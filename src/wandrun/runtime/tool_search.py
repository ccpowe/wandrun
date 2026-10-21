"""可搜索工具：向模型声明原生 tool_search，在角色目录中检索并执行已加载的工具。

已加载哪些工具只由当前上下文视图中 tool_search 结果的 artifact 推导，不另存状态；
压缩切掉搜索结果后需重新搜索。原始历史仍用于定位正在执行的调用。
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass

from langchain.agents.middleware import AgentMiddleware
from langchain.messages import AIMessage, ToolMessage
from langchain.tools import BaseTool

from wandrun.integrations.codex_subscription import (
    TOOL_SEARCH,
    is_client_search,
    namespaced_tool_name,
    raw_tool_call,
    tool_search_namespace,
)
from wandrun.runtime.compaction import context_messages

SEARCH_LIMIT = 8


@dataclass(frozen=True)
class ToolNamespace:
    """一个可搜索服务；工具使用服务内的原始名称，对模型以 namespace 区分。"""

    name: str
    description: str
    tools: tuple[BaseTool, ...]


def loaded_tool_names(messages) -> set[str]:
    """历史中已经随原生搜索结果加载的工具（LangChain 侧名称）。

    与适配器编码 tool_search_output 的判据相同：结果的 tool_call_id 属于原始
    tool_search_call，而不是结果名称；远端工具也可能叫 tool_search。
    """
    searches = {
        item["call_id"]
        for message in messages
        if isinstance(message, AIMessage)
        for item in message.additional_kwargs.get("codex_output_items") or []
        if is_client_search(item)
    }
    names = set()
    for message in messages:
        if isinstance(message, ToolMessage) and message.tool_call_id in searches:
            for namespace in message.artifact or []:
                names.update(
                    namespaced_tool_name(namespace["name"], tool["name"])
                    for tool in namespace["tools"]
                )
    return names


def search_terms(text: str) -> set[str]:
    # 英文按词、中文按字；下划线分隔的工具名拆成单词。
    return set(re.findall(r"[a-z0-9]+|[一-鿿]", text.lower()))


def relevance(query_terms: set[str], name: str, text: str) -> int:
    """词重合打分，名称命中加权；tool_search 与 Code Mode 的 search_tools 共用这一规则。"""
    return 2 * len(query_terms & search_terms(name)) + len(query_terms & search_terms(text))


class ToolSearchMiddleware(AgentMiddleware):
    """为角色声明 tool_search；搜索结果和后续调用都限定在构造时给出的目录内。"""

    def __init__(self, namespaces: Sequence[ToolNamespace]):
        super().__init__()
        if not namespaces:
            raise ValueError("可搜索目录不能为空")
        self._namespaces = {}
        self._tools = {}
        for namespace in namespaces:
            # 点号用于拼接 LangChain 侧名称，namespace 中出现会使名称有歧义。
            if "." in namespace.name or namespace.name in self._namespaces:
                raise ValueError(f"可搜索服务名称无效或重复：{namespace.name}")
            self._namespaces[namespace.name] = namespace
            for tool in namespace.tools:
                key = namespaced_tool_name(namespace.name, tool.name)
                if key in self._tools:
                    raise ValueError(f"可搜索工具名称重复：{key}")
                self._tools[key] = (namespace, tool)
        catalog = "\n".join(f"- {n.name}: {n.description}" for n in namespaces)
        self.declaration = {
            "type": TOOL_SEARCH,
            "execution": "client",
            "description": (
                "Search and load tools from these services when the task needs a "
                "capability you do not currently have:\n" + catalog
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What the tool should do, with service or object names.",
                    }
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        }

    def search(self, query: str, loaded: set[str]) -> list[dict]:
        """按词重合打分，名称命中加权；返回按服务分组的延迟加载定义。"""
        terms = search_terms(query)
        scored = []
        for order, (key, (namespace, tool)) in enumerate(self._tools.items()):
            if key in loaded:
                continue
            score = relevance(
                terms, f"{namespace.name} {tool.name}", f"{namespace.description} {tool.description}"
            )
            if score:
                scored.append((-score, order, namespace, tool))
        scored.sort(key=lambda item: item[:2])
        groups: dict[str, list[BaseTool]] = {}
        for _, _, namespace, tool in scored[:SEARCH_LIMIT]:
            groups.setdefault(namespace.name, []).append(tool)
        return [
            tool_search_namespace(name, self._namespaces[name].description, tools)
            for name, tools in groups.items()
        ]

    def _search_message(self, request) -> ToolMessage:
        call = request.tool_call
        loaded = self.search(
            str(call["args"].get("query", "")),
            loaded_tool_names(context_messages(request.state)),
        )
        names = [
            namespaced_tool_name(namespace["name"], tool["name"])
            for namespace in loaded
            for tool in namespace["tools"]
        ]
        # 模型只看到 artifact 中的定义；正文供日志和人工检查。
        return ToolMessage(
            content=("已加载：" + ", ".join(names)) if names else "未找到匹配工具",
            tool_call_id=call["id"],
            name=TOOL_SEARCH,
            artifact=loaded,
        )

    def _route(self, request):
        """返回 (直接结果, None) 或 (None, 交给 ToolNode 执行的请求)。

        按原始调用项区分原生搜索、namespace 调用和普通函数，不按名称：
        直接工具可能恰好叫 tool_search。
        """
        messages = request.state["messages"]
        item = raw_tool_call(messages, request.tool_call["id"])
        if item is not None and is_client_search(item):
            return self._search_message(request), None
        if item is None or not item.get("namespace"):
            return None, request
        name = namespaced_tool_name(item["namespace"], item["name"])
        if name not in self._tools:
            return ToolMessage(
                content=f"工具 {name} 不在可搜索目录中。",
                tool_call_id=request.tool_call["id"],
                name=name,
                status="error",
            ), None
        if name not in loaded_tool_names(context_messages(request.state)):
            return ToolMessage(
                content=f"工具 {name} 尚未加载，请先使用 tool_search 搜索。",
                tool_call_id=request.tool_call["id"],
                name=name,
                status="error",
            ), None
        return None, request.override(tool=self._tools[name][1])

    def wrap_model_call(self, request, handler):
        return handler(request.override(tools=[*request.tools, self.declaration]))

    async def awrap_model_call(self, request, handler):
        return await handler(request.override(tools=[*request.tools, self.declaration]))

    def wrap_tool_call(self, request, handler):
        result, forward = self._route(request)
        return result if forward is None else handler(forward)

    async def awrap_tool_call(self, request, handler):
        result, forward = self._route(request)
        return result if forward is None else await handler(forward)
