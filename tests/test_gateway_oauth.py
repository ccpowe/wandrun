"""Real local DCR/PKCE/MCP peer through the gateway's HTTP, store and pool boundaries."""

import asyncio
import json
import logging
import socket
import sys
import tempfile
import time
import unittest
from contextlib import AsyncExitStack
from unittest.mock import patch
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

import httpx
import uvicorn

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.connectors import connection_fields
from wandrun.gateway.http import create_app
from wandrun.gateway.oauth import GatewayOAuthRecords
from wandrun.integrations.mcp_oauth import ConnectorOAuth, OAuthIssue, OAuthUnavailable
from wandrun.gateway.service import Gateway, GatewayFailure
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.mcp import MCPConnectionPool
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import open_runtime
from test_gateway_models import subscription_fixture
from test_runtime import configure
from codex_test_home import isolate_codex_home
from oauth_server import ProtocolState, create_app as controlled_peer


class GatewayOAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        isolate_codex_home(self)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.workspace = configure(Path(directory.name))
        self.store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        self.addCleanup(self.store.close)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        sock.setblocking(False)
        self.peer = ProtocolState(f"http://127.0.0.1:{sock.getsockname()[1]}")
        self.server = uvicorn.Server(uvicorn.Config(
            controlled_peer(self.peer), host="127.0.0.1", port=sock.getsockname()[1],
            lifespan="off", access_log=False, log_level="critical",
        ))
        self.serving = asyncio.create_task(self.server.serve(sockets=[sock]))
        self.addAsyncCleanup(self.stop_peer)
        async with asyncio.timeout(5):
            while not self.server.started:
                await asyncio.sleep(0.01)
        role = AgentDefinition("OAuth 测试", "Read controlled notes", "offline",
                               mcp_servers=("remote",), environment="local")
        self.store.import_agents(AgentCatalog("main", {"main": role}), {
            "remote": {"id": "remote", "name": "Controlled", "description": "Read controlled notes",
                       "url": self.peer.resource, "transport": "streamable-http", "auth_type": "oauth"},
        })
        subscription, _ = subscription_fixture(self, self.store)
        self.gateway = Gateway(self.store, subscription)
        self.stack = AsyncExitStack()
        self.addAsyncCleanup(self.stack.aclose)
        self.runtime = await self.stack.enter_async_context(open_runtime(
            self.workspace, metrics=RunMetrics(self.workspace.runs_dir),
            agent_catalog=self.store.agent_catalog(),
            mcp_servers={"remote": {"url": self.peer.resource, "transport": "streamable-http"}},
            mcp_descriptions={"remote": "Read controlled notes"},
            mcp_oauth=self.gateway.oauth, oauth_connectors={"remote"},
            on_human=self.gateway.on_human, on_task=self.gateway.on_task,
            notify_human_of_roots=False,
        ))
        self.gateway.attach(self.runtime.workers, self.runtime.checkpointer, runtime=self.runtime)
        self.client = await self.stack.enter_async_context(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "dev")),
            base_url="http://gateway", headers={"Authorization": "Bearer dev"},
        ))
        self.browser = await self.stack.enter_async_context(httpx.AsyncClient(follow_redirects=False))

    async def stop_peer(self):
        self.server.should_exit = True
        await asyncio.wait_for(self.serving, 5)

    async def test_probe_classifies_without_credentials_registration_or_events(self):
        before = self.store.last_seq()
        for mode, expected in (("none", "none"), ("oauth", "oauth"), ("key", "key"), ("failed", "failed")):
            self.peer.auth_mode = mode
            response = await self.client.post("/connectors/probe", json={"url": self.peer.resource})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["result"], expected, response.text)
            if expected == "oauth":
                self.assertTrue(response.json()["oauth"]["dcr_supported"])
        self.assertEqual(self.store.last_seq(), before)
        self.assertFalse(any("authorization" in headers for headers in self.peer.received_headers))
        self.assertFalse(any(kind == "register" for kind, _ in self.peer.requests))
        self.peer.auth_mode, self.peer.support_dcr = "oauth", False
        probe = (await self.client.post("/connectors/probe", json={"url": self.peer.resource})).json()
        self.assertEqual(probe["result"], "oauth")
        self.assertFalse(probe["oauth"]["dcr_supported"])
        rejected = await self.client.post("/connectors", json={
            "client_id": "unsupported", "url": self.peer.resource, "auth_type": "oauth",
        })
        self.assertEqual(rejected.status_code, 409, rejected.text)
        self.assertEqual(rejected.json()["error"]["code"], "oauth_dcr_unsupported")
        self.assertEqual(set(self.store.connector_definitions()), {"remote"})
        self.peer.auth_mode, self.peer.unauthorized_status = "key", 403
        forbidden = await self.client.post("/connectors/probe", json={"url": self.peer.resource})
        self.assertEqual(forbidden.json()["result"], "key")
        for invalid in ({"command": "npx"}, {"url": self.peer.resource, "headers": {"X-Key": "secret"}}):
            rejected = await self.client.post("/connectors/probe", json=invalid)
            self.assertEqual(rejected.status_code, 400)

    async def test_probe_discovers_authorization_without_challenge_metadata(self):
        self.peer.challenge_metadata, self.peer.prm_available = False, False
        probe = await self.client.post("/connectors/probe", json={"url": self.peer.resource})
        self.assertEqual(probe.json()["result"], "oauth", probe.text)

    async def test_failed_creation_reuses_initial_response_without_reconnecting(self):
        for mode, expected_status in (("failed", 502), ("oauth", 409)):
            self.peer.auth_mode = mode
            before = len(self.peer.mcp_requests)
            response = await self.client.post("/connectors", json={
                "client_id": "failed-" + mode, "url": self.peer.resource,
            })
            self.assertEqual(response.status_code, expected_status, response.text)
            attempts = self.peer.mcp_requests[before:]
            self.assertEqual(attempts.count(("POST", "initialize")), 1, attempts)

    async def test_asm_only_creation_completes_oauth_with_resource_binding(self):
        self.peer.challenge_metadata, self.peer.prm_available = False, False
        response = await self.client.post("/connectors", json={
            "client_id": "asm-only", "url": self.peer.resource, "auth_type": "oauth",
        })
        self.assertEqual(response.status_code, 201, response.text)
        identity = response.json()["connector"]["id"]
        started = await self.client.post(f"/connectors/{identity}/oauth/start")
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(parse_qs(urlsplit(started.json()["authorization_url"]).query)["resource"],
                         [self.peer.resource])
        redirect = await self.browser.get(started.json()["authorization_url"])
        self.assertEqual(redirect.status_code, 302, redirect.text)
        completed = await self.client.post(f"/connectors/{identity}/oauth/callback",
                                           json={"url": redirect.headers["location"]})
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertEqual(completed.json()["connector"]["auth"]["status"], "authorized")
        exchanges = [data for kind, data in self.peer.requests if kind == "token"]
        self.assertEqual(exchanges[-1]["resource"], self.peer.resource)

    async def test_imported_and_catalog_values_survive_successful_authorization(self):
        from wandrun.gateway.connectors import MCP_APPS
        with patch.dict(MCP_APPS["notion"], {"url": self.peer.resource}):
            bound = await self.client.post("/apps/notion/connect", json={"client_id": "catalog-fixed"})
        identities = ("remote", bound.json()["connector"]["id"])
        for identity in identities:
            before = (await self.client.get(f"/connectors/{identity}")).json()
            started = await self.client.post(f"/connectors/{identity}/oauth/start")
            self.assertEqual(started.status_code, 200, started.text)
            redirect = await self.browser.get(started.json()["authorization_url"])
            completed = await self.client.post(f"/connectors/{identity}/oauth/callback",
                                               json={"url": redirect.headers["location"]})
            self.assertEqual(completed.status_code, 200, completed.text)
            after = completed.json()["connector"]
            self.assertEqual((after["name"], after["description"]), (before["name"], before["description"]))
            self.assertEqual((after["name_source"], after["description_source"]), ("user", "user"))

    async def test_create_classifies_oauth_mismatch_and_failure_without_persistence(self):
        before = self.store.last_seq()
        for mode, fields, status, code in (
            ("oauth", {}, 409, "authentication_mismatch"),
            ("failed", {}, 502, "connection_failed"),
            ("key", {"auth_type": "key", "headers": {"Authorization": "Bearer wrong-key"}}, 502, "connection_failed"),
        ):
            self.peer.auth_mode = mode
            response = await self.client.post("/connectors", json={
                "client_id": "retry-after-failure", "url": self.peer.resource, **fields,
            })
            self.assertEqual(response.status_code, status, response.text)
            self.assertEqual(response.json()["error"]["code"], code)
            self.assertNotIn("wrong-key", response.text)
            self.assertEqual(self.store.last_seq(), before)
            self.assertEqual(set(self.store.connector_definitions()), {"remote"})


    async def test_connect_submits_credentials_derives_metadata_and_preserves_user_fields(self):
        self.peer.auth_mode = "key"
        self.peer.server_info.update(title="Notes", description="Search notes.",
                                     icons=[{"src": "https://example.com/icon.png"}])
        mismatch = await self.client.post("/connectors", json={
            "client_id": "new", "url": self.peer.resource, "auth_type": "none",
        })
        self.assertEqual(mismatch.status_code, 409, mismatch.text)
        self.assertEqual(mismatch.json()["error"]["code"], "authentication_mismatch")
        self.assertEqual(mismatch.json()["error"]["details"]["probe"]["result"], "key")
        created = await self.client.post("/connectors", json={
            "client_id": "new", "url": self.peer.resource, "auth_type": "key",
            "headers": {"Authorization": "Bearer fixture-key"},
        })
        self.assertEqual(created.status_code, 201, created.text)
        value = created.json()["connector"]
        self.assertEqual((value["name"], value["description"], value["status"]), ("Notes", "Search notes.", "connected"))
        self.assertEqual(value["icon"], "https://example.com/icon.png")
        self.assertNotIn("fixture-key", created.text)
        identity = value["id"]
        await self.client.patch(f"/connectors/{identity}", json={"name": "My notes", "description": ""})
        tested = await self.client.post(f"/connectors/{identity}/test")
        self.assertTrue(tested.json()["success"], tested.text)
        detail = (await self.client.get(f"/connectors/{identity}")).json()
        self.assertEqual((detail["name"], detail["description"]), ("My notes", ""))
        self.assertEqual((detail["name_source"], detail["description_source"]), ("user", "user"))
        self.assertTrue(detail["description_missing"])
    async def test_connect_uses_raw_tool_titles_and_reports_empty_description(self):
        self.peer.auth_mode = "none"
        self.peer.server_info = {"name": "notes-server", "version": "1"}
        self.peer.tools = [
            {"name": "search_notes", "title": "Search", "description": "Search notes",
             "inputSchema": {"type": "object", "properties": {}}},
        ]
        first = await self.client.post("/connectors", json={"client_id": "tools", "url": self.peer.resource})
        self.assertEqual(first.status_code, 201, first.text)
        self.assertIn("Search", first.json()["connector"]["description"])
        self.assertNotIn("search_notes", first.json()["connector"]["description"])
        self.assertFalse(first.json()["connector"]["description_missing"])
        self.peer.tools = []
        empty = await self.client.post("/connectors", json={"client_id": "empty", "url": self.peer.resource})
        self.assertEqual(empty.status_code, 201, empty.text)
        self.assertEqual(empty.json()["connector"]["name"], "Notes 2")
        self.assertEqual(empty.json()["connector"]["description"], "")
        self.assertTrue(empty.json()["connector"]["description_missing"])

    async def test_connector_tools_reads_negotiated_catalog_without_connecting(self):
        before = list(self.peer.requests)
        waiting = await self.client.get("/connectors/remote/tools")
        self.assertEqual(waiting.status_code, 200)
        self.assertEqual(waiting.json()["status"], "disconnected")
        self.assertEqual(waiting.json()["tools"], [])
        self.assertEqual(self.peer.requests, before)
        self.peer.auth_mode = "none"
        self.peer.tools = [{"name": "search_notes", "title": "Search notes",
                            "description": "Find notes by text",
                            "inputSchema": {"type": "object", "properties": {}}}]
        created = await self.client.post("/connectors", json={"client_id": "tool-display", "url": self.peer.resource})
        identity = created.json()["connector"]["id"]
        before = list(self.peer.requests)
        listed = await self.client.get(f"/connectors/{identity}/tools")
        self.assertEqual(listed.json()["status"], "connected")
        self.assertEqual(listed.json()["tools"], [{"name": "search_notes", "title": "Search notes",
                                                  "description": "Find notes by text"}])
        self.assertEqual(self.peer.requests, before)
        self.assertEqual((await self.client.get("/connectors/missing/tools")).status_code, 404)

    async def test_clear_key_retires_credentials_and_reconnects_after_reentry(self):
        self.peer.auth_mode = "key"
        response = await self.client.post("/connectors", json={
            "client_id": "clear-key", "url": self.peer.resource, "auth_type": "key",
            "name": "受控密钥连接器", "description": "供 Agent 查询的受控说明",
            "headers": {"Authorization": "Bearer fixture-key"},
        })
        identity = response.json()["connector"]["id"]
        self.assertEqual(response.json()["connector"]["status"], "connected")
        assigned = await self.client.patch("/agents/main", json={"mcp_servers": [identity]})
        self.assertEqual(assigned.status_code, 200, assigned.text)
        before = (await self.client.get(f"/connectors/{identity}")).json()
        self.assertEqual([agent["id"] for agent in before["used_by"]], ["main"])
        cleared = await self.client.delete(f"/connectors/{identity}/key")
        self.assertEqual(cleared.status_code, 200, cleared.text)
        self.assertEqual(cleared.json()["connector"]["headers"], {})
        self.assertNotEqual(cleared.json()["connector"]["status"], "connected")
        self.assertEqual(self.store.connector_definitions()[identity]["headers"], {})
        self.assertNotIn("fixture-key", cleared.text)
        self.assertEqual(cleared.json()["connector"]["used_by"], before["used_by"])
        self.assertEqual(self.store.agent("main")["mcp_servers"], [identity])
        self.assertEqual(cleared.json()["connector"]["name"], "受控密钥连接器")
        self.assertEqual(cleared.json()["connector"]["description"], "供 Agent 查询的受控说明")
        restored = await self.client.patch(f"/connectors/{identity}", json={
            "headers": {"Authorization": "Bearer fixture-key"},
        })
        self.assertEqual(restored.status_code, 200, restored.text)
        tested = await self.client.post(f"/connectors/{identity}/test")
        self.assertTrue(tested.json()["success"], tested.text)
        self.assertFalse(tested.json()["pending_restart"])
        self.assertEqual((await self.client.delete("/connectors/remote/key")).status_code, 400)
    async def test_catalog_query_key_binding_sends_key_only_in_the_connection_url(self):
        from wandrun.gateway.connectors import MCP_APPS
        self.peer.auth_mode = "query-key"
        apps = {app["id"]: app for app in (await self.client.get("/apps")).json()["apps"]}
        self.assertEqual(apps["amap"]["auth"]["key"], {"in": "query", "name": "key"})
        self.assertIsNone(apps["amap"]["connector"])
        with patch.dict(MCP_APPS["amap"], {"url": self.peer.resource}):
            bound = await self.client.post("/apps/amap/connect", json={"client_id": "amap-binding"})
        self.assertEqual(bound.status_code, 200, bound.text)
        connector = bound.json()["connector"]
        identity = connector["id"]
        self.assertEqual((connector["auth_type"], connector["headers"], connector["app_id"]), ("key", {}, "amap"))
        self.assertNotEqual(connector["status"], "connected")
        # Address / auth stay catalog-owned; only the Key may be written.
        for fields in ({"url": self.peer.resource + "?key=x"}, {"auth_type": "none"},
                       {"headers": {"key": "fixture-key"}, "url": self.peer.resource},
                       # Only the declared Key may be written or cleared; no other header.
                       {"headers": {"Authorization": "fixture-key"}},
                       {"headers": {"key": "fixture-key", "X-Arbitrary": "x"}},
                       {"headers": {"Authorization": None}}):
            rejected = await self.client.patch(f"/connectors/{identity}", json=fields)
            self.assertEqual(rejected.status_code, 400, (fields, rejected.text))
        self.assertEqual(self.store.connector_definitions()[identity]["headers"], {})
        wrong = await self.client.patch(f"/connectors/{identity}", json={"headers": {"key": "wrong-key"}})
        self.assertEqual(wrong.status_code, 200, wrong.text)
        failed = await self.client.post(f"/connectors/{identity}/test")
        self.assertFalse(failed.json()["success"], failed.text)
        failed_detail = (await self.client.get(f"/connectors/{identity}")).json()
        # Invalid credentials are actionable, without exposing identifiers or secrets.
        self.assertEqual(failed_detail["status"], "failed")
        self.assertIn("Key", failed_detail["error"])
        self.assertNotIn(identity, failed_detail["error"])
        self.assertEqual(failed.json()["error"], failed_detail["error"])
        self.assertNotIn("wrong-key", failed.text)
        self.assertNotIn("wrong-key", str(failed_detail))
        self.peer.received_urls.clear()
        self.peer.received_headers.clear()
        saved = await self.client.patch(f"/connectors/{identity}", json={"headers": {"key": "fixture-key"}})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["connector"]["headers"], {"key": True})
        self.assertEqual(saved.json()["connector"]["url"], self.peer.resource)
        self.assertNotIn("fixture-key", saved.text)
        tested = await self.client.post(f"/connectors/{identity}/test")
        self.assertTrue(tested.json()["success"], tested.text)
        self.assertTrue(self.peer.received_urls and all("key=fixture-key" in url for url in self.peer.received_urls))
        self.assertFalse(any("key" in headers for headers in self.peer.received_headers))
        listed = (await self.client.get("/connectors")).text
        self.assertNotIn("fixture-key", listed)
        self.assertNotIn("fixture-key", (await self.client.get("/apps")).text)
        cleared = await self.client.delete(f"/connectors/{identity}/key")
        self.assertEqual(cleared.json()["connector"]["headers"], {})
        self.assertNotEqual(cleared.json()["connector"]["status"], "connected")

    async def test_catalog_key_standard_auth_rejection_and_unreachable_service(self):
        from wandrun.gateway.connectors import MCP_APPS
        unavailable = socket.socket()
        unavailable.bind(("127.0.0.1", 0))
        self.addCleanup(unavailable.close)
        for status in (401, 403, None):
            with self.subTest(status=status):
                self.peer.auth_mode = "key"
                self.peer.unauthorized_status = status or 401
                url = self.peer.resource if status else f"http://127.0.0.1:{unavailable.getsockname()[1]}/mcp"
                with patch.dict(MCP_APPS["amap"], {"url": url}):
                    bound = await self.client.post("/apps/amap/connect", json={"client_id": f"key-{status}"})
                identity = bound.json()["connector"]["id"]
                await self.client.patch(f"/connectors/{identity}", json={"headers": {"key": "private-invalid"}})
                result = await self.client.post(f"/connectors/{identity}/test")
                self.assertFalse(result.json()["success"], result.text)
                message = result.json()["error"]
                self.assertEqual("Key" in message, status is not None)
                self.assertNotIn(identity, message)
                if status is None:
                    self.assertIn("无法连接", message)
                self.assertNotIn("private-invalid", message)
                self.assertEqual((await self.client.get(f"/connectors/{identity}")).json()["error"], message)
                await self.client.delete(f"/connectors/{identity}")

    async def test_local_connect_initializes_command_args_and_environment_in_one_request(self):
        script = self.workspace.root / "local_peer.py"
        script.write_text(
            "import os\nfrom fastmcp import FastMCP\n"
            "mcp = FastMCP(os.environ['PEER_NAME'], instructions='Read local notes.')\n"
            "@mcp.tool\n"
            "def read_note() -> str:\n    return 'local note'\n"
            "mcp.run(transport='stdio', show_banner=False)\n",
            encoding="utf-8",
        )
        response = await self.client.post("/connectors", json={
            "client_id": "local", "command": sys.executable, "args": [str(script)],
            "env": {"PEER_NAME": "notes-server"},
        })
        self.assertEqual(response.status_code, 201, response.text)
        connector = response.json()["connector"]
        self.assertEqual((connector["name"], connector["description"], connector["tool_count"]),
                         ("Notes", "Read local notes.", 1))
        self.assertEqual(connector["env"], {"PEER_NAME": True})
        self.assertEqual(connector["auth"]["status"], "not_required")



    async def test_oauth_callback_returns_only_connector_and_result_to_app(self):
        for fail in (False, True):
            started = await self.client.post("/connectors/remote/oauth/start",
                                             json={"return_url": "wandrun://oauth/done"})
            self.assertEqual(started.status_code, 200, started.text)
            redirect = await self.browser.get(started.json()["authorization_url"])
            callback_url = redirect.headers["location"]
            self.peer.force_unavailable = fail
            result = await self.client.get("/oauth/callback?" + urlsplit(callback_url).query,
                                           headers={"Authorization": ""})
            self.assertEqual(result.status_code, 303, result.text)
            self.assertEqual(result.headers["location"],
                             "wandrun://oauth/done?connector=remote&result=" + ("error" if fail else "ok"))
            self.assertEqual(result.headers["cache-control"], "no-store")
            for secret in ("code=", "state=", "access-", "refresh-"):
                self.assertNotIn(secret, str(result.headers) + result.text)
        bad = await self.client.post("/connectors/remote/oauth/start", json={"return_url": "https://example.com"})
        self.assertEqual(bad.status_code, 400)
        invalid = await self.client.get("/oauth/callback?state=invalid&code=private")
        self.assertNotIn("location", invalid.headers)

    async def test_public_deployment_disables_manual_callback(self):
        self.gateway.oauth.manual_callback = False
        result = await self.client.post("/connectors/remote/oauth/callback", json={"url": "http://localhost"})
        self.assertEqual((result.status_code, result.json()["error"]["code"]), (400, "manual_callback_disabled"))

    async def test_oauth_transaction_identity_matches_pending_and_never_reuses_completed_material(self):
        initial = (await self.client.get("/connectors/remote")).json()["auth"]
        self.assertIsNone(initial["transaction_id"])
        first = (await self.client.post("/connectors/remote/oauth/start")).json()
        first_id = first["transaction_id"]
        self.assertIsInstance(first_id, str)
        self.assertGreater(len(first_id), 20)
        pending = (await self.client.get("/connectors/remote")).json()["auth"]
        self.assertTrue(pending["authorizing"])
        self.assertEqual(pending["transaction_id"], first_id)
        self.assertNotEqual(first_id, parse_qs(urlsplit(first["authorization_url"]).query)["state"][0])

        cancelled = await self.client.delete("/connectors/remote/oauth/pending")
        self.assertIsNone(cancelled.json()["connector"]["auth"]["transaction_id"])
        second = (await self.client.post("/connectors/remote/oauth/start")).json()
        self.assertNotEqual(second["transaction_id"], first_id)
        self.assertEqual((await self.client.get("/connectors/remote")).json()["auth"]["transaction_id"],
                         second["transaction_id"])
        redirect = await self.browser.get(second["authorization_url"])
        completed = await self.client.post("/connectors/remote/oauth/callback",
                                           json={"url": redirect.headers["location"]})
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertIsNone(completed.json()["connector"]["auth"]["transaction_id"])

        cold = ConnectorOAuth(GatewayOAuthRecords(self.store, self.gateway._persist), port=8765)
        self.addAsyncCleanup(cold.aclose)
        restarted = await cold.start("remote", self.peer.resource)
        self.assertNotIn(restarted["transaction_id"], (first_id, second["transaction_id"]))
        self.assertEqual(cold.status("remote", "oauth")["transaction_id"], restarted["transaction_id"])
        cold.cancel("remote")
        self.assertIsNone(cold.status("remote", "oauth")["transaction_id"])

    async def authorize(self, *, public=False):
        response = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(response.status_code, 200, response.text)
        started = response.json()
        self.assertEqual(started["manual_callback"], True)
        self.assertGreater(started["expires_at"], time.time())
        query = parse_qs(urlsplit(started["authorization_url"]).query)
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertEqual(query["resource"], [self.peer.resource])
        self.assertEqual(query["scope"], ["read"])
        redirect = await self.browser.get(started["authorization_url"])
        self.assertEqual(redirect.status_code, 302, redirect.text)
        url = redirect.headers["location"]
        if public:
            result = await self.client.get("/oauth/callback?" + urlsplit(url).query,
                                           headers={"Authorization": ""})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.headers["cache-control"], "no-store")
            self.assertNotIn("code-", result.text)
            return url
        result = await self.client.post("/connectors/remote/oauth/callback", json={"url": url})
        self.assertEqual(result.status_code, 200, result.text)
        return url

    async def test_catalog_binding_and_explicit_custom_authorization(self):
        apps = (await self.client.get("/apps")).json()["apps"]
        self.assertIsNone(next(app for app in apps if app["id"] == "notion")["connector"])
        first = await self.client.post("/apps/notion/connect", json={"client_id": "install"})
        second = await self.client.post("/apps/notion/connect", json={"client_id": "again"})
        self.assertEqual(first.json()["connector"]["id"], second.json()["connector"]["id"])
        self.assertEqual(first.json()["connector"]["auth"], {
            "status": "unauthorized", "authorizing": False, "transaction_id": None, "scopes": [],
        })
        identity = first.json()["connector"]["id"]
        self.assertEqual((await self.client.patch(f"/connectors/{identity}", json={
            "url": self.peer.resource,
        })).status_code, 400)
        self.assertEqual((await self.client.post("/apps/missing/connect", json={
            "client_id": "unknown",
        })).status_code, 404)
        self.assertEqual((await self.client.post("/apps/notion/connect", json={
            "client_id": "install",
        })).json()["connector"]["id"], identity)
        self.assertEqual(self.runtime.mcp.status("remote", connection_fields(
            self.store.connector_definitions()["remote"]))["status"], "disconnected")
        self.assertEqual((await self.client.get("/connectors/remote")).json()["auth"]["status"], "unauthorized")
        self.assertEqual([kind for kind, _ in self.peer.requests if kind == "register"], [])

    async def test_app_bindings_are_independent_and_command_ids_cannot_cross_apps(self):
        notion = await self.client.post("/apps/notion/connect", json={"client_id": "notion-binding"})
        github = await self.client.post("/apps/github/connect", json={"client_id": "github-binding"})
        self.assertEqual(github.status_code, 200, github.text)
        github_id = github.json()["connector"]["id"]
        self.assertNotEqual(github_id, notion.json()["connector"]["id"])
        replay = await self.client.post("/apps/github/connect", json={"client_id": "github-again"})
        self.assertEqual(replay.json()["connector"]["id"], github_id)
        conflict = await self.client.post("/apps/github/connect", json={"client_id": "notion-binding"})
        self.assertEqual(conflict.status_code, 409)
        changed = await self.client.patch(f"/connectors/{github_id}", json={"auth_type": "none"})
        self.assertEqual(changed.status_code, 400)
        removed = await self.client.delete(f"/connectors/{github_id}")
        self.assertEqual(removed.status_code, 200, removed.text)
        apps = {app["id"]: app["connector"] for app in (await self.client.get("/apps")).json()["apps"]}
        self.assertIsNone(apps["github"])
        self.assertEqual(apps["notion"]["id"], notion.json()["connector"]["id"])

    async def test_existing_app_binding_replay_never_resurrects_deleted_connector(self):
        original = await self.client.post("/apps/notion/connect", json={"client_id": "first"})
        identity = original.json()["connector"]["id"]
        acquired = await self.client.post("/apps/notion/connect", json={"client_id": "second"})
        self.assertEqual(acquired.json()["connector"]["id"], identity)
        removed = await self.client.delete(f"/connectors/{identity}")
        self.assertEqual(removed.status_code, 200, removed.text)
        replay = await self.client.post("/apps/notion/connect", json={"client_id": "second"})
        self.assertEqual(replay.json(), acquired.json())
        self.assertIsNone((await self.client.get("/apps")).json()["apps"][0]["connector"])
        self.gateway._stopping["inflight"] = object()
        conflict = await self.client.post("/apps/notion/connect", json={"client_id": "inflight"})
        self.assertEqual(conflict.status_code, 409)
        self.gateway._stopping.pop("inflight")
        fresh = await self.client.post("/apps/notion/connect", json={"client_id": "third"})
        self.assertNotEqual(fresh.json()["connector"]["id"], identity)

    async def test_parent_resource_and_resource_scoped_permissions(self):
        self.peer.challenge_scope = False
        self.peer.prm_scope = False
        self.peer.extra_scope = True
        endpoint = self.peer.resource + "/team"
        created = await self.client.post("/connectors", json={
            "client_id": "parent", "name": "Parent resource", "description": "Controlled fixture",
            "url": endpoint, "transport": "streamable-http", "auth_type": "oauth",
        })
        self.assertEqual(created.status_code, 201, created.text)
        identity = created.json()["connector"]["id"]
        started = await self.client.post(f"/connectors/{identity}/oauth/start")
        self.assertEqual(started.status_code, 200, started.text)
        link = started.json()["authorization_url"]
        query = parse_qs(urlsplit(link).query)
        self.assertNotIn("scope", query)
        self.assertEqual(query["resource"], [self.peer.resource])
        registration = next(data for kind, data in self.peer.requests if kind == "register")
        self.assertNotIn("scope", registration)
        redirect = await self.browser.get(link)
        callback = await self.client.post(f"/connectors/{identity}/oauth/callback", json={
            "url": redirect.headers["location"],
        })
        self.assertEqual(callback.status_code, 200, callback.text)
        generation, record = self.store.oauth_record(identity)
        self.assertEqual(record["resource"], self.peer.resource)
        self.assertEqual(record["url"], endpoint)
        with self.assertRaises(OAuthUnavailable):
            await self.gateway.oauth.token(identity, generation, self.peer.resource)
        tools = await self.runtime.mcp.open(identity, connection_fields(
            self.store.connector_definitions()[identity]))
        self.assertIn("controlled note", str(await tools[0].ainvoke({})))

    async def test_live_sse_get_finishes_authorization_without_waiting_for_eof(self):
        self.peer.stream_get = True
        await asyncio.wait_for(self.authorize(), 15)
        self.assertTrue(self.peer.get_stream_started.is_set())
        self.assertEqual((await self.client.get("/connectors/remote")).json()["tool_count"], 2)

    async def test_static_tool_cannot_reconnect_after_switch_to_oauth(self):
        await self.authorize()
        _, record = self.store.oauth_record("remote")
        created = await self.client.post("/connectors", json={
            "client_id": "static", "name": "Static", "description": "Controlled fixture",
            "url": self.peer.resource, "headers": {
                "Authorization": "Bearer " + record["tokens"]["access_token"],
            },
        })
        self.assertEqual(created.status_code, 201, created.text)
        identity = created.json()["connector"]["id"]
        old = (await self.runtime.mcp.open(identity, connection_fields(
            self.store.connector_definitions()[identity])))[0]
        self.assertIn("controlled note", str(await old.ainvoke({})))
        switched = await self.client.patch(f"/connectors/{identity}", json={"auth_type": "oauth"})
        self.assertEqual(switched.status_code, 200, switched.text)
        before = len([item for item in self.peer.requests if item == ("mcp", "tools/call")])
        self.assertIn("旧工具已失效", str(await old.ainvoke({})))
        self.assertEqual(len([item for item in self.peer.requests if item == ("mcp", "tools/call")]), before)

    async def test_oauth_tool_recovers_closed_session_without_crossing_generation(self):
        await self.authorize()
        generation = self.gateway.oauth.generation("remote")
        connection = connection_fields(self.store.connector_definitions()["remote"])
        tool = (await self.runtime.mcp.open("remote", connection))[0]
        prior = self.runtime.mcp._services["remote"]
        calls = sum(item == ("mcp", "tools/call") for item in self.peer.requests)
        with patch.object(prior.raw_tools[tool.name], "coroutine", side_effect=ConnectionError("closed")):
            failed = await tool.ainvoke({
                "type": "tool_call", "id": "failed", "name": tool.name, "args": {},
            })
        self.assertEqual(failed.status, "error")
        self.assertEqual(sum(item == ("mcp", "tools/call") for item in self.peer.requests), calls)
        with patch.object(prior.client, "ping", side_effect=ConnectionError("closed")):
            recovered = await tool.ainvoke({})
        self.assertIn("controlled note", str(recovered))
        self.assertIsNot(self.runtime.mcp._services["remote"], prior)
        self.assertEqual(self.runtime.mcp._services["remote"].generation, generation)
        self.assertEqual(sum(item == ("mcp", "tools/call") for item in self.peer.requests), calls + 1)
        await self.client.delete("/connectors/remote/oauth")
        denied = await tool.ainvoke({
            "type": "tool_call", "id": "revoked", "name": tool.name, "args": {},
        })
        self.assertEqual(denied.status, "error")
        self.assertEqual(sum(item == ("mcp", "tools/call") for item in self.peer.requests), calls + 1)

    async def test_server_401_refreshes_once_without_replaying_tool_call(self):
        await self.authorize()
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        generation, old = self.store.oauth_record("remote")
        self.peer.access.remove(old["tokens"]["access_token"])
        first = await tool.ainvoke({"type": "tool_call", "id": "first", "name": tool.name, "args": {}})
        self.assertEqual(first.status, "error")
        self.assertEqual(self.peer.denied_calls, 1)
        refreshes = [data for kind, data in self.peer.requests
                     if kind == "token" and data.get("grant_type") == "refresh_token"]
        self.assertEqual(len(refreshes), 1)
        current_generation, current = self.store.oauth_record("remote")
        self.assertEqual(current_generation, generation)
        self.assertNotEqual(current["tokens"]["access_token"], old["tokens"]["access_token"])
        self.assertEqual(self.gateway.oauth.status("remote", "oauth")["status"], "authorized")
        self.assertFalse(self.gateway.oauth._cleanup_tasks)
        second = await tool.ainvoke({"type": "tool_call", "id": "second", "name": tool.name, "args": {}})
        self.assertEqual(second.status, "success")
        self.assertIn("controlled note", str(second.content))
        self.assertEqual(self.peer.denied_calls, 1)
        self.assertEqual(len([data for kind, data in self.peer.requests
                              if kind == "token" and data.get("grant_type") == "refresh_token"]), 1)

    async def test_expired_token_temporary_failure_keeps_captured_tool_usable(self):
        await self.authorize()
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        self.peer.force_unavailable = True
        calls_before = sum(item == ("mcp", "tools/call") for item in self.peer.requests)
        failed = await tool.ainvoke({"type": "tool_call", "id": "failed", "name": tool.name, "args": {}})
        self.assertEqual(failed.status, "error")
        self.assertEqual(sum(item == ("mcp", "tools/call") for item in self.peer.requests), calls_before)
        self.assertEqual(self.runtime.mcp.status("remote", connection_fields(
            self.store.connector_definitions()["remote"]))["status"], "connected")
        self.peer.force_unavailable = False
        recovered = await tool.ainvoke({"type": "tool_call", "id": "recovered", "name": tool.name, "args": {}})
        self.assertEqual(recovered.status, "success")
        self.assertIn("controlled note", str(recovered.content))

    async def test_http_probe_auth_failure_keeps_captured_tool_usable(self):
        await self.authorize()
        connection = connection_fields(self.store.connector_definitions()["remote"])
        tool = (await self.runtime.mcp.open("remote", connection))[0]
        for phase in ("expired_refresh_unavailable", "server_rejected_access"):
            with self.subTest(phase=phase):
                generation, record = self.store.oauth_record("remote")
                if phase == "expired_refresh_unavailable":
                    self.store.save_oauth(
                        "remote", generation, {**record, "expires_at": time.time() - 1},
                    )
                    self.peer.force_unavailable = True
                else:
                    self.peer.access.remove(record["tokens"]["access_token"])
                response = await self.client.post("/connectors/remote/test")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertFalse(response.json()["success"])
                self.assertIsNotNone(response.json()["error"])
                self.assertEqual(self.runtime.mcp.status("remote", connection)["status"], "connected")
                self.peer.force_unavailable = False
                recovered = await tool.ainvoke({
                    "type": "tool_call", "id": phase, "name": tool.name, "args": {},
                })
                self.assertEqual(recovered.status, "success")
                self.assertIn("controlled note", str(recovered.content))

    async def test_expired_token_invalid_grant_requires_reauthorization_without_call(self):
        await self.authorize()
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        self.peer.force_invalid_grant = True
        calls_before = sum(item == ("mcp", "tools/call") for item in self.peer.requests)
        failed = await tool.ainvoke({"type": "tool_call", "id": "invalid", "name": tool.name, "args": {}})
        self.assertEqual(failed.status, "error")
        self.assertEqual(sum(item == ("mcp", "tools/call") for item in self.peer.requests), calls_before)
        self.assertEqual(self.gateway.oauth.status("remote", "oauth")["status"], "reauthorization_required")
        self.assertIsNone(self.store.oauth_record("remote")[1].get("tokens"))

    async def test_close_drains_inflight_refresh_and_refuses_new_token_calls(self):
        await self.authorize()
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        self.peer.refresh_release = asyncio.Event()
        self.peer.refresh_started.clear()
        refreshing = asyncio.create_task(self.gateway.oauth.token("remote", generation, self.peer.resource))
        await asyncio.wait_for(self.peer.refresh_started.wait(), 5)
        closing = asyncio.create_task(self.gateway.oauth.aclose())
        await asyncio.sleep(0)
        self.assertFalse(closing.done())
        with self.assertRaises(OAuthIssue):
            await self.gateway.oauth.token("remote", generation, self.peer.resource)
        self.peer.refresh_release.set()
        self.assertTrue((await asyncio.wait_for(refreshing, 5)).startswith("access-"))
        await asyncio.wait_for(closing, 5)

    async def test_cancelled_tool_waiter_does_not_abandon_rotated_refresh(self):
        await self.authorize()
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        for phase in ("recover_tool", "drain_owner"):
            generation, record = self.store.oauth_record("remote")
            self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
            self.peer.refresh_rotated.clear()
            self.peer.refresh_response_release = asyncio.Event()
            waiting = asyncio.create_task(tool.ainvoke({
                "type": "tool_call", "id": phase, "name": tool.name, "args": {},
            }))
            try:
                await asyncio.wait_for(self.peer.refresh_rotated.wait(), 5)
                self.assertNotIn(record["tokens"]["refresh_token"], self.peer.refresh)
                waiting.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await waiting
                self.assertIn(("remote", generation), self.gateway.oauth._refresh_tasks)
                if phase == "drain_owner":
                    closing = asyncio.create_task(self.gateway.oauth.aclose())
                    await asyncio.sleep(0)
                    self.assertFalse(closing.done())
                self.peer.refresh_response_release.set()
                if phase == "recover_tool":
                    await asyncio.wait_for(self.gateway.oauth._refresh_tasks[("remote", generation)], 5)
                else:
                    await asyncio.wait_for(closing, 5)
                _, updated = self.store.oauth_record("remote")
                self.assertNotEqual(updated["tokens"]["refresh_token"], record["tokens"]["refresh_token"])
                self.assertNotEqual(updated["tokens"]["access_token"], record["tokens"]["access_token"])
                if phase == "recover_tool":
                    recovered = await tool.ainvoke({
                        "type": "tool_call", "id": "same-tool", "name": tool.name, "args": {},
                    })
                    self.assertEqual(recovered.status, "success")
                    self.assertIn("controlled note", str(recovered.content))
            finally:
                self.peer.refresh_response_release.set()

    async def test_concurrent_tool_waits_for_rejected_access_refresh_before_cached_token(self):
        await self.authorize()
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        generation, record = self.store.oauth_record("remote")
        self.peer.access.remove(record["tokens"]["access_token"])
        self.peer.refresh_rotated.clear()
        self.peer.refresh_response_release = asyncio.Event()
        first = asyncio.create_task(tool.ainvoke({
            "type": "tool_call", "id": "rejected", "name": tool.name, "args": {},
        }))
        pending = [first]
        try:
            await asyncio.wait_for(self.peer.refresh_rotated.wait(), 5)
            second = asyncio.create_task(tool.ainvoke({
                "type": "tool_call", "id": "concurrent", "name": tool.name, "args": {},
            }))
            joined = asyncio.create_task(self.gateway.oauth.token("remote", generation, self.peer.resource))
            pending.extend((second, joined))
            await asyncio.sleep(0)
            self.assertFalse(joined.done(), "a known-rejected token must wait for its owned refresh")
        finally:
            self.peer.refresh_response_release.set()
            results = await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), 5)
        self.assertEqual(results[0].status, "error")
        self.assertEqual(results[1].status, "success")
        self.assertIn("controlled note", str(results[1].content))
        self.assertNotEqual(results[2], record["tokens"]["access_token"])
        self.assertEqual(self.peer.denied_calls, 1)
        self.assertEqual(len([
            data for kind, data in self.peer.requests
            if kind == "token" and data.get("grant_type") == "refresh_token"
        ]), 1)

    async def test_server_401_invalid_grant_requires_new_authorization(self):
        await self.authorize()
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        _, record = self.store.oauth_record("remote")
        self.peer.access.remove(record["tokens"]["access_token"])
        self.peer.force_invalid_grant = True
        failed = await tool.ainvoke({"type": "tool_call", "id": "rejected", "name": tool.name, "args": {}})
        self.assertEqual(failed.status, "error")
        self.assertEqual(self.peer.denied_calls, 1)
        self.assertEqual(self.gateway.oauth.status("remote", "oauth")["status"], "reauthorization_required")
        self.assertIsNone(self.store.oauth_record("remote")[1].get("tokens"))

    async def test_oauth_secrets_do_not_remove_unrelated_log_tracebacks(self):
        await self.authorize()
        try:
            raise RuntimeError("unrelated diagnostics")
        except RuntimeError:
            record = logging.getLogger("unrelated").makeRecord(
                "unrelated", logging.ERROR, __file__, 1, "failure", (), sys.exc_info(),
            )
        self.assertIsNotNone(record.exc_info)

    async def test_manual_and_public_callback_discover_tools_and_revoke_old_tool(self):
        manual_url = await self.authorize()
        detail = (await self.client.get("/connectors/remote")).json()
        self.assertEqual(detail["auth"]["status"], "authorized")
        self.assertEqual(detail["auth"]["scopes"], ["read"])
        self.assertEqual(detail["tool_count"], 2)
        tools = await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"]))
        tool, echo = tools
        self.assertIn("controlled note", str(await tool.ainvoke({})))
        _, issued = self.store.oauth_record("remote")
        echoed = str(await echo.ainvoke({}))
        self.assertNotIn(issued["tokens"]["access_token"], echoed)
        self.assertIn("[redacted]", echoed)
        self.assertEqual((await self.client.post("/connectors/remote/oauth/callback", json={
            "url": manual_url,
        })).status_code, 400)
        _, record = self.store.oauth_record("remote")
        for forbidden in (record["tokens"]["access_token"], record["tokens"]["refresh_token"],
                          parse_qs(urlsplit(manual_url).query)["code"][0], manual_url):
            self.assertNotIn(forbidden, json.dumps(detail))
            self.assertNotIn(forbidden, json.dumps([event.to_dict() for event in self.store.after(0)]))
        revoked = await self.client.delete("/connectors/remote/oauth")
        self.assertEqual(revoked.status_code, 200, revoked.text)
        self.assertTrue(revoked.json()["remote_revoked"])
        self.assertEqual(revoked.json()["connector"]["auth"]["status"], "unauthorized")
        calls_before = sum(item == ("mcp", "tools/call") for item in self.peer.requests)
        rejected = await tool.ainvoke({"type": "tool_call", "id": "retired", "name": tool.name, "args": {}})
        self.assertEqual(rejected.status, "error")
        self.assertEqual(sum(item == ("mcp", "tools/call") for item in self.peer.requests), calls_before)
        self.assertEqual(self.peer.revocations, ["access_token", "refresh_token"])
        await self.authorize(public=True)
        self.assertEqual((await self.client.get("/connectors/remote")).json()["auth"]["status"], "authorized")

    async def test_second_metadata_cannot_downgrade_browser_authorization_url(self):
        self.peer.unsafe_second_metadata = True
        response = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["error"]["code"], "unsupported_oauth")
        self.assertNotIn("authorization_url", response.text)

    async def test_protocol_unsupported_and_temporary_failures_are_distinct(self):
        self.peer.support_dcr = False
        unsupported = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(unsupported.json()["error"]["code"], "unsupported_oauth")
        self.peer.support_dcr = True
        self.peer.support_s256 = False
        unsupported = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(unsupported.json()["error"]["code"], "unsupported_oauth")
        self.peer.support_s256 = True
        self.peer.metadata_unavailable = True
        unavailable = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(unavailable.json()["error"]["code"], "oauth_unavailable")
        self.peer.metadata_unavailable = False
        self.peer.registration_unavailable = True
        unavailable = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(unavailable.json()["error"]["code"], "oauth_unavailable")
        self.peer.registration_unavailable = False
        await self.authorize()

    async def test_denial_publishes_state_and_unicode_state_is_safe(self):
        started = (await self.client.post("/connectors/remote/oauth/start")).json()
        location = (await self.browser.get(started["authorization_url"])).headers["location"]
        parts = urlsplit(location)
        denied = urlunsplit(parts._replace(query=urlencode({
            "state": parse_qs(parts.query)["state"][0],
            "iss": self.peer.origin, "error": "access_denied",
        })))
        invalid = urlunsplit(parts._replace(query=urlencode({"state": "中文", "code": "x"})))
        manual = await self.client.post("/connectors/remote/oauth/callback", json={"url": invalid})
        self.assertEqual(manual.status_code, 400)
        self.assertEqual(manual.json()["error"]["code"], "invalid_callback")
        public = await self.client.get("/oauth/callback?" + urlsplit(invalid).query,
                                       headers={"Authorization": ""})
        self.assertEqual(public.status_code, 400)
        self.assertEqual(public.headers["cache-control"], "no-store")
        before = self.store.last_seq()
        refused = await self.client.post("/connectors/remote/oauth/callback", json={"url": denied})
        self.assertEqual(refused.json()["error"]["code"], "oauth_denied")
        events = [event for event in self.store.after(before)
                  if event.data.get("kind") == "connector" and event.data.get("op") == "status"]
        self.assertEqual(len(events), 1)
        self.assertFalse((await self.client.get("/connectors/remote")).json()["auth"]["authorizing"])

    async def test_start_waits_for_url_cutover_and_binds_token_to_new_endpoint(self):
        await self.authorize()
        entered, release = asyncio.Event(), asyncio.Event()
        original_close = self.runtime.mcp.close_service
        async def delayed_close(identity):
            entered.set()
            await release.wait()
            await original_close(identity)
        with patch.object(self.runtime.mcp, "close_service", side_effect=delayed_close):
            updating = asyncio.create_task(self.client.patch("/connectors/remote", json={
                "url": self.peer.resource + "/team",
            }))
            await asyncio.wait_for(entered.wait(), 5)
            starting = asyncio.create_task(self.client.post("/connectors/remote/oauth/start"))
            release.set()
            self.assertEqual((await updating).status_code, 200)
            started = await starting
        self.assertEqual(started.status_code, 200, started.text)
        redirect = await self.browser.get(started.json()["authorization_url"])
        completed = await self.client.post("/connectors/remote/oauth/callback", json={
            "url": redirect.headers["location"],
        })
        self.assertEqual(completed.status_code, 200, completed.text)
        generation, record = self.store.oauth_record("remote")
        self.assertEqual(record["url"], self.peer.resource + "/team")
        with self.assertRaises(OAuthUnavailable):
            await self.gateway.oauth.token("remote", generation, self.peer.resource)
        self.assertEqual(completed.json()["connector"]["tool_count"], 2)

    async def test_cancelling_reregistration_keeps_active_authorization(self):
        await self.authorize()
        generation, active = self.store.oauth_record("remote")
        self.peer.extra_scope = True
        started = await self.client.post("/connectors/remote/oauth/start")
        self.assertEqual(started.status_code, 200, started.text)
        current_generation, staged = self.store.oauth_record("remote")
        self.assertEqual(generation, current_generation)
        self.assertEqual(staged["tokens"], active["tokens"])
        self.assertEqual(staged["client"], active["client"])
        self.assertNotEqual(staged["pending_registration"]["client"]["client_id"],
                            active["client"]["client_id"])
        cancelled = await self.client.delete("/connectors/remote/oauth/pending")
        self.assertEqual(cancelled.json()["connector"]["auth"]["status"], "authorized")
        self.assertEqual(self.store.oauth_record("remote")[1]["tokens"], active["tokens"])
        tool = (await self.runtime.mcp.open("remote", connection_fields(
            self.store.connector_definitions()["remote"])))[0]
        self.assertIn("controlled note", str(await tool.ainvoke({})))

    async def test_state_issuer_cancel_and_second_start_are_one_time(self):
        started = (await self.client.post("/connectors/remote/oauth/start")).json()
        redirect = await self.browser.get(started["authorization_url"])
        url = redirect.headers["location"]
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        invalid = urlunsplit(parts._replace(query=urlencode({**{k: v[0] for k, v in query.items()},
                                                             "state": "wrong"})))
        self.assertEqual((await self.client.post("/connectors/remote/oauth/callback", json={
            "url": invalid,
        })).status_code, 400)
        missing_issuer = urlunsplit(parts._replace(query=urlencode({
            "code": query["code"][0], "state": query["state"][0],
        })))
        self.assertEqual((await self.client.post("/connectors/remote/oauth/callback", json={
            "url": missing_issuer,
        })).status_code, 400)
        wrong_issuer = urlunsplit(parts._replace(query=urlencode({
            **{key: value[0] for key, value in query.items()}, "iss": self.peer.origin + "/wrong",
        })))
        self.assertEqual((await self.client.post("/connectors/remote/oauth/callback", json={
            "url": wrong_issuer,
        })).status_code, 400)
        replacement = (await self.client.post("/connectors/remote/oauth/start")).json()
        self.assertNotEqual(started["authorization_url"], replacement["authorization_url"])
        self.assertEqual((await self.client.post("/connectors/remote/oauth/callback", json={
            "url": url,
        })).status_code, 400)
        cancelled = await self.client.delete("/connectors/remote/oauth/pending")
        self.assertEqual(cancelled.json()["connector"]["auth"]["authorizing"], False)
        self.assertEqual((await self.client.post("/connectors/remote/oauth/callback", json={
            "url": url,
        })).status_code, 400)

    async def test_refresh_rotation_cold_load_and_revocation_race(self):
        await self.authorize()
        previous_generation, previous = self.store.oauth_record("remote")
        stale = {**previous, "expires_at": time.time() - 1}
        self.assertTrue(self.store.save_oauth("remote", previous_generation, stale))
        cold = ConnectorOAuth(GatewayOAuthRecords(self.store, self.gateway._persist), port=8765)
        async with MCPConnectionPool(oauth=cold) as pool:
            pool.oauth_connectors.add("remote")
            opened = await pool.open("remote", {"url": self.peer.resource, "transport": "streamable-http"})
            self.assertEqual(len(opened), 2)
            await asyncio.gather(*(cold.token("remote", previous_generation, self.peer.resource) for _ in range(3)))
            refreshes = [data for kind, data in self.peer.requests if kind == "token"
                         and data["grant_type"] == "refresh_token"]
            self.assertEqual(len(refreshes), 1)
            self.assertEqual(refreshes[0]["resource"], self.peer.resource)
            self.assertNotEqual(self.store.oauth_record("remote")[1]["tokens"]["refresh_token"],
                                previous["tokens"]["refresh_token"])
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        self.peer.refresh_release = asyncio.Event()
        self.peer.refresh_started.clear()
        late = asyncio.create_task(cold.token("remote", generation, self.peer.resource))
        await asyncio.wait_for(self.peer.refresh_started.wait(), 5)
        await self.client.delete("/connectors/remote/oauth")
        self.peer.refresh_release.set()
        with self.assertRaises(OAuthUnavailable):
            await late
        self.assertIsNone(self.store.oauth_record("remote")[1])

    async def test_restart_loads_absolute_expiry_and_refreshes_with_resource(self):
        await self.authorize()
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        await self.stack.aclose()
        self.store.close()
        restarted_store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        self.addCleanup(restarted_store.close)
        restarted_gateway = Gateway(restarted_store)
        restarted = AsyncExitStack()
        self.addAsyncCleanup(restarted.aclose)
        runtime = await restarted.enter_async_context(open_runtime(
            self.workspace, metrics=RunMetrics(self.workspace.runs_dir),
            agent_catalog=restarted_store.agent_catalog(),
            mcp_servers={"remote": {"url": self.peer.resource, "transport": "streamable-http"}},
            mcp_descriptions={"remote": "Read controlled notes"},
            mcp_oauth=restarted_gateway.oauth, oauth_connectors={"remote"},
            on_human=restarted_gateway.on_human, on_task=restarted_gateway.on_task,
            notify_human_of_roots=False,
        ))
        restarted_gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
        self.assertEqual(runtime.mcp.status("remote", {"url": self.peer.resource,
                                                       "transport": "streamable-http"})["tool_count"], 2)
        refreshed = restarted_store.oauth_record("remote")[1]
        self.assertNotEqual(refreshed["tokens"]["refresh_token"], record["tokens"]["refresh_token"])
        self.assertTrue(any(kind == "token" and data.get("grant_type") == "refresh_token"
                            and data.get("resource") == self.peer.resource
                            for kind, data in self.peer.requests))

    async def test_invalid_grant_marks_reauthorization_required(self):
        await self.authorize()
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        self.peer.force_invalid_grant = True
        with self.assertRaises(OAuthUnavailable):
            await self.gateway.oauth.token("remote", generation, self.peer.resource)
        self.assertEqual(self.gateway.oauth.status("remote", "oauth")["status"], "reauthorization_required")
        self.assertIsNone(self.store.oauth_record("remote")[1].get("tokens"))

    async def test_refresh_rotation_save_failure_fails_closed(self):
        await self.authorize()
        generation, record = self.store.oauth_record("remote")
        self.store.save_oauth("remote", generation, {**record, "expires_at": time.time() - 1})
        with patch.object(self.store, "save_oauth", side_effect=OSError("disk full")):
            with self.assertRaises(GatewayFailure):
                await self.gateway.oauth.token("remote", generation, self.peer.resource)
        current_generation, current = self.store.oauth_record("remote")
        self.assertGreater(current_generation, generation)
        self.assertEqual(current["status"], "reauthorization_required")
        self.assertNotIn("tokens", current)
        self.assertIsNotNone(self.gateway.failure)
