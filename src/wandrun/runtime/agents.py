"""根据角色配置组装 Agent 图；通信协议和执行机制由运行时维护。"""

from collections.abc import Callable, Collection, Mapping, Sequence
from copy import copy as _copy
from dataclasses import dataclass, replace
from hashlib import sha256
from types import MappingProxyType
from itertools import chain
import logging
from pathlib import PurePosixPath
from typing import Annotated, NotRequired

from deepagents.backends import CompositeBackend
from deepagents.backends.protocol import LsResult
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.skills import (
    SKILLS_SYSTEM_PROMPT, SkillsMiddleware, _skill_metadata_from_response,
)
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRetryMiddleware, wrap_model_call
from langchain.agents.middleware.types import PrivateStateAttr
from langchain.agents.structured_output import ProviderStrategy
from langchain_core.messages import AnyMessage
from langgraph.channels import DeltaChannel
from langgraph.channels.binop import _get_overwrite
from langgraph.graph.message import add_messages
from langgraph.pregel._messages import (
    _messages_delta_reducer as _framework_messages_delta_reducer,
)
from langgraph.graph.state import CompiledStateGraph

from wandrun.runtime.conversations import conversation_config, prepare_conversation_input
from wandrun.integrations.codex_subscription import (
    TOOL_SEARCH,
    CodexSubscriptionModel,
    ModelRequestBudget,
    ReasoningEffort,
    is_retryable_model_error,
)
from wandrun.integrations.codex_credentials import CodexCredentials
from wandrun.config import AgentDefinition
from wandrun.runtime.messages import AgentOutput
from wandrun.runtime.files import TaskBackend, TaskFiles, TaskPathMiddleware
from wandrun.runtime.process_tools import CommandMiddleware
from wandrun.runtime.code_mode import CodeModeCatalog, CodeModeMiddleware
from wandrun.runtime.environments import Environment
from wandrun.runtime.compaction import CompactionMiddleware, CompactionState
from wandrun.runtime.compaction_archive import CompactionArchive
from wandrun.runtime.tool_search import ToolNamespace, ToolSearchMiddleware
from wandrun.runtime.memory import MemoryStore
from wandrun.runtime.memory_runtime import MemoryMiddleware
from wandrun.runtime.workers import CommunicationMiddleware
from wandrun.runtime.browser import BrowserLeases
from wandrun.runtime.browser_tools import BrowserTakeoverMiddleware
from wandrun.runtime.capabilities import (
    EntryCapabilityDefinition, ResolvedCapabilities, resolve_capabilities,
)

logger = logging.getLogger(__name__)
COMMUNICATION = """
你在 Wandrun 中工作。文件搜索、读取、修改和命令执行使用普通工具；所有交流通过
结构化输出 messages 和 next，不能把需要投递的正文只写在普通最终回答里。

通信规则：
- to 是协作目录中的 Agent id；task_id=null 创建新任务，已有 task_id 向该任务发信。
  to 必须匹配目标任务绑定的 Agent，不能改变它的身份。
- 同事看不到你的历史。委派时只给出目标、必要证据、范围、依赖和验收标准，
  不复制整个对话，不让对方重复已完成的探索。
- 以运行时注入的身份为准，回信使用来信中的 to 和 task_id。被委派的任务完成、受阻
  或需要决定时，用结构化消息回复创建者；只结束本轮（done）不会通知对方。
- attachments 是交付的原文件路径数组，无附件时为 []；不列草稿，相对路径基于发送任务
  工作目录。同环境成员可共享文件；SSH 与本机 human 跨环境不能通过路径传文件，不会自动复制。
- 回执分别报告文字投递和逐附件结果；accepted 只表示运行时接收、投递的结果：
  true 接收、false 拒绝、null 未知，不表示工作完成。null 时不要自动重发，先按回执提示判断。
  已成功的消息或附件不要重发，部分失败只纠正失败项。无消息时 messages 为 []。
- 普通 commentary 进度说明不投递；需发送的内容必须写入结构化 messages（commentary 或最终阶段）。
  每次完整响应的结构化消息合并后按顺序立即投递，不等工具或本轮结束；
  同一收件人不覆盖，每条 task_id=null 创建独立任务。空列表不撤销旧消息，新来信不撤回已投递消息。
- 同时调用工具时使用 next=continue。运行时先投递消息，再执行工具并继续模型调用；
  此时 wait/done 不会跳过工具。投递回执和期间收到的来信在下一次模型调用前提供。
- 没有工具调用时，next=continue 表示还有可立即推进的独立工作；next=wait 等待来信
  或必要输入，不保证等到子任务完成；next=done 表示根据当前信息本轮完成。
  wait/done 都可由新来信唤醒；成功回执不唤醒，投递失败会反馈纠正。不要用 continue 轮询或空转。
- to=human 时 task_id 必须为 null。已知信息足以行动时直接推进；只有缺少无法通过
  探索获得的必要信息才请求澄清。

执行约定：
- 同一根任务的成员使用其对话默认目录，其他对话的工作区仍可显式访问。其他任务可能
  同时修改文件；遵守分配范围，不覆盖或回退他人修改，发现冲突先协调，基于当前状态继续。
- 先理解背景与相关约定，采用解决问题所需的最小改动，避免无关工作。
- 用能证明结果的检查来验证，区分已验证、推测和未验证；不宣称未运行的检查已通过。
  外部操作失败或中断后先查状态，避免重复执行副作用。
""".strip()


