"""Validated agent roles, centrally declared MCP connections and execution environments."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from pathlib import Path
import tomllib
from urllib.parse import urlsplit

from wandrun.integrations.codex_subscription import ReasoningEffort


@dataclass(frozen=True)
class AgentDefinition:
    description: str
    system_prompt: str
    model: str
    reasoning_effort: ReasoningEffort | None = None
    # 显式窗口优先于目录；未知窗口不执行上下文压缩。
    context_window: int | None = None
    compaction_keep_tokens: int = 20000
    compaction_model: str | None = None
    mcp_servers: tuple[str, ...] = ()
    # 可搜索服务：不进入初始工具列表，经 tool_search 按需加载（ADR-0010）。
    searchable_mcp_servers: tuple[str, ...] = ()
    workers: tuple[str, ...] = ()
    skills: tuple[str, ...] = ()
    # 提供 run_code：脚本在 Monty 中批量调用本角色的 MCP 工具和 backend 函数（ADR-0010）。
    code_mode: bool = True
    # 执行环境名称；load_config 把未填写的角色解析为 environments.toml 的 default（ADR-0012）。
    environment: str | None = None
    # 显示名不参与检查点、收件人或委派图的身份；None 表示沿用 id。
    name: str | None = None


@dataclass(frozen=True)
class BrowserDefinition:
    """Local Chrome CDP endpoint and bounded task lease capacity."""

    cdp_url: str
    slots: int = 3
    max_pages: int = 8
    idle_timeout: float = 7200
    queue_timeout: float = 30


@dataclass(frozen=True)
class EnvironmentDefinition:
    """一个执行环境的配置（ADR-0012）。

    local：根目录固定为 workspace。ssh：连接 host 上的 workdir；认证只用宿主机的 ~/.ssh
    密钥、ssh-agent 与 known_hosts，配置中不写任何秘密。
    """

    type: str
    command_timeout: int = 120
    # 取消、超时或关闭时，SIGTERM 之后等待多久再 SIGKILL（ADR-0011）。
    termination_grace: float = 2.0
    host: str | None = None
    port: int | None = None  # 省略时使用 ~/.ssh/config 或 22
    user: str | None = None  # 省略时使用 ~/.ssh/config 或本机用户名
    workdir: str | None = None
    browser: BrowserDefinition | None = None


@dataclass(frozen=True)
class AgentCatalog:
    """一组 Agent 定义及其入口，与它们引用的 MCP 服务、执行环境的具体配置无关。

    Agent 来源不止 agents.toml（网关从自己的数据库提供，ADR-0022）；来源只负责给出这三项，
    引用是否成立由 load_config_for_catalog 与文件来源用同一套规则检查。
    键是 Agent 的身份：运行时的检查点绑定、委派目标和目录都用它。
    """

    main_agent: str | None
    agents: dict[str, AgentDefinition]


@dataclass(frozen=True)
class RuntimeConfig:
    main_agent: str | None
    agents: dict[str, AgentDefinition]
    mcp_servers: dict[str, dict]
    # 服务说明不属于连接参数；可搜索服务必须提供，供模型判断何时搜索。
    mcp_descriptions: dict[str, str] = field(default_factory=dict)
    environments: dict[str, EnvironmentDefinition] = field(default_factory=dict)
    default_environment: str = "local"

    @property
    def catalog(self) -> AgentCatalog:
        return AgentCatalog(self.main_agent, self.agents)


def _table(
    value: object, location: str, *, required: set[str] | None = None,
    allowed: set[str] | None = None,
) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{location} 必须是表")
    missing = (required or set()) - value.keys()
    extra = value.keys() - allowed if allowed is not None else set()
    if missing or extra:
        raise ValueError(f"{location} 字段错误：缺少 {sorted(missing)}；未知 {sorted(extra)}")
    return value


def _text(value: object, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{location} 必须是非空字符串")
    return value


def _identity(value: object, location: str) -> str:
    text = _text(value, location)
    if text != text.strip():
        raise ValueError(f"{location} 不能包含首尾空白")
    return text


AGENT_ID_MAX = 64
DISPLAY_NAME_MAX = 64
_LINE_BREAKS = "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029"


def _display_name(value: object, location: str) -> str:
    """显示名保留原样供目录和提示词使用，但不能换行或无限占用上下文。"""
    text = _identity(value, location)
    if len(text) > DISPLAY_NAME_MAX or any(char in _LINE_BREAKS for char in text):
        raise ValueError(f"{location} 只能占一行，最多 {DISPLAY_NAME_MAX} 字")
    return text


_AGENT_ID = re.compile(rf"[A-Za-z0-9_-]{{1,{AGENT_ID_MAX}}}")


def _agent_id(value: object, location: str) -> str:
    """Agent 的身份规则（ADR-0022 约定 8）：ASCII 字母、数字、下划线、连字符，至多 AGENT_ID_MAX 个字符。

    它出现在 URL 路径、检查点绑定和模型看到的委派目标 `to` 中，所以必须能原样放进路径、
    不含需要转义的字符；human 是保留收件人。任何来源的定义都在 _validated 里经过这里。
    """
    if not isinstance(value, str) or _AGENT_ID.fullmatch(value) is None:
        raise ValueError(
            f"{location} 必须是 1～{AGENT_ID_MAX} 个 ASCII 字母、数字、下划线或连字符: {value!r}"
        )
    if value == "human":
        raise ValueError("human 是保留收件人，不能用作 Agent 名称")
    return value


def _selection(value: object, location: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise ValueError(f"{location} 必须是字符串数组")
    names = tuple(_identity(item, f"{location}[{index}]") for index, item in enumerate(value))
    if len(set(names)) != len(names):
        raise ValueError(f"{location} 不能重复")
    return names


def _skill_names(value: object, location: str) -> tuple[str, ...]:
    """skill 是 .wandrun/skills 的直接子目录名；路径形式会越出该目录（SSH 环境还会据此上传）。"""
    names = _selection(value, location)
    for name in names:
        if name in {".", ".."} or "/" in name or "\\" in name:
            raise ValueError(f"{location} 只能是 skills 目录下的名称，不能是路径: {name}")
    return names


def _strings(value: object, location: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{location} 必须是字符串数组")
    return value


def _string_table(value: object, location: str) -> dict[str, str]:
    if not isinstance(value, dict) or any(
        not isinstance(key, str) or not key or not isinstance(item, str)
        for key, item in value.items()
    ):
        raise ValueError(f"{location} 必须是字符串表")
    return value


def _connection(value: object, name: str) -> dict:
    location = f"mcp_servers.{name}"
    if not isinstance(value, dict):
        raise ValueError(f"{location} 必须是表")
    if "url" in value:
        connection = _table(
            value, location, required={"url"}, allowed={"url", "transport", "headers"}
        )
        url = _text(connection["url"], f"{location}.url")
        parts = urlsplit(url)
        if (
            parts.scheme not in {"http", "https"}
            or not parts.hostname
            or parts.username is not None
            or parts.password is not None
        ):
            raise ValueError(f"{location}.url 必须是无内嵌凭据的 HTTP(S) URL")
        try:
            _ = parts.port
        except ValueError:
            raise ValueError(f"{location}.url 的端口无效") from None
        if "transport" in connection and connection["transport"] not in (
            "http", "streamable-http", "sse"
        ):
            raise ValueError(f"{location}.transport 无效")
        if "headers" in connection:
            _string_table(connection["headers"], f"{location}.headers")
    else:
        connection = _table(
            value, location, required={"command"}, allowed={"command", "args", "env", "transport"}
        )
        _text(connection["command"], f"{location}.command")
        if "transport" in connection and connection["transport"] != "stdio":
            raise ValueError(f"{location}.transport 必须是 stdio")
        if "args" in connection:
            _strings(connection["args"], f"{location}.args")
        if "env" in connection:
            _string_table(connection["env"], f"{location}.env")
    return {
        key: list(item) if isinstance(item, list) else dict(item) if isinstance(item, dict) else item
        for key, item in connection.items()
    }


def _environments(data: object) -> tuple[str, dict[str, EnvironmentDefinition]]:
    root = _table(
        data, "environments.toml", required={"default", "environments"},
        allowed={"default", "environments"},
    )
    default = _identity(root["default"], "default")
    raw = _table(root["environments"], "environments")
    if not raw:
        raise ValueError("environments 不能是空表")
    environments = {}
    for raw_name, raw_definition in raw.items():
        name = _identity(raw_name, "环境名称")
        location = f"environments.{name}"
        kind = _table(raw_definition, location, required={"type"})["type"]
        common = {"type", "command_timeout", "termination_grace"}
        if kind == "local":
            definition = _table(raw_definition, location, allowed=common | {"browser"})
        elif kind == "ssh":
            definition = _table(
                raw_definition, location, required={"type", "host", "workdir"},
                allowed=common | {"host", "port", "user", "workdir"},
            )
        else:
            raise ValueError(f"{location}.type 只支持 local 或 ssh")
        timeout = definition.get("command_timeout", 120)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout <= 0:
            raise ValueError(f"{location}.command_timeout 必须是正整数（秒）")
        grace = definition.get("termination_grace", 2.0)
        if (
            isinstance(grace, bool) or not isinstance(grace, int | float)
            or not math.isfinite(grace) or grace <= 0
        ):
            # inf 会让忽略 SIGTERM 的命令永远停在宽限期；nan 的比较恒为假，会跳过宽限期。
            raise ValueError(f"{location}.termination_grace 必须是有限正数（秒）")
        remote = {}
        if kind == "ssh":
            remote["host"] = _identity(definition["host"], f"{location}.host")
            workdir = _identity(definition["workdir"], f"{location}.workdir")
            if not workdir.startswith("/"):
                raise ValueError(f"{location}.workdir 必须是远端绝对路径")
            remote["workdir"] = workdir.rstrip("/") or "/"
            if "user" in definition:
                remote["user"] = _identity(definition["user"], f"{location}.user")
            if "port" in definition:
                port = definition["port"]
                if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
                    raise ValueError(f"{location}.port 必须是 1～65535 的整数")
                remote["port"] = port
        browser = None
        if "browser" in definition:
            settings = _table(
                definition["browser"], f"{location}.browser", required={"cdp_url"},
                allowed={"cdp_url", "slots", "max_pages", "idle_timeout", "queue_timeout"},
            )
            endpoint = _text(settings["cdp_url"], f"{location}.browser.cdp_url")
            parsed = urlsplit(endpoint)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
                raise ValueError(f"{location}.browser.cdp_url 必须是 HTTP CDP 地址")
            numbers = {"slots": 3, "max_pages": 8, "idle_timeout": 7200, "queue_timeout": 30}
            numbers.update({key: value for key, value in settings.items() if key != "cdp_url"})
            for key in ("slots", "max_pages"):
                value = numbers[key]
                if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                    raise ValueError(f"{location}.browser.{key} 必须是正整数")
            for key in ("idle_timeout", "queue_timeout"):
                value = numbers[key]
                if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
                    raise ValueError(f"{location}.browser.{key} 必须是有限数字")
                if (value < 0 if key == "idle_timeout" else value <= 0):
                    raise ValueError(f"{location}.browser.{key} 必须{'非负' if key == 'idle_timeout' else '大于零'}")
            browser = BrowserDefinition(endpoint, **numbers)
        environments[name] = EnvironmentDefinition(
            type=kind, command_timeout=timeout, termination_grace=float(grace), browser=browser, **remote
        )
    if sum(bool(item.browser) for item in environments.values()) > 1:
        raise ValueError("目前只支持一个本机浏览器环境")
    if default not in environments:
        raise ValueError(f"default 引用了未知环境: {default}")
    targets: dict[tuple, str] = {}
    for name, environment in environments.items():
        if environment.type != "ssh":
            continue
        # 同一远端目录会被各自清空和同步 skills，互相覆盖；不同超时等设置应放在同一个环境里。
        target = (environment.host, environment.port, environment.user, environment.workdir)
        if target in targets:
            raise ValueError(f"environments.{name} 与 environments.{targets[target]} 指向同一远端工作目录")
        targets[target] = name
    return default, environments


def _resolve_mcp_servers(
    path: Path | None, servers: dict[str, dict] | None, descriptions: dict[str, str] | None,
) -> tuple[dict[str, dict], dict[str, str]]:
    """Check database and TOML connections with the same schema; descriptions are not transport fields."""
    if servers is None:
        if descriptions is not None:
            raise ValueError("mcp_descriptions 需要 mcp_servers")
        if path is None:
            raise ValueError("缺少 MCP 配置路径")
        return _read_mcp_servers(path)
    if path is not None:
        raise ValueError("mcps_config 与 mcp_servers 只能给一个")
    if descriptions is None:
        descriptions = {}
    if not isinstance(servers, dict) or not isinstance(descriptions, dict):
        raise ValueError("mcp_servers 和 mcp_descriptions 必须是表")
    checked = {_identity(name, "MCP 服务名称"): _connection(connection, name)
               for name, connection in servers.items()}
    checked_descriptions = {
        _identity(name, "MCP 服务名称"): _text(value, f"mcp_servers.{name}.description")
        for name, value in descriptions.items()
    }
    for name in checked_descriptions:
        if name not in checked:
            raise ValueError(f"mcp_servers.{name}.description 引用了未知服务")
    return checked, checked_descriptions


def validate_mcp_servers(
    servers: dict[str, dict], descriptions: dict[str, str],
) -> tuple[dict[str, dict], dict[str, str]]:
    """Validate connection-only definitions and independently supplied searchable descriptions."""
    return _resolve_mcp_servers(None, servers, descriptions)


def load_config(
    agents_path: Path, mcps_path: Path | None = None, environments_path: Path | None = None,
    *, mcp_servers: dict[str, dict] | None = None, mcp_descriptions: dict[str, str] | None = None,
) -> RuntimeConfig:
    """Read agent/environment files; MCP may come from a validated database snapshot."""
    if mcps_path is None and mcp_servers is None:
        mcps_path = agents_path.parent / "mcps.toml"
    if environments_path is None:
        environments_path = agents_path.parent / "environments.toml"
    with agents_path.open("rb") as source:
        agents_data = tomllib.load(source)
    default_environment, environments = _read_environments(environments_path)
    return _validated(
        _parse_catalog(agents_data, default_environment),
        *_resolve_mcp_servers(mcps_path, mcp_servers, mcp_descriptions),
        environments, default_environment, require_main=True,
    )


def load_config_for_catalog(
    catalog: AgentCatalog, mcps_path: Path | None, environments_path: Path,
    *, mcp_servers: dict[str, dict] | None = None, mcp_descriptions: dict[str, str] | None = None,
) -> RuntimeConfig:
    """Validate supplied Agent definitions against MCP connections and environment definitions."""
    default_environment, environments = _read_environments(environments_path)
    return _validated(
        catalog, *_resolve_mcp_servers(mcps_path, mcp_servers, mcp_descriptions),
        environments, default_environment,
    )


def validate_catalog(catalog: AgentCatalog, config: RuntimeConfig) -> RuntimeConfig:
    """用已打开运行时的 MCP/环境配置检查新目录，不重新读取配置文件。"""
    return _validated(
        catalog, config.mcp_servers, config.mcp_descriptions,
        config.environments, config.default_environment,
    )


def _read_environments(path: Path) -> tuple[str, dict[str, EnvironmentDefinition]]:
    with path.open("rb") as source:
        return _environments(tomllib.load(source))


def _parse_catalog(agents_data: object, default_environment: str) -> AgentCatalog:
    """agents.toml 的字段级检查；引用其他配置的部分留给 _validated。"""
    root = _table(
        agents_data, "agents.toml", required={"main_agent", "agents"},
        allowed={"main_agent", "agents"},
    )
    main_agent = root["main_agent"]
    raw_agents = _table(root["agents"], "agents")
    if not raw_agents:
        raise ValueError("agents 不能是空表")
    agents: dict[str, AgentDefinition] = {}
    for raw_name, raw_definition in raw_agents.items():
        name = raw_name
        location = f"agents.{name}"
        definition = _table(
            raw_definition, location, required={"description", "system_prompt", "model"},
            allowed={
                "name", "description", "system_prompt", "model", "reasoning_effort", "mcp_servers",
                "searchable_mcp_servers", "workers", "skills", "code_mode", "environment",
                "context_window", "compaction_keep_tokens", "compaction_model",
            },
        )
        # 只做来源解码：TOML 数组 → tuple，缺省值补齐；类型和取值是否合法交给 _check_definition，
        # 它对任何来源的定义一视同仁（类型不对的原始值原样带过去，由它拒绝）。
        def listed(key):
            value = definition.get(key, [])
            return tuple(value) if isinstance(value, list) else value

        agents[name] = AgentDefinition(
            description=definition["description"],
            system_prompt=definition["system_prompt"],
            model=definition["model"],
            reasoning_effort=definition.get("reasoning_effort"),
            context_window=definition.get("context_window"),
            compaction_keep_tokens=definition.get("compaction_keep_tokens", 20000),
            compaction_model=definition.get("compaction_model"),
            mcp_servers=listed("mcp_servers"),
            searchable_mcp_servers=listed("searchable_mcp_servers"),
            skills=listed("skills"),
            workers=listed("workers"),
            code_mode=definition.get("code_mode", True),
            environment=definition.get("environment", default_environment),
            name=definition.get("name"),
        )
    return AgentCatalog(main_agent, agents)


def _read_mcp_servers(path: Path) -> tuple[dict[str, dict], dict[str, str]]:
    with path.open("rb") as source:
        mcps_data = tomllib.load(source)
    mcp_root = _table(mcps_data, "mcps.toml", required={"mcp_servers"}, allowed={"mcp_servers"})
    raw_servers = _table(mcp_root["mcp_servers"], "mcp_servers")
    servers, descriptions = {}, {}
    for raw_name, connection in raw_servers.items():
        name = _identity(raw_name, "MCP 服务名称")
        if isinstance(connection, dict) and "description" in connection:
            connection = dict(connection)
            descriptions[name] = _text(
                connection.pop("description"), f"mcp_servers.{name}.description"
            )
        servers[name] = _connection(connection, name)
    return servers, descriptions


def _check_definition(name: str, definition: AgentDefinition) -> None:
    """一个 Agent 定义自身的身份与字段检查（不涉及其他配置）；文件和数据库来源共用。"""
    _agent_id(name, "Agent 名称")
    location = f"agents.{name}"
    if definition.name is not None:
        _display_name(definition.name, f"{location}.name")
    _text(definition.description, f"{location}.description")
    _text(definition.system_prompt, f"{location}.system_prompt")
    _text(definition.model, f"{location}.model")
    if definition.reasoning_effort is not None and (
        not isinstance(definition.reasoning_effort, str)
        or not definition.reasoning_effort.strip()
    ):
        raise ValueError(f"{location}.reasoning_effort 无效")
    if definition.context_window is not None and (
        type(definition.context_window) is not int or definition.context_window <= 0
    ):
        raise ValueError(f"{location}.context_window 必须是正整数")
    if type(definition.compaction_keep_tokens) is not int or definition.compaction_keep_tokens <= 0:
        raise ValueError(f"{location}.compaction_keep_tokens 必须是正整数")
    if definition.compaction_model is not None:
        _text(definition.compaction_model, f"{location}.compaction_model")
    if not isinstance(definition.code_mode, bool):
        raise ValueError(f"{location}.code_mode 必须是布尔值")
    _selection(definition.mcp_servers, f"{location}.mcp_servers")
    _selection(definition.searchable_mcp_servers, f"{location}.searchable_mcp_servers")
    _skill_names(definition.skills, f"{location}.skills")
    for worker in _selection(definition.workers, f"{location}.workers"):
        _agent_id(worker, f"{location}.workers")
        if worker == name:
            raise ValueError(f"{location}.workers 不能包含自己")
    _identity(definition.environment, f"{location}.environment")


def _validated(
    catalog: AgentCatalog, servers: dict[str, dict], descriptions: dict[str, str],
    environments: dict[str, EnvironmentDefinition], default_environment: str,
    *, require_main: bool = False,
) -> RuntimeConfig:
    """Agent 与 MCP、环境、其他 Agent 之间的引用检查；任何来源的 Agent 都经过这里。"""
    main_agent = catalog.main_agent
    agents = {
        name: replace(
            definition,
            environment=default_environment if definition.environment is None else definition.environment,
        )
        for name, definition in catalog.agents.items()
    }
    if require_main and not agents:
        raise ValueError("agents 不能是空表")
    if main_agent is not None:
        _agent_id(main_agent, "main_agent")
    elif require_main:
        raise ValueError("main_agent 必须指定")
    for name, definition in agents.items():
        _check_definition(name, definition)
    if main_agent is not None and main_agent not in agents:
        raise ValueError(f"main_agent 引用了未知 Agent: {main_agent}")
    for name, definition in agents.items():
        if definition.environment not in environments:
            raise ValueError(f"agents.{name}.environment 引用了未知环境: {definition.environment}")
        for worker in definition.workers:
            if worker not in agents:
                raise ValueError(f"Agent {name} 的成员不存在：{worker}")
        for server in definition.mcp_servers:
            if server not in servers:
                raise ValueError(f"Agent {name} 所选的连接器不存在：{server}")
        for server in definition.searchable_mcp_servers:
            location = f"agents.{name}.searchable_mcp_servers"
            if server not in servers:
                raise ValueError(f"Agent {name} 按需搜索的连接器不存在：{server}")
            if server in definition.mcp_servers:
                raise ValueError(f"{location} 与 mcp_servers 重复: {server}")
            if "." in server:
                # 服务名作为 namespace，点号用于拼接 LangChain 侧工具名。
                raise ValueError(f"{location} 的服务名不能包含点号: {server}")
            if server not in descriptions:
                raise ValueError(f"可搜索服务 mcp_servers.{server} 需要 description")
    return RuntimeConfig(
        main_agent=main_agent, agents=agents, mcp_servers=servers,
        mcp_descriptions=descriptions, environments=environments,
        default_environment=default_environment,
    )
