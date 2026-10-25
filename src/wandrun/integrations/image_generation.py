"""Generate one PNG through an independent subscription Responses request.

The image stays out of the main chat history. A completed response is required even
when an image_generation_call has already delivered its base64 result.
"""

import base64
import binascii
import json
import os
import re
from contextlib import aclosing, nullcontext
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

import httpx
from PIL import Image

from wandrun.integrations.codex_subscription import (
    CodexSubscriptionHTTPError,
    CodexSubscriptionModel,
    _safe_detail,
)
from wandrun.integrations.codex_credentials import CodexCredentials
from wandrun.metrics import record_request


DEFAULT_IMAGE_MODEL = "gpt-6-astra"
MAX_REFERENCE_IMAGES = 3
MAX_REFERENCE_BYTES = 10 * 1024 * 1024
MAX_REFERENCE_PIXELS = 25_000_000
ImageSize = Literal["auto", "1024x1024", "1024x1536", "1536x1024"]
ImageQuality = Literal["auto", "low", "medium", "high"]
_IMAGE_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_QUOTA_CODES = {
    "usage_limit_reached", "insufficient_quota",
    "image_gen_limit_reached", "image_generation_limit_reached",
    "image_gen_quota_exhausted", "image_generation_quota_exhausted",
}


@dataclass(frozen=True)
class GeneratedImage:
    """Decoded PNG and the provider-reported quality (not the requested quality)."""

    data: bytes
    quality: str | None
    width: int
    height: int


class ImageGenerationError(RuntimeError):
    """Generation failed; code distinguishes confirmed quota exhaustion from other failures."""

    def __init__(self, code: str, detail: str, resets_at=None):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.resets_at = resets_at


def _failure(payload, fallback="图片生成失败"):
    if not isinstance(payload, dict):
        payload = {}
    error = payload.get("error")
    if not isinstance(error, dict):
        error = {}
    details = payload.get("incomplete_details")
    if not isinstance(details, dict):
        details = {}
    code = error.get("code") or error.get("type") or payload.get("code") or details.get("reason")
    message = _safe_detail(error.get("message")) or _safe_detail(payload.get("message"))
    reason = _safe_detail(details.get("reason"))
    server_detail = _safe_detail(payload.get("detail"))
    detail = message or server_detail or reason or _safe_detail(code) or fallback
    signals = (code, reason, message, server_detail)
    quota = any(
        isinstance(signal, str)
        and (
            signal.lower() in _QUOTA_CODES
            or bool(re.search(
                r"image[_ -](?:gen(?:eration)?)[_ -](?:usage[_ -])?"
                r"(?:limit|quota)[_ -](?:reached|exceeded|exhausted)", signal, re.I,
            ))
        )
        for signal in signals
    )
    quota = quota or (
        error.get("limit_id", payload.get("limit_id")) == "image_gen"
        and code == "rate_limit_exceeded"
    )
    resets_at = error.get("resets_at", error.get("reset_at"))
    if resets_at is None:
        resets_at = payload.get("resets_at", payload.get("reset_at"))
    if resets_at is not None and not isinstance(resets_at, (str, int, float)):
        resets_at = None
    return ImageGenerationError(
        "image_generation_quota_exhausted" if quota else "image_generation_failed",
        detail,
        resets_at,
    )


def _http_failure(error):
    # Classification uses the adapter's pre-truncation, credential-redacted fields.
    payload = error.error_payload
    if payload is None:
        payload = {"message": _safe_detail(error.detail)}
    failure = _failure(payload)
    return ImageGenerationError(
        failure.code, f"图片生成请求 HTTP {error.status_code}：{failure.detail}", failure.resets_at,
    )


def _image_item(item):
    return isinstance(item, dict) and item.get("type") == "image_generation_call"


def _refusal(items):
    for item in items:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "refusal":
                return _safe_detail(part.get("refusal")) or "模型拒绝生成图片"
    return None


def _image_info(data: bytes, *, reference: bool) -> tuple[str, int, int]:
    """Decode fully before trusting format or dimensions; reject corrupt media."""
    try:
        with Image.open(BytesIO(data)) as image:
            if reference and image.width * image.height > MAX_REFERENCE_PIXELS:
                raise ImageGenerationError("image_generation_failed", "参考图片像素超出限制")
            if image.format not in (_IMAGE_MIME if reference else {"PNG": "image/png"}):
                raise ImageGenerationError(
                    "image_generation_failed", "参考图片仅支持 PNG、JPEG、WebP" if reference
                    else "图片生成返回的不是 PNG",
                )
            image.load()
            return (_IMAGE_MIME[image.format], image.width, image.height)
    except (OSError, ValueError, Image.DecompressionBombError):
        raise ImageGenerationError(
            "image_generation_failed", "参考图片无效或已损坏" if reference
            else "图片生成返回的 PNG 无效或已损坏",
        ) from None


def _input_content(prompt: str, reference_images: list[bytes] | None) -> list[dict]:
    if reference_images is None:
        reference_images = []
    if not isinstance(reference_images, list) or len(reference_images) > MAX_REFERENCE_IMAGES:
        raise ImageGenerationError("image_generation_failed", "参考图片数量超出限制")
    content = [{"type": "input_text", "text": prompt}]
    for data in reference_images:
        if not isinstance(data, bytes) or not data or len(data) > MAX_REFERENCE_BYTES:
            raise ImageGenerationError("image_generation_failed", "参考图片字节大小无效或超出限制")
        mime, _, _ = _image_info(data, reference=True)
        content.append({
            "type": "input_image",
            "image_url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}",
        })
    return content


