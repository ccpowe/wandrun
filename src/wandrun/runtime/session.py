"""统一装配并持有一次进程内运行；不解释终端命令、HTTP 或评测终态。"""

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from tempfile import TemporaryDirectory

import pydantic_monty as pm
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.runtime.agents import AgentAssembly, build_agents, create_models, run_conversation
from wandrun.runtime.capabilities import CAPABILITY_DEFINITIONS, EntryCapabilityDefinition
from wandrun.integrations.codex_subscription import ModelRequestBudget, ReasoningEffort
from wandrun.integrations.codex_credentials import CodexCredentials
from wandrun.config import (
    AgentCatalog, load_config, load_config_for_catalog, validate_catalog, validate_mcp_servers,
)
from wandrun.integrations.mcp import MCPConnectionError, MCPConnectionPool, select_mcp_tools
from wandrun.integrations.mcp_oauth import ConnectorOAuth
from wandrun.runtime.tool_search import ToolNamespace
from wandrun.metrics import RunMetrics
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.runtime.environments import Environment, open_environments
from wandrun.runtime.files import ResolvedAttachment, TaskFiles, _current_task
from wandrun.runtime.scheduler_store import SchedulerStore, paired_store_path
from wandrun.runtime.memory import MemoryStore
from wandrun.runtime.browser import BrowserLeases
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.workers import WorkerManager
from wandrun.runtime.workspace import Workspace


@dataclass
class Runtime:
    """已启动的运行句柄；图与连接由运行时持有，prepare 后才允许入口持久化新目录。"""

    workers: WorkerManager
    # 供网关删除对话线程；持有期与运行时相同，不能在退出后使用。
    checkpointer: AsyncSqliteSaver
    main_agent: str | None
    agent_models: dict[str, dict[str, str | None]]
    mcp: MCPConnectionPool
    _assembly_for: Callable[[str], AgentAssembly]
    default_environment: str = "local"
    files: TaskFiles | None = None
    _prepare_agents: Callable[[AgentCatalog, Mapping[str, int] | None, frozenset[str]], Awaitable[Callable[[], None]]] | None = None
    _prepare_connectors: Callable[[dict[str, dict], dict[str, str]], Callable[[], None]] | None = None
    _refresh_mcp: Callable[[str], Awaitable[None]] | None = None
    # 是否还有待交付结果的后台执行；入口据此判断等待中的任务是否仍有工作在进行（ADR-0017）。
    processes_pending: Callable[[], bool] = lambda: False
    browser: BrowserLeases | None = None
    memory: MemoryStore | None = None

    async def compaction_events(self, task_id: str) -> list[dict]:
        """读取图恢复后的压缩事件（含 pending writes）；未登记任务或已移除角色返回空列表。"""
        if not self.workers.has_task(task_id):
            return []
        agent = self.workers.agent_name(task_id)
        if agent not in self.agent_models:
            return []
        graph = self._assembly_for(agent).graph
        snapshot = await graph.aget_state(conversation_config(task_id))
        return snapshot.values.get("compaction_events", [])


    async def prepare_agents(
        self, catalog: AgentCatalog, *, model_context_windows: Mapping[str, int] | None = None,
    ) -> Callable[[], None]:
        """Prepare candidate graphs and optional refreshed model windows before persistence.

        Commit synchronously after persisting the new catalog. Existing turns keep their
        graph and capability decisions; rebuilt graphs publish both together on commit.
        """
        if self._prepare_agents is None:
            raise RuntimeError("此运行时不支持动态 Agent 目录")
        return await self._prepare_agents(catalog, model_context_windows, frozenset())

    async def refresh_mcp(self, identity: str) -> None:
        """Rebuild committed referring graphs when one service gains or loses tools."""
        if self._refresh_mcp is None:
            raise RuntimeError("此运行时不支持动态 MCP 工具")
        await self._refresh_mcp(identity)

    def prepare_connectors(
        self, servers: dict[str, dict], descriptions: dict[str, str],
    ) -> Callable[[], None]:
        """Validate connection/description definitions against current Agent references.

        Commit updates definitions used for future prepares. Changed live connection
        parameters require restart; descriptions are metadata used by newly built
        graphs, while existing graphs keep their previous directory text.
        """
        if self._prepare_connectors is None:
            raise RuntimeError("此运行时不支持动态连接器目录")
        return self._prepare_connectors(servers, descriptions)


