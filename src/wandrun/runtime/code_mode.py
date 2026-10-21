"""Code Mode：模型调用 run_code 写一段脚本，脚本在 Monty 中调用工具，只把输出交给模型（ADR-0010）。

脚本运行在运行时持有的 Monty 子进程池中，没有文件系统、网络和环境变量；工具调用回到
运行时进程执行。每次 run_code 是一个执行作用域：登记脚本发起的调用，任何退出路径都先
拒绝新调用、取消并等待未完成的调用，再返回结果或传播异常。
"""

from __future__ import annotations

import asyncio
import inspect
import json
import keyword
import re
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AsyncExitStack
from dataclasses import asdict, dataclass
from typing import Annotated, Any

import pydantic_monty as pm
from langchain.agents.middleware import AgentMiddleware
from langchain.messages import ToolMessage
from langchain.tools import BaseTool, InjectedToolCallId, tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.errors import GraphBubbleUp

from wandrun.runtime.tool_search import SEARCH_LIMIT, ToolNamespace, relevance, search_terms

CODE_TOOL = "run_code"
DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 600
MAX_MEMORY = 256 * 1024 * 1024
MAX_RECORDS = 100
LISTING_BUDGET = 4000
BACKEND_FUNCTIONS = ("read", "write", "edit", "ls", "glob", "grep", "execute")


def script_name(raw: str) -> str:
    """工具在脚本中的标识符：可搜索工具的点号变为双下划线，其余非法字符变为下划线。"""
    name = re.sub(r"\W", "_", raw.replace(".", "__"), flags=re.ASCII)
    return f"_{name}" if name[:1].isdigit() else name


@dataclass(frozen=True)
class ScriptTool:
    raw: str
    name: str
    tool: BaseTool
    listed: bool  # 直接携带的工具在说明中列出签名；可搜索工具由脚本检索。
    service_description: str = ""


class CodeModeCatalog:
    """角色可在脚本中调用的 MCP 工具；原名与脚本标识符一一对应。"""

    def __init__(self, direct: Sequence[BaseTool], namespaces: Sequence[ToolNamespace]):
        self.namespaces = tuple(namespaces)
        entries = [ScriptTool(t.name, script_name(t.name), t, True) for t in direct]
        entries += [
            ScriptTool(f"{ns.name}.{t.name}", script_name(f"{ns.name}.{t.name}"), t, False, ns.description)
            for ns in namespaces
            for t in ns.tools
        ]
        self.by_name: dict[str, ScriptTool] = {}
        self.by_raw: dict[str, ScriptTool] = {}
        for entry in entries:
            if entry.name in self.by_name or entry.raw in self.by_raw:
                raise ValueError(f"Code Mode 工具名称冲突：{entry.raw} → {entry.name}")
            self.by_name[entry.name] = entry
            self.by_raw[entry.raw] = entry

    def resolve(self, name: str) -> ScriptTool:
        entry = self.by_raw.get(name) or self.by_name.get(name)
        if entry is None:
            raise KeyError(f"没有名为 {name} 的工具")
        return entry

    def search(self, query: str, limit: int = SEARCH_LIMIT) -> list[dict]:
        """与 tool_search 共用打分规则（relevance）。"""
        terms = search_terms(query)
        scored = []
        for order, entry in enumerate(self.by_name.values()):
            score = relevance(terms, entry.raw, f"{entry.service_description} {entry.tool.description}")
            if score:
                scored.append((-score, order, entry))
        scored.sort(key=lambda item: item[:2])
        return [
            {"name": e.name, "raw_name": e.raw, "description": _first_line(e.tool.description)}
            for _, _, e in scored[:limit]
        ]

    def describe(self, name: str) -> dict:
        entry = self.resolve(name)
        return {
            "name": entry.name,
            "raw_name": entry.raw,
            "description": entry.tool.description,
            "parameters": _parameters(entry.tool),
        }


def _first_line(text: str | None, limit: int = 120) -> str:
    line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    return line if len(line) <= limit else line[: limit - 1] + "…"


def _parameters(tool: BaseTool) -> dict:
    return convert_to_openai_tool(tool)["function"].get("parameters", {})


