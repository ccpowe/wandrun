"""订阅通道的最小 LangChain 实验适配器：文本、工具调用、原生 Schema 和 client tool_search。

凭据由注入的组件管理；非网关入口默认只读。支持文本/图片/PDF 输入及同步/异步增量输出。
invoke 收齐返回 AIMessage，stream 逐段返回；完整回放项和用量仅在成功结束时附加。
AgentOutput 通信正文收齐响应后合并返回，避免把多个 JSON 对象当成增量正文。
"""

import json
import logging
import math
import re
from contextlib import aclosing, closing
from pathlib import Path
from threading import Lock
from typing import Annotated, Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import httpx
from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.chat_models import (
    agenerate_from_stream,
    generate_from_stream,
)
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.utils.function_calling import (
    convert_to_openai_function,
    convert_to_openai_tool,
)
from langgraph.errors import GraphBubbleUp
from pydantic import Field, PrivateAttr, TypeAdapter

from wandrun.runtime.messages import AgentOutput, merge_response_outputs
from wandrun.integrations.human_preview import HumanPreviewParser
from wandrun.runtime.preview import current_preview
from wandrun.metrics import record_request
from wandrun.integrations.codex_credentials import CodexCredentials, CredentialSnapshot

logger = logging.getLogger(__name__)

# 同时用于请求体和 HTTP header，限制为 1–64 个可见 ASCII 字符。
CacheKey = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[\x21-\x7e]+$")]
ReasoningEffort = Annotated[str, Field(min_length=1)]

# 原生 client tool_search 调用在 LangChain 侧使用的工具名。
TOOL_SEARCH = "tool_search"


def namespaced_tool_name(namespace: str, name: str) -> str:
    """namespace 内工具在 LangChain 侧的名称；含点号，不会与顶层 function 名冲突。"""
    return f"{namespace}.{name}"


def raw_tool_call(messages, call_id: str) -> dict | None:
    """历史 AIMessage 原始输出项中 call_id 对应的调用项。

    原生搜索与 namespace 调用的身份以原始项为准，不能从 LangChain 侧名称推断：
    普通函数或远端工具可能与 tool_search 同名。
    """
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            for item in message.additional_kwargs.get("codex_output_items") or []:
                if item.get("call_id") == call_id and item.get("type") in {
                    "function_call",
                    "tool_search_call",
                }:
                    return item
    return None


def is_client_search(item) -> bool:
    return item.get("type") == "tool_search_call" and item.get("execution") == "client"


def tool_search_namespace(name: str, description: str, tools) -> dict:
    """把一个服务的命中工具转成 tool_search_output 中的延迟加载 namespace。

    返回纯 JSON 数据，可放入 ToolMessage.artifact 并随检查点持久化。
    """
    converted = []
    for tool in tools:
        function = convert_to_openai_tool(tool)["function"]
        converted.append({"type": "function", **function, "defer_loading": True})
    return {"type": "namespace", "name": name, "description": description, "tools": converted}


class CodexSubscriptionHTTPError(RuntimeError):
    """订阅通道 HTTP 错误；展示正文可截断，error_payload 保留脱敏的分类字段。"""

    def __init__(self, status_code: int, detail: str, error_payload: dict | None = None):
        super().__init__(f"订阅请求 HTTP {status_code}：{detail}")
        self.status_code = status_code
        self.detail = detail
        self.error_payload = error_payload


class CodexSubscriptionStreamError(RuntimeError):
    """SSE 连接未产生完整响应。"""


class ContextWindowExceededError(RuntimeError):
    """Provider explicitly rejected an input for exceeding its context window."""


_CONTEXT_ERROR_CODES = frozenset({
    "context_length_exceeded", "context_window_exceeded",
    "context_length_error", "context_window_error",
})


def _context_window_exceeded(payload):
    """Classify provider-controlled codes, never an HTTP status or prose message."""
    if not isinstance(payload, dict):
        return False
    for item in (payload, payload.get("error"), payload.get("incomplete_details")):
        if isinstance(item, dict):
            if any(
                isinstance(item.get(key), str)
                and item[key].lower() in _CONTEXT_ERROR_CODES
                for key in ("code", "type", "reason")
            ):
                return True
    return False



