"""Request projections preserve canonical media, including reopened checkpoints."""

import base64
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, MessagesState, StateGraph

from wandrun.integrations.codex_subscription import CodexSubscriptionHTTPError, CodexSubscriptionModel
from wandrun.runtime.conversations import conversation_config, prepare_conversation_input
from codex_test_home import isolate_codex_home



class MediaInputTests(unittest.TestCase):
    def setUp(self):
        isolate_codex_home(self)

    def test_pdf_mapping_uses_block_then_read_path_then_default_filename(self):
        for fields, source, filename in (
            ({"filename": "explicit.pdf"}, "/docs/source.pdf", "explicit.pdf"),
            ({"extras": {"filename": "extra.pdf"}}, None, "extra.pdf"),
            ({}, "/docs/source.pdf", "source.pdf"),
            ({}, None, "document.pdf"),
        ):
            with self.subTest(filename=filename):
                block = {"type": "file", "mime_type": "application/pdf", "base64": "JVBERg==", **fields}
                message = ToolMessage(content=[block], tool_call_id="read", additional_kwargs={"read_file_path": source})
                original = copy.deepcopy(message)
                result = CodexSubscriptionModel()._build_request([message])["input"][0]["output"]
                self.assertEqual(result, [{"type": "input_file", "filename": filename, "file_data": "data:application/pdf;base64,JVBERg=="}])
                self.assertEqual(message, original)
                user = CodexSubscriptionModel()._build_request([HumanMessage(content=[block])])
                self.assertEqual(user["input"][0]["content"][0]["type"], "input_file")

    def test_unsupported_blocks_preserve_neighbors_and_describe_missing_content(self):
        for block in (
            {"type": "file", "mime_type": "application/vnd.ms-powerpoint", "base64": "YWJj"},
            {"type": "file", "mime_type": "application/pdf", "file_id": "remote-pdf"},
            {"type": "audio", "mime_type": "audio/mpeg", "base64": "YWJj"},
            {"type": "video", "mime_type": "video/mp4", "base64": "YWJj"},
            {"type": "image", "mime_type": "image/png", "url": "file:///not/read.png"},
            {"type": "image", "file_id": "remote-image"},
            {"type": "image", "mime_type": "text/plain", "base64": "YWJj"},
            {"type": "image_url", "image_url": {}},
            {"type": "image", "url": "https://example.org/a.png", "detail": []},
            {"type": "future_media", "filename": "unknown.bin", "size": 42},
            {"type": "text"},
        ):
            with self.subTest(block=block):
                content = ["before", block, {"type": "text", "text": "after"}]
                original = copy.deepcopy(content)
                message = ToolMessage(content=content, tool_call_id="read", additional_kwargs={"read_file_path": "/docs/source.bin"})
                output = CodexSubscriptionModel()._build_request([message])["input"][0]["output"]
                self.assertEqual(output[0], {"type": "input_text", "text": "before"})
                self.assertEqual(output[2], {"type": "input_text", "text": "after"})
                self.assertEqual(output[1]["type"], "input_text")
                text = output[1]["text"]
                for fact in (block["type"], "/docs/source.bin", "MIME=", "大小=", "原因：", "尚未读取", "命令行"):
                    self.assertIn(fact, text)
                if "mime_type" in block:
                    self.assertIn(block["mime_type"], text)
                self.assertNotIn("YWJj", text)
                self.assertEqual(content, original)

    def test_system_media_also_degrades_without_discarding_text(self):
        result = CodexSubscriptionModel()._build_request([SystemMessage(content=["rules", {"type": "image", "url": "https://example.org/i.png"}])])
        self.assertTrue(result["instructions"].startswith("rules\n"))
        self.assertIn("系统指令只支持文字", result["instructions"])


class MediaHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        isolate_codex_home(self)

    async def test_reopened_tool_checkpoint_recovers_without_reexecuting_or_rewriting(self):
        original = [
            {"type": "file", "mime_type": "application/pdf", "base64": base64.b64encode(b"%PDF-fixture").decode()},
            {"type": "audio", "mime_type": "audio/mpeg", "base64": "YWJj"},
        ]
        call = AIMessage(content="", tool_calls=[{"name": "read_file", "args": {}, "id": "read"}], additional_kwargs={"codex_output_items": [{"type": "function_call", "name": "read_file", "arguments": "{}", "call_id": "read"}]})
        seed = [HumanMessage(content="read"), call, ToolMessage(content=copy.deepcopy(original), tool_call_id="read", additional_kwargs={"read_file_path": "/docs/old.pdf"})]
        requests = []
        real_client = httpx.AsyncClient

        def respond(request):
            import json
            body = json.loads(request.content)
            requests.append(body)
            output = next(item["output"] for item in body["input"] if item.get("type") == "function_call_output")
            self.assertEqual(output[0]["type"], "input_file")
            self.assertEqual(output[1]["type"], "input_text")
            event = {"type": "response.completed", "response": {"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "recovered"}]}]}}
            return httpx.Response(200, content="data: " + json.dumps(event) + "\n\n")

        model = CodexSubscriptionModel()
        async def invoke(state):
            return {"messages": [await model.ainvoke(state["messages"])]}

        def graph(saver):
            builder = StateGraph(MessagesState)
            builder.add_node("model", invoke)
            builder.add_edge(START, "model")
            builder.add_edge("model", END)
            return builder.compile(checkpointer=saver)

        config = conversation_config("old-file-history")
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "history.sqlite")
            async with AsyncSqliteSaver.from_conn_string(path) as saver:
                # A fully paired tool result is precisely what the failed old turn left.
                await graph(saver).aupdate_state(config, {"messages": seed}, as_node="model")
            with patch("wandrun.integrations.codex_credentials.Path.read_bytes", return_value=b'{"auth_mode":"chatgpt","tokens":{"access_token":"test.e30.test"}}'), patch("wandrun.integrations.codex_subscription.httpx.AsyncClient", side_effect=lambda **kw: real_client(transport=httpx.MockTransport(respond), **kw)):
                async with AsyncSqliteSaver.from_conn_string(path) as saver:
                    agent = graph(saver)
                    inputs = await prepare_conversation_input(agent, config, [HumanMessage(content="continue")])
                    result = await agent.ainvoke(inputs, config, durability="sync")
                    self.assertEqual(result["messages"][-1].content, "recovered")
                async with AsyncSqliteSaver.from_conn_string(path) as saver:
                    saved = (await graph(saver).aget_state(config)).values["messages"]
                    tools = [m for m in saved if isinstance(m, ToolMessage)]
                    self.assertEqual([m.content for m in tools], [original])
            self.assertEqual(len(requests), 1)

    async def test_actual_provider_error_is_not_converted_to_omission(self):
        real_client = httpx.AsyncClient
        with patch("wandrun.integrations.codex_credentials.Path.read_bytes", return_value=b'{"auth_mode":"chatgpt","tokens":{"access_token":"test.e30.test"}}'), patch("wandrun.integrations.codex_subscription.httpx.AsyncClient", side_effect=lambda **kw: real_client(transport=httpx.MockTransport(lambda request: httpx.Response(400, text="invalid PDF")), **kw)):
            with self.assertRaises(CodexSubscriptionHTTPError) as raised:
                await CodexSubscriptionModel().ainvoke([HumanMessage(content=[{"type": "file", "mime_type": "application/pdf", "base64": "JVBERg=="}])])
        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("invalid PDF", str(raised.exception))