_FILE_TOOLS = ("ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep")


def create_models(
    definitions: Mapping[str, AgentDefinition],
    *,
    model_name: str | None = None,
    reasoning_effort: ReasoningEffort | None = None,
    model_timeout: float = 60,
    max_model_requests: int | None = None,
    request_budget: ModelRequestBudget | None = None,
    credentials: CodexCredentials | None = None,
) -> dict[str, CodexSubscriptionModel]:
    """显式运行参数覆盖角色配置；所有角色和重试共用一次运行的请求预算。"""
    budget = request_budget if request_budget is not None else (
        ModelRequestBudget(max_model_requests) if max_model_requests is not None else None
    )
    credentials = credentials if credentials is not None else CodexCredentials()
    return {
        name: CodexSubscriptionModel(
            model_name=definition.model if model_name is None else model_name,
            reasoning_effort=(
                definition.reasoning_effort
                if reasoning_effort is None
                else reasoning_effort
            ),
            timeout=model_timeout,
            request_budget=budget,
            credentials=credentials,
        )
        for name, definition in definitions.items()
    }


class _SelectedSkillsBackend:
    """Restrict each skill source to this role's configured names or runtime builtins."""

    def __init__(self, backend, sources: Mapping[str, tuple[str, ...]]):
        self._backend = backend
        self._names = {source: set(names) for source, names in sources.items()}

    def _select(self, path: str, result: LsResult) -> LsResult:
        if result.entries is None:
            return result  # Preserve backend errors for the middleware's warning.
        directories = {
            PurePosixPath(item["path"]).name: item
            for item in result.entries
            if item["is_dir"]
        }
        missing = self._names[path] - directories.keys()
        if missing:
            raise ValueError(f"未找到配置的 skill: {', '.join(sorted(missing))}")
        return LsResult(entries=[
            item for item in result.entries
            if item["is_dir"] and PurePosixPath(item["path"]).name in self._names[path]
        ])

    def ls(self, path: str) -> LsResult:
        return self._select(path, self._backend.ls(path))

    async def als(self, path: str) -> LsResult:
        return self._select(path, await self._backend.als(path))

    def download_files(self, paths):
        return self._backend.download_files(paths)

    async def adownload_files(self, paths):
        return await self._backend.adownload_files(paths)


