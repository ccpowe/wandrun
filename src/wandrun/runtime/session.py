"""统一装配并持有一次进程内运行；不解释终端命令、HTTP 或评测终态。"""

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from tempfile import TemporaryDirectory

import pydantic_monty as pm
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.runtime.agent.agents import AgentAssembly, build_agents, create_models, run_conversation
from wandrun.runtime.agent.capabilities import CAPABILITY_DEFINITIONS, EntryCapabilityDefinition
from wandrun.integrations.codex_subscription import ModelRequestBudget, ReasoningEffort
from wandrun.integrations.codex_credentials import CodexCredentials
from wandrun.config import (
    AgentCatalog, EnvironmentDefinition, load_config, load_config_for_catalog, validate_catalog, validate_mcp_servers,
)
from wandrun.integrations.mcp import MCPConnectionError, MCPConnectionPool, select_mcp_tools
from wandrun.integrations.mcp_oauth import ConnectorOAuth
from wandrun.runtime.agent.tool_search import ToolNamespace
from wandrun.metrics import RunMetrics
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations import cleanup
from wandrun.runtime.execution.environments import (
    Environment, environment_identity, open_environments, open_instabox, open_local,
)
from wandrun.runtime.execution.files import ResolvedAttachment, TaskFiles, _current_task
from wandrun.runtime.communication.scheduler_store import SchedulerStore, paired_store_path
from wandrun.runtime.context.environment_runtime import recovery_feedback_applies
from wandrun.runtime.context.memory import MemoryStore
from wandrun.runtime.browser.leases import BrowserLeases, BrowserRejected, UnknownBrowserTask
from wandrun.runtime.browser.cdp import CDPError
from wandrun.runtime.agent.conversations import conversation_config
from wandrun.runtime.communication.workers import WorkerManager
from wandrun.runtime.execution.workspace import Workspace


