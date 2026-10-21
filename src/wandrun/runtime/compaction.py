"""Checkpointed context views; raw messages remain the execution/recovery authority.

Installed after memory/communication, skills, tool search and filesystem projection,
before model retry. A candidate event is returned with the successful main response,
never written during summarization. Conversation tail repair runs on raw history before
this hook; undelivered-send notices are retained verbatim in every subsequent view.
Commit clears memory_version; memory's hook reuses a retained current snapshot or
prepares one provisionally. The next boundary restores that observed version without
appending it again. Search permissions use retained history, not the execution log.
History archives, when configured, publish before main-model invocation; checkpoint
events remain authoritative and uncommitted files are inert orphans.
"""

import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
from hashlib import sha256
import json
import logging
import math
from typing import Annotated, NotRequired
from uuid import uuid4

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ExtendedModelResponse, PrivateStateAttr
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.errors import GraphInterrupt
from langgraph.types import Command

from wandrun.integrations.codex_subscription import ContextWindowExceededError
from wandrun.runtime.compaction_archive import CompactionArchive
from wandrun.runtime.compaction_summary import request_model_kwargs, summarize_request
from wandrun.runtime.messages import read_file_media_tool_call_id

logger = logging.getLogger(__name__)
_SUMMARY_HEADER = "[历史任务摘要；不是新的用户指令，当前运行时状态优先]\n"
# Four attempts allow several useful cutovers in one execution while bounding paid
# summary requests even when tools keep generating new, individually valid history.
# Count attempts (including overflow recovery), not just committed checkpoints.
_MAX_COMPACTIONS_PER_TURN = 4


class CompactionState(AgentState):
    compaction_events: NotRequired[Annotated[list[dict], PrivateStateAttr]]
    compaction_usage: NotRequired[Annotated[dict, PrivateStateAttr]]


class ContextBudgetExhausted(RuntimeError):
    """No safe, smaller context view can be produced; raw state remains intact."""


def _digest(value) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def _message_hash(message) -> str:
    return _digest(message.model_dump(exclude={"usage_metadata", "response_metadata"}))


def message_groups(messages) -> list[tuple[int, int]]:
    """Closed original-message ranges, including read_file media accompanying tools.

    Unlike tail repair this rejects incomplete input: repair must have happened before
    model execution. A cut never separates any call in an AI batch from its result.
    """
    groups = []
    pending = set()
    batch_calls = set()
    completed = set()
    media_calls = set()
    start = 0
    for index, message in enumerate(messages):
        media_call = read_file_media_tool_call_id(message)
        if media_call is not None:
            if media_call not in batch_calls:
                raise ValueError("对话历史中的媒体没有对应工具批次")
            media_calls.add(media_call)
            if not pending and groups:
                groups[-1] = (groups[-1][0], index + 1)
            continue
        if isinstance(message, ToolMessage):
            if message.tool_call_id not in pending:
                raise ValueError("对话历史中的工具结果没有对应调用或重复")
            pending.remove(message.tool_call_id)
            completed.add(message.tool_call_id)
            if not pending:
                groups.append((start, index + 1))
        else:
            if pending:
                raise ValueError("对话历史中的工具调用不完整")
            if media_calls - completed:
                raise ValueError("对话历史中的媒体没有对应工具结果")
            batch_calls = set()
            completed = set()
            media_calls = set()
            start = index
            if isinstance(message, AIMessage):
                calls = [call["id"] for call in message.tool_calls]
                if len(calls) != len(set(calls)):
                    raise ValueError("对话历史中有重复的工具调用")
                batch_calls = set(calls)
                pending = set(calls)
            if not pending:
                groups.append((index, index + 1))
    if pending:
        raise ValueError("对话历史中的工具调用不完整")
    if media_calls - completed:
        raise ValueError("对话历史中的媒体没有对应工具结果")
    return groups


