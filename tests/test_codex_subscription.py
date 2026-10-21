"""缓存路由与用量统计的离线协议验证，不读取真实凭据。"""

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from langchain_core.messages import (
    HumanMessage,
    ToolMessage,
    messages_from_dict,
    messages_to_dict,
)
from pydantic import ValidationError

from wandrun.integrations.codex_subscription import (
    TOOL_SEARCH,
    CodexSubscriptionHTTPError,
    CodexSubscriptionModel,
    CodexSubscriptionStreamError,
    ModelRequestBudget,
    is_retryable_model_error,
    tool_search_namespace,
)
from wandrun.metrics import RunMetrics
from codex_test_home import isolate_codex_home



class CodexSubscriptionTests(unittest.TestCase):
    def setUp(self):
        isolate_codex_home(self)
        self.requests = []
        self.output = [
            {
                "type": "reasoning",
                "id": "rs_test",
                "summary": [],
                "encrypted_content": "opaque-reasoning",
            },
            {
                "type": "message",
                "id": "msg_test",
                "role": "assistant",
                "phase": "final_answer",
                "content": [{"type": "output_text", "text": "OK"}],
            },
        ]
        self.response = {
            "status": "completed",
            "output": self.output,
            "usage": {
                "input_tokens": 2000,
                "output_tokens": 30,
                "total_tokens": 2030,
                "input_tokens_details": {
                    "cached_tokens": 1536,
                    "cache_write_tokens": 256,
                },
                "output_tokens_details": {"reasoning_tokens": 20},
            },
        }
        claims = base64.urlsafe_b64encode(b"{}").decode().rstrip("=")
        auth = {
            "auth_mode": "chatgpt",
            "tokens": {
                "access_token": f"test.{claims}.test",
                "account_id": "test-account",
            },
        }
        self.auth_patch = patch(
            "wandrun.integrations.codex_credentials.Path.read_bytes", return_value=json.dumps(auth).encode()
        )
        self.http_patch = patch(
            "wandrun.integrations.codex_subscription.urlopen", side_effect=self.respond
        )
        self.auth_patch.start()
        self.http_patch.start()
        self.addCleanup(self.auth_patch.stop)
        self.addCleanup(self.http_patch.stop)

    def respond(self, request, **kwargs):
        self.requests.append((json.loads(request.data), dict(request.header_items())))
        event = {"type": "response.completed", "response": self.response}
        return io.BytesIO(b"data: " + json.dumps(event).encode() + b"\n\n")

    def test_usage_and_stable_key_survive_history_roundtrip(self):
        model = CodexSubscriptionModel(prompt_cache_key="thread-123")
        history = [HumanMessage(content="hello")]
        answer = model.invoke(history)
        self.assertEqual(answer.response_metadata["usage"], self.response["usage"])
        self.assertEqual(
            answer.usage_metadata,
            {
                "input_tokens": 2000,
                "output_tokens": 30,
                "total_tokens": 2030,
                "input_token_details": {"cache_read": 1536, "cache_creation": 256},
                "output_token_details": {"reasoning": 20},
            },
        )
        restored = messages_from_dict(
            json.loads(json.dumps(messages_to_dict([answer])))
        )[0]
        self.assertEqual(restored.usage_metadata, answer.usage_metadata)
        model.invoke(history + [restored, HumanMessage(content="continue")])
        for body, headers in self.requests:
            self.assertEqual(body["prompt_cache_key"], "thread-123")
            self.assertEqual(headers["Session-id"], "thread-123")
        replay = self.requests[1][0]["input"][1:3]
        self.assertEqual(
            replay,
            [{k: v for k, v in item.items() if k != "id"} for item in self.output],
        )
        self.assertEqual(model.request_summaries[-1]["prompt_cache_key"], "thread-123")

    def test_bound_sessions_do_not_change_shared_model(self):
        model = CodexSubscriptionModel(prompt_cache_key="default")
        first = model.bind(prompt_cache_key="thread-a")
        second = model.bind(prompt_cache_key="thread-b")
        for target in (first, second, first, model):
            target.invoke("hello")
        model.invoke("hello", prompt_cache_key=None)
        self.assertEqual(
            [body.get("prompt_cache_key") for body, _ in self.requests],
            ["thread-a", "thread-b", "thread-a", "default", None],
        )
        self.assertNotIn("Session-id", self.requests[-1][1])
        self.assertEqual(model.prompt_cache_key, "default")

    def test_reasoning_effort_and_request_limit_are_explicit(self):
        model = CodexSubscriptionModel(
            reasoning_effort="medium", request_budget=ModelRequestBudget(1)
        )
        with tempfile.TemporaryDirectory() as directory:
            metrics = RunMetrics(Path(directory))
            with metrics.agent_scope("task", "planner"):
                model.invoke("hello")
                with self.assertRaises(RuntimeError):
                    model.invoke("again")
            self.assertEqual(metrics.summary()["model_request_count"], 1)
        self.assertEqual(self.requests[0][0]["reasoning"], {"effort": "medium"})
        self.assertEqual(model.request_summaries[0]["reasoning_effort"], "medium")

    def test_reasoning_effort_accepts_new_nonempty_strings_and_none_omits(self):
        self.assertEqual(
            CodexSubscriptionModel(reasoning_effort="future-level")
            ._build_request([HumanMessage(content="work")])["reasoning"],
            {"effort": "future-level"},
        )
        self.assertNotIn(
            "reasoning", CodexSubscriptionModel()
            ._build_request([HumanMessage(content="work")]),
        )
        with self.assertRaises(ValidationError):
            CodexSubscriptionModel(reasoning_effort="")

    def test_distinct_models_share_one_request_budget(self):
        budget = ModelRequestBudget(2)
        planner = CodexSubscriptionModel(model_name="planner-test", request_budget=budget)
        executor = CodexSubscriptionModel(model_name="executor-test", request_budget=budget)
        planner.invoke("first")
        executor.invoke("second")
        for model in (planner, executor):
            with self.subTest(model=model.model_name), self.assertRaises(RuntimeError):
                model.invoke("over limit")
        self.assertEqual(
            [body["model"] for body, _ in self.requests],
            ["planner-test", "executor-test"],
        )

    def test_missing_usage_is_not_reported_as_zero(self):
        self.response.pop("usage")
        answer = CodexSubscriptionModel().invoke("hello")
        self.assertIsNone(answer.usage_metadata)
        self.assertIsNone(answer.response_metadata["usage"])
        self.assertNotIn("prompt_cache_key", self.requests[0][0])
        self.assertNotIn("Session-id", self.requests[0][1])

    def test_zero_cache_read_and_missing_details(self):
        self.response["usage"]["input_tokens_details"] = {"cached_tokens": 0}
        self.response["usage"].pop("output_tokens_details")
        answer = CodexSubscriptionModel().invoke("hello")
        self.assertEqual(
            answer.usage_metadata["input_token_details"], {"cache_read": 0}
        )
        self.assertEqual(answer.usage_metadata["output_token_details"], {})

    def test_invalid_key_rejected_before_http(self):
        for value in ("", "x" * 65, "thread\nheader", "线程", 123):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    CodexSubscriptionModel(prompt_cache_key=value)
                with self.assertRaises(ValidationError):
                    CodexSubscriptionModel().invoke("hello", prompt_cache_key=value)
        self.assertEqual(self.requests, [])

    def test_retry_classification_is_limited_to_transient_failures(self):
        import httpx

        for error in (
            httpx.ConnectTimeout("timeout"),
            httpx.RemoteProtocolError("disconnected"),
            CodexSubscriptionStreamError("incomplete"),
            CodexSubscriptionHTTPError(408, "timeout"),
            CodexSubscriptionHTTPError(429, "limited"),
            CodexSubscriptionHTTPError(503, "unavailable"),
        ):
            with self.subTest(error=error):
                self.assertTrue(is_retryable_model_error(error))
        for error in (
            CodexSubscriptionHTTPError(400, "bad request"),
            CodexSubscriptionHTTPError(401, "unauthorized"),
            ValueError("programming error"),
        ):
            with self.subTest(error=error):
                self.assertFalse(is_retryable_model_error(error))


