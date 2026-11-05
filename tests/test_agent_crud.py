"""Agent 编辑与删除跨真实运行时、HTTP、检查点和调度库；模型只替换传输。"""

import asyncio
from contextlib import AsyncExitStack, closing
from dataclasses import replace
import os
import shutil
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from wandrun.config import AgentCatalog, AgentDefinition, EnvironmentDefinition
from wandrun.gateway.app import ensure_agents
from wandrun.gateway.capabilities import gateway_capabilities
from wandrun.gateway.connectors import connector_fields
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway, GatewayFailure
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.communication.scheduler_store import paired_store_path
from wandrun.runtime.communication.messages import AgentOutput, SendMessage
from wandrun.runtime.session import open_runtime
from wandrun.runtime.context.memory import MemoryReadError, MemoryRetired
from test_runtime import answer, configure
from test_gateway_models import subscription_fixture
from codex_test_home import isolate_codex_home



class AgentCrudTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        isolate_codex_home(self)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = configure(Path(self.directory.name))
        role = AgentDefinition("说明", "完成任务", "offline", environment="local", code_mode=False)
        self.catalog = AgentCatalog("main", {
            "main": replace(role, workers=("child",)),
            "child": role,
            "desktop": role,
        })
        self.store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        self.addCleanup(self.store.close)
        self.store.import_agents(self.catalog)
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.block = False
        self.requests = []
        owner = self

        async def respond(model, body):
            owner.requests.append(body)
            owner.entered.set()
            if owner.block:
                await owner.release.wait()
            yield answer("完成")

        self.transport = patch.object(CodexSubscriptionModel, "_arequest", respond)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        await self.start_runtime()

    async def start_runtime(self):
        self.stack = AsyncExitStack()
        self.addAsyncCleanup(self.stack.aclose)
        subscription, self.upstream = subscription_fixture(self, self.store)
        self.gateway = Gateway(self.store, subscription)
        self.gateway.skills_dir = self.workspace.skills_dir
        self.runtime = await self.stack.enter_async_context(open_runtime(
            self.workspace, metrics=RunMetrics(self.workspace.runs_dir),
            agent_catalog=self.store.agent_catalog(), on_human=self.gateway.on_human,
            on_task=self.gateway.on_task, notify_human_of_roots=False,
            entry_capabilities=gateway_capabilities(self.gateway),
            environment_definitions=self.store.environment_definitions(),
        ))
        self.gateway.attach(self.runtime.workers, self.runtime.checkpointer, runtime=self.runtime)
        self.client = await self.stack.enter_async_context(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "dev")),
            base_url="http://gateway", headers={"Authorization": "Bearer dev"},
        ))

    def payload(self, **extra):
        return {"client_id": "create", "name": "写作者", "description": "写作",
                "system_prompt": "写文章", "model": "offline", **extra}

    async def test_agent_name_conflicts_are_explicit_atomic_and_do_not_break_replay(self):
        created = await self.client.post("/agents", json=self.payload(name=" Test "))
        self.assertEqual(created.status_code, 201, created.text)
        first = created.json()
        identity = first["agent"]["id"]
        self.assertEqual(first["agent"]["name"], "Test")
        self.assertEqual(self.store.agent_catalog().agents[identity].name, "Test")
        seq = self.store.last_seq()
        for name in ("test", " Test ", "TEST"):
            with self.subTest(name=name):
                rejected = await self.client.post("/agents", json=self.payload(client_id="duplicate", name=name))
                self.assertEqual(rejected.status_code, 409, rejected.text)
                self.assertEqual(rejected.json(), {"error": {"code": "agent_name_conflict", "message": "已有同名 Agent"}})
                rejected = await self.client.patch("/agents/desktop", json={"name": name, "description": "不应保存"})
                self.assertEqual(rejected.status_code, 409, rejected.text)
                self.assertEqual(rejected.json()["error"]["code"], "agent_name_conflict")
        self.assertEqual(self.store.last_seq(), seq)
        self.assertEqual(self.store.agent("desktop")["description"], "说明")
        same = await self.client.patch(f"/agents/{identity}", json={"name": " Test "})
        self.assertEqual(same.status_code, 200, same.text)
        self.assertIsNone(same.json()["event"])
        renamed = await self.client.patch(f"/agents/{identity}", json={"name": " Different "})
        self.assertEqual(renamed.json()["agent"]["name"], "Different")
        self.assertEqual(self.store.agent_catalog().agents[identity].name, "Different")
        replacement = await self.client.post("/agents", json=self.payload(client_id="replacement", name="Test"))
        self.assertEqual(replacement.status_code, 201, replacement.text)
        replay = await self.client.post("/agents", json=self.payload(name="Test"))
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json(), {**first, "replayed": True})
        fresh = await self.client.post("/agents", json=self.payload(client_id="duplicate", name="Recovered"))
        self.assertEqual(fresh.status_code, 201, fresh.text)
        concurrent = await asyncio.gather(*(
            self.client.post("/agents", json=self.payload(client_id=f"race-{index}", name=name))
            for index, name in enumerate(("Race", " race "))
        ))
        self.assertEqual(sorted(response.status_code for response in concurrent), [201, 409])
        self.assertIsNone(self.gateway._failure)

    async def test_required_agent_text_rejections_do_not_persist(self):
        seq = self.store.last_seq()
        before = self.store.agent("main")
        for key, label in (("description", "说明"), ("system_prompt", "提示词")):
            with self.subTest(field=key):
                payload = self.payload(client_id=f"missing-{key}")
                del payload[key]
                missing = await self.client.post("/agents", json=payload)
                self.assertEqual(missing.status_code, 400)
                self.assertIn(label, missing.json()["error"]["message"])
                self.assertNotIn("agents.", missing.json()["error"]["message"])
                blank = await self.client.patch("/agents/main", json={key: "  "})
                self.assertEqual(blank.status_code, 400)
                self.assertIn(label, blank.json()["error"]["message"])
                self.assertNotIn("agents.", blank.json()["error"]["message"])
        self.assertEqual(self.store.agent("main"), before)
        self.assertEqual(self.store.last_seq(), seq)

    async def test_fast_mode_crud_runtime_replay_and_strict_noop(self):
        self.assertIs(self.store.agent("main")["fast_mode"], False)
        models = await self.client.get("/models")
        self.assertEqual(models.json()["capabilities"], {"fast_mode": True})
        connection = await self.client.get("/connection")
        self.assertEqual(connection.json()["capabilities"], {"fast_mode": True})
        default = await self.client.post("/agents", json=self.payload(client_id="fast-default", name="默认 Fast", code_mode=False))
        self.assertEqual(default.status_code, 201, default.text)
        self.assertIs(default.json()["agent"]["fast_mode"], False)
        payload = self.payload(client_id="fast-enabled", fast_mode=True, reasoning_effort="xhigh", code_mode=False)
        created = await self.client.post("/agents", json=payload)
        self.assertEqual(created.status_code, 201, created.text)
        first = created.json()
        identity = first["agent"]["id"]
        self.assertIs(first["agent"]["fast_mode"], True)
        self.assertTrue(self.store.agent_catalog().agents[identity].fast_mode)
        root = self.gateway.create_conversation("Fast request", identity, client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "fast-request", "完成")
        self.assertEqual((await self.runtime.workers.wait(root))["status"], "completed")
        self.assertEqual(self.requests[-1]["service_tier"], "priority")
        self.assertEqual(self.requests[-1]["reasoning"], {"effort": "xhigh"})
        detail = await self.client.get(f"/agents/{identity}")
        self.assertIs(detail.json()["fast_mode"], True)
        seq = self.store.last_seq()
        original = self.runtime._assembly_for(identity)
        same = await self.client.patch(f"/agents/{identity}", json={"fast_mode": True})
        self.assertEqual(same.status_code, 200, same.text)
        self.assertIsNone(same.json()["event"])
        self.assertIs(self.runtime._assembly_for(identity), original)
        self.assertEqual(self.store.last_seq(), seq)
        # 1 == True and 0 == False must not bypass validation via no-op equality.
        for value in (None, "true", "false", 0, 1, [], {}):
            with self.subTest(value=value):
                rejected = await self.client.patch(f"/agents/{identity}", json={"fast_mode": value})
                self.assertEqual(rejected.status_code, 400, rejected.text)
                rejected = await self.client.post(
                    "/agents", json=self.payload(client_id=f"bad-fast-{value}", fast_mode=value, code_mode=False),
                )
                self.assertEqual(rejected.status_code, 400, rejected.text)
                self.assertEqual(self.store.last_seq(), seq)
        self.upstream["status"] = 503
        disabled = await self.client.patch(f"/agents/{identity}", json={"fast_mode": False})
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertIs(disabled.json()["agent"]["fast_mode"], False)
        self.assertEqual(disabled.json()["agent"]["reasoning_effort"], "xhigh")
        self.assertEqual(disabled.json()["event"]["data"], {"kind": "agent", "id": identity, "op": "updated"})
        self.assertFalse(self.store.agent_catalog().agents[identity].fast_mode)
        replay = await self.client.post("/agents", json=payload)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(replay.json()["agent"], first["agent"])
        self.assertEqual(replay.json()["event"], first["event"])
        self.assertEqual(self.store.last_seq(), seq + 1)
        root = self.gateway.create_conversation("Standard request", identity, client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "standard-request", "完成")
        self.assertEqual((await self.runtime.workers.wait(root))["status"], "completed")
        self.assertNotIn("service_tier", self.requests[-1])
        self.assertEqual(self.requests[-1]["reasoning"], {"effort": "xhigh"})

    async def test_environment_create_idle_switch_active_conflict_and_restart_are_lazy(self):
        machine = "m_" + "a" * 26
        cloud = EnvironmentDefinition(
            type="instabox", machine_id=machine, workdir=str(self.workspace.root / "remote"),
        )
        self.runtime.environment_definitions.update({"cloud": cloud, "cloud-alias": cloud})
        with patch("wandrun.integrations.instabox.InstaboxBackend._prepare",
                   side_effect=AssertionError("configuration must not prepare a machine")):
            first = await self.client.post("/agents", json=self.payload(
                client_id="cloud-create", environment="cloud", code_mode=False,
            ))
            self.assertEqual(first.status_code, 201, first.text)
            identity = first.json()["agent"]["id"]
            second = await self.client.post("/agents", json=self.payload(
                client_id="cloud-alias-create", name="云端别名", environment="cloud-alias", code_mode=False,
            ))
            self.assertEqual(second.status_code, 201, second.text)
            alias = second.json()["agent"]["id"]
            self.assertIs(self.runtime.files.remote_backends[identity], self.runtime.files.remote_backends[alias])
            selected = await self.client.patch("/agents/desktop", json={"environment": "cloud"})
            self.assertEqual(selected.status_code, 200, selected.text)
            # The list read by the App's server page carries each Agent's environment, not only the detail.
            listing = {item["id"]: item["environment"] for item in (await self.client.get("/agents")).json()["agents"]}
            self.assertEqual((listing["desktop"], listing[identity], listing[alias]), ("cloud", "cloud", "cloud-alias"))
            self.assertIs(self.runtime.files.remote_backends["desktop"], self.runtime.files.remote_backends[identity])
            self.block = True
            root = self.gateway.create_conversation("active", "desktop", client_id=uuid4().hex)[0]["id"]
            self.gateway.send_message(root, "cloud-chat", "只聊天")
            await self.entered.wait()
            rejected = await self.client.patch("/agents/desktop", json={"environment": "local"})
            self.assertEqual(rejected.status_code, 409, rejected.text)
            self.assertEqual(self.store.agent("desktop")["environment"], "cloud")
            self.assertEqual(self.runtime.workers.get(root)["status"], "running")
            self.release.set()
            await self.runtime.workers.wait(root)
            switched = await self.client.patch("/agents/desktop", json={"environment": "local"})
            self.assertEqual(switched.status_code, 200, switched.text)
            self.assertNotIn("desktop", self.runtime.files.remote_backends)
            self.assertEqual(self.store.environment_definitions()["cloud"], cloud)
            await self.stack.aclose()
            await self.start_runtime()
            self.assertEqual(self.store.agent(identity)["environment"], "cloud")
            self.assertEqual(self.store.agent("desktop")["environment"], "local")
            self.assertIs(self.runtime.files.remote_backends[identity], self.runtime.files.remote_backends[alias])

    async def test_discovered_browser_switch_create_alias_restart_and_shutdown(self):
        from wandrun.integrations.instabox import InstaboxBackend
        from wandrun.runtime.agent.conversations import conversation_config

        machine = "m_" + "b" * 26
        selected = "instabox-" + machine
        shutil.copytree(
            Path(__file__).parents[1] / "src/wandrun/defaults/skills/browser",
            self.workspace.skills_dir / "browser",
        )
        original = httpx.AsyncClient
        provider = httpx.MockTransport(lambda request: httpx.Response(200, json={
            "machines": [{"id": machine, "name": "Discovered", "state": "suspended"}],
        }))
        with patch.dict(os.environ, {"INSTABOX_API_KEY": "test"}), patch(
            "wandrun.gateway.environments.httpx.AsyncClient",
            side_effect=lambda **kwargs: original(transport=provider, **kwargs),
        ):
            choices = await self.client.get("/execution-environments")
        self.assertEqual(choices.status_code, 200, choices.text)
        with patch.object(InstaboxBackend, "_prepare", side_effect=AssertionError("cloud I/O")):
            switched = await self.client.patch("/agents/desktop", json={
                "environment": selected, "skills": ["browser"],
            })
            self.assertEqual(switched.status_code, 200, switched.text)
            browser = self.runtime.browsers[selected]
            self.assertTrue(self.runtime._assembly_for("desktop").capabilities.enabled("browser"))
            self.assertEqual(
                [item["environment_id"] for item in self.gateway.computer()["environments"]],
                ["instabox:" + machine],
            )
            root = self.gateway.create_conversation("browser feedback", "desktop", client_id=uuid4().hex)[0]["id"]
            self.gateway.send_message(root, "browser-feedback", "只聊天")
            self.assertEqual((await self.runtime.workers.wait(root))["status"], "completed")
            checkpoint = await self.runtime.checkpointer.aget_tuple(conversation_config(root))
            feedback = checkpoint.checkpoint["channel_values"]["observed_environment"]["browser"]
            self.assertTrue(feedback["configured"])
            self.assertEqual(feedback["availability"], "未探测，实际使用时确认")
            # A configured alias and a discovered identity borrow the physical owner.
            definition = self.runtime.environment_definitions[selected]
            with self.workspace.environments_config.open("a") as config:
                config.write(
                    '\n[environments.discovered_alias]\ntype = "instabox"\n'
                    f'machine_id = "{machine}"\nworkdir = "/data/home/wandrun"\n'
                    '[environments.discovered_alias.browser]\n'
                )
            self.runtime.environment_definitions["discovered_alias"] = definition
            created = await self.client.post("/agents", json=self.payload(
                client_id="discovered-browser", environment="discovered_alias",
                skills=["browser"], code_mode=False,
            ))
            self.assertEqual(created.status_code, 201, created.text)
            self.assertIs(self.runtime.browsers["discovered_alias"], browser)
            self.assertEqual(len(self.gateway.computer()["environments"]), 1)
            await self.stack.aclose()
            self.assertTrue(browser._closed)
            await self.start_runtime()
            restored = self.runtime.browsers[selected]
            self.assertIsNot(restored, browser)
            self.assertIs(self.runtime.browsers["discovered_alias"], restored)
            self.assertTrue(self.runtime._assembly_for("desktop").capabilities.enabled("browser"))
            self.assertEqual(restored.config, definition.browser)

    async def test_background_command_blocks_environment_switch_after_model_done_until_explicit_stop(self):
        self.runtime.environment_definitions["cloud"] = EnvironmentDefinition(
            type="instabox", machine_id="m_" + "a" * 26,
            workdir=str(self.workspace.root / "remote"),
        )
        calls = 0

        async def respond(model, body):
            nonlocal calls
            calls += 1
            if calls == 1:
                yield {
                    "type": "response.completed",
                    "response": {"status": "completed", "output": [{
                        "type": "function_call", "id": "background", "call_id": "background",
                        "name": "exec_command",
                        "arguments": json.dumps({"command": "sleep 60", "yield_seconds": 0}),
                    }]},
                }
            else:
                yield answer("后台命令仍在执行")

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            root = self.gateway.create_conversation("background", "desktop", client_id=uuid4().hex)[0]["id"]
            self.gateway.send_message(root, "start-background", "启动后台命令然后结束本轮")
            self.assertEqual((await self.runtime.workers.wait(root))["status"], "completed")
            self.assertEqual(self.runtime.workers.running_tasks("desktop"), [])
            self.assertIn(root, self.runtime.agent_tasks_pending("desktop"))
            rejected = await self.client.patch("/agents/desktop", json={"environment": "cloud"})
            self.assertEqual(rejected.status_code, 409, rejected.text)
            self.assertEqual(self.store.agent("desktop")["environment"], "local")
            stopped = await self.runtime.workers.cancel(root)
            self.assertNotIn("cleanup_unconfirmed", stopped)
            async def released():
                while self.runtime.agent_tasks_pending("desktop"):
                    await asyncio.sleep(0.01)
            await asyncio.wait_for(released(), 5)
            switched = await self.client.patch("/agents/desktop", json={"environment": "cloud"})
            self.assertEqual(switched.status_code, 200, switched.text)

    async def test_code_mode_default_explicit_value_edits_and_validation(self):
        self.assertFalse(self.store.agent("main")["code_mode"])  # Imported definitions keep their saved value.
        default = await self.client.post("/agents", json=self.payload(client_id="code-default"))
        self.assertEqual(default.status_code, 201, default.text)
        identity = default.json()["agent"]["id"]
        self.assertTrue(default.json()["agent"]["code_mode"])
        self.assertTrue(self.store.agent_catalog().agents[identity].code_mode)
        disabled = await self.client.post("/agents", json=self.payload(client_id="code-disabled", name="禁用代码模式", code_mode=False))
        self.assertEqual(disabled.status_code, 201, disabled.text)
        self.assertFalse(disabled.json()["agent"]["code_mode"])
        self.assertFalse(self.store.agent_catalog().agents[disabled.json()["agent"]["id"]].code_mode)

        cursor = self.store.last_seq()
        off = await self.client.patch(f"/agents/{identity}", json={"code_mode": False})
        self.assertEqual(off.status_code, 200, off.text)
        self.assertFalse(off.json()["agent"]["code_mode"])
        self.assertEqual(off.json()["event"]["type"], "resource.changed")
        self.assertFalse(self.store.agent_catalog().agents[identity].code_mode)
        self.assertEqual(self.runtime._assembly_for(identity).capabilities.entries["code_mode"].status, "disabled")
        unchanged = await self.client.patch(f"/agents/{identity}", json={"code_mode": False})
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        self.assertIsNone(unchanged.json()["event"])
        on = await self.client.patch(f"/agents/{identity}", json={"code_mode": True})
        self.assertEqual(on.status_code, 200, on.text)
        self.assertTrue(on.json()["agent"]["code_mode"])
        self.assertTrue(self.store.agent_catalog().agents[identity].code_mode)
        self.assertEqual(self.runtime._assembly_for(identity).capabilities.entries["code_mode"].tools, ("run_code",))
        changed = [event for event in self.store.after(cursor) if event.type == "resource.changed"]
        self.assertEqual([event.data for event in changed], [
            {"kind": "agent", "id": identity, "op": "updated"},
            {"kind": "agent", "id": identity, "op": "updated"},
        ])

        seq = self.store.last_seq()
        for value in (None, "false", 0, [], {}):
            with self.subTest(value=value):
                rejected = await self.client.patch(f"/agents/{identity}", json={"code_mode": value})
                self.assertEqual(rejected.status_code, 400, rejected.text)
                self.assertNotIn("agents.", rejected.json()["error"]["message"])
                rejected_create = await self.client.post(
                    "/agents", json=self.payload(client_id=f"bad-code-{str(value)}", name="无效代码模式", code_mode=value),
                )
                self.assertEqual(rejected_create.status_code, 400, rejected_create.text)
                self.assertEqual(self.store.last_seq(), seq)
        environment = await self.client.patch(f"/agents/{identity}", json={"environment": "local"})
        self.assertEqual(environment.status_code, 200, environment.text)
        self.assertIsNone(environment.json()["event"])
        self.assertTrue(self.store.agent(identity)["code_mode"])

    async def test_first_code_pool_open_serializes_overlapping_agent_edits(self):
        from wandrun.runtime import session

        original_monty = session.pm.AsyncMonty
        pools = []
        entering, release, waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()

        class ObservedPool:
            def __init__(self):
                self.pool = original_monty()
                self.exits = 0
                pools.append(self)

            async def __aenter__(self):
                entering.set()
                await release.wait()  # Hold the first edit before entering the real pool.
                return await self.pool.__aenter__()

            async def __aexit__(self, *args):
                result = await self.pool.__aexit__(*args)
                self.exits += 1
                return result

        lock = self.gateway._catalog_lock
        acquire = lock.acquire

        async def observed_acquire():
            if lock.locked():
                waiting.set()
            return await acquire()  # Observe contention without replacing the real lock.

        requests = []

        async def respond(model, body):
            requests.append(body)
            if len(requests) == 1:
                yield {
                    "type": "response.completed",
                    "response": {"status": "completed", "output": [{
                        "type": "function_call", "id": "code", "call_id": "code", "name": "run_code",
                        "arguments": json.dumps({
                            "code": "await write('concurrent-proof.txt', 'saved both edits')\nprint(17 * 19)",
                        }),
                    }]},
                }
            else:
                yield answer("完成")

        original = self.store.agent("main")
        cursor = self.store.last_seq()
        with (patch.object(session.pm, "AsyncMonty", side_effect=ObservedPool),
              patch.object(lock, "acquire", observed_acquire),
              patch.object(CodexSubscriptionModel, "_arequest", respond)):
            edits = []
            try:
                edits.append(asyncio.create_task(self.client.patch("/agents/main", json={"code_mode": True})))
                await asyncio.wait_for(entering.wait(), 5)
                edits.append(asyncio.create_task(self.client.patch("/agents/main", json={"name": "并发改名"})))
                await asyncio.wait_for(waiting.wait(), 5)
                self.assertTrue(all(not edit.done() for edit in edits))
                self.assertEqual(self.store.agent("main"), original)
                self.assertEqual(self.store.last_seq(), cursor)
                self.assertEqual(self.runtime._assembly_for("main").capabilities.entries["code_mode"].status, "disabled")
                release.set()
                changed, renamed = await asyncio.wait_for(asyncio.gather(*edits), 10)
            finally:
                release.set()
                for edit in edits:
                    if not edit.done():
                        edit.cancel()
                await asyncio.gather(*edits, return_exceptions=True)

            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(renamed.status_code, 200, renamed.text)
            self.assertTrue(renamed.json()["agent"]["code_mode"])
            self.assertEqual(renamed.json()["agent"]["name"], "并发改名")
            saved = self.store.agent_catalog().agents["main"]
            self.assertTrue(saved.code_mode)
            self.assertEqual(saved.name, "并发改名")
            self.assertEqual(len(pools), 1)
            self.assertEqual(pools[0].exits, 0)

            root = self.gateway.create_conversation("并发编辑后的执行", "main", client_id=uuid4().hex)[0]["id"]
            self.gateway.send_message(root, "run-code", "执行脚本")
            result = await asyncio.wait_for(self.runtime.workers.wait(root), 10)
            self.assertEqual(result["status"], "completed", result)
            self.assertEqual((self.workspace.root / "concurrent-proof.txt").read_text(), "saved both edits")
            self.assertIn("run_code", {item.get("name") for item in requests[0]["tools"]})
            outputs = [item["output"] for item in requests[1]["input"]
                       if item.get("type") == "function_call_output" and item.get("call_id") == "code"]
            self.assertEqual(len(outputs), 1)
            self.assertIn("323", str(outputs[0]))
            await self.stack.aclose()
        self.assertEqual(len(pools), 1)
        self.assertEqual(pools[0].exits, 1)

    async def test_head_reads_resources_without_mutations(self):
        connector_body = {
            "client_id": "head-connector", "name": "文档",
            "url": "https://example.com/mcp", "description": "查询文档",
        }
        connector_id = "head-fixture"
        definition = connector_fields(connector_id, {key: value for key, value in connector_body.items()
                                                     if key != "client_id"})
        self.store.create_connector(definition, connector_body["client_id"])
        schedule_body = {
            "client_id": "head-schedule", "name": "晨报", "content": "独立说明",
            "rule": {"kind": "daily", "time": "00:00"}, "timezone": "Etc/UTC",
        }
        schedule = await self.client.post("/agents/desktop/schedules", json=schedule_body)
        self.assertEqual(schedule.status_code, 201, schedule.text)
        schedule_id = schedule.json()["schedule"]["id"]
        conversation_body = {"title": "保留对话", "agent_id": "desktop", "client_id": "head-new-conversation"}
        conversation = await self.client.post("/conversations", json={**conversation_body, "client_id": uuid4().hex})
        self.assertEqual(conversation.status_code, 201, conversation.text)
        conversation_id = conversation.json()["id"]
        memory = (await self.client.get("/agents/desktop/memory")).json()
        # 携带有效写入内容，确保 HEAD 被误分派时不能靠缺少 JSON 偶然挡住副作用。
        cases = [
            ("/agents", self.payload(client_id="head-new-agent")),
            ("/agents/desktop", {"name": "不应修改"}),
            ("/connectors", {**connector_body, "client_id": "head-new-connector"}),
            (f"/connectors/{connector_id}", {"name": "不应修改"}),
            ("/agents/desktop/schedules", {**schedule_body, "client_id": "head-new-schedule"}),
            (f"/schedules/{schedule_id}", {"name": "不应修改"}),
            ("/agents/desktop/memory", {"content": "不应写入", "version": memory["version"]}),
            ("/settings", {"default_model": "offline", "default_reasoning_effort": "xhigh"}),
            ("/conversations", conversation_body),
        ]
        for path, body in cases:
            with self.subTest(path=path):
                before = await self.client.get(path)
                self.assertEqual(before.status_code, 200, before.text)
                seq = self.store.last_seq()
                response = await self.client.request("HEAD", path, json=body)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, b"")
                self.assertEqual(self.store.last_seq(), seq)
                after = await self.client.get(path)
                self.assertEqual(after.status_code, 200, after.text)
                self.assertEqual(after.json(), before.json())
                rejected = await self.client.request("OPTIONS", path, json=body)
                self.assertEqual(rejected.status_code, 405)
                self.assertEqual(self.store.last_seq(), seq)
        seq = self.store.last_seq()
        response = await self.client.head(f"/conversations/{conversation_id}")
        self.assertEqual(response.status_code, 405)
        self.assertEqual(self.store.conversation(conversation_id)["title"], "保留对话")
        self.assertEqual(self.store.last_seq(), seq)

    async def test_committed_capabilities_match_model_tools_and_edit_failure_boundary(self):
        url = "/agents/desktop/capabilities"
        denied = await self.client.get(url, headers={"Authorization": "Bearer wrong"})
        self.assertEqual((denied.status_code, denied.json()["error"]["code"]), (401, "unauthorized"))
        initial = await self.client.get(url)
        self.assertEqual(initial.status_code, 200, initial.text)
        entries = initial.json()["capabilities"]
        self.assertEqual([item["id"] for item in entries], [
            "memory", "tool_search", "files", "processes", "browser", "code_mode",
            "schedule", "image_generation", "uploads", "ui_blocks",
        ])
        by_id = {item["id"]: item for item in entries}
        self.assertEqual((by_id["files"]["status"], by_id["files"]["reason"]),
                         ("enabled", "所有 Agent 都有"))
        self.assertEqual((by_id["code_mode"]["status"], by_id["code_mode"]["reason"], by_id["code_mode"]["tools"]),
                         ("disabled", "未开启", []))
        self.assertEqual((by_id["tool_search"]["status"], by_id["tool_search"]["reason"], by_id["tool_search"]["tools"]),
                         ("disabled", "没有按需连接器", []))
        self.assertEqual((by_id["browser"]["status"], by_id["browser"]["reason"], by_id["browser"]["tools"]),
                         ("not_applicable", "电脑未配置浏览器", []))
        self.assertEqual(by_id["ui_blocks"]["skills"], ["wandrun-ui"])
        self.assertEqual(by_id["memory"]["tools"], [])
        self.assertEqual(by_id["schedule"]["tools"], ["create_schedule"])
        self.assertEqual(by_id["image_generation"]["tools"], ["generate_image"])
        self.assertEqual(by_id["uploads"]["tools"], ["fetch_upload"])
        self.assertEqual(by_id["processes"]["tools"], ["exec_command", "kill_process"])
        bodies = []

        async def respond(model, body):
            bodies.append(body)
            yield answer("done")

        conversation = self.gateway.create_conversation("Tools", "desktop", client_id=uuid4().hex)[0]["id"]
        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            self.runtime.workers.start("tools", conversation, agent_name="desktop")
            self.assertEqual((await self.runtime.workers.wait(conversation))["status"], "completed")
        declared = {tool.get("name", tool["type"]) for tool in bodies[0]["tools"]}
        self.assertEqual(declared - {"cancel_worker"},
                         {tool for item in entries for tool in item["tools"]})

        old = self.runtime._assembly_for("desktop")
        with patch.object(self.runtime, "prepare_agents", side_effect=ValueError("prepare failed")):
            rejected = await self.client.patch("/agents/desktop", json={"description": "uncommitted"})
        self.assertEqual(rejected.status_code, 400)
        self.assertIs(self.runtime._assembly_for("desktop"), old)
        self.assertEqual((await self.client.get(url)).json(), initial.json())
        changed = await self.client.patch("/agents/desktop", json={"description": "committed"})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertIsNot(self.runtime._assembly_for("desktop"), old)
        self.assertEqual((await self.client.get(url)).json(), initial.json())
        deleted = await self.client.delete("/agents/desktop")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        missing = await self.client.get(url)
        self.assertEqual((missing.status_code, missing.json()["error"]["code"]), (404, "not_found"))

    async def test_builtin_skill_catalog_and_separate_user_skill(self):
        listed = await self.client.get("/builtin-skills")
        self.assertEqual(listed.status_code, 200, listed.text)
        item, = listed.json()["skills"]
        self.assertEqual(item["name"], "wandrun-ui")
        self.assertEqual(item["capability"]["id"], "ui_blocks")
        self.assertEqual(item["used_by"], [
            {"id": identity, "name": self.store.agent(identity)["name"]}
            for identity in ("main", "child", "desktop")
        ])
        self.assertTrue(item["description"])
        detail = await self.client.get("/builtin-skills/wandrun-ui")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual({key: value for key, value in detail.json().items() if key != "content"}, item)
        self.assertIn("name: wandrun-ui", detail.json()["content"])
        self.assertEqual((await self.client.get("/builtin-skills/absent")).status_code, 404)
        self.assertEqual((await self.client.delete("/builtin-skills/wandrun-ui")).status_code, 405)
        denied = await self.client.get("/builtin-skills", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(denied.status_code, 401)
        directory = self.workspace.skills_dir / "wandrun-ui"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(
            "---\nname: wandrun-ui\ndescription: user copy\n---\nUser file\n", encoding="utf-8",
        )
        self.assertIn("内置技能", (await self.client.get("/skills/wandrun-ui")).json()["error"])
        removed = await self.client.delete("/skills/wandrun-ui")
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertFalse(directory.exists())
        self.assertEqual((await self.client.get("/builtin-skills")).json()["skills"], [item])

    async def test_agent_persistence_failure_does_not_publish_prepared_assembly(self):
        original = self.runtime._assembly_for("main")
        committed = (await self.client.get("/agents/main/capabilities")).json()
        catalog = self.store.agent_catalog()
        cursor = self.store.last_seq()
        # Fail inside the real store transaction, after Gateway prepared the candidate.
        with closing(sqlite3.connect(self.workspace.state_dir / "gateway.sqlite")) as connection:
            connection.execute("""
                CREATE TRIGGER reject_agent_update BEFORE UPDATE ON agents
                BEGIN SELECT RAISE(ABORT, 'controlled persistence failure'); END
            """)
        response = await self.client.patch("/agents/main", json={"code_mode": True})
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIsInstance(self.gateway.failure, GatewayFailure)
        self.assertIsInstance(self.gateway.failure.__cause__, sqlite3.IntegrityError)
        self.assertEqual(self.store.agent_catalog(), catalog)
        self.assertEqual(self.store.last_seq(), cursor)
        self.assertIs(self.runtime._assembly_for("main"), original)
        self.assertEqual(original.capabilities.entries["code_mode"].status, "disabled")
        self.assertEqual(next(item for item in committed["capabilities"] if item["id"] == "code_mode")["tools"], [])
        self.assertEqual((await self.client.get("/agents/main/capabilities")).status_code, 503)
        with self.assertRaises(GatewayFailure):
            await self.gateway.update_agent("main", {"code_mode": True})

    async def test_default_creation_and_dynamic_effort_validation(self):
        settings = {"default_model": "offline", "default_reasoning_effort": "xhigh"}
        self.assertEqual((await self.client.put("/settings", json=settings)).status_code, 200)
        fields = self.payload()
        del fields["model"]
        created = await self.client.post("/agents", json=fields)
        self.assertEqual(created.status_code, 201, created.text)
        identity = created.json()["agent"]["id"]
        self.assertEqual((created.json()["agent"]["model"], created.json()["agent"]["reasoning_effort"]), ("offline", "xhigh"))
        changed = await self.client.patch(f"/agents/{identity}", json={"reasoning_effort": "low"})
        self.assertEqual(changed.json()["agent"]["reasoning_effort"], "low")
        rejected = await self.client.patch(f"/agents/{identity}", json={"reasoning_effort": "max"})
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(self.store.agent(identity)["reasoning_effort"], "low")

    async def test_compaction_settings_survive_creation_edit_and_restart(self):
        created = await self.client.post("/agents", json=self.payload(
            client_id="compaction-settings", context_window=99000,
            compaction_keep_tokens=14000, compaction_model="summary",
        ))
        self.assertEqual(created.status_code, 201, created.text)
        identity = created.json()["agent"]["id"]
        self.assertEqual(
            (self.store.agent_catalog().agents[identity].context_window,
             self.store.agent_catalog().agents[identity].compaction_keep_tokens,
             self.store.agent_catalog().agents[identity].compaction_model),
            (99000, 14000, "summary"),
        )
        edited = await self.client.patch(f"/agents/{identity}", json={
            "context_window": None, "compaction_keep_tokens": 7000, "compaction_model": None,
        })
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(
            (edited.json()["agent"]["context_window"],
             edited.json()["agent"]["compaction_keep_tokens"],
             edited.json()["agent"]["compaction_model"]),
            (None, 7000, None),
        )
        for bad in ({"context_window": True}, {"compaction_keep_tokens": 0},
                    {"compaction_model": ""}):
            rejected = await self.client.patch(f"/agents/{identity}", json=bad)
            self.assertEqual(rejected.status_code, 400, rejected.text)
        await self.stack.aclose()
        await self.start_runtime()
        self.assertEqual(self.store.agent_catalog().agents[identity].compaction_keep_tokens, 7000)

    async def test_unchanged_agent_pair_does_not_need_catalog(self):
        self.upstream["status"] = 503
        original = self.store.agent("main")
        edited = await self.client.patch("/agents/main", json={
            "name": "断网改名", "model": original["model"], "reasoning_effort": original["reasoning_effort"],
        })
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(self.upstream["calls"], 0)
        rejected = await self.client.patch("/agents/main", json={"reasoning_effort": "xhigh"})
        self.assertEqual((rejected.status_code, rejected.json()["error"]["code"]), (503, "model_catalog_unavailable"))
        self.assertEqual(self.store.agent("main")["reasoning_effort"], original["reasoning_effort"])

    async def test_catalog_wait_keeps_create_idempotency_and_concurrent_edits(self):
        entered, release = asyncio.Event(), asyncio.Event()
        models = self.gateway.subscription.models

        async def delayed_models(*args, **kwargs):
            entered.set()
            await release.wait()
            return await models(*args, **kwargs)

        with patch.object(self.gateway.subscription, "models", delayed_models):
            first = asyncio.create_task(self.client.post("/agents", json=self.payload()))
            await entered.wait()
            second = asyncio.create_task(self.client.post("/agents", json=self.payload()))
            release.set()
            results = await asyncio.gather(first, second)
        self.assertEqual(sorted(response.status_code for response in results), [200, 201])
        self.assertEqual(results[0].json()["agent"]["id"], results[1].json()["agent"]["id"])
        self.assertEqual(len(self.store.agents()), 4)

        entered.clear()
        release.clear()
        with patch.object(self.gateway.subscription, "models", delayed_models):
            changing = asyncio.create_task(self.client.patch("/agents/main", json={"reasoning_effort": "xhigh"}))
            await entered.wait()
            renaming = asyncio.create_task(self.client.patch("/agents/main", json={"name": "并发改名"}))
            release.set()
            changed, renamed = await asyncio.gather(changing, renaming)
            self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual((self.store.agent("main")["name"], self.store.agent("main")["reasoning_effort"]), ("并发改名", "xhigh"))

    async def test_ultra_is_rejected_before_catalog_access(self):
        self.upstream["status"] = 503
        responses = [
            await self.client.post("/agents", json=self.payload(reasoning_effort="ultra")),
            await self.client.patch("/agents/main", json={"reasoning_effort": "ultra"}),
            await self.client.put("/settings", json={"default_model": "offline", "default_reasoning_effort": "ultra"}),
        ]
        for response in responses:
            self.assertEqual(response.status_code, 400, response.text)
            self.assertIn("不支持 ultra", response.json()["error"]["message"])
        self.assertEqual(self.upstream["calls"], 0)

    async def test_create_replay_patch_noop_validation_and_stream(self):
        cursor = self.store.last_seq()
        response = await self.client.post("/agents", json=self.payload())
        self.assertEqual(response.status_code, 201, response.text)
        original = response.json()
        identity = original["agent"]["id"]
        self.assertRegex(identity, r"^a_[a-f0-9]{32}$")
        self.assertEqual((await self.client.post("/agents", json=self.payload())).json()["agent"], original["agent"])
        updated = await self.client.patch(f"/agents/{identity}", json={"name": "新名", "workers": ["child"]})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.store.agent("child")["member_of"], ["main", identity])
        seq = self.store.last_seq()
        noop = await self.client.patch(f"/agents/{identity}", json={"name": "新名", "workers": ["child"]})
        self.assertIsNone(noop.json()["event"])
        self.assertEqual(self.store.last_seq(), seq)
        for fields in ({"workers": [identity]}, {"workers": ["missing"]}, {"skills": ["../escape"]},
                       {"name": ""}, {"name": None}, {"name": "两\n行"}, {"name": "名" * 65},
                       {"avatar": True}, {"avatar": -1}, {"avatar": 8}, {"avatar": None}, {"model": ""},
                       {"reasoning_effort": "wrong"}, {"skills": "bad"}, {"environment": "missing"},
                       {"mcp_servers": ["missing"]}, {"searchable_mcp_servers": "bad"}, {"code_mode": "false"},
                       {"code_mode": None}, {"code_mode": 0}, {"code_mode": []}):
            rejected = await self.client.patch(f"/agents/{identity}", json=fields)
            self.assertEqual(rejected.status_code, 400, (fields, rejected.text))
            self.assertEqual(self.store.last_seq(), seq)
            self.assertEqual(self.store.agent(identity), updated.json()["agent"])
        replay = await self.client.post("/agents", json=self.payload(name="忽略重试内容"))
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["agent"], original["agent"])
        stream = self.gateway.stream(cursor)
        await anext(stream)  # Authoritative draft set precedes durable replay.
        self.assertEqual((await anext(stream))[1], original["event"])
        self.assertEqual((await anext(stream))[1], updated.json()["event"])
        await stream.aclose()

    async def test_memory_api_cas_unicode_limit_authorship_and_external_changes(self):
        url = "/agents/main/memory"
        empty = (await self.client.get(url)).json()
        self.assertEqual(empty, {
            "scope": "work", "agent_id": "main", "content": "",
            "version": self.runtime.memory.read("main").version,
            "details": {}, "updated_at": None, "updated_by": None, "limit": 1000,
        })
        invalid = [
            {}, {"content": None, "version": empty["version"]},
            {"content": "x", "version": None},
            {"content": "x", "version": "A" * 64},
            {"content": "x", "version": empty["version"], "unexpected": True},
        ]
        for body in invalid:
            response = await self.client.put(url, json=body)
            self.assertEqual(response.status_code, 400, response.text)
        content = "🤖中\r\n" + "a" * 997
        changed = await self.client.put(url, json={"content": content, "version": empty["version"]})
        self.assertEqual(changed.status_code, 200, changed.text)
        saved = changed.json()
        self.assertEqual(saved["content"], "🤖中\n" + "a" * 997)
        self.assertEqual((len(saved["content"]), saved["updated_by"], saved["limit"]), (1000, "user", 1000))
        self.assertIsInstance(saved["updated_at"], float)
        self.assertEqual((await self.client.get(url)).json(), saved)
        events = self.store.after(0)
        self.assertEqual([(e.type, e.data) for e in events], [
            ("resource.changed", {"kind": "memory", "scope": "work", "id": "main", "op": "updated"}),
        ])
        noop = await self.client.put(url, json={"content": saved["content"], "version": saved["version"]})
        self.assertEqual(noop.json(), saved)
        self.assertEqual(self.store.last_seq(), events[-1].seq)
        too_long = await self.client.put(url, json={
            "content": content + "x", "version": saved["version"],
        })
        self.assertEqual(too_long.status_code, 400)
        self.assertEqual((await self.client.get(url)).json(), saved)
        stale = await self.client.put(url, json={"content": "过期", "version": empty["version"]})
        self.assertEqual((stale.status_code, stale.json()["error"]["code"]), (409, "memory_conflict"))
        self.assertEqual(stale.json()["error"]["details"]["current"], saved)
        self.assertEqual(self.store.last_seq(), events[-1].seq)
        with patch.object(self.runtime.memory, "on_change", None):
            direct = self.runtime.memory.save("main", "外部更改", saved["version"])
        external = (await self.client.get(url)).json()
        self.assertEqual((external["content"], external["updated_by"]), ("外部更改", "external"))
        conflicted = await self.client.put(url, json={"content": "不覆盖", "version": saved["version"]})
        self.assertEqual(conflicted.json()["error"]["details"]["current"], external)
        self.assertEqual(self.store.last_seq(), events[-1].seq)
        self.assertEqual(direct.version, external["version"])
        self.assertEqual((await self.client.get("/agents/missing/memory")).status_code, 404)

    async def test_agent_memory_callback_records_root_event_but_user_edits_do_not(self):
        root = self.gateway.create_conversation("委派", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "begin", "开始")
        await self.runtime.workers.wait(root)
        child = self.runtime.workers.start("记住", sender_id=root, agent_name="child")["task_id"]
        await self.runtime.workers.wait(child)
        cursor = self.store.last_seq()
        memory = self.runtime.memory
        first = memory.save("child", "受托记忆", memory.read("child").version, task_id=child)
        self.assertEqual(
            [(event.type, event.data) for event in self.store.after(cursor)],
            [
                ("resource.changed", {"kind": "memory", "scope": "work", "id": "child", "op": "updated"}),
                ("memory.updated", {
                    "scope": "work", "agent_id": "child", "version": first.version, "summary": "已记住",
                }),
            ],
        )
        self.assertEqual(self.store.history(root)[-1].conversation_id, root)
        self.assertEqual((await self.client.get("/agents/child/memory")).json()["updated_by"], "agent")
        cursor = self.store.last_seq()
        second = await self.client.put("/agents/child/memory", json={
            "content": "用户修正", "version": first.version,
        })
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            [(event.type, event.data) for event in self.store.after(cursor)],
            [("resource.changed", {"kind": "memory", "scope": "work", "id": "child", "op": "updated"})],
        )
        self.assertEqual((await self.client.get("/agents/child/memory")).json()["updated_by"], "user")
        clear = await self.client.put("/agents/child/memory", json={
            "content": "", "version": second.json()["version"],
        })
        self.assertEqual((clear.status_code, clear.json()["updated_by"], clear.json()["content"]),
                         (200, "user", ""))
        self.assertEqual((await self.client.get("/agents/child/memory")).json()["updated_by"], "user")

    async def test_profile_api_is_shared_and_reports_actual_root_writer(self):
        profile_url = "/memory/profile"
        empty = (await self.client.get(profile_url)).json()
        self.assertEqual(empty, {
            "scope": "profile", "content": "", "version": self.runtime.memory.read(None).version,
            "details": {}, "updated_at": None, "updated_by": None, "limit": 1000,
        })
        work = (await self.client.get("/agents/child/memory")).json()
        changed = await self.client.put(profile_url, json={
            "content": "跨 Agent 偏好", "version": empty["version"],
        })
        self.assertEqual(changed.status_code, 200, changed.text)
        profile = changed.json()
        self.assertEqual(profile["updated_by"], "user")
        self.assertNotIn("agent_id", profile)
        self.assertEqual((await self.client.get(profile_url)).json(), profile)
        self.assertEqual((await self.client.get("/agents/child/memory")).json(), work)
        self.assertEqual([(e.type, e.data) for e in self.store.after(0)], [
            ("resource.changed", {"kind": "memory", "scope": "profile", "op": "updated"}),
        ])
        stale = await self.client.put(profile_url, json={
            "content": "旧覆盖", "version": empty["version"],
        })
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["error"]["details"]["current"], profile)
        root = self.gateway.create_conversation("入口", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "profile-root", "开始")
        await self.runtime.workers.wait(root)
        cursor = self.store.last_seq()
        written = self.runtime.memory.save(None, "入口更新", profile["version"], task_id=root)
        self.assertEqual([(e.type, e.data) for e in self.store.after(cursor)], [
            ("resource.changed", {"kind": "memory", "scope": "profile", "op": "updated"}),
            ("memory.updated", {
                "scope": "profile", "agent_id": "main", "version": written.version,
                "summary": "已记住",
            }),
        ])
        self.assertEqual((await self.client.get(profile_url)).json()["updated_by"], "agent")

    async def test_profile_a_b_a_rejects_old_cas_baseline(self):
        url = "/memory/profile"
        empty = (await self.client.get(url)).json()
        first = (await self.client.put(url, json={
            "content": "A", "version": empty["version"],
        })).json()
        second = (await self.client.put(url, json={
            "content": "B", "version": first["version"],
        })).json()
        back = (await self.client.put(url, json={
            "content": "A", "version": second["version"],
        })).json()
        self.assertNotEqual(back["version"], first["version"])
        stale = await self.client.put(url, json={
            "content": "旧编辑", "version": first["version"],
        })
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["error"]["details"]["current"], back)

    async def test_detail_api_combines_index_publication_and_cas_in_both_scopes(self):
        for identity, index_url, detail_url, scope in (
            (None, "/memory/profile", "/memory/profile/details/tone", "profile"),
            ("main", "/agents/main/memory", "/agents/main/memory/details/tone", "work"),
        ):
            with self.subTest(scope=scope):
                empty = (await self.client.get(index_url)).json()
                logical = f"/.wandrun/memory/{scope}/details/tone.md"
                initial = f"偏好：[语气]({logical})"
                cursor = self.store.last_seq()
                no_index = await self.client.put(detail_url, json={
                    "content": "保持简洁", "version": empty["version"],
                })
                self.assertEqual(no_index.status_code, 400)
                self.assertEqual(self.store.last_seq(), cursor)
                created = await self.client.put(detail_url, json={
                    "content": "保持简洁", "version": empty["version"], "index_content": initial,
                })
                self.assertEqual(created.status_code, 200, created.text)
                document = created.json()
                self.assertEqual(document["scope"], scope)
                self.assertEqual(len(self.store.after(cursor)), 1)
                reference = document["details"]["tone"]
                self.assertIn(reference["path"], document["content"])
                self.assertNotIn(logical, document["content"])
                detail = (await self.client.get(detail_url)).json()
                self.assertEqual(detail, {
                    "scope": scope, "slug": "tone", "content": "保持简洁",
                    "sha256": reference["sha256"], "path": reference["path"],
                    "version": document["version"], "limit": 65536,
                    **({"agent_id": identity} if identity is not None else {}),
                })
                same = await self.client.put(detail_url, json={
                    "content": "保持简洁", "version": document["version"],
                })
                self.assertEqual(same.json(), document)
                self.assertEqual(len(self.store.after(cursor)), 1)
                stale = await self.client.put(detail_url, json={
                    "content": "旧编辑", "version": empty["version"],
                })
                self.assertEqual(stale.status_code, 409)
                self.assertEqual(stale.json()["error"]["details"]["current"], document)
                stale_delete = await self.client.request("DELETE", detail_url, json={
                    "content": "", "version": empty["version"],
                })
                self.assertEqual(stale_delete.status_code, 409)
                self.assertEqual(stale_delete.json()["error"]["details"]["current"], document)
                changed = await self.client.put(detail_url, json={
                    "content": "LF\r\n与 🤖", "version": document["version"],
                })
                self.assertEqual(changed.status_code, 200, changed.text)
                newer = changed.json()
                self.assertNotEqual(newer["version"], document["version"])
                self.assertNotEqual(newer["details"]["tone"], reference)
                self.assertEqual((await self.client.get(detail_url)).json()["content"], "LF\n与 🤖")
                with self.assertRaisesRegex(ValueError, "失效"):
                    self.runtime.memory.read_detail(identity, "tone", path=reference["path"])
                still_referenced = await self.client.request("DELETE", detail_url, json={
                    "content": newer["content"], "version": newer["version"],
                })
                self.assertEqual(still_referenced.status_code, 400)
                deleted = await self.client.request("DELETE", detail_url, json={
                    "content": "", "version": newer["version"],
                })
                self.assertEqual(deleted.status_code, 200, deleted.text)
                self.assertEqual(deleted.json()["details"], {})
                self.assertEqual((await self.client.get(detail_url)).status_code, 400)
                before_noop = self.store.last_seq()
                repeated = await self.client.request("DELETE", detail_url, json={
                    "content": "", "version": deleted.json()["version"],
                })
                self.assertEqual(repeated.json(), deleted.json())
                self.assertEqual(self.store.last_seq(), before_noop)

    async def test_detail_api_rejects_invalid_input_and_preserves_document(self):
        index = (await self.client.get("/memory/profile")).json()
        url = "/memory/profile/details/tone"
        for body in ({}, {"content": 1, "version": index["version"]}, {
            "content": "x", "version": index["version"], "index_content": None,
        }, {"content": "x", "version": "wrong", "index_content": "x"}):
            self.assertEqual((await self.client.put(url, json=body)).status_code, 400)
        oversized = await self.client.put(url, json={
            "content": "中" * 21846, "version": index["version"],
            "index_content": "/.wandrun/memory/profile/details/tone.md",
        })
        self.assertEqual(oversized.status_code, 400)
        bad_slug = await self.client.put("/memory/profile/details/bad.slug", json={
            "content": "x", "version": index["version"],
            "index_content": "/.wandrun/memory/profile/details/bad.slug.md",
        })
        self.assertEqual(bad_slug.status_code, 400)
        cross_scope = await self.client.put("/memory/profile", json={
            "content": "/.wandrun/memory/work/details/tone/" + "0" * 64 + ".md",
            "version": index["version"],
        })
        self.assertEqual(cross_scope.status_code, 400)
        self.assertEqual((await self.client.get("/memory/profile")).json(), index)

    async def test_detail_publication_failure_does_not_report_unpublished_success(self):
        empty = (await self.client.get("/memory/profile")).json()
        cursor = self.store.last_seq()
        with patch.object(self.store, "record_memory_change", side_effect=OSError("event disk failed")):
            failed = await self.client.put("/memory/profile/details/tone", json={
                "content": "已发布", "version": empty["version"],
                "index_content": "/.wandrun/memory/profile/details/tone.md",
            })
        self.assertEqual((failed.status_code, failed.json()["error"]["code"]), (503, "unavailable"))
        published = self.runtime.memory.read(None)
        self.assertIn("tone", published.details)
        self.assertEqual(self.runtime.memory.read_detail(None, "tone").content, "已发布")
        self.assertEqual(self.store.last_seq(), cursor)
        self.assertIsInstance(self.gateway.failure, GatewayFailure)

    async def test_detail_cleanup_failure_reports_partial_publication(self):
        memory = self.runtime.memory
        empty = (await self.client.get("/agents/main/memory")).json()
        with patch.object(memory, "_cleanup", side_effect=OSError("unlink failed")):
            failed = await self.client.put("/agents/main/memory/details/tone", json={
                "content": "正文", "version": empty["version"],
                "index_content": "/.wandrun/memory/work/details/tone.md",
            })
        self.assertEqual((failed.status_code, failed.json()["error"]["code"]), (503, "unavailable"))
        self.assertIn("tone", memory.read("main").details)
        self.assertEqual(len(self.store.after(0)), 1)

    async def test_invalid_external_memory_read_fails_closed(self):
        memory = self.runtime.memory
        memory.save("main", "good", memory.read("main").version)
        manifest = memory.root / "agents" / "main" / "current.json"
        manifest.write_bytes(b"\xff")
        response = await self.client.get("/agents/main/memory")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "unavailable"))
        self.assertIsInstance(self.gateway.failure.__cause__, MemoryReadError)
        self.assertEqual(manifest.read_bytes(), b"\xff")
        self.assertEqual(self.store.last_seq(), 1)

    async def test_memory_storage_and_post_save_metadata_failures_stop_gateway(self):
        with patch.object(self.runtime.memory, "read", side_effect=OSError("read failed")):
            response = await self.client.get("/agents/main/memory")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "unavailable"))
        self.assertIsInstance(self.gateway.failure, GatewayFailure)
        await self.stack.aclose()
        await self.start_runtime()
        empty = (await self.client.get("/agents/main/memory")).json()
        cursor = self.store.last_seq()
        with patch.object(self.store, "record_memory_change", side_effect=OSError("disk full")):
            failed = await self.client.put("/agents/main/memory", json={
                "content": "已写但事件失败", "version": empty["version"],
            })
        self.assertEqual((failed.status_code, failed.json()["error"]["code"]), (503, "unavailable"))
        self.assertEqual(self.runtime.memory.read("main").content, "已写但事件失败")
        self.assertEqual(self.store.last_seq(), cursor)
        self.assertIsInstance(self.gateway.failure, GatewayFailure)

    async def test_delete_waits_for_file_transfer_cleanup_without_publishing_intent(self):
        with patch.object(self.runtime, "file_transfers_pending", return_value=True):
            rejected = await self.client.delete("/agents/desktop")
        self.assertEqual(rejected.status_code, 409, rejected.text)
        self.assertTrue(rejected.json()["error"]["details"]["file_transfers_pending"])
        self.assertFalse(self.store.agent_deleting("desktop"))
        self.assertIsNone(self.store.deleted_agent_event("desktop"))
        self.assertEqual((await self.client.get("/agents/desktop")).status_code, 200)
        self.assertIsNone(self.gateway.failure)

        deleted = await self.client.delete("/agents/desktop")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertIsNotNone(self.store.deleted_agent_event("desktop"))

    async def test_delete_conflicts_report_members_and_running_tasks(self):
        response = await self.client.delete("/agents/child")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["details"], {
            "member_of": [{"id": "main", "name": "main"}], "running_conversations": 0,
            "running_tasks": 0,
        })
        desktop = await self.client.delete("/agents/desktop")
        self.assertEqual(desktop.status_code, 200)
        self.block = True
        root = self.gateway.create_conversation("运行中", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "run", "开始")
        await asyncio.wait_for(self.entered.wait(), 5)
        working = await self.client.delete("/agents/main")
        self.assertEqual(working.status_code, 409)
        self.assertEqual(working.json()["error"]["details"]["running_conversations"], 1)
        self.release.set()
        await self.runtime.workers.wait(root)


    async def test_removed_member_with_running_delegation_cannot_be_deleted(self):
        root = self.gateway.create_conversation("其他入口", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "run", "开始")
        await self.runtime.workers.wait(root)
        self.block = True
        self.entered.clear()
        receipt = self.runtime.workers.dispatch(AgentOutput(messages=[
            SendMessage(to="child", task_id=None, message="委派"),
        ], next="done"), root)[0]
        child = receipt["task_id"]
        await asyncio.wait_for(self.entered.wait(), 5)
        updated = await self.client.patch("/agents/main", json={"workers": []})
        self.assertEqual(updated.status_code, 200, updated.text)
        rejected = await self.client.delete("/agents/child")
        self.assertEqual(rejected.status_code, 409, rejected.text)
        self.assertEqual(rejected.json()["error"]["details"], {
            "member_of": [], "running_conversations": 0, "running_tasks": 1,
        })
        self.assertFalse(self.store.agent_deleting("child"))
        self.assertEqual(self.runtime.workers.get(child)["status"], "running")
        self.assertIsNone(self.gateway.failure)
        self.release.set()
        await self.runtime.workers.wait(child)
        self.assertEqual((await self.client.delete("/agents/child")).status_code, 200)
        self.assertIsNotNone(self.store.conversation(root))
        self.assertEqual(self.runtime.workers.get(child)["status"], "completed")

    async def test_deletion_intent_blocks_existing_delegation_and_notification_resume(self):
        root = self.gateway.create_conversation("其他入口", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "run", "开始")
        manager = self.runtime.workers
        await manager.wait(root)
        child = manager.start("委派", sender_id=root, agent_name="child")["task_id"]
        await manager.wait(child)
        await self.client.patch("/agents/main", json={"workers": []})
        history = self.gateway.create_conversation("子角色历史", "child", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(history, "child-run", "开始")
        await manager.wait(history)
        started, release = asyncio.Event(), asyncio.Event()

        async def cleanup(scope):
            started.set()
            await release.wait()
            return []

        manager.add_stop_hook(cleanup)
        operation = asyncio.create_task(self.gateway.delete_agent("child"))
        await asyncio.wait_for(started.wait(), 5)
        try:
            # 无关编辑会重新发布角色目录，不能解除删除屏障。
            await self.client.patch("/agents/main", json={"name": "新入口"})
            with self.assertRaisesRegex(ValueError, "正在删除"):
                manager.start("恢复旧任务", child, sender_id=root, agent_name="child")
            manager.notify(child, {"process_finished": True})
            await asyncio.sleep(0)
            self.assertEqual(manager.get(child)["status"], "completed")
        finally:
            release.set()
            await operation
        with self.assertRaisesRegex(ValueError, "未知 Agent"):
            manager.start("删除后恢复", child, sender_id=root, agent_name="child")
        manager.notify(child, {"late_process_finished": True})
        await asyncio.sleep(0)
        self.assertEqual(manager.get(child)["status"], "completed")
        self.assertIsNotNone(self.store.conversation(root))

    async def test_create_selects_least_used_avatar_and_replays_original_choice(self):
        # 初次导入的三个角色依次占用 0、1、2。
        response = await self.client.post("/agents", json=self.payload())
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["agent"]["avatar"], 3)
        explicit = await self.client.post("/agents", json=self.payload(client_id="explicit", name="指定头像", avatar=7))
        self.assertEqual(explicit.status_code, 201, explicit.text)
        self.assertEqual(explicit.json()["agent"]["avatar"], 7)
        replay = await self.client.post("/agents", json=self.payload(avatar=6))
        self.assertEqual(replay.json()["agent"], response.json()["agent"])
        identity = response.json()["agent"]["id"]
        renamed = await self.client.patch(f"/agents/{identity}", json={"name": "名" * 64})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(renamed.json()["agent"]["avatar"], 3)

    async def test_delete_cleans_threads_scheduler_settings_and_preserves_members(self):
        root = self.gateway.create_conversation("历史", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "run", "开始")
        await self.runtime.workers.wait(root)
        checkpointer = self.runtime.checkpointer
        config = {"configurable": {"thread_id": root}}
        self.assertIsNotNone(await checkpointer.aget_tuple(config))
        result = await self.client.delete("/agents/main")
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["event"]["data"], {"kind": "agent", "id": "main", "op": "deleted"})
        self.assertIsNone(self.store.agent("main"))
        self.assertIsNone(self.store.conversation(root))
        self.assertIsNone(await checkpointer.aget_tuple(config))
        self.assertEqual(self.runtime.workers.get(root)["status"], "not_found")
        with sqlite3.connect(paired_store_path(self.workspace.checkpoint_path)) as db:
            self.assertEqual(db.execute("SELECT task_id FROM tasks").fetchall(), [])
        self.assertIsNone(self.store.agent_catalog().main_agent)
        self.assertEqual(self.store.agent("child")["member_of"], [])
        child = self.gateway.create_conversation("成员仍可用", "child", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(child, "child-run", "工作")
        await self.runtime.workers.wait(child)
        self.assertEqual(self.runtime.workers.get(child)["status"], "completed")
        self.assertEqual((await self.client.delete("/agents/main")).json(), result.json())

    async def test_delete_agent_preserves_unconfirmed_browser_and_directory_reports(self):
        from types import SimpleNamespace
        from wandrun.runtime.browser.leases import BrowserRejected
        root = self.gateway.create_conversation("外部未确认", "main", client_id=uuid4().hex)[0]["id"]

        async def fail_close_agent(*args, **kwargs):
            raise ExceptionGroup("close", [BrowserRejected("Chrome unavailable")])

        async def remote(command):
            raise TimeoutError("SSH unavailable")

        class Browser:
            list_tasks = staticmethod(lambda: [])
            close_agent = staticmethod(fail_close_agent)

        self.runtime.browsers = {"local": Browser()}
        self.runtime.files.conversation_workdirs = True
        self.runtime.files.update_environments(
            {"main": ("cloud", "/remote")}, {"main": SimpleNamespace(aexecute=remote)},
        )
        deleted = await self.client.delete("/agents/main")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        stages = {item["stage"] for item in deleted.json()["event"]["data"]["cleanup_unconfirmed"]}
        self.assertEqual(stages, {"browser", "directory"})
        self.assertIsNone(self.gateway.failure)
        self.assertIsNone(self.store.agent("main"))
        self.assertIsNone(self.store.conversation(root))
        self.assertEqual((await self.client.delete("/agents/main")).json(), deleted.json())
        self.assertEqual(self.store.deleted_event(root).data["cleanup_unconfirmed"][0]["environment"], "cloud")

    async def test_failed_delete_survives_restart_and_resumes_without_duplicate_events(self):
        root = self.gateway.create_conversation("历史", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "run", "开始")
        await self.runtime.workers.wait(root)
        with patch.object(self.runtime.checkpointer, "adelete_thread", side_effect=OSError("disk failed")):
            with self.assertRaises(GatewayFailure):
                await self.gateway.delete_agent("main")
        self.assertTrue(self.store.agent_deleting("main"))
        self.assertIsNotNone(self.store.agent("main"))
        self.assertEqual((await self.client.patch("/agents/main", json={"name": "不能修改"})).status_code, 503)
        await self.stack.aclose()
        await self.start_runtime()
        with self.assertRaisesRegex(ValueError, "正在删除"):
            self.runtime.workers.start("重启后恢复", root, agent_name="main")
        await self.gateway.resume_deletions()
        self.assertIsNone(self.store.agent("main"))
        self.assertEqual(self.store.pending_agent_deletions(), [])
        deleted = [event for event in self.store.after(0)
                   if event.type == "resource.changed" and event.data.get("op") == "deleted"]
        self.assertEqual([event.data["id"] for event in deleted], ["main"])
        with self.assertRaises(MemoryRetired):
            self.runtime.memory.read("main")
        self.assertEqual(await self.gateway.delete_agent("main"), deleted[0])

    async def test_memory_unlink_failure_keeps_delete_intent_and_retries_after_restart(self):
        memory = self.runtime.memory
        work = await self.client.put("/agents/main/memory/details/note", json={
            "content": "待清理", "version": memory.read("main").version,
            "index_content": "/.wandrun/memory/work/details/note.md",
        })
        self.assertEqual(work.status_code, 200, work.text)
        saved = memory.read("main")
        profile_response = await self.client.put("/memory/profile/details/note", json={
            "content": "保留画像", "version": memory.read(None).version,
            "index_content": "/.wandrun/memory/profile/details/note.md",
        })
        self.assertEqual(profile_response.status_code, 200, profile_response.text)
        profile = memory.read(None)
        file = memory.root / "agents" / "main" / "current.json"
        with patch.object(memory, "delete", side_effect=OSError("unlink failed")):
            with self.assertRaises(GatewayFailure):
                await self.gateway.delete_agent("main")
        self.assertTrue(self.store.agent_deleting("main"))
        self.assertIn("note", file.read_text(encoding="utf-8"))
        with self.assertRaises(MemoryRetired):
            memory.save("main", "新任务", saved.version)
        await self.stack.aclose()
        await self.start_runtime()
        with self.assertRaises(MemoryRetired):
            self.runtime.memory.read("main")
        self.assertEqual((await self.client.get("/agents/main/memory")).status_code, 404)
        await self.gateway.resume_deletions()
        self.assertFalse(file.exists())
        self.assertIsNone(self.store.agent("main"))
        self.assertEqual(self.runtime.memory.read(None).content, profile.content)
        self.assertEqual(self.runtime.memory.read_detail(None, "note").content, "保留画像")
        self.assertEqual(self.store.memory_author(None, profile.version), "user")
        self.assertIsNone(self.store.memory_author("main", saved.version))
        deleted = [
            event for event in self.store.after(0)
            if event.data == {"kind": "agent", "id": "main", "op": "deleted"}
        ]
        self.assertEqual(len(deleted), 1)

    async def test_delete_intent_blocks_new_work_and_references_while_waiter_cancels(self):
        root = self.gateway.create_conversation("历史", "main", client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "run", "开始")
        await self.runtime.workers.wait(root)
        memory = self.runtime.memory
        saved = memory.save("main", "删除中的正文", memory.read("main").version)
        started, release = asyncio.Event(), asyncio.Event()

        async def cleanup(scope):
            started.set()
            await release.wait()
            return []

        self.runtime.workers.add_stop_hook(cleanup)
        operation = asyncio.create_task(self.gateway.delete_agent("main"))
        await asyncio.wait_for(started.wait(), 5)
        with self.assertRaises(MemoryRetired):
            memory.save("main", "不准写", saved.version)
        self.assertEqual((await self.client.get("/agents/main/memory")).status_code, 404)
        operation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await operation
        try:
            self.assertEqual((await self.client.post("/conversations", json={"client_id": uuid4().hex, "agent_id": "main"})).status_code, 409)
            self.assertEqual((await self.client.patch("/agents/main", json={"name": "晚到"})).status_code, 409)
            self.assertEqual((await self.client.patch("/agents/child", json={"workers": ["main"]})).status_code, 400)
            changed = await self.client.patch("/agents/child", json={"name": "独立更新"})
            self.assertEqual(changed.status_code, 200)
        finally:
            release.set()
            await self.gateway.drain_deletions()
        self.assertIsNone(self.store.agent("main"))
        self.assertEqual(self.store.agent("child")["name"], "独立更新")
        self.assertFalse((memory.root / "agents" / "main" / "current.json").exists())

    async def test_deleted_empty_catalog_is_not_reimported(self):
        # 桌面角色仍有独立保护；这里用单 Agent catalog 验证合法删空后的首次导入边界。
        await self.stack.aclose()
        other = GatewayStore(self.workspace.state_dir / "empty.sqlite")
        self.addCleanup(other.close)
        other.import_agents(AgentCatalog("last", {"last": self.catalog.agents["child"]}))
        self.store = other
        await self.start_runtime()
        await self.gateway.delete_agent("last")
        self.assertEqual(self.store.agent_catalog().agents, {})
        ensure_agents(self.store, Path("missing-agents.toml"), Path("missing-mcps.toml"), Path("missing-env.toml"))
        self.assertEqual(self.store.agents(), [])
        created = await self.client.post("/agents", json=self.payload())
        self.assertEqual(created.status_code, 201, created.text)
        identity = created.json()["agent"]["id"]
        root = self.gateway.create_conversation("新开始", identity, client_id=uuid4().hex)[0]["id"]
        self.gateway.send_message(root, "new-run", "工作")
        await self.runtime.workers.wait(root)
        self.assertEqual(self.runtime.workers.get(root)["status"], "completed")
