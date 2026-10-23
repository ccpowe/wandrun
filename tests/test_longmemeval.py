import json
import unittest
from urllib.parse import parse_qs

import httpx

from wandrun.evaluation.gateway_replay import MAX_MESSAGE_CHARS, RunCaseError
from wandrun.evaluation.longmemeval import history_prompt, query_prompt, run_case


def sample_case():
    return {
        "question_id": "q-1", "question_type": "multi-session", "question": "Which city?",
        "answer": "secret reference", "question_date": "2023/05/23 (Tue) 08:00",
        "haystack_sessions": [
            [{"role": "user", "content": "Newer user"}, {"role": "assistant", "content": "Newer assistant"}],
            [{"role": "user", "content": "Older user"}, {"role": "assistant", "content": "Older assistant"}],
        ],
        "haystack_dates": ["2023/05/22 (Mon) 17:00", "2023/05/20 (Sat) 05:15"],
        "haystack_session_ids": ["session-new", "session-old"],
        "answer_session_ids": ["session-old"],
    }


class GatewayFixture:
    def __init__(self):
        self.sent = []
        self.stopped = []
        self.histories = {}
        self.polls = {}
        self.next_seq = 0
        self.flood = False
        self.stale_first = False
        self.never_finishes = False
        self.fail_status = False
        self.send_error = False

    def event(self, kind, data):
        self.next_seq += 1
        return {"seq": self.next_seq, "type": kind, "data": data}

    def __call__(self, request):
        parts = request.url.path.strip("/").split("/")
        body = json.loads(request.content) if request.method == "POST" else None
        if parts == ["conversations"] and request.method == "POST":
            identity = f"conversation-{len(self.histories) + 1}"
            self.histories[identity] = [self.event("conversation.created", {})]
            self.polls[identity] = 0
            return httpx.Response(201, json={"id": identity})
        identity = parts[1]
        if parts[-1] == "messages":
            if self.send_error:
                return httpx.Response(503, json={"error": "unavailable"})
            self.sent.append((identity, body))
            history = self.histories[identity]
            # A previous terminal event is never proof that this newly accepted turn finished.
            if self.stale_first:
                history.append(self.event("conversation.status", {"status": "idle"}))
            sent = self.event("message.user", {"text": body["text"]})
            history.append(sent)
            return httpx.Response(202, json={"event": sent})
        if parts[-1] == "events":
            self.polls[identity] += 1
            history = self.histories[identity]
            if not self.never_finishes and (not self.stale_first or self.polls[identity] > 1):
                if not any(event["type"] == "conversation.status" and event["seq"] > next(
                    e["seq"] for e in history if e["type"] == "message.user"
                ) for event in history):
                    if self.flood:
                        history.extend(self.event("notice", {"index": i}) for i in range(205))
                    if self.fail_status:
                        history.append(self.event("turn.failed", {"error": "real agent error"}))
                    else:
                        history.append(self.event("message.agent", {"status": "completed", "text": "received"}))
                    history.append(self.event("conversation.status", {"status": "failed" if self.fail_status else "idle"}))
            params = parse_qs(request.url.query.decode())
            before = int(params["before"][0]) if "before" in params else 2**63
            limit = int(params.get("limit", ["200"])[0])
            page = [e for e in history if e["seq"] < before][-limit:]
            return httpx.Response(200, json={"events": page, "as_of_seq": self.next_seq})
        if parts[-1] == "stop":
            self.stopped.append(identity)
            return httpx.Response(202, json={"event": self.event("turn.stopped", {})})
        raise AssertionError(request.url)


class PromptTests(unittest.TestCase):
    def test_preserves_raw_turns_and_boundaries_without_answer_or_question(self):
        case = sample_case()
        case["haystack_sessions"][1][0]["has_answer"] = True
        prompt = history_prompt(case, 1)
        self.assertIn("2023/05/20 (Sat) 05:15", prompt)
        self.assertIn("[session-old/turn-0001] " + json.dumps({
            "role": "user", "content": "Older user",
        }), prompt)
        self.assertNotIn("has_answer", prompt)
        self.assertIn("[session-old/turn-0002] " + json.dumps(case["haystack_sessions"][1][1]), prompt)
        self.assertNotIn("secret reference", prompt)
        self.assertNotIn("Which city?", prompt)

    def test_oversize_fails_without_truncation(self):
        case = sample_case()
        case["haystack_sessions"][0][0]["content"] = "x" * MAX_MESSAGE_CHARS
        with self.assertRaisesRegex(ValueError, "exceeds"):
            history_prompt(case, 0)