class _ConfiguredSkillsMiddleware(SkillsMiddleware):
    """Refresh skill metadata at turn boundaries; builtin names override user selections.

    Selection precedence changes only discovery, not the user's files or configuration.
    Fingerprints include environment paths because local builtin directories change on restart;
    identical bytes must not retain a checkpoint's now-deleted SKILL.md path.
    """

    def __init__(
        self, backend, names: tuple[str, ...], source: str, *,
        builtin_source: str | None = None, builtin_names: Collection[str] = (),
    ):
        reserved = set(builtin_names) if builtin_source is not None else set()
        self._sources = {source: tuple(name for name in names if name not in reserved)}
        if builtin_source is not None and reserved:
            self._sources[builtin_source] = tuple(sorted(reserved))
        self._selection = [name for selected in self._sources.values() for name in selected]
        super().__init__(
            backend=_SelectedSkillsBackend(backend, self._sources),
            sources=[source for source, selected in self._sources.items() if selected],
            system_prompt=SKILLS_SYSTEM_PROMPT if self._selection else None,
        )

    async def abefore_agent(self, state, runtime, config):
        # Read through the environment backend: SSH skills remain the startup snapshot until
        # the environment is reopened, even if the host's source files have changed.
        paths = [
            str(PurePosixPath(source) / name / "SKILL.md")
            for source, names in self._sources.items() for name in names
        ]
        responses = await self._backend.adownload_files(paths) if paths else []
        # A new runtime may stage identical content at a different local path. Refresh the
        # persisted metadata in that case, but keep SSH paths tied to their startup snapshot.
        fingerprints = [
            f"{path}:sha256:{sha256(response.content).hexdigest()}"
            if response.error is None and response.content is not None
            else f"{path}:error:{response.error or 'missing_content'}"
            for path, response in zip(paths, responses, strict=True)
        ]
        if (
            state.get("skills_selection") == self._selection
            and state.get("skills_fingerprints") == fingerprints
            and "skills_metadata" in state
        ):
            return None
        if not self._selection:
            return {
                "skills_metadata": [], "skills_load_errors": [],
                "skills_selection": [], "skills_fingerprints": [],
            }
        # Parse each already-fingerprinted file independently. Deep Agents 0.7.13's
        # bulk loader lets YAML RecursionError escape and abort otherwise valid skills.
        # Keep its metadata parser, but turn this file-level failure into a model warning.
        skills = {}
        errors = []
        listings = {}
        for source, names in self._sources.items():
            if not names:
                continue
            listing = await self._backend.als(source)
            listings[source] = listing
            if listing.error:
                errors.append(f"Cannot load skills from '{source}': {listing.error}")
        for path, response in zip(paths, responses, strict=True):
            source = str(PurePosixPath(path).parent.parent)
            if listings[source].entries is None:
                continue
            try:
                skill = _skill_metadata_from_response(response, str(PurePosixPath(path).parent), path)
            except RecursionError:
                errors.append(f"Cannot load skill '{path}': SKILL.md 头部 YAML 嵌套过深")
                continue
            if skill is not None:
                skills[skill["name"]] = skill
        return {
            "skills_metadata": list(skills.values()),
            "skills_load_errors": errors,
            "skills_selection": self._selection,
            "skills_fingerprints": fingerprints,
        }


def display_identity(agent_id: str, definition: AgentDefinition) -> str:
    """模型可读的身份；协议中的 to/thread_id 始终只使用 agent_id。"""
    return f"{agent_id}（{definition.name}）" if definition.name and definition.name != agent_id else agent_id


def _system_prompt(name: str, definitions: Mapping[str, AgentDefinition]) -> str:
    definition = definitions[name]
    if definition.workers:
        directory = "你只能向以下 Agent 创建协作任务（每个 Agent 可创建多个任务）：\n"
        directory += "\n".join(
            f"- {display_identity(target, definitions[target])}：{definitions[target].description}"
            for target in definition.workers
        )
        directory += (
            "\n你委派的任务可能随你一起被上级停止。运行时反馈中 cause=stopped_with_parent 表示该任务"
            "已停止，不会再回复，也不会自动继续。你再次被激活时，以上级的新消息为准："
            "需要原任务继续，就向原 task_id 发消息恢复它（保留其历史与未处理输入）；"
            "要求已改变，就用 task_id=null 重新委派；不再需要则不必处理。"
            "已停止的任务只能由创建它的上级恢复。"
        )
    else:
        directory = "你不能创建其他协作任务。"
    directory += "\ncancel_worker 只能选择自己创建且不再需要的直接子任务，取消会覆盖其全部后代并等待清理。"
    directory += "\n这不限制向已知任务回信；回复使用来信中的 to 和 task_id。"
    return "\n\n".join(
        (COMMUNICATION, definition.system_prompt, f"当前 Agent 身份：{display_identity(name, definition)}\n{directory}")
    )


MESSAGE_SNAPSHOT_FREQUENCY = 20
# Lower values add full snapshots; higher values reduce writes but increase replay work.