def _signature(entry: ScriptTool) -> str:
    """必填参数写名字；有默认值写真实默认值；可省略但没有默认值的写成 [name]，不伪造 None。"""
    schema = _parameters(entry.tool)
    required = set(schema.get("required", ()))
    params = []
    for name, spec in schema.get("properties", {}).items():
        if name in required:
            params.append(name)
        elif isinstance(spec, dict) and "default" in spec:
            params.append(f"{name}={spec['default']!r}")
        else:
            params.append(f"[{name}]")
    return f"tools.{entry.name}({', '.join(params)})  # {_first_line(entry.tool.description)}"


def _mcp_result(message: ToolMessage, name: str) -> Any:
    """MCP 结果转成脚本值：只有文本或只有结构化内容时直接返回；含非文本块时返回组合 dict，不静默丢弃。"""
    content = message.content
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else list(content)
    text = "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    if message.status == "error":
        raise RuntimeError(f"{name} 调用失败：{text or '工具报告错误'}")
    artifact = message.artifact
    structured = artifact.get("structured_content") if isinstance(artifact, dict) else None
    others = [b for b in blocks if not (isinstance(b, dict) and b.get("type") == "text")]
    if others:
        combined = {"text": text, "content": others}
        if structured is not None:
            combined["structured_content"] = structured
        return combined
    return structured if structured is not None else text


class _Execution:
    """一次 run_code 的作用域；Monty 退出时不会替宿主取消调用，收尾由这里负责。"""

    def __init__(self, timeout: float):
        self.timeout = timeout
        self.calls: set[asyncio.Task] = set()
        self.records: list[dict] = []
        self.dropped_records = 0
        self.closed = False
        self.interrupt: GraphBubbleUp | None = None
        self.feed: asyncio.Future | None = None

    async def call(self, name: str, operation: Callable[[], Awaitable[Any]]) -> Any:
        if self.closed:
            raise RuntimeError(f"run_code 已结束，拒绝调用 {name}")
        record = {"name": name, "status": "started"}
        if len(self.records) < MAX_RECORDS:
            self.records.append(record)
        else:
            self.dropped_records += 1
        task = asyncio.current_task()
        self.calls.add(task)
        try:
            result = await operation()
        except GraphBubbleUp as error:
            record["status"] = "interrupted"
            # 经 Monty 后会变成脚本可捕获的普通异常；宿主保存原异常并主动终止本次执行。
            if self.interrupt is None:
                self.interrupt = error
                self.closed = True
                self.feed.cancel()
            raise BaseException("graph control flow") from None
        except asyncio.CancelledError:
            record["status"] = "cancelled"
            raise
        except Exception as error:
            record["status"] = "failed"
            record["error"] = str(error)[:500]
            # Monty 只保留内置异常类型；统一为 RuntimeError，消息带调用名。
            message = str(error) if isinstance(error, RuntimeError) else f"{name} 调用失败：{error}"
            raise RuntimeError(message) from None
        else:
            record["status"] = "succeeded"
            return result
        finally:
            self.calls.discard(task)

    async def close(self) -> None:
        """拒绝新调用，取消并等待未完成的调用；收尾期间再次取消不截断，等收尾结束后再传播。"""
        self.closed = True
        pending = list(self.calls)
        for call in pending:
            call.cancel()
        if not pending:
            return
        cleanup = asyncio.ensure_future(asyncio.gather(*pending, return_exceptions=True))
        cancelled = False
        # 与 session._finish_shutdown 相同：取消只断开等待，不能打断宿主调用的异步释放。
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        if cancelled:
            raise asyncio.CancelledError

    async def run(self, pool, checkout: dict, code: str, **feed) -> Any:
        """墙钟时限覆盖等待解释器和执行脚本；收尾和释放会话不受时限截断。"""
        deadline = asyncio.get_running_loop().time() + self.timeout
        async with AsyncExitStack() as stack:
            async with asyncio.timeout_at(deadline):
                session = await stack.enter_async_context(pool.checkout(**checkout))
            self.feed = asyncio.ensure_future(session.feed_run(code, **feed))
            try:
                try:
                    async with asyncio.timeout_at(deadline):
                        return await self.feed
                except asyncio.CancelledError:
                    if self.interrupt is None or asyncio.current_task().cancelling():
                        raise
                except pm.MontyError:
                    if self.interrupt is None:
                        raise
            finally:
                # 完成、报错、超时、取消、图中断都走这里：之后的调用被拒绝，未完成的调用被取消。
                await self.close()
        raise self.interrupt