class DriverTests(unittest.IsolatedAsyncioTestCase):
    async def run_fixture(self, fixture, case=None, timeout=1):
        async with httpx.AsyncClient(transport=httpx.MockTransport(fixture), base_url="http://gateway") as client:
            return await run_case(client, case or sample_case(), agent_id="memory", timeout=timeout)

    async def test_chronological_sessions_roles_and_fresh_query(self):
        fixture = GatewayFixture()
        result = await self.run_fixture(fixture)
        self.assertEqual([record["session_id"] for record in result["ingestion"]], ["session-old", "session-new"])
        self.assertEqual(result["ingestion"][0]["turn_ids"], ["session-old/turn-0001", "session-old/turn-0002"])
        self.assertEqual([identity for identity, _ in fixture.sent], ["conversation-1", "conversation-2", "conversation-3"])
        self.assertEqual(fixture.stopped, ["conversation-1", "conversation-2", "conversation-3"])
        self.assertIn('"role": "assistant", "content": "Older assistant"', fixture.sent[0][1]["text"])
        self.assertEqual(fixture.sent[-1][1]["text"], query_prompt(sample_case()))
        self.assertNotIn("secret reference", str(fixture.sent))
        self.assertTrue(result["query_is_new"])
        self.assertNotIn(result["query_id"], result["ingestion_ids"])
        self.assertEqual(result["answer"], "received")
        self.assertEqual(result["query"]["events"][-1]["data"]["status"], "idle")
        self.assertEqual(result["status"], "completed")

    async def test_paginated_events_are_complete_before_terminal_decision(self):
        fixture = GatewayFixture()
        fixture.flood = True
        result = await self.run_fixture(fixture)
        self.assertEqual(len(result["query"]["events"]), 207)
        self.assertEqual(result["query"]["events"][0]["data"]["index"], 0)
        self.assertEqual(result["query"]["events"][-1]["data"]["status"], "idle")

    async def test_old_idle_is_not_new_turn_terminal(self):
        fixture = GatewayFixture()
        fixture.stale_first = True
        result = await self.run_fixture(fixture)
        self.assertTrue(all(count > 1 for count in fixture.polls.values()))
        self.assertEqual(result["answer"], "received")
        self.assertEqual(len(result["query"]["events"]), 2)

    async def test_timeout_stops_active_conversation_and_exposes_partial_evidence(self):
        fixture = GatewayFixture()
        fixture.never_finishes = True
        with self.assertRaises(RunCaseError) as caught:
            await self.run_fixture(fixture, timeout=0.01)
        self.assertEqual(caught.exception.kind, "timeout")
        self.assertIsInstance(caught.exception.__cause__, TimeoutError)
        self.assertEqual(caught.exception.result["ingestion_ids"], ["conversation-1"])
        self.assertEqual(fixture.stopped, ["conversation-1"])
        self.assertEqual(caught.exception.result["status"], "failed")
        self.assertEqual(caught.exception.result["ingestion"][0]["events"], [])

    async def test_gateway_error_stops_active_and_preserves_original(self):
        fixture = GatewayFixture()
        fixture.send_error = True
        with self.assertRaises(RunCaseError) as caught:
            await self.run_fixture(fixture)
        self.assertEqual(caught.exception.kind, "http_error")
        self.assertIsInstance(caught.exception.__cause__, httpx.HTTPStatusError)
        self.assertEqual(fixture.stopped, ["conversation-1"])

    async def test_agent_failure_is_not_counted_as_answer(self):
        fixture = GatewayFixture()
        fixture.fail_status = True
        with self.assertRaises(RunCaseError) as caught:
            await self.run_fixture(fixture)
        self.assertEqual(caught.exception.kind, "agent_failed")
        self.assertEqual(caught.exception.result["ingestion"][0]["terminal_status"], "failed")
        self.assertEqual(fixture.stopped, ["conversation-1"])

    async def test_oversize_preflight_creates_nothing(self):
        fixture = GatewayFixture()
        case = sample_case()
        case["haystack_sessions"][1][0]["content"] = "x" * MAX_MESSAGE_CHARS
        with self.assertRaises(ValueError):
            await self.run_fixture(fixture, case)
        self.assertEqual(fixture.histories, {})