def sse(*events):
    return b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in events)


def text_events(output, response):
    return [
        {"type": "response.output_item.done", "output_index": 0, "item": output[0]},
        {
            "type": "response.output_item.added",
            "output_index": 1,
            "item": {**output[1], "content": []},
        },
        {
            "type": "response.output_text.delta",
            "output_index": 1,
            "content_index": 0,
            "delta": "O",
        },
        {
            "type": "response.output_text.delta",
            "output_index": 1,
            "content_index": 0,
            "delta": "K",
        },
        {"type": "response.output_item.done", "output_index": 1, "item": output[1]},
        {"type": "response.completed", "response": response},
    ]


class StreamingTests(unittest.TestCase):
    setUp = CodexSubscriptionTests.setUp
    respond = CodexSubscriptionTests.respond

    def events(self, events):
        self.wire = io.BytesIO(sse(*events))
        self.http_patch.stop()
        self.stream_patch = patch(
            "wandrun.integrations.codex_subscription.urlopen", return_value=self.wire
        )
        self.stream_patch.start()
        self.addCleanup(self.stream_patch.stop)

    def test_incremental_output_before_completed_and_replay(self):
        from langchain_core.messages import message_chunk_to_message

        self.events(text_events(self.output, self.response))
        stream = CodexSubscriptionModel().stream("hello")
        first = next(stream)
        self.assertEqual(first.content, "O")
        self.assertNotIn("codex_output_items", first.additional_kwargs)
        self.assertLess(self.wire.tell(), len(self.wire.getvalue()))
        chunks = [first, *stream]
        self.assertEqual([c.content for c in chunks], ["O", "K", ""])
        self.assertTrue(self.wire.closed)
        combined = message_chunk_to_message(sum(chunks[1:], chunks[0]))
        self.assertEqual(combined.content, "OK")
        self.assertEqual(combined.additional_kwargs["codex_output_items"], self.output)
        self.assertEqual(combined.usage_metadata["input_tokens"], 2000)
        self.stream_patch.stop()
        self.http_patch.start()
        CodexSubscriptionModel().invoke(
            [HumanMessage(content="hello"), combined, HumanMessage(content="continue")]
        )
        self.assertEqual(
            self.requests[-1][0]["input"][1]["encrypted_content"], "opaque-reasoning"
        )

    def test_parallel_tool_argument_deltas_merge_once(self):
        tools = [
            {
                "type": "function_call",
                "id": f"fc_{i}",
                "call_id": f"call_{i}",
                "name": "lookup",
                "arguments": json.dumps({"x": i}),
            }
            for i in range(2)
        ]
        events = [
            {
                "type": "response.output_item.added",
                "output_index": i,
                "item": {**item, "arguments": ""},
            }
            for i, item in enumerate(tools)
        ]
        for fragment in ('{"x": ', None):
            for i in range(2):
                events.append(
                    {
                        "type": "response.function_call_arguments.delta",
                        "output_index": i,
                        "delta": fragment if fragment is not None else f"{i}}}",
                    }
                )
        events.extend(
            {"type": "response.output_item.done", "output_index": i, "item": item}
            for i, item in enumerate(tools)
        )
        events.append(
            {
                "type": "response.completed",
                "response": {**self.response, "output": tools},
            }
        )
        self.events(events)
        answer = CodexSubscriptionModel().invoke("look up")
        self.assertEqual(
            [(t["id"], t["args"]) for t in answer.tool_calls],
            [("call_0", {"x": 0}), ("call_1", {"x": 1})],
        )
        self.assertEqual(answer.invalid_tool_calls, [])

    def item_events(self, item, added=None):
        """单个输出项：added 时为起始形态，done 与 completed 时为完整形态（completed 不带 output）。"""
        self.events(
            [
                {"type": "response.output_item.added", "output_index": 0, "item": added or item},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {**self.response, "output": []}},
            ]
        )

    def test_client_tool_search_roundtrip(self):
        declaration = {
            "type": "tool_search",
            "execution": "client",
            "description": "Find tools.",
            "parameters": {
                "type": "object",
                "properties": {"goal": {"type": "string"}},
                "required": ["goal"],
            },
        }
        call = {
            "type": "tool_search_call",
            "id": "ts_1",
            "execution": "client",
            "call_id": "call_search",
            "status": "completed",
            "arguments": {"goal": "天气"},
        }
        self.item_events(call, added={**call, "status": "in_progress", "arguments": {}})
        model = CodexSubscriptionModel().bind_tools([declaration])
        answer = model.invoke("weather?")
        self.assertEqual(
            answer.tool_calls,
            [{"name": TOOL_SEARCH, "args": {"goal": "天气"}, "id": "call_search", "type": "tool_call"}],
        )

        def get_weather(city: str) -> str:
            """Get current weather for a city."""

        loaded = [tool_search_namespace("weather", "Weather tools.", [get_weather])]
        self.assertEqual(loaded[0]["tools"][0]["name"], "get_weather")
        self.assertTrue(loaded[0]["tools"][0]["defer_loading"])
        self.stream_patch.stop()
        self.http_patch.start()
        history = [
            HumanMessage(content="weather?"),
            answer,
            ToolMessage(content="loaded", tool_call_id="call_search", artifact=loaded),
        ]
        model.invoke(messages_from_dict(messages_to_dict(history)))
        body = self.requests[-1][0]
        self.assertEqual(body["tools"], [declaration])
        self.assertEqual(
            [item.get("type", item.get("role")) for item in body["input"]],
            ["user", "tool_search_call", "tool_search_output"],
        )
        self.assertNotIn("id", body["input"][1])
        self.assertEqual(
            body["input"][2],
            {
                "type": "tool_search_output",
                "execution": "client",
                "call_id": "call_search",
                "status": "completed",
                "tools": loaded,
            },
        )
        # 没有 artifact 表示未加载任何工具；普通工具结果仍编码为 function_call_output。
        history[2] = ToolMessage(content="error", tool_call_id="call_search", status="error")
        model.invoke(history + [ToolMessage(content="x", tool_call_id="other")])
        self.assertEqual(self.requests[-1][0]["input"][2]["tools"], [])
        self.assertEqual(self.requests[-1][0]["input"][3]["type"], "function_call_output")
        history[2] = ToolMessage(content="bad", tool_call_id="call_search", artifact={"x": 1})
        with self.assertRaisesRegex(ValueError, "artifact"):
            model.invoke(history)

    def test_namespaced_call_name_and_replay(self):
        call = {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_weather",
            "name": "get_weather",
            "namespace": "weather",
            "arguments": '{"city": "Paris"}',
        }
        self.item_events(call, added={**call, "arguments": ""})
        answer = CodexSubscriptionModel().invoke("weather?")
        self.assertEqual(
            [(t["name"], t["args"]) for t in answer.tool_calls],
            [("weather.get_weather", {"city": "Paris"})],
        )
        self.stream_patch.stop()
        self.http_patch.start()
        CodexSubscriptionModel().invoke(
            [HumanMessage(content="weather?"), answer, ToolMessage(content="rain", tool_call_id="call_weather")]
        )
        self.assertEqual(self.requests[-1][0]["input"][1]["namespace"], "weather")

    def test_call_name_change_after_start_fails(self):
        call = {
            "type": "function_call",
            "id": "fc_1",
            "call_id": "call_weather",
            "name": "get_weather",
            "namespace": "weather",
            "arguments": "{}",
        }
        added = {key: value for key, value in call.items() if key != "namespace"}
        self.item_events(call, added=added)
        with self.assertRaisesRegex(RuntimeError, "工具名称"):
            CodexSubscriptionModel().invoke("weather?")

    def test_unsupported_builtin_tool_rejected(self):
        model = CodexSubscriptionModel().bind_tools([{"type": "tool_search"}])
        with self.assertRaisesRegex(ValueError, "client tool_search"):
            model.invoke("hello")
        self.assertEqual(self.requests, [])

    def test_commentary_excluded_but_preserved_and_empty_final_output(self):
        commentary = {**self.output[1], "id": "commentary", "phase": "commentary"}
        events = [
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": commentary,
            },
            {"type": "response.output_text.delta", "output_index": 0, "delta": "OK"},
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": commentary,
            },
            {
                "type": "response.output_item.done",
                "output_index": 1,
                "item": self.output[1],
            },
            {"type": "response.completed", "response": {**self.response, "output": []}},
        ]
        self.events(events)
        answer = CodexSubscriptionModel().invoke("hello")
        self.assertEqual(answer.content, "OK")
        self.assertEqual(
            answer.additional_kwargs["codex_output_items"], [commentary, self.output[1]]
        )

    def test_failure_and_truncation_after_delta_close_connection(self):
        for ending in (
            [],
            [{"type": "response.failed"}],
            [{"type": "response.incomplete"}],
        ):
            with self.subTest(ending=ending):
                self.events(text_events(self.output, self.response)[:3] + ending)
                stream = CodexSubscriptionModel().stream("hello")
                self.assertEqual(next(stream).content, "O")
                with self.assertRaises(RuntimeError):
                    list(stream)
                self.assertTrue(self.wire.closed)
                self.stream_patch.stop()

    def test_consumer_close_releases_sync_connection(self):
        self.events(text_events(self.output, self.response))
        stream = CodexSubscriptionModel().stream("hello")
        next(stream)
        stream.close()
        self.assertTrue(self.wire.closed)

    def test_refusal_is_not_success(self):
        item = {**self.output[1], "content": [{"type": "refusal", "refusal": "No"}]}
        self.events(
            [{"type": "response.output_item.done", "output_index": 0, "item": item}]
        )
        with self.assertRaises(RuntimeError):
            CodexSubscriptionModel().invoke("hello")
        self.assertTrue(self.wire.closed)

    def test_multiline_sse_frame(self):
        from wandrun.integrations.codex_subscription import _SSEDecoder

        decoder = _SSEDecoder()
        for line in [
            ": heartbeat\r\n",
            "event: response.completed\r\n",
            'data: {"type":\r\n',
            'data: "response.completed"}\r\n',
        ]:
            self.assertIsNone(decoder.feed(line))
        self.assertEqual(decoder.feed("\r\n"), {"type": "response.completed"})
        decoder.feed("data: [DONE]")
        self.assertIsNone(decoder.feed(""))

    def test_image_formats_and_tool_result(self):
        from langchain_core.messages import ToolMessage

        blocks = [
            {"type": "text", "text": "Compare"},
            {
                "type": "image_url",
                "image_url": {"url": "https://example.com/a.png", "detail": "low"},
            },
            {"type": "image", "base64": "aGVsbG8=", "mime_type": "image/png"},
            {"type": "image", "url": "https://example.com/b.png"},
            {"type": "input_image", "image_url": "data:image/png;base64,aGVsbG8="},
        ]
        CodexSubscriptionModel().invoke(
            [
                HumanMessage(content=blocks),
                ToolMessage(content=blocks, tool_call_id="call_image"),
            ]
        )
        inputs = self.requests[-1][0]["input"]
        self.assertEqual(inputs[0]["content"], inputs[1]["output"])
        self.assertEqual(
            inputs[0]["content"][1],
            {
                "type": "input_image",
                "image_url": "https://example.com/a.png",
                "detail": "low",
            },
        )
        self.assertEqual(
            inputs[0]["content"][2]["image_url"], "data:image/png;base64,aGVsbG8="
        )



class AsyncStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        isolate_codex_home(self)
        import httpx

        self.real_client = httpx.AsyncClient
        claims = base64.urlsafe_b64encode(b"{}").decode().rstrip("=")
        auth = {
            "auth_mode": "chatgpt",
            "tokens": {"access_token": f"test.{claims}.test"},
        }
        self.auth = patch(
            "wandrun.integrations.codex_credentials.Path.read_bytes", return_value=json.dumps(auth).encode()
        )
        self.auth.start()
        self.addCleanup(self.auth.stop)

    def transport(self, handler):
        import httpx

        mocked = patch(
            "wandrun.integrations.codex_subscription.httpx.AsyncClient",
            side_effect=lambda **kw: self.real_client(
                transport=httpx.MockTransport(handler), **kw
            ),
        )
        mocked.start()
        self.addCleanup(mocked.stop)

    async def test_async_deltas_and_agent_messages(self):
        import httpx
        from langchain.agents import create_agent

        item = {
            "type": "message",
            "role": "assistant",
            "phase": "final_answer",
            "content": [{"type": "output_text", "text": "OK"}],
        }
        payload = sse(
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {**item, "content": []},
            },
            {"type": "response.output_text.delta", "output_index": 0, "delta": "O"},
            {"type": "response.output_text.delta", "output_index": 0, "delta": "K"},
            {
                "type": "response.completed",
                "response": {"status": "completed", "output": [item]},
            },
        )
        self.transport(lambda request: httpx.Response(200, content=payload))
        model = CodexSubscriptionModel()
        chunks = [c async for c in model.astream("hello")]
        self.assertEqual([c.content for c in chunks], ["O", "K", ""])
        self.assertEqual((await model.ainvoke("hello")).content, "OK")
        agent = create_agent(model=model, tools=[])
        chunks = [
            part
            async for part in agent.astream(
                {"messages": [HumanMessage(content="hello")]},
                stream_mode="messages",
                version="v2",
            )
        ]
        self.assertEqual(
            [p["data"][0].content for p in chunks if p["data"][0].content], ["O", "K"]
        )

    async def test_cancel_pending_read_closes_response(self):
        import asyncio
        import httpx

        entered, closed = asyncio.Event(), asyncio.Event()

        class DelayedStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield sse(
                    {
                        "type": "response.output_text.delta",
                        "output_index": 0,
                        "delta": "O",
                    }
                )
                entered.set()
                await asyncio.Event().wait()

            async def aclose(self):
                closed.set()

        self.transport(lambda request: httpx.Response(200, stream=DelayedStream()))
        stream = CodexSubscriptionModel().astream("hello")
        self.assertEqual((await anext(stream)).content, "O")
        pending = asyncio.create_task(anext(stream))
        await asyncio.wait_for(entered.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await asyncio.wait_for(closed.wait(), 1)
        await stream.aclose()


if __name__ == "__main__":
    unittest.main()