@dataclass(frozen=True)
class StopClaims:
    """Admission's sealed snapshot; execution may only await these exact owners."""

    scope: frozenset[str]
    results: dict[str, asyncio.Future]
    files: asyncio.Future | None = None

    def subset(self, scope: set[str]) -> "StopClaims":
        return StopClaims(frozenset(scope), {task: self.results[task] for task in scope})


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
    # Management ignores historical remote cleanup debt; these expose real activity.
    agent_tasks_pending: Callable[[str], list[str]] = lambda agent: []
    file_transfers_pending: Callable[[str], bool] = lambda agent: False
    _stop_commands: Callable[[set[str]], Awaitable[list[str]]] | None = None
    _local_resources_pending: Callable[[set[str]], bool] = lambda owners: False
    # Configuration aliases borrow the same physical environment's browser owner.
    browsers: dict[str, BrowserLeases] = field(default_factory=dict)
    on_browser_event: Callable[[str, dict], None] | None = None
    memory: MemoryStore | None = None
    environment_definitions: dict[str, EnvironmentDefinition] = field(default_factory=dict)
    # The actual task identity owns its stop result across overlapping Agent batches.
    # A new execution (no longer stopped) starts a fresh lifecycle.
    _task_stops: dict[str, tuple[cleanup.CleanupOperation, asyncio.Future]] = field(default_factory=dict)
    _stop_drivers: set[asyncio.Task] = field(default_factory=set)

    def claim_stop(
        self, scope: set[str], *, operation: cleanup.CleanupOperation, agent: str | None = None,
    ) -> StopClaims:
        """Publish the whole known range and synchronously revoke Worker dispatch."""
        claims = {}
        created = []
        for task in scope:
            previous = self._task_stops.get(task)
            if previous is not None:
                result = previous[1]
                # Completed reports are remote facts; local failures are not.
                # A later independent admission must recheck local settlement.
                if not result.done() or (
                    self.workers.is_stopped(task) and not result.cancelled() and result.exception() is None
                ):
                    claims[task] = result
                    continue
            future = asyncio.get_running_loop().create_future()
            future.add_done_callback(cleanup._consume)
            self._task_stops[task] = operation, future
            operation.batch.track(operation, future)
            claims[task] = future
            created.append((task, future))
        # No await or eager cleanup is allowed between the snapshot and sealing it.
        self.workers.revoke_tasks(scope)
        for task, future in created:
            for browser in dict.fromkeys(self.browsers.values()):
                browser.claim_task_close(task, operation=operation, reason="任务停止")
            asyncio.get_running_loop().call_soon(self._start_stop, task, future, operation)
        file_stop = None
        if agent is not None and self.files is not None:
            callers = self.files.agent_file_callers(agent)
            async def stop_files():
                await asyncio.sleep(0)
                return await self.files.stop_agent_files(agent, operation=operation, callers=callers)
            file_stop = asyncio.create_task(stop_files())
            operation.batch.track(operation, file_stop)
            self._stop_drivers.add(file_stop)
            file_stop.add_done_callback(self._stop_drivers.discard)
        return StopClaims(frozenset(scope), claims, file_stop)

    def _start_stop(self, task, future, operation):
        async def stop():
            try:
                reports = await self._stop_owned_task(task, operation=operation)
            except BaseException as error:
                future.set_exception(error)
            else:
                future.set_result(reports)
        driver = asyncio.create_task(stop(), name=f"cleanup-task:{task}")
        self._stop_drivers.add(driver)
        driver.add_done_callback(self._stop_drivers.discard)

    def agent_stop_scope(self, agent: str) -> set[str]:
        scope = set()
        for task in self.workers.agent_tasks(agent):
            scope.update(self.workers.branch_threads(task))
        for browser in dict.fromkeys(self.browsers.values()):
            scope.update(browser.owned_tasks(agent))
        return scope

    def conversation_stop_scope(self, conversation: str) -> set[str]:
        scope = self.workers.branch_threads(conversation)
        for browser in dict.fromkeys(self.browsers.values()):
            scope.update(lease["task_id"] for lease in browser.list_tasks()
                         if lease["root_id"] == conversation)
        return scope

    async def _stop_owned_task(self, task: str, *, operation: cleanup.CleanupOperation) -> list[dict]:
        """One owner does remote work once; local Worker settlement stays independent."""
        reports = []
        scope = {task}
        stopping = self.workers.stop_tasks(scope)

        async def finish(awaitable, stage):
            try:
                result = await operation.wait(awaitable)
                if result:
                    reports.append({"stage": stage, "error": "CleanupUnconfirmed"})
            except* (BrowserRejected, CDPError, TimeoutError):
                reports.append({"stage": stage, "error": "CleanupUnconfirmed"})

        operations = [finish(asyncio.shield(stopping), "execution")]
        if self._stop_commands is not None:
            operations.append(finish(self._stop_commands(scope), "execution"))
        operations.append(finish(self.close_browser_tasks(scope, operation=operation), "browser"))
        await asyncio.gather(*operations)
        if reports:
            if self._local_resources_pending(scope):
                raise RuntimeError("本机执行资源尚未释放")
            remote = {
                owner for owner in scope if self.workers.has_task(owner)
                and self.files is not None
                and self.workers.agent_name(owner) in self.files.remote_backends
            }
            self.workers.settle_remote_stop(scope, remote)
        if self.workers.has_task(task):
            agent = self.workers.agent_name(task)
            return [{**report, "agent_id": agent} for report in reports]
        return reports

    async def stop_agent(
        self, agent: str, *, operation: cleanup.CleanupOperation, claims: StopClaims,
    ) -> list[dict]:
        """Await only this admission's sealed owners; never rediscover resources."""
        reports = []
        results = await asyncio.gather(*(asyncio.shield(future) for future in claims.results.values()))
        for result in results:
            for report in result:
                item = {"agent_id": agent, **report}
                if item not in reports:
                    reports.append(item)
        if claims.files is not None:
            reports.extend(await asyncio.shield(claims.files))
        return reports

    async def stop_conversation(
        self, conversation: str, *, operation: cleanup.CleanupOperation, claims: StopClaims,
    ) -> dict:
        """Project the same resource outcomes into the conversation API."""
        results = await asyncio.gather(*(asyncio.shield(future) for future in claims.results.values()))
        reports = []
        for result in results:
            for report in result:
                item = {
                    **report,
                    "stage": "branch" if report["stage"] == "execution" else report["stage"],
                    "task_id": conversation,
                }
                if item not in reports:
                    reports.append(item)
        return {"stopped": sorted(claims.scope), "cleanup_unconfirmed": reports}

    async def close_browser_tasks(
        self, scope: set[str], *, operation: cleanup.CleanupOperation,
    ) -> None:
        """Borrow owner terminals concurrently; never borrow a historical operation."""
        results = await asyncio.gather(*(
            browser.close_task(task, reason="任务停止", operation=operation)
            for browser in dict.fromkeys(self.browsers.values()) for task in scope
        ), return_exceptions=True)
        failures = []
        for result in results:
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, Exception):
                failures.append(result)
        if failures:
            raise ExceptionGroup("浏览器任务关闭未确认", failures)

    def forget_stopped_root(self, conversation: str, *, claims: StopClaims) -> None:
        """Dispose task stop ownership with the actual local task identities."""
        self.workers.forget_stopped_root(conversation)
        for task in claims.scope:
            self._task_stops.pop(task, None)

    def browser_for_lease(self, lease_id: str) -> BrowserLeases:
        """Resolve immutable lease ownership, never the Agent's current environment."""
        for browser in dict.fromkeys(self.browsers.values()):
            try:
                browser.detail(lease_id)
            except UnknownBrowserTask:
                continue
            return browser
        raise UnknownBrowserTask(lease_id)

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