class _Tools:
    """脚本中的 tools 对象；属性名在宿主侧解析为工具。"""

    def __init__(self, catalog: CodeModeCatalog, execution: _Execution):
        self._catalog = catalog
        self._execution = execution

    def __getattr__(self, name: str):
        entry = self._catalog.by_name.get(name)
        if entry is None:
            raise AttributeError(name)
        return lambda **arguments: _invoke(entry, arguments, self._execution)


async def _invoke(entry: ScriptTool, arguments: dict, execution: _Execution) -> Any:
    async def operation():
        call = {"type": "tool_call", "id": f"code_mode:{entry.raw}", "name": entry.tool.name, "args": arguments}
        return _mcp_result(await entry.tool.ainvoke(call), entry.raw)

    return await execution.call(entry.raw, operation)


def _script_functions(catalog: CodeModeCatalog, backend, execution: _Execution | None) -> dict[str, Callable]:
    """脚本中的全局函数。backend 方法返回结构化 dict：文件操作的 error 抛 RuntimeError，非零 exit_code 正常返回。

    类型检查存根也由这些函数的签名生成（execution 为 None，只读签名），运行时与预检使用同一份接口。
    """

    async def file_operation(name: str, start: Callable[[], Awaitable[Any]]) -> dict:
        async def operation():
            result = await start()
            if result.error:
                raise RuntimeError(f"{name} 失败：{result.error}")
            data = asdict(result)
            data.pop("error")
            return data

        return await execution.call(name, operation)

    async def read(file_path: str, offset: int = 0, limit: int = 2000):
        return await file_operation("read", lambda: backend.aread(file_path, offset, limit))

    async def write(file_path: str, content: str):
        return await file_operation("write", lambda: backend.awrite(file_path, content))

    async def edit(file_path: str, old_string: str, new_string: str, replace_all: bool = False):
        return await file_operation("edit", lambda: backend.aedit(file_path, old_string, new_string, replace_all))

    async def ls(path: str = "."):
        return await file_operation("ls", lambda: backend.als(path))

    async def glob(pattern: str, path: str | None = None):
        return await file_operation("glob", lambda: backend.aglob(pattern, path))

    async def grep(pattern: str, path: str | None = None, glob: str | None = None):
        return await file_operation("grep", lambda: backend.agrep(pattern, path, glob))

    async def execute(command: str, timeout: int | None = None):
        async def operation():
            response = await backend.aexecute(command, timeout=timeout)
            return {"output": response.output, "exit_code": response.exit_code, "truncated": response.truncated}

        return await execution.call("execute", operation)

    async def call_tool(name: str, **arguments):
        return await _invoke(catalog.resolve(name), arguments, execution)

    def search_tools(query: str):
        return catalog.search(query)

    def describe_tool(name: str):
        return catalog.describe(name)

    return {
        f.__name__: f
        for f in (read, write, edit, ls, glob, grep, execute, call_tool, search_tools, describe_tool)
    }


def _function_stub(name: str, function: Callable) -> str:
    params = []
    for parameter in inspect.signature(function).parameters.values():
        if parameter.kind is parameter.VAR_KEYWORD:
            params.append(f"**{parameter.name}: Any")
        elif parameter.default is parameter.empty:
            params.append(f"{parameter.name}: Any")
        else:
            params.append(f"{parameter.name}: Any = {parameter.default!r}")
    prefix = "async def" if inspect.iscoroutinefunction(function) else "def"
    return f"{prefix} {name}({', '.join(params)}) -> Any: ..."


