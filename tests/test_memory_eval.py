import asyncio
import json
import unittest
from urllib.parse import parse_qs

import httpx

from test_gateway import gateway_manager, open_store, temp_dir
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway as GatewayService
from wandrun.runtime.messages import AgentOutput, SendMessage

from wandrun.evaluation.gateway_replay import RunCaseError
from wandrun.evaluation.memory_eval import MemoryReplay


class Gateway:
    def __init__(self):
        self.seq = 0
        self.histories = {}
        self.tasks = {}
        self.messages = []
        self.stopped = []
        self.pending = {}
        self.delegate = {}
        self.never_finish = False
        self.fail = False
        self.send_error = False
        self.flood = False
        self.polled = asyncio.Event()

    def event(self, kind, data):
        self.seq += 1
        return {"seq": self.seq, "type": kind, "data": data}

    def add_child(self, root, agent):
        identity = f"task-{len(self.tasks) + 1}"
        self.tasks[identity] = {
            "task_id": identity, "root_id": root, "creator_task_id": root,
            "creator_agent_id": self.histories[root][0]["data"]["agent_id"],
            "agent_id": agent, "status": "waiting",
        }
        self.histories[identity] = []
        self.histories[root].append(self.event("task.created", {
            "task_id": identity, "creator_task_id": root, "agent_id": agent,
        }))
        return identity

    def __call__(self, request):
        path = request.url.path.strip("/").split("/")
        body = json.loads(request.content) if request.method == "POST" else None
        if path == ["conversations"] and request.method == "POST":
            root = f"root-{sum(key.startswith('root-') for key in self.histories) + 1}"
            self.histories[root] = [self.event("conversation.created", {"agent_id": body["agent_id"]})]
            return httpx.Response(201, json={"id": root})
        if path[0] == "tasks" and len(path) == 2:
            return httpx.Response(200, json=self.tasks[path[1]])
        identity, action = path[1:]
        if action == "messages":
            self.messages.append((path[0], identity, body))
            if self.send_error:
                return httpx.Response(503, json={"error": "unavailable"})
            data = {"text": body["text"]}
            if path[0] == "tasks":
                data["task_id"] = identity
            accepted = self.event("message.user", data)
            self.histories[identity].append(accepted)
            self.pending[identity] = (accepted["seq"], identity if path[0] == "tasks" else None, body["text"])
            return httpx.Response(202, json={"event": accepted})
        if action == "events":
            root = identity
            self.polled.set()
            pending = self.pending.get(root)
            if pending and not self.never_finish:
                self.pending.pop(root)
                _, task, text = pending
                if self.flood:
                    self.histories[root].extend(self.event("notice", {"index": i}) for i in range(205))
                if task:
                    self.histories[root].append(self.event("message.agent", {
                        "task_id": task, "status": "completed", "text": "member response",
                    }))
                    self.histories[root].append(self.event("task.status", {
                        "task_id": task, "status": "waiting",
                    }))
                else:
                    if text in self.delegate:
                        self.add_child(root, self.delegate[text])
                    elif not self.fail:
                        self.histories[root].append(self.event("message.agent", {
                            "status": "completed", "text": f"reply: {text}",
                        }))
                    if self.fail:
                        self.histories[root].append(self.event("turn.failed", {"error": "actual failure"}))
                    self.histories[root].append(self.event("conversation.status", {
                        "status": "failed" if self.fail else "idle",
                    }))
            params = parse_qs(request.url.query.decode())
            before = int(params.get("before", [str(2**63)])[0])
            limit = int(params.get("limit", ["200"])[0])
            events = [e for e in self.histories[root] if e["seq"] < before][-limit:]
            return httpx.Response(200, json={"events": events, "as_of_seq": self.seq})
        if action == "stop":
            self.stopped.append(identity)
            return httpx.Response(202, json={"event": self.event("turn.stopped", {})})
        raise AssertionError(request.url)


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_session_turns_and_fresh_root_remain_open_until_finish(self):
        gateway = Gateway()
        gateway.flood = True
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway), base_url="http://gateway") as client:
            replay = MemoryReplay(client, timeout=1)
            root = await replay.create("E", "history")
            first = await replay.turn(root, "preference")
            second = await replay.turn(root, "correction")
            query_root = await replay.create("M", "query")
            query = await replay.turn(query_root, "question")
            self.assertEqual(gateway.stopped, [])
            self.assertEqual([m[1] for m in gateway.messages], [root, root, query_root])
            self.assertEqual([m[2]["text"] for m in gateway.messages], ["preference", "correction", "question"])
            self.assertTrue(all(set(m[2]) == {"client_id", "text"} for m in gateway.messages))
            self.assertEqual([r["outputs"] for r in (first, second, query)],
                             [["reply: preference"], ["reply: correction"], ["reply: question"]])
            self.assertEqual((second["root_id"], second["task_id"], second["agent_id"]), (root, root, "E"))
            self.assertTrue(all(e["seq"] > second["submitted_seq"] for e in second["events"]))
            self.assertEqual(len(query["events"]), 207)
            self.assertEqual(query["events"][-1]["data"]["status"], "idle")
            await replay.finish()
            await replay.finish()
            self.assertEqual(gateway.stopped, [root, query_root])

    async def test_child_transport_excludes_old_tasks_and_stays_open(self):
        for parent, member in (("E", "M"), ("M", "E")):
            with self.subTest(parent=parent, member=member):
                gateway = Gateway()
                gateway.delegate["delegate"] = member
                async with httpx.AsyncClient(transport=httpx.MockTransport(gateway), base_url="http://gateway") as client:
                    replay = MemoryReplay(client, timeout=1)
                    root = await replay.create(parent, "collaboration")
                    await replay.turn(root, "first")
                    old = gateway.add_child(root, member)
                    delegated = await replay.turn(root, "delegate")
                    self.assertEqual(delegated["outputs"], [])
                    task = await replay.child(root, member)
                    self.assertNotEqual(task["task_id"], old)
                    self.assertEqual((task["root_id"], task["creator_task_id"], task["agent_id"]),
                                     (root, root, member))
                    feedback = await replay.turn(root, "only to member", task_id=task["task_id"])
                    self.assertEqual(feedback["terminal_status"], "waiting")
                    self.assertEqual(feedback["outputs"], ["member response"])
                    self.assertTrue(all(e["seq"] > feedback["submitted_seq"] for e in feedback["events"]))
                    self.assertEqual((feedback["root_id"], feedback["task_id"], feedback["agent_id"]),
                                     (root, task["task_id"], member))
                    self.assertEqual(gateway.messages[-1][:2], ("tasks", task["task_id"]))
                    self.assertEqual(set(gateway.messages[-1][2]), {"client_id", "text"})
                    self.assertEqual(gateway.stopped, [])
                    await replay.finish()
                    self.assertEqual(gateway.stopped, [root])

    async def test_no_synthetic_child_and_preflight_lengths(self):
        gateway = Gateway()
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway), base_url="http://gateway") as client:
            replay = MemoryReplay(client, timeout=0.01)
            with self.assertRaises(ValueError):
                await replay.create("E", "x" * 201)
            root = await replay.create("E", "test")
            with self.assertRaises(ValueError):
                await replay.turn(root, "x" * 20_001)
            self.assertEqual(gateway.messages, [])
            await replay.turn(root, "ordinary")
            with self.assertRaises(ValueError):
                await replay.turn(root, "interject", task_id="invented")
            with self.assertRaises(RunCaseError) as caught:
                await replay.child(root, "M")
            self.assertEqual(caught.exception.kind, "timeout")
            self.assertEqual(gateway.stopped, [root])

    async def test_failed_turn_captures_raw_error_and_stops(self):
        gateway = Gateway()
        gateway.fail = True
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway), base_url="http://gateway") as client:
            replay = MemoryReplay(client, timeout=1)
            root = await replay.create("E", "failure")
            with self.assertRaises(RunCaseError) as caught:
                await replay.turn(root, "fail")
            self.assertEqual(caught.exception.kind, "agent_failed")
            record = caught.exception.result
            self.assertEqual((record["root_id"], record["terminal_status"]), (root, "failed"))
            self.assertEqual(record["events"][-2]["data"]["error"], "actual failure")
            self.assertEqual(gateway.stopped, [root])

    async def test_http_error_keeps_accepted_context_without_retry(self):
        gateway = Gateway()
        gateway.send_error = True
        async with httpx.AsyncClient(transport=httpx.MockTransport(gateway), base_url="http://gateway") as client:
            replay = MemoryReplay(client, timeout=1)
            root = await replay.create("E", "request error")
            with self.assertRaises(RunCaseError) as caught:
                await replay.turn(root, "message")
            self.assertEqual(caught.exception.kind, "http_error")
            self.assertIsInstance(caught.exception.__cause__, httpx.HTTPStatusError)
            self.assertEqual(caught.exception.result["conversation_id"], root)
            self.assertIsNone(caught.exception.result["submitted_seq"])
            self.assertEqual(len(gateway.messages), 1)
            self.assertEqual(gateway.stopped, [root])

    async def test_timeout_and_cancellation_stop_owned_roots(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                gateway = Gateway()
                gateway.never_finish = True
                async with httpx.AsyncClient(transport=httpx.MockTransport(gateway), base_url="http://gateway") as client:
                    replay = MemoryReplay(client, timeout=0.02 if not cancel else 1)
                    first = await replay.create("E", "first")
                    second = await replay.create("M", "second")
                    if cancel:
                        work = asyncio.create_task(replay.turn(first, "pending"))
                        await gateway.polled.wait()
                        work.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await work
                    else:
                        with self.assertRaises(RunCaseError) as caught:
                            await replay.turn(first, "pending")
                        self.assertEqual(caught.exception.kind, "timeout")
                        self.assertEqual(caught.exception.result["text"], "pending")
                        self.assertEqual(caught.exception.result["events"], [])
                    self.assertEqual(gateway.stopped, [first, second])


class GatewayReplayIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = open_store(self, temp_dir(self) / "gateway.sqlite")
        self.gateway = GatewayService(self.store)
        self.addCleanup(self.gateway.end_streams)
        self.member_calls = 0

        async def run(prompts, task_id):
            if self.manager.agent_name(task_id) == "c":
                self.manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="a", task_id=None, message="member assignment"),
                ], next="wait"), task_id)
            else:
                self.member_calls += 1
                if self.member_calls == 2:
                    self.gateway.on_human(task_id, "member reply\ncomplete second line", [])
                    root = self.manager.root_of(task_id)
                    for index in range(205):
                        self.store.append(root, "notice", {"index": index, "timeline_ids": [task_id]})
            return AgentOutput(messages=[], next="wait")

        self.manager = gateway_manager(self.gateway, run)
        self.addAsyncCleanup(self.manager.close)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, token="offline")),
            base_url="http://gateway", headers={"Authorization": "Bearer offline"},
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_member_body_uses_real_task_timeline_across_pages(self):
        replay = MemoryReplay(self.client, timeout=3)
        self.addAsyncCleanup(replay.finish)
        root = await replay.create("c", "collaboration")
        await replay.turn(root, "delegate")
        task = await replay.child(root, "a")
        result = await replay.turn(root, "member feedback", task_id=task["task_id"])
        self.assertEqual(result["outputs"], ["member reply\ncomplete second line"])
        self.assertEqual(result["terminal_status"], "waiting")
        self.assertGreater(len(result["events"]), 200)
        root_events = self.store.history(root, limit=200)
        self.assertFalse(any(event.type == "message.agent" for event in root_events))
        preview = next(event for event in root_events if event.type == "message.task_preview")
        self.assertEqual(preview.data["text"], "member reply")
        member_messages = [event for event in self.store.task_history(task["task_id"], limit=300)
                           if event.type == "message.agent"]
        self.assertEqual(member_messages[0].data["text"], result["outputs"][0])

    async def test_self_delegation_preflight_marks_uncovered_without_starting_work(self):
        replay = MemoryReplay(self.client, timeout=1)
        with self.assertRaises(RunCaseError) as caught:
            await replay.create("a", "C04", required_workers=("a",))
        self.assertEqual(caught.exception.kind, "unsupported_scenario")
        self.assertEqual(caught.exception.result["status"], "uncovered")
        self.assertEqual(caught.exception.result["missing_workers"], ["a"])
        self.assertIsNone(caught.exception.result["conversation_id"])
        self.assertEqual(self.store.conversations(), [])
        self.assertEqual(self.member_calls, 0)
        await replay.finish()

    async def test_supported_delegation_preflight_allows_root_creation(self):
        replay = MemoryReplay(self.client, timeout=1)
        self.addAsyncCleanup(replay.finish)
        root = await replay.create("c", "C03", required_workers=("a",))
        self.assertEqual(self.store.conversation(root)["agent_id"], "c")
        self.assertEqual(self.member_calls, 0)


class ReplayCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_later_cancel_wins_over_earlier_stop_error_and_cleanup_continues(self):
        for during_turn in (False, True):
            with self.subTest(during_turn=during_turn):
                gateway = Gateway()
                entered = asyncio.Event()
                attempted = []
                interrupt = True
                roots = []

                async def handle(request):
                    if request.url.path.endswith("/stop"):
                        identity = request.url.path.split("/")[2]
                        attempted.append(identity)
                        if interrupt and identity == roots[0]:
                            return httpx.Response(503, json={"error": "stop failed"})
                        if interrupt and identity == roots[1]:
                            entered.set()
                            await asyncio.Event().wait()
                    return gateway(request)

                async with httpx.AsyncClient(
                    transport=httpx.MockTransport(handle), base_url="http://gateway",
                ) as client:
                    replay = MemoryReplay(client, timeout=1)
                    for title in ("first", "second", "third"):
                        roots.append(await replay.create("E", title))
                    gateway.send_error = during_turn
                    operation = replay.turn(roots[0], "fail") if during_turn else replay.finish()
                    work = asyncio.create_task(operation)
                    await asyncio.wait_for(entered.wait(), timeout=2)
                    work.cancel()
                    with self.assertRaises(asyncio.CancelledError) as caught:
                        await work
                    self.assertEqual(attempted, roots)
                    self.assertEqual(gateway.stopped, [roots[2]])
                    self.assertTrue(any("503" in note for note in caught.exception.__notes__))
                    interrupt = False
                    await replay.finish()
                    self.assertEqual(attempted, [*roots, roots[0], roots[1]])
                    self.assertEqual(gateway.stopped, [roots[2], roots[0], roots[1]])
