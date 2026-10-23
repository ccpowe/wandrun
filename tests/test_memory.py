"""共享画像、工作记忆、详情发布和撤销的可观察契约。"""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from wandrun.runtime.memory import (
    InvalidMemory, MEMORY_DETAIL_LIMIT, MemoryCleanupError, MemoryConflict,
    MemoryReadError, MemoryRetired, MemoryStore,
)


class MemoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "memory"
        self.changes = []
        self.store = MemoryStore(self.root, on_change=self.changes.append)

    def save(self, text, *, agent="main"):
        return self.store.save(agent, text, self.store.read(agent).version)

    def manifest(self, agent="main"):
        return self.root / ("profile" if agent is None else f"agents/{agent}") / "current.json"

    def detail(self, text="当前结论，适用范围与用户证据", *, agent="main", slug="style"):
        base = self.store.read(agent)
        logical = f"/.wandrun/memory/{base.scope}/details/{slug}.md"
        return self.store.put_detail(agent, slug, text, base.version,
                                     index_content=f"- [工作方式]({logical})")

    def test_scopes_normalization_noop_and_reopen(self):
        profile_empty = self.store.read(None)
        self.assertEqual((profile_empty.scope, profile_empty.content, profile_empty.revision), ("profile", "", 0))
        self.assertFalse(self.root.exists())
        profile = self.save("用户背景\r\n偏好\r结论", agent=None)
        work = self.save("本 Agent 反馈")
        self.assertEqual(profile.content, "用户背景\n偏好\n结论")
        self.assertEqual(work.content, "本 Agent 反馈")
        self.assertEqual(self.store.save(None, profile.content, profile.version), profile)
        self.assertEqual(self.manifest(None).parent.name, "profile")
        self.assertEqual(json.loads(self.manifest().read_text())["content"], work.content)
        reopened = MemoryStore(self.root)
        self.assertEqual(reopened.read(None), profile)
        self.assertEqual(reopened.read("main"), work)
        self.assertEqual([change.agent_id for change in self.changes], [None, "main"])

    def test_unicode_limits_each_scope_and_normalization(self):
        for agent in (None, "main"):
            with self.subTest(agent=agent):
                saved = self.save("😀" * 999 + "\r\n", agent=agent)
                self.assertEqual(len(saved.content), 1000)
                for invalid in (saved.content + "中", "\ud800"):
                    with self.assertRaises(InvalidMemory):
                        self.store.save(agent, invalid, saved.version)
                self.assertEqual(self.store.read(agent), saved)

    def test_partial_edit_preserves_others_and_rejects_ambiguous_missing_target(self):
        original = self.save("- 使用 npm\n- 回答中文\n- 使用 npm\n")
        for target in ("不存在", "npm", ""):
            with self.subTest(target=target), self.assertRaises(InvalidMemory):
                self.store.edit("main", target, "pnpm", original.version)
            self.assertEqual(self.store.read("main"), original)
        updated = self.store.edit("main", "npm", "pnpm", original.version, replace_all=True, task_id="child")
        self.assertEqual(updated.content, "- 使用 pnpm\n- 回答中文\n- 使用 pnpm\n")
        self.assertEqual(self.changes[-1].task_id, "child")

    def test_aba_and_clear_never_restore_old_cas(self):
        initial = self.store.read(None)
        a = self.save("A", agent=None)
        self.store.save(None, "B", a.version)
        again = self.save("A", agent=None)
        self.assertNotEqual(a.version, again.version)
        cleared = self.store.save(None, "", again.version)
        self.assertNotEqual(initial.version, cleared.version)
        self.assertEqual(cleared.revision, 4)
        for stale in (a, initial):
            with self.assertRaises(MemoryConflict):
                self.store.save(None, "resurrect", stale.version)

    def test_competing_roots_and_app_only_one_can_commit(self):
        base = self.save("原文", agent=None)
        def save(text):
            try:
                return self.store.save(None, text, base.version).content
            except MemoryConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ("根任务甲", "App")))
        winner = next(result for result in results if result is not None)
        self.assertEqual(results.count(None), 1)
        self.assertEqual(self.store.read(None).content, winner)

    def test_authorization_rechecked_before_every_mutation_including_noop(self):
        current = self.store.read(None)
        def deny():
            raise PermissionError("旧执行已撤权")
        operations = (
            lambda: self.store.save(None, "", current.version, authorize=deny),
            lambda: self.store.edit(None, "x", "y", current.version, authorize=deny),
            lambda: self.store.prepare_detail(None, "a", "x", current.version, owner="old", authorize=deny),
            lambda: self.store.put_detail(None, "a", "x", current.version, authorize=deny),
            lambda: self.store.delete_detail(None, "a", "", current.version, authorize=deny),
        )
        for operation in operations:
            with self.assertRaises(PermissionError):
                operation()
        self.assertEqual(self.store.read(None), current)
        self.assertFalse(self.root.exists())

    def test_staging_does_not_publish_and_only_preparer_can_publish(self):
        base = self.store.read(None)
        prepared = self.store.prepare_detail(None, "learning", "证据\r\n例外", base.version, owner="root:1")
        self.assertEqual(prepared.content, "证据\n例外")
        self.assertEqual(self.store.read(None), base)
        self.assertEqual(self.changes, [])
        with self.assertRaises(InvalidMemory):
            self.store.read_detail(None, "learning", path=prepared.path)
        content = f"学习方式：[{prepared.path}]({prepared.path})"
        with self.assertRaises(InvalidMemory):
            self.store.save(None, content, base.version, owner="another:1")
        published = self.store.save(None, content, base.version, owner="root:1")
        self.assertEqual(self.store.read_detail(None, "learning").content, "证据\n例外")
        self.assertEqual(published.details["learning"]["path"], prepared.path)
        self.assertEqual(len(self.changes), 1)

    def test_detail_byte_limit_and_invalid_utf8(self):
        base = self.store.read("main")
        content = "中" * (MEMORY_DETAIL_LIMIT // 3) + "x"
        self.assertEqual(len(content.encode()), MEMORY_DETAIL_LIMIT)
        prepared = self.store.prepare_detail("main", "large", content, base.version, owner="task:1")
        self.assertEqual(len(prepared.content.encode()), MEMORY_DETAIL_LIMIT)
        for invalid in (content + "x", "\ud800"):
            with self.assertRaises(InvalidMemory):
                self.store.prepare_detail("main", "large", invalid, base.version, owner="task:1")

    def test_api_create_requires_index_and_uses_single_publication(self):
        base = self.store.read("main")
        with self.assertRaises(InvalidMemory):
            self.store.put_detail("main", "new", "details", base.version)
        self.assertEqual(self.store.read("main"), base)
        published = self.detail()
        self.assertEqual(published.revision, 1)
        self.assertEqual(len(self.changes), 1)
        self.assertEqual(self.store.read_detail("main", "style").version, published.version)
        self.assertEqual(self.store.put_detail("main", "style", "当前结论，适用范围与用户证据", published.version), published)
        self.assertEqual(len(self.changes), 1)

    def test_detail_update_is_copy_on_write_and_revokes_old_path(self):
        old = self.detail()
        path = old.details["style"]["path"]
        updated = self.store.put_detail("main", "style", "新的适用范围", old.version)
        self.assertNotEqual(updated.version, old.version)
        self.assertNotEqual(updated.details["style"]["path"], path)
        with self.assertRaises(InvalidMemory):
            self.store.read_detail("main", "style", path=path)
        self.assertEqual(self.store.read_detail("main", "style").content, "新的适用范围")
        self.assertEqual(len(self.changes), 2)
        files = list(self.manifest().parent.glob("details/style/*.md"))
        self.assertEqual([file.stem for file in files], [updated.details["style"]["sha256"]])

    def test_unprepared_cross_scope_and_dangling_references_rejected(self):
        prepared = self.store.prepare_detail(None, "item", "evidence", self.store.read(None).version, owner="root")
        for content in (
            prepared.path,
            "/.wandrun/memory/work/details/item/" + "a" * 64 + ".md",
            "/.wandrun/memory/work/details/../../profile.md",
            "/.wandrun/memory/work/details/item.md",
            "[详情](/etc/passwd)",
            "[详情](relative.md)",
            "[详情][outside]\n\n[outside]: /host/private.md",
        ):
            with self.subTest(content=content), self.assertRaises(InvalidMemory):
                self.store.save("main", content, self.store.read("main").version, owner="root")
        with self.assertRaises(InvalidMemory):
            self.store.save(None, prepared.path, self.store.read(None).version)

    def test_conflict_cancellation_and_delete_revoke_prepared_publication(self):
        for revoke in ("conflict", "cancel", "clear"):
            with self.subTest(revoke=revoke):
                base = self.store.read("main")
                prepared = self.store.prepare_detail("main", "item", revoke, base.version, owner="task")
                if revoke == "cancel":
                    self.store.discard_prepared("task")
                else:
                    self.store.save("main", revoke, base.version)
                    if revoke == "conflict":
                        with self.assertRaises(MemoryConflict):
                            self.store.save("main", prepared.path, base.version, owner="task")
                    else:
                        self.save("")
                latest = self.store.read("main")
                with self.assertRaises(InvalidMemory):
                    self.store.save("main", prepared.path, latest.version, owner="task")

    def test_delete_detail_requires_removed_index_and_is_idempotent_at_current_version(self):
        saved = self.detail(agent=None)
        with self.assertRaises(InvalidMemory):
            self.store.delete_detail(None, "style", saved.content, saved.version)
        deleted = self.store.delete_detail(None, "style", "用户背景", saved.version)
        self.assertEqual(deleted.details, {})
        self.assertEqual(deleted.content, "用户背景")
        self.assertEqual(self.store.delete_detail(None, "style", deleted.content, deleted.version), deleted)
        with self.assertRaises(InvalidMemory):
            self.store.read_detail(None, "style")
        with self.assertRaises(MemoryConflict):
            self.store.delete_detail(None, "style", "", saved.version)
        with self.assertRaises(InvalidMemory):
            self.store.delete_detail(None, "style", "无关改动", deleted.version)

    def test_startup_removes_orphan_preparation_but_keeps_active_details(self):
        active = self.detail()
        self.store.prepare_detail("main", "orphan", "not published", active.version, owner="task")
        temporary = self.manifest().parent / ".memory-crashed"
        temporary.write_text("unpublished")
        reopened = MemoryStore(self.root)
        self.assertEqual(reopened.read("main"), active)
        self.assertFalse((self.manifest().parent / "details/orphan").exists())
        self.assertFalse(temporary.exists())
        self.assertEqual(reopened.read_detail("main", "style").content, "当前结论，适用范围与用户证据")

    def test_detail_failure_before_manifest_switch_keeps_old_index(self):
        saved = self.detail()
        with patch.object(self.store, "_atomic", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.store.put_detail("main", "style", "new", saved.version)
        self.assertEqual(self.store.read("main"), saved)
        self.assertEqual(len(self.changes), 1)

    def test_manifest_failure_keeps_old_index_and_restart_cleans_orphan(self):
        base = self.store.read("main")
        prepared = self.store.prepare_detail("main", "item", "prepared", base.version, owner="task")
        with patch("wandrun.runtime.memory.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.store.save("main", prepared.path, base.version, owner="task")
        self.assertEqual(self.store.read("main"), base)
        reopened = MemoryStore(self.root)
        self.assertEqual(reopened.read("main"), base)
        self.assertFalse((self.manifest().parent / "details/item").exists())
        self.assertEqual(list(self.manifest().parent.glob(".memory-*")), [])

    def test_cleanup_failure_reports_committed_removal_and_restart_finishes(self):
        saved = self.detail()
        old_path = saved.details["style"]["path"]
        with patch.object(self.store, "_cleanup", side_effect=OSError("unlink denied")):
            with self.assertRaisesRegex(MemoryCleanupError, "已发布"):
                self.store.save("main", "", saved.version)
        self.assertEqual(self.store.read("main").details, {})
        with self.assertRaises(InvalidMemory):
            self.store.read_detail("main", "style", path=old_path)
        MemoryStore(self.root)
        self.assertFalse((self.manifest().parent / "details/style").exists())
        self.assertEqual(len(self.changes), 2)

    def test_cleanup_retry_does_not_lose_cancelled_owner_or_report_noop_early(self):
        base = self.store.read("main")
        prepared = self.store.prepare_detail("main", "cancelled", "not active", base.version, owner="task:1")
        with patch.object(self.store, "_cleanup", side_effect=OSError("unlink denied")):
            with self.assertRaises(OSError):
                self.store.discard_prepared("task:1")
        with self.assertRaises(InvalidMemory):
            self.store.save("main", prepared.path, base.version, owner="task:1")
        self.store.discard_prepared("task:1")
        self.assertFalse((self.manifest().parent / "details/cancelled").exists())
        active = self.detail()
        with patch.object(self.store, "_cleanup", side_effect=OSError("unlink denied")):
            with self.assertRaises(MemoryCleanupError):
                self.store.save("main", "", active.version)
            cleared = self.store.read("main")
            with self.assertRaises(MemoryCleanupError):
                self.store.save("main", "", cleared.version)
        self.assertEqual(self.store.save("main", "", cleared.version), cleared)
        self.assertFalse((self.manifest().parent / "details/style").exists())
        self.assertEqual(len(self.changes), 2)

    def test_callback_failure_reports_partial_success_and_does_not_repeat(self):
        saved = self.save("原文")
        def fail(change):
            raise RuntimeError("event storage failed")
        self.store.on_change = fail
        with self.assertRaisesRegex(RuntimeError, "event storage failed"):
            self.store.save("main", "已保存", saved.version)
        committed = self.store.read("main")
        self.assertEqual(committed.content, "已保存")
        self.assertEqual(self.store.save("main", committed.content, committed.version), committed)

    def test_corrupt_manifest_missing_detail_and_wrong_fingerprint_fail_closed(self):
        saved = self.detail()
        manifest = self.manifest()
        original = manifest.read_bytes()
        for raw in (b"\xff", b"{}", b"null", b"x" * 40000):
            manifest.write_bytes(raw)
            with self.assertRaises(MemoryReadError):
                self.store.read("main")
        manifest.write_bytes(original)
        file = self.manifest().parent / "details/style" / (saved.details["style"]["sha256"] + ".md")
        file.write_text("tampered")
        with self.assertRaises(MemoryReadError):
            self.store.read("main")
        file.unlink()
        with self.assertRaises(MemoryReadError):
            MemoryStore(self.root)

    def test_symlink_files_and_directories_are_not_followed(self):
        self.save("保存")
        outside = Path(self.directory.name) / "outside"
        outside.mkdir()
        manifest = self.manifest()
        manifest.unlink()
        (outside / "current.json").write_text('{"content":"","details":{},"revision":1}')
        manifest.symlink_to(outside / "current.json")
        with self.assertRaises(OSError):
            self.store.read("main")
        manifest.unlink()
        manifest.parent.rmdir()
        manifest.parent.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(MemoryReadError):
            self.store.read("main")
        with self.assertRaises(InvalidMemory):
            self.store.read("../outside")

    def test_partial_agent_deletion_does_not_leave_a_dangling_manifest_on_restart(self):
        profile = self.detail(agent=None)
        self.detail()
        def interrupted_delete(_directory):
            for path in self.manifest().parent.glob("details/*/*.md"):
                path.unlink()
            raise OSError("interrupted recursive deletion")
        with patch("wandrun.runtime.memory.shutil.rmtree", side_effect=interrupted_delete):
            with self.assertRaises(OSError):
                self.store.delete("main")
        reopened = MemoryStore(self.root)
        reopened.delete("main")
        self.assertEqual(reopened.read(None), profile)
        self.assertFalse(self.manifest().parent.exists())

    def test_markdown_escaped_reference_is_rejected_without_revoking_active_detail(self):
        saved = self.detail()
        path = saved.details["style"]["path"]
        escaped = path.replace("/.wandrun", "/\\.wandrun")
        with self.assertRaises(InvalidMemory):
            self.store.save("main", f"[详情]({escaped})", saved.version)
        self.assertEqual(self.store.read("main"), saved)
        self.assertEqual(self.store.read_detail("main", "style").content, "当前结论，适用范围与用户证据")
        profile = self.store.read(None)
        with self.assertRaises(InvalidMemory):
            self.store.save(None, f"[越界]({escaped})", profile.version)
        missing = escaped.replace(saved.details["style"]["sha256"], "a" * 64)
        with self.assertRaises(InvalidMemory):
            self.store.save("main", f"[悬空]({missing})", saved.version)

    def test_same_value_deletion_revokes_unpublished_preparations(self):
        for clear_index in (False, True):
            with self.subTest(clear_index=clear_index):
                base = self.store.read(None)
                prepared = self.store.prepare_detail(None, "item", "not published", base.version, owner="old:1")
                if clear_index:
                    result = self.store.save(None, "", base.version)
                else:
                    result = self.store.delete_detail(None, "item", "", base.version)
                self.assertEqual(result, base)
                self.assertEqual(self.changes, [])
                with self.assertRaises(InvalidMemory):
                    self.store.save(None, f"[旧暂存]({prepared.path})", base.version, owner="old:1")
                self.assertFalse((self.manifest(None).parent / "details/item").exists())

    def test_agent_deletion_retains_profile_and_other_work(self):
        profile = self.detail(agent=None)
        work = self.detail()
        other = self.save("另一 Agent", agent="other")
        self.store.retire("main")
        with self.assertRaises(MemoryRetired):
            self.store.read("main")
        with self.assertRaises(MemoryRetired):
            self.store.save("main", "late", work.version)
        self.store.delete("main")
        self.store.delete("main")
        with self.assertRaises(InvalidMemory):
            self.store.delete(None)
        self.assertFalse(self.manifest().parent.exists())
        self.assertEqual(self.store.read(None), profile)
        self.assertEqual(self.store.read("other"), other)
        self.assertEqual(self.store.read_detail(None, "style").content, "当前结论，适用范围与用户证据")


if __name__ == "__main__":
    unittest.main()
