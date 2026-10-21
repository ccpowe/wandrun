"""Offline subscription image-generation protocol and lifecycle tests."""

import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from wandrun.integrations.image_generation import (
    DEFAULT_IMAGE_MODEL,
    ImageGenerationError,
    generate_image,
)
from wandrun.metrics import RunMetrics
from codex_test_home import isolate_codex_home



PNG = b"\x89PNG\r\n\x1a\n" + b"test-content"
ENCODED = base64.b64encode(PNG).decode()


def sse(*events):
    return "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()


def image_item(result=ENCODED):
    return {"type": "image_generation_call", "id": "img_1", "status": "completed", "result": result}


def done(result=ENCODED):
    return {"type": "response.output_item.done", "item": image_item(result)}


def completed(output=None):
    return {"type": "response.completed", "response": {"status": "completed", "output": output or []}}


class ImageGenerationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        isolate_codex_home(self)
        self.requests = []
        self.status = 200
        self.payload = sse(done(), completed())
        original_client = httpx.AsyncClient

        def handler(request):
            self.requests.append(request)
            return httpx.Response(self.status, content=self.payload)

        self.transport = httpx.MockTransport(handler)
        self.client_patch = patch(
            "wandrun.integrations.codex_subscription.httpx.AsyncClient",
            side_effect=lambda **kw: original_client(transport=self.transport, **kw),
        )
        self.credentials_patch = patch(
            "wandrun.integrations.codex_credentials.Path.read_bytes",
            return_value=b'{"auth_mode":"chatgpt","tokens":{"access_token":"TEST","account_id":"account"}}',
        )
        self.client_patch.start()
        self.credentials_patch.start()
        self.addCleanup(self.client_patch.stop)
        self.addCleanup(self.credentials_patch.stop)

    async def assert_failure(self, code="image_generation_failed", detail=None, resets_at=None):
        with self.assertRaises(ImageGenerationError) as caught:
            await generate_image("draw a circle")
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.resets_at, resets_at)
        if detail:
            self.assertIn(detail, caught.exception.detail)

    async def test_request_shape_and_done_result_survives_empty_completed_output(self):
        self.assertEqual(await generate_image("draw a circle"), PNG)
        request, = self.requests
        self.assertEqual(request.url.path, "/backend-api/codex/responses")
        self.assertEqual(request.headers["authorization"], "Bearer TEST")
        self.assertEqual(json.loads(request.content), {
            "model": DEFAULT_IMAGE_MODEL,
            "instructions": "You are a helpful assistant.",
            "input": [{"role": "user", "content": "draw a circle"}],
            "reasoning": {"effort": "low"},
            "store": False,
            "stream": True,
            "include": ["reasoning.encrypted_content"],
            "tools": [{"type": "image_generation", "size": "1024x1024", "quality": "low", "output_format": "png"}],
            "tool_choice": {"type": "image_generation"},
        })

    async def test_duplicate_completed_item_and_configurable_model(self):
        self.payload = sse(done(), completed([image_item()]))
        self.assertEqual(await generate_image("circle", model_name="alternate-model"), PNG)
        self.assertEqual(json.loads(self.requests[0].content)["model"], "alternate-model")

    async def test_completed_output_can_supply_result_without_done_event(self):
        self.payload = sse(completed([image_item()]))
        self.assertEqual(await generate_image("circle"), PNG)

    async def test_result_requires_completed_event(self):
        self.payload = sse(done())
        await self.assert_failure(detail="response.completed")
        self.assertEqual(len(self.requests), 1)

    async def test_failure_after_done_takes_precedence(self):
        self.payload = sse(done(), {
            "type": "response.failed", "response": {
                "status": "failed", "error": {"code": "unsupported_model", "message": "Model cannot generate images"},
            },
        })
        await self.assert_failure(detail="Model cannot generate images")

    async def test_incomplete_and_refusal(self):
        self.payload = sse(done(), {
            "type": "response.incomplete", "response": {
                "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
            },
        })
        await self.assert_failure(detail="max_output_tokens")
        self.payload = sse(done(), completed([{
            "type": "message", "content": [{"type": "refusal", "refusal": "Cannot draw that"}],
        }]))
        await self.assert_failure(detail="Cannot draw that")

    async def test_explicit_http_quota_and_generic_429(self):
        self.status = 429
        self.payload = json.dumps({"error": {
            "code": "usage_limit_reached", "message": "Image usage exhausted", "resets_at": "tomorrow",
        }}).encode()
        await self.assert_failure("image_generation_quota_exhausted", "Image usage exhausted", "tomorrow")
        self.payload = json.dumps({"error": {"code": "rate_limit_exceeded", "message": "Too many requests"}}).encode()
        await self.assert_failure(detail="Too many requests")
        self.assertEqual(len(self.requests), 2)  # no retries

    async def test_long_http_error_keeps_quota_and_reset_before_display_truncation(self):
        self.status = 429
        self.payload = json.dumps({"error": {
            "message": "Image quota exhausted",
            "diagnostic": "unrelated " * 300,
            "code": "usage_limit_reached",
            "resets_at": 1800000000,
        }}).encode()
        await self.assert_failure(
            "image_generation_quota_exhausted", "Image quota exhausted", 1800000000,
        )
        self.assertEqual(len(self.requests), 1)

    async def test_http_top_level_detail_preserves_reason_and_filters_media(self):
        self.status = 401
        self.payload = json.dumps({"detail": "Invalid subscription credentials"}).encode()
        await self.assert_failure(detail="Invalid subscription credentials")
        self.status = 400
        self.payload = json.dumps({"detail": "Model does not support image generation"}).encode()
        await self.assert_failure(detail="Model does not support image generation")
        self.payload = json.dumps({"detail": "data:image/png;base64," + ENCODED}).encode()
        with self.assertRaises(ImageGenerationError) as caught:
            await generate_image("draw a circle")
        self.assertEqual(caught.exception.detail, "图片生成请求 HTTP 400：图片生成失败")
        self.assertNotIn(ENCODED, caught.exception.detail)

    async def test_http_structured_fields_redact_credentials_and_reject_media(self):
        secret = "provider-secret"
        self.status = 429
        self.payload = json.dumps({"error": {
            "code": "usage_limit_reached",
            "message": f"Subscription {secret} quota exhausted",
            "resets_at": 1800000000,
        }, "detail": "data:image/png;base64," + ENCODED}).encode()
        with patch(
            "wandrun.integrations.codex_credentials.Path.read_bytes",
            return_value=json.dumps({"auth_mode": "chatgpt", "tokens": {"access_token": secret}}).encode(),
        ):
            with self.assertRaises(ImageGenerationError) as caught:
                await generate_image("draw a circle")
        self.assertEqual(caught.exception.code, "image_generation_quota_exhausted")
        self.assertEqual(caught.exception.resets_at, 1800000000)
        self.assertIn("[REDACTED]", caught.exception.detail)
        self.assertNotIn(secret, caught.exception.detail)
        self.assertNotIn(ENCODED, caught.exception.detail)

    async def test_sse_quota_and_generic_rate_limit(self):
        self.payload = sse({"type": "error", "error": {
            "code": "insufficient_quota", "message": "Not enough quota", "reset_at": 1234,
        }})
        await self.assert_failure("image_generation_quota_exhausted", "Not enough quota", 1234)
        self.payload = sse({"type": "error", "error": {
            "code": "rate_limit_exceeded", "message": "Slow down",
        }})
        await self.assert_failure(detail="Slow down")
        self.payload = sse({"type": "response.failed", "response": {
            "status": "failed", "error": {
                "code": "image_gen_limit_reached", "message": "Image generation limit reached",
                "resets_at": 1800000000,
            },
        }})
        await self.assert_failure("image_generation_quota_exhausted", "Image generation limit", 1800000000)

    async def test_image_quota_identity_does_not_confuse_input_size_limit(self):
        self.payload = sse({"type": "error", "error": {
            "code": "rate_limit_exceeded", "limit_id": "image_gen",
            "message": "Image quota exhausted", "resets_at": 1234,
        }})
        await self.assert_failure("image_generation_quota_exhausted", resets_at=1234)
        self.payload = sse({"type": "error", "error": {
            "code": "invalid_request", "message": "image_generation input size limit exceeded",
        }})
        await self.assert_failure(detail="input size limit")

    async def test_authentication_and_transport_failures_keep_their_reason(self):
        with patch(
            "wandrun.integrations.codex_credentials.Path.read_bytes",
            side_effect=RuntimeError("需要 Codex 登录"),
        ):
            await self.assert_failure(detail="需要 Codex 登录")
        self.transport = httpx.MockTransport(
            lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("provider timed out"))
        )
        await self.assert_failure(detail="ReadTimeout")

    async def test_no_result_invalid_base64_and_non_png_do_not_echo_payload(self):
        self.payload = sse(completed())
        await self.assert_failure(detail="未返回图片")
        self.payload = sse(done("not valid base64!"), completed())
        await self.assert_failure(detail="base64")
        self.payload = sse(done(base64.b64encode(b"not a png").decode()), completed())
        await self.assert_failure(detail="不是 PNG")
        self.payload = sse({"type": "error", "error": {"message": "X" * 1000}})
        with self.assertRaises(ImageGenerationError) as caught:
            await generate_image("draw a circle")
        self.assertNotIn("X" * 100, caught.exception.detail)

    async def test_records_only_ordinary_response_usage(self):
        self.payload = sse(done(), {
            "type": "response.completed",
            "response": {
                "status": "completed", "output": [], "usage": {
                    "input_tokens": 12, "output_tokens": 3,
                    "input_tokens_details": {"cached_tokens": 2},
                },
            },
        })
        with tempfile.TemporaryDirectory() as directory:
            metrics = RunMetrics(Path(directory))
            with metrics.agent_scope("task", "executor"):
                self.assertEqual(await generate_image("circle"), PNG)
            summary = metrics.summary()
            self.assertEqual(summary["model_request_count"], 1)
            self.assertEqual(summary["input_tokens"], 12)
            self.assertEqual(summary["output_tokens"], 3)

    async def test_malformed_sse_does_not_expose_frame(self):
        self.payload = b'data: {\"result\":\"secret-raw-payload\"\\n\\n'
        with self.assertRaises(ImageGenerationError) as caught:
            await generate_image("circle")
        self.assertEqual(caught.exception.code, "image_generation_failed")
        self.assertNotIn("secret-raw-payload", caught.exception.detail)

    async def test_cancellation_closes_http_stream(self):
        entered = asyncio.Event()
        closed = asyncio.Event()

        class WaitingStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield sse(done())
                entered.set()
                await asyncio.Event().wait()

            async def aclose(self):
                closed.set()

        self.transport = httpx.MockTransport(
            lambda request: httpx.Response(200, stream=WaitingStream())
        )
        task = asyncio.create_task(generate_image("circle"))
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.wait_for(closed.wait(), 2)
