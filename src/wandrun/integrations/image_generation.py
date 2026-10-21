"""Generate one PNG through an independent subscription Responses request.

The image stays out of the main chat history. A completed response is required even
when an image_generation_call has already delivered its base64 result.
"""

import base64
import binascii
import json
import re
from contextlib import aclosing

import httpx

from wandrun.integrations.codex_subscription import (
    CodexSubscriptionHTTPError,
    CodexSubscriptionModel,
    _safe_detail,
)
from wandrun.metrics import record_request
from wandrun.integrations.codex_credentials import CodexCredentials


DEFAULT_IMAGE_MODEL = "gpt-6-astra"
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_QUOTA_CODES = {
    "usage_limit_reached", "insufficient_quota",
    "image_gen_limit_reached", "image_generation_limit_reached",
    "image_gen_quota_exhausted", "image_generation_quota_exhausted",
}


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


async def generate_image(
    prompt: str, *, model_name: str = DEFAULT_IMAGE_MODEL,
    credentials: CodexCredentials | None = None,
) -> bytes:
    """Return complete PNG bytes or raise ImageGenerationError; never retry a request.

    Auth and HTTP/SSE lifecycle come from the subscription adapter. Only the
    ordinary Responses usage is recorded; image-generation cost is not measured.
    """
    model = CodexSubscriptionModel(
        model_name=model_name, timeout=180,
        credentials=credentials if credentials is not None else CodexCredentials(),
    )
    body = {
        "model": model_name,
        "instructions": "You are a helpful assistant.",
        "input": [{"role": "user", "content": prompt}],
        "reasoning": {"effort": "low"},
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        "tools": [{"type": "image_generation", "size": "1024x1024", "quality": "low", "output_format": "png"}],
        "tool_choice": {"type": "image_generation"},
    }
    result = None
    completed = False
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
                            result = result or item.get("result")
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
                                result = result or item.get("result")
                            elif _image_item(item):
                                raise _failure(item, "图片生成未完成")
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
            return image
    except CodexSubscriptionHTTPError as error:
        raise _http_failure(error) from None
    except ImageGenerationError:
        raise
    except json.JSONDecodeError:
        raise ImageGenerationError("image_generation_failed", "图片生成返回了无效的 SSE JSON") from None
    except (httpx.HTTPError, RuntimeError) as error:
        detail = _safe_detail(str(error)) or type(error).__name__
        raise ImageGenerationError("image_generation_failed", f"{type(error).__name__}：{detail}") from None
