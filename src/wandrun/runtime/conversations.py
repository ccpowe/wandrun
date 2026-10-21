"""对话身份与历史尾部修复；状态存储路径由运行入口决定。"""

from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END

from wandrun.runtime.messages import (
    read_file_media_tool_call_id,
    unaccepted_send_notice,
)


def conversation_config(thread_id: str) -> dict:
    if not thread_id.strip():
        raise ValueError("需要非空的对话 ID")
    # 对话身份与执行它的 Agent 无关，调用方负责为不同对话分配唯一 ID。
    return {"configurable": {"thread_id": thread_id}}


def missing_tool_results(messages) -> list[ToolMessage]:
    """只补尾部未完成的调用，不删除调用、不伪造成功、不重写已完成历史。

    A marked ``read_file`` media message belongs to the active AI tool batch.
    It can occur between results or after the last result without consuming a
    pending call; unrelated human messages remain batch boundaries.
    """
    pending = {}
    batch_calls = {}
    completed = set()
    media_calls = set()
    for message in messages:
        media_call = read_file_media_tool_call_id(message)
        if media_call is not None:
            if media_call not in batch_calls:
                raise ValueError("历史中存在与工具批次无关的媒体伴随消息，需单独检查。")
            media_calls.add(media_call)
            continue
        if isinstance(message, ToolMessage):
            if message.tool_call_id not in pending:
                raise ValueError("历史中存在没有对应调用或重复的工具结果，需单独检查。")
            del pending[message.tool_call_id]
            completed.add(message.tool_call_id)
        else:
            if pending:
                raise ValueError("历史中间已有未配对的工具调用，不能仅追加修复，请单独检查。")
            if media_calls - completed:
                raise ValueError("历史中存在没有对应工具结果的媒体伴随消息，需单独检查。")
            batch_calls = {}
            completed = set()
            media_calls = set()
            if isinstance(message, AIMessage):
                for call in message.tool_calls:
                    if call["id"] in batch_calls:
                        raise ValueError("同一条消息中存在重复的 tool_call_id。")
                    batch_calls[call["id"]] = (message.id, call["name"])
                    pending[call["id"]] = (message.id, call["name"])
    if media_calls - completed:
        raise ValueError("历史中存在没有对应工具结果的媒体伴随消息，需单独检查。")
    return [
        ToolMessage(
            id=f"interrupted:{message_id}:{call_id}",
            tool_call_id=call_id, name=name, status="error",
            content="上次执行已中断或失败，未取得此工具的结果。外部操作可能已经发生，"
                    "不能据此认定操作未执行；请结合最新消息，先检查实际状态再决定是否重试。",
        )
        for call_id, (message_id, name) in pending.items()
    ]




async def prepare_conversation_input(agent, config: dict, prompts: list[HumanMessage]) -> dict:
    """旧执行已停止后使用：整理尾部工具结果，追加尚未落盘的消息。"""
    snapshot = await agent.aget_state(config)
    # 先校验；对超出尾部修复范围的旧历史，不做写入。
    missing_tool_results(snapshot.values.get("messages", []))
    if snapshot.next or snapshot.tasks:
        # 这里只更新检查点：合入已完成节点的 pending writes，停止旧调度。
        # 不执行任何模型/工具；这不是 invoke(None) 恢复旧节点。
        await agent.aupdate_state(config, None, as_node=END)
        snapshot = await agent.aget_state(config) # 后续调查看看 具体的构成张什么样子
    history = snapshot.values.get("messages", [])
    saved_ids = {message.id for message in history if message.id is not None}
    inputs = [message for message in prompts if message.id not in saved_ids]
    # 最近一次发送响应若没有被运行时接收，在本次输入之前说明（ADR-0009）。
    notice = unaccepted_send_notice(history, inputs)
    return {"messages": [
        *missing_tool_results(history),
        *([notice] if notice is not None else []),
        *inputs,
    ]}
