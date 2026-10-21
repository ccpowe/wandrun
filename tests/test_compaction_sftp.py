"""Compaction artifact publication over a real loopback SSH/SFTP transport."""

import os
import tempfile
import unittest
from pathlib import Path

import asyncssh

from wandrun.integrations.ssh_backend import SSHBackend, SessionChannel


class _NoAuthServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return False


class _RacingSFTPServer(asyncssh.SFTPServer):
    def __init__(self, channel, root, owner):
        super().__init__(channel, chroot=os.fsencode(root))
        self.owner = owner

    def link(self, oldpath, newpath):
        if self.owner.race is not None:
            expected, content = self.owner.race
            assert newpath == expected
            target = Path(os.fsdecode(self.map_path(newpath)))
            assert not target.exists()
            if isinstance(content, Path):
                target.symlink_to(content)
            else:
                target.write_bytes(content)  # Competing publisher arrives inside the no-clobber request.
            self.owner.race = None
        if self.owner.disable_link:
            raise asyncssh.SFTPOpUnsupported("hard links unavailable")
        return super().link(oldpath, newpath)


class CompactionSFTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.race = None
        self.disable_link = False
        self.listener = await asyncssh.listen(
            "127.0.0.1", 0,
            server_factory=_NoAuthServer,
            server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
            sftp_factory=lambda channel: _RacingSFTPServer(channel, self.root, self),
        )
        self.connection = await asyncssh.connect(
            "127.0.0.1", port=self.listener.get_port(), username="test", known_hosts=None,
        )
        # Publishing uses only the SFTP connection, not an exec/session channel.
        self.backend = SSHBackend(
            SessionChannel(None, None), connection=self.connection, label="loopback", workdir="/work",
        )

    async def asyncTearDown(self):
        self.connection.close()
        await self.connection.wait_closed()
        self.listener.close()
        await self.listener.wait_closed()
        self.temporary.cleanup()

    def assert_no_stages(self):
        self.assertEqual(list(self.root.rglob("*.stage")), [])

    async def test_new_publication_and_identical_retry_preserve_original(self):
        path = "/work/.wandrun/artifacts/compaction/thread/segment.jsonl"
        target = self.root / path.lstrip("/")
        await self.backend.apublish_artifact(path, b"original\x00bytes")
        self.assertEqual(target.read_bytes(), b"original\x00bytes")
        await self.backend.apublish_artifact(path, b"original\x00bytes")
        with self.assertRaisesRegex(OSError, "同名内容不一致"):
            await self.backend.apublish_artifact(path, b"other")
        self.assertEqual(target.read_bytes(), b"original\x00bytes")
        self.assert_no_stages()

    async def test_atomic_race_rechecks_original_bytes_without_replacement(self):
        for name, competing, expected_error in (
            ("different", b"rival", True),
            ("identical", b"published", False),
        ):
            with self.subTest(name=name):
                path = f"/work/.wandrun/artifacts/compaction/thread/{name}.jsonl"
                self.race = (os.fsencode(path), competing)
                if expected_error:
                    with self.assertRaisesRegex(OSError, "同名内容不一致"):
                        await self.backend.apublish_artifact(path, b"published")
                else:
                    await self.backend.apublish_artifact(path, b"published")
                self.assertIsNone(self.race)  # The request reached the server's link operation.
                self.assertEqual((self.root / path.lstrip("/")).read_bytes(), competing)
                self.assert_no_stages()

    async def test_racing_target_symlink_is_rejected_and_stage_removed(self):
        path = "/work/.wandrun/artifacts/compaction/thread/racing-link.bin"
        outside = self.root / "race-outside"
        outside.write_bytes(b"sentinel")
        self.race = (os.fsencode(path), outside)
        with self.assertRaisesRegex(OSError, "目标不是普通文件"):
            await self.backend.apublish_artifact(path, b"published")
        self.assertIsNone(self.race)
        self.assertTrue((self.root / path.lstrip("/")).is_symlink())
        self.assertEqual(outside.read_bytes(), b"sentinel")
        self.assert_no_stages()

    async def test_symlinked_directory_chain_is_rejected_without_external_write(self):
        components = ("workdir", ".wandrun", "artifacts", "compaction", "thread", "media")
        for index, component in enumerate(components):
            with self.subTest(component=component):
                relative = Path(f"work{index}/.wandrun/artifacts/compaction/thread/media/file.bin")
                directory = relative.parent
                # Isolate each case so a failed publication cannot affect the next one.
                prefix = self.root
                for part in directory.parts:
                    prefix /= part
                    if part == component or (component == "workdir" and part == f"work{index}"):
                        break
                prefix.parent.mkdir(parents=True, exist_ok=True)
                outside = self.root / f"outside{index}"
                outside.mkdir()
                (outside / "sentinel").write_bytes(b"safe")
                prefix.symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(OSError, "目录不是普通目录"):
                    await self.backend.apublish_artifact("/" + str(relative), b"not outside")
                self.assertEqual(sorted(child.name for child in outside.iterdir()), ["sentinel"])
                self.assertEqual((outside / "sentinel").read_bytes(), b"safe")
                self.assert_no_stages()

    async def test_target_symlink_is_rejected_even_when_dangling(self):
        for name, exists in (("existing", True), ("dangling", False)):
            with self.subTest(name=name):
                path = f"/work/.wandrun/artifacts/compaction/thread/{name}.bin"
                target = self.root / path.lstrip("/")
                target.parent.mkdir(parents=True, exist_ok=True)
                outside = self.root / f"{name}-outside"
                if exists:
                    outside.write_bytes(b"sentinel")
                target.symlink_to(outside)
                with self.assertRaisesRegex(OSError, "目标不是普通文件"):
                    await self.backend.apublish_artifact(path, b"not outside")
                self.assertTrue(target.is_symlink())
                if exists:
                    self.assertEqual(outside.read_bytes(), b"sentinel")
                else:
                    self.assertFalse(outside.exists())
                self.assert_no_stages()

    async def test_non_directory_parent_and_non_file_target_are_rejected(self):
        parent = self.root / "work/.wandrun/artifacts/compaction/thread/media"
        parent.parent.mkdir(parents=True)
        parent.write_bytes(b"file")
        with self.assertRaisesRegex(OSError, "目录不是普通目录"):
            await self.backend.apublish_artifact("/work/.wandrun/artifacts/compaction/thread/media/file.bin", b"new")
        self.assertEqual(parent.read_bytes(), b"file")
        target = parent.parent / "directory.bin"
        target.mkdir()
        with self.assertRaisesRegex(OSError, "目标不是普通文件"):
            await self.backend.apublish_artifact("/work/.wandrun/artifacts/compaction/thread/directory.bin", b"new")
        self.assert_no_stages()

    async def test_unavailable_hardlink_fails_closed_and_cleans_stage(self):
        self.disable_link = True
        path = "/work/.wandrun/artifacts/compaction/thread/no-link.bin"
        with self.assertRaises(asyncssh.SFTPError):
            await self.backend.apublish_artifact(path, b"new")
        self.assertFalse((self.root / path.lstrip("/")).exists())
        self.assert_no_stages()