# LangGraph's message-ID preprocessor recognizes its reducer by identity. Keep that
# reducer on the channel so raw message-like inputs are normalized before writes are
# persisted, while the channel below supplies the full add_messages behavior.
def _messages_delta_reducer(
    state: list[AnyMessage], writes: Sequence[object],
) -> list[AnyMessage]:
    """Apply add_messages semantics to each persisted DeltaChannel write batch."""
    flattened = [
        item
        for write in writes
        for item in (write if isinstance(write, list) else [write])
    ]
    return add_messages(state, flattened)


class _MessageDeltaChannel(DeltaChannel):
    """DeltaChannel with full add_messages semantics and framework ID stamping."""

    __slots__ = ()

    def __init__(
        self,
        reducer=_framework_messages_delta_reducer,
        typ=None,
        *,
        snapshot_frequency: int = 1000,
    ):
        super().__init__(
            _framework_messages_delta_reducer,
            typ,
            snapshot_frequency=snapshot_frequency,
        )

    def update(self, values: Sequence[object]) -> bool:
        if not values:
            return False
        if any(_get_overwrite(value)[0] for value in values):
            return super().update(values)
        state = self.get() if self.is_available() else []
        self.value = _messages_delta_reducer(state, values)
        return True

    def replay_writes(self, writes) -> None:
        values = [value for _, _, value in writes]
        if not values:
            return
        state = self.get() if self.is_available() else []
        start = 0
        for index, value in enumerate(values):
            is_overwrite, overwrite = _get_overwrite(value)
            if is_overwrite:
                state = _copy(overwrite) if overwrite is not None else self.typ()
                start = index + 1
        self.value = (
            _messages_delta_reducer(state, values[start:])
            if start < len(values) else state
        )


def _message_delta_channel(*, snapshot_frequency: int) -> _MessageDeltaChannel:
    return _MessageDeltaChannel(snapshot_frequency=snapshot_frequency)


class ConversationState(CompactionState):
    messages: Annotated[
        list[AnyMessage],
        _message_delta_channel(snapshot_frequency=MESSAGE_SNAPSHOT_FREQUENCY),
    ]
    agent_name: str
    skills_selection: NotRequired[Annotated[list[str], PrivateStateAttr]]
    skills_fingerprints: NotRequired[Annotated[list[str], PrivateStateAttr]]
    memory_version: NotRequired[Annotated[str | None, PrivateStateAttr]]


@wrap_model_call
async def thread_cache_key(request, handler):
    """task_id 与检查点 thread_id 相同；只设置本次请求，不修改共享模型。"""
    return await handler(
        request.override(
            model_settings={
                **request.model_settings,
                "prompt_cache_key": request.runtime.context["task_id"],
            }
        )
    )


@dataclass(frozen=True)
class AgentAssembly:
    """A graph and its immutable decisions are selected and published together."""

    graph: CompiledStateGraph
    capabilities: ResolvedCapabilities