async def generate_image(
    prompt: str, *, reference_images: list[bytes] | None = None,
    size: ImageSize = "1024x1024", quality: ImageQuality = "auto",
    model_name: str = DEFAULT_IMAGE_MODEL,
    credentials: CodexCredentials | None = None,
) -> GeneratedImage:
    """Generate a decoded PNG with actual dimensions and provider quality.

    References and requested size/quality are validated before any billable request.
    The provider may ignore requested size/quality. Never retry a request; only
    ordinary Responses usage is recorded, not image-generation cost.
    """
    if size not in ("auto", "1024x1024", "1024x1536", "1536x1024"):
        raise ImageGenerationError("image_generation_failed", "图片尺寸参数无效")
    if quality not in ("auto", "low", "medium", "high"):
        raise ImageGenerationError("image_generation_failed", "图片质量参数无效")
    content = _input_content(prompt, reference_images)
    model = CodexSubscriptionModel(
        model_name=model_name, timeout=180,
        credentials=credentials if credentials is not None else CodexCredentials(),
    )
    body = {
        "model": model_name,
        "instructions": "You are a helpful assistant.",
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": "low"},
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        "tools": [{"type": "image_generation", "size": size, "quality": quality, "output_format": "png"}],
        "tool_choice": {"type": "image_generation"},
    }
    span_context = nullcontext(None)
    if os.environ.get("LANGSMITH_TRACING", "").lower() == "true":
        from wandrun.runtime.tracing import capture_tool_context, tool_span

        context = capture_tool_context()
        if context is not None:
            span_context = tool_span(context, "image_generation.responses", body, run_type="llm")
    with span_context as span:
        result = None
        result_item_id = None
        actual_quality = None
        completed = False
        usage = None
        try:
            with record_request(model_name) as trace:
                async with aclosing(model._arequest(body)) as events:
                    async for event in events:
                        if not isinstance(event, dict):
                            raise ImageGenerationError("image_generation_failed", "图片生成返回了无效的 SSE 事件")
                        kind = event.get("type")
                        if kind in {"response.completed", "response.failed", "response.incomplete"}:
                            response = event.get("response")
                            if response is not None and not isinstance(response, dict):
                                raise ImageGenerationError("image_generation_failed", "图片生成返回了无效的响应")
                        if trace is not None:
                            trace.observe(event)
                        if kind in {"error", "response.failed", "response.incomplete"}:
                            raise _failure(event.get("response") or event, f"图片生成失败：{kind}")
                        if kind == "response.output_item.done":
                            item = event.get("item")
                            if _image_item(item) and item.get("status") == "completed":
                                if not result:
                                    result = item.get("result")
                                    result_item_id = item.get("id")
                                if item.get("id") == result_item_id and isinstance(item.get("quality"), str):
                                    actual_quality = item["quality"]
                            elif _image_item(item):
                                raise _failure(item, "图片生成未完成")
                            elif isinstance(item, dict):
                                refusal = _refusal([item])
                                if refusal:
                                    raise ImageGenerationError("image_generation_failed", refusal)
                        if kind == "response.completed":
                            response = event.get("response")
                            if not isinstance(response, dict):
                                response = {}
                            if response.get("status") != "completed":
                                raise _failure(response, "图片生成响应未完成")
                            items = response.get("output") or []
                            refusal = _refusal(items)
                            if refusal:
                                raise ImageGenerationError("image_generation_failed", refusal)
                            for item in items:
                                if _image_item(item) and item.get("status") == "completed":
                                    if not result:
                                        result = item.get("result")
                                        result_item_id = item.get("id")
                                    if item.get("id") == result_item_id and isinstance(item.get("quality"), str):
                                        actual_quality = item["quality"]
                                elif _image_item(item):
                                    raise _failure(item, "图片生成未完成")
                            usage = response.get("usage")
                            completed = True
                            break
                if not completed:
                    raise ImageGenerationError("image_generation_failed", "图片生成 SSE 提前结束，未收到 response.completed")
                if not isinstance(result, str) or not result:
                    raise ImageGenerationError("image_generation_failed", "图片生成完成，但未返回图片")
                try:
                    image = base64.b64decode(result, validate=True)
                except (ValueError, binascii.Error):
                    raise ImageGenerationError("image_generation_failed", "图片生成返回了无效的 base64") from None
                if not image.startswith(_PNG_SIGNATURE):
                    raise ImageGenerationError("image_generation_failed", "图片生成返回的不是 PNG")
                _, width, height = _image_info(image, reference=False)
                if span is not None:
                    outputs = {
                        "status": "completed",
                        "image_format": "png",
                        "image_size": f"{width}x{height}",
                        "image_quality": actual_quality,
                        "response_metadata": {"model_name": model_name},
                    }
                    if isinstance(usage, dict):
                        tokens = {
                            key: usage[key] for key in ("input_tokens", "output_tokens", "total_tokens")
                            if type(usage.get(key)) is int and usage[key] >= 0
                        }
                        if tokens:
                            outputs["usage_metadata"] = tokens
                    span.end(outputs=outputs)
                return GeneratedImage(image, actual_quality, width, height)
        except CodexSubscriptionHTTPError as error:
            raise _http_failure(error) from None
        except ImageGenerationError:
            raise
        except json.JSONDecodeError:
            raise ImageGenerationError("image_generation_failed", "图片生成返回了无效的 SSE JSON") from None
        except (httpx.HTTPError, RuntimeError) as error:
            detail = _safe_detail(str(error)) or type(error).__name__
            raise ImageGenerationError("image_generation_failed", f"{type(error).__name__}：{detail}") from None