def _safe_detail(value):
    # Provider descriptions can contain generated media or other opaque payloads.
    if not isinstance(value, str) or not value or len(value) > 500:
        return None
    if "base64," in value.lower() or re.search(r"[A-Za-z0-9+/=_-]{64,}", value):
        return None
    return value


def _http_error_payload(detail):
    """Extract only safe, recognized error fields before truncating display text."""
    try:
        source = json.loads(detail)
    except ValueError:
        return None
    if not isinstance(source, dict):
        return {}

    def selected_fields(source, fields):
        result = {}
        for key in fields:
            value = source.get(key)
            if key in {"resets_at", "reset_at"} and isinstance(value, (int, float)) and not isinstance(value, bool):
                result[key] = value
            elif safe := _safe_detail(value):
                result[key] = safe
        return result

    payload = selected_fields(source, ("code", "message", "detail", "limit_id", "resets_at", "reset_at"))
    for key, fields in (
        ("error", ("code", "type", "message", "limit_id", "resets_at", "reset_at")),
        ("incomplete_details", ("reason",)),
    ):
        value = source.get(key)
        if isinstance(value, dict):
            payload[key] = selected_fields(value, fields)
    return payload


def is_retryable_model_error(error: Exception) -> bool:
    """只重试明确可恢复的传输错误和临时 HTTP 状态。"""
    if isinstance(error, (httpx.TransportError, CodexSubscriptionStreamError)):
        return True
    if isinstance(error, CodexSubscriptionHTTPError):
        return error.status_code in {408, 409, 429} or error.status_code >= 500
    return False


class ModelRequestBudget:
    """一次运行的请求计数；不同角色模型和同步/异步调用共享同一个实例。"""

    def __init__(self, limit: int):
        if type(limit) is not int or limit <= 0:
            raise ValueError("模型请求上限必须为正整数")
        self.limit = limit
        self._used = 0
        self._lock = Lock()

    def consume(self) -> None:
        with self._lock:
            if self._used >= self.limit:
                raise RuntimeError(f"达到 {self.limit} 次模型请求上限")
            self._used += 1