async def _browser_notify(manager: WorkerManager | None, task_id: str, text: str, interrupt: bool) -> None:
    """Interrupt only the owner's current execution on takeover, preserving its task."""
    if manager is not None:
        manager.notify(task_id, {"browser_control": {
            "status": "taken_over" if interrupt else "handed_back", "note": text,
        }}, interrupt=interrupt)


class RuntimeCleanupError(RuntimeError):
    """清理超过调用方的等待阈值；资源安全收拢后再报告，不提前释放活跃依赖。"""


async def _shutdown(manager, environments, stack, metrics) -> None:
    unconfirmed: list[CleanupUnconfirmedError] = []
    try:
        operations = []
        if manager is not None:
            # close 首先停止接收输入、取消任务；后端关闭禁止新进程启动并终止现有命令。
            operations.append(manager.close())
        operations.extend(
            asyncio.to_thread(environment.backend.close) for environment in environments
        )
        operations.extend(
            environment.processes.aclose()
            for environment in environments
            if environment.processes is not None
        )
        results = await asyncio.gather(*operations, return_exceptions=True)
        # 远端环境关闭时汇总的未确认调用（ADR-0014）：所有环境的都要报告，作为一次清理失败交给入口。
        unconfirmed += [result for result in results if isinstance(result, CleanupUnconfirmedError)]
        for result in results:
            if isinstance(result, BaseException) and not isinstance(result, CleanupUnconfirmedError):
                if unconfirmed:
                    result.add_note("；".join(str(item) for item in unconfirmed))
                raise result
        if unconfirmed:
            raise RuntimeCleanupError("；".join(str(item) for item in unconfirmed)) from unconfirmed[0]
    finally:
        try:
            # Worker 和命令收尾后，才释放环境以及它们仍可能使用的 MCP 和检查点（ADR-0012 释放顺序）。
            await stack.aclose()
        except BaseException as error:
            if unconfirmed:  # 释放资源的失败不能覆盖已收集的远端清理事实
                error.add_note("远端清理未确认：" + "；".join(str(item) for item in unconfirmed))
            raise
        finally:
            metrics.write_summary()


async def _finish_shutdown(manager, environments, stack, metrics, timeout) -> None:
    closing = asyncio.create_task(_shutdown(manager, environments, stack, metrics))
    cancelled = False
    timed_out = False
    try:
        await asyncio.wait_for(asyncio.shield(closing), timeout)
        return
    except TimeoutError:
        if closing.done():
            closing.result()  # 底层自身的异常不是等待阈值超时。
        timed_out = True
    except asyncio.CancelledError:
        cancelled = True
    # 断开调用者的等待不能使后台清理失去所有者；再次取消也不截断资源释放。
    while not closing.done():
        try:
            await asyncio.shield(closing)
        except asyncio.CancelledError:
            cancelled = True
    closing.result()
    if cancelled:
        raise asyncio.CancelledError
    if timed_out:
        raise RuntimeCleanupError(f"清理超过 {timeout:g} 秒；资源已完成清理")