async def _environment_recovered(
    manager: WorkerManager, checkpointer: AsyncSqliteSaver, identity: dict[str, str], note: str,
) -> bool:
    """Durably queue recovery only for threads that last observed this owner.

    Read all checkpoints before enqueueing: cancellation cannot leave a partially
    delivered batch that the backend would duplicate on its next readiness attempt.
    """
    task_id = _current_task.get()
    if task_id is None:
        return False
    manager.ensure_active(task_id)
    owners = [owner for owner in manager.snapshot()["tasks"] if not manager.is_stopped(owner)]
    checkpoints = await asyncio.gather(*(
        checkpointer.aget_tuple(conversation_config(owner)) for owner in owners
    ))
    manager.ensure_active(task_id)
    for owner, checkpoint in zip(owners, checkpoints):
        if checkpoint is None or manager.is_stopped(owner):
            continue
        observed = checkpoint.checkpoint["channel_values"].get("observed_environment")
        if isinstance(observed, dict) and observed.get("identity") == identity:
            manager.add_feedback(owner, {"execution_environment": {
                "identity": identity, "status": "recovered", "note": note,
            }})
    return True


async def _browser_notify(manager: WorkerManager | None, task_id: str, text: str, interrupt: bool) -> None:
    """Interrupt only the owner's current execution on takeover, preserving its task."""
    if manager is not None:
        manager.notify(task_id, {"browser_control": {
            "status": "taken_over" if interrupt else "handed_back", "note": text,
        }}, interrupt=interrupt)


class AgentEnvironmentBusy(ValueError):
    """A proposed cutover would abandon in-flight work or unreleased environment resources."""

    def __init__(self, agent: str):
        self.agent = agent
        super().__init__("Agent 有在途任务或未释放的执行环境资源，不能切换执行环境")


class RuntimeCleanupError(RuntimeError):
    """清理超过调用方的等待阈值；资源安全收拢后再报告，不提前释放活跃依赖。"""


async def _shutdown(manager, environments, stack, metrics, browsers=()) -> None:
    unconfirmed: list[CleanupUnconfirmedError] = []
    try:
        operations = []
        if manager is not None:
            # close 首先停止接收输入、取消任务；后端关闭禁止新进程启动并终止现有命令。
            operations.append(manager.close())
        for environment in environments:
            if environment.type == "instabox":
                # Keep SSH alive until Workers and browser target cleanup settle.
                continue
            else:
                operations.append(asyncio.to_thread(environment.backend.close))
                if environment.processes is not None:
                    operations.append(environment.processes.aclose())
        results = await asyncio.gather(*operations, return_exceptions=True)
        results.extend(await asyncio.gather(
            *(browser.aclose() for browser in browsers), return_exceptions=True,
        ))
        results.extend(await asyncio.gather(*(
            environment.backend.aclose()
            for environment in environments if environment.type == "instabox"
        ), return_exceptions=True))
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