class CodexSubscriptionModel(BaseChatModel):
    model_name: str = "gpt-5.5"
    timeout: float = 60
    reasoning_effort: ReasoningEffort | None = None
    request_budget: ModelRequestBudget | None = Field(default=None, exclude=True)
    credentials: CodexCredentials = Field(default_factory=CodexCredentials, exclude=True, repr=False)
    prompt_cache_key: CacheKey | None = None
    _requests: list[dict] = PrivateAttr(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "codex-subscription-experiment"

    @property
    def request_summaries(self) -> list[dict]:
        """仅记录协议路径，不保存凭据或用户消息。"""
        return list(self._requests)

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        converted = [convert_to_openai_tool(tool) for tool in tools]
        if tool_choice is not None:
            kwargs["tool_choice"] = "required" if tool_choice == "any" else tool_choice
        return self.bind(tools=converted, **kwargs)

    def project_request(self, messages, stop=None, **kwargs) -> dict:
        """Encode the actual Responses request without consuming budget or recording it."""
        if stop or set(kwargs) - {
            "tools",
            "tool_choice",
            "response_format",
            "prompt_cache_key",
        }:
            raise ValueError(
                "此实验仅支持 tools、tool_choice、response_format 和 prompt_cache_key"
            )
        # 调用参数优先，不修改共享模型；不同会话可绑定各自的稳定 key。
        cache_key = TypeAdapter(CacheKey | None).validate_python(
            kwargs.get("prompt_cache_key", self.prompt_cache_key)
        )
        instructions, inputs = [], []
        # 原生搜索调用的结果要编码为 tool_search_output，而不是 function_call_output。
        search_calls = set()
        for message in messages:
            if isinstance(message, SystemMessage):
                content = _input_content(message.content, text_only=True)
                if isinstance(content, list):
                    content = "\n".join(part["text"] for part in content)
                instructions.append(content)
            elif isinstance(message, HumanMessage):
                inputs.append(
                    {"role": "user", "content": _input_content(message.content)}
                )
            elif isinstance(message, AIMessage):
                raw_items = message.additional_kwargs.get("codex_output_items")
                if raw_items is None:
                    raise ValueError("此实验仅回放自身生成的 AIMessage")
                # store=false 时不能按服务端 item id 查询；回填完整内容。
                inputs.extend(
                    {k: v for k, v in item.items() if k != "id"} for item in raw_items
                )
                search_calls.update(
                    item["call_id"] for item in raw_items if is_client_search(item)
                )
            elif isinstance(message, ToolMessage) and message.tool_call_id in search_calls:
                inputs.append(
                    {
                        "type": "tool_search_output",
                        "execution": "client",
                        "call_id": message.tool_call_id,
                        "status": "completed",
                        "tools": _search_output_tools(message.artifact),
                    }
                )
            elif isinstance(message, ToolMessage):
                inputs.append(
                    {
                        "type": "function_call_output",
                        "call_id": message.tool_call_id,
                        "output": _input_content(
                            message.content, source=message.additional_kwargs.get("read_file_path"),
                        ),
                    }
                )
            else:
                raise ValueError(f"不支持的消息类型：{message.type}")
        body: dict[str, Any] = {
            "model": self.model_name,
            "instructions": "\n".join(instructions) or "You are a helpful assistant.",
            "input": inputs,
            "store": False,
            "stream": True,
            "include": ["reasoning.encrypted_content"],
        }
        if self.reasoning_effort is not None:
            body["reasoning"] = {"effort": self.reasoning_effort}
        if cache_key is not None:
            body["prompt_cache_key"] = cache_key
        tools = kwargs.get("tools", [])
        if tools:
            body["tools"] = []
            for tool in tools:
                if tool.get("type") == "function":
                    body["tools"].append({"type": "function", **tool["function"]})
                elif tool.get("type") == TOOL_SEARCH and tool.get("execution") == "client":
                    body["tools"].append(tool)
                else:
                    raise ValueError("此实验仅支持 function 工具和 client tool_search")
        if "tool_choice" in kwargs:
            body["tool_choice"] = kwargs["tool_choice"]
        if response_format := kwargs.get("response_format"):
            if response_format["type"] != "json_schema":
                raise ValueError("此实验仅支持 json_schema 输出格式")
            spec = response_format["json_schema"]
            # 复用 LangChain 的严格 Schema 转换，补齐 additionalProperties 等约束。
            strict_tool = convert_to_openai_function(
                {"name": spec["name"], "parameters": spec["schema"]},
                strict=spec.get("strict", False),
            )
            body["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": spec["name"],
                    "strict": spec.get("strict", False),
                    "schema": strict_tool["parameters"],
                }
            }
        return body

    def estimate_request_tokens(self, messages, **kwargs) -> int:
        """Conservative text estimate of the projected input, not a provider upper bound.

        Images/PDFs have a fixed provisional reserve since resolution, PDF pages and
        provider tokenization are unknown; callers still need upstream overflow recovery.
        Opaque base64/encrypted content is never counted as textual tokens.
        """
        return _estimate_projected_tokens(self.project_request(messages, **kwargs))

    def _build_request(self, messages, stop=None, **kwargs):
        body = self.project_request(messages, stop, **kwargs)
        cache_key = body.get("prompt_cache_key")
        inputs = body["input"]
        if self.request_budget is not None:
            self.request_budget.consume()
        self._requests.append(
            {
                "tools": [tool.get("name", tool["type"]) for tool in body.get("tools", [])],
                "tool_choice": body.get("tool_choice"),
                "text_format": body.get("text", {}).get("format", {}).get("type"),
                "strict": body.get("text", {}).get("format", {}).get("strict"),
                "input_types": [item.get("type", item.get("role")) for item in inputs],
                "prompt_cache_key": cache_key,
                "reasoning_effort": self.reasoning_effort,
            }
        )
        return body

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return generate_from_stream(self._stream(messages, stop=stop, **kwargs))

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return await agenerate_from_stream(self._astream(messages, stop=stop, **kwargs))

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        body = self._build_request(messages, stop, **kwargs)
        scope = current_preview.get()
        state = _ResponseStream(self.model_name, kwargs.get("response_format"), preview=scope)
        try:
            with record_request(self.model_name) as trace:
                with closing(self._request(body)) as events:
                    for event in events:
                        if trace is not None:
                            trace.observe(event)
                        for chunk in state.feed(event):
                            if run_manager is not None:
                                run_manager.on_llm_new_token(
                                    chunk.message.content, chunk=chunk
                                )
                            yield chunk
                        if state.completed:
                            return
                raise CodexSubscriptionStreamError(
                    "SSE 提前结束，未收到 response.completed"
                )
        finally:
            if scope is not None and state.attempt_id is not None and not state.completed:
                scope.failed_attempt(state.attempt_id)

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        body = self._build_request(messages, stop, **kwargs)
        scope = current_preview.get()
        state = _ResponseStream(self.model_name, kwargs.get("response_format"), preview=scope)
        try:
            with record_request(self.model_name) as trace:
                async with aclosing(self._arequest(body)) as events:
                    async for event in events:
                        if trace is not None:
                            trace.observe(event)
                        for chunk in state.feed(event):
                            if run_manager is not None:
                                await run_manager.on_llm_new_token(
                                    chunk.message.content, chunk=chunk
                                )
                            yield chunk
                        if state.completed:
                            return
                raise CodexSubscriptionStreamError(
                    "SSE 提前结束，未收到 response.completed"
                )
        finally:
            if scope is not None and state.attempt_id is not None and not state.completed:
                scope.failed_attempt(state.attempt_id)

    @staticmethod
    def _usage_metadata(response):
        usage = response.get("usage")
        usage_metadata = None
        if usage is not None:
            # 总输入量已包含缓存 tokens，总输出量已包含 reasoning，不能重复相加。
            usage_metadata = {
                key: usage[key]
                for key in ("input_tokens", "output_tokens", "total_tokens")
            }
            input_details = usage.get("input_tokens_details") or {}
            output_details = usage.get("output_tokens_details") or {}
            usage_metadata["input_token_details"] = {
                target: input_details[source]
                for source, target in (
                    ("cached_tokens", "cache_read"),
                    ("cache_write_tokens", "cache_creation"),
                )
                if source in input_details
            }
            usage_metadata["output_token_details"] = (
                {"reasoning": output_details["reasoning_tokens"]}
                if "reasoning_tokens" in output_details
                else {}
            )
        return usage_metadata

    @staticmethod
    def _prepare_http_request(body, credential: CredentialSnapshot):
        headers = dict(credential.headers)
        if cache_key := body.get("prompt_cache_key"):
            headers["session-id"] = cache_key
        request = Request(
            "https://chatgpt.com/backend-api/codex/responses",
            data=json.dumps(body).encode(),
            headers=headers,
        )
        return request

    @staticmethod
    def _http_error(status, detail, tokens):
        for secret in tokens.values():
            if isinstance(secret, str) and secret:
                detail = detail.replace(secret, "[REDACTED]")
        payload = _http_error_payload(detail)
        if _context_window_exceeded(payload):
            return ContextWindowExceededError(f"订阅请求超过上下文窗口（HTTP {status}）")
        return CodexSubscriptionHTTPError(status, detail[:1500], payload)

    def _request(self, body):
        credential = self.credentials.get()
        replay = not any(tool.get("type") == "image_generation" for tool in body.get("tools", []))
        for attempt in range(2):
            request = self._prepare_http_request(body, credential)
            decoder = _SSEDecoder()
            started = False
            try:
                with urlopen(request, timeout=self.timeout) as stream:
                    started = True
                    self.credentials.accepted(credential)
                    for line in stream:
                        if event := decoder.feed(line.decode("utf-8")):
                            self._observe_auth_event(event, credential)
                            yield event
                    if event := decoder.feed(""):
                        self._observe_auth_event(event, credential)
                        yield event
                return
            except HTTPError as error:
                detail = error.read().decode(errors="replace")
                error.close()
                if error.code == 401:
                    self.credentials.rejected(credential, retry_exhausted=bool(attempt))
                    if replay and not started and attempt == 0:
                        credential = self.credentials.recover(credential)
                        continue
                elif error.code >= 500:
                    self.credentials.temporary_failure(credential)
                raise self._http_error(error.code, detail, credential.tokens) from None
            except URLError:
                self.credentials.temporary_failure(credential)
                raise

    async def _arequest(self, body):
        credential = await self.credentials.aget()
        # Even a header-level rejection must not replay an image-generation request.
        replay = not any(tool.get("type") == "image_generation" for tool in body.get("tools", []))
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for attempt in range(2):
                request = self._prepare_http_request(body, credential)
                decoder = _SSEDecoder()
                try:
                    async with client.stream(
                        "POST", request.full_url, content=request.data,
                        headers=dict(request.header_items()),
                    ) as response:
                        if response.is_error:
                            detail = (await response.aread()).decode(errors="replace")
                            if response.status_code == 401:
                                self.credentials.rejected(credential, retry_exhausted=bool(attempt))
                                if replay and attempt == 0:
                                    credential = await self.credentials.arecover(credential)
                                    continue
                            elif response.status_code >= 500:
                                self.credentials.temporary_failure(credential)
                            raise self._http_error(response.status_code, detail, credential.tokens)
                        self.credentials.accepted(credential)
                        async for line in response.aiter_lines():
                            if event := decoder.feed(line):
                                self._observe_auth_event(event, credential)
                                yield event
                        if event := decoder.feed(""):
                            self._observe_auth_event(event, credential)
                            yield event
                    return
                except httpx.TransportError:
                    self.credentials.temporary_failure(credential)
                    raise

    def _observe_auth_event(self, event, credential):
        # A 200 stream may subsequently report authentication failure. Report it,
        # but never restart a stream: the provider may already have executed tools.
        if not isinstance(event, dict):
            return
        payload = event.get("response") or event
        if not isinstance(payload, dict):
            return
        error = payload.get("error")
        if isinstance(error, dict) and (
            error.get("code") in {"unauthorized", "invalid_token", "invalid_authentication_token"}
            or error.get("status_code") == 401
        ):
            self.credentials.rejected(credential)


