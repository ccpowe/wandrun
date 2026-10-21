"""Consumer invariants for checkpointed compaction, without network requests."""

import base64
import json
import os
import asyncio
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from deepagents.backends import FilesystemBackend
from langchain.agents import create_agent
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.prebuilt.tool_node import ToolCallRequest

from wandrun.integrations.codex_subscription import CodexSubscriptionModel, ContextWindowExceededError
from wandrun.runtime.compaction import (
    CompactionMiddleware, ContextBudgetExhausted, context_messages, message_groups,
)
from wandrun.runtime.compaction_archive import CompactionArchive
from wandrun.runtime.conversations import conversation_config, prepare_conversation_input
from wandrun.runtime.agents import ConversationState
from wandrun.runtime.memory import MemoryStore
from wandrun.runtime.memory_runtime import MEMORY_PATH, ManagedMemoryBackend, MemoryMiddleware
from wandrun.runtime.tool_search import ToolNamespace, ToolSearchMiddleware, loaded_tool_names
from langchain.tools import tool


def reply(text="done", *, usage=True):
    return AIMessage(content=text, additional_kwargs={"codex_output_items": [{
        "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}],
    }]}, usage_metadata={"input_tokens": 100, "output_tokens": 10, "total_tokens": 110} if usage else None)


def media_read_call():
    args = {"file_path": "/report.pdf"}
    return AIMessage(content="", id="call", tool_calls=[
        {"name": "read_file", "id": "read", "args": args},
    ], additional_kwargs={"codex_output_items": [{
        "type": "function_call", "name": "read_file", "call_id": "read",
        "arguments": json.dumps(args),
    }]})


def history():
    return [HumanMessage(content="early constraint: never overwrite\n" + "diagnostic " * 2500, id="old"),
            reply(), HumanMessage(content="latest instruction", id="latest")]


def request(messages=None, **state):
    raw = history() if messages is None else messages
    for i, message in enumerate(raw):
        if message.id is None:
            message.id = f"message-{i}"
    return ModelRequest(model=CodexSubscriptionModel(), messages=raw,
                        state={"messages": raw, **state}, runtime=SimpleNamespace(context={"task_id": "test"}),
                        model_settings={"prompt_cache_key": "test"})


