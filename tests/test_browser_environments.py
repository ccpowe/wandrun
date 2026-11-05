"""Browser ownership across environment aliases, Agent cutovers and persisted definitions."""

import asyncio
import json
import shutil
import tempfile
import unittest
from dataclasses import replace
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx
from websockets.asyncio.client import connect

from wandrun.config import AgentCatalog, AgentDefinition, BrowserDefinition, EnvironmentDefinition, default_instabox_browser
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.session import AgentEnvironmentBusy, open_runtime
from wandrun.runtime.execution.workspace import Workspace

from test_runtime import answer


async def respond(model, body):
    yield answer("done")


class BrowserEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    def workspace(self, root, url=None):
        workspace = Workspace(root)
        workspace.runtime_dir.mkdir()
        browser = f'[environments.local.browser]\ncdp_url = "{url}"\nmax_pages = 1\n' if url else ''
        alias = f'[environments.alias.browser]\ncdp_url = "{url}"\nmax_pages = 1\n' if url else ''
        workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n' + browser
            + '[environments.alias]\ntype = "local"\n' + alias
            + '[environments.without_browser]\ntype = "local"\n'
            + '[environments.cloud]\ntype = "instabox"\n'
            + f'machine_id = "m_{"a" * 26}"\nworkdir = "/data/home/wandrun"\n'
            + '[environments.cloud.browser]\ncdp_port = 9222\nprofile_dir = "/tmp/wandrun-chrome"\n',
            encoding="utf-8",
        )
        workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
        return workspace

    async def connect_task(self, browser, task):
        environment = await browser.command_environment(task)
        async with httpx.AsyncClient() as client:
            endpoint = (await client.get(environment["WANDRUN_BROWSER_CDP"] + "/json/version")).json()["webSocketDebuggerUrl"]
        client = await connect(endpoint)
        self.addAsyncCleanup(client.close)
        await client.send(json.dumps({"id": 1, "method": "Browser.getVersion"}))
        async with asyncio.timeout(5):
            while True:
                reply = json.loads(await client.recv())
                if reply.get("id") == 1:
                    return reply

    @unittest.skipUnless(shutil.which("google-chrome") and shutil.which("Xvfb"), "requires isolated Chrome")
    async def test_alias_tasks_share_budget_and_switch_preserves_old_lease_environment(self):
        with tempfile.TemporaryDirectory() as directory, ChromeDev() as chrome:
            workspace = self.workspace(Path(directory), chrome.cdp_url)
            first = AgentDefinition("First", "Work", "offline", environment="local", skills=("browser",), code_mode=False)
            second = replace(first, environment="alias")
            catalog = AgentCatalog("first", {"first": first, "second": second})
            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(workspace, metrics=RunMetrics(workspace.runs_dir), agent_catalog=catalog,
                                        on_human=lambda *_: None, notify_human_of_roots=False) as runtime:
                    for agent in ("first", "second"):
                        runtime.workers.start("register owner", agent + "-task", agent_name=agent)
                        self.assertEqual((await runtime.workers.wait(agent + "-task"))["status"], "completed")
                    browser = runtime.browsers["local"]
                    self.assertIn("result", await self.connect_task(browser, "first-task"))
                    old = browser.lease_for_task("first-task")
                    denied = await self.connect_task(runtime.browsers["alias"], "second-task")
                    self.assertIn("页面总数已达上限", denied["error"]["message"])
                    changed = AgentCatalog("first", {"first": replace(first, environment="without_browser"), "second": second})
                    with self.assertRaises(AgentEnvironmentBusy):
                        await runtime.prepare_agents(changed)
                    await browser.close(old)
                    (await runtime.prepare_agents(changed))()
                    self.assertFalse(runtime._assembly_for("first").capabilities.enabled("browser"))
                    self.assertEqual(runtime.browser_for_lease(old).detail(old)["environment_id"], "local")
                    self.assertEqual((await runtime.browser_for_lease(old).close(old))["state"], "released")
                    self.assertIn("result", await self.connect_task(runtime.browsers["alias"], "second-task"))
                    self.assertEqual(browser.capacity()["pages_used"], 1)

    async def test_instabox_browser_assembles_lazily_and_dynamic_selection_reuses_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = self.workspace(Path(directory))
            with workspace.environments_config.open("a") as config:
                config.write(
                    '[environments.cloud_alias]\ntype = "instabox"\n'
                    f'machine_id = "m_{"a" * 26}"\nworkdir = "/data/home/wandrun"\n'
                    '[environments.cloud_alias.browser]\ncdp_port = 9222\n'
                    'profile_dir = "/tmp/wandrun-chrome"\n'
                )
            shutil.copytree(
                Path(__file__).parents[1] / "src/wandrun/defaults/skills/browser",
                workspace.skills_dir / "browser",
            )
            local = AgentDefinition("Agent", "Work", "offline", environment="local", code_mode=False)
            cloud = replace(local, environment="cloud", skills=("browser",))
            with patch.object(InstaboxBackend, "_prepare", side_effect=AssertionError("must not contact sandbox")):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    agent_catalog=AgentCatalog("agent", {
                        "agent": cloud, "peer": replace(cloud, environment="cloud_alias"),
                    }), on_human=lambda *_: None,
                ) as runtime:
                    browser = runtime.browsers["cloud"]
                    self.assertIs(runtime.browsers["cloud_alias"], browser)
                    self.assertTrue(runtime._assembly_for("agent").capabilities.enabled("browser"))
                    self.assertEqual(browser.capacity()["pages_used"], 0)
                    self.assertIsNone(browser._chrome)
                    (await runtime.prepare_agents(AgentCatalog("agent", {"agent": local})))()
                    self.assertFalse(runtime._assembly_for("agent").capabilities.enabled("browser"))
                    (await runtime.prepare_agents(AgentCatalog("agent", {"agent": cloud})))()
                    self.assertTrue(runtime._assembly_for("agent").capabilities.enabled("browser"))
                    self.assertIs(runtime.browsers["cloud"], browser)
                    self.assertIsNone(browser._chrome)

    async def test_failed_candidate_owner_closes_without_ever_committing(self):
        from wandrun.runtime.browser.leases import BrowserLeases

        with tempfile.TemporaryDirectory() as directory:
            workspace = self.workspace(Path(directory))
            agent = AgentDefinition("Agent", "Work", "offline", environment="local", code_mode=False)
            catalog = AgentCatalog("agent", {"agent": agent})
            started = []
            original = BrowserLeases.start

            async def record_start(browser):
                await original(browser)
                started.append(browser)

            with patch.object(InstaboxBackend, "_prepare", side_effect=AssertionError("cloud I/O")):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    agent_catalog=catalog, on_human=lambda *_: None,
                ) as runtime:
                    selected = "instabox-m_" + "b" * 26
                    runtime.environment_definitions[selected] = EnvironmentDefinition(
                        type="instabox", machine_id="m_" + "b" * 26,
                        workdir="/data/home/wandrun", browser=default_instabox_browser(),
                    )
                    candidate = AgentCatalog("agent", {"agent": replace(agent, environment=selected)})
                    previous = runtime._assembly_for("agent")
                    with patch.object(BrowserLeases, "start", record_start), patch(
                        "wandrun.runtime.session.create_models", side_effect=RuntimeError("candidate failed"),
                    ):
                        with self.assertRaisesRegex(RuntimeError, "candidate failed"):
                            await runtime.prepare_agents(candidate)
                    self.assertNotIn(selected, runtime.browsers)
                    self.assertIs(runtime._assembly_for("agent"), previous)
                    owner, = started
                    self.assertFalse(owner._closed)
                    (await runtime.prepare_agents(AgentCatalog("agent", {
                        "agent": replace(agent, description="Edited locally"),
                    })))()
                    self.assertNotIn(selected, runtime.browsers)
                self.assertTrue(owner._closed)

    async def test_uncommitted_browser_stays_private_after_unrelated_local_commit(self):
        from wandrun.gateway.service import Gateway
        from wandrun.integrations.mcp import MCPConnectionError
        from wandrun.runtime.browser.leases import BrowserLeases

        for mode in ("mcp_failure", "cancelled", "abandoned"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                workspace = self.workspace(Path(directory))
                shutil.copytree(
                    Path(__file__).parents[1] / "src/wandrun/defaults/skills/browser",
                    workspace.skills_dir / "browser",
                )
                agent = AgentDefinition("Agent", "Work", "offline", environment="local", code_mode=False)
                catalog = AgentCatalog("agent", {"agent": agent})
                started = []
                original = BrowserLeases.start

                async def record_start(browser):
                    await original(browser)
                    started.append(browser)

                with closing(GatewayStore(workspace.state_dir / "gateway.sqlite")) as store, patch.object(
                    InstaboxBackend, "_prepare", side_effect=AssertionError("must not contact sandbox"),
                ):
                    store.import_agents(catalog)
                    gateway = Gateway(store)
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), agent_catalog=catalog,
                        mcp_servers={"docs": {"transport": "http", "url": "http://mcp.invalid/mcp"}},
                        on_human=lambda *_: None,
                    ) as runtime:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        machine = "m_" + "b" * 26
                        selected = "instabox-" + machine
                        runtime.environment_definitions[selected] = EnvironmentDefinition(
                            type="instabox", machine_id=machine, workdir="/data/home/wandrun",
                            browser=default_instabox_browser(),
                        )
                        cloud_agent = replace(agent, environment=selected, skills=("browser",), mcp_servers=("docs",))
                        candidate = AgentCatalog("agent", {"agent": cloud_agent})
                        previous = runtime._assembly_for("agent")
                        entered = asyncio.Event()

                        async def open_mcp(*_):
                            if mode == "mcp_failure":
                                raise MCPConnectionError("MCP preparation failed")
                            if mode == "cancelled":
                                entered.set()
                                await asyncio.Future()
                            return []

                        with patch.object(BrowserLeases, "start", record_start), patch.object(
                            runtime.mcp, "open", open_mcp,
                        ):
                            if mode == "mcp_failure":
                                with self.assertRaisesRegex(MCPConnectionError, "MCP preparation failed"):
                                    await runtime.prepare_agents(candidate)
                            elif mode == "cancelled":
                                pending = asyncio.create_task(runtime.prepare_agents(candidate))
                                try:
                                    async with asyncio.timeout(5):
                                        await entered.wait()
                                finally:
                                    pending.cancel()
                                    with self.assertRaises(asyncio.CancelledError):
                                        await pending
                            else:
                                await runtime.prepare_agents(candidate)  # Deliberately discard the commit.
                            owner, = started
                            self.assertIs(runtime._assembly_for("agent"), previous)
                            self.assertNotIn(selected, runtime.browsers)
                            self.assertEqual(gateway.computer()["environments"], [])
                            self.assertFalse(owner._closed)

                            (await runtime.prepare_agents(AgentCatalog("agent", {
                                "agent": replace(agent, description="Edited locally"),
                            })))()
                            self.assertFalse(runtime._assembly_for("agent").capabilities.enabled("browser"))
                            self.assertNotIn(selected, runtime.browsers)
                            self.assertEqual(gateway.computer()["environments"], [])
                            self.assertFalse(owner._closed)

                        with patch.object(runtime.mcp, "open", return_value=[]):
                            commit = await runtime.prepare_agents(candidate)
                        self.assertNotIn(selected, runtime.browsers)
                        commit()
                        self.assertIs(runtime.browsers[selected], owner)
                        self.assertTrue(runtime._assembly_for("agent").capabilities.enabled("browser"))
                        self.assertEqual(
                            [item["environment_id"] for item in gateway.computer()["environments"]],
                            ["instabox:" + machine],
                        )
                    self.assertTrue(owner._closed)

    @unittest.skipUnless(shutil.which("google-chrome") and shutil.which("Xvfb"), "requires isolated Chrome")
    async def test_startup_browser_aliases_remain_public_without_agent_references(self):
        with tempfile.TemporaryDirectory() as directory, ChromeDev() as chrome:
            workspace = self.workspace(Path(directory), chrome.cdp_url)
            agent = AgentDefinition("Agent", "Work", "offline", environment="without_browser", code_mode=False)
            with patch.object(InstaboxBackend, "_prepare", side_effect=AssertionError("must not contact sandbox")):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir),
                    agent_catalog=AgentCatalog("agent", {"agent": agent}), on_human=lambda *_: None,
                ) as runtime:
                    browser = runtime.browsers["local"]
                    self.assertIs(runtime.browsers["alias"], browser)
                    self.assertFalse(runtime._assembly_for("agent").capabilities.enabled("browser"))
                    (await runtime.prepare_agents(AgentCatalog("agent", {
                        "agent": replace(agent, description="Edited locally"),
                    })))()
                    self.assertIs(runtime.browsers["local"], browser)
                    self.assertIs(runtime.browsers["alias"], browser)

    @unittest.skipUnless(shutil.which("google-chrome") and shutil.which("Xvfb"), "requires isolated Chrome")
    async def test_prepared_browser_owner_rebuilds_capability_and_publishes_to_attached_gateway(self):
        from wandrun.gateway.service import Gateway

        with tempfile.TemporaryDirectory() as directory, ChromeDev() as chrome:
            workspace = self.workspace(Path(directory))
            agent = AgentDefinition("Agent", "Work", "offline", environment="local", skills=("browser",), code_mode=False)
            catalog = AgentCatalog("agent", {"agent": agent})
            with closing(GatewayStore(workspace.state_dir / "gateway.sqlite")) as store:
                store.import_agents(catalog)
                gateway = Gateway(store)
                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    async with open_runtime(workspace, metrics=RunMetrics(workspace.runs_dir),
                                            agent_catalog=catalog, on_human=lambda *_: None) as runtime:
                        gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                        runtime.environment_definitions["local"] = replace(
                            runtime.environment_definitions["local"],
                            browser=BrowserDefinition(chrome.cdp_url, max_pages=1),
                        )
                        (await runtime.prepare_agents(catalog))()
                        root = gateway.create_conversation("dynamic browser", "agent", client_id=uuid4().hex)[0]["id"]
                        runtime.workers.start("register new owner", root, agent_name="agent")
                        self.assertEqual((await runtime.workers.wait(root))["status"], "completed")
                        browser = runtime.browsers["local"]
                        self.assertIn("result", await self.connect_task(browser, root))
                        persisted = gateway.browser_task(browser.lease_for_task(root))
                        self.assertEqual((persisted["environment_id"], persisted["capacity"]["pages_used"]), ("local", 1))

    def test_execution_environment_browser_definition_survives_database_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gateway.sqlite"
            cloud = EnvironmentDefinition(type="instabox", machine_id="m_" + "a" * 26,
                                          workdir="/data/home/wandrun",
                                          browser=BrowserDefinition(cdp_port=9333, profile_dir="/data/chrome", max_pages=5))
            definitions = {
                "local": EnvironmentDefinition(type="local", browser=BrowserDefinition("http://127.0.0.1:9999", max_pages=4)),
                "cloud": cloud, "alias": cloud,
            }
            with closing(GatewayStore(path)) as store:
                store.save_environment_definitions(definitions)
            with closing(GatewayStore(path)) as store:
                self.assertEqual(store.environment_definitions(), definitions)