def prepare_subscription_request(
    kind: str, *, client_version: str, credential: CredentialSnapshot,
) -> Request:
    """Project a credential snapshot onto a fixed-host catalog or quota GET."""
    from urllib.parse import urlencode

    paths = {"models": "/codex/models", "usage": "/wham/usage"}
    path = paths[kind]
    if kind == "models":
        path += "?" + urlencode({"client_version": client_version})
    return Request(
        "https://chatgpt.com/backend-api" + path,
        headers={**credential.headers, "Accept": "application/json"},
    )


def _estimate_projected_tokens(body: dict) -> int:
    """Estimate visible request semantics; opaque media bytes are not text tokens.

    1.5x UTF-8/4 is a conservative approximate baseline, not a hard tokenizer
    bound. Image/PDF reservations (6k/16k each) are provisional: image tiling,
    PDF page count and extracted text cannot be inferred from an encoded payload.
    """
    byte_count = 0
    media_tokens = 0

    def visit(value):
        nonlocal byte_count, media_tokens
        if isinstance(value, str):
            byte_count += len(value.encode("utf-8"))
        elif isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            kind = value.get("type")
            if kind == "input_image":
                media_tokens += 6000
            elif kind == "input_file":
                media_tokens += 16000
            for key, item in value.items():
                if key in {"file_data", "image_url", "encrypted_content", "base64", "id"}:
                    continue
                byte_count += len(key)
                visit(item)

    visit(body["instructions"])
    visit(body["input"])
    visit(body.get("tools", []))
    visit(body.get("text", {}))
    # Include request framing per input item and tool; control fields are small.
    framing = 12 * len(body["input"]) + 24 * len(body.get("tools", [])) + 32
    return math.ceil(byte_count * 1.5 / 4) + media_tokens + framing




