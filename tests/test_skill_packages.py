"""Gateway snapshots and complete package publication over loopback SSH/SFTP."""

import asyncio
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import asyncssh

from wandrun.integrations.ssh_backend import SSHBackend, SessionChannel
from wandrun.runtime.execution.skills import SkillPackages
from wandrun.runtime.execution import skills as skill_packages


def make_skill(root: Path, name: str = "recipe") -> Path:
    skill = root / name
    (skill / "scripts").mkdir(parents=True)
    (skill / "empty").mkdir()
    (skill / "SKILL.md").write_bytes(
        f"---\nname: {name}\ndescription: Gateway recipe\n---\nRead scripts/run.py.\n".encode()
    )
    (skill / "scripts" / "run.py").write_bytes(b"print('original')\n")
    (skill / "scripts" / "run.py").chmod(0o751)
    (skill / "resource.bin").write_bytes(b"resource\x00bytes")
    (skill / "resource.bin").chmod(0o640)
    (skill / "empty").chmod(0o555)
    skill.chmod(0o750)
    return skill


class SkillSnapshotTests(unittest.TestCase):
    def test_names_modes_and_contents_all_change_the_version(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            skill = make_skill(source)
            packages = SkillPackages(source, None, "/work/.wandrun/skill-packages")
            original, = packages.snapshot(("recipe",))
            self.assertIs(packages.snapshot(("recipe",))[0], original)
            script = skill / "scripts" / "run.py"
            script.write_bytes(b"print('changed')\n")
            changed, = packages.snapshot(("recipe",))
            self.assertEqual(original.document, changed.document)
            self.assertNotEqual(original.version, changed.version)
            self.assertNotEqual(original.path, changed.path)
            script.chmod(0o711)
            permission_changed, = packages.snapshot(("recipe",))
            self.assertNotEqual(changed.version, permission_changed.version)
            script.rename(script.with_name("renamed.py"))
            renamed, = packages.snapshot(("recipe",))
            self.assertNotEqual(permission_changed.version, renamed.version)
            (skill / "empty").chmod(0o550)
            directory_mode_changed, = packages.snapshot(("recipe",))
            self.assertNotEqual(renamed.version, directory_mode_changed.version)
            (skill / "another-empty").mkdir()
            added_directory, = packages.snapshot(("recipe",))
            self.assertNotEqual(directory_mode_changed.version, added_directory.version)

    def test_bad_names_missing_documents_and_special_files_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            skill = make_skill(source)
            packages = SkillPackages(source, None, "/work/packages")
            for name in ("", ".", "..", "../outside", "/absolute", "recipe/child", "bad\x00name"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    packages.snapshot((name,))
            with self.assertRaisesRegex(ValueError, "未找到配置的 skill"):
                packages.snapshot(("missing",))
            (skill / "SKILL.md").unlink()
            with self.assertRaisesRegex(ValueError, "缺少普通文件 SKILL.md"):
                packages.snapshot(("recipe",))
            (skill / "SKILL.md").mkdir()
            with self.assertRaisesRegex(ValueError, "缺少普通文件 SKILL.md"):
                packages.snapshot(("recipe",))
            (skill / "SKILL.md").rmdir()
            (skill / "SKILL.md").write_bytes(b"document")
            os.mkfifo(skill / "fifo")
            with self.assertRaisesRegex(ValueError, "异常文件"):
                packages.snapshot(("recipe",))
            self.assertEqual(packages._snapshots, {})

    def test_root_package_and_nested_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "skills"
            skill = make_skill(source)
            alias = root / "alias"
            alias.symlink_to(source, target_is_directory=True)
            with self.assertRaises(OSError):
                SkillPackages(alias, None, "/work/packages").snapshot(("recipe",))
            with self.assertRaises(OSError):
                SkillPackages(alias / ".." / "skills", None, "/work/packages").snapshot(("recipe",))
            (source / "linked").symlink_to(skill, target_is_directory=True)
            packages = SkillPackages(source, None, "/work/packages")
            with self.assertRaises(OSError):
                packages.snapshot(("linked",))
            (skill / "linked-file").symlink_to(skill / "SKILL.md")
            with self.assertRaisesRegex(ValueError, "符号链接"):
                packages.snapshot(("recipe",))
            self.assertEqual(packages._snapshots, {})

    def test_read_errors_do_not_register_a_partial_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            make_skill(source, "first")
            make_skill(source, "second")
            packages = SkillPackages(source, None, "/work/packages")
            original = os.open

            scripts_read = 0

            def fail_script(name, flags, *args, **kwargs):
                nonlocal scripts_read
                if name == "run.py":
                    scripts_read += 1
                    if scripts_read == 2:
                        raise PermissionError("cannot read selected package")
                return original(name, flags, *args, **kwargs)

            with patch.object(skill_packages.os, "open", side_effect=fail_script):
                with self.assertRaisesRegex(PermissionError, "cannot read selected package"):
                    packages.snapshot(("first", "second"))
            self.assertEqual(packages._snapshots, {})

    def test_remote_root_rejects_relative_and_traversing_paths(self):
        for path in ("relative", "/", "//", "///", "/work/../packages", "/work/./packages", "/work/\x00bad"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                SkillPackages(Path("unused"), None, path)


class _NoAuthServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return False


class _PackageSFTPServer(asyncssh.SFTPServer):
    def __init__(self, channel, root, owner):
        super().__init__(channel, chroot=os.fsencode(root))
        self.owner = owner

    def write(self, file_obj, offset, data):
        self.owner.writes += 1
        result = super().write(file_obj, offset, data + (b"wrong" if self.owner.corrupt else b""))
        if self.owner.fail_write:
            raise asyncssh.SFTPFailure("injected upload failure")
        return result

    def rename(self, oldpath, newpath):
        if self.owner.fail_rename:
            raise asyncssh.SFTPFailure("injected publication failure")
        self.owner.publications += 1
        return super().rename(oldpath, newpath)


class SkillPackageSFTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "gateway"
        self.remote = self.root / "remote"
        self.remote.mkdir()
        self.skill = make_skill(self.source)
        self.packages = SkillPackages(self.source, None, "/work/.wandrun/skill-packages")
        self.snapshot, = self.packages.snapshot(("recipe",))
        self.writes = 0
        self.publications = 0
        self.fail_write = False
        self.fail_rename = False
        self.corrupt = False
        self.connections = []
        self.listener = await asyncssh.listen(
            "127.0.0.1", 0,
            server_factory=_NoAuthServer,
            server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
            sftp_factory=lambda channel: _PackageSFTPServer(channel, self.remote, self),
        )
        self.backend = await self.connect()

    async def connect(self):
        connection = await asyncssh.connect(
            "127.0.0.1", port=self.listener.get_port(), username="test", known_hosts=None,
        )
        self.connections.append(connection)
        return SSHBackend(SessionChannel(None, None), connection=connection, label="loopback", workdir="/work")

    async def asyncTearDown(self):
        for connection in self.connections:
            connection.close()
            await connection.wait_closed()
        self.listener.close()
        await self.listener.wait_closed()
        self.temporary.cleanup()

    def remote_path(self, path):
        return self.remote / path.lstrip("/")

    def assert_no_stages(self):
        self.assertEqual(list(self.remote.rglob(".stage-*")), [])

    async def test_instabox_compaction_archive_is_published_remotely_not_on_gateway(self):
        import json
        from langchain_core.messages import HumanMessage
        from wandrun.integrations.instabox import InstaboxBackend
        from wandrun.runtime.context.compaction_archive import CompactionArchive

        host_path = self.root / "remote-only-artifacts"
        provider = InstaboxBackend("m_" + "a" * 26, workdir="/work")
        try:
            with patch.object(provider, "_ready", return_value=self.backend):
                archive = CompactionArchive(str(host_path), provider)
                path = await archive.segment("task", [HumanMessage(content="remote archive proof")], 0, 1)
            self.assertFalse(host_path.exists())
            rows = [json.loads(line) for line in self.remote_path(path).read_text().splitlines()]
            message = json.loads("".join(row["json"] for row in rows[1:]))
            self.assertEqual(message["content"], "remote archive proof")
        finally:
            await provider.aclose()

    async def test_full_snapshot_is_verified_before_publish_and_modes_are_preserved(self):
        original_verify = skill_packages._verify_package
        staged = []

        async def verify(sftp, container, snapshot):
            result = await original_verify(sftp, container, snapshot)
            if "/.stage-" in container:
                staged.append(container)
                self.assertFalse(self.remote_path(snapshot.root).exists())
                root = self.remote_path(container) / "recipe"
                self.assertEqual((root / "resource.bin").read_bytes(), b"resource\x00bytes")
                self.assertEqual(stat.S_IMODE((root / "scripts/run.py").stat().st_mode), 0o751)
                self.assertEqual(stat.S_IMODE((root / "empty").stat().st_mode), 0o555)
                self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o750)
            return result

        # Editing the gateway after snapshot creation cannot change frozen upload bytes.
        (self.skill / "scripts/run.py").write_bytes(b"later gateway edit\n")
        with patch.object(skill_packages, "_verify_package", side_effect=verify):
            await self.packages.prepare(self.backend)
        self.assertEqual(len(staged), 1)
        published = self.remote_path(self.snapshot.root)
        self.assertEqual((published / "scripts/run.py").read_bytes(), b"print('original')\n")
        self.assertEqual((published / "resource.bin").read_bytes(), b"resource\x00bytes")
        self.assert_no_stages()

    async def test_same_connection_reuses_and_reconnection_verifies_without_upload(self):
        await asyncio.gather(self.packages.prepare(self.backend), self.packages.prepare(self.backend))
        self.assertEqual(self.writes, 3)
        self.assertEqual(self.publications, 1)
        await self.packages.prepare(self.backend)
        self.assertEqual(self.writes, 3)
        reconnected = await self.connect()
        await self.packages.prepare(reconnected)
        self.assertEqual(self.writes, 3)
        self.assertEqual(self.publications, 1)
        published = self.remote_path(self.snapshot.root)
        (published / "scripts/run.py").write_bytes(b"remote mutation")
        with self.assertRaisesRegex(OSError, "内容与快照不一致"):
            await self.packages.prepare(await self.connect())
        self.assertEqual((published / "scripts/run.py").read_bytes(), b"remote mutation")
        self.assertEqual(self.writes, 3)

    async def test_independent_publishers_share_one_version_without_replacing_it(self):
        peer = SkillPackages(self.source, None, "/work/.wandrun/skill-packages")
        peer_snapshot, = peer.snapshot(("recipe",))
        self.assertEqual(peer_snapshot.root, self.snapshot.root)
        peer_backend = await self.connect()
        await asyncio.gather(self.packages.prepare(self.backend), peer.prepare(peer_backend))
        self.assertEqual(
            (self.remote_path(self.snapshot.root) / "scripts/run.py").read_bytes(),
            b"print('original')\n",
        )
        self.assert_no_stages()

    async def test_reconnection_rejects_modified_permissions_and_nested_symlinks(self):
        await self.packages.prepare(self.backend)
        script = self.remote_path(self.snapshot.root) / "scripts/run.py"
        script.chmod(0o700)
        with self.assertRaisesRegex(OSError, "类型或权限与快照不一致"):
            await self.packages.prepare(await self.connect())
        script.chmod(0o751)
        script.unlink()
        outside = self.remote / "outside-file"
        outside.write_bytes(b"print('original')\n")
        script.symlink_to("/outside-file")
        with self.assertRaisesRegex(OSError, "类型或权限与快照不一致"):
            await self.packages.prepare(await self.connect())
        self.assertTrue(script.is_symlink())
        self.assertEqual(outside.read_bytes(), b"print('original')\n")
        self.assertEqual(self.writes, 3)
        self.assert_no_stages()

    async def test_shared_old_versions_and_other_agent_packages_remain_available(self):
        make_skill(self.source, "other")
        other, = self.packages.snapshot(("other",))
        await self.packages.prepare(self.backend)
        old = self.remote_path(self.snapshot.root)
        peer = self.remote_path(other.root)
        (self.skill / "scripts/run.py").write_bytes(b"new version\n")
        updated, = self.packages.snapshot(("recipe",))
        await self.packages.prepare(self.backend)
        self.assertNotEqual(updated.root, self.snapshot.root)
        self.assertEqual((old / "scripts/run.py").read_bytes(), b"print('original')\n")
        self.assertEqual((peer / "scripts/run.py").read_bytes(), b"print('original')\n")
        self.assertEqual((self.remote_path(updated.root) / "scripts/run.py").read_bytes(), b"new version\n")
        self.assert_no_stages()

    async def test_upload_verification_and_publication_failures_never_expose_partial_package(self):
        for fault in ("fail_write", "corrupt", "fail_rename"):
            with self.subTest(fault=fault):
                setattr(self, fault, True)
                with self.assertRaises((asyncssh.SFTPError, OSError)):
                    await self.packages.prepare(self.backend)
                self.assertFalse(self.remote_path(self.snapshot.root).exists())
                self.assert_no_stages()
                setattr(self, fault, False)
        await self.packages.prepare(self.backend)
        self.assertTrue(self.remote_path(self.snapshot.path).is_file())
        self.assert_no_stages()

    async def test_cancellation_cleans_only_own_staging_and_retry_can_publish(self):
        original_verify = skill_packages._verify_package
        staged = asyncio.Event()

        async def hold_staging(sftp, container, snapshot):
            if "/.stage-" in container:
                staged.set()
                await asyncio.Event().wait()
            return await original_verify(sftp, container, snapshot)

        with patch.object(skill_packages, "_verify_package", side_effect=hold_staging):
            preparation = asyncio.create_task(self.packages.prepare(self.backend))
            await asyncio.wait_for(staged.wait(), 5)
            self.assertFalse(self.remote_path(self.snapshot.root).exists())
            preparation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await preparation
        self.assertFalse(self.remote_path(self.snapshot.root).exists())
        self.assert_no_stages()
        await self.packages.prepare(self.backend)
        self.assertTrue(self.remote_path(self.snapshot.path).is_file())

    async def test_failed_staging_cleanup_is_reported_and_retried_before_publication(self):
        from wandrun.integrations.shell_backend import CleanupUnconfirmedError

        self.fail_write = True
        with patch.object(skill_packages, "_remove_staging", side_effect=OSError("cleanup unavailable")):
            with self.assertRaises(CleanupUnconfirmedError):
                await self.packages.prepare(self.backend)
        self.assertFalse(self.remote_path(self.snapshot.root).exists())
        self.assertTrue(all(self.remote_path(path).is_dir() for path in self.packages.pending_staging))
        self.assertEqual(len(self.packages.pending_staging), 1)
        self.fail_write = False
        await self.packages.prepare(self.backend)
        self.assertEqual(self.packages.pending_staging, ())
        self.assertTrue(self.remote_path(self.snapshot.path).is_file())
        self.assert_no_stages()

    async def test_cancelled_publication_preserves_unconfirmed_cleanup_without_losing_cancellation(self):
        original_verify = skill_packages._verify_package
        staged = asyncio.Event()

        async def hold_staging(sftp, container, snapshot):
            if "/.stage-" in container:
                staged.set()
                await asyncio.Event().wait()
            return await original_verify(sftp, container, snapshot)

        with (
            patch.object(skill_packages, "_verify_package", side_effect=hold_staging),
            patch.object(skill_packages, "_remove_staging", side_effect=OSError("cleanup unavailable")),
        ):
            preparation = asyncio.create_task(self.packages.prepare(self.backend))
            await asyncio.wait_for(staged.wait(), 5)
            preparation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await preparation
        self.assertEqual(len(self.packages.pending_staging), 1)
        self.assertFalse(self.remote_path(self.snapshot.root).exists())
        await self.packages.prepare(self.backend)
        self.assertEqual(self.packages.pending_staging, ())
        self.assertTrue(self.remote_path(self.snapshot.path).is_file())
        self.assert_no_stages()

    async def test_cancelled_waiter_does_not_cancel_another_preparation(self):
        original = skill_packages._prepare_package
        entered = asyncio.Event()
        release = asyncio.Event()

        async def hold(sftp, snapshot, pending_staging):
            entered.set()
            await release.wait()
            return await original(sftp, snapshot, pending_staging)

        with patch.object(skill_packages, "_prepare_package", side_effect=hold):
            owner = asyncio.create_task(self.packages.prepare(self.backend))
            await asyncio.wait_for(entered.wait(), 5)
            waiter = asyncio.create_task(self.packages.prepare(self.backend))
            await asyncio.sleep(0)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertFalse(owner.done())
            release.set()
            await owner
        self.assertEqual(self.publications, 1)
        self.assertTrue(self.remote_path(self.snapshot.path).is_file())
        self.assert_no_stages()

    async def test_remote_symlink_parents_and_corrupt_existing_packages_fail_closed(self):
        outside = self.remote / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"safe")
        managed = self.remote / "work/.wandrun"
        managed.parent.mkdir(parents=True)
        managed.symlink_to("/outside", target_is_directory=True)
        with self.assertRaisesRegex(OSError, "目录不是普通目录"):
            await self.packages.prepare(self.backend)
        self.assertEqual(sorted(path.name for path in outside.iterdir()), ["sentinel"])
        managed.unlink()
        await self.packages.prepare(self.backend)
        (self.remote_path(self.snapshot.root) / "unexpected").write_bytes(b"not in snapshot")
        with self.assertRaisesRegex(OSError, "目录内容与快照不一致"):
            await self.packages.prepare(await self.connect())
        self.assert_no_stages()

    async def test_existing_version_symlink_is_not_followed_or_replaced(self):
        container = self.remote_path(self.snapshot.root).parent
        container.parent.mkdir(parents=True)
        outside = self.remote / "outside"
        outside.mkdir()
        (outside / "sentinel").write_bytes(b"safe")
        container.symlink_to("/outside", target_is_directory=True)
        with self.assertRaisesRegex(OSError, "目录不是普通目录"):
            await self.packages.prepare(self.backend)
        self.assertTrue(container.is_symlink())
        self.assertEqual(sorted(path.name for path in outside.iterdir()), ["sentinel"])
        self.assertEqual(self.writes, 0)
        self.assert_no_stages()
