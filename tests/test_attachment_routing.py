"""Trusted recipient routing across distinct production SSH backends and Local files."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_file_transfer import remote_backend
from wandrun.integrations import file_transfer
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.runtime.communication.messages import AgentOutput, SendMessage
from wandrun.runtime.communication.workers import WorkerManager
from wandrun.runtime.execution.files import TaskFiles


class AttachmentRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.local = self.base / "gateway"
        self.local.mkdir()
        self.a_root, self.b_root = self.base / "machine-a", self.base / "machine-b"
        self.a = await self.enterAsyncContext(remote_backend(self.a_root))
        self.b = await self.enterAsyncContext(remote_backend(self.b_root))
        self.seen = {}

        async def run(prompts, task_id):
            self.seen.setdefault(task_id, []).extend(prompts)
            return AgentOutput(messages=[], next="wait")

        self.manager = WorkerManager(
            run, default_agent="a",
            agent_workers={"a": ("b", "local", "alias"), "b": ("a", "local"),
                           "local": ("a", "b"), "alias": ()},
            on_human=lambda *_: None,
        )
        self.addAsyncCleanup(self.manager.close)
        self.files = TaskFiles(
            self.local, self.manager,
            {"local": ("local", str(self.local)), "a": ("cloud-a", str(self.a_root)),
             "b": ("cloud-b", str(self.b_root)), "alias": ("alias-of-a", str(self.a_root))},
            conversation_workdirs=True,
            remote_backends={"a": self.a, "b": self.b, "alias": self.a},
        )
        self.manager._attachment_resolver = self.files.resolve_attachments
        self.manager._attachment_preflight = self.files.prepare_attachments
        for role in ("local", "a", "b", "alias"):
            self.manager.start("begin", role + "-root", agent_name=role)
            await self.manager.wait(role + "-root")
            await self.files.prepare_file_output(role + "-root")

    async def deliver(self, sender, target, task=None, paths=None):
        output = AgentOutput(messages=[SendMessage(
            to=target, task_id=task, message="Read the real file", attachments=paths or ["report.txt"],
        )], next="wait")
        prepared = await self.manager.prepare_attachments(output, sender)
        receipt, = self.manager.dispatch(output, sender, prepared=prepared)
        if receipt["accepted"] and target != "human":
            await self.manager.wait(receipt["task_id"])
        return receipt

    async def test_local_remote_and_different_remote_backends_deliver_identical_readable_bytes(self):
        for sender, target in (("a", "local"), ("local", "a"), ("a", "b"), ("b", "a")):
            with self.subTest(sender=sender, target=target):
                source = Path(self.files.directory(sender + "-root")) / "report.txt"
                content = (sender + " -> " + target).encode() * 100000
                source.write_bytes(content)
                receipt = await self.deliver(sender + "-root", target, target + "-root")
                self.assertTrue(receipt["accepted"])
                self.assertEqual(receipt["attachments"], [{"path": "report.txt", "accepted": True, "name": "report.txt"}])
                message = self.seen[target + "-root"][-1]
                attachment, = message.additional_kwargs["attachments"]
                actual = attachment["path"]
                destination = self.files.directory(target + "-root")
                self.assertTrue(actual.startswith(destination + "/"), actual)
                self.assertNotEqual(actual, str(source))
                self.assertEqual(attachment["requested_path"], "report.txt")
                self.assertIn(actual, message.content)
                self.assertNotIn(str(source), message.content)
                self.assertEqual(attachment["remote_environment"], None if target == "local" else "cloud-" + target)
                self.assertEqual(Path(actual).read_bytes(), content)
                self.assertEqual(source.read_bytes(), content)
                self.assertEqual(attachment["size"], len(content))
                if target != "local":
                    backend = self.files.remote_backends[target]
                    self.assertEqual(await backend.aread_task_file(
                        actual, destination, max_bytes=len(content), owner=target + "-root",
                    ), content)
        self.assertEqual(self.files.pending_transfer_agents(), set())

    async def test_new_member_uses_sender_root_in_destination_environment(self):
        source = Path(self.files.directory("a-root")) / "report.txt"
        source.write_bytes(b"new member bytes")
        receipt = await self.deliver("a-root", "b")
        self.assertTrue(receipt["attachments"][0]["accepted"])
        target = receipt["task_id"]
        attachment, = self.seen[target][-1].additional_kwargs["attachments"]
        self.assertTrue(attachment["path"].startswith(str(self.b_root / "conversations/a-root") + "/"))
        self.assertEqual(self.manager.root_of(target), "a-root")
        self.assertEqual(Path(attachment["path"]).read_bytes(), b"new member bytes")

    async def test_same_machine_alias_shares_verified_original_even_with_different_recipient_root(self):
        source = Path(self.files.directory("a-root")) / "report.txt"
        source.write_bytes(b"one physical machine")

        async def forbidden(*args, **kwargs):
            self.fail("same-machine aliases must not copy files")

        with patch.object(self.a, "aimport_file", forbidden), patch.object(self.a, "aretrieve_attachment", forbidden):
            receipt = await self.deliver("a-root", "alias", "alias-root")
        self.assertTrue(receipt["attachments"][0]["accepted"])
        attachment, = self.seen["alias-root"][-1].additional_kwargs["attachments"]
        self.assertEqual(attachment["path"], str(source))
        self.assertEqual(attachment["remote_environment"], "alias-of-a")
        self.assertEqual(Path(attachment["path"]).read_bytes(), b"one physical machine")

    async def test_invalid_target_is_rejected_before_any_irreversible_file_io(self):
        async def forbidden(*args, **kwargs):
            self.fail("invalid target must not cause file I/O")

        cases = [("a-root", "b", "a-root"), ("a-root", "b", "missing-task"),
                 ("alias-root", "b", None), ("a-root", "human", "a-root")]
        with patch.object(self.a, "aretrieve_attachment", forbidden), patch.object(self.b, "aimport_file", forbidden):
            for sender, target, task in cases:
                with self.subTest(sender=sender, target=target, task=task):
                    receipt = await self.deliver(sender, target, task)
                    self.assertFalse(receipt["accepted"])
        self.assertEqual(list(self.b_root.rglob("report.txt")), [])

    async def test_bad_source_paths_keep_text_and_never_publish_partial_or_overwrite(self):
        source = Path(self.files.directory("a-root")) / "report.txt"
        source.write_bytes(b"allowed")
        symlink = source.parent / "alias.txt"
        symlink.symlink_to(source)
        receipt = await self.deliver("a-root", "b", "b-root", ["alias.txt", "../missing.txt", "report.txt"])
        self.assertTrue(receipt["accepted"])
        self.assertEqual([item["accepted"] for item in receipt["attachments"]], [False, False, True])
        first, = self.seen["b-root"][-1].additional_kwargs["attachments"]
        Path(first["path"]).write_bytes(b"receiver edits")
        repeated = await self.deliver("a-root", "b", "b-root")
        self.assertTrue(repeated["attachments"][0]["accepted"])
        second, = self.seen["b-root"][-1].additional_kwargs["attachments"]
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual(Path(first["path"]).read_bytes(), b"receiver edits")
        self.assertEqual(Path(second["path"]).read_bytes(), b"allowed")
        self.assertEqual(list(self.b_root.rglob("*.stage")), [])

    async def test_active_copy_freezes_both_roles_and_cancelled_wait_never_publishes(self):
        source = Path(self.files.directory("a-root")) / "report.txt"
        source.write_bytes(b"data")
        gate, entered = asyncio.Event(), asyncio.Event()
        original = self.b.aimport_file

        async def delayed(*args, **kwargs):
            entered.set()
            await gate.wait()
            return await original(*args, **kwargs)

        with patch.object(self.b, "aimport_file", delayed):
            copying = asyncio.create_task(self.deliver("a-root", "b", "b-root"))
            await entered.wait()
            self.assertEqual(self.files.pending_transfer_agents(), {"a", "b"})
            with self.assertRaisesRegex(ValueError, "不能切换"):
                self.files.update_environments(
                    {**self.files.environments, "b": ("local", str(self.local))},
                    {role: backend for role, backend in self.files.remote_backends.items() if role != "b"},
                )
            copying.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await copying
        self.assertEqual(self.files.pending_transfer_agents(), set())
        self.assertEqual(list(self.b_root.rglob("report.txt")), [])

    async def test_prepared_bindings_revalidated_after_later_message_awaits(self):
        source = Path(self.files.directory("a-root")) / "report.txt"
        source.write_bytes(b"prepared in original backend")
        gate, entered = asyncio.Event(), asyncio.Event()
        original = self.a.aexecute

        async def delayed(command, **kwargs):
            if "import json, mimetypes" in command:
                entered.set()
                await gate.wait()
            return await original(command, **kwargs)

        output = AgentOutput(messages=[
            SendMessage(to="b", task_id="b-root", message="First text", attachments=["report.txt"]),
            SendMessage(to="alias", task_id="alias-root", message="Second text", attachments=["report.txt"]),
        ], next="wait")
        with patch.object(self.a, "aexecute", delayed):
            preparing = asyncio.create_task(self.manager.prepare_attachments(output, "a-root"))
            await entered.wait()
            self.assertNotIn("b", self.files.pending_transfer_agents())
            self.files.update_environments(
                {**self.files.environments, "b": ("local", str(self.local))},
                {role: backend for role, backend in self.files.remote_backends.items() if role != "b"},
            )
            gate.set()
            prepared = await preparing
        first, second = self.manager.dispatch(output, "a-root", prepared=prepared)
        self.assertTrue(first["accepted"])
        self.assertFalse(first["attachments"][0]["accepted"])
        self.assertIn("预检后", first["attachments"][0]["error"])
        self.assertTrue(second["attachments"][0]["accepted"])
        await self.manager.wait("b-root")
        self.assertIn("First text", self.seen["b-root"][-1].content)
        self.assertNotIn("attachments", self.seen["b-root"][-1].additional_kwargs)

    async def test_target_retired_after_copy_is_not_delivered(self):
        (Path(self.files.directory("a-root")) / "report.txt").write_bytes(b"safe")
        output = AgentOutput(messages=[SendMessage(
            to="b", task_id="b-root", message="must not arrive", attachments=["report.txt"],
        )], next="wait")
        prepared = await self.manager.prepare_attachments(output, "a-root")
        self.manager.retire_agent("b")
        receipt, = self.manager.dispatch(output, "a-root", prepared=prepared)
        self.assertFalse(receipt["accepted"])
        self.assertFalse(any("must not arrive" in message.content for message in self.seen["b-root"]))

    async def test_delayed_real_cleanup_ack_retains_both_roles_after_failed_delivery(self):
        (Path(self.files.directory("a-root")) / "report.txt").write_bytes(b"owned until cleanup")
        gate, observed = asyncio.Event(), asyncio.Event()
        slow_root = self.base / "slow-machine"
        async with remote_backend(slow_root, cleanup_gate=gate, observed=observed) as backend:
            self.files.update_environments(
                {**self.files.environments, "b": ("cloud-slow", str(slow_root))},
                {**self.files.remote_backends, "b": backend},
            )
            try:
                with patch.object(file_transfer, "TRANSFER_CLEANUP_LIMIT", 0.01):
                    receipt = await self.deliver("a-root", "b", "b-root")
                await asyncio.wait_for(observed.wait(), 5)
                self.assertTrue(receipt["accepted"])
                self.assertFalse(receipt["attachments"][0]["accepted"])
                self.assertEqual(self.files.pending_transfer_agents(), {"a", "b"})
                self.assertEqual(backend.pending_transfer_owners(), {"a-root"})
                for role in ("a", "b"):
                    with self.subTest(role=role), self.assertRaisesRegex(ValueError, "不能切换"):
                        self.files.update_environments(
                            {**self.files.environments, role: ("local", str(self.local))},
                            {key: value for key, value in self.files.remote_backends.items() if key != role},
                        )
                gate.set()
                async with asyncio.timeout(5):
                    while self.files.pending_transfer_agents():
                        await asyncio.sleep(0.001)
                self.assertEqual(list(slow_root.rglob("*.stage")), [])
            finally:
                gate.set()

    async def test_missing_publication_receipt_is_never_success_and_retains_both_bindings(self):
        (Path(self.files.directory("a-root")) / "report.txt").write_bytes(b"commit acknowledgement lost")
        unknown_root = self.base / "unknown-machine"
        with self.assertRaises(CleanupUnconfirmedError):
            async with remote_backend(unknown_root, drop_publication_receipt=True) as backend:
                self.files.update_environments(
                    {**self.files.environments, "b": ("cloud-unknown", str(unknown_root))},
                    {**self.files.remote_backends, "b": backend},
                )
                receipt = await self.deliver("a-root", "b", "b-root")
                self.assertTrue(receipt["accepted"])
                self.assertFalse(receipt["attachments"][0]["accepted"])
                self.assertNotIn("attachments", self.seen["b-root"][-1].additional_kwargs)
                published, = unknown_root.rglob("report.txt")
                self.assertEqual(published.read_bytes(), b"commit acknowledgement lost")
                self.assertEqual(backend.pending_transfer_owners(), {"a-root"})
                self.assertEqual(self.files.pending_transfer_agents(), {"a", "b"})
        self.assertEqual(self.files.pending_transfer_agents(), {"a", "b"})

    async def test_cancellation_during_real_upload_does_not_publish_partial_bytes(self):
        (Path(self.files.directory("local-root")) / "report.txt").write_bytes(b"x" * (8 * 1024 * 1024))
        original = os.read
        interrupted = False

        def cancel_source_read(descriptor, count):
            nonlocal interrupted
            chunk = original(descriptor, count)
            if count == file_transfer.CHUNK_SIZE and not interrupted:
                interrupted = True
                asyncio.current_task().cancel()
            return chunk

        with patch.object(file_transfer.os, "read", cancel_source_read):
            copying = asyncio.create_task(self.deliver("local-root", "b", "b-root"))
            with self.assertRaises(asyncio.CancelledError):
                await copying
        self.assertTrue(interrupted)
        self.assertEqual(list(self.b_root.rglob("report.txt")), [])
        self.assertEqual(list(self.b_root.rglob("*.stage")), [])
        self.assertEqual(self.files.pending_transfer_agents(), set())

    async def test_symlinked_recipient_directories_cannot_redirect_local_or_remote_publication(self):
        (Path(self.files.directory("a-root")) / "report.txt").write_bytes(b"must remain confined")
        for target in ("local", "b"):
            with self.subTest(target=target):
                directory = Path(self.files.directory(target + "-root"))
                directory.rmdir()
                outside = self.base / ("outside-" + target)
                outside.mkdir()
                directory.symlink_to(outside, target_is_directory=True)
                receipt = await self.deliver("a-root", target, target + "-root")
                self.assertTrue(receipt["accepted"])
                self.assertFalse(receipt["attachments"][0]["accepted"])
                self.assertNotIn("attachments", self.seen[target + "-root"][-1].additional_kwargs)
                self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(self.files.pending_transfer_agents(), set())

    async def test_cancel_after_publish_retains_roles_until_late_success_and_cleanup_are_consumed(self):
        content = b"fully published before caller cancellation"
        (Path(self.files.directory("a-root")) / "report.txt").write_bytes(content)
        gate, observed = asyncio.Event(), asyncio.Event()
        delayed_root = self.base / "late-publication-machine"
        async with remote_backend(delayed_root, publication_gate=gate, observed=observed) as backend:
            self.files.update_environments(
                {**self.files.environments, "b": ("cloud-late", str(delayed_root))},
                {**self.files.remote_backends, "b": backend},
            )
            try:
                with patch.object(file_transfer, "TRANSFER_CLEANUP_LIMIT", 0.01):
                    copying = asyncio.create_task(self.files.prepare_attachments(
                        "a-root", "b", ["report.txt"], "b-root",
                    ))
                    await asyncio.wait_for(observed.wait(), 5)
                    published, = delayed_root.rglob("report.txt")
                    self.assertEqual(published.read_bytes(), content)
                    copying.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await copying
                self.assertEqual(self.files.pending_transfer_agents(), {"a", "b"})
                self.assertEqual(backend.pending_transfer_owners(), {"a-root"})
                self.assertTrue(backend._backend._transfers)
                gate.set()
                async with asyncio.timeout(5):
                    while self.files.pending_transfer_agents():
                        await asyncio.sleep(0.001)
                self.assertEqual(backend.pending_transfer_owners(), set())
                self.assertEqual(backend._backend._unconfirmed, {})
                self.assertEqual(list(delayed_root.rglob("*.stage")), [])
                self.assertEqual(published.read_bytes(), content)
                self.assertNotIn("attachments", self.seen["b-root"][-1].additional_kwargs)
            finally:
                gate.set()

    async def test_confirmed_receiver_conflict_releases_both_roles_without_overwrite(self):
        content = b"same source identity"
        (Path(self.files.directory("a-root")) / "report.txt").write_bytes(content)
        original = self.b.aimport_file

        async def same_destination(source_fd, directory, identity, name, *, owner=None):
            return await original(source_fd, directory, "f_conflicttest", name, owner=owner)

        with patch.object(self.b, "aimport_file", same_destination):
            first = await self.deliver("a-root", "b", "b-root")
            self.assertTrue(first["attachments"][0]["accepted"])
            attachment, = self.seen["b-root"][-1].additional_kwargs["attachments"]
            published = Path(attachment["path"])
            published.write_bytes(b"receiver changes must survive")
            conflict = await self.deliver("a-root", "b", "b-root")
        self.assertTrue(conflict["accepted"])
        self.assertFalse(conflict["attachments"][0]["accepted"])
        self.assertNotIn("attachments", self.seen["b-root"][-1].additional_kwargs)
        self.assertEqual(published.read_bytes(), b"receiver changes must survive")
        self.assertEqual(self.a.pending_transfer_owners(), set())
        self.assertEqual(self.b.pending_transfer_owners(), set())
        self.assertEqual(self.files.pending_transfer_agents(), set())
        self.assertEqual(list(self.b_root.rglob("*.stage")), [])