def _search_output_tools(artifact):
    """搜索结果的工具定义；无 artifact 表示未加载任何工具（含搜索失败）。"""
    if artifact is None:
        return []
    if not isinstance(artifact, list) or not all(isinstance(t, dict) for t in artifact):
        raise ValueError("tool_search 结果的 artifact 必须是工具定义列表")
    return artifact


def _call_name(item):
    if is_client_search(item):
        return TOOL_SEARCH
    if namespace := item.get("namespace"):
        return namespaced_tool_name(namespace, item["name"])
    return item["name"]


def _omitted_content(block, reason, source=None):
    """Describe omitted media without echoing its binary payload or reading its source."""
    kind = block.get("type", "unknown")
    extras = block.get("extras")
    extras = extras if isinstance(extras, dict) else {}
    image = block.get("image_url")
    image_url = image.get("url") if isinstance(image, dict) else image
    origin = source or block.get("url") or image_url or block.get("file_id")
    if not isinstance(origin, str) or origin.startswith("data:"):
        origin = "内联数据" if block.get("base64") or origin else "未知"
    filename = block.get("filename") or extras.get("filename")
    if not filename and source:
        filename = Path(source).name
    mime = block.get("mime_type") or "未知"
    size = block.get("size", extras.get("size"))
    encoded = block.get("base64")
    if size is None and isinstance(encoded, str):
        padding = 2 if encoded.endswith("==") else int(encoded.endswith("="))
        size = f"约 {max(0, len(encoded) * 3 // 4 - padding)}"
    return {
        "type": "input_text",
        "text": (
            f"[内容未发送给模型：块类型={kind}；来源={origin}；"
            f"文件名={filename or '未知'}；MIME={mime}；大小={size if size is not None else '未知'} 字节。"
            f"原因：{reason}。模型尚未读取这部分内容；"
            "可用命令行工具提取文字、音频转录或视频抽帧，或转换为支持的 PDF/图片后重新读取。]"
        ),
    }


