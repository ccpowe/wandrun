"""执行环境：backend 之外的打开、准备与释放（ADR-0012）。

角色的文件工具、execute、Code Mode 的 backend 函数和 skills 读取都经过所绑定环境的 backend。
环境由运行时按配置打开，同一环境被多个角色引用时只打开一次；入口不构造 backend。
"""

import posixpath
from collections.abc import AsyncIterator, Collection
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from dataclasses import dataclass
from typing import Literal

import asyncssh
from deepagents.backends.protocol import SandboxBackendProtocol

from wandrun.config import EnvironmentDefinition, RuntimeConfig
from wandrun.integrations.local_processes import ProcessTable
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.integrations.ssh_backend import SSHBackend, remote_script, sftp_client
from wandrun.runtime.workspace import Workspace


@dataclass(frozen=True)
class Environment:
    """已打开的环境。

    backend.close() 停止接收命令并终止进行中的命令，由运行时在收拢 Worker 时调用；
    环境本身的释放（以后的远端暂停、断开）由打开它的上下文在之后完成。
    """

    name: str
    backend: SandboxBackendProtocol
    # 用户 skills 目录；文件工具与 execute 可访问它和独立的内置目录。
    skills_source: str
    # 文件系统中间件的内部产物（大工具结果、过长消息）落盘的根目录，须在环境中可写。
    # deepagents 默认用 "/"，真实路径下会指向系统根目录而写入失败。
    artifacts_root: str
    # 追加到角色系统提示词的环境说明；本机环境不需要。
    description: str | None = None
    # 后台执行表（ADR-0017）：有它的环境以 exec_command/kill_process 代替同步 execute。
    # 目前只有本机环境；远端保留同步 execute，等远端设计完成。
    processes: ProcessTable | None = None
    # SSH 只在打开时同步；prepare_agents 可同步确认新引用是否确实已在远端。
    synced_skills: frozenset[str] | None = None
    # Startup snapshot of all entry declarations; graphs select their enabled subset.
    builtin_skills_source: str | None = None
    builtin_skills: frozenset[str] = frozenset()
    type: Literal["local", "ssh"] = "local"


@asynccontextmanager
async def open_local(
    name: str, definition: EnvironmentDefinition, workspace: Workspace,
    builtin_source: Path | None = None,
) -> AsyncIterator[Environment]:
    """本机环境：根目录是 workspace，使用真实路径，skills 就在 workspace 中，无需同步。"""
    backend = ManagedShellBackend(
        root_dir=workspace.root,
        # 虚拟路径只作用于文件工具，execute 看到的仍是真实路径，两者会错位；也不是安全隔离。
        virtual_mode=False,
        inherit_env=True,
        timeout=definition.command_timeout,
        termination_grace=definition.termination_grace,
    )
    artifacts = workspace.runtime_dir / "artifacts"
    processes = ProcessTable(
        cwd=workspace.root,
        log_dir=artifacts / "processes",
        termination_grace=definition.termination_grace,
    )
    try:
        yield Environment(
            name, backend, str(workspace.skills_dir), str(artifacts), processes=processes,
            builtin_skills_source=str(builtin_source) if builtin_source is not None else None,
            builtin_skills=(
                frozenset(path.name for path in builtin_source.iterdir())
                if builtin_source is not None else frozenset()
            ),
        )
    finally:
        try:
            await processes.aclose()  # 幂等；运行时通常已在收拢 Worker 时关闭过。
        finally:
            backend.close()