def archived_messages(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
    parts = {}
    for row in rows[1:]:
        parts.setdefault(row["message_index"], []).append(row["json"])
    return [rows[0], *(json.loads("".join(chunks)) for chunks in parts.values())]


class CompactionTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_compactions_keep_raw_and_old_summary_in_next_summary(self):
        middleware = CompactionMiddleware(context_window=10_000, keep_tokens=100)
        req = request()
        saved = [m.model_dump() for m in req.messages]
        seen = []
        async def summary(r, **kwargs):
            seen.append(r)
            return reply("1. 目标\n2. 用户约束与偏好原话：never overwrite\n3. 已确认事实\n4. 决策与否决及理由\n5. 产物与路径\n6. 进行中 / 下一步\n7. 关键标识")
        async def main(r):
            self.assertIn("never overwrite", r.messages[0].content)
            self.assertEqual(r.messages[-1].content, "latest instruction")
            return ModelResponse(result=[reply()])
        with patch("wandrun.runtime.compaction.summarize_request", summary):
            result = await middleware.awrap_model_call(req, main)
            update = result.command.update
            self.assertEqual([m.model_dump() for m in req.messages], saved)
            self.assertEqual(len(update["compaction_events"]), 1)
            self.assertIsNone(update["compaction_events"][0]["archive_path"])
            raw = [*req.messages, HumanMessage(content="more diagnostic " * 2500, id="more"),
                   HumanMessage(content="latest instruction", id="newest")]
            again = await middleware.awrap_model_call(request(raw, **update), main)
        self.assertEqual(len(again.command.update["compaction_events"]), 2)
        self.assertIn("never overwrite", seen[1].messages[0].content)
        self.assertGreater(again.command.update["compaction_events"][-1]["cutoff_index"], update["compaction_events"][-1]["cutoff_index"])

    async def test_archive_is_incremental_readable_and_separated_per_thread(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            backend = FilesystemBackend(root_dir=root, virtual_mode=False)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"), backend)
            middleware = CompactionMiddleware(context_window=10_000, keep_tokens=100, archive=archive)
            summaries = []

            async def summary(view, **kwargs):
                summaries.append(view)
                return reply(f"summary #{len(summaries)}")

            async def main(view):
                self.assertIn("原文留档索引", view.messages[0].content)
                return ModelResponse(result=[reply()])

            first = request()
            with patch("wandrun.runtime.compaction.summarize_request", summary):
                result = await middleware.awrap_model_call(first, main)
                event1 = result.command.update["compaction_events"][-1]
                self.assertIn("early constraint", str((await backend.aread(event1["archive_path"])).file_data))
                more = [*first.messages, HumanMessage(content="second detail " * 2500, id="second"),
                        HumanMessage(content="new instruction", id="newest")]
                req2 = request(more, **result.command.update)
                second = await middleware.awrap_model_call(req2, main)
            event2 = second.command.update["compaction_events"][-1]
            segment1 = archived_messages(event1["archive_path"])
            segment2 = archived_messages(event2["archive_path"])
            self.assertEqual((segment1[0]["start_index"], segment1[0]["end_index"]),
                             (0, event1["cutoff_index"]))
            self.assertEqual((segment2[0]["start_index"], segment2[0]["end_index"]),
                             (event1["cutoff_index"], event2["cutoff_index"]))
            self.assertNotIn("early constraint", Path(event2["archive_path"]).read_text())
            self.assertIn(event1["archive_path"], Path(event2["archive_index_path"]).read_text())
            self.assertIn(event2["archive_path"], Path(event2["archive_index_path"]).read_text())
            self.assertIn(event2["archive_index_path"], event2["summary_text"])
            self.assertEqual([row["id"] for row in segment1[1:]],
                             [m.id for m in first.messages[:event1["cutoff_index"]]])
            other = await archive.segment("another-thread", first.messages, 0, event1["cutoff_index"])
            self.assertNotEqual(other, event1["archive_path"])
            self.assertEqual(Path(other).read_bytes(), Path(event1["archive_path"]).read_bytes().replace(
                b'"task_id": "test"', b'"task_id": "another-thread"'))

    async def test_inline_media_archive_preserves_bytes_and_omits_base64(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            backend = FilesystemBackend(root_dir=root, virtual_mode=False)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"), backend)
            image, pdf = bytes.fromhex("89504e470d0a1a0a") + b"actual bytes", b"%PDF-1.4\nexact content\n%%EOF"
            raw = [HumanMessage(id="media", content=[
                {"type": "image", "mime_type": "image/png", "url": "/original/also.png",
                 "base64": base64.b64encode(image).decode()},
                {"type": "file", "mime_type": "application/pdf", "base64": base64.b64encode(pdf).decode()},
                {"type": "image", "url": "/original/user.png"},
            ])]
            path = await archive.segment("media-thread", raw, 0, 1)
            body = Path(path).read_text()
            self.assertNotIn(base64.b64encode(image).decode(), body)
            self.assertNotIn(base64.b64encode(pdf).decode(), body)
            record = archived_messages(path)[1]["content"]
            self.assertEqual(record[2]["url"], "/original/user.png")
            self.assertEqual(record[0]["source_path"], "/original/also.png")
            self.assertEqual(Path(record[0]["archive_path"]).read_bytes(), image)
            self.assertEqual(Path(record[1]["archive_path"]).read_bytes(), pdf)
            self.assertEqual(await archive.segment("media-thread", raw, 0, 1), path)
            self.assertIn("archive_path", str((await backend.aread(path)).file_data))

    async def test_archive_preserves_full_tool_arguments_and_result_tail(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"),
                                        FilesystemBackend(root_dir=root, virtual_mode=False))
            arguments = {"query": "complete argument " * 1200 + "TAIL-PARAMETER-58",
                         "include": {"page": 17, "range": [3, 9]}}
            raw = [AIMessage(id="call", content="", tool_calls=[
                {"name": "search", "id": "tool-17", "args": arguments}]),
                   ToolMessage(id="result", tool_call_id="tool-17",
                               content="row " * 1200 + "DEEP-RESULT-71")]
            path = await archive.segment("tool-thread", raw, 0, 2)
            records = archived_messages(path)
            self.assertEqual(records[1]["tool_calls"][0]["args"], arguments)
            self.assertTrue(records[2]["content"].endswith("DEEP-RESULT-71"))

    async def test_archive_failure_keeps_checkpoint_and_does_not_invoke_main_request(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"),
                                        FilesystemBackend(root_dir=root, virtual_mode=False))
            failures = []
            middleware = CompactionMiddleware(
                context_window=10_000, keep_tokens=100, archive=archive,
                on_compaction=lambda task, event: failures.append(event))
            req = request()
            main = AsyncMock()
            with patch("wandrun.runtime.compaction.summarize_request",
                       AsyncMock(return_value=reply("summary"))), patch.object(
                           archive, "_publish", AsyncMock(side_effect=OSError("archive unavailable"))):
                with self.assertRaisesRegex(OSError, "archive unavailable"):
                    await middleware.awrap_model_call(req, main)
            main.assert_not_awaited()
            self.assertNotIn("compaction_events", req.state)
            self.assertEqual(failures[0]["status"], "failed")

    async def test_overflow_after_provisional_cut_archives_all_new_originals(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"),
                                        FilesystemBackend(root_dir=root, virtual_mode=False))
            filler = reply("diagnostic " * 1000)
            filler.id = "filler"
            raw = [*history()[:2], filler, HumanMessage(content="latest instruction", id="latest")]
            calls = []

            async def main(view):
                calls.append(view.messages[0].content)
                if len(calls) == 1:
                    raise ContextWindowExceededError("overflow")
                return ModelResponse(result=[reply()])

            with patch("wandrun.runtime.compaction.summarize_request",
                       AsyncMock(return_value=reply("summary"))):
                result = await CompactionMiddleware(
                    context_window=10_000, keep_tokens=100, archive=archive,
                ).awrap_model_call(request(raw), main)
            event = result.command.update["compaction_events"][-1]
            header = json.loads(Path(event["archive_path"]).read_text().splitlines()[0])
            self.assertEqual(header["start_index"], 0)
            self.assertEqual(header["end_index"], event["cutoff_index"])
            self.assertIn("filler", [record["id"] for record in archived_messages(event["archive_path"])[1:]])
            index = Path(event["archive_index_path"]).read_text()
            self.assertEqual(index.count("segment-"), 1)
            self.assertEqual(len(calls), 2)

    async def test_missing_capacity_does_not_summarize(self):
        with self.assertLogs("wandrun.runtime.compaction", level="WARNING") as logs:
            middleware = CompactionMiddleware(context_window=None)
        self.assertIn("context_window", logs.output[0])
        handler = AsyncMock(return_value=ModelResponse(result=[reply()]))
        with patch("wandrun.runtime.compaction.summarize_request", new_callable=AsyncMock) as summarize:
            await middleware.awrap_model_call(request(), handler)
        summarize.assert_not_awaited()
        self.assertEqual(handler.call_args.args[0].messages[0].id, "old")

    async def test_summary_main_failure_and_cancel_never_mutate_state(self):
        for failure_at in ("summary", "main"):
            for failure in (RuntimeError("failed"), asyncio.CancelledError()):
                with self.subTest(failure_at=failure_at, failure=type(failure).__name__):
                    notices = []
                    middleware = CompactionMiddleware(context_window=10_000, keep_tokens=100,
                                                       on_compaction=lambda task, event: notices.append(event))
                    req = request()
                    summary = AsyncMock(side_effect=failure) if failure_at == "summary" else AsyncMock(return_value=reply("summary"))
                    main = AsyncMock(side_effect=failure)
                    with patch("wandrun.runtime.compaction.summarize_request", summary):
                        with self.assertRaises(type(failure)):
                            await middleware.awrap_model_call(req, main)
                    self.assertNotIn("compaction_events", req.state)
                    self.assertEqual(notices[0]["status"], "failed")

    async def test_overflow_has_one_recovery_and_preserves_failure(self):
        middleware = CompactionMiddleware(context_window=1_000_000, keep_tokens=100)
        handler = AsyncMock(side_effect=[ContextWindowExceededError("overflow"), ModelResponse(result=[reply()])])
        with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
            result = await middleware.awrap_model_call(request(), handler)
        self.assertEqual(result.command.update["compaction_events"][0]["reason"], "overflow")
        self.assertEqual(handler.await_count, 2)
        handler = AsyncMock(side_effect=ContextWindowExceededError("overflow"))
        with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
            with self.assertRaises(ContextWindowExceededError):
                await middleware.awrap_model_call(request(), handler)
        self.assertEqual(handler.await_count, 2)

    async def test_soft_tail_target_keeps_crossing_tool_groups_until_capacity_requires_shrink(self):
        for window, keep, group_count in ((272000, 20000, 1), (80000, 30000, 3), (10000, 20000, 1)):
            with self.subTest(window=window, keep=keep):
                raw = history()[:2]
                for index in range(group_count):
                    call_id = f"report-{index}"
                    raw.extend([
                        AIMessage(content="", id=f"call-{index}", tool_calls=[
                            {"name": "report", "args": {}, "id": call_id},
                        ], additional_kwargs={"codex_output_items": [{
                            "type": "function_call", "name": "report", "call_id": call_id,
                            "arguments": "{}",
                        }]}),
                        ToolMessage(content="diagnostic " * (5200 if group_count == 1 else 2900),
                                    tool_call_id=call_id, id=f"result-{index}"),
                    ])
                raw.append(HumanMessage(content="short latest instruction", id="latest"))
                req = request(raw)
                middleware = CompactionMiddleware(context_window=window, keep_tokens=keep)
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
                    event, candidate, _ = await middleware._compact(req, req, None, "threshold")
                ids = [m.id for m in candidate.messages]
                self.assertIn("latest", ids)
                self.assertEqual(event["keep_tokens"], keep)
                if window == 10000:
                    self.assertNotIn("call-0", ids)
                    self.assertNotIn("result-0", ids)
                    self.assertLess(event["retained_tokens"], keep)
                    self.assertEqual(event["retention_reason"], "candidate_capacity")
                else:
                    self.assertEqual(event["cutoff_index"], 2)
                    self.assertIn("call-0", ids)
                    self.assertIn("result-0", ids)
                    self.assertGreaterEqual(event["retained_tokens"], keep)
                    self.assertEqual(event["retention_reason"], "target")
                message_groups(candidate.messages)

    async def test_unconsumed_media_cannot_be_compacted_out_of_main_request(self):
        for window, pdf_count, system_size in ((40_000, 1, 32_000), (272_000, 14, 0)):
            with self.subTest(window=window):
                raw = [
                    HumanMessage(content="Read and compare the media", id="instruction"),
                    media_read_call(),
                    ToolMessage(content="Media loaded", tool_call_id="read", id="result"),
                    HumanMessage(id="media", additional_kwargs={"read_file_media_result": True, "read_file_tool_call_id": "read"},
                                 content=[
                                     {"type": "image", "mime_type": "image/png", "base64": "aW1hZ2U="},
                                     *[{"type": "file", "mime_type": "application/pdf", "base64": "cGRm"}
                                       for _ in range(pdf_count)],
                                 ]),
                    HumanMessage(content="current memory", id="runtime-memory",
                                 additional_kwargs={"source": "runtime"}),
                ]
                req = request(raw).override(system_message=SystemMessage(content="s" * system_size))
                before = [m.model_dump() for m in raw]
                notices = []
                middleware = CompactionMiddleware(
                    context_window=window,
                    on_compaction=lambda task, event: notices.append(event),
                )
                main = AsyncMock(return_value=ModelResponse(result=[reply("read again")]))
                with patch("wandrun.runtime.compaction.summarize_request",
                           AsyncMock(return_value=reply("Read the media again"))):
                    with self.assertRaisesRegex(ContextBudgetExhausted, "分批读取"):
                        await middleware.awrap_model_call(req, main)
                main.assert_not_awaited()
                self.assertNotIn("compaction_events", req.state)
                self.assertEqual([m.model_dump() for m in raw], before)
                self.assertEqual(notices[0]["status"], "failed")
                self.assertIn("图片或 PDF 尚未处理", notices[0]["message"])

    async def test_media_fits_or_has_already_been_consumed(self):
        for consumed in (False, True):
            with self.subTest(consumed=consumed):
                raw = [
                    HumanMessage(content="older history " * 50_000, id="old"),
                    reply(),
                    HumanMessage(content="Read media", id="instruction"),
                    media_read_call(),
                    ToolMessage(content="loaded", tool_call_id="read", id="result"),
                    HumanMessage(id="media", additional_kwargs={"read_file_media_result": True, "read_file_tool_call_id": "read"},
                                 content=[{"type": "file", "mime_type": "application/pdf", "base64": "cGRm"}]),
                ]
                if consumed:
                    raw.extend([reply("I have read it"), HumanMessage(content="Continue", id="continue")])
                main = AsyncMock(return_value=ModelResponse(result=[reply()]))
                with patch("wandrun.runtime.compaction.summarize_request",
                           AsyncMock(return_value=reply("facts"))):
                    await CompactionMiddleware(context_window=272_000, keep_tokens=1).awrap_model_call(
                        request(raw), main)
                ids = [m.id for m in main.call_args.args[0].messages]
                self.assertEqual("media" in ids, not consumed)

    async def test_overflow_recovery_must_not_discard_unconsumed_media(self):
        raw = [
            *history()[:2],
            HumanMessage(content="Compare this report", id="instruction"),
            media_read_call(),
            ToolMessage(content="loaded", tool_call_id="read", id="result"),
            HumanMessage(id="media", additional_kwargs={"read_file_media_result": True, "read_file_tool_call_id": "read"},
                         content=[{"type": "file", "mime_type": "application/pdf", "base64": "cGRm"}]),
        ]
        main = AsyncMock(side_effect=ContextWindowExceededError("overflow"))
        req = request(raw)
        with patch("wandrun.runtime.compaction.summarize_request",
                   AsyncMock(return_value=reply("facts"))):
            with self.assertRaisesRegex(ContextBudgetExhausted, "分批读取"):
                await CompactionMiddleware(context_window=30_000, keep_tokens=100).awrap_model_call(req, main)
        self.assertEqual(main.await_count, 1)
        self.assertIn("media", [m.id for m in main.call_args.args[0].messages])
        self.assertNotIn("compaction_events", req.state)

    async def test_turn_limit_bounds_tool_loop_and_resets_on_next_invocation(self):
        @tool
        def read_report() -> str:
            """Read a large report."""
            return "diagnostic " * 2500

        calls = []
        class Model(CodexSubscriptionModel):
            async def _agenerate(self, messages, **kwargs):
                calls.append(messages)
                if messages[-1].content == "stop":
                    result = reply("stopped")
                else:
                    call_id = f"read-{len(calls)}"
                    result = AIMessage(content="", tool_calls=[
                        {"name": "read_report", "id": call_id, "args": {}},
                    ], additional_kwargs={"codex_output_items": [{
                        "type": "function_call", "name": "read_report",
                        "call_id": call_id, "arguments": "{}",
                    }]})
                return ChatResult(generations=[ChatGeneration(message=result)])

        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            async with AsyncSqliteSaver.from_conn_string(str(Path(directory) / "state.sqlite")) as saver:
                graph = create_agent(Model(), tools=[read_report], middleware=[
                    CompactionMiddleware(context_window=10_000, keep_tokens=100),
                ], checkpointer=saver)
                config = conversation_config("bounded-turn")
                summaries = AsyncMock(return_value=reply("report facts"))
                with patch("wandrun.runtime.compaction.summarize_request", summaries):
                    with self.assertRaisesRegex(ContextBudgetExhausted, "4 次上限"):
                        await graph.ainvoke({"messages": [HumanMessage(content="read")]}, config,
                                            context={"task_id": "bounded-turn"})
                    saved = (await graph.aget_state(config)).values
                    self.assertEqual(len(saved["compaction_events"]), 4)
                    self.assertEqual(summaries.await_count, 4)
                    self.assertEqual(len(calls), 5)
                    resumed = await graph.ainvoke({"messages": [HumanMessage(content="stop")]}, config,
                                                 context={"task_id": "bounded-turn"})
                self.assertEqual(resumed["messages"][-1].content, "stopped")
                saved = (await graph.aget_state(config)).values
                self.assertEqual(len(saved["compaction_events"]), 5)

    async def test_memory_new_conversation_reload_and_restart_without_summary_rebase(self):
        observations = []
        class Model(CodexSubscriptionModel):
            async def _agenerate(self, messages, **kwargs):
                observations.append(messages)
                return ChatResult(generations=[ChatGeneration(message=reply())])
        with tempfile.TemporaryDirectory() as directory:
            store = MemoryStore(Path(directory) / "memory")
            current = store.save("agent", "只使用中文答复", store.read("agent").version)
            path = str(Path(directory) / "state.sqlite")
            config = conversation_config("memory-compaction")
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                memory = MemoryMiddleware(store, "agent")
                graph = create_agent(Model(), state_schema=ConversationState, middleware=[
                    memory, CompactionMiddleware(context_window=10_000, keep_tokens=100, memory=memory),
                ], checkpointer=saver)
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("task summary"))):
                    await graph.ainvoke({"messages": history()}, config, context={"task_id": "memory-compaction"})
                saved = (await graph.aget_state(config)).values
                self.assertIsNone(saved["memory_version"])
                self.assertEqual(saved["compaction_events"][0]["summary_text"], "task summary")
                self.assertIn("只使用中文答复", observations[0][-1].content)
                view = [m for m in observations[0] if not isinstance(m, SystemMessage)]
                self.assertTrue(view[0].id.startswith("compaction:"))
                # The snapshot precedes the response in raw history, even if it calls tools.
                self.assertEqual(saved["messages"][-2].additional_kwargs["memory_snapshot_version"], current.version)
                self.assertEqual(sum(
                    m.additional_kwargs.get("memory_snapshot_version") == current.version
                    for m in observations[0]
                ), 1)
                self.assertEqual(sum(
                    m.additional_kwargs.get("memory_snapshot_version") == current.version
                    for m in saved["messages"]
                ), 1)
            # Reopen SQLite with the same store version: recover the cleared marker,
            # not another copy of the snapshot already seen by the successful model.
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                memory = MemoryMiddleware(store, "agent")
                graph = create_agent(Model(), state_schema=ConversationState, middleware=[
                    memory, CompactionMiddleware(context_window=10_000, keep_tokens=100, memory=memory),
                ], checkpointer=saver)
                await graph.ainvoke({"messages": [HumanMessage(content="继续")]}, config,
                                    context={"task_id": "memory-compaction"})
                unchanged = (await graph.aget_state(config)).values
                self.assertEqual(unchanged["memory_version"], current.version)
                for messages in (observations[-1], unchanged["messages"]):
                    self.assertEqual(sum(
                        m.additional_kwargs.get("memory_snapshot_version") == current.version
                        for m in messages
                    ), 1)
            store.save("agent", "", current.version)
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                memory = MemoryMiddleware(store, "agent")
                graph = create_agent(Model(), state_schema=ConversationState, middleware=[
                    memory, CompactionMiddleware(context_window=10_000, keep_tokens=100, memory=memory),
                ], checkpointer=saver)
                with patch("wandrun.runtime.compaction.summarize_request", new_callable=AsyncMock) as summarize:
                    await graph.ainvoke({"messages": [HumanMessage(content="继续")]}, config,
                                        context={"task_id": "memory-compaction"})
                summarize.assert_not_awaited()
                resumed = (await graph.aget_state(config)).values
                self.assertEqual(resumed["memory_version"], store.read("agent").version)
                self.assertEqual(resumed["compaction_events"], saved["compaction_events"])
                self.assertIn("当前记忆为空", observations[-1][-1].content)
                for messages in (observations[-1], resumed["messages"]):
                    versions = [m.additional_kwargs["memory_snapshot_version"] for m in messages
                                if "memory_snapshot_version" in m.additional_kwargs]
                    self.assertEqual(versions, [current.version, store.read("agent").version])

    async def test_cut_snapshot_is_reloaded_once_and_next_boundary_reuses_it(self):
        observations = []
        class Model(CodexSubscriptionModel):
            async def _agenerate(self, messages, **kwargs):
                observations.append(messages)
                return ChatResult(generations=[ChatGeneration(message=reply())])
        with tempfile.TemporaryDirectory() as directory:
            store = MemoryStore(Path(directory) / "memory")
            current = store.save("agent", "当前背景", store.read("agent").version)
            async with AsyncSqliteSaver.from_conn_string(str(Path(directory) / "state.sqlite")) as saver:
                memory = MemoryMiddleware(store, "agent")
                graph = create_agent(Model(), state_schema=ConversationState, middleware=[
                    memory, CompactionMiddleware(context_window=10000, keep_tokens=100, memory=memory),
                ], checkpointer=saver)
                config = conversation_config("cut-memory")
                await graph.ainvoke({"messages": [HumanMessage(content="start")]}, config,
                                    context={"task_id": "cut-memory"})
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
                    await graph.ainvoke({"messages": history()}, config, context={"task_id": "cut-memory"})
                for _ in range(2):
                    await graph.ainvoke({"messages": [HumanMessage(content="continue")]}, config,
                                        context={"task_id": "cut-memory"})
                saved = (await graph.aget_state(config)).values
                self.assertEqual(len(saved["compaction_events"]), 1)
                self.assertEqual(saved["memory_version"], current.version)
                # The immutable old history has its original snapshot plus the one
                # reload; each actual post-compaction request has only the reload.
                self.assertEqual(sum("memory_snapshot_version" in m.additional_kwargs
                                     for m in saved["messages"]), 2)
                for messages in observations[1:]:
                    self.assertEqual([m.additional_kwargs["memory_snapshot_version"] for m in messages
                                      if "memory_snapshot_version" in m.additional_kwargs], [current.version])

    async def test_cut_search_must_reload_before_execution(self):
        @tool
        def lookup(query: str) -> str:
            """Look up a record."""
            return {"record-17": "青槐归档"}[query]
        search = ToolSearchMiddleware([ToolNamespace("catalog", "records", (lookup,))])
        artifact = search.search("lookup records", set())
        ai = AIMessage(content="", id="search-ai", tool_calls=[{"name": "tool_search", "args": {"query": "lookup"}, "id": "search"}],
                       additional_kwargs={"codex_output_items": [{"type": "tool_search_call", "execution": "client", "call_id": "search", "arguments": {"query": "lookup"}}]})
        output = ToolMessage(content="loaded", id="search-result", tool_call_id="search", artifact=artifact)
        raw = [ai, output, *history()]
        req = request(raw)
        with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
            result = await CompactionMiddleware(context_window=10_000, keep_tokens=100).awrap_model_call(req, AsyncMock(return_value=ModelResponse(result=[reply()])))
        event = result.command.update["compaction_events"][-1]
        view = context_messages(req.state, event=event)
        self.assertEqual(loaded_tool_names(view), set())
        self.assertEqual(message_groups(raw)[0], (0, 2))
        call = AIMessage(content="", tool_calls=[{"name": "catalog.lookup", "args": {"query": "x"}, "id": "execute"}], additional_kwargs={"codex_output_items": [{"type": "function_call", "namespace": "catalog", "name": "lookup", "call_id": "execute"}]})
        state = {"messages": [*raw, call], "compaction_events": [event]}
        tool_request = ToolCallRequest(tool_call=call.tool_calls[0], tool=None, state=state, runtime=None)
        direct, forwarded = search._route(tool_request)
        self.assertEqual(direct.status, "error")
        self.assertIsNone(forwarded)
        # A new actual search, not summary prose, restores the permission.
        reloaded_call = ai.model_copy(update={
            "id": "search-again",
            "tool_calls": [{"name": "tool_search", "args": {"query": "lookup records"}, "id": "reload"}],
            "additional_kwargs": {"codex_output_items": [{
                "type": "tool_search_call", "execution": "client", "call_id": "reload",
                "arguments": {"query": "lookup records"},
            }]},
        })
        state["messages"] = [*raw, reloaded_call]
        search_request = ToolCallRequest(tool_call=reloaded_call.tool_calls[0], tool=None, state=state, runtime=None)
        output, _ = search._route(search_request)
        state["messages"] = [*state["messages"], output, call]
        direct, forwarded = search._route(tool_request)
        self.assertIsNone(direct)
        self.assertEqual(await forwarded.tool.ainvoke({"query": "record-17"}), "青槐归档")
        with self.assertRaises(ValueError):
            message_groups([ai, HumanMessage(content="broken")])
        with self.assertRaises(ValueError):
            message_groups([output])

    async def test_usage_baseline_and_changed_source(self):
        middleware = CompactionMiddleware(context_window=100_000, keep_tokens=100)
        req = request([HumanMessage(content="question", id="question")])
        response = reply("answer")
        response.id = "answer"
        result = await middleware.awrap_model_call(req, AsyncMock(return_value=ModelResponse(result=[response])))
        saved = result.command.update
        next_req = request([*req.messages, response, HumanMessage(content="next", id="next")], **saved)
        usage, _, _ = middleware._usage(next_req, 0)
        self.assertGreaterEqual(usage, 110)
        modified = next_req.override(messages=[HumanMessage(content="changed " * 500, id="question"), *next_req.messages[1:]])
        changed, _, _ = middleware._usage(modified, 0)
        self.assertGreater(changed, usage)

    async def test_sqlite_restart_and_failed_main_preserve_committed_event(self):
        class Model(CodexSubscriptionModel):
            fail: bool = False
            async def _agenerate(self, messages, **kwargs):
                if self.fail:
                    raise RuntimeError("main failed")
                return ChatResult(generations=[ChatGeneration(message=reply())])
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "checkpoint.sqlite")
            config = conversation_config("restart")
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                model = Model()
                graph = create_agent(model, middleware=[CompactionMiddleware(context_window=10_000, keep_tokens=100)], checkpointer=saver)
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("first summary"))):
                    await graph.ainvoke({"messages": history()}, config, context={"task_id": "restart"}, durability="sync")
                before = (await graph.aget_state(config)).values
                self.assertEqual(len(before["compaction_events"]), 1)
                model.fail = True
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("uncommitted summary"))):
                    with self.assertRaisesRegex(RuntimeError, "main failed"):
                        await graph.ainvoke({"messages": [HumanMessage(content="new " * 10000, id="new"), HumanMessage(content="finish", id="finish")]}, config, context={"task_id": "restart"}, durability="sync")
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                graph = create_agent(Model(), middleware=[CompactionMiddleware(context_window=10_000, keep_tokens=100)], checkpointer=saver)
                resumed = (await graph.aget_state(config)).values
                self.assertEqual(resumed["compaction_events"], before["compaction_events"])
                inputs = await prepare_conversation_input(graph, config, [HumanMessage(content="finish", id="finish")])
                self.assertEqual(inputs["messages"], [])
                self.assertIn("old", [m.id for m in resumed["messages"]])

    async def test_notice_and_tool_batch_survive_cut_and_source_changes_fail(self):
        call = AIMessage(content="", id="batch", tool_calls=[
            {"name": "read", "args": {}, "id": "a"}, {"name": "read", "args": {}, "id": "b"},
        ], additional_kwargs={"codex_output_items": [
            {"type": "function_call", "name": "read", "call_id": key, "arguments": "{}"} for key in ("a", "b")
        ]})
        a = ToolMessage(content="first result", tool_call_id="a", id="a-result")
        b = ToolMessage(content="second result", tool_call_id="b", id="b-result")
        notice = HumanMessage(content="先前发送未被接收，不要假定已创建任务", id="undelivered:response")
        req = request([notice, *history(), call, a, b])
        with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
            result = await CompactionMiddleware(context_window=10_000, keep_tokens=100).awrap_model_call(
                req, AsyncMock(return_value=ModelResponse(result=[reply()])),
            )
        event = result.command.update["compaction_events"][-1]
        view = context_messages(req.state, event=event)
        ids = [m.id for m in view]
        self.assertIn(notice.id, ids)
        self.assertEqual(ids[-3:], ["batch", "a-result", "b-result"])
        original = req.state["messages"][0]
        req.state["messages"][0] = original.model_copy(update={"content": "tampered same ID"})
        with self.assertRaisesRegex(ValueError, "不一致"):
            context_messages(req.state, event=event)

    async def test_compaction_events_are_thread_local(self):
        middleware = CompactionMiddleware(context_window=10_000, keep_tokens=100)
        async def summary(r, **kwargs):
            await asyncio.sleep(0)
            return reply("summary for " + r.runtime.context["task_id"])
        left, right = request(), request()
        right.runtime.context["task_id"] = "other"
        with patch("wandrun.runtime.compaction.summarize_request", summary):
            results = await asyncio.gather(*(
                middleware.awrap_model_call(r, AsyncMock(return_value=ModelResponse(result=[reply()])))
                for r in (left, right)
            ))
        events = [result.command.update["compaction_events"][0] for result in results]
        self.assertEqual([event["summary_text"] for event in events], ["summary for test", "summary for other"])
        self.assertNotEqual(events[0]["event_id"], events[1]["event_id"])

    async def test_actual_usage_triggers_and_changed_response_invalidates_baseline(self):
        middleware = CompactionMiddleware(context_window=1000, keep_tokens=50)
        req = request([HumanMessage(content="old instruction", id="first")])
        answer = reply("short answer")
        answer.id = "answer"
        answer.usage_metadata = {"input_tokens": 800, "output_tokens": 100, "total_tokens": 900}
        initial = await middleware.awrap_model_call(req, AsyncMock(return_value=ModelResponse(result=[answer])))
        following = request([*req.messages, answer, HumanMessage(content="next", id="next")],
                            **initial.command.update)
        self.assertGreaterEqual(middleware._usage(following, 0)[0], 900)
        changed = following.override(messages=[
            *req.messages, reply("replacement without the original reasoning"), following.messages[-1],
        ])
        self.assertLess(middleware._usage(changed, 0)[0], 750)
        with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("short summary"))):
            compacted = await middleware.awrap_model_call(
                following, AsyncMock(return_value=ModelResponse(result=[reply()])),
            )
        self.assertEqual(compacted.command.update["compaction_events"][0]["reason"], "threshold")

    async def test_indivisible_input_and_unhelpful_summary_fail_without_main_call(self):
        middleware = CompactionMiddleware(context_window=10_000, keep_tokens=100)
        for raw, summary in (
            ([HumanMessage(content="uncut instruction " * 5000, id="only")], "summary"),
            (history(), "oversized summary " * 10000),
        ):
            with self.subTest(single=len(raw) == 1):
                handler = AsyncMock()
                req = request(raw)
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply(summary))):
                    with self.assertRaises(ContextBudgetExhausted):
                        await middleware.awrap_model_call(req, handler)
                handler.assert_not_awaited()
                self.assertNotIn("compaction_events", req.state)

    async def test_compacted_response_can_write_memory_without_authorizing_unseen_changes(self):
        for concurrent_edit in (False, True):
            with self.subTest(concurrent_edit=concurrent_edit), tempfile.TemporaryDirectory() as directory:
                store = MemoryStore(Path(directory) / "memory")
                saved = store.save("agent", "旧背景", store.read("agent").version)
                backend = ManagedMemoryBackend(FilesystemBackend(root_dir=directory), store, "agent")
                @tool
                async def save_memory(content: str) -> str:
                    """Replace the memory document using the observed version."""
                    result = await backend.awrite(MEMORY_PATH, content)
                    return result.error or "保存成功"
                calls = []
                class Model(CodexSubscriptionModel):
                    async def _agenerate(self, messages, **kwargs):
                        calls.append(messages)
                        if len(calls) == 1:
                            if concurrent_edit:
                                store.save("agent", "外部新背景", saved.version)
                            result = AIMessage(content="", tool_calls=[{
                                "name": "save_memory", "args": {"content": "模型新背景"}, "id": "save",
                            }], additional_kwargs={"codex_output_items": [{
                                "type": "function_call", "call_id": "save", "name": "save_memory",
                                "arguments": '{"content":"模型新背景"}',
                            }]})
                        else:
                            result = reply()
                        return ChatResult(generations=[ChatGeneration(message=result)])
                memory = MemoryMiddleware(store, "agent")
                graph = create_agent(Model(), tools=[save_memory], state_schema=ConversationState, middleware=[
                    memory, CompactionMiddleware(context_window=10_000, keep_tokens=100, memory=memory),
                ])
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("summary"))):
                    state = await graph.ainvoke({"messages": history()}, context={"task_id": "memory-write"})
                self.assertEqual(store.read("agent").content, "外部新背景" if concurrent_edit else "模型新背景")
                result = next(m for m in state["messages"] if isinstance(m, ToolMessage))
                self.assertIn("已更新" if concurrent_edit else "保存成功", result.content)
                message_groups(state["messages"])

    async def test_cancel_during_summary_reopens_original_history_without_candidate(self):
        started = asyncio.Event()
        async def blocked_summary(request, **kwargs):
            started.set()
            await asyncio.Event().wait()
        class Model(CodexSubscriptionModel):
            async def _agenerate(self, messages, **kwargs):
                return ChatResult(generations=[ChatGeneration(message=reply())])
        config = conversation_config("cancelled")
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "checkpoint.sqlite")
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                graph = create_agent(Model(), middleware=[
                    CompactionMiddleware(context_window=10_000, keep_tokens=100),
                ], checkpointer=saver)
                with patch("wandrun.runtime.compaction.summarize_request", blocked_summary):
                    running = asyncio.create_task(graph.ainvoke(
                        {"messages": history()}, config, context={"task_id": "cancelled"}, durability="sync",
                    ))
                    await asyncio.wait_for(started.wait(), 5)
                    running.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await running
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                graph = create_agent(Model(), middleware=[
                    CompactionMiddleware(context_window=10_000, keep_tokens=100),
                ], checkpointer=saver)
                original = (await graph.aget_state(config)).values
                self.assertNotIn("compaction_events", original)
                self.assertEqual([m.id for m in original["messages"]].count("old"), 1)
                inputs = await prepare_conversation_input(graph, config, [
                    HumanMessage(content="latest instruction", id="latest"),
                ])
                with patch("wandrun.runtime.compaction.summarize_request", AsyncMock(return_value=reply("retry summary"))):
                    await graph.ainvoke(inputs, config, context={"task_id": "cancelled"}, durability="sync")
                resumed = (await graph.aget_state(config)).values
                self.assertEqual([e["summary_text"] for e in resumed["compaction_events"]], ["retry summary"])
                self.assertEqual([m.id for m in resumed["messages"]].count("old"), 1)