def _input_content(content, *, source=None, text_only=False):
    """Project each history block into a request; never mutate stored messages.

    Only inline PDF files have a verified input_file shape. Unsupported sources
    become actionable text, not local file reads or a failure of the whole turn.
    Actual HTTP/provider errors remain the request layer's responsibility.
    """
    if isinstance(content, str):
        return content
    parts = []
    for block in content:
        if isinstance(block, str):
            parts.append({"type": "input_text", "text": block})
            continue
        if not isinstance(block, dict):
            parts.append(_omitted_content({}, "无法表示的内容块", source))
            continue
        kind = block.get("type")
        if kind in ("text", "input_text") and isinstance(block.get("text"), str):
            parts.append({"type": "input_text", "text": block["text"]})
            continue
        if text_only:
            parts.append(_omitted_content(block, "系统指令只支持文字", source))
            continue
        extras = block.get("extras")
        extras = extras if isinstance(extras, dict) else {}
        if kind == "file":
            encoded = block.get("base64")
            if block.get("mime_type") == "application/pdf" and isinstance(encoded, str) and encoded:
                filename = block.get("filename") or extras.get("filename") or source
                filename = Path(filename).name if isinstance(filename, str) else "document.pdf"
                parts.append({
                    "type": "input_file", "filename": filename or "document.pdf",
                    "file_data": f"data:application/pdf;base64,{encoded}",
                })
            else:
                parts.append(_omitted_content(
                    block, "当前订阅文件输入仅验证了内联 base64 PDF；此文件类型或来源未受支持", source,
                ))
            continue
        detail = block.get("detail", extras.get("detail", "auto"))
        url = None
        if kind == "image_url":
            image = block.get("image_url")
            url = image if isinstance(image, str) else None
            if isinstance(image, dict):
                url = image.get("url")
                detail = image.get("detail", detail)
        elif kind == "input_image":
            url = block.get("image_url")
        elif kind == "image":
            url = block.get("url")
            encoded, mime = block.get("base64"), block.get("mime_type")
            if not url and isinstance(encoded, str) and encoded and isinstance(mime, str) and mime.startswith("image/"):
                url = f"data:{mime};base64,{encoded}"
        else:
            parts.append(_omitted_content(block, "当前订阅输入不支持此内容块类型", source))
            continue
        if not isinstance(url, str) or not url.startswith(("https://", "http://", "data:image/")):
            parts.append(_omitted_content(
                block, "图片需要 HTTP(S) URL 或带 image MIME 的内联数据；不读取本地路径或解析 file_id", source,
            ))
        elif detail not in ("auto", "low", "high", "original"):
            parts.append(_omitted_content(block, "无法表示的图片 detail 参数", source))
        else:
            parts.append({"type": "input_image", "image_url": url, "detail": detail})
    return parts


