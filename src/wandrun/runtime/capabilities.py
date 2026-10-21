"""Resolve graph installation once; entry declarations do not own runtime resources."""

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal

from langchain.agents.middleware import AgentMiddleware

from wandrun.config import AgentDefinition
from wandrun.runtime.browser import BrowserLeases
from wandrun.runtime.environments import Environment
from wandrun.runtime.files import ResolvedAttachment, TaskFiles
from wandrun.runtime.memory import MemoryStore
from wandrun.runtime.tool_search import ToolNamespace

if TYPE_CHECKING:
    from wandrun.runtime.workers import WorkerManager


CapabilityStatus = Literal["enabled", "disabled", "not_applicable"]
CapabilityCondition = Literal[
    "always", "memory", "tool_search", "task_path", "processes", "browser", "code_mode",
]


@dataclass(frozen=True)
class CapabilityDefinition:
    """Static identity and resolver condition key; no owned resources or call state."""

    id: str
    display_name: str
    kind: Literal["capability", "mechanism"]
    condition: CapabilityCondition
    summary: str = ""
    description: str = ""


CAPABILITY_DEFINITIONS = (
    CapabilityDefinition("memory", "记忆", "capability", "memory",
                         "记住跨对话的信息", "跨对话保留记忆，可在 Agent 资料中编辑。"),
    CapabilityDefinition("communication", "通信", "mechanism", "always"),
    CapabilityDefinition("cache_key", "缓存键", "mechanism", "always"),
    CapabilityDefinition("skills", "技能加载", "mechanism", "always"),
    CapabilityDefinition("tool_search", "按需搜索", "capability", "tool_search",
                         "按需加载连接器的工具", "连接器设为“按需搜索”时，Agent 先搜索再加载需要的工具。"),
    CapabilityDefinition("task_path", "任务路径", "mechanism", "task_path"),
    CapabilityDefinition("files", "文件", "capability", "always",
                         "读写电脑上的文件", "读写这个 Agent 所在电脑上的文件，相对路径落在当前对话的目录里。"),
    CapabilityDefinition("processes", "命令", "capability", "processes",
                         "运行命令和脚本", "在这台电脑上运行命令和脚本，耗时的会转到后台，完成后通知 Agent。"),
    CapabilityDefinition("browser", "浏览器", "capability", "browser",
                         "操作浏览器，需要时请你接管", "用电脑上的浏览器操作网页，遇到登录等情况请你接管。"),
    CapabilityDefinition("code_mode", "Code Mode", "capability", "code_mode",
                         "写脚本批量调用工具", "写一段 Python 脚本批量调用工具、处理中间数据。"),
    # Installation is unconditional; window/retry policy remains inside the middleware.
    CapabilityDefinition("compaction", "上下文压缩", "mechanism", "always"),
    CapabilityDefinition("retry", "模型重试", "mechanism", "always"),
)


@dataclass(frozen=True)
class EntryCapabilityDefinition:
    """Entry-owned installation and static declarations, fixed for one runtime.

    condition runs once per initial/candidate graph. prepare_middleware runs once
    per configured environment type after Manager/TaskFiles exist; its returned
    factory creates graph-local middleware borrowing the same captured tools.
    All builtin files are staged before opening environments, even for an empty
    catalog. validate_human is the sole runtime delivery policy, not a graph hook.
    """

    id: str
    display_name: str
    condition: Callable[[AgentDefinition, Environment], tuple[CapabilityStatus, str]]
    prepare_middleware: Callable[["WorkerManager", TaskFiles, str], Callable[[], AgentMiddleware]]
    builtin_skills: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    validate_human: Callable[[str, str, list[ResolvedAttachment]], str | None] | None = None
    summary: str = ""
    description: str = ""
    kind: Literal["capability"] = field(default="capability", init=False)

    def __post_init__(self):
        # Declaration names/content cannot change after startup materializes its snapshot.
        object.__setattr__(self, "builtin_skills", MappingProxyType({
            name: MappingProxyType(dict(files)) for name, files in self.builtin_skills.items()
        }))


@dataclass(frozen=True)
class ResolvedCapability:
    """One installation decision, including disabled and inapplicable definitions."""

    definition: CapabilityDefinition | EntryCapabilityDefinition
    status: CapabilityStatus
    reason: str
    tools: tuple[str, ...] = ()


@dataclass(frozen=True)
class ResolvedCapabilities:
    """Immutable graph-scoped decisions, never rewritten by prepare or tool calls.

    browser only borrows the runtime's owner; resolving does not register a task,
    open resources, or release anything. An old graph keeps this same reference.
    """

    entries: Mapping[str, ResolvedCapability]
    browser: BrowserLeases | None

    def enabled(self, capability_id: str) -> bool:
        return self.entries[capability_id].status == "enabled"


def resolve_capabilities(
    definition: AgentDefinition,
    environment: Environment,
    *,
    memory: MemoryStore | None,
    files: TaskFiles | None,
    searchable: Sequence[ToolNamespace],
    browser: BrowserLeases | None,
    browser_environments: Collection[str],
    entry_capabilities: Sequence[EntryCapabilityDefinition] = (),
) -> ResolvedCapabilities:
    """Resolve one initial/candidate assembly without changing shared resources.

    Unsupported runtime/environment takes precedence over an unselected browser
    skill. Code Mode selection stays enabled even without a pool: construction
    must report the existing missing-pool error rather than silently omit it.
    """
    decisions: dict[CapabilityCondition, tuple[CapabilityStatus, str]] = {
        "always": ("enabled", "所有 Agent 都有"),
        "memory": ("enabled", "已提供记忆库") if memory is not None
        else ("not_applicable", "未提供记忆库"),
        "task_path": ("enabled", "所有 Agent 都有") if files is not None
        else ("not_applicable", "未提供任务目录"),
        "processes": ("enabled", "本机环境可用") if environment.processes is not None
        else ("not_applicable", "需要本机环境"),
        "tool_search": ("enabled", "已选择按需连接器") if searchable
        else ("disabled", "没有按需连接器"),
        "code_mode": ("enabled", "已开启") if definition.code_mode
        else ("disabled", "未开启"),
    }
    if browser is None:
        decisions["browser"] = ("not_applicable", "电脑未配置浏览器")
    elif environment.name not in browser_environments:
        decisions["browser"] = ("not_applicable", "电脑未配置浏览器")
    elif "browser" not in definition.skills:
        decisions["browser"] = ("disabled", "未选择 browser 技能")
    else:
        decisions["browser"] = ("enabled", "已选择 browser 技能，电脑已配置浏览器")
    entries = {}
    for capability in CAPABILITY_DEFINITIONS:
        if capability.id == "compaction":
            for entry in entry_capabilities:
                status, reason = entry.condition(definition, environment)
                entries[entry.id] = ResolvedCapability(entry, status, reason)
        status, reason = decisions[capability.condition]
        entries[capability.id] = ResolvedCapability(capability, status, reason)
    return ResolvedCapabilities(
        MappingProxyType(entries),
        browser if entries["browser"].status == "enabled" else None,
    )