def build_agents(
    manager,
    *,
    definitions: Mapping[str, AgentDefinition],
    models,
    graph_names: Sequence[str] | None = None,
    tools,
    environments: Mapping[str, Environment],
    checkpointer,
    entry_capabilities: Sequence[EntryCapabilityDefinition] = (),
    entry_middleware_factories: Mapping[str, Mapping[str, Callable[[], AgentMiddleware]]] | None = None,
    model_max_retries: int = 0,
    searchable: Mapping[str, Sequence[ToolNamespace]] | None = None,
    code_pool=None,
    memory: MemoryStore | None = None,
    files: TaskFiles | None = None,
    browser: BrowserLeases | None = None,
    browser_environments: Collection[str] = (),
    model_context_windows: Mapping[str, int] | None = None,
    on_compaction: Callable[[str, dict], None] | None = None,
) -> dict[str, AgentAssembly]:
    """每个角色一份图与能力解析结果；任务用 thread_id 隔离历史，共享环境 backend。

    environments 给出每个角色的执行环境：文件工具、execute、Code Mode 和 skills 都经过它。

    code_pool 是运行时持有的 Monty 池；启用 code_mode 的角色才有 run_code。
    memory 为宿主上的共享存储；每张图仅绑定自己的 Agent 身份。
    entry_capabilities 是入口的稳定声明；entry_middleware_factories 按环境类型绑定运行实例工具，
    每个已启用能力为本图创建中间件；不加入 MCP/Code Mode 目录。
    model_context_windows 是可见模型目录的当前窗口；角色显式窗口覆盖目录，同名模型切换随图重建解析。
    缺可信窗口时仅禁用压缩，不禁用对话。on_compaction 在失败时由中间件报告。
    每个初建/候选图只解析一次条件；未重建的角色由调用方复用原装配。
    browser 与 browser_environments 分别提供原资源 owner 和配置了浏览器的环境名称；
    角色的技能选择在解析时决定，工具、backend 和执行前注册共用该结果。
    """
    if model_max_retries < 0:
        raise ValueError("model_max_retries 不能小于 0")
    agents = {}
    for name in (graph_names if graph_names is not None else definitions):
        definition = definitions[name]
        environment = environments[name]
        namespaces = (searchable or {}).get(name, ())
        capabilities = resolve_capabilities(
            definition, environment, memory=memory, files=files, searchable=namespaces,
            browser=browser, browser_environments=browser_environments,
            entry_capabilities=entry_capabilities,
        )
        role_browser = capabilities.browser
        backend = environment.backend
        memory_middleware = MemoryMiddleware(memory, name) if capabilities.enabled("memory") else None
        if memory_middleware is not None:
            backend = memory_middleware.wrap_backend(backend)
        if capabilities.enabled("task_path"):
            backend = TaskBackend(
                backend, lambda task_id, role=name: files.directory(task_id, role), browser=role_browser,
            )
        # 无路由的组合 backend 只用来指定内部产物根目录；文件操作和 execute 原样交给环境 backend。
        filesystem = FilesystemMiddleware(
            backend=CompositeBackend(
                default=backend, routes={}, artifacts_root=environment.artifacts_root
            ),
            # 有后台执行表的环境用 exec_command 代替同步 execute（ADR-0017）。
            tools=list(_FILE_TOOLS) if capabilities.enabled("processes") else None,
        )
        role_tools = tools[name]
        middleware = []
        installed_tools: dict[str, tuple[str, ...]] = {}

        def install(capability_id: str, item: AgentMiddleware) -> None:
            middleware.append(item)
            installed_tools[capability_id] = tuple(tool.name for tool in (getattr(item, "tools", ()) or ()))

        if memory_middleware is not None:
            install("memory", memory_middleware)
        middleware.extend([CommunicationMiddleware(manager), thread_cache_key])
        middleware.append(_ConfiguredSkillsMiddleware(
            backend, tuple(skill for skill in definition.skills if skill not in environment.builtin_skills),
            environment.skills_source,
            builtin_source=environment.builtin_skills_source,
            builtin_names={
                skill for capability in entry_capabilities if capabilities.enabled(capability.id)
                for skill in capability.builtin_skills
            },
        ))
        if capabilities.enabled("tool_search"):
            install("tool_search", ToolSearchMiddleware(namespaces))
        if capabilities.enabled("task_path"):
            middleware.append(TaskPathMiddleware(files))
        install("files", filesystem)
        if capabilities.enabled("processes"):
            install("processes", CommandMiddleware(
                manager, environment.processes, files=files, browser=role_browser,
            ))
        if capabilities.enabled("browser"):
            install("browser", BrowserTakeoverMiddleware(manager, role_browser))
        if capabilities.enabled("code_mode"):
            if code_pool is None:
                raise ValueError(f"Agent {name} 启用了 code_mode，但没有提供 Monty 池")
            # 脚本只能调用本角色的 MCP 工具（直接携带与可搜索目录）和 backend 函数。
            install("code_mode", CodeModeMiddleware(
                code_pool, backend, CodeModeCatalog(tools[name], namespaces),
            ))
        for capability in entry_capabilities:
            if capabilities.enabled(capability.id):
                install(capability.id, (entry_middleware_factories or {})[environment.type][capability.id]())
        primary_model = models[name]
        primary_model_name = getattr(primary_model, "model_name", definition.model)
        resolved_window = definition.context_window
        if resolved_window is None:
            resolved_window = (model_context_windows or {}).get(primary_model_name)
        if resolved_window is None:
            logger.warning("Agent %s 的模型 %s 缺少可信 context_window；自动压缩已禁用",
                           name, primary_model_name)
        summary_model = (
            CodexSubscriptionModel(
                model_name=definition.compaction_model,
                reasoning_effort=primary_model.reasoning_effort,
                timeout=primary_model.timeout,
                request_budget=primary_model.request_budget,
                credentials=primary_model.credentials,
            )
            if definition.compaction_model is not None else None
        )
        middleware.extend([
            CompactionMiddleware(
                context_window=resolved_window,
                keep_tokens=definition.compaction_keep_tokens,
                summary_model=summary_model,
                memory=memory_middleware,
                archive=CompactionArchive(environment.artifacts_root, environment.backend),
                on_compaction=(
                    (lambda task_id, event, role=name: on_compaction(task_id, {"agent_name": role, **event}))
                    if on_compaction is not None else None
                ),
            ),
            ModelRetryMiddleware(
                max_retries=model_max_retries,
                retry_on=is_retryable_model_error,
                on_failure="error",
                initial_delay=1.0,
                backoff_factor=2.0,
                max_delay=4.0,
                jitter=True,
            ),
        ])
        # 框架会静默覆盖同名工具；在它收集工具前检查全部图级声明，不含搜索目录。
        seen = set()
        for role_tool in chain(
            chain.from_iterable(getattr(item, "tools", ()) for item in middleware), role_tools,
        ):
            if role_tool.name in seen:
                raise ValueError(f"Agent {name} 的工具名重复：{role_tool.name}")
            seen.add(role_tool.name)
        if capabilities.enabled("tool_search") and TOOL_SEARCH in seen:
            # 原生声明与同名函数并存时，模型侧语义有歧义。
            raise ValueError(f"Agent {name} 的工具 {TOOL_SEARCH} 与按需搜索冲突")
        graph = create_agent(
            model=models[name],
            tools=role_tools,
            system_prompt="\n\n".join(
                part for part in (
                    _system_prompt(name, definitions), environment.description,
                ) if part
            ),
            response_format=ProviderStrategy(
                AgentOutput.model_json_schema(), strict=True
            ),
            state_schema=ConversationState,
            checkpointer=checkpointer,
            middleware=middleware,
        )
        # Freeze names from the constructed middleware, not a second tool ownership table.
        # Native tool_search has no middleware.tools; its client declaration stays native.
        capabilities = replace(capabilities, entries=MappingProxyType({
            capability_id: replace(entry, tools=installed_tools.get(capability_id, ()))
            for capability_id, entry in capabilities.entries.items()
        }))
        agents[name] = AgentAssembly(graph, capabilities)
    return agents


