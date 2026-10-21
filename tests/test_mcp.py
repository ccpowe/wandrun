"""MCP service pool and adapter lifetime across agent roles."""

import asyncio
import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, quote_plus
from unittest.mock import patch

from langchain.mcp import MCPAdapter
from langchain_core.tools import StructuredTool
from mcp.shared.exceptions import MCPError
from mcp_types import CONNECTION_CLOSED, REQUEST_TIMEOUT

from wandrun.config import AgentDefinition, RuntimeConfig
from wandrun.integrations.mcp import MCPConnectionPool, MCPConnectionError, _redact, select_mcp_tools


def role(*servers):
    return AgentDefinition("Role", "Prompt", "model", mcp_servers=servers)


def adapter_servers(target):
    """Read the config passed to a mocked adapter, including a configured Client."""
    if isinstance(target, dict):
        return target["mcpServers"]
    return {
        name: definition.model_dump(mode="json", exclude_none=True)
        for name, definition in target.transport.config.mcpServers.items()
    }


class MCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_discovery_failure_closes_failed_service_and_exit_closes_success(self):
        active = set()

        class Adapter:
            def __init__(self, config):
                self.server = next(iter(adapter_servers(config)))
                self.client = self

            async def __aenter__(self):
                active.add(self.server)
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                active.discard(self.server)

            async def list_tools(self):
                if self.server == "broken":
                    raise RuntimeError("discovery failed")
                return []

        config = RuntimeConfig(
            main_agent="lead",
            agents={"lead": role("docs", "broken")},
            mcp_servers={
                "docs": {"url": "https://example.com/mcp"},
                "broken": {"url": "https://example.com/broken"},
            },
        )
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                await pool.open("docs", config.mcp_servers["docs"])
                with self.assertRaises(MCPConnectionError):
                    await pool.open("broken", config.mcp_servers["broken"])
                self.assertEqual(active, {"docs"})
                self.assertEqual(pool.status("broken", config.mcp_servers["broken"])["status"], "failed")
        self.assertEqual(active, set())

    async def test_ambiguous_prefixed_tool_names_are_rejected(self):
        by_server = {
            "a_b": [StructuredTool.from_function(
                coroutine=self.lookup, name="c", description="Lookup"
            )],
            "a": [StructuredTool.from_function(
                coroutine=self.lookup, name="b_c", description="Lookup"
            )],
        }
        with self.assertRaisesRegex(ValueError, "工具名称冲突"):
            select_mcp_tools(role("a_b", "a"), by_server)

    @staticmethod
    async def lookup() -> str:
        return "result"


class MCPPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_coalesced_open_cancellation_retry_and_connection_edit(self):
        entered, release = asyncio.Event(), asyncio.Event()
        attempts, closed, changes = [], [], []
        fail = True
        secret = "credential-needle"
        connection = {"url": "https://example.com/mcp", "headers": {"Authorization": secret}}

        class Adapter:
            def __init__(self, config):
                self.client = self
                self.server = next(iter(adapter_servers(config)))
                attempts.append(self.server)

            async def __aenter__(self):
                entered.set()
                await release.wait()
                if fail:
                    logging.getLogger("fastmcp.client").error("secret %s", secret)
                    raise RuntimeError(f"cannot connect with {secret}")
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                closed.append(self.server)

            async def list_tools(self):
                return []

        class Collect(logging.Handler):
            def __init__(self):
                super().__init__()
                self.messages = []

            def emit(self, record):
                self.messages.append(self.format(record))

        handler = Collect()
        logger = logging.getLogger("fastmcp.client")
        logger.addHandler(handler)
        try:
            with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
                async with MCPConnectionPool() as pool:
                    pool.on_change = changes.append
                    first = asyncio.create_task(pool.open("docs", connection))
                    await entered.wait()
                    another = asyncio.create_task(pool.open("docs", connection))
                    await asyncio.sleep(0)
                    first.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await first
                    self.assertEqual(attempts, ["docs"])
                    release.set()
                    with self.assertRaises(MCPConnectionError) as raised:
                        await another
                    self.assertNotIn(secret, str(raised.exception))
                    self.assertEqual(pool.status("docs", connection)["status"], "failed")
                    self.assertEqual(changes, ["docs"])
                    fail = False
                    self.assertEqual(await pool.open("docs", connection), [])
                    self.assertEqual(attempts, ["docs", "docs"])
                    self.assertEqual(changes, ["docs", "docs"])
                    self.assertEqual(pool.status("docs", connection)["status"], "connected")
                    changed = {"url": "https://elsewhere.example/mcp"}
                    await pool.open("docs", changed)
                    self.assertEqual(attempts, ["docs", "docs"])
                    self.assertTrue(pool.status("docs", changed)["pending_restart"])
                    self.assertFalse(pool.status("docs", connection)["pending_restart"])
            self.assertEqual(closed, ["docs", "docs"])
            self.assertNotIn(secret, repr(handler.messages))
        finally:
            logger.removeHandler(handler)

    async def test_independent_opens_and_shutdown_interrupts_inflight_entry(self):
        entered = {name: asyncio.Event() for name in ("one", "two")}
        release = {name: asyncio.Event() for name in entered}
        closed = []

        class Adapter:
            def __init__(self, config):
                self.name = next(iter(adapter_servers(config)))
                self.client = self

            async def __aenter__(self):
                entered[self.name].set()
                await release[self.name].wait()
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                closed.append(self.name)

            async def list_tools(self):
                return []

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            pool = MCPConnectionPool()
            one = asyncio.create_task(pool.open("one", {"command": "one"}))
            two = asyncio.create_task(pool.open("two", {"command": "two"}))
            await asyncio.gather(*(event.wait() for event in entered.values()))
            release["one"].set()
            await one
            shutting_down = asyncio.create_task(pool.aclose())
            with self.assertRaises(MCPConnectionError):
                await two
            await shutting_down
        self.assertCountEqual(closed, ["one", "two"])

    async def test_discovery_deadline_releases_owner_without_waiter_cancellation(self):
        closed = asyncio.Event()

        class Adapter:
            def __init__(self, _):
                self.client = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                closed.set()

            async def list_tools(self):
                await asyncio.Event().wait()

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool(open_timeout=0.02) as pool:
                with self.assertRaisesRegex(MCPConnectionError, "请求超时"):
                    await pool.open("docs", {"command": "fake"})
                self.assertTrue(closed.is_set())
                self.assertEqual(pool.status("docs", {"command": "fake"})["status"], "failed")


    async def test_open_timeout_during_stuck_cleanup_reopens_and_reports_orphan(self):
        release, cleaning = asyncio.Event(), asyncio.Event()
        attempts = []

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                if self is attempts[0]:
                    cleaning.set()
                    while not release.is_set():
                        try:
                            await release.wait()
                        except asyncio.CancelledError:
                            pass

            async def close(self):
                pass

            async def list_tools(self):
                if self is attempts[0]:
                    await asyncio.Event().wait()
                return []

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            pool = MCPConnectionPool(open_timeout=0.02, cleanup_timeout=0.03)
            try:
                with self.assertRaises(MCPConnectionError):
                    await pool.open("docs", {"command": "fake"})
                self.assertTrue(cleaning.is_set())
                owner = pool._services["docs"].task
                self.assertFalse(owner.done())
                self.assertEqual(await pool.open("docs", {"command": "changed"}), [])
                self.assertIsNot(pool._services["docs"].task, owner)
                self.assertEqual(len(attempts), 2)
                with self.assertRaises(RuntimeError):
                    await pool.aclose()
                self.assertFalse(owner.done())
            finally:
                release.set()
                await asyncio.gather(*(state.task for states in pool._orphans.values()
                                       for state in states), return_exceptions=True)
                await pool.aclose()

    async def test_shutdown_timeout_reports_unconfirmed_owner_release(self):
        entered, releasing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        class Adapter:
            def __init__(self, _):
                self.client = self

            async def __aenter__(self):
                entered.set()
                return self

            async def __aexit__(self, *_):
                releasing.set()
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    await release.wait()

            async def close(self):
                pass

            async def list_tools(self):
                return []

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            pool = MCPConnectionPool(cleanup_timeout=0.02)
            await pool.open("docs", {"command": "fake"})
            closing = asyncio.create_task(pool.aclose())
            await releasing.wait()
            with self.assertRaisesRegex(RuntimeError, "资源释放未确认"):
                await closing
            self.assertFalse(pool._services["docs"].task.done())
            release.set()
            await pool._services["docs"].task
            await pool.aclose()


    async def test_probe_and_recovery_keep_original_connection_after_parameter_edit(self):
        requests, closed = [], []

        class Adapter:
            def __init__(self, config):
                self.client = self
                self.url = adapter_servers(config)["wiki"]["url"]
                self.alive = True

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                closed.append(self.url)

            async def ping(self):
                return self.alive

            async def list_tools(self, *, cache_mode=None):
                requests.append((self.url, cache_mode))

                async def lookup(query: str):
                    if not self.alive:
                        raise ConnectionError("Connection closed")
                    return f"{self.url}:{query}"

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup"
                )]

        original = {"url": "https://original.example/mcp"}
        changed = {"url": "https://changed.example/mcp"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                tools = await pool.probe("wiki", original)
                self.assertIs(await pool.probe("wiki", original), tools)
                self.assertEqual(requests, [(original["url"], None), (original["url"], "bypass")])
                pool._services["wiki"].client.alive = False
                call = {"name": "lookup", "args": {"query": "x"}, "id": "call", "type": "tool_call"}
                first = await tools[0].ainvoke(call)
                self.assertEqual(first.status, "error")
                self.assertIn("结果未知", str(first.content))
                self.assertEqual(pool.status("wiki", original)["status"], "connected")
                recovered = await pool.probe("wiki", changed)
                self.assertIs(recovered, tools)
                second = await tools[0].ainvoke(call)
                self.assertEqual(second.content, original["url"] + ":x")
                self.assertEqual(closed, [original["url"]])
                self.assertTrue(all(url == original["url"] for url, _ in requests))
                self.assertTrue(pool.status("wiki", changed)["pending_restart"])

    async def test_probe_connection_error_is_confirmed_before_reopen(self):
        attempts = []

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                return self is not attempts[0]

            async def list_tools(self, *, cache_mode=None):
                if self is attempts[0] and cache_mode == "bypass":
                    raise ConnectionError("Connection closed")
                return []

        connection = {"url": "https://old.example/mcp"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                await pool.open("docs", connection)
                with self.assertRaises(MCPConnectionError):
                    await pool.probe("docs", connection)
                self.assertEqual(pool.status("docs", connection)["status"], "connected")
                self.assertEqual(await pool.probe("docs", connection), [])
                self.assertEqual(len(attempts), 2)
                self.assertEqual(pool.status("docs", connection)["status"], "connected")

    async def test_dead_session_shutdown_uses_confirmed_forced_close(self):
        closed = []

        class Adapter:
            def __init__(self, _):
                self.client = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                raise ConnectionError("Session already closed")

            async def close(self):
                closed.append(True)

            async def list_tools(self):
                async def lookup():
                    raise ConnectionError("Connection closed")

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup"
                )]

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            pool = MCPConnectionPool()
            tools = await pool.open("docs", {"command": "fake"})
            result = await tools[0].ainvoke({
                "name": tools[0].name, "args": {}, "id": "call", "type": "tool_call"
            })
            self.assertEqual(result.status, "error")
            self.assertEqual(pool.status("docs", {"command": "fake"})["status"], "connected")
            await pool.aclose()
            self.assertEqual(closed, [True])

    async def test_background_session_completion_marks_failed_before_next_call(self):
        ended, failed = asyncio.Event(), asyncio.Event()
        changes, attempts = [], []

        class Adapter:
            def __init__(self, _):
                self.client = self
                self.ended = ended if not attempts else asyncio.Event()
                attempts.append(self)
                self._session_state = SimpleNamespace(session_task=None)

            async def __aenter__(self):
                self._session_state.session_task = asyncio.create_task(self.ended.wait())
                return self

            async def __aexit__(self, *_):
                self.ended.set()
                await self._session_state.session_task

            async def close(self):
                pass

            async def list_tools(self):
                return []

        original = {"url": "https://old.example/mcp"}
        changed = {"url": "https://new.example/mcp"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                def changed_status(server):
                    changes.append(server)
                    if pool.status(server, changed)["status"] == "failed":
                        failed.set()

                pool.on_change = changed_status
                await pool.open("docs", original)
                ended.set()
                await asyncio.wait_for(failed.wait(), 1)
                status = pool.status("docs", changed)
                self.assertEqual(status["status"], "failed")
                self.assertIn("会话任务结束", status["error"])
                self.assertEqual(await pool.open("docs", changed), [])
                self.assertEqual(len(attempts), 2)
                self.assertEqual(changes, ["docs", "docs", "docs"])


    async def test_tool_deadline_and_request_timeout_leave_session_usable(self):
        attempts, calls = [], []

        class Adapter:
            def __init__(self, target):
                self.client = self
                attempts.append(target)

            async def __aenter__(self):
                await asyncio.sleep(0.015)  # Opening has its own deadline.
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def list_tools(self):
                async def lookup():
                    calls.append(len(calls))
                    if len(calls) == 1:
                        await asyncio.sleep(0.03)
                    if len(calls) == 2:
                        raise MCPError(REQUEST_TIMEOUT, "credential-needle")
                    return "ok"

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup"
                )]

        connection = {"url": "https://example.com/mcp"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool(open_timeout=0.1, call_timeout=0.01) as pool:
                tools = await pool.open("docs", connection)
                call = {"name": "lookup", "args": {}, "id": "call", "type": "tool_call"}
                timed_out = await tools[0].ainvoke(call)
                self.assertEqual(timed_out.status, "error")
                self.assertIn("结果未知", str(timed_out.content))
                request_timeout = await tools[0].ainvoke(call)
                self.assertEqual(request_timeout.status, "error")
                self.assertNotIn("credential-needle", str(request_timeout.content))
                self.assertFalse(pool._services["docs"].suspect)
                self.assertEqual(pool.status("docs", connection)["status"], "connected")
                self.assertEqual((await tools[0].ainvoke(call)).content, "ok")
                self.assertEqual(len(attempts), 1)

    async def test_suspect_ping_success_shares_confirmation_across_cancelled_waiters(self):
        ping_entered, release_ping = asyncio.Event(), asyncio.Event()
        attempts, calls, pings = [], [], []

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                pings.append(True)
                ping_entered.set()
                await release_ping.wait()
                return True

            async def list_tools(self):
                async def lookup():
                    calls.append(True)
                    if len(calls) == 1:
                        raise MCPError(CONNECTION_CLOSED, "request stream closed")
                    return "ok"

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup"
                )]

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                tools = await pool.open("docs", {"command": "fake"})
                call = {"name": "lookup", "args": {}, "id": "call", "type": "tool_call"}
                self.assertEqual((await tools[0].ainvoke(call)).status, "error")
                first = asyncio.create_task(tools[0].ainvoke(call))
                await ping_entered.wait()
                second = asyncio.create_task(tools[0].ainvoke(call))
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                release_ping.set()
                self.assertEqual((await second).content, "ok")
                self.assertEqual(len(attempts), 1)
                self.assertEqual(len(pings), 1)
                self.assertEqual(len(calls), 2)  # Failed invocation was never replayed.

    async def test_same_name_schema_only_change_logs_and_keeps_first_definition(self):
        attempts = []

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)
                self.number = len(attempts)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                return False

            async def list_tools(self):
                async def before(query: str) -> str:
                    return query
                async def after(id: int) -> str:
                    return str(id)
                return [StructuredTool.from_function(
                    coroutine=before if self.number == 1 else after,
                    name="lookup", description="Lookup",
                )]

        connection = {"command": "fake"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                original = await pool.open("docs", connection)
                pool._services["docs"].suspect = True
                with self.assertLogs("wandrun.integrations.mcp", level="WARNING") as captured:
                    current = await pool.open("docs", connection)
                self.assertIs(current, original)
                self.assertEqual([tool.name for tool in current], ["lookup"])
                self.assertEqual(set(current[0].args), {"query"})
                self.assertEqual(set(pool._services["docs"].raw_tools["lookup"].args), {"id"})
                self.assertEqual(sum("工具目录已变化，沿用首次发现的定义" in message
                                     for message in captured.output), 1)

    async def test_http_status_error_does_not_suspect_or_probe_live_session(self):
        import httpx2

        attempts, calls, pings = [], [], []
        request = httpx2.Request("POST", "https://example.com/mcp")
        response = httpx2.Response(503, request=request)

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                pings.append(True)
                return False

            async def list_tools(self):
                async def lookup():
                    calls.append(True)
                    if len(calls) == 1:
                        raise httpx2.HTTPStatusError(
                            "private upstream detail", request=request, response=response,
                        )
                    return "same session"
                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup",
                )]

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                tool, = await pool.open("docs", {"command": "fake"})
                state = pool._services["docs"]
                call = {"type": "tool_call", "id": "use", "name": "lookup", "args": {}}
                failed = await tool.ainvoke(call)
                self.assertEqual(failed.status, "error")
                self.assertNotIn("private upstream detail", str(failed.content))
                self.assertFalse(state.suspect)
                self.assertEqual((await tool.ainvoke(call)).content, "same session")
                self.assertIs(pool._services["docs"], state)
                self.assertEqual(pings, [])
                self.assertEqual(len(attempts), 1)

    async def test_hanging_ping_expires_before_reopening_session(self):
        attempts, calls = [], []
        ping_cancelled = asyncio.Event()
        timeout = asyncio.timeout

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)
                self.number = len(attempts)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                try:
                    await asyncio.Event().wait()
                finally:
                    ping_cancelled.set()

            async def list_tools(self):
                async def lookup():
                    calls.append(self.number)
                    if self.number == 1:
                        raise ConnectionError("old transport closed")
                    return "recovered"
                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup",
                )]

        def short_ping_deadline(seconds):
            return timeout(0.02 if seconds == 5 else seconds)

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                tool, = await pool.open("docs", {"command": "fake"})
                call = {"type": "tool_call", "id": "use", "name": "lookup", "args": {}}
                self.assertEqual((await tool.ainvoke(call)).status, "error")
                with patch("wandrun.integrations.mcp.asyncio.timeout", side_effect=short_ping_deadline):
                    async with timeout(1):
                        result = await tool.ainvoke(call)
                self.assertTrue(ping_cancelled.is_set())
                self.assertEqual(result.content, "recovered")
                self.assertEqual(calls, [1, 2])
                self.assertEqual(len(attempts), 2)

    async def test_failed_reopen_retries_later_without_replaying_failed_call(self):
        attempts, calls = [], []

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)
                self.number = len(attempts)

            async def __aenter__(self):
                if self.number == 2:
                    raise ConnectionError("credential-needle")
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                return False

            async def list_tools(self):
                async def lookup():
                    calls.append(self.number)
                    if self.number == 1:
                        raise ConnectionError("stream closed")
                    return "recovered"

                tools = [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup"
                )]
                if self.number == 3:
                    tools.append(StructuredTool.from_function(
                        coroutine=lookup, name="extra", description="Extra"
                    ))
                return tools

        connection = {"command": "fake"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                tools = await pool.open("docs", connection)
                call = {"name": "lookup", "args": {}, "id": "call", "type": "tool_call"}
                self.assertEqual((await tools[0].ainvoke(call)).status, "error")
                concurrent = await asyncio.gather(
                    pool.open("docs", connection), pool.open("docs", connection),
                    return_exceptions=True,
                )
                self.assertTrue(all(isinstance(error, MCPConnectionError) for error in concurrent))
                self.assertEqual(len(attempts), 2)
                self.assertEqual(pool.status("docs", connection)["status"], "failed")
                self.assertNotIn("credential-needle", pool.status("docs", connection)["error"])

                recovered = await asyncio.gather(*(tools[0].ainvoke(call) for _ in range(3)))
                self.assertEqual([result.content for result in recovered], ["recovered"] * 3)
                self.assertEqual(calls, [1, 3, 3, 3])
                self.assertEqual(len(attempts), 3)
                self.assertEqual(pool.status("docs", connection)["status"], "connected")

    async def test_recovery_ping_revocation_and_shutdown_release_owner(self):
        for shutdown in (False, True):
            with self.subTest(shutdown=shutdown):
                entered = asyncio.Event()
                released = []

                class OAuth:
                    generation_number = 1

                    def generation(self, server):
                        return self.generation_number

                    def authorized(self, server, generation, url):
                        return generation == self.generation_number

                    async def token(self, server, generation, url):
                        return "revoked-secret"

                    def secret_values(self, server):
                        return ("revoked-secret",)

                class Adapter:
                    def __init__(self, _):
                        self.client = self

                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, *_):
                        pass

                    async def close(self):
                        released.append(True)

                    async def ping(self):
                        entered.set()
                        await asyncio.Event().wait()

                    async def list_tools(self):
                        return []

                oauth = OAuth()
                connection = {"url": "https://example.com/mcp"}
                pool = MCPConnectionPool(oauth=oauth, cleanup_timeout=1)
                pool.oauth_connectors.add("docs")
                with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
                    try:
                        await pool.open("docs", connection)
                        pool._services["docs"].suspect = True
                        pending = asyncio.create_task(pool.probe("docs", connection))
                        await asyncio.wait_for(entered.wait(), 2)
                        if shutdown:
                            await pool.aclose()
                        else:
                            oauth.generation_number += 1
                            await pool.close_service("docs")
                        with self.assertRaises(MCPConnectionError):
                            await asyncio.wait_for(pending, 2)
                        self.assertEqual(released, [True])
                        self.assertTrue(pool.release_confirmed("docs"))
                    finally:
                        await pool.aclose()

    async def test_oauth_explicit_close_rejects_unreleased_recovery_orphan(self):
        from wandrun.integrations.mcp import MCPCleanupError

        release = asyncio.Event()
        attempts = []

        class OAuth:
            current = 1

            def generation(self, server):
                return self.current

            def authorized(self, server, generation, url):
                return generation == self.current

            async def token(self, server, generation, url):
                return "test-secret"

            def secret_values(self, server):
                return ("test-secret",)

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)
                self.number = len(attempts)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                if self.number == 1:
                    while not release.is_set():
                        try:
                            await release.wait()
                        except asyncio.CancelledError:
                            pass

            async def close(self):
                pass

            async def ping(self):
                return False

            async def list_tools(self):
                async def lookup():
                    if self.number == 1:
                        raise ConnectionError("old transport closed")
                    return "recovered"
                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup",
                )]

        oauth = OAuth()
        connection = {"url": "https://example.com/mcp"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            pool = MCPConnectionPool(oauth=oauth, cleanup_timeout=0.02)
            pool.oauth_connectors.add("docs")
            try:
                tool, = await pool.open("docs", connection)
                old = pool._services["docs"]
                call = {"type": "tool_call", "id": "use", "name": "lookup", "args": {}}
                self.assertEqual((await tool.ainvoke(call)).status, "error")
                async with asyncio.timeout(1):
                    self.assertEqual((await tool.ainvoke(call)).content, "recovered")
                self.assertFalse(old.task.done())
                self.assertFalse(old.released)
                self.assertFalse(pool.release_confirmed("docs"))
                oauth.current += 1
                # The first close retires the current owner; the second has only
                # the retained orphan. Neither may report confirmed release.
                for _ in range(2):
                    with self.assertRaises(MCPCleanupError):
                        async with asyncio.timeout(1):
                            await pool.close_service("docs")
                    self.assertIn(old, pool._orphans["docs"])
                    self.assertFalse(pool.release_confirmed("docs"))
                    self.assertFalse(old.task.done())
                release.set()
                await asyncio.wait_for(old.task, 1)
                await pool.close_service("docs")
                self.assertTrue(pool.release_confirmed("docs"))
            finally:
                release.set()
                await pool.aclose()

    async def test_oauth_transport_recovers_within_generation_but_old_tool_cannot_cross_revoke(self):
        attempts, calls = [], []

        class OAuth:
            current = 1

            def generation(self, server):
                return self.current

            def authorized(self, server, generation, url):
                return generation == self.current and url == "https://example.com/mcp"

            async def token(self, server, generation, url):
                return "private-token"

            def secret_values(self, server):
                return ("private-token",)

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)
                self.number = len(attempts)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                return False

            async def list_tools(self):
                async def lookup():
                    calls.append(self.number)
                    if self.number == 1:
                        raise ConnectionError("stream ended")
                    return "ok"

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup"
                )]

        oauth = OAuth()
        connection = {"url": "https://example.com/mcp"}
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool(oauth=oauth) as pool:
                pool.oauth_connectors.add("docs")
                tools = await pool.open("docs", connection)
                call = {"name": "lookup", "args": {}, "id": "call", "type": "tool_call"}
                self.assertEqual((await tools[0].ainvoke(call)).status, "error")
                self.assertEqual((await tools[0].ainvoke(call)).content, "ok")
                self.assertEqual(calls, [1, 2])
                oauth.current = 2
                denied = await tools[0].ainvoke(call)
                self.assertEqual(denied.status, "error")
                self.assertIn("重新授权", str(denied.content))
                self.assertEqual(len(attempts), 2)
                newer = await pool.open("docs", connection)
                self.assertEqual((await newer[0].ainvoke(call)).content, "ok")
                self.assertEqual((await tools[0].ainvoke(call)).status, "error")
                self.assertEqual(calls, [1, 2, 3])

    async def test_dead_ping_logs_redacted_reason_and_removed_old_tool_fails_safely(self):
        secret = "private-needle"
        server = "docs-" + secret
        messages, calls, attempts = [], [], []

        class Collect(logging.Handler):
            def emit(self, record):
                messages.append(self.format(record))

        class Adapter:
            def __init__(self, _):
                self.client = self
                attempts.append(self)
                self.number = len(attempts)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def ping(self):
                return False

            async def list_tools(self):
                async def lookup():
                    calls.append(self.number)
                    raise ConnectionError(secret)

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup" if self.number == 1 else "other",
                    description="Lookup",
                )]

        handler = Collect()
        logger = logging.getLogger("wandrun.integrations.mcp")
        logger.addHandler(handler)
        connection = {"command": "fake", "env": {"SECRET": secret}}
        try:
            with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
                async with MCPConnectionPool() as pool:
                    tools = await pool.open(server, connection)
                    call = {"name": "lookup", "args": {}, "id": "call", "type": "tool_call"}
                    self.assertEqual((await tools[0].ainvoke(call)).status, "error")
                    removed = await tools[0].ainvoke(call)
                    self.assertEqual(removed.status, "error")
                    self.assertIn("不再提供", str(removed.content))
                    self.assertNotIn(secret, str(removed.content))
                    self.assertEqual(calls, [1])
                    self.assertEqual(len(attempts), 2)
                    self.assertEqual(pool.status(server, connection)["status"], "connected")
            self.assertTrue(any("ping 失败" in message for message in messages))
            self.assertNotIn(secret, repr(messages))
        finally:
            logger.removeHandler(handler)

    async def test_inflight_error_redacts_invoked_owner_after_another_replacement(self):
        from langchain_core.tools import ToolException

        entered, release = asyncio.Event(), asyncio.Event()

        class Adapter:
            def __init__(self, target):
                self.client = self
                self.secret = adapter_servers(target)["docs"]["headers"]["X-Key"]

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def list_tools(self):
                async def lookup():
                    entered.set()
                    await release.wait()
                    raise ToolException("server echoed " + self.secret)

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup",
                    handle_tool_error=lambda error: str(error),
                )]

        def connection(secret):
            return {"url": "https://example.com/mcp", "headers": {"X-Key": secret}}

        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                old_tool, = await pool.open("docs", connection("original-secret"))
                await pool.close_service("docs")
                await pool.open("docs", connection("invoked-secret"))
                pending = asyncio.create_task(old_tool.ainvoke({
                    "type": "tool_call", "id": "held", "name": "lookup", "args": {},
                }))
                try:
                    await asyncio.wait_for(entered.wait(), 2)
                    await pool.close_service("docs")
                    await pool.open("docs", connection("current-secret"))
                finally:
                    release.set()
                result = await pending
                self.assertEqual(result.status, "error")
                self.assertNotIn("invoked-secret", str(result.content))
                self.assertIn("server echoed", str(result.content))

    async def test_encoded_secrets_are_removed_before_logging_and_public_errors(self):
        secret = "a'\"\\\n雪 +/%"
        variants = (
            secret, repr(secret)[1:-1], json.dumps(secret)[1:-1],
            json.dumps(secret, ensure_ascii=False)[1:-1],
            repr(secret.encode())[2:-1], quote(secret, safe=""), quote_plus(secret, safe=""),
        )
        for variant in variants:
            self.assertNotIn(variant, _redact(f"request {variant}", (secret,)))
        records = []

        class Collect(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        class Adapter:
            def __init__(self, _):
                self.client = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def list_tools(self):
                logging.getLogger("fastmcp.client").error("bad %s", variants)
                raise RuntimeError(repr(secret.encode()))

        handler = Collect()
        logger = logging.getLogger("fastmcp.client")
        logger.addHandler(handler)
        connection = {"url": (
            f"https://user:{quote(secret, safe='')}@example.com/mcp?"
            f"token={quote(secret, safe='')}"
        )}
        try:
            with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
                async with MCPConnectionPool() as pool:
                    with self.assertRaises(MCPConnectionError) as raised:
                        await pool.open("docs", connection)
                    public = (str(raised.exception), repr(raised.exception),
                              pool.status("docs", connection)["error"])
                    for variant in variants:
                        self.assertNotIn(variant, repr(public))
            self.assertTrue(records)
            for variant in variants:
                self.assertNotIn(variant, repr(records))
        finally:
            logger.removeHandler(handler)

class MCPSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_searchable_services_keep_original_names_per_role(self):
        connected = []

        class Adapter:
            def __init__(self, config):
                self.server = next(iter(adapter_servers(config)))
                self.client = self

            async def __aenter__(self):
                connected.append(self.server)
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def list_tools(self):
                async def lookup() -> str:
                    return "result"

                return [StructuredTool.from_function(coroutine=lookup, name="lookup",
                                                     description="Lookup")]

        config = RuntimeConfig(
            main_agent="lead",
            agents={
                "lead": AgentDefinition("Role", "Prompt", "model", mcp_servers=("docs",),
                                        searchable_mcp_servers=("mail",)),
                "other": role("docs"),
            },
            mcp_servers={name: {"url": f"https://example.com/{name}"}
                         for name in ("docs", "mail", "unused")},
        )
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            async with MCPConnectionPool() as pool:
                by_server = {
                    name: await pool.open(name, config.mcp_servers[name])
                    for name in ("docs", "mail")
                }
                direct, searchable = select_mcp_tools(config.agents["lead"], by_server)
                other_direct, other_searchable = select_mcp_tools(config.agents["other"], by_server)
        self.assertEqual(sorted(connected), ["docs", "mail"])
        self.assertEqual([t.name for t in direct], ["docs_lookup"])
        self.assertEqual([t.name for t in searchable["mail"]], ["lookup"])
        self.assertEqual([t.name for t in other_direct], ["docs_lookup"])
        self.assertEqual(other_searchable, {})


class MCPCallFailureTests(unittest.IsolatedAsyncioTestCase):
    async def tool(self, failure, *, secret=None):
        from langchain.mcp.tools import _handle_mcp_tool_error

        class Adapter:
            def __init__(self, config):
                self.client = self

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def close(self):
                pass

            async def list_tools(self):
                async def lookup(query: str):
                    raise failure

                return [StructuredTool.from_function(
                    coroutine=lookup, name="lookup", description="Lookup",
                    response_format="content_and_artifact",
                    handle_tool_error=_handle_mcp_tool_error,
                )]

        config = RuntimeConfig(
            main_agent="lead", agents={"lead": role("wiki")},
            mcp_servers={"wiki": {
                "url": "https://example.com/wiki",
                **({"headers": {"Authorization": secret}} if secret else {}),
            }},
        )
        with patch("wandrun.integrations.mcp.MCPAdapter", Adapter):
            pool = await self.enterAsyncContext(MCPConnectionPool())
            by_server = {"wiki": await pool.open("wiki", config.mcp_servers["wiki"])}
            direct, _ = select_mcp_tools(config.agents["lead"], by_server)
        return direct[0]

    def call(self, tool):
        return tool.ainvoke({"name": tool.name, "args": {"query": "x"}, "id": "c1", "type": "tool_call"})

    async def test_transport_failure_becomes_error_result(self):
        tool = await self.tool(RuntimeError("SSE stream ended without a response"))
        message = await self.call(tool)
        self.assertEqual(message.status, "error")
        self.assertNotIn("SSE stream ended", str(message.content))

    async def test_server_error_result_keeps_adapter_handling(self):
        from langchain.mcp.tools import _MCPToolExecutionError
        from langchain_core.messages.content import create_text_block

        tool = await self.tool(_MCPToolExecutionError([create_text_block(text="bad repo")]))
        message = await self.call(tool)
        self.assertEqual(message.status, "error")
        self.assertEqual(message.content[0]["text"], "bad repo")

    async def test_transport_and_server_errors_redact_connection_credentials(self):
        from langchain.mcp.tools import _MCPToolExecutionError
        from langchain_core.messages.content import create_text_block

        secret = "private-auth-value"
        for failure in (
            RuntimeError(f"connection rejected token {secret}"),
            _MCPToolExecutionError([create_text_block(text=f"server echoed {secret}")]),
        ):
            with self.subTest(kind=type(failure).__name__):
                tool = await self.tool(failure, secret=secret)
                message = await self.call(tool)
                self.assertEqual(message.status, "error")
                self.assertNotIn(secret, repr(message.content))
                if isinstance(failure, _MCPToolExecutionError):
                    self.assertIsInstance(message.content, list)

    async def test_escaped_server_error_content_is_redacted(self):
        from langchain.mcp.tools import _MCPToolExecutionError
        from langchain_core.messages.content import create_text_block

        secret = "line'\n雪/%"
        variants = (repr(secret)[1:-1], repr(secret.encode())[2:-1],
                    json.dumps(secret)[1:-1], quote(secret, safe=""))
        tool = await self.tool(
            _MCPToolExecutionError([create_text_block(text=" ".join(variants))]),
            secret=secret,
        )
        message = await self.call(tool)
        self.assertEqual(message.status, "error")
        self.assertIsInstance(message.content, list)
        for variant in variants:
            self.assertNotIn(variant, repr(message.content))

    async def test_graph_interrupt_still_propagates(self):
        from langgraph.errors import GraphInterrupt

        tool = await self.tool(GraphInterrupt(()))
        with self.assertRaises(GraphInterrupt):
            await self.call(tool)

    async def test_cancellation_still_propagates(self):
        import asyncio

        tool = await self.tool(asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            await self.call(tool)


class MCPHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def test_sse_endpoint_follows_same_origin_307(self):
        import socket
        import uvicorn
        from fastmcp import FastMCP
        from starlette.responses import RedirectResponse
        from starlette.routing import Route

        peer = FastMCP("redirect-test")

        @peer.tool
        async def lookup(query: str) -> str:
            return query

        app = peer.http_app(path="/sse", transport="sse")
        app.routes.append(Route("/entry307", lambda _: RedirectResponse("/sse", status_code=307)))
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        sock.setblocking(False)
        server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="critical"))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    await asyncio.sleep(0.01)
            connection = {
                "url": f"http://127.0.0.1:{sock.getsockname()[1]}/entry307",
                "transport": "sse",
            }
            async with MCPConnectionPool(open_timeout=3) as pool:
                tools = await pool.open("docs", connection)
                self.assertEqual([tool.name for tool in tools], ["lookup"])
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 5)
            sock.close()

    async def test_oauth_recovery_ping_redacts_sdk_sender_logs_from_open_and_probe(self):
        import socket
        import uvicorn
        from fastmcp import FastMCP

        secret = "review-oauth-secret-8492"
        static_secret = "review-static-secret-742"

        class OAuth:
            def generation(self, server):
                return 1

            def authorized(self, server, generation, url):
                return generation == 1

            async def token(self, server, generation, url):
                return secret

            def secret_values(self, server):
                return (secret,)

        peer = FastMCP("oauth-ping-test")

        @peer.tool
        async def lookup() -> str:
            return "ok"

        underlying = peer.http_app()

        async def app(scope, receive, send):
            if scope["type"] != "http" or scope["method"] != "POST":
                return await underlying(scope, receive, send)
            chunks = []
            while True:
                message = await receive()
                chunks.append(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            body = b"".join(chunks)
            request = json.loads(body)
            if request.get("method") == "ping":
                error = {"jsonrpc": "2.0", "id": request["id"],
                         "error": {"code": -32000,
                                   "message": "Bearer " + secret + " " + static_secret}}
                event = f"event: message\ndata: {json.dumps(error)}\n\n".encode()
                await send({"type": "http.response.start", "status": 200,
                            "headers": [(b"content-type", b"text/event-stream")]})
                await send({"type": "http.response.body", "body": event})
                return
            replayed = False

            async def replay():
                nonlocal replayed
                if not replayed:
                    replayed = True
                    return {"type": "http.request", "body": body, "more_body": False}
                return await receive()

            return await underlying(scope, replay, send)

        class Collect(logging.Handler):
            def emit(self, record):
                messages.append(self.format(record))

        messages = []
        logger = logging.getLogger("mcp.client.streamable_http")
        original_level = logger.level
        handler = Collect()
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        sock.setblocking(False)
        server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level="critical"))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    await asyncio.sleep(0.01)
            connection = {
                "url": f"http://127.0.0.1:{sock.getsockname()[1]}/mcp",
                "headers": {"X-Test-Secret": static_secret},
            }
            async with MCPConnectionPool(oauth=OAuth(), open_timeout=3) as pool:
                pool.oauth_connectors.add("docs")
                await pool.open("docs", connection)
                pool._services["docs"].suspect = True
                await pool.open("docs", connection)
                pool._services["docs"].suspect = True
                await pool.probe("docs", connection)
            ping_logs = [message for message in messages if "SSE message:" in message
                         and "Bearer " in message]
            self.assertEqual(len(ping_logs), 2)
            self.assertNotIn(secret, repr(messages))
            self.assertNotIn(static_secret, repr(messages))
            self.assertTrue(all("[redacted]" in message for message in ping_logs))
        finally:
            logger.removeHandler(handler)
            logger.setLevel(original_level)
            server.should_exit = True
            await asyncio.wait_for(serving, 5)
            sock.close()

    async def test_slow_http_tool_outlives_old_read_clock_without_shortening_discovery(self):
        import socket
        import uvicorn
        from fastmcp import FastMCP

        class SlowCatalog(FastMCP):
            slow_discovery = True

            async def list_tools(self, *, run_middleware=True):
                if self.slow_discovery:
                    await asyncio.sleep(0.65)
                return await super().list_tools(run_middleware=run_middleware)

        peer = SlowCatalog("deadline-test")
        calls, started = [], asyncio.Event()

        @peer.tool
        async def slow(delay: float) -> str:
            calls.append(delay)
            started.set()
            await asyncio.sleep(delay)
            return "completed"

        class ShortOldClockPool(MCPConnectionPool):
            def _http_client(self, **kwargs):
                client = super()._http_client(**kwargs)

                async def old_clock(request):
                    if (request.method == "POST"
                            and json.loads(request.content).get("method") == "tools/call"):
                        request.extensions["timeout"]["read"] = 0.03

                # Simulate the old 300s read limit at a shorter scale, before
                # the production per-request override gets its turn.
                client.event_hooks["request"].insert(0, old_clock)
                return client

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        sock.setblocking(False)
        server = uvicorn.Server(uvicorn.Config(
            peer.http_app(), access_log=False, log_level="critical",
        ))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    await asyncio.sleep(0.01)
            connection = {"url": f"http://127.0.0.1:{sock.getsockname()[1]}/mcp"}
            async with ShortOldClockPool(call_timeout=0.5, open_timeout=3) as pool:
                tool, = await pool.open("slow", connection)
                peer.slow_discovery = False
                owner = pool._services["slow"]

                async def invoke(delay):
                    return await tool.ainvoke({
                        "type": "tool_call", "id": "slow", "name": "slow", "args": {"delay": delay},
                    })

                completed = await invoke(0.15)
                self.assertEqual(completed.status, "success", completed.content)
                self.assertEqual(completed.content[0]["text"], "completed")
                timed_out = await invoke(1.0)
                self.assertEqual(timed_out.status, "error")
                self.assertIn("结果未知", str(timed_out.content))
                self.assertEqual((await invoke(0)).status, "success")
                self.assertIs(pool._services["slow"], owner)
                self.assertEqual(pool.status("slow", connection)["status"], "connected")
                self.assertEqual(calls, [0.15, 1.0, 0.0])
                started.clear()
                waiting = asyncio.create_task(invoke(5))
                await asyncio.wait_for(started.wait(), 2)
                waiting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(waiting, 0.3)
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, 5)
            sock.close()


    async def test_real_ended_http_session_close_completes_transport_fallback(self):
        import socket
        import uvicorn
        from fastmcp import FastMCP

        peer = FastMCP("ended-session")

        @peer.tool
        async def slow() -> str:
            await asyncio.sleep(0.5)
            return "late"

        class BrokenReadPool(MCPConnectionPool):
            def _http_client(self, **kwargs):
                client = super()._http_client(**kwargs)

                async def end_tool_stream(request):
                    if (request.method == "POST"
                            and json.loads(request.content).get("method") == "tools/call"):
                        request.extensions["timeout"]["read"] = 0.02

                client.event_hooks["request"].append(end_tool_stream)
                return client

        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        sock.setblocking(False)
        server = uvicorn.Server(uvicorn.Config(
            peer.http_app(), access_log=False, log_level="critical",
        ))
        serving = asyncio.create_task(server.serve(sockets=[sock]))
        pool = BrokenReadPool(open_timeout=3, cleanup_timeout=5)
        try:
            async with asyncio.timeout(5):
                while not server.started:
                    await asyncio.sleep(0.01)
            connection = {"url": f"http://127.0.0.1:{sock.getsockname()[1]}/mcp"}
            tool, = await pool.open("ended", connection)
            owner = pool._services["ended"]
            client = owner.client
            # Instrument only the release stage, not the SDK session runner.
            transport = client.transport
            original_close = transport.close
            releases = []

            async def observed_close():
                releases.append(True)
                await original_close()

            transport.close = observed_close
            session_task = client._session_state.session_task
            result = await tool.ainvoke({
                "type": "tool_call", "id": "slow", "name": "slow", "args": {},
            })
            self.assertEqual(result.status, "error")
            await asyncio.wait_for(asyncio.gather(session_task, return_exceptions=True), 3)
            self.assertIsNotNone(session_task.exception())
            await pool.aclose()
            self.assertTrue(owner.released)
            self.assertEqual(releases, [True])
        finally:
            try:
                await pool.aclose()
            finally:
                server.should_exit = True
                await asyncio.wait_for(serving, 5)
                sock.close()


class MCPSDKBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_blocked_courtesy_cancel_write_waits_for_sdk_bound(self):
        import anyio
        from mcp.client.session import ClientSession

        # A zero-buffer real SDK transport accepts the request, then the peer
        # stops reading. The courtesy notification must block in send(), not
        # merely in a patched ping or a fabricated echo coroutine.
        inbound_send, inbound_receive = anyio.create_memory_object_stream(0)
        outbound_send, outbound_receive = anyio.create_memory_object_stream(0)
        records = []

        class Collect(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        logger = logging.getLogger("mcp.shared.jsonrpc_dispatcher")
        handler = Collect()
        logger.addHandler(handler)
        try:
            async with ClientSession(inbound_receive, outbound_send) as session:
                # Keep MCP 2.1.1's actual five-second courtesy-write bound.
                # A shortened mock clock would not characterize caller-visible latency.
                pending = asyncio.create_task(session.call_tool("lookup", {}))
                first = await asyncio.wait_for(outbound_receive.receive(), 2)
                self.assertEqual(first.message.method, "tools/call")
                started = asyncio.get_running_loop().time()
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(pending, 7)
                elapsed = asyncio.get_running_loop().time() - started
                self.assertGreaterEqual(elapsed, 4.5)
                self.assertLess(elapsed, 7)
                self.assertTrue(any("courtesy cancel for caller-cancelled request"
                                    in message and "transport write blocked" in message
                                    for message in records))
        finally:
            logger.removeHandler(handler)
            await inbound_send.aclose()
            await outbound_receive.aclose()


STDIO_SERVER = """
import os
import sys
from pathlib import Path
from fastmcp import FastMCP

Path(sys.argv[1]).write_text(str(os.getpid()))
server = FastMCP("lifecycle-test")

@server.tool
def add(a: int, b: int) -> int:
    return a + b

server.run(transport="stdio", show_banner=False)
"""


STDIO_CHANGED_SCHEMA_SERVER = """
import os
import sys
from pathlib import Path
from fastmcp import FastMCP

server = FastMCP("changed-schema")
if Path(sys.argv[1]).read_text() == "query":
    @server.tool
    def lookup(query: str) -> str:
        return query
    @server.tool
    def removed() -> str:
        return "old result"
else:
    @server.tool
    def lookup(id: int) -> str:
        return str(id)

@server.tool
def crash() -> str:
    os._exit(7)

server.run(transport="stdio", show_banner=False)
"""


STDIO_STUCK_SERVER = """
import asyncio
import os
import sys
from pathlib import Path
from fastmcp import FastMCP

class Stuck(FastMCP):
    async def list_tools(self, *, run_middleware=True):
        Path(sys.argv[2]).write_text("requested")
        await asyncio.Event().wait()

Path(sys.argv[1]).write_text(str(os.getpid()))
Stuck("stuck-tools").run(transport="stdio", show_banner=False)
"""


STDIO_SECRET_SERVER = """
import os
from fastmcp import FastMCP

class Failing(FastMCP):
    async def list_tools(self, *, run_middleware=True):
        raise RuntimeError(repr(os.environ["WANDRUN_MCP_REVIEW_SECRET"].encode()))

Failing("secret-tools").run(transport="stdio", show_banner=False)
"""


@unittest.skipUnless(os.name == "posix", "Uses POSIX process existence checks")
class MCPProcessTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.adapters = []
        self.fail_connect = False
        test = self

        class ObservedAdapter(MCPAdapter):
            def __init__(self, config):
                super().__init__(config)
                self.server_name = next(iter(adapter_servers(config)))
                test.adapters.append(self)

            async def __aenter__(self):
                result = await super().__aenter__()
                if self.server_name == "second" and test.fail_connect:
                    # 已分配真实 transport，但尚未向 ExitStack 交付成功的上下文。
                    raise ConnectionError("initialization failed")
                return result

        patcher = patch("wandrun.integrations.mcp.MCPAdapter", ObservedAdapter)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addAsyncCleanup(self.close_clients)
        self.config = RuntimeConfig(
            main_agent="lead",
            agents={"lead": role("first", "second")},
            mcp_servers={
                name: {
                    "command": sys.executable,
                    "args": [
                        "-c", STDIO_SERVER, str(self.directory / f"{name}.pid")
                    ],
                }
                for name in ("first", "second")
            },
        )

    async def close_clients(self):
        # 即使断言失败也不泄漏子进程；保留 adapter 引用以排除 GC 偶然收尾。
        for adapter in self.adapters:
            await adapter.client.close()

    def assert_processes_stopped(self):
        for name in ("first", "second"):
            with self.subTest(server=name):
                pid = int((self.directory / f"{name}.pid").read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    async def test_context_exit_waits_for_kept_alive_processes(self):
        async with MCPConnectionPool() as pool:
            first = await pool.open("first", self.config.mcp_servers["first"])
            second = await pool.open("second", self.config.mcp_servers["second"])
            self.assertEqual(len(second), 1)
            self.assertIs(await pool.probe("first", self.config.mcp_servers["first"]), first)
            direct, _ = select_mcp_tools(self.config.agents["lead"], {"first": first, "second": second})
            result = await direct[0].ainvoke({"a": 17, "b": 25})
            self.assertEqual(result[0]["text"], "42")
        self.assert_processes_stopped()

    async def test_failed_entry_closes_partial_and_preceding_transports(self):
        self.fail_connect = True
        async with MCPConnectionPool() as pool:
            await pool.open("first", self.config.mcp_servers["first"])
            with self.assertRaises(MCPConnectionError):
                await pool.open("second", self.config.mcp_servers["second"])
        self.assert_processes_stopped()

    async def test_real_recovery_retains_first_schema_and_returns_server_argument_error(self):
        mode = self.directory / "schema-mode"
        mode.write_text("query")
        connection = {
            "command": sys.executable,
            "args": ["-c", STDIO_CHANGED_SCHEMA_SERVER, str(mode)],
        }
        async with MCPConnectionPool() as pool:
            original = await pool.open("schema", connection)
            by_name = {tool.name: tool for tool in original}
            mode.write_text("id")
            failed = await by_name["crash"].ainvoke({
                "type": "tool_call", "id": "crash", "name": "crash", "args": {},
            })
            self.assertEqual(failed.status, "error")
            self.assertIn("结果未知", str(failed.content))
            async with asyncio.timeout(10):
                with self.assertLogs("wandrun.integrations.mcp", level="WARNING") as logs:
                    mismatch = await by_name["lookup"].ainvoke({
                        "type": "tool_call", "id": "lookup", "name": "lookup",
                        "args": {"query": "old schema"},
                    })
            self.assertEqual(mismatch.status, "error")
            self.assertIn("id", str(mismatch.content))
            self.assertIn("required", str(mismatch.content).lower())
            self.assertTrue(any("工具目录已变化，沿用首次发现的定义" in message
                                for message in logs.output))
            current = await pool.open("schema", connection)
            self.assertIs(current, original)
            self.assertEqual(set(by_name["lookup"].args), {"query"})
            removed = await by_name["removed"].ainvoke({
                "type": "tool_call", "id": "removed", "name": "removed", "args": {},
            })
            self.assertEqual(removed.status, "error")
            self.assertIn("已不再提供", str(removed.content))

    async def test_cancelled_waiter_then_shutdown_interrupts_real_stuck_discovery(self):
        pid_file = self.directory / "stuck.pid"
        requested = self.directory / "requested"
        connection = {
            "command": sys.executable,
            "args": ["-c", STDIO_STUCK_SERVER, str(pid_file), str(requested)],
        }
        pool = MCPConnectionPool()
        opening = asyncio.create_task(pool.open("stuck", connection))
        try:
            async with asyncio.timeout(10):
                while not requested.exists():
                    await asyncio.sleep(0.02)
            opening.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await opening
            await asyncio.wait_for(pool.aclose(), 15)
            self.assertTrue(pool._services["stuck"].task.done())
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)
        finally:
            if not opening.done():
                opening.cancel()
            if pid_file.exists():
                try:
                    os.kill(int(pid_file.read_text()), 9)
                except ProcessLookupError:
                    pass

    async def test_real_sdk_stdio_and_http_errors_never_expose_escaped_secret(self):
        secret = "key'\nvalue"
        stdio = {
            "command": sys.executable,
            "args": ["-c", STDIO_SECRET_SERVER],
            "env": {"WANDRUN_MCP_REVIEW_SECRET": secret},
        }
        http = {
            "url": "http://127.0.0.1:1/mcp",
            "headers": {"X-API-Key": secret},
        }
        async with MCPConnectionPool() as pool:
            for name, connection in (("stdio", stdio), ("http", http)):
                with self.subTest(name=name):
                    with self.assertRaises(MCPConnectionError) as raised:
                        await asyncio.wait_for(pool.open(name, connection), 10)
                    public = (str(raised.exception), repr(raised.exception),
                              pool.status(name, connection)["error"])
                    for variant in (secret, repr(secret)[1:-1], repr(secret.encode())[2:-1]):
                        self.assertNotIn(variant, repr(public))