def _stage_builtin_skills(source: Path, skills: Mapping[str, Mapping[str, str]]) -> None:
    """Materialize caller-owned skill content for this runtime only; never write user skills."""
    for name, files in skills.items():
        if not name or name in {".", ".."} or "/" in name or "\\" in name:
            raise ValueError(f"无效的内置 skill 名称: {name!r}")
        if "SKILL.md" not in files:
            raise ValueError(f"内置 skill {name} 缺少 SKILL.md")
        for filename, content in files.items():
            parts = filename.split("/")
            if any(part in {"", ".", ".."} for part in parts) or "\\" in filename:
                raise ValueError(f"无效的内置 skill 文件路径: {filename!r}")
            destination = source.joinpath(name, *parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(content, encoding="utf-8")


@asynccontextmanager
async def open_runtime(
    workspace: Workspace,
    *,
    metrics: RunMetrics,
    on_human: Callable[[str, str, list[ResolvedAttachment], str | None], None],
    on_preview: Callable[[str, dict], list[dict] | None] | None = None,
    entry_capabilities: Sequence[EntryCapabilityDefinition] = (),
    agents_config: Path | None = None,
    agent_catalog: AgentCatalog | None = None,
    mcps_config: Path | None = None,
    mcp_servers: dict[str, dict] | None = None,
    mcp_descriptions: dict[str, str] | None = None,
    mcp_oauth: ConnectorOAuth | None = None,
    oauth_connectors: set[str] | None = None,
    environments_config: Path | None = None,
    checkpoint_path: Path | None = None,
    model_name: str | None = None,
    reasoning_effort: ReasoningEffort | None = None,
    model_timeout: float = 60,
    model_max_retries: int = 0,
    max_model_requests: int | None = None,
    credentials: CodexCredentials | None = None,
    cleanup_timeout: float | None = None,
    on_update: Callable[[str, dict], None] | None = None,
    model_context_windows: Mapping[str, int] | None = None,
    on_compaction: Callable[[str, dict], None] | None = None,
    on_task: Callable[[str, str, str | None], None] | None = None,
    on_task_created: Callable[[str, str, str, str], None] | None = None,
    on_task_message: Callable[[str, str, str, list[ResolvedAttachment]], None] | None = None,
    notify_human_of_roots: bool = True,
    conversation_workdirs: bool = False,
) -> AsyncIterator[Runtime]:
    """打开工作区运行时，退出时收拢全部任务、工具进程、连接并保存统计。

    执行环境按 environments.toml 由本上下文打开和释放，入口不构造 backend（ADR-0012）。
    metrics 由入口预先创建，以便启动失败时也能报告本次运行及其最终统计。
    entry_capabilities 声明入口中间件、内置技能和至多一份 human 投递策略；不解释格式。
    回调同步接收输出，不负责路由；on_update 同时携带 task_id，供入口决定如何展示。
    on_task 报告每次执行的启动与结算；自己聚合状态的入口（网关）同时传 notify_human_of_roots=False，
    根任务结束时不再经 on_human 发运行时通知。
    on_task_created(task_id, creator_task_id, agent_id, summary) 与
    on_task_message(sender_task_id, recipient_task_id, text, attachments) 仅报告已接收的协作事实，
    不影响调度；状态仍走 on_task。所有回调可省略，终端/headless 无需记录展示会话。
    cleanup_timeout 是超限报告阈值而非强制遗弃资源的期限；超限仍等待安全释放。
    Agent 默认来自 agents.toml（agents_config）；传 agent_catalog 时改用调用方给出的定义（网关从数据库提供），
    此时不读 agents.toml，两者互斥。MCP 可以来自 mcps_config 文件或 mcp_servers 数据库快照
    （相互排斥）；mcp_descriptions 单独作为可搜索服务目录元数据验证。环境仍读文件。
    每个实例拥有独立的 Manager 和请求预算。调度状态保存在与检查点成对的 <检查点文件名>.scheduler.sqlite，
    启动时恢复协作关系并停止旧执行，由用户逐级恢复（ADR-0008）。
    入口能力在 Manager/TaskFiles 创建后按配置的环境类型绑定一次；返回的工厂为每张图创建
    中间件，捕获的工具闭包在同环境类型的初建和动态重建之间共享，不加入 MCP/Code Mode 目录。
    model_context_windows 提供订阅目录当前窗口，角色显式配置优先；无窗口只禁用压缩并记录警告。
    on_compaction(task_id, event) 报告失败和检查点提交后的成功压缩事件。
    入口声明的全部内置技能在打开环境前物化到独立临时目录；各角色只加载已启用能力的技能。
    内置名称优先于同名用户选择：只替换实际发现来源，不修改用户文件或持久化的 skills 配置。
    本机临时路径重启后会变化；技能刷新同时比较内容与环境内路径，避免检查点继续公布已清理的路径。
    """
    stack = AsyncExitStack()
    manager = None
    browser = None
    tracing = None
    failure = None
    environments: list[Environment] = []
    try:
        entry_capabilities = tuple(entry_capabilities)
        builtin_skills = {}
        validate_human = None
        capability_ids = {item.id for item in CAPABILITY_DEFINITIONS}
        for capability in entry_capabilities:
            if capability.id in capability_ids:
                raise ValueError(f"能力 id 重复：{capability.id}")
            capability_ids.add(capability.id)
            for name, content in capability.builtin_skills.items():
                if name in builtin_skills:
                    raise ValueError(f"内置 skill 声明重复：{name}")
                builtin_skills[name] = content
            if capability.validate_human is not None:
                if validate_human is not None:
                    raise ValueError("入口能力只能声明一份 human 投递策略")
                validate_human = capability.validate_human
        if mcp_servers is not None and mcps_config is not None:
            raise ValueError("mcps_config 与 mcp_servers 只能给一个")
        if agent_catalog is None:
            config = load_config(
                agents_config or workspace.agents_config,
                mcps_config if mcp_servers is None else None,
                environments_config,
                mcp_servers=mcp_servers, mcp_descriptions=mcp_descriptions,
            )
        elif agents_config is not None:
            raise ValueError("agents_config 与 agent_catalog 只能给一个")
        else:
            config = load_config_for_catalog(
                agent_catalog,
                mcps_config or workspace.mcps_config if mcp_servers is None else None,
                environments_config or workspace.environments_config,
                mcp_servers=mcp_servers, mcp_descriptions=mcp_descriptions,
            )
        credentials = credentials if credentials is not None else CodexCredentials()
        traced_oauth_ids = frozenset(config.mcp_servers)
        if os.environ.get("LANGSMITH_TRACING", "").lower() == "true":
            from wandrun.integrations.codex_credentials import CredentialError
            from wandrun.runtime.tracing import RuntimeTracing

            tracing = RuntimeTracing(secret_source=lambda: tuple(
                secret for identity in traced_oauth_ids
                for secret in (mcp_oauth.secret_values(identity) if mcp_oauth is not None else ())
            ))
            tracing.remember_connectors(config.mcp_servers)
            try:
                tracing.remember_credentials(credentials.peek())
            except CredentialError:
                pass  # Preserve the normal model invocation's credential error.
        browser_settings = [
            environment.browser for environment in config.environments.values()
            if environment.browser is not None
        ]
        browser = BrowserLeases(
            browser_settings[0], state_path=workspace.state_dir / "browser-leases.json",
            notify=lambda task_id, text, interrupt: _browser_notify(
                manager, task_id, text, interrupt,
            ),
        ) if browser_settings else None
        if browser is not None:
            await browser.start()
            stack.push_async_callback(browser.aclose)
        checkpoint = checkpoint_path or workspace.checkpoint_path
        memory = MemoryStore(workspace.memory_dir)
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        checkpointer = await stack.enter_async_context(
            AsyncSqliteSaver.from_conn_string(str(checkpoint))
        )
        store = SchedulerStore(paired_store_path(checkpoint))
        stack.callback(store.close)
        builtin_source = None
        if builtin_skills:
            builtin_source = Path(stack.enter_context(TemporaryDirectory(prefix="wandrun-builtin-skills-")))
            _stage_builtin_skills(builtin_source, builtin_skills)
        role_environments = await open_environments(
            config, workspace, stack, environments, include_default=agent_catalog is not None,
            builtin_source=builtin_source,
        )
        mcp = await stack.enter_async_context(MCPConnectionPool(oauth=mcp_oauth))
        mcp.oauth_connectors = set(oauth_connectors or ())
        used = sorted({
            server for role in config.agents.values()
            for server in (*role.mcp_servers, *role.searchable_mcp_servers)
        })
        opened = await asyncio.gather(*(
            mcp.open(server, config.mcp_servers[server]) for server in used
        ))
        by_server = dict(zip(used, opened))
        tools, searchable_tools = {}, {}
        for name, role in config.agents.items():
            tools[name], searchable_tools[name] = select_mcp_tools(role, by_server)
        code_pool = None
        if any(role.code_mode for role in config.agents.values()):
            # 在 MCP 之后进入资源栈，因此先于 MCP 关闭；Worker 由 Manager 先行收拢（ADR-0010）。
            code_pool = await stack.enter_async_context(pm.AsyncMonty())
        request_budget = ModelRequestBudget(max_model_requests) if max_model_requests is not None else None
        models = create_models(
            config.agents,
            model_name=model_name,
            reasoning_effort=reasoning_effort,
            model_timeout=model_timeout,
            request_budget=request_budget,
            credentials=credentials,
        )
        context_windows = dict(model_context_windows or {})
        role_roots = {
            name: (
                role.environment,
                str(workspace.root) if config.environments[role.environment].type == "local"
                else config.environments[role.environment].workdir,
            )
            for name, role in config.agents.items()
        }
        files = TaskFiles(
            workspace.root, None, role_roots, conversation_workdirs=conversation_workdirs,
            remote_backends={
                name: role_environments[name].backend for name, role in config.agents.items()
                if config.environments[role.environment].type == "ssh"
            },
        )

        browser_environments = frozenset(
            name for name, environment in config.environments.items()
            if environment.browser is not None
        )

        async def run_worker(prompts, task_id):
            name = manager.agent_name(task_id)
            assembly = agents.get(name)
            if assembly is None:
                raise ValueError(f"Agent 已删除: {name}")
            role_browser = assembly.capabilities.browser
            if role_browser is not None:
                root = manager.root_of(task_id)
                role_browser.register(task_id, root, name, manager.agent_name(root))
            await files.prepare(task_id)
            token = _current_task.set(task_id)
            try:
                with metrics.agent_scope(task_id, name):
                    return await run_conversation(
                        assembly.graph, prompts, task_id, name,
                        on_update=(lambda chunk: on_update(task_id, chunk)) if on_update else None,
                        on_compaction=on_compaction,
                    )
            finally:
                _current_task.reset(token)
        manager = WorkerManager(
            tracing.wrap_worker(run_worker, lambda: manager) if tracing is not None else run_worker,
            on_human=on_human,
            on_preview=on_preview,
            validate_human=validate_human,
            agent_workers={name: role.workers for name, role in config.agents.items()},
            default_agent=config.main_agent,
            store=store,
            on_task=on_task,
            on_task_created=on_task_created,
            on_task_message=on_task_message,
            attachment_resolver=files.resolve_attachments,
            attachment_preflight=files.prepare_attachments,
            notify_human_of_roots=notify_human_of_roots,
        )
        manager.bind_memory(memory)
        files.manager = manager
        entry_middleware_factories = {
            kind: {
                capability.id: capability.prepare_middleware(manager, files, kind)
                for capability in entry_capabilities
            }
            for kind in {env.type for env in config.environments.values()}
        }
        tables = [env.processes for env in environments if env.processes is not None]
        for table in tables:
            manager.add_stop_hook(table.stop_owners)
        if browser is not None:
            async def close_browser_tasks(scope):
                await asyncio.gather(*(browser.close_task(task_id, reason="任务结束") for task_id in scope))
            manager.add_cancel_hook(close_browser_tasks)
        searchable = {
            name: [
                ToolNamespace(server, config.mcp_descriptions[server], tuple(server_tools))
                for server, server_tools in servers.items()
            ]
            for name, servers in searchable_tools.items()
        }
        def build_catalog(
            catalog_config, catalog_models, catalog_tools, catalog_namespaces,
            catalog_environments, catalog_windows, *, graph_names=None,
        ):
            """Initial and candidate assemblies share all entry/resource bindings."""
            return build_agents(
                manager, definitions=catalog_config.agents, models=catalog_models,
                tools=catalog_tools,
                entry_capabilities=entry_capabilities,
                entry_middleware_factories=entry_middleware_factories,
                environments=catalog_environments, graph_names=graph_names,
                checkpointer=checkpointer, searchable=catalog_namespaces,
                model_max_retries=model_max_retries, code_pool=code_pool, memory=memory, files=files,
                browser=browser, browser_environments=browser_environments,
                model_context_windows=catalog_windows, on_compaction=on_compaction,
            )

        agents = build_catalog(
            config, models, tools, searchable, role_environments, context_windows,
        )

        async def prepare_agents(
            catalog: AgentCatalog, refreshed_windows: Mapping[str, int] | None,
            forced_servers: frozenset[str],
        ) -> Callable[[], None]:
            """Prepare candidate graphs without publishing definitions or refreshed windows yet."""
            nonlocal config, agents, models, by_server, context_windows, code_pool
            candidate_windows = dict(refreshed_windows) if refreshed_windows is not None else context_windows
            candidate = validate_catalog(catalog, config)
            by_name = {environment.name: environment for environment in environments}
            for name, definition in candidate.agents.items():
                previous = config.agents.get(name)
                if previous is None:
                    if definition.environment != config.default_environment:
                        raise ValueError(f"新 Agent {name} 只能使用默认执行环境")
                elif definition.environment != previous.environment:
                    raise ValueError(f"Agent {name} 的 environment 不能在运行时改变")
                environment = by_name.get(definition.environment)
                if environment is None:
                    raise ValueError(f"执行环境尚未打开: {definition.environment}")
                if environment.synced_skills is not None:
                    missing = set(definition.skills) - environment.synced_skills - environment.builtin_skills
                    if missing:
                        raise ValueError(f"远端环境 {environment.name} 尚未同步技能：{', '.join(sorted(missing))}")
            referenced = {
                server for definition in candidate.agents.values()
                for server in (*definition.mcp_servers, *definition.searchable_mcp_servers)
            }
            # A cutover invalidates definitions even while no Agent references the service.
            candidate_by_server = {
                server: tools for server, tools in by_server.items() if server not in forced_servers
            }
            missing = sorted(referenced - candidate_by_server.keys())

            async def open_candidate(server: str):
                try:
                    return await mcp.open(server, candidate.mcp_servers[server])
                except MCPConnectionError:
                    if server not in forced_servers or not mcp.release_confirmed(server):
                        raise
                    return []  # An auth/transport cutover must not leave stale tools in a live graph.

            opened = await asyncio.gather(*(open_candidate(server) for server in missing))
            candidate_by_server.update(zip(missing, opened))
            candidate_tools, candidate_searchable = {}, {}
            for name, definition in candidate.agents.items():
                candidate_tools[name], candidate_searchable[name] = select_mcp_tools(
                    definition, candidate_by_server,
                )
            if code_pool is None and any(definition.code_mode for definition in candidate.agents.values()):
                # Pool belongs to the runtime, even if this candidate is later abandoned.
                code_pool = await stack.enter_async_context(pm.AsyncMonty())
            candidate_namespaces = {
                name: [
                    ToolNamespace(server, candidate.mcp_descriptions[server], tuple(server_tools))
                    for server, server_tools in selected.items()
                ]
                for name, selected in candidate_searchable.items()
            }
            changed = {
                name for name, definition in candidate.agents.items()
                if definition != config.agents.get(name)
            }
            # 目录中包含成员的显示身份与说明：即使调用方自身未编辑，也须重建图。
            directory_changed = {
                name for name in changed
                if name in config.agents and (
                    config.agents[name].name != candidate.agents[name].name
                    or config.agents[name].description != candidate.agents[name].description
                )
            }
            rebuild = changed | {
                name for name, definition in candidate.agents.items()
                if set(definition.workers) & directory_changed
            }
            rebuild.update(
                name for name, definition in candidate.agents.items()
                if name in config.agents and definition.context_window is None
                and context_windows.get(models[name].model_name) != candidate_windows.get(
                    model_name or definition.model
                )
            )
            rebuild.update(
                name for name, definition in candidate.agents.items()
                if forced_servers & set((*definition.mcp_servers, *definition.searchable_mcp_servers))
            )
            replacement_models = create_models(
                {name: candidate.agents[name] for name in changed},
                model_name=model_name, reasoning_effort=reasoning_effort,
                model_timeout=model_timeout, request_budget=request_budget,
                credentials=credentials,
            )
            candidate_models = {**models, **replacement_models}
            candidate_models = {name: candidate_models[name] for name in candidate.agents}
            candidate_environments = {
                name: by_name[definition.environment] for name, definition in candidate.agents.items()
            }
            replacement_assemblies = build_catalog(
                candidate, candidate_models, candidate_tools, candidate_namespaces,
                candidate_environments, candidate_windows, graph_names=tuple(rebuild),
            )
            # Reuse whole assemblies, not just graphs; prepare never mutates committed decisions.
            candidate_assemblies = {
                name: replacement_assemblies[name] if name in replacement_assemblies else agents[name]
                for name in candidate.agents
            }
            candidate_workers = {name: role.workers for name, role in candidate.agents.items()}
            manager._check_agent_workers(candidate_workers, candidate.main_agent)

            def commit() -> None:
                nonlocal config, agents, models, by_server, context_windows
                candidate_roots = {
                    name: (
                        role.environment,
                        str(workspace.root) if candidate.environments[role.environment].type == "local"
                        else candidate.environments[role.environment].workdir,
                    )
                    for name, role in candidate.agents.items()
                }
                files.update_environments(candidate_roots, {
                    name: candidate_environments[name].backend
                    for name, role in candidate.agents.items()
                    if candidate.environments[role.environment].type == "ssh"
                })
                manager.replace_agent_workers(candidate_workers, candidate.main_agent)
                config, agents, models, by_server, context_windows = (
                    candidate, candidate_assemblies, candidate_models, candidate_by_server, candidate_windows,
                )
                runtime.main_agent = candidate.main_agent
                runtime.agent_models = {
                    name: {"model": model.model_name, "reasoning_effort": model.reasoning_effort}
                    for name, model in candidate_models.items()
                }

            return commit

        async def refresh_mcp(identity: str) -> None:
            commit = await prepare_agents(config.catalog, None, frozenset({identity}))
            commit()

        def prepare_connectors(
            servers: dict[str, dict], descriptions: dict[str, str],
        ) -> Callable[[], None]:
            nonlocal config
            checked_servers, checked_descriptions = validate_mcp_servers(servers, descriptions)
            candidate = validate_catalog(
                config.catalog,
                replace(config, mcp_servers=checked_servers, mcp_descriptions=checked_descriptions),
            )

            def commit() -> None:
                nonlocal config, traced_oauth_ids
                if tracing is not None:
                    tracing.remember_connectors(checked_servers)
                    traced_oauth_ids = traced_oauth_ids | checked_servers.keys()
                config = candidate

            return commit

        runtime = Runtime(
            workers=manager,
            checkpointer=checkpointer,
            main_agent=config.main_agent,
            agent_models={
                name: {
                    "model": model.model_name,
                    "reasoning_effort": model.reasoning_effort,
                }
                for name, model in models.items()
            },
            _assembly_for=lambda name: agents[name],
            default_environment=config.default_environment,
            mcp=mcp,
            _prepare_connectors=prepare_connectors,
            _refresh_mcp=refresh_mcp,
            _prepare_agents=prepare_agents,
            processes_pending=lambda: any(table.pending() for table in tables),
            browser=browser,
            memory=memory,
            files=files,
        )
        yield runtime
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            await _finish_shutdown(manager, environments, stack, metrics, cleanup_timeout)
        except RuntimeCleanupError as error:
            if failure is None:
                raise
            # 超限仅说明清理耗时，不能覆盖启动/执行错误或调用者的取消。
            failure.add_note(str(error))
        finally:
            # Debug uploads are not execution resources: a slow cloud must not turn
            # a successful headless task into cleanup_failed.
            if tracing is not None:
                await tracing.aclose()