async def run_conversation(agent, prompts, task_id, agent_name, *, on_update=None, on_compaction=None):
    """执行至本轮停止；只从已同步检查点通知新压缩事件，失败通知由中间件直接发送。"""
    config = conversation_config(task_id)
    snapshot = await agent.aget_state(config)
    saved_agent = snapshot.values.get("agent_name")
    if saved_agent is not None and saved_agent != agent_name:
        raise ValueError(f"历史绑定 {saved_agent}，不能以 {agent_name} 执行")
    reported = {event["event_id"] for event in snapshot.values.get("compaction_events", [])}

    def report_events(saved):
        for event in saved.values.get("compaction_events", []):
            if event["event_id"] in reported:
                continue
            if on_compaction is not None:
                on_compaction(task_id, {"status": "completed", "agent_name": agent_name, **event})
            else:
                logger.info("任务 %s（Agent %s）上下文压缩完成：%s",
                            task_id, agent_name, event["event_id"])
            reported.add(event["event_id"])

    inputs = await prepare_conversation_input(agent, config, prompts)
    inputs["agent_name"] = agent_name
    try:
        async for chunk in agent.astream(
            inputs,
            config=config,
            context={"task_id": task_id, "compaction_attempts": 0},
            stream_mode="updates",
            version="v2",
            durability="sync",
        ):
            if "compaction_events" in (chunk.get("data", {}).get("model") or {}):
                # Updates may precede the write: final/exception paths check again.
                report_events(await agent.aget_state(config))
            if on_update is not None:
                on_update(chunk)
    except BaseException:
        report_events(await agent.aget_state(config))
        raise
    snapshot = await agent.aget_state(config)
    report_events(snapshot)
    return AgentOutput.model_validate(snapshot.values.get("structured_response"))