class _SSEDecoder:
    """按 SSE 空行分帧，支持多行 data、注释和 CRLF。"""

    def __init__(self):
        self.data = []

    def feed(self, line):
        line = line.rstrip("\r\n")
        if line.startswith("data:"):
            self.data.append(line[5:].removeprefix(" "))
        elif not line and self.data:
            data, self.data = "\n".join(self.data), []
            if data != "[DONE]":
                return json.loads(data)
        return None


class _ResponseStream:
    """每个请求独立的增量状态；完成项用于校验、补齐及无损历史回放。"""

    def __init__(self, model_name, response_format=None, *, preview=None):
        self.model_name = model_name
        # 只合并本项目的通信协议；不能把任意 JSON Schema 当作 AgentOutput。
        self.merge_communication = (response_format or {}).get(
            "type"
        ) == "json_schema" and (response_format or {}).get("json_schema", {}).get(
            "schema"
        ) == AgentOutput.model_json_schema()
        self.preview = preview if self.merge_communication and preview is not None and preview.enabled else None
        self.attempt_id = None
        if self.preview is not None:
            try:
                self.attempt_id = self.preview.begin()
            except GraphBubbleUp:
                raise
            except Exception:
                logger.exception("Human preview attempt initialization failed")
                self.preview.disable()
                self.preview = None
        self.parsers: dict[int, HumanPreviewParser] = {}
        self.preview_parts: dict[int, int] = {}
        self.items = {}
        self.texts = {}
        self.arguments = {}
        self.names = {}
        self.tools = set()
        self.completed = False

    @staticmethod
    def chunk(**kwargs):
        return ChatGenerationChunk(
            message=AIMessageChunk(content=kwargs.pop("content", ""), **kwargs)
        )

    def _tool_start(self, index, item):
        name = _call_name(item)
        if index in self.tools:
            # LangChain 按 index 拼接名称片段，起始后无法再改名，只能报错。
            if self.names[index] != name:
                raise RuntimeError("完成工具名称与起始项不一致")
            return
        self.tools.add(index)
        self.names[index] = name
        self.arguments[index] = ""
        yield self.chunk(
            tool_call_chunks=[
                {"index": index, "id": item["call_id"], "name": name, "args": ""}
            ]
        )

    def _finish_item(self, index, item):
        self.items[index] = item
        if self.merge_communication and item["type"] == "message":
            return  # completed 中以完整 output 列表解析一次，不提前发出正文。
        if item["type"] == "message" and item.get("phase") != "commentary":
            for part_index, part in enumerate(item.get("content", [])):
                if part["type"] == "refusal":
                    raise RuntimeError("模型拒绝了请求：" + part.get("refusal", ""))
                if part["type"] != "output_text":
                    continue
                key = (index, part_index)
                prior = self.texts.get(key, "")
                if not part["text"].startswith(prior):
                    raise RuntimeError("完成文本与已发送增量不一致")
                suffix = part["text"][len(prior) :]
                self.texts[key] = part["text"]
                if suffix:
                    yield self.chunk(content=suffix)
        elif item["type"] == "function_call" or is_client_search(item):
            yield from self._tool_start(index, item)
            arguments = item["arguments"]
            if is_client_search(item):
                # 搜索参数以对象返回且没有增量事件，完成时一次发出。
                arguments = json.dumps(arguments, ensure_ascii=False)
            if not isinstance(json.loads(arguments), dict):
                raise ValueError("工具参数必须为 JSON 对象")
            prior = self.arguments[index]
            if not arguments.startswith(prior):
                raise RuntimeError("完成工具参数与已发送增量不一致")
            self.arguments[index] = arguments
            if suffix := arguments[len(prior) :]:
                yield self.chunk(tool_call_chunks=[{"index": index, "args": suffix}])

    def feed(self, event):
        kind = event.get("type")
        index = event.get("output_index", 0)
        if kind in {"error", "response.failed", "response.incomplete"}:
            if _context_window_exceeded(event) or _context_window_exceeded(event.get("response")):
                raise ContextWindowExceededError(f"订阅响应超过上下文窗口：{kind}")
            raise RuntimeError(f"订阅响应失败：{kind}")
        if kind == "response.output_item.added":
            item = self.items[index] = event["item"]
            if item["type"] == "function_call":
                yield from self._tool_start(index, item)
            if (
                self.preview is not None and self.preview.enabled and item.get("type") == "message"
                and item.get("role") == "assistant"
                and item.get("phase") in {None, "commentary", "final_answer"}
            ):
                try:
                    self.parsers[index] = HumanPreviewParser()
                except GraphBubbleUp:
                    raise
                except Exception:
                    logger.exception("Human preview parser initialization failed")
                    self.preview.disable()
        elif kind == "response.output_text.delta":
            part_index = event.get("content_index", 0)
            if self.preview is not None and self.preview.enabled and index in self.parsers:
                previous = self.preview_parts.get(index, 0)
                if previous <= part_index <= previous + 1:
                    self.preview_parts[index] = part_index
                    try:
                        updates = self.parsers[index].feed(event["delta"])
                        for message_index, text in updates:
                            self.preview.update(
                                self.attempt_id, index, message_index, text,
                                self.items[index].get("phase"),
                            )
                    except GraphBubbleUp:
                        raise
                    except Exception:
                        logger.exception("Human preview parser failed")
                        self.preview.disable()
                else:
                    self.parsers[index].disabled = True  # Out-of-order parts cannot be routed safely.
                    self.preview.failed_attempt(self.attempt_id)
            if (
                not self.merge_communication
                and self.items.get(index, {}).get("phase") != "commentary"
            ):
                key = (index, event.get("content_index", 0))
                self.texts[key] = self.texts.get(key, "") + event["delta"]
                yield self.chunk(content=event["delta"])
        elif kind == "response.function_call_arguments.delta":
            if index not in self.tools:
                raise RuntimeError("工具参数增量缺少 function_call 起始项")
            self.arguments[index] += event["delta"]
            yield self.chunk(
                tool_call_chunks=[{"index": index, "args": event["delta"]}]
            )
        elif kind == "response.output_item.done":
            yield from self._finish_item(index, event["item"])
        elif kind == "response.completed":
            response = event["response"]
            if response.get("status") != "completed":
                if _context_window_exceeded(response):
                    raise ContextWindowExceededError("订阅响应超过上下文窗口")
                raise RuntimeError("响应未完成")
            output_items = response.get("output")
            if output_items:
                items = output_items
                by_id = {
                    item["id"]: raw_index for raw_index, item in self.items.items()
                    if item.get("id") is not None
                }
                positional = set(self.items) == set(range(len(items)))
                output_indices = [
                    by_id.get(item["id"]) if item.get("id") is not None
                    else index if positional else None
                    for index, item in enumerate(items)
                ]
            else:
                output_indices = sorted(self.items)
                items = [self.items[index] for index in output_indices]
            for index, item in enumerate(items):
                yield from self._finish_item(index, item)
            sources: list[tuple[int, int]] | None = [] if self.preview is not None else None
            communication = (
                merge_response_outputs(items, message_sources=sources)
                if self.merge_communication else None
            )
            if self.merge_communication and communication is None and not self.tools:
                raise RuntimeError("响应完成，但没有结构化通信或工具调用")
            if (
                communication is None
                and not any(self.texts.values())
                and not self.tools
            ):
                raise RuntimeError("响应完成，但没有文本或工具调用")
            self.completed = True
            draft_ids = None
            if self.preview is not None:
                try:
                    if communication is not None and sources is not None:
                        draft_ids = [
                            self.preview.id_for(self.attempt_id, output_indices[item_index], message_index)
                            if output_indices[item_index] is not None else None
                            for item_index, message_index in sources
                        ]
                    self.preview.complete_attempt(self.attempt_id)
                except GraphBubbleUp:
                    raise
                except Exception:
                    logger.exception("Human preview completion failed")
                    self.preview.disable()
                    draft_ids = None
            yield self.chunk(
                content=communication.model_dump_json() if communication else "",
                chunk_position="last",
                additional_kwargs={
                    "codex_output_items": items,
                    **(
                        {"wandrun_agent_output": communication.model_dump()}
                        if communication
                        else {}
                    ),
                    **({"wandrun_draft_ids": draft_ids} if draft_ids is not None else {}),
                },
                usage_metadata=CodexSubscriptionModel._usage_metadata(response),
                response_metadata={
                    "model_name": self.model_name,
                    "status": response["status"],
                    "usage": response.get("usage"),
                },
            )