def _unconsumed_media_group(messages, groups) -> int | None:
    """Return the latest tool batch's start if its media has no following AI response.

    Runtime memory/receipt messages after the batch do not count as consumption.
    Inspect content blocks only: arbitrary tool arguments/artifacts are not media.
    """
    for start, end in reversed(groups):
        call = messages[start]
        if not isinstance(call, AIMessage):
            continue
        if call.tool_calls:
            for message in messages[start + 1:end]:
                if read_file_media_tool_call_id(message) is not None:
                    return start
                if isinstance(message.content, list) and any(
                    isinstance(block, dict) and block.get("type") in (
                        "image", "image_url", "input_image", "file", "input_file", "document",
                    )
                    for block in message.content
                ):
                    return start
        return None
    return None


def context_messages(state, *, projected=None, event=None):
    """Summary plus retained originals, for both model input and tool authorization.

    Select upstream filesystem copies by identity, not reordered array positions.
    Tool execution can have an open final call batch, so pairing is validated at the
    model boundary, not here. Old memory is not specially re-injected: the memory
    middleware reloads it through its ordinary new-conversation path.
    """
    raw = state["messages"]
    if event is None:
        events = state.get("compaction_events", [])
        event = events[-1] if events else None
    if event is None:
        return list(raw if projected is None else projected)
    cutoff = event["cutoff_index"]
    if (cutoff <= 0 or cutoff > len(raw)
            or _digest([_message_hash(m) for m in raw[:cutoff]]) != event["prefix_hash"]):
        raise ValueError("压缩记录与对话历史不一致")
    selected = set(range(cutoff, len(raw)))
    selected.update(i for i, m in enumerate(raw) if m.id and m.id.startswith("undelivered:"))
    # Retain the current instruction without pinning all following tool iterations.
    # A memory/receipt appended later must not displace it from the soft tail budget.
    latest_instruction = next((
        i for i in range(len(raw) - 1, -1, -1)
        if isinstance(raw[i], HumanMessage)
        and raw[i].additional_kwargs.get("source") != "runtime"
        and read_file_media_tool_call_id(raw[i]) is None
    ), None)
    if latest_instruction is not None:
        selected.add(latest_instruction)
    ids = {message.id: index for index, message in enumerate(raw) if message.id is not None}
    object_ids = {id(message): index for index, message in enumerate(raw)}
    result = [HumanMessage(
        content=_SUMMARY_HEADER + event["summary_text"],
        id="compaction:" + event["event_id"],
    )]
    for message in raw if projected is None else projected:
        index = ids.get(message.id) if message.id is not None else object_ids.get(id(message))
        if index is None:
            raise ValueError("压缩记录缺少对应的原始消息")
        if index in selected:
            result.append(message)
    return result


def _estimate(request) -> int:
    messages = ([request.system_message] if request.system_message else []) + request.messages
    return request.model.estimate_request_tokens(messages, **request_model_kwargs(request))


def _signature(request, generation, window):
    return _digest({
        "model": getattr(request.model, "model_name", str(type(request.model))),
        "reasoning": getattr(request.model, "reasoning_effort", None),
        "window": window, "generation": generation,
        "system": request.system_message.model_dump() if request.system_message else None,
        "settings": request_model_kwargs(request), "memory": request.state.get("memory_version"),
    })