def _tool_stub(entry: ScriptTool) -> str:
    """工具方法的存根不能比工具 Schema 更严格，也不能比运行时更宽松：只在明确禁止额外属性时不接受额外参数。

    参数类型一律写 Any，只检查名字和必填项；参数名不是合法标识符时只接受 **arguments。
    """
    schema = _parameters(entry.tool)
    properties = schema.get("properties") or {}
    required = set(schema.get("required", ()))
    if not all(name.isidentifier() and not keyword.iskeyword(name) for name in properties):
        return f"    async def {entry.name}(self, **arguments: Any) -> Any: ..."
    # 运行时的工具方法只接受关键字参数，存根也一律 keyword-only；可选属性因此可以排在必填属性之前。
    params = [f"{n}: Any" if n in required else f"{n}: Any = ..." for n in properties]
    if params:
        params.insert(0, "*")
    if schema.get("additionalProperties") is not False:
        # JSON Schema 未声明时默认允许额外属性；允许额外关键字参数，不等于允许位置参数。
        params.append("**arguments: Any")
    return f"    async def {entry.name}({', '.join(['self', *params])}) -> Any: ..."


def _stubs(catalog: CodeModeCatalog, functions: dict[str, Callable]) -> str:
    """执行前类型检查用的存根：静态可识别的未定义名字、不存在的模块、直接写出的工具方法名与参数在调用任何工具前被拒绝。

    call_tool 的工具名和参数、运行时数据错误不在检查范围内，可能在部分调用执行后才出错。
    """
    lines = ["from typing import Any", "class _Tools:"]
    lines += [_tool_stub(entry) for entry in catalog.by_name.values()] or ["    pass"]
    lines.append("tools: _Tools")
    lines += [_function_stub(name, function) for name, function in functions.items()]
    return "\n".join(lines)


def _render_value(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2, default=str)
    except (TypeError, ValueError):
        return repr(value)


def _summary(execution: _Execution) -> str:
    if not execution.records:
        return ""
    items = ", ".join(f"{r['name']}({r['status']})" for r in execution.records)
    if execution.dropped_records:
        items += f"，另有 {execution.dropped_records} 次未记录"
    return f"\n\n本次脚本发起的工具调用（已发生的副作用不会撤销；cancelled 表示结果未知）：{items}"


def _description(catalog: CodeModeCatalog) -> str:
    listed, remaining = [], 0
    used = 0
    for entry in catalog.by_name.values():
        if not entry.listed:
            continue
        line = _signature(entry)
        if used + len(line) > LISTING_BUDGET:
            remaining += 1
            continue
        listed.append(line)
        used += len(line)
    parts = [
        "运行一段 Python 脚本，在脚本中批量调用工具并处理中间数据，只把 print 的输出和最后一个表达式的值返回给你。"
        "适合需要多次调用工具、筛选或汇总大量结果的任务；单次调用直接使用对应工具即可。",
        "环境：Python 子集（Monty），支持顶层 await。模块需要自己 import（如 import asyncio, json），可用的有 asyncio、json、re、"
        "math、datetime、collections、itertools、functools、random；没有 decimal 和任何第三方库，也没有文件系统、网络和环境变量。"
        "文件和命令必须通过下面的函数完成。每次运行是全新环境，变量不保留。执行前会做类型检查：未定义的名字、不存在的模块、"
        "tools.<name> 写错的方法名或参数会直接报错，此时没有调用任何工具；call_tool 的工具名和参数、运行时的数据错误不在检查"
        "范围内，可能在部分调用已经执行后才出错。",
        "函数（都是 async，需要 await）：\n"
        "- read(file_path, offset=0, limit=2000) -> {file_data: {content, encoding}, total_lines, ...}\n"
        "- write(file_path, content) / edit(file_path, old_string, new_string, replace_all=False)\n"
        "- ls(path='.') / glob(pattern, path=None) / grep(pattern, path=None, glob=None)\n"
        "- execute(command, timeout=None) -> {output, exit_code, truncated}；非零 exit_code 不抛异常\n"
        "- tools.<name>(**参数)：调用工具，返回结构化结果或文本；含图片等非文本内容时返回 {text, content, structured_content}\n"
        "- call_tool(原名, **参数)：按原名调用，如 call_tool('server.tool', ...)\n"
        "- search_tools(query) / describe_tool(name)：检索工具、查看参数 Schema（同步函数，不需要 await）",
        "工具或文件操作失败时抛 RuntimeError，可用 try/except 处理。互不依赖的调用用 asyncio.gather 并发。"
        "不确定工具返回的结构时，先只调用一次（只查一个对象）并打印它的结构，确认后再写批量处理的脚本；"
        "不要先全量查询再只打印一个结果，那样批量调用会在下一段脚本里重复一遍。"
        "工具调用是真实操作：脚本中途失败时，已执行的调用不会撤销，重试时只重做失败的步骤。"
        f"timeout 是整个脚本的墙钟秒数（默认 {DEFAULT_TIMEOUT}，上限 {MAX_TIMEOUT}），包含等待解释器和工具的时间；"
        "每次运行最多 1000 次外部调用。",
    ]
    if listed:
        tools_text = "可直接调用的工具（[name] 表示可省略的参数）：\n" + "\n".join(listed)
        if remaining:
            tools_text += f"\n（另有 {remaining} 个工具未列出，用 search_tools 查询）"
        parts.append(tools_text)
    if catalog.namespaces:
        parts.append(
            "可检索的服务（工具名为 tools.<服务>__<工具>，先用 search_tools / describe_tool 查询）：\n"
            + "\n".join(f"- {ns.name}: {ns.description}" for ns in catalog.namespaces)
        )
    return "\n\n".join(parts)