async def _finish_shutdown(manager, environments, stack, metrics, timeout, browsers=()) -> None:
    closing = asyncio.create_task(_shutdown(manager, environments, stack, metrics, browsers))
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
    environment_definitions: Mapping[str, EnvironmentDefinition] | None = None,
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
    runtime: Runtime | None = None
    tracing = None
    failure = None
    environments: list[Environment] = []
    browser_owners: dict[tuple[str, str], BrowserLeases] = {}
    configured_browser_transports: set[tuple[str, str]] = set()
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
                environment_definitions=environment_definitions,
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
        browsers: dict[str, BrowserLeases] = {}
        startup_environment_names = frozenset(config.environments)

        async def prepare_browsers(definitions, agents) -> dict[str, BrowserLeases]:
            """Bind one ledger to each prepared physical owner without waking Instabox.

            Candidate preparation retains its resources until runtime shutdown; it
            never changes an existing lease's environment or transport. Callers select
            startup or adopted environments; cached candidates must not be published.
            The returned aliases become visible only when the candidate commits.
            """
            prepared = {}
            for name, definition in definitions.items():
                if definition.browser is None:
                    continue
                transport = None
                if definition.type == "instabox":
                    transport = next((
                        environment.backend for environment in environments
                        if environment.type == "instabox"
                        and environment.backend.id == f"instabox:{definition.machine_id}"
                    ), None)
                    if transport is None:
                        continue
                identity = (definition.type, definition.machine_id if transport else "local")
                environment_id = f"instabox:{definition.machine_id}" if transport else "local"
                browser = browser_owners.get(identity)
                if browser is None:
                    browser = BrowserLeases(
                        definition.browser,
                        environment_id=environment_id,
                        environment_name=name if transport else "Local",
                        state_path=workspace.state_dir / (
                            f"browser-leases-{definition.machine_id if transport else 'local'}.json"
                        ),
                        transport=transport,
                        on_event=lambda kind, data: (
                            runtime.on_browser_event(kind, data)
                            if runtime is not None and runtime.on_browser_event is not None else None
                        ),
                        notify=lambda task_id, text, interrupt: _browser_notify(
                            manager, task_id, text, interrupt,
                        ),
                    )
                    await browser.start()
                    stack.push_async_callback(browser.aclose)
                    browser_owners[identity] = browser
                elif browser.config != definition.browser:
                    raise ValueError(f"执行环境 {name} 的同一物理机器浏览器配置冲突")
                prepared[name] = browser
                if transport is not None and identity not in configured_browser_transports and any(
                    "browser" in agent.skills
                    and definitions[agent.environment].machine_id == definition.machine_id
                    for agent in agents.values()
                ):
                    environment = next(env for env in environments if env.backend is transport)
                    package, = environment.skill_packages.snapshot(("browser",))
                    transport.configure_browser(
                        definition.browser, browser.connection_lost,
                        start_script=f"{package.root}/scripts/start_browser.py",
                    )
                    configured_browser_transports.add(identity)
            return prepared

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
        browsers.update(await prepare_browsers(config.environments, config.agents))
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
                role_environments[name].name,
                str(workspace.root) if config.environments[role.environment].type == "local"
                else config.environments[role.environment].workdir,
            )
            for name, role in config.agents.items()
        }
        files = TaskFiles(
            workspace.root, None, role_roots, conversation_workdirs=conversation_workdirs,
            remote_backends={
                name: role_environments[name].backend for name, role in config.agents.items()
                if config.environments[role.environment].type != "local"
            },
        )


        async def run_worker(prompts, task_id):
            manager.ensure_active(task_id)
            name = manager.agent_name(task_id)
            assembly = agents.get(name)
            if assembly is None:
                raise ValueError(f"Agent 已删除: {name}")
            role_browser = assembly.capabilities.browser
            if role_browser is not None:
                root = manager.root_of(task_id)
                role_browser.register(task_id, root, name, manager.agent_name(root))
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

        def accept_feedback(task_id, message):
            name = manager.agent_name(task_id)
            environment = role_environments.get(name) if name in config.agents else None
            return recovery_feedback_applies(
                message, environment.context_identity() if environment is not None else None,
            )
        manager = WorkerManager(
            tracing.wrap_worker(run_worker, lambda: manager) if tracing is not None else run_worker,
            on_human=on_human,
            on_preview=on_preview,
            validate_human=validate_human,
            accept_feedback=accept_feedback,
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
        for environment in environments:
            if environment.type == "instabox":
                environment.backend.bind_recovery_feedback(
                    lambda note, identity=environment.context_identity(): _environment_recovered(
                        manager, checkpointer, identity, note,
                    ),
                )
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
        async def close_browser_tasks(scope):
            # Normal Worker cancellation uses the resource owner's existing close
            # (management has already claimed it); there is no implicit request D.
            await asyncio.gather(*(
                browser.close_task(task, reason="任务停止")
                for browser in dict.fromkeys(runtime.browsers.values()) for task in scope
            ))
        manager.add_cancel_hook(close_browser_tasks)
        searchable = {
            name: [
                ToolNamespace(server, config.mcp_descriptions[server], tuple(server_tools))
                for server, server_tools in servers.items()
            ]
            for name, servers in searchable_tools.items()
        }
        def busy_tasks(agent: str) -> list[str]:
            tasks = set(manager.running_tasks(agent))
            for table in tables:
                tasks.update(
                    owner for owner in table.pending_owners()
                    if manager.has_task(owner) and manager.agent_name(owner) == agent
                )
            return sorted(tasks)

        def transfer_pending(agent: str) -> bool:
            if agent in files.pending_transfer_agents():
                return True
            for environment in environments:
                if environment.type != "instabox":
                    continue
                for owner in environment.backend.pending_transfer_owners():
                    if owner is not None and manager.has_task(owner) and manager.agent_name(owner) == agent:
                        return True
            return False

        async def stop_commands(scope):
            reports = []
            for environment in environments:
                table = environment.processes
                if table is None:
                    continue
                result = await table.stop_owners(scope)
                if result and environment.type == "local":
                    raise RuntimeError("本机执行未释放：" + "；".join(result))
                reports.extend(result)
            return reports

        def build_catalog(
            catalog_config, catalog_models, catalog_tools, catalog_namespaces,
            catalog_environments, catalog_windows, catalog_browsers, *, graph_names=None,
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
                browsers=catalog_browsers,
                model_context_windows=catalog_windows, on_compaction=on_compaction,
            )

        agents = build_catalog(
            config, models, tools, searchable, role_environments, context_windows, browsers,
        )

        async def prepare_agents(
            catalog: AgentCatalog, refreshed_windows: Mapping[str, int] | None,
            forced_servers: frozenset[str],
        ) -> Callable[[], None]:
            """Prepare candidate graphs without publishing definitions or refreshed windows yet."""
            nonlocal config, agents, models, by_server, context_windows, code_pool
            candidate_windows = dict(refreshed_windows) if refreshed_windows is not None else context_windows
            candidate = validate_catalog(catalog, replace(
                config, environments={**config.environments, **runtime.environment_definitions},
            ))
            by_identity = {
                environment_identity(environment.name, candidate.environments[environment.name]): environment
                for environment in environments
            }
            by_name = {
                name: by_identity.get(environment_identity(name, definition))
                for name, definition in candidate.environments.items()
            }
            for name, definition in candidate.agents.items():
                previous = config.agents.get(name)
                if (previous is not None and definition.environment != previous.environment
                        and not manager.agent_held(name)):
                    if busy_tasks(name) or transfer_pending(name):
                        raise AgentEnvironmentBusy(name)
                    for browser in browser_owners.values():
                        await browser.revoke_idle_endpoints(name)
                    if (any(browser.pending_tasks(name) for browser in browser_owners.values())
                            or busy_tasks(name) or transfer_pending(name)):
                        raise AgentEnvironmentBusy(name)
                if by_name.get(definition.environment) is None:
                    settings = candidate.environments[definition.environment]
                    identity = environment_identity(definition.environment, settings)
                    environment = by_identity.get(identity)
                    if environment is None:
                        opening = open_instabox if settings.type == "instabox" else open_local
                        environment = await stack.enter_async_context(opening(
                            definition.environment, settings, workspace, builtin_source,
                        ))
                        environments.append(environment)
                        by_identity[identity] = environment
                        if environment.type == "instabox":
                            environment.backend.bind_recovery_feedback(
                                lambda note, identity=environment.context_identity(): _environment_recovered(
                                    manager, checkpointer, identity, note,
                                ),
                            )
                        if environment.processes is not None:
                            tables.append(environment.processes)
                            manager.add_stop_hook(environment.processes.stop_owners)
                    by_name[definition.environment] = environment
                kind = candidate.environments[definition.environment].type
                if kind not in entry_middleware_factories:
                    entry_middleware_factories[kind] = {
                        capability.id: capability.prepare_middleware(manager, files, kind)
                        for capability in entry_capabilities
                    }
            # Retained transports from failed/abandoned candidates are not adoption.
            candidate_browser_names = startup_environment_names | {
                definition.environment for definition in candidate.agents.values()
            }
            candidate_browsers = await prepare_browsers({
                name: definition for name, definition in candidate.environments.items()
                if name in candidate_browser_names
            }, candidate.agents)
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
                if name in config.agents and candidate.environments[definition.environment].browser
                != config.environments[config.agents[name].environment].browser
            )
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
                name: replace(
                    by_name[definition.environment],
                    browser=candidate.environments[definition.environment].browser,
                )
                for name, definition in candidate.agents.items()
            }
            replacement_assemblies = build_catalog(
                candidate, candidate_models, candidate_tools, candidate_namespaces,
                candidate_environments, candidate_windows, candidate_browsers, graph_names=tuple(rebuild),
            )
            # Reuse whole assemblies, not just graphs; prepare never mutates committed decisions.
            candidate_assemblies = {
                name: replacement_assemblies[name] if name in replacement_assemblies else agents[name]
                for name in candidate.agents
            }
            candidate_workers = {name: role.workers for name, role in candidate.agents.items()}
            manager._check_agent_workers(candidate_workers, candidate.main_agent)

            def commit() -> None:
                nonlocal config, agents, models, by_server, context_windows, role_environments
                for name, definition in candidate.agents.items():
                    previous = config.agents.get(name)
                    if (previous is not None and previous.environment != definition.environment
                            and not manager.agent_held(name)):
                        if (busy_tasks(name) or transfer_pending(name)
                                or any(browser.pending_tasks(name) for browser in browser_owners.values())):
                            raise AgentEnvironmentBusy(name)
                candidate_roots = {
                    name: (
                        candidate_environments[name].name,
                        str(workspace.root) if candidate.environments[role.environment].type == "local"
                        else candidate.environments[role.environment].workdir,
                    )
                    for name, role in candidate.agents.items()
                }
                files.update_environments(candidate_roots, {
                    name: candidate_environments[name].backend
                    for name, role in candidate.agents.items()
                    if candidate.environments[role.environment].type != "local"
                })
                manager.replace_agent_workers(candidate_workers, candidate.main_agent)
                config, agents, models, by_server, context_windows, role_environments = (
                    candidate, candidate_assemblies, candidate_models, candidate_by_server,
                    candidate_windows, candidate_environments,
                )
                browsers.update(candidate_browsers)
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
            agent_tasks_pending=busy_tasks,
            file_transfers_pending=transfer_pending,
            _stop_commands=stop_commands,
            _local_resources_pending=lambda scope: any(
                environment.type == "local" and environment.processes is not None
                and bool(environment.processes.pending_owners() & scope)
                for environment in environments
            ),
            browsers=browsers,
            memory=memory,
            files=files,
            environment_definitions=dict(config.environments),
        )
        yield runtime
    except BaseException as error:
        failure = error
        raise
    finally:
        try:
            await _finish_shutdown(
                manager, environments, stack, metrics, cleanup_timeout, tuple(browser_owners.values()),
            )
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