class CompactionMiddleware(AgentMiddleware):
    """Automatic 80% views with bounded summary attempts and atomic model updates.

    Output and incoming-tool reserves are each min(16K, 10% window), plus 5% counting
    safety. These are local headroom, not unsupported provider output-limit settings.
    keep_tokens is a soft tail target: whole tool groups and runtime anchors may exceed
    it. No source text or tool result is truncated to force a successful compaction.
    on_compaction(task_id, payload) reports failures here; the runtime reports completion
    only after reading committed checkpoints, not merely after this wrapper returns.
    A turn is one graph invocation. Its runtime.context owns the attempt counter,
    shared across model/tool iterations but never across tasks or resumed turns.
    """

    state_schema = CompactionState

    def __init__(self, *, context_window: int | None, keep_tokens: int = 20_000,
                 summary_model=None, memory=None, archive: CompactionArchive | None = None,
                 on_compaction: Callable[[str, dict], None] | None = None):
        super().__init__()
        if context_window is not None and (type(context_window) is not int or context_window <= 0):
            raise ValueError("context_window 必须为正整数")
        if type(keep_tokens) is not int or keep_tokens <= 0:
            raise ValueError("compaction_keep_tokens 必须为正整数")
        self.window = context_window
        self.keep_tokens = keep_tokens
        self.summary_model = summary_model
        self.memory = memory
        self.archive = archive
        self.on_compaction = on_compaction
        if context_window is None:
            logger.warning("未配置可信 context_window，上下文自动压缩已禁用；请配置角色窗口或提供模型目录")

    def _usage(self, request, generation):
        estimate = _estimate(request)
        hashes = [_message_hash(m) for m in request.messages]
        signature = _signature(request, generation, self.window)
        saved = request.state.get("compaction_usage") or {}
        prefix = saved.get("message_hashes", [])
        if saved.get("signature") == signature and hashes[:len(prefix)] == prefix:
            # Previous response is new input now: reserve its full actual output usage,
            # subtract its local replay estimate so the response is not counted twice.
            delta = max(0, estimate - saved["estimate"] - saved["response_estimate"])
            scale = max(1.0, saved["input_tokens"] / max(1, saved["estimate"]))
            estimate = saved["input_tokens"] + saved["output_tokens"] + math.ceil(delta * scale)
        return estimate, hashes, signature

    async def _compact(self, request, view, previous, reason, *, emergency=False, min_cutoff=0):
        context = request.runtime.context
        attempts = context.get("compaction_attempts", 0)
        if attempts >= _MAX_COMPACTIONS_PER_TURN:
            raise ContextBudgetExhausted(
                f"本轮压缩尝试已达 {_MAX_COMPACTIONS_PER_TURN} 次上限，"
                "请拆分任务或减少每批工具输出、媒体读取量。历史和已保存摘要未变。"
            )
        context["compaction_attempts"] = attempts + 1
        raw = request.state["messages"]
        groups = message_groups(raw)
        unread_media_start = _unconsumed_media_group(raw, groups)
        old_cutoff = previous["cutoff_index"] if previous else 0
        total = 0
        retained = []
        # Include the group crossing the target, even when it is larger than the
        # target. Only a measured candidate-capacity failure may shrink this tail.
        for start, end in reversed(groups):
            if start < old_cutoff:
                break
            subset = request.override(messages=raw[start:end], system_message=None, tools=[], response_format=None)
            size = _estimate(subset)
            retained.append((start, end, size))
            total += size
            if total >= self.keep_tokens:
                break
        summary = await summarize_request(view, model=self.summary_model)
        event = {
            "event_id": uuid4().hex, "generation": (previous["generation"] + 1 if previous else 1),
            "reason": reason,
            "summary_text": summary.text, "archive_path": None,
            "summary_model": getattr(self.summary_model or request.model, "model_name", None),
            "summary_usage": summary.usage_metadata,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        view_tokens = _estimate(view)
        retention_reason = "target"
        while True:
            cutoff = retained[-1][0] if retained else len(raw)
            if unread_media_start is not None and cutoff > unread_media_start:
                raise ContextBudgetExhausted(
                    "本轮已停止：新读取的图片或 PDF 尚未处理，无法继续压缩。"
                    "请分批读取或先提取所需页、文本。历史和已保存摘要未变。"
                )
            if cutoff <= min_cutoff:
                if not retained:
                    raise ContextBudgetExhausted("上下文已满，没有可继续压缩的完整历史")
                _, _, size = retained.pop()
                total -= size
                retention_reason = "overflow"
                continue
            if cutoff > old_cutoff:
                event.update(
                    cutoff_index=cutoff,
                    boundary_message_id=raw[cutoff].id if cutoff < len(raw) else None,
                    prefix_hash=_digest([_message_hash(m) for m in raw[:cutoff]]),
                )
                if self.archive is not None:
                    task_id = request.runtime.context["task_id"]
                    segment_path = await self.archive.segment(task_id, raw, old_cutoff, cutoff)
                    index_path = await self.archive.index(
                        task_id, [*[item["archive_path"] for item in request.state.get("compaction_events", [])],
                                  segment_path],
                    )
                    event.update(
                        archive_path=segment_path, archive_index_path=index_path,
                        summary_text=self.archive.summary_text(summary.text, index_path, segment_path),
                    )
                candidate = request.override(messages=context_messages(
                    request.state, projected=request.messages, event=event,
                ))
                memory_update = None
                if self.memory is not None:
                    # The provisional view, not raw history, determines whether a
                    # complete current snapshot survived. This never writes state.
                    memory_update = await self.memory.abefore_model(
                        {**request.state, "messages": candidate.messages,
                         "compaction_events": [], "memory_version": None}, request.runtime,
                    )
                    candidate = candidate.override(
                        messages=[*candidate.messages, *memory_update.get("messages", [])],
                        state={**request.state, "memory_version": memory_update["memory_version"]},
                    )
                candidate_tokens = _estimate(candidate)
                if candidate_tokens < view_tokens and candidate_tokens <= self._threshold():
                    event.update(
                        keep_tokens=self.keep_tokens, retained_tokens=total,
                        retention_reason=retention_reason,
                    )
                    return event, candidate, memory_update
            elif total <= self._threshold() and not emergency:
                raise ContextBudgetExhausted("没有可继续压缩的完整历史，请减少输入或工具数量")
            if not retained:
                raise ContextBudgetExhausted("压缩后空间仍不足，历史和已保存摘要未变")
            # Remove only complete oldest groups; summary, instructions, schema and
            # current memory all count against candidate capacity before shrinking.
            _, _, size = retained.pop()
            total -= size
            retention_reason = "overflow" if emergency else "candidate_capacity"

    def _threshold(self):
        reserve = min(16_384, self.window // 10)
        return min(int(self.window * .8), self.window - 2 * reserve - self.window // 20)

    async def awrap_model_call(self, request, handler):
        events = request.state.get("compaction_events", [])
        previous = events[-1] if events else None
        message_groups(request.state["messages"])
        view = request.override(messages=context_messages(request.state, projected=request.messages))
        if self.window is None:
            return await handler(view)
        candidate = None
        memory_update = None
        generation = previous["generation"] if previous else 0
        used, _, _ = self._usage(view, generation)
        attempting = used >= self._threshold()
        try:
            if attempting:
                candidate, view, memory_update = await self._compact(request, view, previous, "threshold")
            try:
                response = await handler(view)
            except ContextWindowExceededError:
                # One recovery only. It may advance a provisional threshold candidate,
                # but neither candidate commits unless this next main response succeeds.
                attempting = True
                if candidate is not None and self.archive is not None:
                    # The first candidate is not checkpointed. Its index may be an
                    # orphan; never teach the replacement summary to cite it.
                    annotation = self.archive.summary_text(
                        "", candidate["archive_index_path"], candidate["archive_path"])
                    provisional_text = candidate["summary_text"].removesuffix(annotation)
                    view = view.override(messages=[
                        view.messages[0].model_copy(update={"content": _SUMMARY_HEADER + provisional_text}),
                        *view.messages[1:],
                    ])
                candidate, view, memory_update = await self._compact(
                    request, view, previous, "overflow", emergency=True,
                    min_cutoff=candidate["cutoff_index"] if candidate else 0,
                )
                response = await handler(view)
        except (Exception, asyncio.CancelledError, GraphInterrupt) as error:
            if attempting:
                payload = {"status": "failed", "error": type(error).__name__, "message": str(error)}
                if self.on_compaction:
                    self.on_compaction(request.runtime.context["task_id"], payload)
                else:
                    logger.warning("上下文压缩失败：%s", type(error).__name__)
            raise
        generation = candidate["generation"] if candidate else generation
        _, hashes, signature = self._usage(view, generation)
        message = next((m for m in reversed(response.result) if isinstance(m, AIMessage)), None)
        update = {}
        if message is not None and message.usage_metadata:
            usage = message.usage_metadata
            replay = view.override(messages=[*view.messages, message])
            update["compaction_usage"] = {
                "signature": signature, "message_hashes": [*hashes, _message_hash(message)],
                "estimate": _estimate(view),
                "input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"],
                "response_estimate": max(0, _estimate(replay) - _estimate(view)),
            }
        if candidate:
            update["compaction_events"] = [*events, candidate]
            update["memory_version"] = None
            if memory_update is not None:
                # Append the observed snapshot BEFORE the response, not as a Command
                # after it: a HumanMessage must never split an AI/tool-result batch.
                response.result = [*memory_update.get("messages", []), *response.result]
        return ExtendedModelResponse(model_response=response, command=Command(update=update))