def code_mode_tool(pool: pm.AsyncMonty, backend, catalog: CodeModeCatalog) -> BaseTool:
    """为一个角色创建 run_code；函数表只含该角色的 MCP 工具和 backend 函数。"""

    stubs = _stubs(catalog, _script_functions(catalog, backend, None))

    @tool(CODE_TOOL, description=_description(catalog))
    async def run_code(
        code: str,
        tool_call_id: Annotated[str, InjectedToolCallId],
        timeout: int = DEFAULT_TIMEOUT,
    ) -> ToolMessage:
        """Run a Python script that orchestrates tool calls."""
        timeout = max(1, min(int(timeout), MAX_TIMEOUT))
        execution = _Execution(timeout)
        # Monty external lookups can execute in host callback tasks whose contextvars
        # do not inherit the graph tool task's context. Bind this one invocation's
        # observed version explicitly, never on the shared role backend.
        call_backend = backend.for_code_call() if hasattr(backend, "for_code_call") else backend
        functions = _script_functions(catalog, call_backend, execution)
        output = pm.CollectString()
        status, error, value = "success", None, None
        try:
            value = await execution.run(
                pool,
                {
                    "limits": {"max_feed_duration_secs": timeout, "max_memory": MAX_MEMORY},
                    "type_check": True,
                    "type_check_stubs": stubs,
                },
                code,
                inputs={"tools": pm.ClassInstance(_Tools(catalog, execution), allowed_methods=set(catalog.by_name))},
                external_lookup=functions,
                print_callback=output,
            )
        except TimeoutError:
            status, error = "error", f"脚本超过 {timeout} 秒墙钟时限，已终止。"
        except pm.MontyRuntimeError as failure:
            status, error = "error", failure.display()
        except pm.MontyTypingError as failure:
            status, error = "error", f"类型检查未通过，脚本没有执行，也没有调用任何工具：\n{failure.display()}"
        except pm.MontyError as failure:
            status, error = "error", f"{type(failure).__name__}: {failure}"
        printed = output.output.rstrip()
        parts = [f"脚本{'完成' if status == 'success' else '失败'}"]
        if printed:
            parts.append(f"输出：\n{printed}")
        if status == "success" and value is not None:
            parts.append(f"返回值：\n{_render_value(value)}")
        if error:
            parts.append(f"错误：\n{error}")
        content = "\n\n".join(parts)
        if status == "error":
            content += _summary(execution)
        return ToolMessage(
            content=content,
            tool_call_id=tool_call_id,
            name=CODE_TOOL,
            status=status,
            artifact={"calls": execution.records, "dropped_calls": execution.dropped_records},
        )

    return run_code


class CodeModeMiddleware(AgentMiddleware):
    """建图时生成 run_code 的目录与描述；只借用运行时 Monty 池和角色 backend。"""

    def __init__(self, pool: pm.AsyncMonty, backend, catalog: CodeModeCatalog):
        super().__init__()
        self.tools = [code_mode_tool(pool, backend, catalog)]
