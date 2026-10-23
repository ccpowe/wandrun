"""Offline request projection and summary generation contracts."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from langchain.agents.middleware.types import ModelRequest
from langchain.agents.structured_output import ProviderStrategy
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.errors import GraphInterrupt

from wandrun.integrations.codex_subscription import (
    CodexSubscriptionModel,
    ContextWindowExceededError,
    ModelRequestBudget,
    _ResponseStream,
    is_retryable_model_error,
)
from wandrun.runtime.compaction_summary import (
    SummaryGenerationError,
    request_model_kwargs,
    summarize_request,
    _validate_summary,
)
from wandrun.runtime.messages import AgentOutput
from wandrun.runtime.preview import PreviewExecution, current_preview

from compaction_fixtures import SUMMARY_TEXT


@tool
def lookup(query: str) -> str:
    """Look up a query."""
    return query


def prepared(model):
    return ModelRequest(
        model=model,
        system_message=SystemMessage(content="system prefix"),
        messages=[
            HumanMessage(content="first"),
            AIMessage(content="", tool_calls=[{"name": "lookup", "args": {"query": "first"}, "id": "call-1"}],
                      additional_kwargs={"codex_output_items": [{
                          "type": "function_call", "name": "lookup", "call_id": "call-1",
                          "arguments": '{"query":"first"}',
                      }]}),
            ToolMessage(content="tool result", tool_call_id="call-1"),
        ],
        tools=[lookup],
        response_format=ProviderStrategy(AgentOutput.model_json_schema(), strict=True),
        model_settings={"prompt_cache_key": "task-1"},
    )


def summary_events(text=SUMMARY_TEXT):
    text = json.dumps({
        "messages": [{"to": "human", "task_id": None, "message": text, "attachments": []}],
        "next": "done",
    })
    item = {"type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": text}]}
    return {"type": "response.completed", "response": {
        "status": "completed", "output": [item], "usage": {
            "input_tokens": 120, "output_tokens": 30, "total_tokens": 150,
            "input_tokens_details": {"cached_tokens": 64},
        },
    }}


class ProjectionTests(unittest.TestCase):
    def test_projection_is_pure_and_counts_schema_and_visible_tools(self):
        budget = ModelRequestBudget(1)
        model = CodexSubscriptionModel(request_budget=budget)
        request = prepared(model)
        messages = [request.system_message, *request.messages]
        options = request_model_kwargs(request)
        first = model.project_request(messages, **options)
        self.assertEqual(first, model.project_request(messages, **options))
        self.assertIn("json_schema", first["text"]["format"]["type"])
        self.assertIn("tools", first)
        self.assertGreater(model.estimate_request_tokens(messages, **options),
                           model.estimate_request_tokens(messages, tools=options["tools"]))
        self.assertEqual(model.request_summaries, [])
        self.assertEqual(model._build_request(messages, **options), first)
        with self.assertRaisesRegex(RuntimeError, "请求上限"):
            model._build_request(messages, **options)

    def test_opaque_payloads_are_not_counted_as_text_or_twice(self):
        model = CodexSubscriptionModel()
        raw = [{"type": "reasoning", "encrypted_content": "a" * 100000},
               {"type": "message", "role": "assistant", "content": [
                   {"type": "output_text", "text": "brief"}]}]
        small = AIMessage(content="other" * 10000,
                          additional_kwargs={"codex_output_items": raw})
        large = AIMessage(content="unrelated" * 100000,
                          additional_kwargs={"codex_output_items": [
                              {**raw[0], "encrypted_content": "z" * 1000000}, raw[1]]})
        self.assertEqual(model.estimate_request_tokens([small]),
                         model.estimate_request_tokens([large]))
        def image(payload):
            return HumanMessage(content=[{"type": "image", "mime_type": "image/png", "base64": payload}])
        self.assertEqual(model.estimate_request_tokens([image("a" * 100)]),
                         model.estimate_request_tokens([image("a" * 100000)]))
        self.assertGreater(model.estimate_request_tokens([image("a" * 100)]), 6000)

    def test_controlled_context_codes_both_http_and_sse(self):
        for payload in ('{"error":{"code":"context_length_exceeded"}}',
                        '{"code":"context_window_exceeded"}'):
            error = CodexSubscriptionModel._http_error(400, payload, {})
            self.assertIsInstance(error, ContextWindowExceededError)
            self.assertFalse(is_retryable_model_error(error))
        error = CodexSubscriptionModel._http_error(400, '{"error":{"message":"token limit"}}', {})
        self.assertNotIsInstance(error, ContextWindowExceededError)
        for event in (
            {"type": "error", "error": {"code": "context_length_exceeded"}},
            {"type": "response.failed", "response": {"error": {"code": "context_window_exceeded"}}},
            {"type": "response.incomplete", "response": {
                "incomplete_details": {"reason": "context_length_exceeded"}}},
        ):
            with self.subTest(event=event), self.assertRaises(ContextWindowExceededError):
                list(_ResponseStream("test").feed(event))
        with self.assertRaises(RuntimeError) as caught:
            list(_ResponseStream("test").feed({"type": "response.incomplete", "response": {
                "incomplete_details": {"reason": "max_output_tokens"}}}))
        self.assertFalse(is_retryable_model_error(caught.exception))


class SummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_never_previews_its_human_shaped_output_and_restores_public_scope(self):
        published = []
        scope = PreviewExecution("root", lambda sender, event: published.append(event))
        token = current_preview.set(scope)
        model = CodexSubscriptionModel()
        request = prepared(model)
        before = list(published)

        async def response(_model, body):
            completed = summary_events()
            output = completed["response"]["output"][0]
            yield {"type": "response.output_item.added", "output_index": 0,
                   "item": {**output, "content": []}}
            for character in output["content"][0]["text"]:
                yield {"type": "response.output_text.delta", "output_index": 0,
                       "content_index": 0, "delta": character}
            yield completed

        try:
            with patch.object(CodexSubscriptionModel, "_arequest", response):
                result = await summarize_request(request)
                self.assertEqual(result.content, SUMMARY_TEXT)
                self.assertEqual(published, before)
                await model.ainvoke(request.messages, **request_model_kwargs(request))
                self.assertEqual(published[-1]["text"], SUMMARY_TEXT)
        finally:
            scope.close()
            current_preview.reset(token)

    async def test_summary_preserves_entire_prefix_binding_and_extracts_only_summary(self):
        budget = ModelRequestBudget(2)
        model = CodexSubscriptionModel(request_budget=budget)
        request = prepared(model)
        bodies = []

        async def response(_model, body):
            bodies.append(body)
            yield summary_events()

        with patch.object(CodexSubscriptionModel, "_arequest", response):
            result = await summarize_request(request)
        self.assertEqual(result.content, SUMMARY_TEXT)
        normal = model.project_request([request.system_message, *request.messages],
                                       **request_model_kwargs(request))
        summary = bodies[0]
        self.assertEqual(summary["instructions"], normal["instructions"])
        self.assertEqual(summary["tools"], normal["tools"])
        self.assertEqual(summary["prompt_cache_key"], normal["prompt_cache_key"])
        self.assertEqual(summary["input"][:-1], normal["input"])
        self.assertEqual({**summary, "input": summary["input"][:-1]}, normal)
        self.assertEqual(request.messages[-1].content, "tool result")
        self.assertEqual(result.usage_metadata["input_token_details"]["cache_read"], 64)
        with self.assertRaisesRegex(RuntimeError, "请求上限"):
            model._build_request([HumanMessage(content="a")])
            model._build_request([HumanMessage(content="b")])

    async def test_one_transient_retry_uses_shared_budget(self):
        model = CodexSubscriptionModel(request_budget=ModelRequestBudget(2))
        calls = 0

        async def flaky(_model, body):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise httpx.ConnectTimeout("temporary")
            yield summary_events()

        with patch.object(CodexSubscriptionModel, "_arequest", flaky):
            await summarize_request(prepared(model))
        self.assertEqual(calls, 2)
        with self.assertRaisesRegex(RuntimeError, "请求上限"):
            model._build_request([HumanMessage(content="over limit")])

    async def test_selected_summary_model_shares_the_run_budget(self):
        budget = ModelRequestBudget(1)
        normal = CodexSubscriptionModel(model_name="normal", request_budget=budget)
        selected = CodexSubscriptionModel(model_name="summary", request_budget=budget)
        bodies = []

        async def response(_model, body):
            bodies.append(body)
            yield summary_events()

        with patch.object(CodexSubscriptionModel, "_arequest", response):
            await summarize_request(prepared(normal), model=selected)
        self.assertEqual(bodies[0]["model"], "summary")
        with self.assertRaisesRegex(RuntimeError, "请求上限"):
            normal._build_request([HumanMessage(content="next")])

    async def test_failed_outputs_do_not_become_summaries_or_retry(self):
        for output in ("", "   "):
            model = CodexSubscriptionModel()
            async def blank(_model, body):
                yield summary_events(output)
            with patch.object(CodexSubscriptionModel, "_arequest", blank):
                with self.assertRaises((RuntimeError, ValueError)):
                    await summarize_request(prepared(model))
        model = CodexSubscriptionModel()
        calls = 0
        async def rejected(_model, body):
            nonlocal calls
            calls += 1
            yield {"type": "response.failed", "response": {"error": {"code": "invalid_request_error"}}}
        with patch.object(CodexSubscriptionModel, "_arequest", rejected):
            with self.assertRaises(RuntimeError):
                await summarize_request(prepared(model))
        self.assertEqual(calls, 1)

    async def test_refusal_tool_call_and_incomplete_response_fail(self):
        model = CodexSubscriptionModel()
        events = [
            {"type": "response.completed", "response": {
                "status": "completed", "output": [{
                    "type": "message", "role": "assistant", "content": [
                        {"type": "refusal", "refusal": "no"}]}]}},
            {"type": "response.completed", "response": {
                "status": "completed", "output": [{
                    "type": "function_call", "call_id": "call-1",
                    "name": "lookup", "arguments": "{}"}]}},
            {"type": "response.incomplete", "response": {
                "incomplete_details": {"reason": "max_output_tokens"}}},
        ]
        for event in events:
            with self.subTest(event=event):
                async def answer(_model, body):
                    yield event
                with patch.object(CodexSubscriptionModel, "_arequest", answer):
                    with self.assertRaises((RuntimeError, ValueError)):
                        await summarize_request(prepared(model))

    async def test_summary_rejects_communication_actions_instead_of_dispatching(self):
        base = {"to": "human", "task_id": None, "message": "summary", "attachments": []}
        for output in (
            {"messages": [base], "next": "wait"},
            {"messages": [{**base, "attachments": ["/secret.txt"]}], "next": "done"},
            {"messages": [{**base, "to": "other-agent"}], "next": "done"},
            {"messages": [base, base], "next": "done"},
        ):
            with self.subTest(output=output):
                async def response(_model, body):
                    yield {"type": "response.completed", "response": {
                        "status": "completed", "output": [{
                            "type": "message", "role": "assistant",
                            "content": [{"type": "output_text", "text": json.dumps(output)}],
                        }],
                    }}
                with patch.object(CodexSubscriptionModel, "_arequest", response):
                    with self.assertRaises(SummaryGenerationError):
                        await summarize_request(prepared(CodexSubscriptionModel()))

    def test_section_validation_accepts_markdown_lists_and_nested_content(self):
        plain = SUMMARY_TEXT.replace("## ", "")
        nested = SUMMARY_TEXT.replace(
            "失败尝试与结果未知项：无。",
            "失败尝试与结果未知项：无。\n\n### 示例（不是顶层章节）\n"
            "```markdown\n## 1. 目标\n伪标题\n```\n\n1. 子步骤甲\n2. 子步骤乙",
        )
        spaced = SUMMARY_TEXT.replace("## ", "  ##\t").replace("1. 目标", "1.\t目标  ")
        empty_facts = SUMMARY_TEXT.replace(
            "已读 /reports/a.txt 第 1～80 行，覆盖全文；result=67，信息已足够回答。", "无",
        )
        for text in (SUMMARY_TEXT, plain, nested, spaced, empty_facts):
            with self.subTest(text=text):
                _validate_summary(text, CodexSubscriptionModel())

    def test_section_validation_rejects_missing_duplicate_reordered_empty_and_extra_sections(self):
        parts = SUMMARY_TEXT.split("\n\n")
        variants = [
            "",
            "result=67",
            "\n\n".join(parts[:2] + parts[3:]),
            "\n\n".join(parts[:3] + [parts[2]] + parts[4:]),
            "\n\n".join(parts[:2] + [parts[3], parts[2]] + parts[4:]),
            SUMMARY_TEXT.replace("## 5. 产物与路径\n无", "## 5. 产物与路径\n"),
            "```markdown\n" + SUMMARY_TEXT + "\n```",
            "已完成，请看下面。\n\n" + SUMMARY_TEXT,
            SUMMARY_TEXT + "\n## 最终回复\nresult=67",
            SUMMARY_TEXT.replace("## 3. 已确认事实", "## 3. 最终答案"),
            SUMMARY_TEXT.replace("## 3. 已确认事实", "### 3. 已确认事实"),
            SUMMARY_TEXT.replace("## 3. 已确认事实", "> ## 3. 已确认事实"),
            SUMMARY_TEXT.replace("## 4. 决策", "# 4. 决策"),
            SUMMARY_TEXT.replace("## ", "") + "\n\n这是另附的业务回复。",
            SUMMARY_TEXT.replace("## ", "").replace("3. 已确认事实", "2. 已确认事实"),
            SUMMARY_TEXT.replace("## 3. 已确认事实", "```markdown\n## 3. 已确认事实")
                        .replace("## 4. 决策", "```\n\n## 4. 决策"),
        ]
        for text in variants:
            with self.subTest(text=text), self.assertRaises(SummaryGenerationError):
                _validate_summary(text, CodexSubscriptionModel())

    def test_summary_length_boundary_counts_only_plain_text(self):
        model = CodexSubscriptionModel()
        empty = model.estimate_request_tokens([HumanMessage(content="")])
        def size(text):
            return model.estimate_request_tokens([HumanMessage(content=text)]) - empty
        text = SUMMARY_TEXT + "a" * 20000
        while size(text) < 8000:
            text += "a"
        self.assertEqual(size(text), 8000)
        _validate_summary(text, model)
        while size(text) == 8000:
            text += "a"
        with self.assertRaisesRegex(SummaryGenerationError, "8000"):
            _validate_summary(text, model)

    async def test_invalid_summary_retries_same_prefix_without_replaying_bad_body(self):
        model = CodexSubscriptionModel(request_budget=ModelRequestBudget(2))
        req = prepared(model)
        bodies = []
        bad = "UNUSABLE_BUSINESS_REPLY result=67"

        async def respond(_model, body):
            bodies.append(body)
            yield summary_events(bad if len(bodies) == 1 else SUMMARY_TEXT)

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            answer = await summarize_request(req)
        self.assertEqual(answer.text, SUMMARY_TEXT)
        normal = model.project_request([req.system_message, *req.messages], **request_model_kwargs(req))
        self.assertEqual(len(bodies), 2)
        for body in bodies:
            self.assertEqual({**body, "input": body["input"][:-1]}, normal)
            self.assertNotIn(bad, json.dumps(body, ensure_ascii=False))
        self.assertNotEqual(bodies[0]["input"][-1], bodies[1]["input"][-1])
        self.assertEqual(len(model.request_summaries), 2)
        self.assertEqual(answer.usage_metadata["input_token_details"]["cache_read"], 64)

    async def test_format_and_transport_retries_share_one_extra_transport_attempt(self):
        for outcomes in (
            ["transport", "bad", "good"],
            ["bad", "transport", "good"],
            ["transport", "bad", "transport"],
            ["bad", "bad"],
        ):
            with self.subTest(outcomes=outcomes):
                model = CodexSubscriptionModel(request_budget=ModelRequestBudget(3))
                bodies = []
                async def respond(_model, body):
                    index = len(bodies)
                    bodies.append(body)
                    if outcomes[index] == "transport":
                        raise httpx.ConnectTimeout("temporary")
                    yield summary_events("result=67" if outcomes[index] == "bad" else SUMMARY_TEXT)

                with patch.object(CodexSubscriptionModel, "_arequest", respond):
                    if outcomes[-1] == "good":
                        self.assertEqual((await summarize_request(prepared(model))).text, SUMMARY_TEXT)
                    else:
                        expected = httpx.ConnectTimeout if outcomes[-1] == "transport" else SummaryGenerationError
                        with self.assertRaises(expected):
                            await summarize_request(prepared(model))
                self.assertEqual(len(bodies), len(outcomes))

    async def test_format_retry_stops_at_shared_budget(self):
        model = CodexSubscriptionModel(request_budget=ModelRequestBudget(1))
        bodies = []
        async def respond(_model, body):
            bodies.append(body)
            yield summary_events("result=67")
        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            with self.assertRaisesRegex(RuntimeError, "请求上限"):
                await summarize_request(prepared(model))
        self.assertEqual(len(bodies), 1)

    async def test_cancel_and_graph_interrupt_do_not_retry_and_restore_preview(self):
        for error in (asyncio.CancelledError(), GraphInterrupt()):
            with self.subTest(error=type(error).__name__):
                scope = PreviewExecution("root", lambda *_: None)
                token = current_preview.set(scope)
                model = AsyncMock()
                model.ainvoke.side_effect = error
                try:
                    with self.assertRaises(type(error)):
                        await summarize_request(prepared(model))
                    self.assertIs(current_preview.get(), scope)
                    self.assertEqual(model.ainvoke.await_count, 1)
                finally:
                    scope.close()
                    current_preview.reset(token)
