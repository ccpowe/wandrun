"""Workspace defaults and local/Instabox execution boundaries."""

import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import asyncssh

from wandrun.config import load_config
from wandrun.gateway.skills import inspect_skill
from wandrun.integrations import remote_session
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.integrations.ssh_backend import SSHBackend, SessionChannel
from wandrun.runtime.execution.environments import open_environments, open_instabox
from wandrun.runtime.execution.workspace import Workspace


class WorkspaceConfigTests(unittest.TestCase):
    def test_missing_runtime_dir_gets_loadable_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            self.assertTrue(workspace.ensure_config())
            self.assertTrue(workspace.skills_dir.is_dir())
            installer = workspace.skills_dir / "skill-installer" / "SKILL.md"
            self.assertFalse(installer.is_symlink())
            self.assertEqual(inspect_skill(workspace.skills_dir, "skill-installer")["status"], "ok")
            config = load_config(workspace.agents_config)
            self.assertEqual(config.main_agent, "main")
            self.assertEqual(inspect_skill(workspace.skills_dir, "browser")["status"], "ok")
            self.assertEqual(config.agents[config.main_agent].skills, ("browser", "skill-installer"))
            self.assertEqual(config.agents["main"].mcp_servers, ("exa",))
            self.assertEqual(config.agents["main"].environment, "local")
            self.assertEqual(set(config.mcp_servers), {"exa"})
            self.assertEqual(config.environments["local"].browser.cdp_url, "http://127.0.0.1:9222")

    def test_reinitialization_preserves_customized_installer_and_config(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            self.assertTrue(workspace.ensure_config())
            installer = workspace.skills_dir / "skill-installer" / "SKILL.md"
            installer.write_text("用户修改的安装器", encoding="utf-8")
            workspace.agents_config.write_text("用户修改的配置", encoding="utf-8")

            self.assertFalse(workspace.ensure_config())
            self.assertEqual(installer.read_text(encoding="utf-8"), "用户修改的安装器")
            self.assertEqual(workspace.agents_config.read_text(encoding="utf-8"), "用户修改的配置")

    def test_existing_runtime_dir_is_used_as_is(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.runtime_dir.mkdir()
            edited = 'main_agent = "mine"\n[agents.mine]\ndescription = "d"\nsystem_prompt = "s"\nmodel = "x"\n'
            workspace.agents_config.write_text(edited, encoding="utf-8")
            installer = workspace.skills_dir / "skill-installer"
            installer.mkdir(parents=True)
            (installer / "SKILL.md").write_text("保留已有技能", encoding="utf-8")
            workspace.mcps_config.write_text("[mcp_servers]\n", encoding="utf-8")
            self.assertFalse(workspace.ensure_config())
            self.assertEqual(workspace.agents_config.read_text(encoding="utf-8"), edited)
            self.assertEqual((installer / "SKILL.md").read_text(encoding="utf-8"), "保留已有技能")
            self.assertFalse(workspace.environments_config.exists())  # 不补写缺少的文件
            with self.assertRaises(FileNotFoundError):
                load_config(workspace.agents_config)


class _LoopbackServer(asyncssh.SSHServer):
    def __init__(self, public_key: bytes):
        self._public_key = public_key

    def begin_auth(self, username):
        return True

    def public_key_auth_supported(self):
        return True

    def validate_public_key(self, username, key):
        return username == "test" and key.export_public_key() == self._public_key


@asynccontextmanager
async def loopback_instabox():
    """Replace only provider preparation: real local session protocol and loopback SFTP.

    Production Instabox ownership, lazy readiness, process table, skill publication and
    shutdown remain in use. This fixture does not exercise the Instabox platform API.
    """
    prepared = []
    processes = []
    transfer_processes = []

    async def pump(reader, writer, *, eof=False):
        try:
            while chunk := await reader.read(65536):
                writer.write(chunk)
                await writer.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if eof:
                try:
                    writer.write_eof()
                except (BrokenPipeError, ConnectionResetError):
                    pass

    async def transfer(process):
        child = await asyncio.create_subprocess_shell(
            process.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        transfer_processes.append(child)
        incoming = asyncio.create_task(pump(process.stdin, child.stdin, eof=True))
        outgoing = [asyncio.create_task(pump(child.stdout, process.stdout)),
                    asyncio.create_task(pump(child.stderr, process.stderr))]
        try:
            result = await child.wait()
            await asyncio.gather(*outgoing)
            process.exit(result)
        finally:
            incoming.cancel()
            await asyncio.gather(incoming, return_exceptions=True)
            if child.returncode is None:
                child.terminate()
                await child.wait()

    client_key = asyncssh.generate_private_key("ssh-ed25519")
    listener = await asyncssh.listen(
        "127.0.0.1", 0, server_factory=lambda: _LoopbackServer(client_key.export_public_key()),
        server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
        sftp_factory=asyncssh.SFTPServer, process_factory=transfer, encoding=None,
    )

    async def prepare(owner):
        Path(owner._workdir).mkdir(parents=True, exist_ok=True)
        connection = await asyncssh.connect(
            "127.0.0.1", port=listener.get_port(), username="test", known_hosts=None,
            client_keys=[client_key], agent_path=None, config=None,
        )
        owner._connections.append(connection)
        owner._connection = connection
        process = await asyncio.create_subprocess_exec(
            sys.executable, remote_session.__file__, owner._workdir, repr(owner._termination_grace),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            env={key: value for key, value in os.environ.items()
                 if key not in ("WANDRUN_BROWSER_CDP", "AGENT_BROWSER_SESSION")},
        )
        processes.append(process)
        channel = SessionChannel(process.stdout, process.stdin)
        await channel.open(owner._termination_grace)
        backend = SSHBackend(
            channel, connection=connection, label=owner.id, workdir=owner._workdir,
            timeout=owner._timeout, termination_grace=owner._termination_grace,
        )
        owner._sessions.append(backend)
        owner._backend = backend
        owner._ever_connected = True
        prepared.append(owner)
        return backend, False

    try:
        with patch.object(InstaboxBackend, "_prepare", prepare):
            yield prepared
    finally:
        for process in processes:
            if process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.terminate()
                    await process.wait()
        listener.close()
        await listener.wait_closed()
        for process in transfer_processes:
            if process.returncode is None:
                process.stdin.close()
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.terminate()
                    await process.wait()


class LocalEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    def configure(self, root: Path) -> Workspace:
        workspace = Workspace(root)
        workspace.ensure_config()
        workspace.agents_config.write_text(
            'main_agent = "main"\n'
            '[agents.main]\ndescription = "m"\nsystem_prompt = "m"\nmodel = "x"\n'
            '[agents.helper]\ndescription = "h"\nsystem_prompt = "h"\nmodel = "x"\n'
            'environment = "slow"\n'
            '[agents.peer]\ndescription = "p"\nsystem_prompt = "p"\nmodel = "x"\n',
            encoding="utf-8",
        )
        workspace.environments_config.write_text(
            'default = "local"\n'
            '[environments.local]\ntype = "local"\ncommand_timeout = 11\n'
            '[environments.slow]\ntype = "local"\ncommand_timeout = 22\ntermination_grace = 0.5\n'
            '[environments.unused]\ntype = "local"\n',
            encoding="utf-8",
        )
        return workspace

    async def test_each_referenced_environment_opens_once(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = self.configure(Path(directory))
            config = load_config(workspace.agents_config)
            opened = []
            async with AsyncExitStack() as stack:
                roles = await open_environments(config, workspace, stack, opened)
                self.assertIs(roles["main"], roles["peer"])
                self.assertIsNot(roles["main"], roles["helper"])
                self.assertEqual([e.name for e in opened], ["local", "slow"])  # 未引用的不打开
                self.assertEqual(roles["main"].backend._default_timeout, 11)
                self.assertEqual(roles["helper"].backend._default_timeout, 22)
                self.assertEqual(roles["helper"].backend._termination_grace, 0.5)
            for environment in opened:  # 退出上下文即关闭，不再接受命令
                with self.assertRaises(RuntimeError):
                    environment.backend.execute("echo late")

    async def test_file_tools_and_execute_see_the_same_real_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = self.configure(Path(directory))
            skill = workspace.skills_dir / "proof"
            skill.mkdir()
            (skill / "SKILL.md").write_text("---\nname: proof\ndescription: d\n---\n", encoding="utf-8")
            (skill / "run.py").write_text("print('ran from skill')\n", encoding="utf-8")
            config = load_config(workspace.agents_config)
            async with AsyncExitStack() as stack:
                environment = (await open_environments(config, workspace, stack, []))["main"]
                self.assertEqual(environment.skills_source, str(workspace.skills_dir))
                self.assertTrue(Path(environment.skills_source).is_absolute())
                # 提示词中的 skill 路径既能用文件工具读取，也能直接交给 execute 运行（ADR-0012 去掉虚拟路径）。
                read = environment.backend.read(f"{environment.skills_source}/proof/SKILL.md")
                self.assertIsNone(read.error)
                result = environment.backend.execute(
                    f"{sys.executable} {environment.skills_source}/proof/run.py"
                )
                self.assertEqual(result.exit_code, 0, result.output)
                self.assertIn("ran from skill", result.output)
                # 相对路径与命令的工作目录都是 workspace。
                environment.backend.write("note.txt", "hello")
                self.assertEqual((workspace.root / "note.txt").read_text(), "hello")
                self.assertIn("hello", environment.backend.execute("cat note.txt").output)


class InstaboxBuiltinEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_loopback_fixture_rejects_untrusted_clients(self):
        from wandrun.config import EnvironmentDefinition

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = Workspace(root)
            proof = root / "authorized-only.txt"
            proof.write_bytes(b"private fixture content")
            definition = EnvironmentDefinition(
                type="instabox", machine_id="m_" + "a" * 26, workdir=str(root / "remote"),
            )
            async with loopback_instabox(), open_instabox(
                "remote", definition, workspace,
            ) as environment:
                received = (await environment.backend.adownload_files([str(proof)]))[0]
                self.assertIsNone(received.error)
                self.assertEqual(received.content, b"private fixture content")
                host, port = environment.backend._connection.get_extra_info("peername")[:2]
                for keys in ([], [asyncssh.generate_private_key("ssh-ed25519")]):
                    with self.subTest(credentials="absent" if not keys else "untrusted"):
                        with self.assertRaises(asyncssh.PermissionDenied):
                            async with asyncssh.connect(
                                host, port=port, username="test", known_hosts=None,
                                client_keys=keys, agent_path=None, config=None,
                            ):
                                self.fail("untrusted client gained filesystem access")

    async def test_builtin_packages_override_reserved_user_names_without_mutating_users(self):
        from wandrun.config import EnvironmentDefinition
        from wandrun.runtime.agent.agents import _ConfiguredSkillsMiddleware

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "workspace").mkdir()
            workspace = Workspace(root / "workspace")
            user = workspace.skills_dir / "wandrun-ui" / "SKILL.md"
            user.parent.mkdir(parents=True)
            user.write_text(
                "---\nname: wandrun-ui\ndescription: User description\n---\nUser text.\n",
                encoding="utf-8",
            )
            builtin_source = root / "runtime-source"
            builtin = builtin_source / "wandrun-ui"
            builtin.mkdir(parents=True)
            (builtin / "SKILL.md").write_text(
                "---\nname: wandrun-ui\ndescription: Remote builtin\n---\nBuiltin text.\n",
                encoding="utf-8",
            )
            resource = builtin / "display.md"
            resource.write_text("package-731\n", encoding="utf-8")
            definition = EnvironmentDefinition(
                type="instabox", machine_id="m_" + "a" * 26, workdir=str(root / "remote"),
            )
            async with loopback_instabox() as prepared:
                async with open_instabox("remote", definition, workspace, builtin_source) as environment:
                    self.assertNotEqual(environment.skills_source, environment.builtin_skills_source)
                    selected = _ConfiguredSkillsMiddleware(
                        environment.backend, ("wandrun-ui",), environment.skills_source,
                        builtin_source=environment.builtin_skills_source,
                        builtin_names=environment.builtin_skills,
                        skill_packages=environment.skill_packages,
                    )
                    metadata = await selected.abefore_agent({}, None, {})
                    self.assertEqual(prepared, [])  # Metadata never opens a remote session.
                    skill, = metadata["skills_metadata"]
                    self.assertEqual(skill["description"], "Remote builtin")
                    self.assertTrue(skill["path"].startswith(environment.builtin_skills_source + "/"))
                    resource.write_text("changed on gateway\n", encoding="utf-8")
                    detail = await environment.backend.aread(
                        str(Path(skill["path"]).with_name("display.md")),
                    )
                    self.assertIsNone(detail.error)
                    self.assertIn("package-731", detail.file_data["content"])
                    updated = await selected.abefore_agent(metadata, None, {})
                    updated_skill, = updated["skills_metadata"]
                    self.assertNotEqual(updated_skill["path"], skill["path"])
                    changed = await environment.backend.aread(
                        str(Path(updated_skill["path"]).with_name("display.md")),
                    )
                    self.assertIsNone(changed.error)
                    self.assertIn("changed on gateway", changed.file_data["content"])
                    original = await environment.backend.aread(str(Path(skill["path"]).with_name("display.md")))
                    self.assertIn("package-731", original.file_data["content"])
                self.assertEqual(len(prepared), 1)
                self.assertTrue(prepared[0]._closed)
                # A later graph without the builtin may select the same user's name.
                async with open_instabox("remote", definition, workspace) as environment:
                    self.assertIsNone(environment.builtin_skills_source)
                    self.assertEqual(environment.builtin_skills, frozenset())
                    selected = _ConfiguredSkillsMiddleware(
                        environment.backend, ("wandrun-ui",), environment.skills_source,
                        skill_packages=environment.skill_packages,
                    )
                    metadata = await selected.abefore_agent({}, None, {})
                    skill, = metadata["skills_metadata"]
                    self.assertEqual(skill["description"], "User description")
                    detail = await environment.backend.aread(skill["path"])
                    self.assertIsNone(detail.error)
                    self.assertIn("User text.", detail.file_data["content"])
            self.assertIn("User text.", user.read_text())

if __name__ == "__main__":
    unittest.main()
