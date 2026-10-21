"""Skill HTTP contract, malformed entries and descriptor-anchored deletion boundaries."""

import asyncio
from contextlib import contextmanager
from dataclasses import replace
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.capabilities import gateway_capabilities
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.skills import InvalidSkill, MAX_SKILL_CONTENT_BYTES, inspect_skill
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.metrics import RunMetrics
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.session import open_runtime
from wandrun.runtime.workspace import Workspace
from test_runtime import answer


class GatewaySkillTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.skills = self.workspace / ".wandrun" / "skills"
        self.skills.mkdir(parents=True)
        self.store = GatewayStore(self.workspace / "gateway.sqlite")
        self.addCleanup(self.store.close)
        role = AgentDefinition("说明", "完成任务", "offline", environment="local")
        self.store.import_agents(AgentCatalog("main", {"main": role, "other": role}))
        self.gateway = Gateway(self.store)
        self.gateway.skills_dir = self.skills
        self.gateway.workspace_root = self.workspace
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway", headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)

    def skill(self, name: str, content: str) -> Path:
        directory = self.skills / name
        directory.mkdir()
        (directory / "SKILL.md").write_text(content, encoding="utf-8")
        return directory

    @staticmethod
    def body(name: str, description: str = "执行有用任务", suffix: str = "# 用法\n") -> str:
        return f"---\nname: {name}\ndescription: {description}\n---\n{suffix}"

    def select(self, name: str, *, user: str = "main", display_name: str | None = None) -> None:
        current = self.store.agent(user)
        definition = self.store.agent_catalog().agents[user]
        self.store.update_agent(
            user, replace(definition, name=display_name, skills=(name,)), display_name or user, current["avatar"],
        )

    async def test_reserved_user_skill_is_reported_inactive_and_runtime_keeps_builtin_precedence(self):
        content = self.body("wandrun-ui", "User-selected policy")
        user_file = self.skill("wandrun-ui", content) / "SKILL.md"
        self.select("wandrun-ui")
        catalog = self.store.agent_catalog()
        workspace = Workspace(self.workspace)
        workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8",
        )
        workspace.mcps_config.write_text("[mcp_servers]\n", encoding="utf-8")

        async def respond(model, body):
            yield answer("done")

        async def metadata(runtime, task_id):
            runtime.workers.start("show skill", task_id, agent_name="main")
            result = await runtime.workers.wait(task_id)
            self.assertEqual(result["status"], "completed", result)
            saved = await runtime.checkpointer.aget_tuple(conversation_config(task_id))
            return saved.checkpoint["channel_values"]["skills_metadata"]

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            async with open_runtime(
                workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                agent_catalog=catalog,
                entry_capabilities=gateway_capabilities(self.gateway),
            ) as runtime:
                self.gateway.attach(runtime.workers, runtime.checkpointer, runtime=runtime)
                listed = (await self.client.get("/skills")).json()["skills"]
                detail = (await self.client.get("/skills/wandrun-ui")).json()
                self.assertEqual((listed[0]["status"], detail["status"]), ("error", "error"))
                self.assertIn("内置技能", detail["error"])
                self.assertIn("不生效", listed[0]["error"])
                self.assertEqual(detail["content"], content)
                self.assertEqual(detail["used_by"], [{"id": "main", "name": "main"}])
                selected = await metadata(runtime, "gateway-selected")
                self.assertEqual([skill["name"] for skill in selected], ["wandrun-ui"])
                builtin_path = Path(selected[0]["path"])
                self.assertNotEqual(builtin_path, user_file)
                self.assertNotIn("User-selected policy", str(selected))
                self.assertTrue(builtin_path.is_file())

                before = self.store.last_seq()
                rejected = await self.client.patch("/agents/other", json={"skills": ["wandrun-ui"]})
                self.assertEqual(rejected.status_code, 400)
                with patch.object(self.gateway.subscription, "models", AsyncMock(return_value={"models": []})):
                    created = await self.client.post("/agents", json={
                        "client_id": "reserved-create", "name": "New", "description": "New",
                        "system_prompt": "Work", "model": "offline", "skills": ["wandrun-ui"],
                    })
                self.assertEqual(created.status_code, 400)
                self.assertIn("内置技能", created.json()["error"]["message"])
                self.assertEqual(self.store.last_seq(), before)

                # Existing references can survive unrelated edits or be removed, but not re-added.
                edited = await self.client.patch("/agents/main", json={
                    "description": "Updated", "skills": ["wandrun-ui"],
                })
                self.assertEqual(edited.status_code, 200, edited.text)
                removed = await self.client.patch("/agents/main", json={"skills": []})
                self.assertEqual(removed.status_code, 200, removed.text)
                self.assertEqual((await self.client.get("/skills/wandrun-ui")).json()["used_by"], [])
                rejected = await self.client.patch("/agents/main", json={"skills": ["wandrun-ui"]})
                self.assertEqual(rejected.status_code, 400)
                selected = await metadata(runtime, "gateway-unselected")
                self.assertEqual(selected[0]["path"], str(builtin_path))
                self.assertEqual(user_file.read_text(encoding="utf-8"), content)

            # Reserved names are gateway policy, not a global prohibition on terminal skills.
            async with open_runtime(
                workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                agent_catalog=catalog,
            ) as runtime:
                selected = await metadata(runtime, "terminal-selected")
                self.assertEqual(selected[0]["path"], str(user_file))
                self.assertEqual(selected[0]["description"], "User-selected policy")

    async def test_listing_shows_valid_and_broken_skills_with_users(self):
        empty = (await self.client.get("/skills")).json()
        self.assertEqual(empty, {"skills": [], "as_of_seq": self.store.last_seq(), "default_agent_id": "main"})
        self.skill("valid", self.body("valid", "中文说明"))
        self.skill("missing-field", "---\nname: missing-field\n---\n# 说明\n")
        self.skill("mismatched", self.body("other"))
        self.skill("bad_name", self.body("bad_name"))
        self.skill("bad-yaml", "---\nname: [\ndescription: x\n---\n")
        self.skill("bad name ", self.body("bad name "))
        (self.skills / "missing-file").mkdir()
        (self.skills / "not-a-directory").write_text("x", encoding="utf-8")
        self.select("missing-field", display_name="修复者")
        listed = (await self.client.get("/skills")).json()
        entries = {item["name"]: item for item in listed["skills"]}
        self.assertEqual(set(entries), {
            "valid", "missing-field", "mismatched", "bad_name", "bad-yaml", "missing-file", "bad name ",
        })
        self.assertEqual(entries["valid"], {
            "name": "valid", "description": "中文说明", "used_by": [], "status": "ok", "error": None,
        })
        self.assertEqual(entries["missing-field"]["used_by"], [{"id": "main", "name": "修复者"}])
        for name in ("missing-field", "mismatched", "bad_name", "bad-yaml", "missing-file", "bad name "):
            self.assertEqual(entries[name]["status"], "error")
            self.assertTrue(entries[name]["error"], name)
        self.assertIn("说明", entries["missing-field"]["error"])
        self.assertIn("名称", entries["mismatched"]["error"])
        self.assertIn("名称", entries["bad_name"]["error"])
        self.assertEqual(listed["as_of_seq"], self.store.last_seq())
        denied = await self.client.get("/skills", headers={"Authorization": "Bearer wrong"})
        self.assertEqual((denied.status_code, denied.json()["error"]["code"]), (401, "unauthorized"))
        self.assertEqual((await self.client.post("/skills")).status_code, 405)

    async def test_os_read_error_is_actionable_without_system_diagnostic(self):
        self.skill("unreadable", self.body("unreadable"))
        with patch("wandrun.gateway.skills.os.open", side_effect=PermissionError(13, "Permission denied")):
            detail = inspect_skill(self.skills, "unreadable")
        self.assertEqual(detail["status"], "error")
        self.assertIn("权限", detail["error"])
        self.assertNotIn("Permission denied", detail["error"])

    async def test_head_is_read_only_for_collection_detail_and_missing_skill(self):
        content = self.body("head-victim")
        directory = self.skill("head-victim", content)
        before = self.store.last_seq()
        for path, status in (("/skills", 200), ("/skills/head-victim", 200), ("/skills/missing", 404)):
            with self.subTest(path=path):
                response = await self.client.head(path)
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.content, b"")
                self.assertTrue(directory.is_dir())
                self.assertEqual((directory / "SKILL.md").read_text(encoding="utf-8"), content)
                self.assertEqual(self.store.last_seq(), before)

    async def test_deep_yaml_isolated_to_broken_entry_and_can_be_repaired(self):
        self.skill("valid", self.body("valid"))
        nested = "---\nname: nested\ndescription: nested skill\nextra: " + "[" * 600 + "0" + "]" * 600 + "\n---\nBody\n"
        directory = self.skill("nested", nested)
        before = self.store.last_seq()
        response = await self.client.get("/skills")
        self.assertEqual(response.status_code, 200)
        entries = {item["name"]: item for item in response.json()["skills"]}
        self.assertEqual(entries["valid"]["status"], "ok")
        self.assertEqual(entries["nested"]["status"], "error")
        self.assertIn("嵌套过深", entries["nested"]["error"])
        response = await self.client.get("/skills/nested")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["error"], entries["nested"]["error"])
        self.assertEqual(response.json()["content"], nested)
        self.assertEqual(self.store.last_seq(), before)
        (directory / "SKILL.md").write_text(self.body("nested"), encoding="utf-8")
        repaired = (await self.client.get("/skills/nested")).json()
        self.assertEqual((repaired["status"], repaired["error"]), ("ok", None))

    async def test_detail_content_mtime_invalid_head_and_missing(self):
        valid = self.skill("valid", self.body("valid")) / "SKILL.md"
        bad_content = "---\nname: broken\n---\n# 请修复此处\n"
        self.skill("broken", bad_content)
        self.skill("bad name ", self.body("bad name "))
        self.skill("win\\name", self.body("win\\name"))
        (self.skills / "empty").mkdir()
        response = await self.client.get("/skills/valid")
        self.assertEqual(response.status_code, 200)
        detail = response.json()
        self.assertEqual(detail["path"], ".wandrun/skills/valid")
        self.assertEqual(detail["content"], valid.read_text(encoding="utf-8"))
        self.assertAlmostEqual(detail["mtime"], valid.stat().st_mtime)
        self.assertEqual((detail["status"], detail["error"]), ("ok", None))
        broken = (await self.client.get("/skills/broken")).json()
        self.assertEqual(broken["status"], "error")
        self.assertIn("说明", broken["error"])
        self.assertEqual(broken["content"], bad_content)
        self.assertIsInstance(broken["mtime"], (int, float))
        missing = (await self.client.get("/skills/empty")).json()
        self.assertEqual((missing["status"], missing["content"], missing["mtime"]), ("error", None, None))
        self.assertEqual((await self.client.get("/skills/no-such-skill")).status_code, 404)
        invalid = await self.client.get("/skills/bad%20name%20")
        self.assertEqual(invalid.status_code, 200)
        self.assertEqual(invalid.json()["status"], "error")
        self.assertEqual(invalid.json()["content"], self.body("bad name "))
        self.assertEqual((await self.client.delete("/skills/bad%20name%20")).status_code, 200)
        self.assertEqual((await self.client.get("/skills/bad%20name%20")).status_code, 404)
        backslash = await self.client.get("/skills/win%5Cname")
        self.assertEqual((backslash.status_code, backslash.json()["status"]), (200, "error"))
        self.assertEqual((await self.client.delete("/skills/win%5Cname")).status_code, 200)
        with self.assertRaises(InvalidSkill):
            self.gateway.get_skill("../outside")
        with self.assertRaises(InvalidSkill):
            await self.gateway.delete_skill("../outside")
        self.assertEqual((await self.client.patch("/skills/valid")).status_code, 405)

    async def test_non_utf8_non_string_fields_fifo_and_one_mib_limit(self):
        self.skill("nonutf8", self.body("nonutf8"))
        (self.skills / "nonutf8" / "SKILL.md").write_bytes(b"\xff")
        for name, content in {
            "number-name": "---\nname: 42\ndescription: text\n---\n",
            "null-description": "---\nname: null-description\ndescription: null\n---\n",
            "long-description": self.body("long-description", "a" * 1025),
        }.items():
            self.skill(name, content)
        self.skill("limit", self.body("limit"))
        exact = self.body("limit", suffix="")
        (self.skills / "limit" / "SKILL.md").write_bytes(
            exact.encode() + b"a" * (MAX_SKILL_CONTENT_BYTES - len(exact.encode()))
        )
        self.skill("too-large", self.body("too-large"))
        (self.skills / "too-large" / "SKILL.md").write_bytes(b"a" * (MAX_SKILL_CONTENT_BYTES + 1))
        fifo = self.skills / "fifo"
        fifo.mkdir()
        os.mkfifo(fifo / "SKILL.md")
        listed = {item["name"]: item for item in (await self.client.get("/skills")).json()["skills"]}
        self.assertEqual(listed["limit"]["status"], "ok")
        self.assertEqual(listed["nonutf8"]["error"], "SKILL.md 不是 UTF-8 文本")
        self.assertIn("1 MiB", listed["too-large"]["error"])
        self.assertIn("普通文件", listed["fifo"]["error"])
        for name in ("number-name", "null-description", "long-description"):
            self.assertEqual(listed[name]["status"], "error")
        exact_detail = (await self.client.get("/skills/limit")).json()
        self.assertEqual(len(exact_detail["content"].encode()), MAX_SKILL_CONTENT_BYTES)
        for name in ("nonutf8", "too-large", "fifo"):
            detail = (await self.client.get(f"/skills/{name}")).json()
            self.assertIsNone(detail["content"])
            self.assertIsNone(detail["mtime"])

    async def test_links_and_root_replacement_never_expose_outside_contents(self):
        outside = self.workspace / "outside"
        outside.mkdir()
        (outside / "SKILL.md").write_text(self.body("linked", "机密描述"), encoding="utf-8")
        (outside / "sentinel").write_text("must survive", encoding="utf-8")
        (self.skills / "linked").symlink_to(outside, target_is_directory=True)
        file_link = self.skills / "file-link"
        file_link.mkdir()
        (file_link / "SKILL.md").symlink_to(outside / "SKILL.md")
        internal = self.skill("internal", self.body("internal"))
        (internal / "nested-link").symlink_to(outside, target_is_directory=True)
        entries = {item["name"]: item for item in (await self.client.get("/skills")).json()["skills"]}
        self.assertEqual(entries["internal"]["status"], "ok")
        for name in ("linked", "file-link"):
            self.assertEqual(entries[name]["status"], "error")
            self.assertNotIn("机密描述", str(entries[name]))
            self.assertIsNone((await self.client.get(f"/skills/{name}")).json()["content"])
        self.assertEqual((await self.client.delete("/skills/linked")).status_code, 200)
        self.assertFalse((self.skills / "linked").is_symlink())
        self.assertTrue((outside / "sentinel").exists())
        self.assertEqual((await self.client.delete("/skills/internal")).status_code, 200)
        self.assertFalse(internal.exists())
        self.assertEqual((outside / "sentinel").read_text(), "must survive")
        moved = self.workspace / "former-skills"
        self.skills.rename(moved)
        self.skills.symlink_to(outside, target_is_directory=True)
        self.assertEqual((await self.client.get("/skills")).json()["skills"], [])
        blocked = await self.client.delete("/skills/linked")
        self.assertEqual(blocked.status_code, 409)
        self.assertTrue((outside / "sentinel").exists())
        self.skills.unlink()
        previous = self.workspace / "former-wandrun"
        self.skills.parent.rename(previous)
        self.skills.parent.symlink_to(outside, target_is_directory=True)
        (outside / "skills").mkdir()
        (outside / "skills" / "protected").mkdir()
        (outside / "skills" / "protected" / "sentinel").write_text("safe", encoding="utf-8")
        self.assertEqual((await self.client.get("/skills")).json()["skills"], [])
        self.assertEqual((await self.client.delete("/skills/protected")).status_code, 409)
        self.assertEqual((outside / "skills" / "protected" / "sentinel").read_text(), "safe")

    async def test_referenced_invalid_skill_blocks_delete_then_unblocks_and_emits_once(self):
        self.skill("broken", "---\nname: broken\n---\n")
        self.select("broken", display_name="主 Agent")
        self.select("broken", user="other", display_name="助手")
        detail = (await self.client.get("/skills/broken")).json()
        self.assertEqual(detail["status"], "error")
        self.assertEqual(detail["used_by"], [{"id": "main", "name": "主 Agent"}, {"id": "other", "name": "助手"}])
        before = self.store.last_seq()
        denied = await self.client.delete("/skills/broken")
        self.assertEqual(denied.status_code, 409)
        self.assertEqual(denied.json()["error"]["details"], {"used_by": detail["used_by"]})
        self.assertEqual(self.store.last_seq(), before)
        for user in ("main", "other"):
            current = self.store.agent(user)
            definition = self.store.agent_catalog().agents[user]
            self.store.update_agent(user, replace(definition, skills=()), current["name"], current["avatar"])
        deleted = await self.client.delete("/skills/broken")
        self.assertEqual(deleted.status_code, 200)
        event = deleted.json()["event"]
        self.assertEqual((event["type"], event["data"]), (
            "resource.changed", {"kind": "skill", "id": "broken", "op": "deleted"},
        ))
        self.assertEqual(self.store.after(before)[-1].to_dict(), event)
        self.assertEqual((await self.client.get("/skills/broken")).status_code, 404)
        self.assertEqual((await self.client.delete("/skills/broken")).json(), {"event": None})

    async def test_concurrent_deletes_emit_one_event_and_root_swap_does_not_follow_link(self):
        self.skill("delete-me", self.body("delete-me"))
        before = self.store.last_seq()
        results = await asyncio.gather(*(self.client.delete("/skills/delete-me") for _ in range(12)))
        self.assertEqual([result.status_code for result in results], [200] * 12)
        events = [result.json()["event"] for result in results]
        self.assertEqual(sum(event is not None for event in events), 1)
        self.assertEqual(len(self.store.after(before)), 1)
        self.skill("swap", self.body("swap"))
        outside = self.workspace / "outside"
        outside.mkdir()
        (outside / "swap").mkdir()
        (outside / "swap" / "sentinel").write_text("safe", encoding="utf-8")
        old_root = self.workspace / "old-root"
        from wandrun.gateway.skills import _open_root
        calls = 0

        @contextmanager
        def swapped_root(root):
            nonlocal calls
            with _open_root(root) as fd:
                calls += 1
                if calls == 1:
                    self.skills.rename(old_root)
                    self.skills.symlink_to(outside, target_is_directory=True)
                yield fd

        with patch("wandrun.gateway.skills._open_root", swapped_root):
            response = await self.client.delete("/skills/swap")
        self.assertEqual(response.status_code, 409)
        self.assertTrue((old_root / "swap" / "SKILL.md").exists())
        self.assertEqual((outside / "swap" / "sentinel").read_text(), "safe")