@asynccontextmanager
async def open_ssh(
    name: str, definition: EnvironmentDefinition, workspace: Workspace, skills: Collection[str],
    builtin_source: Path | None = None,
) -> AsyncIterator[Environment]:
    """远端主机：一条连接；启动会话并分别同步用户和内置 skills；退出时关闭会话再断开。"""
    options = {"port": definition.port} if definition.port is not None else {}
    if definition.user is not None:
        options["username"] = definition.user
    async with asyncssh.connect(definition.host, keepalive_interval=30, **options) as connection:
        label = f"{connection.get_extra_info('username')}@{definition.host}"
        workdir = definition.workdir
        backend = await SSHBackend.start(
            connection,
            label=label,
            workdir=workdir,
            timeout=definition.command_timeout,
            termination_grace=definition.termination_grace,
        )
        try:
            skills_dir = posixpath.join(workdir, ".wandrun", "skills")
            await _sync_skills(connection, workspace.skills_dir, skills_dir, skills)
            builtin_dir = posixpath.join(workdir, ".wandrun", "builtin-skills")
            builtin_names = (
                frozenset(path.name for path in builtin_source.iterdir())
                if builtin_source is not None else frozenset()
            )
            # Also clear an earlier gateway snapshot when a later runtime has no builtins.
            await _sync_skills(connection, builtin_source, builtin_dir, builtin_names)
            environment = Environment(
                name,
                backend,
                skills_dir,
                posixpath.join(workdir, ".wandrun", "artifacts"),
                description=(
                    f"执行环境：文件工具、execute 和 skill 脚本都在远端主机 {label} 上运行，"
                    f"不在用户本机。环境工作区是 {workdir}；"
                    "相对路径和命令以当前任务默认目录为准（网关对话有独立目录），"
                    "也可使用该主机上的绝对路径。"
                ),
                synced_skills=frozenset(skills),
                builtin_skills_source=builtin_dir if builtin_source is not None else None,
                builtin_skills=builtin_names,
                type="ssh",
            )
        except BaseException as error:
            # 打开中途失败：保留原始错误，关闭会话时的清理问题只作为附注。
            try:
                await backend.aclose()
            except Exception as cleanup:
                error.add_note(f"关闭远端会话时：{cleanup}")
            raise
        try:
            yield environment
        finally:
            await backend.aclose()  # 只报告一次；运行时通常已在收拢 Worker 时关闭过。


# 重建远端 skills 目录；会话启动前已拒绝被链接到别处的 .wandrun、skills 和 builtin-skills。先恢复写权限：
# 上传保留了宿主权限，只读目录会使下次清空失败。
# 只恢复目录的写权限（删除目录项只需要它）：chmod -R 会改到与树外文件硬链接的普通文件。
_WRITABLE_DIRS = 'find "$1" -type d -exec chmod u+w {} +'
_RESET_SKILLS = _WRITABLE_DIRS + ' 2>/dev/null; rm -rf "$1" && mkdir "$1"'


async def _sync_skills(connection, source_dir: Path | None, target: str, names: Collection[str]) -> None:
    """宿主 source_dir 是唯一来源：清空远端目录后整体上传；不回写，不支持符号链接。"""
    sources = [source_dir / name for name in sorted(names)] if source_dir is not None else []
    sources = [path for path in sources if path.is_dir()]  # 缺少的 skill 由 skills 中间件报告
    for source in sources:
        links = [path for path in [source, *source.rglob("*")] if path.is_symlink()]
        if links:
            raise ValueError(f"skills 不支持符号链接，无法同步到远端：{links[0]}")
    result = await connection.run(remote_script(_RESET_SKILLS, target), check=False)
    if result.exit_status != 0:
        raise RuntimeError(f"无法重建远端 skills 目录 {target}: {result.stderr}")
    if sources:
        async with sftp_client(connection) as sftp:
            await sftp.put([str(path) for path in sources], target, recurse=True, preserve=True)
        result = await connection.run(remote_script(_WRITABLE_DIRS, target), check=False)
        if result.exit_status != 0:
            raise RuntimeError(f"无法调整远端 skills 目录权限 {target}: {result.stderr}")


async def open_environments(
    config: RuntimeConfig, workspace: Workspace, stack: AsyncExitStack, opened: list[Environment],
    *, include_default: bool = False, builtin_source: Path | None = None,
) -> dict[str, Environment]:
    """打开被角色引用的环境，返回 角色 → 环境。

    每打开一个就追加到 opened，启动中途失败时调用方也能关闭已打开的 backend。
    """
    by_name: dict[str, Environment] = {}
    names = dict.fromkeys(definition.environment for definition in config.agents.values())
    if include_default:
        names.setdefault(config.default_environment, None)
    for name in names:
        settings = config.environments[name]
        if settings.type == "ssh":
            # 动态目录的同步 prepare 无 await：目录来源预同步当前全部本机技能。
            if include_default:
                skills = {
                    path.name for path in workspace.skills_dir.iterdir() if path.is_dir()
                } if workspace.skills_dir.exists() else set()
            else:
                skills = {
                    skill for role in config.agents.values()
                    if role.environment == name for skill in role.skills
                }
            opening = open_ssh(name, settings, workspace, skills, builtin_source)
        else:
            opening = open_local(name, settings, workspace, builtin_source)
        environment = await stack.enter_async_context(opening)
        opened.append(environment)
        by_name[name] = environment
    return {role: by_name[definition.environment] for role, definition in config.agents.items()}
