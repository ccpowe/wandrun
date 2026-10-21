"""ADR-0012：工作区默认配置与本机执行环境。"""

import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from wandrun.config import load_config
from wandrun.gateway.skills import inspect_skill
from wandrun.runtime.environments import open_environments, open_ssh
from wandrun.runtime.workspace import Workspace


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


class SSHOpeningFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_failure_while_opening_keeps_the_original_error(self):
        from contextlib import asynccontextmanager
        from unittest.mock import patch

        from wandrun.config import EnvironmentDefinition
        from wandrun.integrations.shell_backend import CleanupUnconfirmedError
        from wandrun.runtime import environments

        class Connection:
            def get_extra_info(self, name):
                return "user"

        @asynccontextmanager
        async def connect(*args, **kwargs):
            yield Connection()

        class Backend:
            async def aclose(self):
                raise CleanupUnconfirmedError("unconfirmed: call-1")

        async def start(*args, **kwargs):
            return Backend()

        async def sync(*args):
            raise ValueError("skills sync failed")

        definition = EnvironmentDefinition(type="ssh", host="example", workdir="/w")
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(environments.asyncssh, "connect", connect), \
                patch.object(environments.SSHBackend, "start", start), \
                patch.object(environments, "_sync_skills", sync):
            with self.assertRaisesRegex(ValueError, "skills sync failed") as raised:
                async with environments.open_ssh("vps", definition, Workspace(Path(directory)), set()):
                    self.fail("opening must fail")
        self.assertTrue(any("call-1" in note for note in raised.exception.__notes__))


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


class SSHBuiltinEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_remote_builtin_source_is_separate_and_is_a_startup_snapshot(self):
        from wandrun.config import EnvironmentDefinition
        from wandrun.integrations.shell_backend import ManagedShellBackend
        from wandrun.integrations.ssh_backend import _PREPARE, remote_script
        from wandrun.runtime import environments
        from wandrun.runtime.agents import _ConfiguredSkillsMiddleware

        class Connection:
            def get_extra_info(self, name):
                return "test-user"

            async def run(self, command, *, check):
                result = subprocess.run(command, shell=True, text=True, capture_output=True, check=False)
                return SimpleNamespace(exit_status=result.returncode, stderr=result.stderr)

        @asynccontextmanager
        async def connect(*args, **kwargs):
            yield Connection()

        class Backend(ManagedShellBackend):
            async def aclose(self):
                self.close()

        async def start(connection, *, workdir, **kwargs):
            result = await connection.run(remote_script(_PREPARE, workdir), check=False)
            if result.exit_status:
                raise RuntimeError(result.stderr)
            return Backend(root_dir=Path(workdir), virtual_mode=False)

        class SFTP:
            async def put(self, sources, target, *, recurse, preserve):
                for source in sources:
                    shutil.copytree(source, Path(target) / Path(source).name)

        @asynccontextmanager
        async def sftp_client(connection):
            yield SFTP()

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
            (builtin / "display.md").write_text("snapshot-731\n", encoding="utf-8")
            remote_root = root / "remote"
            definition = EnvironmentDefinition(type="ssh", host="fake", workdir=str(remote_root))
            with patch.object(environments.asyncssh, "connect", connect), \
                    patch.object(environments.SSHBackend, "start", start), \
                    patch.object(environments, "sftp_client", sftp_client):
                async with open_ssh("remote", definition, workspace, {"wandrun-ui"}, builtin_source) as environment:
                    self.assertNotEqual(environment.skills_source, environment.builtin_skills_source)
                    self.assertEqual(environment.synced_skills, frozenset({"wandrun-ui"}))
                    selected = _ConfiguredSkillsMiddleware(
                        environment.backend, ("wandrun-ui",), environment.skills_source,
                        builtin_source=environment.builtin_skills_source,
                        builtin_names=environment.builtin_skills,
                    )
                    metadata = await selected.abefore_agent({}, None, {})
                    self.assertEqual(metadata["skills_metadata"][0]["description"], "Remote builtin")
                    self.assertEqual(
                        metadata["skills_metadata"][0]["path"],
                        f"{environment.builtin_skills_source}/wandrun-ui/SKILL.md",
                    )
                    detail = environment.backend.read(
                        f"{environment.builtin_skills_source}/wandrun-ui/display.md",
                    )
                    self.assertIsNone(detail.error)
                    self.assertIn("snapshot-731", detail.file_data["content"])
                    (builtin / "display.md").write_text("changed on host\n", encoding="utf-8")
                    self.assertIn(
                        "snapshot-731", environment.backend.read(
                            f"{environment.builtin_skills_source}/wandrun-ui/display.md",
                        ).file_data["content"],
                    )
                    self.assertIn(
                        "User text.", environment.backend.read(
                            f"{environment.skills_source}/wandrun-ui/SKILL.md",
                        ).file_data["content"],
                    )
            self.assertIn("User text.", user.read_text())
            with patch.object(environments.asyncssh, "connect", connect), \
                    patch.object(environments.SSHBackend, "start", start), \
                    patch.object(environments, "sftp_client", sftp_client):
                async with open_ssh("remote", definition, workspace, {"wandrun-ui"}) as environment:
                    self.assertIsNone(environment.builtin_skills_source)
                    self.assertEqual(environment.builtin_skills, frozenset())
                    self.assertFalse((remote_root / ".wandrun" / "builtin-skills" / "wandrun-ui").exists())
                    self.assertIn(
                        "User text.", environment.backend.read(
                            f"{environment.skills_source}/wandrun-ui/SKILL.md",
                        ).file_data["content"],
                    )

if __name__ == "__main__":
    unittest.main()
