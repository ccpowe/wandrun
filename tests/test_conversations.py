"""离线跨进程测试：不连接 MCP、不调用付费模型。"""

import asyncio
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from langchain.agents import create_agent
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.runtime.conversations import conversation_config, prepare_conversation_input
from wandrun.runtime.workers import WorkerManager


async def worker(database, phase):
    async with AsyncSqliteSaver.from_conn_string(database) as saver:
        def build(**kwargs):
            return create_agent(
                model=FakeMessagesListChatModel(responses=[AIMessage(content="answer")]),
                checkpointer=saver, **kwargs,
            )

        main, child = build(), build()
        main_config = conversation_config("conversation-a")
        child_config = conversation_config("conversation-b")

        async def run_child(prompts, task_id):
            config = conversation_config(task_id)
            inputs = await prepare_conversation_input(child, config, prompts)
            result = await child.ainvoke(
                inputs, config,
                durability="sync",
            )
            return result["messages"][-1].text

        manager = WorkerManager(run_child)
        try:
            # 每个进程都是全新的 manager，不根据空 _tasks 拒绝旧 ID。
            assert manager.get("conversation-b")["status"] == "not_found"
            inputs = await prepare_conversation_input(
                main, main_config, [HumanMessage(content=f"main-{phase}", id=f"main-{phase}")],
            )
            await main.ainvoke(
                inputs, main_config,
                durability="sync",
            )
            manager.start(f"child-{phase}", "conversation-b")
            await manager._tasks["conversation-b"]  # 测试直接等待执行完成，不用 sleep 猜时间。
            assert manager.get("conversation-b")["status"] == "completed"
            phases = ["first"] if phase == "first" else ["first", "second"]
            for agent, config, prefix in (
                (main, main_config, "main"), (child, child_config, "child"),
            ):
                snapshot = await agent.aget_state(config)
                assert not snapshot.next
                actual = [m.content for m in snapshot.values["messages"] if isinstance(m, HumanMessage)]
                assert actual == [f"{prefix}-{p}" for p in phases], actual

            # 换一个 Agent 对象，相同 ID 仍访问同一份对话，而非按 Agent 类型分区。
            assert (await child.aget_state(main_config)).values == (await main.aget_state(main_config)).values
            broken_config = conversation_config("unfinished")
            if phase == "first":
                paused = build(interrupt_before=["model"])
                await paused.ainvoke(
                    {"messages": [HumanMessage(content="unfinished input")]},
                    broken_config, durability="sync",
                )
            before = await child.aget_state(broken_config)
            assert before.next
            if phase == "second":
                inputs = await prepare_conversation_input(
                    child, broken_config, [HumanMessage(content="现在重新开始", id="restart")],
                )
                result = await child.ainvoke(inputs, broken_config, durability="sync")
                assert [m.content for m in result["messages"] if isinstance(m, HumanMessage)] == [
                    "unfinished input", "现在重新开始",
                ]
                assert not (await child.aget_state(broken_config)).next

            tool_config = conversation_config("unfinished-tool")
            if phase == "first":
                class ToolCallingModel(FakeMessagesListChatModel):
                    def bind_tools(self, tools, **kwargs):
                        return self

                @tool
                def demo() -> str:
                    """This tool must not be executed by this test."""
                    raise AssertionError("不能恢复旧工具执行")

                paused = create_agent(
                    model=ToolCallingModel(responses=[AIMessage(content="", tool_calls=[
                        {"name": "demo", "args": {}, "id": "demo-call", "type": "tool_call"},
                    ])]), tools=[demo], checkpointer=saver, interrupt_before=["tools"],
                )
                await paused.ainvoke({"messages": [HumanMessage(content="旧工具请求")]}, tool_config, durability="sync")
            else:
                inputs = await prepare_conversation_input(
                    child, tool_config, [HumanMessage(content="停止旧操作", id="tool-correction")],
                )
                result = await child.ainvoke(inputs, tool_config, durability="sync")
                history = result["messages"]
                assert texts(history) == ["旧工具请求", "停止旧操作"]
                tool_results = [m for m in history if isinstance(m, ToolMessage)]
                assert len(tool_results) == 1 and tool_results[0].tool_call_id == "demo-call"
                assert tool_results[0].status == "error"
            print(f"PASS {phase}: 唯一 ID 隔离、旧 ID 续聊、未完成历史保留", flush=True)
        finally:
            await manager.close()


def texts(messages):
    return [m.content for m in messages if isinstance(m, HumanMessage)]


class ConversationTests(unittest.TestCase):
    def test_config_preserves_identity(self):
        self.assertEqual(conversation_config("unique-id"), {"configurable": {"thread_id": "unique-id"}})
        with self.assertRaises(ValueError):
            conversation_config(" ")

    def test_history_survives_new_process(self):
        with tempfile.TemporaryDirectory(prefix="wandrun-conversations-") as directory:
            database = str(Path(directory) / "checkpoints.sqlite")
            for phase in ("first", "second"):
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve()), "--worker", database, phase],
                    capture_output=True, text=True, timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f"PASS {phase}", result.stdout)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        asyncio.run(worker(sys.argv[2], sys.argv[3]))
    else:
        unittest.main()
