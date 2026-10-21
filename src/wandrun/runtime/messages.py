"""模型只描述消息与下一步；身份、投递和调度由运行时负责。"""

import json
from collections.abc import Sequence
from typing import Annotated, Literal
from uuid import uuid4

from langchain.messages import AIMessage, HumanMessage
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

READ_FILE_MEDIA_RESULT = "read_file_media_result"
READ_FILE_TOOL_CALL_ID = "read_file_tool_call_id"


def read_file_media_tool_call_id(message) -> str | None:
    """Return the tool call ID for a Deep Agents ``read_file`` media companion.

    Only the runtime marker and a non-empty call ID identify this synthetic
    ``HumanMessage``; message content is not trusted for this classification.
    A marked message without a valid call ID is malformed and raises.
    """
    if not isinstance(message, HumanMessage):
        return None
    if message.additional_kwargs.get(READ_FILE_MEDIA_RESULT) is not True:
        return None
    call_id = message.additional_kwargs.get(READ_FILE_TOOL_CALL_ID)
    if not isinstance(call_id, str) or not call_id:
        raise ValueError("read_file 媒体伴随消息缺少有效的工具调用 ID")
    return call_id

# 回执记录它所属的模型响应 ID，关联关系由通信层自己拥有（ADR-0009）。
RECEIPT_FOR = "receipt_for"


class SendMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    to: str = Field(
        description="目标 Agent 的 id（见协作目录）；human 表示用户",
        min_length=1,
    )
    task_id: str | None = Field(
        description="发给 Agent：null 创建新任务，已有 task_id 继续或回信；发给 human：必须为 null",
        min_length=1,
    )
    message: str = Field(
        description="正文，说明必要背景；同事看不到发送方的历史", min_length=1
    )
    attachments: list[Annotated[str, StringConstraints(strip_whitespace=False)]] = Field(
        default_factory=list,
        description="随本条消息交付的文件路径；没有时为 []。相对路径以发送任务工作目录为基准。",
    )

    @classmethod
    def __get_pydantic_json_schema__(cls, core_schema, handler):
        # Python callers may omit the field for legacy in-memory message construction,
        # but a strict provider response must always carry an explicit [].
        schema = handler(core_schema)
        schema.setdefault("required", []).append("attachments")
        return schema



class AgentOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[SendMessage] = Field(
        description="批量异步发送的消息；没有消息时为 []"
    )
    next: Literal["continue", "wait", "done"] = Field(
        description="continue 继续独立工作；wait 等待来信；done 本轮完成"
    )


def merge_response_outputs(
    items: list[dict], *, message_sources: list[tuple[int, int]] | None = None,
) -> AgentOutput | None:
    """收齐并合并通信；可同时记录每条消息的 (output item, message index) 来源。"""
    messages = []
    last = final = None
    for item_index, item in enumerate(items):
        if item.get("type") != "message":
            continue
        if item.get("role") != "assistant":
            raise ValueError("响应通信项必须来自 assistant")
        if item.get("phase") not in {None, "commentary", "final_answer"}:
            raise ValueError("未知的响应通信阶段")
        texts = []
        for part in item.get("content", []):
            if part["type"] == "refusal":
                raise ValueError("模型拒绝了请求：" + part.get("refusal", ""))
            if part["type"] != "output_text":
                raise ValueError("响应通信正文必须为 output_text")
            texts.append(part["text"])
        text = "".join(texts)
        try:
            output = AgentOutput.model_validate_json(text)
        except ValidationError as exc:
            if (
                item.get("phase") != "commentary"
                or any(error["type"] != "json_invalid" for error in exc.errors())
                or text.lstrip().startswith(("{", "[", "```"))
            ):
                raise
            continue  # 普通进度文字不是通信；疑似结构化正文仍保留原错误。
        last = output
        if message_sources is not None:
            message_sources.extend((item_index, index) for index in range(len(last.messages)))
        messages.extend(last.messages)
        if item.get("phase") == "final_answer":
            final = last
    if last is None:
        return None  # 没有结构化通信；由适配器检查是否还有工具可执行。
    return AgentOutput(messages=messages, next=(final or last).next)


def runtime_message(
    data: dict, *, message_id: str | None = None, receipt_for: str | None = None
) -> HumanMessage:
    """运行时生成的反馈（回执、任务通知、未接收提示），与模型或同事的来信区分来源。"""
    kwargs = {"source": "runtime"}
    if receipt_for is not None:
        kwargs[RECEIPT_FOR] = receipt_for
    return HumanMessage(
        content="[运行时反馈]\n" + json.dumps(data, ensure_ascii=False),
        id=message_id or uuid4().hex,
        additional_kwargs=kwargs,
    )


def unaccepted_send_notice(
    history: Sequence, inputs: Sequence[HumanMessage]
) -> HumanMessage | None:
    """续聊时说明最近一次发送响应中没有被运行时接收的消息（ADR-0009）。

    history 是合并 pending writes 后的历史；inputs 是本次实际追加的输入（已按已保存 ID 去重）。
    回执覆盖整批消息并与投递同一事务提交（ADR-0008 不变量 6），所以找不到最近一次发送响应的回执，
    就说明其中发给 Worker 的消息都没有被接收。较早的响应不必检查：它们要么已有回执，
    要么在模型再次被调用前已经写入了本提示。提示 ID 固定，已存在时不再生成。
    """
    for index in range(len(history) - 1, -1, -1):
        candidate = history[index]
        output = (
            candidate.additional_kwargs.get("wandrun_agent_output")
            if isinstance(candidate, AIMessage)
            else None
        )
        if output and output.get("messages"):
            break
    else:
        return None
    notice_id = f"undelivered:{candidate.id}"
    if any(message.id == notice_id for message in [*history, *inputs]):
        return None  # 提示不是回执，写入后判定条件不会自动消失，需单独跳过。
    if any(
        message.additional_kwargs.get(RECEIPT_FOR) == candidate.id
        for message in [*history[index + 1:], *inputs]
    ):
        return None
    sent = output["messages"]
    notes = []
    if any(item["to"] != "human" for item in sent):
        notes.append("发给协作任务的消息没有被运行时接收：没有投递，task_id=null 的委派没有创建任务。")
    if any(item["to"] == "human" for item in sent):
        notes.append("发给 human 的消息运行时没有接收记录，但可能已经显示给用户。")
    notes.append(
        "上一次响应中的这些内容只是当时的发送意图。以已知的回执和任务状态为准，"
        "不要仅凭这次发送意图继续等待；是否重新发送，由当前输入决定。"
    )
    return runtime_message(
        {
            "unaccepted_messages": [
                {"to": item["to"], "task_id": item["task_id"],
                 "message": item["message"][:200], "attachments": item.get("attachments", [])}
                for item in sent
            ],
            "note": "".join(notes),
        },
        message_id=notice_id,
    )

