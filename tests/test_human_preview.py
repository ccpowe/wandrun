"""Explicit human previews are transient, request-scoped and execution-owned."""

import asyncio
import json
import unittest
from contextlib import nullcontext
from unittest.mock import patch

from langgraph.errors import GraphBubbleUp, GraphInterrupt

from wandrun.integrations.codex_subscription import (
    CodexSubscriptionModel, CodexSubscriptionStreamError, _ResponseStream,
)
from wandrun.integrations.human_preview import HumanPreviewParser
from wandrun.runtime.messages import AgentOutput
from wandrun.runtime.preview import PreviewExecution, PreviewPersistenceError, current_preview
from wandrun.runtime.workers import WorkerManager


FORMAT = {"type": "json_schema", "json_schema": {
    "name": "AgentOutput", "strict": True, "schema": AgentOutput.model_json_schema(),
}}


def human(text):
    return {"to": "human", "task_id": None, "message": text, "attachments": []}


def item(messages, phase="final_answer"):
    return {"type": "message", "role": "assistant", "phase": phase,
            "content": [{"type": "output_text", "text": json.dumps({"messages": messages, "next": "done"}, ensure_ascii=False)}]}


def stream_events(items, *, finish=True):
    for index, output in enumerate(items):
        yield {"type": "response.output_item.added", "output_index": index,
               "item": {**output, "content": []}}
        if output["type"] == "message":
            for character in output["content"][0]["text"]:
                yield {"type": "response.output_text.delta", "output_index": index,
                       "content_index": 0, "delta": character}
        yield {"type": "response.output_item.done", "output_index": index, "item": output}
    if finish:
        yield {"type": "response.completed", "response": {"status": "completed", "output": items}}


class ParserTests(unittest.TestCase):
    def test_route_and_unicode_survive_character_splits_without_cross_recipient_leak(self):
        worker = {"to": "worker", "task_id": None,
                  "message": 'secret \\"to\\":\\"human\\"', "attachments": []}
        nonnull = {"to": "human", "task_id": "worker", "message": "not for user", "attachments": []}
        payload = ('{"messages":[' + json.dumps(worker) + ',' + json.dumps(nonnull) + ','
                   + '{"to":"human","task_id":null,"message":"A\\uD83D\\uDE42\\n'
                   + '中\\\\\\\" done","attachments":[]}],"next":"done"}')
        parser = HumanPreviewParser()
        observations = [update for char in payload for update in parser.feed(char)]
        self.assertFalse(parser.disabled)
        self.assertEqual(observations[-1], (2, 'A🙂\n中\\" done'))
        self.assertEqual({index for index, _ in observations}, {2})
        self.assertTrue(all("secret" not in text and "not for user" not in text
                            for _, text in observations))

    def test_unrouted_and_malformed_paths_never_publish(self):
        for payload in (
            '{"messages":[{"message":"private","to":"human","task_id":null}]}',
            '{"other":{"messages":[{"to":"human","task_id":null,"message":"private"}]}}',
            '{"messages":[{"to":"human","task_id":"null","message":"private"}]}',
            '普通 commentary',
        ):
            with self.subTest(payload=payload):
                parser = HumanPreviewParser()
                self.assertEqual([update for part in (payload[:5], payload[5:])
                                  for update in parser.feed(part)], [])


