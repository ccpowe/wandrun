"""执行环境：backend 之外的打开、准备与释放（ADR-0012）。

角色的文件工具、execute、Code Mode 的 backend 函数和 skills 读取都经过所绑定环境的 backend。
环境由运行时按配置打开，同一环境被多个角色引用时只打开一次；入口不构造 backend。
"""

import posixpath
from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from pathlib import Path
from dataclasses import dataclass
from typing import Literal

from deepagents.backends.protocol import SandboxBackendProtocol

from wandrun.config import BrowserDefinition, EnvironmentDefinition, RuntimeConfig
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.integrations.local_processes import ProcessTable
from wandrun.integrations.remote_processes import RemoteProcessTable
from wandrun.integrations.shell_backend import CleanupUnconfirmedError, ManagedShellBackend
from wandrun.runtime.execution.workspace import Workspace
from wandrun.runtime.execution.skills import SkillPackages


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
    # 当前运行时快照的补充说明，不进入可变的系统提示前缀。
    description: str | None = None
    # 执行表负责后台句柄、结果交付和 owner 停止。
    processes: ProcessTable | RemoteProcessTable | None = None
    # Startup snapshot of all entry declarations; graphs select their enabled subset.
    builtin_skills_source: str | None = None
    builtin_skills: frozenset[str] = frozenset()
    type: Literal["local", "instabox"] = "local"
    skill_packages: SkillPackages | None = None
    # Stable workspace namespace; never inferred from a temporary backend object ID.
    workspace_root: str | None = None
    # Configuration only; observation must never wake or probe the machine.
    browser: BrowserDefinition | None = None

    def context_identity(self) -> dict[str, str]:
        """Describe execution placement without preparing or querying the backend."""
        root = self.workspace_root
        if root is None:
            root = posixpath.dirname(posixpath.dirname(self.artifacts_root))
            if self.type == "local":
                root = str(getattr(self.backend, "cwd", root))
        return {
            "type": self.type,
            "location": "local" if self.type == "local" else self.backend.id,
            "workspace": str(Path(root).resolve()) if self.type == "local" else posixpath.normpath(root),
        }


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
            workspace_root=str(workspace.root),
            browser=definition.browser,
        )
    finally:
        try:
            await processes.aclose()  # 幂等；运行时通常已在收拢 Worker 时关闭过。
        finally:
            backend.close()


@asynccontextmanager
async def open_instabox(
    name: str, definition: EnvironmentDefinition, workspace: Workspace,
    builtin_source: Path | None = None,
) -> AsyncIterator[Environment]:
    """Bind an existing machine without contacting it; actual backend I/O prepares it."""
    root = definition.workdir
    packages_root = posixpath.join(root, ".wandrun", "skill-packages")
    packages = SkillPackages(workspace.skills_dir, builtin_source, packages_root)
    backend = InstaboxBackend(
        machine_id=definition.machine_id, api_key_env=definition.api_key_env, workdir=root,
        timeout=definition.command_timeout, termination_grace=definition.termination_grace,
        prepare_skills=packages.prepare,
    )
    try:
        yield Environment(
            name, backend, packages.skills_source,
            posixpath.join(root, ".wandrun", "artifacts"),
            description=(
                f"执行环境：文件、终端命令和技能脚本在 Instabox 远端机器上运行，工作区是 {root}。"
                "实际访问才准备或恢复环境；恢复不代表机器已重启，旧执行和服务状态可能需要检查。"
                "技能副本用于读取和执行；正式修改在网关进行，不自动回传。"
            ),
            processes=backend.processes,
            builtin_skills_source=packages.builtin_skills_source,
            builtin_skills=frozenset(
                path.name for path in builtin_source.iterdir()
            ) if builtin_source is not None else frozenset(),
            type="instabox", skill_packages=packages,
            workspace_root=root,
            browser=definition.browser,
        )
    finally:
        try:
            await backend.aclose()
        except BaseException as error:
            if packages.pending_staging:
                error.add_note("技能临时目录清理未确认：" + "、".join(packages.pending_staging))
            raise
        if packages.pending_staging:
            raise CleanupUnconfirmedError("技能临时目录清理未确认：" + "、".join(packages.pending_staging))


def environment_identity(name: str, definition: EnvironmentDefinition) -> tuple[str, str]:
    """Aliases of one cloud instance borrow one resource owner, cwd namespace and execution table."""
    return definition.type, definition.machine_id if definition.type == "instabox" else name


async def open_environments(
    config: RuntimeConfig, workspace: Workspace, stack: AsyncExitStack, opened: list[Environment],
    *, include_default: bool = False, builtin_source: Path | None = None,
) -> dict[str, Environment]:
    """打开被角色引用的环境，返回 角色 → 环境。

    每打开一个就追加到 opened，启动中途失败时调用方也能关闭已打开的 backend。
    """
    by_name: dict[str, Environment] = {}
    instances: dict[tuple[str, str], Environment] = {}
    names = dict.fromkeys(definition.environment for definition in config.agents.values())
    if include_default:
        names.setdefault(config.default_environment, None)
    for name in names:
        settings = config.environments[name]
        identity = environment_identity(name, settings)
        if identity in instances:
            by_name[name] = instances[identity]
            continue
        if settings.type == "instabox":
            opening = open_instabox(name, settings, workspace, builtin_source)
        else:
            opening = open_local(name, settings, workspace, builtin_source)
        environment = await stack.enter_async_context(opening)
        opened.append(environment)
        instances[identity] = environment
        by_name[name] = environment
    return {role: by_name[definition.environment] for role, definition in config.agents.items()}
