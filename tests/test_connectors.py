"""连接器经真实 HTTP、数据库和运行时准备路径；只替换 MCP 传输与模型传输。"""

import asyncio
from contextlib import AsyncExitStack
from dataclasses import replace
import io
import json
import logging
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import httpx
from langchain_core.tools import StructuredTool

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.app import ensure_agents
from wandrun.gateway.connectors import connection_fields, connector_fields, mcp_config
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import open_runtime
from test_gateway_models import subscription_fixture
from test_runtime import answer, configure, adapter_servers
from codex_test_home import isolate_codex_home



class ConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        isolate_codex_home(self)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = configure(Path(self.directory.name))
        self.store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        self.addCleanup(self.store.close)
        role = AgentDefinition("说明", "完成任务", "offline", environment="local")
        self.store.import_agents(AgentCatalog("main", {"main": role, "other": role}))
        self.opened, self.closed, self.connections, self.calls = [], [], {}, []
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        self.block = False
        self.probe_failure = self.call_failure = False
        owner = self

        class Adapter:
            def __init__(self, config):
                self.identity, self.connection = next(iter(adapter_servers(config).items()))
                self.client = self

            async def __aenter__(self):
                owner.opened.append(self.identity)
                owner.connections[self.identity] = self.connection
                owner.entered.set()
                if owner.block:
                    await owner.release.wait()
                if "broken" in self.connection.get("url", ""):
                    secret = self.connection.get("headers", {}).get("Authorization", "none")
                    logging.getLogger("fastmcp.client").error("connection credential: %r", secret)
                    raise ValueError("Authentication failed: " + repr(secret))
                return self

            async def __aexit__(self, *args):
                pass

            async def close(self):
                owner.closed.append(self.identity)

            async def ping(self):
                return True

            async def list_tools(self, *, cache_mode=None):
                if owner.probe_failure:
                    raise ConnectionError("Connection closed")
                async def echo(text: str) -> str:
                    owner.calls.append(text)
                    if owner.call_failure:
                        raise ConnectionError("Connection closed")
                    return "echo:" + text
                return [StructuredTool.from_function(coroutine=echo, name="echo", description="Echo text")]

        self.adapter = patch("wandrun.integrations.mcp.MCPAdapter", Adapter)
        self.adapter.start()
        self.addCleanup(self.adapter.stop)
        self.stack = AsyncExitStack()
        self.addAsyncCleanup(self.stack.aclose)
        subscription, _ = subscription_fixture(self, self.store)
        self.gateway = Gateway(self.store, subscription)
        self.runtime = await self.stack.enter_async_context(open_runtime(
            self.workspace, metrics=RunMetrics(self.workspace.runs_dir),
            agent_catalog=self.store.agent_catalog(), mcp_servers={}, mcp_descriptions={},
            on_human=self.gateway.on_human, on_task=self.gateway.on_task, notify_human_of_roots=False,
        ))
        self.gateway.attach(self.runtime.workers, self.runtime.checkpointer, runtime=self.runtime)
        self.client = await self.stack.enter_async_context(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "dev")),
            base_url="http://gateway", headers={"Authorization": "Bearer dev"},
        ))

    async def create(self, **fields):
        response = await self.client.post("/connectors", json={
            "client_id": "create", "name": "文档", "description": "查询文档", "url": "https://example.com/mcp",
            **fields,
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    async def test_invalid_url_reports_address_without_internal_path_or_persistence(self):
        before = self.store.last_seq()
        response = await self.client.post("/connectors", json={
            "client_id": "bad-url", "name": "文档", "description": "查询文档", "url": "http://[",
        })
        self.assertEqual(response.status_code, 400)
        message = response.json()["error"]["message"]
        self.assertIn("地址", message)
        self.assertNotIn("Invalid IPv6", message)
        self.assertNotIn("mcp_servers.", message)
        self.assertEqual(self.store.last_seq(), before)
        self.assertEqual(self.store.connector_definitions(), {})

    async def test_secrets_merge_delete_and_replay_never_return_values(self):
        original = await self.create(headers={"Authorization": "private-token", "X-Key": "second-secret"})
        identity = original["connector"]["id"]
        self.assertEqual(self.opened, [])
        self.assertEqual(original["connector"]["headers"], {"Authorization": True, "X-Key": True})
        for path in ("/connectors", f"/connectors/{identity}"):
            response = await self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("private-token", response.text)
            self.assertNotIn("second-secret", response.text)
        changed = await self.client.patch(f"/connectors/{identity}", json={
            "name": "改名", "headers": {"X-Key": None, "X-New": "new-secret"},
        })
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(self.store.connector_definitions()[identity]["headers"], {
            "Authorization": "private-token", "X-New": "new-secret",
        })
        await self.client.patch(f"/connectors/{identity}", json={"headers": {"X-New": ""}})
        self.assertEqual(self.store.connector_definitions()[identity]["headers"], {"Authorization": "private-token"})
        replay = await self.client.post("/connectors", json={"client_id": "create", "name": "ignored"})
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["connector"], original["connector"])
        seq = self.store.last_seq()
        noop = await self.client.patch(f"/connectors/{identity}", json={"name": "改名"})
        self.assertIsNone(noop.json()["event"])
        self.assertEqual(self.store.last_seq(), seq)
        for secret in ("private-token", "second-secret", "new-secret"):
            self.assertNotIn(secret, json.dumps([event.to_dict() for event in self.store.after(0)]))
            rows = self.store._connection.execute("SELECT detail FROM created_connector_results").fetchall()
            self.assertNotIn(secret, str(rows))
        collision = await self.client.post("/agents", json={"client_id": "create"})
        self.assertEqual(collision.status_code, 409)

    async def test_local_fields_and_transport_switch_do_not_reuse_secrets(self):
        remote = await self.create(headers={"Authorization": "old-key"})
        identity = remote["connector"]["id"]
        switched = await self.client.patch(f"/connectors/{identity}", json={
            "command": "python", "args": ["-m", "server"], "env": {"TOKEN": "env-secret", "OTHER": "keep"},
        })
        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertNotIn("headers", switched.json()["connector"])
        self.assertNotIn("url", switched.json()["connector"])
        self.assertEqual(switched.json()["connector"]["env"], {"TOKEN": True, "OTHER": True})
        await self.client.patch(f"/connectors/{identity}", json={"env": {"TOKEN": None}})
        self.assertEqual(self.store.connector_definitions()[identity]["env"], {"OTHER": "keep"})
        for path in ("/connectors", f"/connectors/{identity}"):
            response = await self.client.get(path)
            self.assertNotIn("env-secret", response.text)
            self.assertNotIn('"keep"', response.text)

    async def test_test_connection_cache_edit_next_restart_and_delete_conflict(self):
        identity = (await self.create())["connector"]["id"]
        tested = await self.client.post(f"/connectors/{identity}/test")
        self.assertEqual(tested.json(), {"success": True, "tool_count": 1, "error": None, "pending_restart": False})
        selected = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(selected.status_code, 200, selected.text)
        self.assertEqual(self.opened, [identity])
        detail = (await self.client.get(f"/connectors/{identity}")).json()
        self.assertEqual(detail["used_by"], [{"id": "main", "name": "main"}])
        rejected = await self.client.delete(f"/connectors/{identity}")
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(rejected.json()["error"]["details"]["used_by"], detail["used_by"])
        with patch.object(self.runtime, "refresh_mcp", side_effect=AssertionError("static update rebuilt Agent")):
            updated = await self.client.patch(f"/connectors/{identity}", json={"url": "https://example.com/new"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertTrue(updated.json()["connector"]["pending_restart"])
        retested = await self.client.post(f"/connectors/{identity}/test")
        self.assertTrue(retested.json()["success"])
        self.assertTrue(retested.json()["pending_restart"])
        self.assertEqual(self.connections[identity]["url"], "https://example.com/mcp")
        self.assertEqual(self.opened, [identity])
        removed = await self.client.patch("/agents/main", json={"mcp_servers": []})
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(self.closed, [])
        deleted = await self.client.delete(f"/connectors/{identity}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual((await self.client.delete(f"/connectors/{identity}")).json(), deleted.json())
        self.assertEqual((await self.client.get(f"/connectors/{identity}")).status_code, 404)
        self.assertEqual(self.closed, [])
        await self.stack.aclose()
        self.assertEqual(self.closed, [identity])
        self.assertEqual(deleted.json()["event"]["data"], {"kind": "connector", "id": identity, "op": "deleted"})

    async def test_parameter_edit_stays_pending_and_recovery_uses_original_url_and_headers(self):
        identity = (await self.create(headers={"Authorization": "before"}))["connector"]["id"]
        selected = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(selected.status_code, 200, selected.text)
        graph = self.runtime._assembly_for("main")
        original = connection_fields(self.store.connector_definitions()[identity])
        tool = (await self.runtime.mcp.open(identity, original))[0]
        state = self.runtime.mcp._services[identity]
        changed = await self.client.patch(f"/connectors/{identity}", json={
            "url": "https://example.com/next", "headers": {"Authorization": "after"},
        })
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertTrue(changed.json()["connector"]["pending_restart"])
        self.assertIs(self.runtime._assembly_for("main"), graph)
        self.call_failure = True
        self.assertIn("调用失败", await tool.ainvoke({"text": "first"}))
        self.call_failure = False
        with patch.object(state.client, "ping", side_effect=ConnectionError("closed")), \
             patch.object(self.runtime, "refresh_mcp", side_effect=AssertionError("unexpected graph refresh")):
            async with asyncio.timeout(8):
                self.assertEqual(await tool.ainvoke({"text": "second"}), "echo:second")
        self.assertEqual(self.opened, [identity, identity])
        self.assertEqual(self.closed, [identity])
        self.assertEqual(self.connections[identity]["url"], original["url"])
        self.assertEqual(self.connections[identity]["headers"]["Authorization"], "before")
        self.assertTrue((await self.client.get(f"/connectors/{identity}")).json()["pending_restart"])
        self.assertIs(self.runtime._assembly_for("main"), graph)
        tested = (await self.client.post(f"/connectors/{identity}/test")).json()
        self.assertTrue(tested["success"])
        self.assertTrue(tested["pending_restart"])

    async def test_imported_static_connector_without_auth_type_keeps_live_session(self):
        identity = (await self.create())["connector"]["id"]
        legacy = self.store.connector_definitions()[identity]
        legacy.pop("auth_type")
        self.store.update_connector(legacy)  # As with a complete TOML import.
        self.assertTrue((await self.client.post(f"/connectors/{identity}/test")).json()["success"])
        changed = await self.client.patch(f"/connectors/{identity}", json={
            "url": "https://example.com/new",
        })
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["connector"]["auth_type"], "none")
        self.assertTrue(changed.json()["connector"]["pending_restart"])
        self.assertEqual(self.closed, [])
        self.assertEqual(self.connections[identity]["url"], "https://example.com/mcp")

    async def test_probe_failure_reports_request_without_retiring_live_session(self):
        identity = (await self.create())["connector"]["id"]
        self.assertTrue((await self.client.post(f"/connectors/{identity}/test")).json()["success"])
        self.probe_failure = True
        failed = (await self.client.post(f"/connectors/{identity}/test")).json()
        self.assertFalse(failed["success"])
        self.assertIn("工具发现失败", failed["error"])
        detail = (await self.client.get(f"/connectors/{identity}")).json()
        self.assertEqual((detail["status"], detail["tool_count"]), ("connected", 1))
        self.assertEqual(self.opened, [identity])
        self.probe_failure = False
        edited = await self.client.patch(f"/connectors/{identity}", json={"url": "https://example.com/next"})
        self.assertTrue(edited.json()["connector"]["pending_restart"])
        retested = (await self.client.post(f"/connectors/{identity}/test")).json()
        self.assertTrue(retested["success"])
        self.assertTrue(retested["pending_restart"])
        self.assertEqual(self.connections[identity]["url"], "https://example.com/mcp")
        self.assertEqual(self.opened, [identity])

    async def test_tool_transport_failure_does_not_block_recovery(self):
        identity = (await self.create())["connector"]["id"]
        tools = await self.runtime.mcp.open(identity, connection_fields(self.store.connector_definitions()[identity]))
        self.call_failure = True
        result = await tools[0].ainvoke({"text": "lost"})
        self.assertIn("调用失败", result)
        self.call_failure = False
        tested = (await self.client.post(f"/connectors/{identity}/test")).json()
        self.assertTrue(tested["success"])
        self.assertEqual((await self.client.get("/connectors")).json()["connectors"][0]["status"], "connected")
        self.assertEqual(self.opened, [identity])

    async def test_failed_prepare_keeps_agent_and_redacts_failure_and_logs(self):
        secret = "never-show-this-credential"
        identity = (await self.create(url="https://example.com/broken", headers={"Authorization": secret}))["connector"]["id"]
        before = self.store.agent("main")
        messages = io.StringIO()
        handler = logging.StreamHandler(messages)
        logging.getLogger().addHandler(handler)
        self.addCleanup(logging.getLogger().removeHandler, handler)
        rejected = await self.client.patch("/agents/main", json={"mcp_servers": [identity], "name": "不能保存"})
        self.assertEqual(rejected.status_code, 400, rejected.text)
        self.assertEqual(self.store.agent("main"), before)
        failed = await self.client.post(f"/connectors/{identity}/test")
        self.assertFalse(failed.json()["success"])
        self.assertTrue(failed.json()["error"])
        detail = await self.client.get(f"/connectors/{identity}")
        self.assertEqual(detail.json()["status"], "failed")
        for text in (rejected.text, failed.text, detail.text, (await self.client.get("/connectors")).text, messages.getvalue()):
            self.assertNotIn(secret, text)
        self.assertEqual(self.opened, [identity, identity])
        await self.client.patch(f"/connectors/{identity}", json={"url": "https://example.com/fixed"})
        success = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(success.status_code, 200, success.text)
        self.assertEqual(self.store.agent("main")["mcp_servers"], [identity])

    async def test_escaped_header_secret_never_leaks_from_gateway_errors(self):
        secret = "sensitive-before\nsensitive-after"
        escaped = secret.encode("unicode_escape").decode("ascii")
        identity = (await self.create(
            url="https://example.com/broken", headers={"Authorization": secret},
        ))["connector"]["id"]
        original = self.store.agent("main")
        rejected = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(self.store.agent("main"), original)
        failed = await self.client.post(f"/connectors/{identity}/test")
        self.assertFalse(failed.json()["success"])
        detail = await self.client.get(f"/connectors/{identity}")
        listing = await self.client.get("/connectors")
        for response in (rejected, failed, detail, listing):
            self.assertNotIn(secret, response.text)
            self.assertNotIn(escaped, response.text)
            self.assertNotIn("sensitive-before", response.text)
            self.assertNotIn("sensitive-after", response.text)

    async def test_searchable_validation_and_definition_edit_use_same_rules(self):
        identity = (await self.create(description=""))["connector"]["id"]
        rejected = await self.client.patch("/agents/main", json={"searchable_mcp_servers": [identity]})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(self.opened, [])
        await self.client.patch(f"/connectors/{identity}", json={"description": "文档查询"})
        selected = await self.client.patch("/agents/main", json={"searchable_mcp_servers": [identity]})
        self.assertEqual(selected.status_code, 200, selected.text)
        rejected = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(rejected.status_code, 400)
        rejected = await self.client.patch(f"/connectors/{identity}", json={"description": ""})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(self.store.connector_definitions()[identity]["description"], "文档查询")

    async def test_agent_edit_next_execution_calls_new_connector_tool(self):
        identity = (await self.create())["connector"]["id"]
        name = identity + "_echo"

        async def respond(model, body):
            available = {tool.get("name") for tool in body.get("tools", [])}
            results = [item for item in body.get("input", []) if item.get("type") == "function_call_output"]
            if name in available and not results:
                yield {
                    "type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "function_call", "id": "fc-dynamic", "call_id": "dynamic",
                            "name": name, "arguments": json.dumps({"text": "new-tool"}),
                        }],
                    },
                }
            else:
                yield answer("工具调用完成" if results else "尚未选择连接器")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            root = self.gateway.create_conversation("动态连接器", "main")["id"]
            self.gateway.send_message(root, "before", "第一轮")
            self.assertEqual((await self.runtime.workers.wait(root))["status"], "completed")
            self.assertEqual(self.calls, [])
            edited = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
            self.assertEqual(edited.status_code, 200, edited.text)
            self.gateway.send_message(root, "after", "第二轮调用新工具")
            state = await self.runtime.workers.wait(root)
            self.assertEqual(state["status"], "completed", state)
        self.assertEqual(self.calls, ["new-tool"])
        self.assertEqual(
            [event.data["text"] for event in self.store.history(root) if event.type == "message.agent"],
            ["尚未选择连接器", "工具调用完成"],
        )

    async def test_unreferenced_auth_cutover_reopens_current_tool_when_agent_returns(self):
        identity = (await self.create(headers={"Authorization": "static-before"}))["connector"]["id"]
        selected = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(selected.status_code, 200, selected.text)
        removed = await self.client.patch("/agents/main", json={"mcp_servers": []})
        self.assertEqual(removed.status_code, 200, removed.text)
        for fields in (
            {"auth_type": "oauth"},
            {"auth_type": "none", "headers": {"Authorization": "static-after"}},
        ):
            changed = await self.client.patch(f"/connectors/{identity}", json=fields)
            self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(self.opened, [identity], "unused authentication edits must not open a service")
        returned = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(returned.status_code, 200, returned.text)

        bodies = []

        async def respond(model, body):
            bodies.append(body)
            if len(bodies) == 1:
                yield {
                    "type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "function_call", "id": "fc-cutover", "call_id": "cutover",
                            "name": identity + "_echo", "arguments": json.dumps({"text": "after-cutover"}),
                        }],
                    },
                }
            else:
                yield answer("read after authentication cutover")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            root = self.gateway.create_conversation("认证切换后重新使用", "main")["id"]
            self.gateway.send_message(root, "read-current", "调用当前连接器")
            result = await self.runtime.workers.wait(root)
            self.assertEqual(result["status"], "completed", result)
        self.assertEqual(self.calls, ["after-cutover"])
        self.assertEqual(self.connections[identity]["headers"]["Authorization"], "static-after")
        tool_results = [
            item["output"] for item in bodies[1]["input"] if item.get("type") == "function_call_output"
        ]
        self.assertIn("echo:after-cutover", json.dumps(tool_results))

    async def test_concurrent_test_and_agent_prepare_merge_without_lost_edits(self):
        identity = (await self.create())["connector"]["id"]
        self.block = True
        first = asyncio.create_task(self.client.post(f"/connectors/{identity}/test"))
        await self.entered.wait()
        selecting = asyncio.create_task(self.client.patch("/agents/main", json={"mcp_servers": [identity]}))
        renaming = asyncio.create_task(self.client.patch("/agents/other", json={"name": "并发新名字"}))
        self.release.set()
        responses = await asyncio.gather(first, selecting, renaming)
        self.assertEqual([response.status_code for response in responses], [200, 200, 200])
        self.assertEqual(self.opened, [identity])
        self.assertEqual(self.store.agent("other")["name"], "并发新名字")
        self.assertEqual(self.store.agent("main")["mcp_servers"], [identity])
        status_events = [event for event in self.store.after(0) if event.data.get("op") == "status"]
        self.assertEqual([event.data["id"] for event in status_events], [identity])

    async def test_waiting_catalog_edit_validates_against_latest_pair(self):
        identity = (await self.create())["connector"]["id"]
        self.block = True
        original_update = self.gateway.update_agent
        second_entered = asyncio.Event()

        async def update_agent(agent_id, fields):
            if fields.get("name") == "新名字":
                second_entered.set()
            return await original_update(agent_id, fields)

        with patch.object(self.gateway, "update_agent", side_effect=update_agent):
            first = asyncio.create_task(self.client.patch("/agents/main", json={
                "reasoning_effort": "xhigh", "mcp_servers": [identity],
            }))
            await asyncio.wait_for(self.entered.wait(), 5)
            second = asyncio.create_task(self.client.patch("/agents/main", json={
                "model": "offline", "reasoning_effort": None, "name": "新名字",
            }))
            try:
                await asyncio.wait_for(second_entered.wait(), 5)
                self.assertFalse(second.done())
            finally:
                self.release.set()
            changed, renamed = await asyncio.wait_for(asyncio.gather(first, second), 5)
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(renamed.status_code, 200, renamed.text)
        current = self.store.agent("main")
        self.assertEqual((current["name"], current["model"], current["reasoning_effort"]),
                         ("新名字", "offline", None))
        self.assertEqual(current["mcp_servers"], [identity])

    async def test_stop_claims_client_id_while_agent_creation_prepares_connector(self):
        identity = (await self.create())["connector"]["id"]
        started, model_release = asyncio.Event(), asyncio.Event()

        async def respond(model, body):
            started.set()
            await model_release.wait()
            yield answer("完成")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            root = self.gateway.create_conversation("运行中", "main")["id"]
            self.gateway.send_message(root, "message", "开始")
            await asyncio.wait_for(started.wait(), 5)
            self.block = True
            creating = asyncio.create_task(self.client.post("/agents", json={
                "client_id": "shared", "name": "新角色", "description": "查询",
                "system_prompt": "使用连接器", "model": "offline", "mcp_servers": [identity],
            }))
            await asyncio.wait_for(self.entered.wait(), 5)
            cleanup_started, cleanup_release = asyncio.Event(), asyncio.Event()
            original_cancel = self.runtime.workers.cancel

            async def slow_cancel(task_id):
                result = await original_cancel(task_id)
                cleanup_started.set()
                await cleanup_release.wait()
                return result

            with patch.object(self.runtime.workers, "cancel", slow_cancel):
                stopping = asyncio.create_task(self.client.post(
                    f"/conversations/{root}/stop", json={"client_id": "shared"},
                ))
                try:
                    await asyncio.wait_for(cleanup_started.wait(), 5)
                    self.release.set()
                    rejected = await asyncio.wait_for(creating, 5)
                    self.assertEqual((rejected.status_code, rejected.json()["error"]["code"]),
                                     (409, "client_id_reused"))
                    self.assertEqual(len(self.store.agents()), 2)
                finally:
                    self.release.set()
                    cleanup_release.set()
                    model_release.set()
                stopped = await asyncio.wait_for(stopping, 5)
        self.assertEqual(stopped.status_code, 202, stopped.text)
        self.assertEqual(stopped.json()["event"]["type"], "turn.stopped")
        self.assertEqual(self.store.by_client_id("shared").type, "turn.stopped")
        self.assertEqual(len(self.store.agents()), 2)


class ConnectorImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = configure(Path(self.directory.name))
        self.store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        self.addCleanup(self.store.close)

    def test_import_once_including_unused_connector_and_no_later_toml_reads(self):
        self.workspace.mcps_config.write_text(
            '[mcp_servers.docs]\nurl="https://example.com/mcp"\ndescription="Docs"\n'
            'headers={Authorization="stored-secret"}\n', encoding="utf-8",
        )
        paths = (self.workspace.agents_config, self.workspace.mcps_config, self.workspace.environments_config)
        ensure_agents(self.store, *paths)
        definitions = self.store.connector_definitions()
        self.assertEqual(definitions["docs"]["headers"], {"Authorization": "stored-secret"})
        self.assertEqual(definitions["docs"]["name"], "docs")
        self.workspace.agents_config.unlink()
        self.workspace.mcps_config.unlink()
        ensure_agents(self.store, *paths)
        self.assertEqual(self.store.connector_definitions(), definitions)
        self.store.delete_connector("docs")
        ensure_agents(self.store, *paths)
        self.assertEqual(self.store.connector_definitions(), {})

    def test_import_preserves_empty_secrets_but_patch_deletes_them(self):
        self.workspace.mcps_config.write_text(
            '[mcp_servers.local]\ncommand="python"\n'
            'env={WANDRUN_REVIEW_FEATURE="", TOKEN="kept"}\n'
            '[mcp_servers.remote]\nurl="https://example.com/mcp"\n'
            'headers={Authorization="", Other="kept"}\n', encoding="utf-8",
        )
        ensure_agents(
            self.store, self.workspace.agents_config, self.workspace.mcps_config,
            self.workspace.environments_config,
        )
        definitions = self.store.connector_definitions()
        connections, _ = mcp_config(definitions)
        self.assertEqual(connections["local"]["env"], {"WANDRUN_REVIEW_FEATURE": "", "TOKEN": "kept"})
        self.assertEqual(connections["remote"]["headers"], {"Authorization": "", "Other": "kept"})
        # 同一个空字符串只在 API 补丁路径表示删除；其他键不能被清空。
        for identity, field, key, remaining in (
            ("local", "env", "WANDRUN_REVIEW_FEATURE", {"TOKEN": "kept"}),
            ("remote", "headers", "Authorization", {"Other": "kept"}),
        ):
            with self.subTest(identity=identity):
                patched = connector_fields(identity, {field: {key: ""}}, definitions[identity])
                self.store.update_connector(patched)
                self.assertEqual(self.store.connector_definitions()[identity][field], remaining)

    def test_import_transaction_rolls_back_connectors_agents_and_marker(self):
        role = AgentDefinition("d", "p", "offline", environment="local", workers=("missing",))
        definition = connector_fields("docs", {"name": "Docs", "url": "https://example.com/mcp"})
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.import_agents(AgentCatalog("main", {"main": role}), {"docs": definition})
        self.assertFalse(self.store.has_imported_agents())
        self.assertFalse(self.store.has_agents())
        self.assertEqual(self.store.connector_definitions(), {})
        self.store.import_agents(AgentCatalog("main", {"main": replace(role, workers=())}), {"docs": definition})
        self.assertEqual(mcp_config(self.store.connector_definitions())[0], {"docs": {"url": "https://example.com/mcp"}})

    def test_connector_transaction_rolls_back_on_event_write_failure(self):
        self.store.import_agents(AgentCatalog(None, {}))
        definition = connector_fields("docs", {"name": "Docs", "url": "https://example.com/mcp"})
        with patch.object(self.store, "_connector_event", side_effect=sqlite3.OperationalError("disk full")):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.create_connector(definition, "create")
        self.assertEqual(self.store.connector_definitions(), {})
        self.assertIsNone(self.store.replay_create_connector("create"))
        self.store.create_connector(definition, "create")
        with patch.object(self.store, "_connector_event", side_effect=sqlite3.OperationalError("disk full")):
            with self.assertRaises(sqlite3.OperationalError):
                self.store.update_connector({**definition, "name": "new"})
            with self.assertRaises(sqlite3.OperationalError):
                self.store.delete_connector("docs")
        self.assertEqual(self.store.connector_definitions()["docs"], definition)
