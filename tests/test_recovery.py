"""使用真实 Agent 图、可控假模型和临时 SQLite，验证取消/失败后主动续聊。"""

import asyncio
import os
from collections import Counter
from pathlib import Path
import tempfile
import unittest

from langchain.agents import create_agent
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.runtime.conversations import conversation_config, missing_tool_results, prepare_conversation_input
from wandrun.runtime.agents import ConversationState
from wandrun.runtime.workers import CommunicationMiddleware, WorkerManager


def texts(messages):
    return [m.content for m in messages if isinstance(m, HumanMessage)]


async def run_graph(agent, prompts, task_id):
    config = conversation_config(task_id)
    inputs = await prepare_conversation_input(agent, config, prompts)
    async for _ in agent.astream(
        inputs, config=config, context={"task_id": task_id},
        stream_mode="updates", version="v2", durability="sync",
    ):
        pass
    snapshot = await agent.aget_state(config)
    return snapshot.values["messages"][-1].text


class ObservedSaver(AsyncSqliteSaver):
    async def aput_writes(self, config, writes, task_id, task_path=""):
        await super().aput_writes(config, writes, task_id, task_path)
        for channel, value in writes:
            values = value if isinstance(value, (list, tuple)) else [value]
            if channel == "messages" and any(
                isinstance(m, ToolMessage) and m.tool_call_id == "fast-call" for m in values
            ):
                self.fast_saved.set()


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_before_task_starts_keeps_original_messages(self):
        seen = []

        async def run(prompts, task_id):
            seen.extend(prompts)
            return "ok"

        manager = WorkerManager(run)
        self.addAsyncCleanup(manager.close)
        manager.start("先改成 A", "one")
        original_id = manager._inflight["one"][0].id
        manager.start("另一个补充", "one")
        await manager.cancel("one")
        self.assertEqual(seen, [])
        manager.start("刚才说错了，改成 B", "one")
        self.assertEqual((await manager.wait("one"))["status"], "completed")
        self.assertEqual(texts(seen), ["先改成 A", "另一个补充", "刚才说错了，改成 B"])
        self.assertEqual(seen[0].id, original_id)
        self.assertEqual(len({m.id for m in seen}), 3)
        self.assertFalse(manager._inflight)

    async def test_interruption_between_prepare_and_invoke_keeps_batch(self):
        for action in ("cancel", "failure"):
            with self.subTest(action=action):
                entered, release = asyncio.Event(), asyncio.Event()
                batches = []

                async def run(prompts, task_id):
                    batches.append(prompts)
                    inputs = await prepare_conversation_input(agent, conversation_config(task_id), prompts)
                    if len(batches) == 1:
                        entered.set()
                        await release.wait()
                        raise ValueError("failure before graph starts")
                    result = await agent.ainvoke(inputs, conversation_config(task_id), durability="sync")
                    return result["messages"][-1].text

                manager = WorkerManager(run)
                self.addAsyncCleanup(manager.close)
                agent = create_agent(
                    model=FakeMessagesListChatModel(responses=[AIMessage(content="ok")]),
                    checkpointer=InMemorySaver(),
                )
                manager.start("旧指令", "one")
                await asyncio.wait_for(entered.wait(), 2)
                manager.start("旧补充", "one")
                if action == "cancel":
                    await manager.cancel("one")
                else:
                    release.set()
                    await manager.wait("one")
                snapshot = await agent.aget_state(conversation_config("one"))
                self.assertEqual(snapshot.values, {})
                manager.start("新修正", "one")
                await asyncio.wait_for(manager.wait("one"), 2)
                self.assertEqual(texts(batches[-1]), ["旧指令", "旧补充", "新修正"])
                self.assertEqual(batches[0][0].id, batches[1][0].id)
                snapshot = await agent.aget_state(conversation_config("one"))
                self.assertEqual(texts(snapshot.values["messages"]), ["旧指令", "旧补充", "新修正"])

    async def test_mailbox_messages_survive_before_and_after_checkpoint(self):
        for stage in ("before_save", "after_save", "after_answer"):
            for action in ("cancel", "failure"):
                with self.subTest(stage=stage, action=action):
                    entered, release = asyncio.Event(), asyncio.Event()
                    seen, batches = [], []
                    first = True

                    async def pause():
                        entered.set()
                        await release.wait()
                        raise ValueError("controlled failure")

                    class Mailbox(CommunicationMiddleware):
                        async def abefore_model(self, state, runtime):
                            update = await super().abefore_model(state, runtime)
                            if first and stage == "before_save":
                                await pause()
                            return update

                    class Model(FakeMessagesListChatModel):
                        def bind_tools(self, tools, **kwargs):
                            return self

                        async def _agenerate(self, messages, **kwargs):
                            seen.append(messages)
                            if first and stage == "after_save":
                                await pause()
                            return await super()._agenerate(messages, **kwargs)

                    async def run(prompts, task_id):
                        batches.append(prompts)
                        result = await run_graph(agent, prompts, task_id)
                        if first and stage == "after_answer":
                            await pause()  # 图已成功落盘，Manager 尚未确认 _inflight。
                        return result

                    manager = WorkerManager(run)
                    self.addAsyncCleanup(manager.close)
                    agent = create_agent(
                        model=Model(responses=[AIMessage(content="ok")]),
                        middleware=[Mailbox(manager)], checkpointer=InMemorySaver(),
                    )
                    manager.start("最初问题", "one")
                    # 同样文本也要当作两次真实输入，不能按内容去重。
                    manager.start("改成 A", "one")
                    manager.start("改成 A", "one")
                    await asyncio.wait_for(entered.wait(), 2)
                    original_ids = [m.id for m in manager._inflight["one"]]
                    self.assertEqual(len(original_ids), 3)
                    manager.start("仍在队列的补充", "one")
                    if action == "cancel":
                        await manager.cancel("one")
                    else:
                        release.set()
                        await manager.wait("one")
                    self.assertEqual(len(batches), 1)  # 不因失败/取消自动运行。
                    snapshot = await agent.aget_state(conversation_config("one"))
                    self.assertEqual(texts(snapshot.values["messages"]),
                                     ["最初问题"] if stage == "before_save" else ["最初问题", "改成 A", "改成 A"])
                    first = False
                    manager.start("改错了，请改成 B", "one")
                    status = await asyncio.wait_for(manager.wait("one"), 2)
                    self.assertEqual(status["status"], "completed", status)
                    snapshot = await agent.aget_state(conversation_config("one"))
                    history = snapshot.values["messages"]
                    expected = ["最初问题", "改成 A", "改成 A", "仍在队列的补充", "改错了，请改成 B"]
                    self.assertEqual(texts(history), expected)
                    self.assertEqual(texts(seen[-1]), expected)
                    ids = [m.id for m in history if isinstance(m, HumanMessage)]
                    self.assertEqual(ids[:3], original_ids)
                    self.assertEqual(len(ids), len(set(ids)))
                    self.assertFalse(manager._inflight)
                    self.assertEqual(manager.take_messages("one"), [])

    async def test_parallel_tools_keep_saved_results_and_do_not_rerun(self):
        for action in ("cancel", "failure"):
            with self.subTest(action=action), tempfile.TemporaryDirectory(prefix="wandrun-repair-") as directory:
                async with ObservedSaver.from_conn_string(str(Path(directory) / "graph.sqlite")) as saver:
                    saver.fast_saved = asyncio.Event()
                    entered, release = asyncio.Event(), asyncio.Event()
                    counts = Counter()
                    seen = []

                    @tool
                    async def fast() -> str:
                        """A fast, side-effect-free test tool."""
                        counts["fast"] += 1
                        return "真实结果 42"

                    @tool
                    async def slow() -> str:
                        """A controlled slow test tool."""
                        counts["slow"] += 1
                        entered.set()
                        await release.wait()
                        raise RuntimeError("controlled tool failure")

                    class Model(FakeMessagesListChatModel):
                        def bind_tools(self, tools, **kwargs):
                            return self

                        async def _agenerate(self, messages, **kwargs):
                            self_test.assertEqual(missing_tool_results(messages), [])
                            seen.append(messages)
                            return await super()._agenerate(messages, **kwargs)

                    self_test = self

                    async def run(prompts, task_id):
                        return await run_graph(agent, prompts, task_id)

                    manager = WorkerManager(run)
                    try:
                        agent = create_agent(
                            model=Model(responses=[
                                AIMessage(content="", tool_calls=[
                                    {"name": name, "args": {}, "id": f"{name}-call", "type": "tool_call"}
                                    for name in ("fast", "slow")
                                ]),
                                AIMessage(content="已按新要求停止查询"),
                            ]), tools=[fast, slow], middleware=[CommunicationMiddleware(manager)], checkpointer=saver,
                        )
                        manager.start("查询示例数据", "one")
                        await asyncio.wait_for(entered.wait(), 2)
                        await asyncio.wait_for(saver.fast_saved.wait(), 2)
                        manager.start("请继续查 A", "one")
                        if action == "cancel":
                            await manager.cancel("one")
                        else:
                            release.set()
                            await manager.wait("one")
                        self.assertEqual(manager.get("one")["status"], "cancelled" if action == "cancel" else "failed")
                        # 已完成 fast 只存在 pending writes，不能在换轮时丢掉。
                        saved = await saver.aget_tuple(conversation_config("one"))
                        self.assertFalse(any(isinstance(m, ToolMessage) for m in saved.checkpoint["channel_values"]["messages"]))
                        self.assertTrue(any(channel == "messages" for _, channel, _ in saved.pending_writes))
                        manager.start("纠正：停止查询 A，不要调用工具", "one")
                        status = await asyncio.wait_for(manager.wait("one"), 2)
                        self.assertEqual(status["status"], "completed", status)
                        self.assertEqual(counts, {"fast": 1, "slow": 1})
                        snapshot = await agent.aget_state(conversation_config("one"))
                        history = snapshot.values["messages"]
                        self.assertFalse(snapshot.next)
                        results = [m for m in history if isinstance(m, ToolMessage)]
                        self.assertEqual(Counter(m.tool_call_id for m in results), {"fast-call": 1, "slow-call": 1})
                        self.assertEqual(results[0].content, "真实结果 42")
                        self.assertEqual(results[1].status, "error")
                        self.assertIn("外部操作可能已经发生", results[1].content)
                        self.assertEqual(texts(history), ["查询示例数据", "请继续查 A", "纠正：停止查询 A，不要调用工具"])
                        self.assertEqual(missing_tool_results(seen[-1]), [])
                    finally:
                        await manager.close()
    def test_media_companions_follow_only_their_parallel_batch(self):
        calls = [
            {"name": name, "args": {}, "id": call_id, "type": "tool_call"}
            for name, call_id in (("read_file", "video-first"), ("read_file", "video-middle"),
                                  ("read_file", "plain"), ("read_file", "video-last"))
        ]
        batch = AIMessage(content="", id="batch", tool_calls=calls)
        history = [
            batch,
            ToolMessage(content="first", tool_call_id="video-first"),
            HumanMessage(
                content=[{"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="}],
                id="media-first",
                additional_kwargs={
                    "read_file_media_result": True,
                    "read_file_tool_call_id": "video-first",
                },
            ),
            ToolMessage(content="middle", tool_call_id="video-middle", status="error"),
            ToolMessage(content="plain", tool_call_id="plain"),
            HumanMessage(
                content=[{"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="}],
                id="media-middle",
                additional_kwargs={
                    "read_file_media_result": True,
                    "read_file_tool_call_id": "video-middle",
                },
            ),
            ToolMessage(content="last", tool_call_id="video-last"),
            HumanMessage(
                content=[{"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="}],
                id="media-last",
                additional_kwargs={
                    "read_file_media_result": True,
                    "read_file_tool_call_id": "video-last",
                },
            ),
        ]
        original = [message.id for message in history]
        self.assertEqual(missing_tool_results(history), [])
        self.assertEqual([message.id for message in history], original)

    def test_media_result_saved_before_another_tool_is_interrupted(self):
        batch = AIMessage(content="", id="batch", tool_calls=[
            {"name": "read_file", "args": {}, "id": "video", "type": "tool_call"},
            {"name": "slow", "args": {}, "id": "slow", "type": "tool_call"},
        ])
        history = [
            batch,
            ToolMessage(content="video result", tool_call_id="video"),
            HumanMessage(
                content=[{"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="}],
                additional_kwargs={
                    "read_file_media_result": True,
                    "read_file_tool_call_id": "video",
                },
            ),
        ]
        additions = missing_tool_results(history)
        self.assertEqual([(message.tool_call_id, message.status) for message in additions], [("slow", "error")])
        self.assertEqual(additions[0].id, "interrupted:batch:slow")

    def test_unrelated_media_and_tool_messages_are_not_swallowed(self):
        with self.assertRaisesRegex(ValueError, "历史中间"):
            missing_tool_results([
                AIMessage(content="", tool_calls=[
                    {"name": "demo", "args": {}, "id": "call", "type": "tool_call"},
                ]),
                HumanMessage(content="旧历史已经乱序"),
            ])
        orphan_media = HumanMessage(
            content=[{"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="}],
            additional_kwargs={
                "read_file_media_result": True,
                "read_file_tool_call_id": "unknown",
            },
        )
        with self.assertRaisesRegex(ValueError, "媒体"):
            missing_tool_results([orphan_media])
        with self.assertRaisesRegex(ValueError, "工具结果"):
            missing_tool_results([ToolMessage(content="orphan", tool_call_id="unknown")])

    async def test_delta_checkpoint_media_history_prepares_and_resumes(self):
        seed = [
            HumanMessage(content="inspect media", id="prompt"),
            AIMessage(content="", id="batch", tool_calls=[
                {"name": "read_file", "args": {}, "id": "video", "type": "tool_call"},
                {"name": "read_file", "args": {}, "id": "other", "type": "tool_call"},
            ]),
            ToolMessage(content="video result", tool_call_id="video", id="video-result"),
            HumanMessage(
                content=[{"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="}],
                id="video-media",
                additional_kwargs={
                    "read_file_media_result": True,
                    "read_file_tool_call_id": "video",
                },
            ),
            ToolMessage(content="other result", tool_call_id="other", id="other-result"),
        ]
        with tempfile.TemporaryDirectory(
            dir=os.environ["TMPDIR"], prefix="wandrun-media-delta-"
        ) as directory:
            async with AsyncSqliteSaver.from_conn_string(str(Path(directory) / "graph.sqlite")) as saver:
                agent = create_agent(
                    model=FakeMessagesListChatModel(responses=[AIMessage(content="resumed")]),
                    state_schema=ConversationState,
                    checkpointer=saver,
                )
                config = conversation_config("media-delta")
                await agent.aupdate_state(config, {"messages": seed}, as_node="model")
                before = await agent.aget_state(config)
                before_dump = [message.model_dump() for message in before.values["messages"]]
                inputs = await prepare_conversation_input(
                    agent, config, [HumanMessage(content="continue", id="continue")]
                )
                self.assertEqual(
                    [message.id for message in inputs["messages"]], ["continue"]
                )
                after_prepare = await agent.aget_state(config)
                self.assertEqual(
                    [message.model_dump() for message in after_prepare.values["messages"]],
                    before_dump,
                )
                result = await agent.ainvoke(inputs, config, durability="sync")
                self.assertEqual(result["messages"][-1].content, "resumed")


    async def test_only_tail_is_repaired_without_rewriting_history(self):
        call = AIMessage(content="", id="ai-1", tool_calls=[
            {"name": "demo", "args": {}, "id": "call-1", "type": "tool_call"},
        ])
        additions = missing_tool_results([call])
        self.assertEqual(len(additions), 1)
        self.assertEqual(additions[0].tool_call_id, "call-1")
        self.assertEqual(missing_tool_results([call, *additions]), [])
        self.assertEqual(additions[0].id, missing_tool_results([call])[0].id)
        with self.assertRaisesRegex(ValueError, "历史中间"):
            missing_tool_results([call, HumanMessage(content="旧历史已经乱序")])
        with self.assertRaisesRegex(ValueError, "重复"):
            missing_tool_results([call, *additions, *additions])


if __name__ == "__main__":
    unittest.main()
