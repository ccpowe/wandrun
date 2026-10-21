"""小型记忆的内容边界、并发保存与失败原子性。"""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from wandrun.runtime.memory import (
    InvalidMemory, MemoryConflict, MemoryReadError, MemoryRetired, MemoryStore,
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

    def test_normalized_content_version_and_noop_do_not_publish_changes(self):
        empty = self.store.read("main")
        self.assertEqual(empty.content, "")
        self.assertIsNone(empty.updated_at)
        self.assertFalse(self.root.exists())
        saved = self.save("中文\r\nsecond\rlast")
        self.assertEqual(saved.content, "中文\nsecond\nlast")
        self.assertEqual((self.root / "main.md").read_bytes(), "中文\nsecond\nlast".encode())
        self.assertEqual(self.store.save("main", "中文\r\nsecond\nlast", saved.version), saved)
        self.assertEqual([change.snapshot for change in self.changes], [saved])
        # 重开存储仍由正文而非 mtime 或进程内计数得出版本。
        self.assertEqual(MemoryStore(self.root).read("main"), saved)

    def test_unicode_limit_after_newline_normalization_and_rejected_save(self):
        text = "\U0001f600" * 999 + "\r\n"
        saved = self.save(text)
        self.assertEqual(len(saved.content), 1000)
        with self.assertRaises(InvalidMemory):
            self.store.save("main", saved.content + "中", saved.version)
        with self.assertRaises(InvalidMemory):
            self.store.save("main", "\ud800", saved.version)
        self.assertEqual(self.store.read("main"), saved)
        self.assertEqual(len(self.changes), 1)

    def test_partial_edit_preserves_others_and_rejects_ambiguous_or_missing_target(self):
        original = self.save("- 使用 npm\n- 回答中文\n- 使用 npm\n")
        for target in ("不存在", "npm", ""):
            with self.subTest(target=target), self.assertRaises(InvalidMemory):
                self.store.edit("main", target, "pnpm", original.version)
            self.assertEqual(self.store.read("main"), original)
        updated = self.store.edit("main", "npm", "pnpm", original.version, replace_all=True, task_id="child")
        self.assertEqual(updated.content, "- 使用 pnpm\n- 回答中文\n- 使用 pnpm\n")
        self.assertEqual(self.changes[-1].task_id, "child")
        with self.assertRaises(InvalidMemory):
            self.store.edit("main", "中文", "中" * 1000, updated.version)
        self.assertEqual(self.store.read("main"), updated)

    def test_stale_write_and_edit_reject_even_when_target_text_survives(self):
        old = self.save("- 使用 npm\n")
        newer = self.store.save("main", old.content + "- 用户补充\n", old.version)
        with self.assertRaises(MemoryConflict) as conflict:
            self.store.edit("main", "npm", "pnpm", old.version)
        self.assertEqual(conflict.exception.current, newer)
        with self.assertRaises(MemoryConflict):
            self.store.save("main", newer.content, old.version)
        self.assertEqual(self.store.read("main"), newer)

    def test_competing_writers_only_one_can_commit_same_baseline(self):
        base = self.save("原文")
        def save(text):
            try:
                return self.store.save("main", text, base.version).content
            except MemoryConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ("改动甲", "改动乙")))
        winner = next(result for result in results if result is not None)
        self.assertEqual(results.count(None), 1)
        self.assertEqual(self.store.read("main").content, winner)
        self.assertEqual(len(self.changes), 2)

    def test_external_edits_detected_without_fabricating_modification_events(self):
        saved = self.save("旧正文")
        path = self.root / "main.md"
        path.write_text("外部更新", encoding="utf-8")
        changed = self.store.read("main")
        self.assertNotEqual(changed.version, saved.version)
        self.assertEqual(changed.content, "外部更新")
        path.unlink()
        self.assertEqual(self.store.read("main").content, "")
        self.assertEqual(len(self.changes), 1)

    def test_invalid_existing_content_is_not_empty_or_silently_repaired(self):
        self.root.mkdir()
        path = self.root / "main.md"
        for raw in (b"\xff", ("中" * 1001).encode(), b"x" * 8000):
            with self.subTest(raw_length=len(raw)):
                path.write_bytes(raw)
                with self.assertRaises(MemoryReadError):
                    self.store.read("main")
                with self.assertRaises(MemoryReadError):
                    self.store.save("main", "替换", "invalid")
                self.assertEqual(path.read_bytes(), raw)
        path.unlink()
        outside = Path(self.directory.name) / "outside.md"
        outside.write_text("不可访问", encoding="utf-8")
        path.symlink_to(outside)
        with self.assertRaises(OSError):
            self.store.read("main")
        with self.assertRaises(InvalidMemory):
            self.store.read("../outside")

    def test_failed_replace_keeps_old_file_and_removes_temporary(self):
        saved = self.save("保留")
        with patch("wandrun.runtime.memory.os.replace", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                self.store.save("main", "新正文", saved.version)
        self.assertEqual(self.store.read("main"), saved)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["main.md"])
        self.assertEqual(len(self.changes), 1)

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

    def test_clear_and_retryable_retired_deletion_are_agent_scoped(self):
        saved = self.save("main memory")
        other = self.save("other memory", agent="other")
        cleared = self.store.save("main", "", saved.version)
        self.assertEqual(cleared.content, "")
        self.store.retire("main")
        with self.assertRaises(MemoryRetired):
            self.store.save("main", "late", cleared.version)
        with self.assertRaises(MemoryRetired):
            self.store.read("main")
        self.store.delete("main")
        self.store.delete("main")
        self.assertFalse((self.root / "main.md").exists())
        self.assertEqual(self.store.read("other"), other)
        # 重启后删除意图由网关恢复，重复 unlink 仍安全。
        restarted = MemoryStore(self.root)
        restarted.delete("main")
        with self.assertRaises(MemoryRetired):
            restarted.save("main", "late", cleared.version)


if __name__ == "__main__":
    unittest.main()