class AdapterTests(unittest.TestCase):
    def test_phases_and_multiple_messages_keep_distinct_draft_ids_and_final_output(self):
        events = []
        scope = PreviewExecution("member", lambda sender, event: events.append((sender, event)))
        token = current_preview.set(scope)
        try:
            items = [
                {"type": "reasoning", "summary": [], "encrypted_content": "not public"},
                item([human("early"), {"to": "worker", "task_id": None,
                                       "message": "private", "attachments": []}], "commentary"),
                item([human("late"), human("again")]),
            ]
            state = _ResponseStream("test", FORMAT, preview=current_preview.get())
            chunks = [chunk for event in stream_events(items) for chunk in state.feed(event)]
            self.assertEqual(len(chunks), 1)
            output = chunks[0].message.additional_kwargs
            self.assertEqual([m["message"] for m in output["wandrun_agent_output"]["messages"]],
                             ["early", "private", "late", "again"])
            draft_ids = output["wandrun_draft_ids"]
            self.assertEqual(len({identity for identity in draft_ids if identity}), 3)
            self.assertIsNone(draft_ids[1])
            self.assertEqual([event["phase"] for _, event in events if event["kind"] == "update" and
                              event["text"] in {"early", "late", "again"}],
                             ["commentary", "final_answer", "final_answer"])
            self.assertNotIn("private", [event["text"] for _, event in events
                                         if event["kind"] == "update"])
            self.assertNotIn("not public", [event["text"] for _, event in events
                                            if event["kind"] == "update"])
        finally:
            scope.close()
            current_preview.reset(token)

    def test_sparse_output_indices_and_sequential_content_parts_map_to_formal_messages(self):
        seen = []
        scope = PreviewExecution("worker", lambda sender, event: seen.append(event))
        first = item([human("first part")])
        text = first["content"][0]["text"]
        cut = text.index("first") + 3
        first["content"] = [{"type": "output_text", "text": text[:cut]},
                            {"type": "output_text", "text": text[cut:]}]
        second = item([human("second")])
        state = _ResponseStream("test", FORMAT, preview=scope)
        chunks = []
        for index, output in ((7, first), (12, second)):
            chunks.extend(state.feed({
                "type": "response.output_item.added", "output_index": index,
                "item": {**output, "content": []},
            }))
            for part_index, part in enumerate(output["content"]):
                for char in part["text"]:
                    chunks.extend(state.feed({
                        "type": "response.output_text.delta", "output_index": index,
                        "content_index": part_index, "delta": char,
                    }))
            chunks.extend(state.feed({
                "type": "response.output_item.done", "output_index": index, "item": output,
            }))
        chunks.extend(state.feed({
            "type": "response.completed", "response": {"status": "completed", "output": []},
        }))
        metadata = chunks[-1].message.additional_kwargs
        self.assertEqual([message["message"] for message in metadata["wandrun_agent_output"]["messages"]],
                         ["first part", "second"])
        self.assertEqual(metadata["codex_output_items"], [first, second])
        self.assertTrue(metadata["wandrun_draft_ids"][0].endswith(":7:0"))
        self.assertTrue(metadata["wandrun_draft_ids"][1].endswith(":12:0"))
        self.assertEqual({event["text"] for event in seen if event["kind"] == "update"
                          and event["text"] in {"first part", "second"}},
                         {"first part", "second"})
        scope.close()

    def test_completed_item_ids_reconcile_sparse_live_indices(self):
        scope = PreviewExecution("root", lambda *_: None)
        output = {**item([human("mapped")]), "id": "msg_unique"}
        state = _ResponseStream("test", FORMAT, preview=scope)
        for event in (
            {"type": "response.output_item.added", "output_index": 9,
             "item": {**output, "content": []}},
            {"type": "response.output_text.delta", "output_index": 9,
             "content_index": 0, "delta": output["content"][0]["text"]},
            {"type": "response.output_item.done", "output_index": 9, "item": output},
        ):
            list(state.feed(event))
        (chunk,) = list(state.feed({
            "type": "response.completed",
            "response": {"status": "completed", "output": [output]},
        }))
        self.assertTrue(chunk.message.additional_kwargs["wandrun_draft_ids"][0].endswith(":9:0"))
        scope.close()

    def test_failed_http_attempt_ends_only_its_drafts_before_new_request(self):
        observed = []
        scope = PreviewExecution("root", lambda sender, event: observed.append(event))
        token = current_preview.set(scope)
        output = item([human("first")])
        second = item([human("replacement")])
        attempts = iter((list(stream_events([output], finish=False)),
                         list(stream_events([second]))))
        model = CodexSubscriptionModel()
        try:
            with patch.object(CodexSubscriptionModel, "_request", lambda *_: (event for event in next(attempts))):
                with self.assertRaises(CodexSubscriptionStreamError):
                    model.invoke("start", response_format=FORMAT)
                answer = model.invoke("retry", response_format=FORMAT)
            self.assertEqual(answer.additional_kwargs["wandrun_agent_output"]["messages"][0]["message"],
                             "replacement")
            self.assertEqual([event["kind"] for event in observed if event["kind"] != "update"],
                             ["start", "end"])
            old_id = next(event["draft_id"] for event in observed if event["kind"] == "update")
            self.assertEqual(observed[-1]["text"], "replacement")
            self.assertNotEqual(answer.additional_kwargs["wandrun_draft_ids"][0], old_id)
            self.assertEqual(observed[-1]["attempt_id"], answer.additional_kwargs["wandrun_draft_ids"][0].split(':')[1])
            before = len(observed)
            self.assertIsNone(scope.update(old_id.split(":")[1], 4, 0, "late retry", "final_answer"))
            current_id = answer.additional_kwargs["wandrun_draft_ids"][0]
            self.assertIsNone(scope.update(current_id.split(":")[1], 4, 0, "late completed", "final_answer"))
            self.assertEqual(len(observed), before)
            self.assertEqual(scope.id_for(current_id.split(":")[1], 0, 0), current_id)
        finally:
            scope.close()
            current_preview.reset(token)

    def test_sync_response_survives_update_parser_and_initialization_failures(self):
        output = item([human("完整回复")])
        usage = {"input_tokens": 5, "output_tokens": 8, "total_tokens": 13}
        for failure in ("none", "update", "feed", "init", "id_for", "complete_attempt"):
            with self.subTest(failure=failure):
                events = []

                def observer(sender, event):
                    events.append(event)
                    if event["kind"] == failure:
                        raise RuntimeError("temporary observer failed")

                scope = PreviewExecution("root", observer)
                token = current_preview.set(scope)
                samples = list(stream_events([output]))
                samples[-1]["response"]["usage"] = usage
                try:
                    with patch.object(CodexSubscriptionModel, "_request",
                                      lambda *_: (event for event in samples)):
                        if failure == "feed":
                            failing = patch.object(HumanPreviewParser, "feed",
                                                   side_effect=RuntimeError("parser failed"))
                        elif failure == "init":
                            failing = patch("wandrun.integrations.codex_subscription.HumanPreviewParser",
                                            side_effect=RuntimeError("parser init failed"))
                        elif failure in {"id_for", "complete_attempt"}:
                            failing = patch.object(scope, failure, side_effect=RuntimeError("preview completion"))
                        else:
                            failing = nullcontext()
                        with failing:
                            answer = CodexSubscriptionModel().invoke("prompt", response_format=FORMAT)
                    self.assertEqual(answer.additional_kwargs["wandrun_agent_output"]["messages"],
                                     [human("完整回复")])
                    self.assertEqual(answer.additional_kwargs["codex_output_items"], [output])
                    self.assertEqual(answer.response_metadata["status"], "completed")
                    self.assertEqual(answer.response_metadata["usage"], usage)
                    self.assertEqual(answer.usage_metadata["total_tokens"], 13)
                    if failure != "none":
                        self.assertFalse(any(answer.additional_kwargs.get("wandrun_draft_ids", [])))
                        self.assertFalse(scope.enabled)
                        self.assertEqual([event["kind"] for event in events].count("close"), 1)
                    else:
                        self.assertIsNotNone(answer.additional_kwargs["wandrun_draft_ids"][0])
                finally:
                    scope.close()
                    current_preview.reset(token)
                self.assertEqual(events[0], {"kind": "start", "execution_id": scope.execution_id})
                self.assertEqual(events[-1], {"kind": "close", "execution_id": scope.execution_id})
                self.assertEqual([event["kind"] for event in events].count("close"), 1)
                attempt = next(iter(answer.additional_kwargs.get("wandrun_draft_ids", [])), None)
                if attempt:
                    self.assertIsNone(scope.update(attempt.split(":")[1], 0, 0, "late", "final_answer"))

    def test_callback_cleanup_failures_do_not_escape_or_recreate_drafts(self):
        events = []

        def failing(sender, event):
            events.append(event)
            if event["kind"] in {"end", "close"}:
                raise RuntimeError("observer cleanup failed")

        scope = PreviewExecution("root", failing)
        attempt = scope.begin()
        draft = scope.update(attempt, 0, 0, "draft", "final_answer")
        scope.end([draft])
        scope.close()
        self.assertFalse(scope.enabled)
        self.assertIsNone(scope.update(attempt, 0, 0, "late", "final_answer"))
        self.assertEqual([event["kind"] for event in events], ["start", "update", "end", "close"])
        self.assertEqual(events[2]["execution_id"], scope.execution_id)
        self.assertIsNone(scope.id_for(attempt, 0, 0))

    def test_empty_execution_closes_once_on_normal_and_interrupt_paths(self):
        for interrupt in (False, True):
            with self.subTest(interrupt=interrupt):
                observed = []
                scope = PreviewExecution("root", lambda sender, event: observed.append(event))
                if interrupt:
                    self.assertEqual(scope.interrupt(), [])
                scope.close()
                scope.close()
                self.assertEqual([event["kind"] for event in observed], ["start", "close"])
                self.assertTrue(all(event["execution_id"] == scope.execution_id for event in observed))

    def test_control_flow_escapes_every_observer_boundary(self):
        for error_type in (asyncio.CancelledError, SystemExit, KeyboardInterrupt, GraphBubbleUp, GraphInterrupt):
            for kind in ("start", "update", "end", "close", "interrupt"):
                with self.subTest(error=error_type.__name__, kind=kind):
                    error = error_type()

                    def observer(sender, event):
                        if event["kind"] == kind:
                            raise error

                    with self.assertRaises(error_type) as raised:
                        scope = PreviewExecution("root", observer)
                        attempt = scope.begin()
                        identity = scope.update(attempt, 0, 0, "draft", "final_answer")
                        if kind == "end":
                            scope.end([identity])
                        elif kind == "interrupt":
                            scope.interrupt()
                        else:
                            scope.close()
                    self.assertIs(raised.exception, error)

    def test_model_invocation_preserves_graph_interrupt_from_preview(self):
        error = GraphInterrupt()

        def observer(sender, event):
            if event["kind"] == "update":
                raise error

        scope = PreviewExecution("root", observer)
        token = current_preview.set(scope)
        try:
            with patch.object(CodexSubscriptionModel, "_request",
                              return_value=iter(stream_events([item([human("draft")])]))):
                with self.assertRaises(GraphInterrupt) as raised:
                    CodexSubscriptionModel().invoke("prompt", response_format=FORMAT)
            self.assertIs(raised.exception, error)
        finally:
            scope.close()
            current_preview.reset(token)

    def test_attempt_initialization_failure_does_not_drop_authoritative_output(self):
        events = []
        scope = PreviewExecution("root", lambda sender, event: events.append(event["kind"]))
        output = item([human("full")])
        with patch.object(scope, "begin", side_effect=RuntimeError("attempt init failed")):
            state = _ResponseStream("test", FORMAT, preview=scope)
        (answer,) = [chunk for event in stream_events([output]) for chunk in state.feed(event)]
        self.assertEqual(answer.message.additional_kwargs["wandrun_agent_output"]["messages"],
                         [human("full")])
        self.assertFalse(scope.enabled)
        self.assertEqual(events, ["start", "close"])

    def test_start_failure_disables_preview_but_keeps_full_response(self):
        observed = []

        def failing(sender, event):
            observed.append(event["kind"])
            if event["kind"] == "start":
                raise RuntimeError("start observer failed")

        scope = PreviewExecution("root", failing)
        state = _ResponseStream("test", FORMAT, preview=scope)
        output = item([human("full")])
        (answer,) = [chunk for event in stream_events([output]) for chunk in state.feed(event)]
        self.assertEqual(answer.message.additional_kwargs["wandrun_agent_output"]["messages"],
                         [human("full")])
        self.assertEqual(observed, ["start", "close"])
        self.assertFalse(scope.enabled)


class AsyncAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_response_survives_parser_and_update_failures(self):
        output = item([human("async final")])
        for failure in ("update", "feed"):
            with self.subTest(failure=failure):
                events = []

                def observer(sender, event):
                    events.append(event)
                    if event["kind"] == failure:
                        raise RuntimeError("temporary update failed")

                async def response(self, body):
                    for event in stream_events([output]):
                        yield event

                scope = PreviewExecution("root", observer)
                token = current_preview.set(scope)
                try:
                    with patch.object(CodexSubscriptionModel, "_arequest", response):
                        if failure == "feed":
                            with patch.object(HumanPreviewParser, "feed",
                                              side_effect=RuntimeError("parser failed")):
                                answer = await CodexSubscriptionModel().ainvoke("prompt", response_format=FORMAT)
                        else:
                            answer = await CodexSubscriptionModel().ainvoke("prompt", response_format=FORMAT)
                    self.assertEqual(answer.additional_kwargs["wandrun_agent_output"]["messages"],
                                     [human("async final")])
                    self.assertEqual(answer.additional_kwargs["codex_output_items"], [output])
                    self.assertIsNone(answer.additional_kwargs["wandrun_draft_ids"][0])
                    self.assertFalse(scope.enabled)
                finally:
                    scope.close()
                    current_preview.reset(token)
                self.assertEqual([event["kind"] for event in events].count("close"), 1)



class ExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_interrupt_freezes_published_records_for_model_without_late_revival(self):
        entered = asyncio.Event()
        snapshots = []
        seen = []
        scope_ref = []

        def preview(sender, event):
            snapshots.append((sender, event))
            if event["kind"] == "interrupt":
                return [{"draft_id": event["draft_ids"][0], "seq": 17,
                         "agent": "planner", "text": "published"}]
            return None

        async def run(prompts, task_id):
            seen.append(prompts)
            if len(seen) > 1:
                return AgentOutput(messages=[], next="done")
            scope = current_preview.get()
            scope_ref.append(scope)
            scope.update(scope.begin(), 0, 0, "generated", "final_answer")
            entered.set()
            await asyncio.Event().wait()

        manager = WorkerManager(run, on_preview=preview, on_human=lambda *args: None)
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.interrupt("new", "root")
        # A callback racing cancellation cannot resurrect the old execution.
        scope_ref[0].update(scope_ref[0].begin(), 0, 0, "late", "final_answer")
        await asyncio.wait_for(manager.wait("root"), 2)
        feedback = json.loads(seen[1][0].content.split("\n", 1)[1])
        self.assertEqual(feedback["frozen_previews"][0]["text"], "published")
        self.assertEqual(feedback["frozen_previews"][0]["seq"], 17)
        self.assertIn("不代表用户已阅读", feedback["note"])
        self.assertNotIn("late", [event.get("text") for _, event in snapshots])
        self.assertEqual([event["kind"] for _, event in snapshots].count("start"), 2)
        self.assertEqual([event["kind"] for _, event in snapshots].count("close"), 2)

    async def test_delivery_rejection_settles_only_its_draft_and_preserves_mapping(self):
        events = []
        deliveries = []
        receipts_seen = []

        def preview(sender, event):
            events.append(event)
            return None

        async def run(prompts, task_id):
            state = _ResponseStream("test", FORMAT, preview=current_preview.get())
            chunks = [chunk for event in stream_events([item([human("bad"), human("good")])])
                      for chunk in state.feed(event)]
            metadata = chunks[-1].message.additional_kwargs
            output = AgentOutput.model_validate(metadata["wandrun_agent_output"])
            receipts_seen.extend(manager.dispatch(
                output, task_id, draft_ids=metadata["wandrun_draft_ids"],
            ))
            return output

        manager = WorkerManager(
            run, on_preview=preview,
            validate_human=lambda sender, text, attachments: "rejected" if text == "bad" else None,
            on_human=lambda sender, text, attachments, draft_id: deliveries.append((text, draft_id)),
        )
        self.addAsyncCleanup(manager.close)
        manager.start("start", "root")
        await asyncio.wait_for(manager.wait("root"), 2)
        updated = [event["draft_id"] for event in events if event["kind"] == "update"]
        ended = [identity for event in events if event["kind"] == "end" for identity in event["draft_ids"]]
        self.assertEqual([receipt["accepted"] for receipt in receipts_seen], [False, True])
        self.assertEqual(deliveries, [("good", updated[-1])])
        self.assertEqual(set(ended), set(updated))

    async def test_end_callback_failure_does_not_interrupt_two_formal_deliveries(self):
        events = []
        deliveries = []
        receipts_seen = []
        scopes = []

        def preview(sender, event):
            events.append(event)
            if event["kind"] == "end":
                raise RuntimeError("preview cleanup failed")

        async def run(prompts, task_id):
            scope = current_preview.get()
            scopes.append(scope)
            state = _ResponseStream("test", FORMAT, preview=scope)
            chunks = [chunk for event in stream_events([item([human("first"), human("second")])])
                      for chunk in state.feed(event)]
            metadata = chunks[-1].message.additional_kwargs
            output = AgentOutput.model_validate(metadata["wandrun_agent_output"])
            receipts_seen.extend(manager.dispatch(
                output, task_id, draft_ids=metadata["wandrun_draft_ids"],
            ))
            return output

        manager = WorkerManager(
            run, on_preview=preview,
            on_human=lambda sender, text, attachments, draft_id: deliveries.append((text, draft_id)),
        )
        self.addAsyncCleanup(manager.close)
        manager.start("start", "root")
        result = await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(result["status"], "completed")
        self.assertEqual([receipt["accepted"] for receipt in receipts_seen], [True, True])
        self.assertEqual([text for text, _ in deliveries], ["first", "second"])
        self.assertTrue(all(draft_id is not None for _, draft_id in deliveries))
        self.assertEqual([event["kind"] for event in events].count("start"), 1)
        self.assertEqual([event["kind"] for event in events].count("close"), 1)
        self.assertEqual(events[0]["execution_id"], scopes[0].execution_id)
        self.assertEqual(events[-1]["execution_id"], scopes[0].execution_id)
        attempt = deliveries[0][1].split(":")[1]
        before = len(events)
        self.assertIsNone(scopes[0].update(attempt, 0, 0, "late", "final_answer"))
        self.assertEqual(len(events), before)

    async def test_interrupt_persistence_failure_rejects_new_input_and_cancels_old_task(self):
        entered = asyncio.Event()
        seen = []
        events = []
        scopes = []

        def preview(sender, event):
            events.append(event)
            if event["kind"] == "interrupt":
                raise PreviewPersistenceError("durable append failed")

        async def run(prompts, task_id):
            seen.extend(prompts)
            scope = current_preview.get()
            scopes.append(scope)
            scope.update(scope.begin(), 0, 0, "pending", "final_answer")
            entered.set()
            await asyncio.Event().wait()

        manager = WorkerManager(run, on_preview=preview, on_human=lambda *args: None)
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "root")
        await asyncio.wait_for(entered.wait(), 2)
        with self.assertRaisesRegex(PreviewPersistenceError, "durable append failed"):
            manager.interrupt("new user command", "root")
        self.assertFalse(scopes[0].enabled)
        self.assertIsNone(scopes[0].update(scopes[0].begin(), 0, 0, "late", "final_answer"))
        result = await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual([prompt.content for prompt in seen], ["initial"])
        self.assertFalse(manager._inbox.get("root"))
        self.assertFalse(manager._feedback.get("root"))
        self.assertEqual([event["kind"] for event in events].count("close"), 1)
        self.assertEqual([event["kind"] for event in events].count("interrupt"), 1)

    async def test_ordinary_interrupt_observer_failure_does_not_reject_user_command(self):
        entered = asyncio.Event()
        events = []
        seen = []

        def preview(sender, event):
            events.append(event)
            if event["kind"] == "interrupt":
                raise RuntimeError("temporary freeze observer failed")

        async def run(prompts, task_id):
            seen.append(prompts)
            if len(seen) > 1:
                return AgentOutput(messages=[], next="done")
            scope = current_preview.get()
            scope.update(scope.begin(), 0, 0, "pending", "final_answer")
            entered.set()
            await asyncio.Event().wait()

        manager = WorkerManager(run, on_preview=preview, on_human=lambda *args: None)
        self.addAsyncCleanup(manager.close)
        manager.start("initial", "root")
        await asyncio.wait_for(entered.wait(), 2)
        self.assertTrue(manager.interrupt("new user command", "root")["interrupted"])
        self.assertEqual((await asyncio.wait_for(manager.wait("root"), 2))["status"], "completed")
        self.assertEqual(seen[1][-1].content, "new user command")
        feedback = json.loads(seen[1][0].content.split("\n", 1)[1])
        self.assertEqual(feedback["frozen_previews"], [])
        self.assertEqual([event["kind"] for event in events].count("close"), 2)

    async def test_runtime_notification_ends_preview_without_user_interrupt_record(self):
        entered = asyncio.Event()
        events = []
        seen = []

        async def run(prompts, task_id):
            seen.append(prompts)
            if len(seen) > 1:
                return AgentOutput(messages=[], next="done")
            scope = current_preview.get()
            scope.update(scope.begin(), 0, 0, "unfinished", "final_answer")
            entered.set()
            await asyncio.Event().wait()

        manager = WorkerManager(
            run, on_preview=lambda sender, event: events.append(event),
            on_human=lambda *args: None,
        )
        self.addAsyncCleanup(manager.close)
        manager.start("work", "root")
        await asyncio.wait_for(entered.wait(), 2)
        manager.notify("root", {"notice": "runtime"}, interrupt=True)
        await asyncio.wait_for(manager.wait("root"), 2)
        self.assertIn("end", [event["kind"] for event in events])
        self.assertNotIn("interrupt", [event["kind"] for event in events])
        self.assertFalse(any("frozen_previews" in prompt.content for prompt in seen[1]))

    async def test_member_draft_survives_root_interrupt(self):
        member_started = asyncio.Event()
        release = asyncio.Event()
        active = {}

        def preview(sender, event):
            if event["kind"] == "update":
                active[event["draft_id"]] = sender
            elif event["kind"] in {"end", "interrupt"}:
                for identity in event["draft_ids"]:
                    active.pop(identity, None)
            return []

        async def run(prompts, task_id):
            if task_id == "member":
                scope = current_preview.get()
                scope.update(scope.begin(), 0, 0, "member text", "commentary")
                member_started.set()
                await release.wait()
                return AgentOutput(messages=[], next="done")
            if prompts[0].content == "start":
                await asyncio.Event().wait()
            return AgentOutput(messages=[], next="done")

        manager = WorkerManager(run, on_preview=preview, on_human=lambda *args: None)
        self.addAsyncCleanup(manager.close)
        self.addCleanup(release.set)
        manager.start("start", "root")
        manager.start("member work", "member", sender_id="root")
        await asyncio.wait_for(member_started.wait(), 2)
        manager.interrupt("new", "root")
        self.assertEqual(list(active.values()), ["member"])
        release.set()
        await asyncio.wait_for(manager.wait("member"), 2)
        await asyncio.wait_for(manager.wait("root"), 2)
        self.assertEqual(active, {})
