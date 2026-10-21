"""网关 HTTP/SSE：校验、鉴权和格式转换，调度规则在 Gateway。

ADR-0043：/agents/{id}/conversations 混排收到的根与成员会话；
/agents/{id}/collaborations 列直接发起的委派；/tasks/{id} 及 events/messages/read/stop
按成员 task_id 操作。事件保留根 conversation_id，以 data.timeline_ids 分发到聊天页。
成员消息的媒体与 UI 提交仍使用根 conversation_id 和全局消息 seq，提交按原发送任务路由。
"""

import asyncio
import base64
import binascii
import hmac
import ipaddress
import json
import os
import logging
import re
import socket
from contextlib import aclosing
from importlib.metadata import version
from urllib.parse import quote

import anyio

from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route, WebSocketRoute

from wandrun.config import AGENT_ID_MAX
from wandrun.gateway.browser_stream import browser_stream
from wandrun.gateway.connectors import ConnectorConflict, InvalidConnector, UnknownConnector
from wandrun.gateway.pairing import DeviceAuth
from wandrun.integrations.mcp_oauth import OAuthIssue
from wandrun.gateway.attachment_previews import AttachmentPreviewService, PreviewUnavailable, THUMBNAIL_WIDTHS
from wandrun.gateway.rich_media import MediaError
from wandrun.gateway.schedules import InvalidSchedule, UnknownSchedule, local_timezone
from wandrun.gateway.service import (
    AgentConflict, BrowserControlUnavailable, CollaborationUnavailable, FileUnavailable, Gateway, GatewayFailure, InvalidAgent,
    SkillConflict, UIAlreadySubmitted, UIBlockNotFound, UIInvalidValues,
    UnknownConversation, UnknownFile, UnknownSkill,
)
from wandrun.gateway.skills import InvalidSkill, SkillBoundaryError
from wandrun.gateway.uploads import UploadError
from wandrun.gateway.store import ClientIdConflict, InvalidReadPosition, UnknownAgent
from wandrun.gateway.subscription import SubscriptionUnavailable
from wandrun.runtime.memory import InvalidMemory, MemoryConflict, MemoryRetired
from wandrun.runtime.browser import BrowserRejected, UnknownBrowserTask
from wandrun.runtime.preview import PreviewPersistenceError
from wandrun.runtime.workers import CollaborationStopped

MAX_TEXT = 20_000
MAX_CLIENT_ID = 128
SQLITE_MAX_INT = 2**63 - 1
TUS_VERSION = "1.0.0"
logger = logging.getLogger(__name__)
_FIELD_LABELS = {
    "title": "标题", "agent_id": "Agent", "client_id": "请求标识",
    "text": "消息", "name": "名称", "limit": "数量", "offset": "偏移量",
    "before": "事件位置", "after": "事件位置", "days": "天数", "seq": "事件位置",
    "index": "序号",
}


def _field_label(name: str) -> str:
    return _FIELD_LABELS.get(name, name)


def _browser_rejection(message: str) -> str:
    if message.startswith(("页面关闭未确认：", "页面清理未确认：")):
        return "页面关闭尚未确认，请稍后重试。"
    if message.startswith(("关闭未确认：", "任务浏览器资源关闭未确认：")):
        return "浏览器关闭尚未确认，请稍后重试。"
    if message.startswith("收回未确认："):
        return "浏览器控制权交接尚未确认，请稍后重试接管。"
    if message.startswith(("Chrome 尚未恢复：", "浏览器分配失败：")):
        return "浏览器暂时不可用，请稍后重试；若持续失败，请查看网关日志。"
    if message in {
        "浏览器管理器已关闭", "任务浏览器仍在关闭", "任务没有可用的浏览器",
        "浏览器正在关闭或已结束，无法新建页面", "浏览器页面数已达上限",
        "浏览器租约正在关闭", "该浏览器租约不可接管", "接管期间租约已关闭",
        "浏览器未处于接管状态", "任务尚未使用浏览器", "当前控制状态不能请求接管",
        "浏览器未处于当前接管代际", "页面不可关闭或不属于本租约",
    }:
        return message
    return "浏览器操作未完成，请稍后重试；若持续失败，请查看网关日志。"


def _request_rejection(message: str) -> str:
    if message == "任务分支正在停止，请等待清理完成后再发送":
        return message
    if message == "任务分支尚未完成停止与清理":
        return "任务仍在停止和清理中，请稍后重试。"
    if message == "目标任务已停止，只能由创建它的上级恢复；重新委派请用 task_id=null":
        return "任务已停止，请从上级会话恢复或重新委派。"
    return "当前操作无法完成，请检查任务状态后重试；若持续失败，请查看网关日志。"


def _tus_metadata(header: str | None) -> dict[str, str]:
    """Decode tus base64 metadata without accepting ambiguous or malformed keys."""
    if header is not None and len(header) > 8192:
        raise UploadError(400, "invalid_request", "Upload-Metadata 过长")
    if not header:
        raise UploadError(400, "invalid_request", "Upload-Metadata 缺少必要字段")
    fields = {}
    for item in header.split(","):
        parts = item.strip().split(" ", 1)
        if not parts[0] or parts[0] in fields or any(c.isspace() for c in parts[0]):
            raise UploadError(400, "invalid_request", "Upload-Metadata 格式错误或字段重复")
        try:
            fields[parts[0]] = base64.b64decode(parts[1] if len(parts) == 2 else "", validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError, binascii.Error) as error:
            raise UploadError(400, "invalid_request", "Upload-Metadata 编码错误") from error
    required = {"conversation_id", "filename", "filetype"}
    if not required <= fields.keys() or any(not fields[key] for key in required):
        raise UploadError(400, "invalid_request", "Upload-Metadata 缺少必要字段")
    return fields


def _tus_number(value: str | None, name: str) -> int:
    if value is None or len(value) > 19 or not value.isascii() or not value.isdecimal():
        raise UploadError(400, "invalid_request", f"{name} 必须是非负整数")
    number = int(value)
    if number > SQLITE_MAX_INT:
        raise UploadError(400, "invalid_request", f"{name} 超出范围")
    return number


class _OpenedFileResponse(StreamingResponse):
    """响应从开始发送到结束的所有路径都持有并关闭已校验文件句柄。"""

    def __init__(self, content, fd: int, **kwargs):
        super().__init__(content, **kwargs)
        self._fd = fd

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            fd, self._fd = self._fd, None
            if fd is not None:
                os.close(fd)


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


def _error(status: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    error = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return JSONResponse({"error": error}, status_code=status)


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        raise HttpError(400, "invalid_json", "请求体不是合法的 JSON")
    if not isinstance(body, dict):
        raise HttpError(400, "invalid_json", "请求体必须是 JSON 对象")
    return body


def _string(body: dict, name: str, limit: int, *, required: bool = True) -> str | None:
    value = body.get(name)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip():
        raise HttpError(400, "invalid_request", f"{_field_label(name)}必须是非空文字")
    if len(value) > limit:
        raise HttpError(413, "too_large", f"{_field_label(name)}超过 {limit} 个字符")
    return value


def _int(value, name: str, default: int | None = None) -> int | None:
    if value is None:
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise HttpError(400, "invalid_request", f"{_field_label(name)}必须是整数")
    if number < 0:
        raise HttpError(400, "invalid_request", f"{_field_label(name)}不能为负数")
    if number > SQLITE_MAX_INT:
        raise HttpError(400, "invalid_request", f"{_field_label(name)}超出范围")
    return number


def _tus_headers(**extra: str) -> dict[str, str]:
    return {"Tus-Resumable": TUS_VERSION, **extra}


def create_app(
    gateway: Gateway, token: str | None = None, *, management_token: str | None = None,
) -> Starlette:
    """构建网关 HTTP API。

    普通 GET 路由的 HEAD 使用同一读分支；多方法处理器只对明确的写方法执行写入。
    上传保留 tus 方法契约，包含 HEAD 对已收齐但未发布文件的恢复。
    """
    auth = DeviceAuth(gateway.store, token)
    computer_name = socket.gethostname()
    gateway_version = version("wandrun")

    def handled(endpoint, *, access="device"):
        # 鉴权放在每个路由的包装里，不用 BaseHTTPMiddleware：后者包装流式响应有已知问题。
        async def run(request: Request):
            if access == "device":
                identity = auth.identify(request.headers.get("authorization"))
                if identity is None:
                    return _error(401, "unauthorized", "缺少或错误的访问令牌")
                request.state.identity = identity
            elif access == "admin":
                # 只用直接 TCP peer，不信 Host、X-Forwarded-For 或代理头。
                try:
                    loopback = ipaddress.ip_address(request.client.host).is_loopback
                except (AttributeError, ValueError):
                    loopback = False
                if not loopback:
                    return _error(403, "forbidden", "管理接口只接受本机回环连接")
                provided = request.headers.get("authorization", "")
                if management_token is None or not hmac.compare_digest(
                    provided.encode("utf-8"), f"Bearer {management_token}".encode("utf-8")
                ):
                    return _error(401, "unauthorized", "缺少或错误的管理凭据")
            try:
                return await endpoint(request)
            except HttpError as error:
                return _error(error.status, error.code, str(error))
            except PreviewUnavailable as error:
                return _error(error.status, error.code, str(error))
            except MediaError as error:
                return _error(error.status, error.code, str(error))
            except UploadError as error:
                return _error(error.status, error.code, str(error))
            except OAuthIssue as error:
                return _error(error.status, error.code, str(error))
            except SubscriptionUnavailable as error:
                return _error(503, error.code, str(error))
            except MemoryConflict as error:
                try:
                    current = gateway._memory_response(request.path_params["id"], error.current)
                except GatewayFailure:
                    return _error(503, "unavailable", "网关状态更新失败，网关正在退出")
                return _error(409, "memory_conflict", str(error), {"current": current})
            except InvalidMemory as error:
                return _error(400, "invalid_request", str(error))
            except MemoryRetired:
                return _error(404, "not_found", "Agent 不存在")
            except UnknownFile:
                return _error(404, "not_found", "文件登记不存在")
            except FileUnavailable as error:
                return _error(error.status, error.code, str(error))
            except UIBlockNotFound as error:
                return _error(404, "ui_block_not_found", str(error))
            except UIAlreadySubmitted as error:
                return _error(409, "ui_already_submitted", str(error), {"event": error.event.to_dict()})
            except UIInvalidValues as error:
                return _error(400, "ui_invalid_values", str(error), error.details)
            except CollaborationUnavailable as error:
                return _error(409, "collaboration_unavailable", str(error))
            except CollaborationStopped as error:
                return _error(409, "collaboration_stopped", str(error))
            except UnknownConversation:
                return _error(404, "not_found", "对话不存在")
            except UnknownBrowserTask:
                return _error(404, "not_found", "浏览器任务不存在")
            except UnknownAgent:
                return _error(404, "not_found", "Agent 不存在")
            except UnknownConnector:
                return _error(404, "not_found", "连接器不存在")
            except UnknownSchedule:
                return _error(404, "not_found", "定时不存在")
            except UnknownSkill:
                return _error(404, "not_found", "技能不存在")
            except ClientIdConflict:
                return _error(409, "client_id_reused", "请求标识已用于其他操作，请检查此前操作的结果")
            except (InvalidAgent, InvalidConnector, InvalidSchedule, InvalidSkill) as error:
                return _error(400, "invalid_request", str(error))
            except (AgentConflict, ConnectorConflict, SkillConflict) as error:
                return _error(409, "rejected", str(error), error.details)
            except SkillBoundaryError as error:
                return _error(409, "rejected", str(error))
            except InvalidReadPosition as error:
                return _error(400, "invalid_request", str(error))
            except BrowserRejected as error:
                logger.warning("浏览器操作拒绝：%s", error)
                return _error(409, "rejected", _browser_rejection(str(error)))
            except ValueError as error:
                # WorkerManager 的拒绝（例如上一次停止的清理还没完成）。
                logger.warning("网关命令被拒绝：%s", error)
                return _error(409, "rejected", _request_rejection(str(error)))
            except BrowserControlUnavailable:
                return _error(503, "unavailable", "运行时已停止，网关正在退出")
            except (GatewayFailure, PreviewPersistenceError):
                return _error(503, "unavailable", "网关状态更新失败，网关正在退出")
            except RuntimeError:
                # 已封锁定时投递/运行时已关闭时明确返回不可用，而不是内部错误。
                if (gateway._closing and (
                    request.url.path.startswith("/schedules/")
                    or request.url.path.endswith("/schedules")
                )) or (gateway.manager is not None and gateway.manager.snapshot()["closed"]) or (
                    gateway.runtime is None and request.url.path.startswith("/agents")
                ) or (
                    request.url.path.endswith("/memory") and getattr(gateway.runtime, "memory", None) is None
                ) or (
                    request.url.path.startswith("/browser-tasks/")
                    and getattr(gateway.runtime, "browser", None) is None
                ) or (
                    request.method == "DELETE" and gateway.checkpointer is None
                ):
                    return _error(503, "unavailable", "运行时已停止，网关正在退出")
                raise
        async def wrapper(request: Request):
            response = await run(request)
            if request.url.path.startswith("/uploads"):
                response.headers["Tus-Resumable"] = TUS_VERSION
                if response.status_code == 412:
                    response.headers["Tus-Version"] = TUS_VERSION
            return response
        return wrapper

    async def upload_collection(request):
        method = request.headers.get("x-http-method-override", request.method).upper()
        if method == "OPTIONS":
            if gateway.uploads is None:
                raise UploadError(503, "unavailable", "上传尚未就绪")
            return Response(headers=_tus_headers(
                **{"Tus-Version": TUS_VERSION, "Tus-Extension": "creation,termination",
                   "Tus-Max-Size": str(gateway.uploads.max_size)}
            ))
        if method != "POST":
            raise UploadError(405, "method_not_allowed", "上传集合只支持 POST 与 OPTIONS")
        if request.headers.get("tus-resumable") != TUS_VERSION:
            raise UploadError(412, "unsupported_version", "需要 Tus-Resumable: 1.0.0")
        length = _tus_number(request.headers.get("upload-length"), "Upload-Length")
        metadata_header = request.headers.get("upload-metadata")
        metadata = _tus_metadata(metadata_header)
        upload = gateway.create_upload(
            metadata["conversation_id"], metadata["filename"], metadata["filetype"], length, metadata_header,
        )
        headers = _tus_headers(
            # Keep the router's mount/root_path without trusting the upstream scheme.
            Location=request.url_for("upload_session", id=upload["id"]).path,
            **{"Upload-Offset": str(upload["offset"])}
        )
        if upload["completed"]:
            headers["Upload-File-Id"] = upload["file_id"]
        return Response(status_code=201, headers=headers)

    async def upload_session(request):
        if gateway.uploads is None:
            raise UploadError(503, "unavailable", "上传尚未就绪")
        method = request.headers.get("x-http-method-override", request.method).upper()
        if method == "OPTIONS":
            return Response(headers=_tus_headers(
                **{"Tus-Version": TUS_VERSION, "Tus-Extension": "creation,termination",
                   "Tus-Max-Size": str(gateway.uploads.max_size)}
            ))
        if request.headers.get("tus-resumable") != TUS_VERSION:
            raise UploadError(412, "unsupported_version", "需要 Tus-Resumable: 1.0.0")
        identity = request.path_params["id"]
        async with gateway.uploads.session_lock(identity):
            upload = gateway.uploads.get(identity)
            if method == "HEAD":
                if upload["offset"] == upload["length"] and not upload["completed"]:
                    await gateway.uploads.complete_async(upload)
                    upload = gateway.uploads.get(identity)
                headers = _tus_headers(**{
                    "Upload-Offset": str(upload["offset"]), "Upload-Length": str(upload["length"]),
                    "Upload-Metadata": upload["metadata"], "Cache-Control": "no-store",
                })
                if upload["completed"]:
                    headers["Upload-File-Id"] = upload["file_id"]
                return Response(status_code=200, headers=headers)
            if method == "DELETE":
                gateway.uploads.terminate(identity)
                return Response(status_code=204, headers=_tus_headers())
            if method != "PATCH":
                raise UploadError(405, "method_not_allowed", "上传资源只支持 PATCH、HEAD、DELETE 与 OPTIONS")
            if request.headers.get("content-type") != "application/offset+octet-stream":
                raise UploadError(415, "unsupported_media_type", "PATCH 需要 application/offset+octet-stream")
            offset = _tus_number(request.headers.get("upload-offset"), "Upload-Offset")
            if offset != upload["offset"]:
                raise UploadError(409, "offset_conflict", "Upload-Offset 与服务端偏移不一致")
            result = await gateway.uploads.advance(upload, offset, request.stream())
            headers = _tus_headers(**{"Upload-Offset": str(result["offset"])})
            if result["completed"]:
                headers["Upload-File-Id"] = result["file_id"]
            return Response(status_code=204, headers=headers)

    def attachment_previews() -> AttachmentPreviewService:
        service = gateway.attachment_previews
        if service is None:
            if gateway.workspace_root is None:
                raise FileUnavailable()
            service = AttachmentPreviewService(gateway.workspace_root / ".wandrun" / "state" / "previews")
            gateway.attachment_previews = service
        return service

    def preview_headers(etag: str) -> dict[str, str]:
        return {
            "Cache-Control": "private, max-age=300",
            "ETag": f'"{etag}"',
            "X-Content-Type-Options": "nosniff",
        }

    async def file_preview(request):
        if request.query_params:
            raise HttpError(400, "invalid_request", "预览接口不接受查询参数")
        artifact = await attachment_previews().preview(
            request.path_params["id"], gateway.open_file,
        )
        return JSONResponse(artifact.metadata, headers=preview_headers(artifact.etag))

    async def file_thumbnail(request):
        width = _int(request.query_params.get("w"), "w")
        if width not in THUMBNAIL_WIDTHS:
            raise HttpError(400, "invalid_request", "缩略图宽度只支持 240、480 或 960")
        artifact = await attachment_previews().thumbnail(
            request.path_params["id"], width, gateway.open_file,
        )
        return Response(
            artifact.payload, media_type="image/jpeg", headers=preview_headers(artifact.etag),
        )

    async def file_metadata(request):
        return JSONResponse(gateway.get_file(request.path_params["id"]))

    async def file_content(request):
        record, fd = gateway.open_file(request.path_params["id"])
        size = record["size"]
        status = 200
        start, end = 0, size - 1
        range_header = request.headers.get("range")
        headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store",
                   "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"}
        if range_header is not None:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if (match is not None and (match[1] or match[2]) and size
                    and len(match[1]) <= 20 and len(match[2]) <= 20):
                if match[1]:
                    start = int(match[1])
                    end = min(int(match[2]), size - 1) if match[2] else size - 1
                else:
                    suffix = int(match[2])
                    start = max(size - suffix, 0)
                    end = size - 1
                valid = start <= end and start < size and (bool(match[1]) or int(match[2]) > 0)
            else:
                valid = False
            if not valid:
                os.close(fd)
                response = _error(416, "invalid_range", "请求范围不可满足")
                response.headers["Content-Range"] = f"bytes */{size}"
                response.headers["Accept-Ranges"] = "bytes"
                return response
            status = 206
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)
        download = request.query_params.get("download", "false")
        if download not in ("true", "false"):
            os.close(fd)
            raise HttpError(400, "invalid_request", "download 必须是 true 或 false")
        safe_inline = record["media_type"] in {
            "text/plain", "image/png", "image/jpeg", "image/gif", "image/webp",
        }
        disposition = "attachment" if download == "true" or not safe_inline else "inline"
        headers["Content-Disposition"] = (
            f"{disposition}; filename=\"download\"; filename*=UTF-8''{quote(record['name'], safe='')}"
        )

        async def chunks():
            position = start
            while position <= end:
                data = await anyio.to_thread.run_sync(os.pread, fd, min(64 * 1024, end - position + 1), position)
                if not data:
                    break
                position += len(data)
                yield data

        return _OpenedFileResponse(
            chunks(), fd, status_code=status, media_type=record["media_type"], headers=headers,
        )

    async def search(request):
        query = request.query_params.get("q", "")
        if len(query) > 500:
            raise HttpError(413, "too_large", "搜索内容不能超过 500 字")
        limit = min(_int(request.query_params.get("limit"), "limit", 30), 100)
        if limit < 1:
            raise HttpError(400, "invalid_request", "limit 必须是正整数")
        offset = _int(request.query_params.get("offset"), "offset", 0)
        return JSONResponse(gateway.search(query, request.query_params.get("agent_id"), limit, offset))

    async def list_conversations(request):
        agent_id = request.query_params.get("agent_id")
        if agent_id is not None and gateway.store.agent(agent_id) is None:
            raise UnknownAgent(agent_id)  # 过滤条件指向不存在的 Agent 是错误，而不是“没有对话”
        # 先取编号再读列表：两者之间没有 await，App 用这个编号开流不会漏也不会重。
        as_of = gateway.store.last_seq()
        return JSONResponse({"conversations": gateway.store.conversations(agent_id), "as_of_seq": as_of})

    async def create_conversation(request):
        body = await _json(request)
        title = _string(body, "title", 200, required=False) or "新对话"
        # 必须显式给出入口 Agent：没有“默认 Agent”可回落，所有 Agent 平等（ADR-0021）。
        agent_id = _string(body, "agent_id", AGENT_ID_MAX)
        return JSONResponse(gateway.create_conversation(title, agent_id), status_code=201)

    async def manage_conversation(request):
        identity = request.path_params["id"]
        if request.method == "PATCH":
            raw = (await _json(request)).get("title")
            if not isinstance(raw, str) or not (title := raw.strip()):
                raise HttpError(400, "invalid_request", "标题必须是非空文字")
            if len(title) > 200:
                raise HttpError(413, "too_large", "标题超过 200 个字符")
            conversation, event = gateway.rename_conversation(identity, title)
            return JSONResponse({"conversation": conversation, "event": event.to_dict() if event else None})
        if request.method != "DELETE":
            raise HTTPException(405)
        event = await gateway.delete_conversation(identity)
        return JSONResponse({"event": event.to_dict()})

    async def agents(request):
        if request.method in ("GET", "HEAD"):
            return await list_agents(request)
        if request.method != "POST":
            raise HTTPException(405)
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        agent, event, created = await gateway.create_agent(
            client_id, {key: value for key, value in body.items() if key != "client_id"}
        )
        return JSONResponse(
            {"agent": agent, "event": event.to_dict(), "replayed": not created},
            status_code=201 if created else 200,
        )

    async def manage_agent(request):
        if request.method in ("GET", "HEAD"):
            return await get_agent(request)
        identity = request.path_params["id"]
        if request.method == "PATCH":
            agent, event = await gateway.update_agent(identity, await _json(request))
            return JSONResponse({"agent": agent, "event": event.to_dict() if event else None})
        if request.method != "DELETE":
            raise HTTPException(405)
        event = await gateway.delete_agent(identity)
        return JSONResponse({"event": event.to_dict()})

    async def agent_memory(request):
        identity = request.path_params["id"]
        if request.method in ("GET", "HEAD"):
            return JSONResponse(gateway.get_memory(identity))
        if request.method != "PUT":
            raise HTTPException(405)
        body = await _json(request)
        if body.keys() != {"content", "version"} or not isinstance(body["content"], str) or (
            not isinstance(body["version"], str)
            or re.fullmatch(r"[0-9a-f]{64}", body["version"]) is None
        ):
            raise HttpError(400, "invalid_request", "记忆需要 content 字符串和 SHA-256 version")
        return JSONResponse(gateway.put_memory(identity, body["content"], body["version"]))

    async def apps(request):
        return JSONResponse({"apps": gateway.list_apps()})

    async def connect_app(request):
        body = await _json(request)
        if body.keys() != {"client_id"}:
            raise HttpError(400, "invalid_request", "只接受 client_id")
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        return JSONResponse({"connector": await gateway.connect_app(request.path_params["id"], client_id)})

    async def oauth_start(request):
        return JSONResponse(await gateway.start_oauth(request.path_params["id"]),
                            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

    async def oauth_callback_manual(request):
        body = await _json(request)
        if body.keys() != {"url"}:
            raise HttpError(400, "invalid_request", "只接受 url")
        url = _string(body, "url", 8192)
        return JSONResponse({"connector": await gateway.callback_oauth(url, request.path_params["id"])},
                            headers={"Cache-Control": "no-store"})

    async def oauth_callback_public(request):
        # Build exclusively from configured redirect + raw query: Host and proxy
        # headers are untrusted. No URL, code, state or issuer enters logs or HTML.
        try:
            query = request.scope.get("query_string", b"")
            if len(query) > 8192:
                raise OAuthIssue("invalid_callback", "回调地址无效", 400)
            await gateway.callback_oauth(gateway.oauth.redirect + "?" + query.decode("ascii"))
            success = True
        except (OAuthIssue, UnicodeDecodeError):
            success = False
        return Response(
            "<!doctype html><html><head><meta name=\"referrer\" content=\"no-referrer\"></head>"
            "<body>授权已处理，请回到 Wandrun。</body></html>" if success else
            "<!doctype html><html><head><meta name=\"referrer\" content=\"no-referrer\"></head>"
            "<body>授权未完成，请回到 Wandrun 重试。</body></html>",
            status_code=200 if success else 400, media_type="text/html",
            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                     "X-Content-Type-Options": "nosniff"},
        )

    async def oauth_pending(request):
        return JSONResponse({"connector": gateway.cancel_oauth(request.path_params["id"])})

    async def oauth_revoke(request):
        connector, remote_revoked = await gateway.revoke_oauth(request.path_params["id"])
        return JSONResponse({"connector": connector, "remote_revoked": remote_revoked})

    async def connectors(request):
        if request.method in ("GET", "HEAD"):
            as_of = gateway.store.last_seq()
            return JSONResponse({"connectors": gateway.list_connectors(), "as_of_seq": as_of})
        if request.method != "POST":
            raise HTTPException(405)
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        connector, event, created = await gateway.create_connector(
            client_id, {key: value for key, value in body.items() if key != "client_id"}
        )
        return JSONResponse(
            {"connector": connector, "event": event.to_dict(), "replayed": not created},
            status_code=201 if created else 200,
        )

    async def manage_connector(request):
        identity = request.path_params["id"]
        if request.method in ("GET", "HEAD"):
            return JSONResponse(gateway.get_connector(identity))
        if request.method == "PATCH":
            connector, event = await gateway.update_connector(identity, await _json(request))
            return JSONResponse({"connector": connector, "event": event.to_dict() if event else None})
        if request.method != "DELETE":
            raise HTTPException(405)
        event = await gateway.delete_connector(identity)
        return JSONResponse({"event": event.to_dict()})

    async def test_connector(request):
        return JSONResponse(await gateway.test_connector(request.path_params["id"]))

    async def agent_schedules(request):
        identity = request.path_params["id"]
        if request.method in ("GET", "HEAD"):
            as_of = gateway.store.last_seq()
            return JSONResponse({
                "schedules": gateway.list_schedules(identity),
                "default_timezone": local_timezone(),
                "as_of_seq": as_of,
            })
        if request.method != "POST":
            raise HTTPException(405)
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        schedule, event, created = gateway.create_schedule(
            identity, client_id, {key: value for key, value in body.items() if key != "client_id"},
        )
        return JSONResponse(
            {"schedule": schedule, "event": event.to_dict(), "replayed": not created},
            status_code=201 if created else 200,
        )

    async def manage_schedule(request):
        identity = request.path_params["id"]
        if request.method in ("GET", "HEAD"):
            return JSONResponse(gateway.get_schedule(identity))
        if request.method == "PATCH":
            schedule, event = gateway.update_schedule(identity, await _json(request))
            return JSONResponse({"schedule": schedule, "event": event.to_dict() if event else None})
        if request.method != "DELETE":
            raise HTTPException(405)
        event = gateway.delete_schedule(identity)
        return JSONResponse({"event": event.to_dict()})

    async def schedule_runs(request):
        identity = request.path_params["id"]
        before = _int(request.query_params.get("before"), "before")
        limit = min(_int(request.query_params.get("limit"), "limit", 20), 100)
        if limit < 1:
            raise HttpError(400, "invalid_request", "limit 必须是正整数")
        as_of = gateway.store.last_seq()
        return JSONResponse({
            "runs": gateway.list_schedule_runs(identity, before=before, limit=limit),
            "as_of_seq": as_of,
        })

    def refresh(request) -> bool:
        value = request.query_params.get("refresh", "false")
        if value not in ("true", "false"):
            raise HttpError(400, "invalid_request", "refresh 必须是 true 或 false")
        return value == "true"

    async def models(request):
        return JSONResponse(await gateway.subscription.models(refresh=refresh(request)))

    async def settings(request):
        if request.method in ("GET", "HEAD"):
            return JSONResponse(await gateway.get_settings())
        if request.method != "PUT":
            raise HTTPException(405)
        return JSONResponse(await gateway.update_settings(await _json(request)))

    async def subscription_usage(request):
        return JSONResponse(await gateway.subscription.status(refresh=refresh(request)))

    async def agent_usage(request):
        days = _int(request.query_params.get("days"), "days", 7)
        if days < 1:
            raise HttpError(400, "invalid_request", "days 必须是正整数")
        return JSONResponse({"days": days, "agents": gateway.store.agent_usage(days)})

    async def agent_capabilities(request):
        return JSONResponse({"capabilities": gateway.agent_capabilities(request.path_params["id"])})

    async def list_builtin_skills(request):
        return JSONResponse({"skills": gateway.list_builtin_skills()})

    async def builtin_skill_detail(request):
        return JSONResponse(gateway.get_builtin_skill(request.path_params["name"]))

    async def list_skills(request):
        as_of = gateway.store.last_seq()
        return JSONResponse({
            "skills": gateway.list_skills(), "as_of_seq": as_of,
            "default_agent_id": gateway.store.agent_catalog().main_agent,
        })

    async def manage_skill(request):
        name = request.path_params["name"]
        # Starlette implicitly registers HEAD for GET routes; only DELETE may mutate.
        if request.method == "DELETE":
            event = await gateway.delete_skill(name)
            return JSONResponse({"event": event.to_dict() if event is not None else None})
        return JSONResponse(gateway.get_skill(name))

    async def list_agents(request):
        # 与对话列表同样先取编号：Agent 定义变化将来也走事件流，App 用它开流不漏不重。
        as_of = gateway.store.last_seq()
        return JSONResponse({"agents": gateway.store.agents(), "as_of_seq": as_of})

    async def hide_agent(request):
        return JSONResponse(gateway.set_agent_on_home(request.path_params["id"], False))

    async def unhide_agent(request):
        return JSONResponse(gateway.set_agent_on_home(request.path_params["id"], True))

    async def get_agent(request):
        agent = gateway.store.agent(request.path_params["id"])
        if agent is None:
            raise UnknownAgent(request.path_params["id"])
        return JSONResponse(agent)

    async def agent_conversations(request):
        agent_id = request.path_params["id"]
        if gateway.store.agent(agent_id) is None:
            raise UnknownAgent(agent_id)
        as_of = gateway.store.last_seq()
        items = (
            gateway.store.task_conversations(creator_agent_id=agent_id)
            if request.url.path.endswith("/collaborations")
            else gateway.store.received_conversations(agent_id)
        )
        return JSONResponse({"conversations": items, "as_of_seq": as_of})

    async def task_detail(request):
        return JSONResponse(gateway.require_task_conversation(request.path_params["id"]))

    async def task_history(request):
        task_id = request.path_params["id"]
        gateway.require_task_conversation(task_id)
        before = _int(request.query_params.get("before"), "before")
        limit = min(_int(request.query_params.get("limit"), "limit", 50), 200)
        as_of = gateway.store.last_seq()
        items = gateway.store.task_history(task_id, before=before, limit=limit)
        return JSONResponse({"events": [event.to_dict() for event in items], "as_of_seq": as_of})

    async def send_task_message(request):
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        text = _string(body, "text", MAX_TEXT)
        event, created = gateway.send_task_message(request.path_params["id"], client_id, text)
        return _accepted(event, created)

    async def stop_task(request):
        body = await _json(request)
        event, created = await gateway.stop(
            request.path_params["id"], _string(body, "client_id", MAX_CLIENT_ID), task=True,
        )
        return _accepted(event, created)

    async def read_task(request):
        body = await _json(request)
        gateway.mark_task_read(request.path_params["id"], _int(body.get("seq"), "seq", 0))
        return Response(status_code=204)

    async def history(request):
        conversation_id = request.path_params["id"]
        if gateway.store.conversation(conversation_id) is None:
            raise UnknownConversation(conversation_id)
        before = _int(request.query_params.get("before"), "before")
        limit = min(_int(request.query_params.get("limit"), "limit", 50), 200)
        as_of = gateway.store.last_seq()
        events = gateway.store.history(conversation_id, before=before, limit=limit)
        return JSONResponse({"events": [e.to_dict() for e in events], "as_of_seq": as_of})

    async def send_message(request):
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        text = body.get("text", "")
        if not isinstance(text, str) or len(text) > MAX_TEXT:
            raise HttpError(400, "invalid_request", "消息须为文本，不能超过 20000 字")
        attachments = body.get("attachments", [])
        if not isinstance(attachments, list) or len(attachments) > 100 or any(
            not isinstance(identity, str) or not identity or len(identity) > 128 for identity in attachments
        ) or len(set(attachments)) != len(attachments):
            raise HttpError(400, "invalid_request", "附件必须是不重复的文件 ID 列表")
        if not text.strip() and not attachments:
            raise HttpError(400, "invalid_request", "消息或附件至少提供一项")
        event, created = gateway.send_message(request.path_params["id"], client_id, text, attachments)
        return _accepted(event, created)

    async def submit_ui(request):
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        message_seq, block = body.get("message_seq"), body.get("block")
        if (type(message_seq) is not int or not 0 < message_seq <= SQLITE_MAX_INT
                or type(block) is not int or not 0 <= block <= SQLITE_MAX_INT):
            raise HttpError(400, "invalid_request", "消息位置必须为正整数，界面块编号必须为非负整数")
        values = body.get("values")
        if not isinstance(values, dict):
            raise UIInvalidValues({"$": "界面输入值必须是对象"})
        event, created = gateway.submit_ui(request.path_params["id"], client_id, message_seq, block, values)
        return JSONResponse({"event": event.to_dict(), "replayed": not created})

    async def stop(request):
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        event, created = await gateway.stop(request.path_params["id"], client_id)
        return _accepted(event, created)

    async def mark_read(request):
        body = await _json(request)
        gateway.mark_read(request.path_params["id"], _int(body.get("seq"), "seq", 0))
        return Response(status_code=204)

    async def exchange_pairing(request):
        body = await _json(request)
        # Even malformed guesses consume a live challenge's five attempts.
        code = body.get("code")
        if not isinstance(code, str) or len(code) > 64:
            code = ""
        name = _string(body, "name", 64, required=False)
        method = body.get("method")
        if method not in ("manual", "qr"):
            raise HttpError(400, "invalid_request", "method 必须为 manual 或 qr")
        result, error = gateway.store.exchange_pairing_code(code, name, method)
        if error is not None:
            messages = {
                "pairing_invalid": "配对码无效，请在电脑上重新生成",
                "pairing_expired": "配对码已过期，请在电脑上重新生成",
                "pairing_used": "配对码已使用，请在电脑上重新生成",
                "pairing_locked": "配对码尝试次数过多，请在电脑上重新生成",
            }
            return _error(400, error, messages[error])
        return JSONResponse({
            **result, "computer_name": computer_name, "gateway_version": gateway_version,
        }, headers={"Cache-Control": "no-store"})

    async def connection(request):
        return JSONResponse({
            **request.state.identity, "computer_name": computer_name,
            "gateway_version": gateway_version,
        }, headers={"Cache-Control": "no-store"})

    async def disconnect(request):
        identity = request.state.identity["device_id"]
        if identity is not None:
            auth.revoke(identity)
        return Response(status_code=204)

    async def pairing_code(request):
        body = await _json(request)
        name = _string(body, "name", 64, required=False)
        return JSONResponse(gateway.store.issue_pairing_code(name), headers={"Cache-Control": "no-store"})

    async def devices(request):
        return JSONResponse({"devices": gateway.store.list_devices()}, headers={"Cache-Control": "no-store"})

    async def revoke_device(request):
        if not auth.revoke(request.path_params["id"]):
            raise HttpError(404, "not_found", "设备不存在")
        return Response(status_code=204)

    async def events(request):
        return _EventStreamResponse(
            gateway, stream_cursor(request.headers, request.query_params),
            auth, request.state.identity["device_id"],
        )

    async def computer(request):
        return JSONResponse(gateway.computer())

    async def browser_tasks(request):
        return JSONResponse(gateway.list_browser_tasks(
            request.query_params.get("agent_id"), request.query_params.get("entry_agent_id"),
        ))

    async def browser_task(request):
        identity = request.path_params["id"]
        if request.method in ("GET", "HEAD"):
            return JSONResponse(gateway.browser_task(identity))
        if request.method != "DELETE":
            raise HTTPException(405)
        return JSONResponse({"browser_task": await gateway.close_browser_task(identity)})

    async def browser_page(request):
        return JSONResponse({"browser_task": await gateway.close_browser_page(
            request.path_params["id"], request.path_params["page"],
        )})

    async def browser_control(request):
        body = await _json(request)
        client_id = _string(body, "client_id", MAX_CLIENT_ID)
        return JSONResponse(await gateway.browser_control(
            request.path_params["id"],
            "takeover" if request.url.path.endswith("/takeover") else "handback",
            client_id,
        ))

    async def browser_thumbnail(request):
        jpeg = await gateway.browser_thumbnail(
            request.path_params["id"], request.query_params.get("page"),
        )
        return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def message_media(request):
        if request.query_params:
            raise HttpError(400, "invalid_request", "媒体接口不接受来源 URL 或其他参数")
        location = request.path_params
        media = await gateway.message_media(
            location["id"], _int(location["seq"], "seq"), location["block"],
            location["element"], _int(location["index"], "index"),
        )
        headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if request.url.path.endswith("/content"):
            return Response(media.data, media_type=media.mime, headers=headers)
        return JSONResponse(
            {"mime": media.mime, "width": media.width, "height": media.height},
            headers=headers,
        )

    async def conversations(request):
        # 同一路径的方法放在一个路由里，405 的 Allow 才会列全（分成两个路由时只报第一个）。
        if request.method in ("GET", "HEAD"):
            return await list_conversations(request)
        if request.method != "POST":
            raise HTTPException(405)
        return await create_conversation(request)

    routes = [
        Route("/pairing/exchange", handled(exchange_pairing, access="public"), methods=["POST"]),
        Route("/connection", handled(connection), methods=["GET"]),
        Route("/devices/current", handled(disconnect), methods=["DELETE"]),
        Route("/admin/pairing-codes", handled(pairing_code, access="admin"), methods=["POST"]),
        Route("/admin/devices", handled(devices, access="admin"), methods=["GET"]),
        Route("/admin/devices/{id}", handled(revoke_device, access="admin"), methods=["DELETE"]),
        Route("/uploads", handled(upload_collection), methods=["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"]),
        Route("/uploads/{id}", handled(upload_session), methods=["GET", "PUT", "POST", "PATCH", "HEAD", "DELETE", "OPTIONS"], name="upload_session"),
        Route("/computer", handled(computer), methods=["GET"]),
        Route("/files/{id}/preview", handled(file_preview), methods=["GET"]),
        Route("/files/{id}/thumbnail", handled(file_thumbnail), methods=["GET"]),
        Route("/files/{id}", handled(file_metadata), methods=["GET"]),
        Route("/files/{id}/content", handled(file_content), methods=["GET"]),
        Route("/search", handled(search), methods=["GET"]),
        Route("/apps", handled(apps), methods=["GET"]),
        Route("/apps/{id}/connect", handled(connect_app), methods=["POST"]),
        Route("/oauth/callback", handled(oauth_callback_public, access="public"), methods=["GET"]),
        Route("/connectors/{id}/oauth/start", handled(oauth_start), methods=["POST"]),
        Route("/connectors/{id}/oauth/callback", handled(oauth_callback_manual), methods=["POST"]),
        Route("/connectors/{id}/oauth/pending", handled(oauth_pending), methods=["DELETE"]),
        Route("/connectors/{id}/oauth", handled(oauth_revoke), methods=["DELETE"]),
        Route("/connectors", handled(connectors), methods=["GET", "POST"]),
        Route("/connectors/{id}", handled(manage_connector), methods=["GET", "PATCH", "DELETE"]),
        Route("/connectors/{id}/test", handled(test_connector), methods=["POST"]),
        Route("/agents", handled(agents), methods=["GET", "POST"]),
        Route("/agents/{id}", handled(manage_agent), methods=["GET", "PATCH", "DELETE"]),
        Route("/agents/{id}/capabilities", handled(agent_capabilities), methods=["GET"]),
        Route("/agents/{id}/conversations", handled(agent_conversations), methods=["GET"]),
        Route("/agents/{id}/collaborations", handled(agent_conversations), methods=["GET"]),
        Route("/tasks/{id}", handled(task_detail), methods=["GET"]),
        Route("/tasks/{id}/events", handled(task_history), methods=["GET"]),
        Route("/tasks/{id}/messages", handled(send_task_message), methods=["POST"]),
        Route("/tasks/{id}/stop", handled(stop_task), methods=["POST"]),
        Route("/tasks/{id}/read", handled(read_task), methods=["POST"]),
        Route("/agents/{id}/schedules", handled(agent_schedules), methods=["GET", "POST"]),
        Route("/schedules/{id}", handled(manage_schedule), methods=["GET", "PATCH", "DELETE"]),
        Route("/schedules/{id}/runs", handled(schedule_runs), methods=["GET"]),
        Route("/agents/{id}/memory", handled(agent_memory), methods=["GET", "PUT"]),
        Route("/models", handled(models), methods=["GET"]),
        Route("/settings", handled(settings), methods=["GET", "PUT"]),
        Route("/usage/subscription", handled(subscription_usage), methods=["GET"]),
        Route("/usage/agents", handled(agent_usage), methods=["GET"]),
        Route("/builtin-skills", handled(list_builtin_skills), methods=["GET"]),
        Route("/builtin-skills/{name}", handled(builtin_skill_detail), methods=["GET"]),
        Route("/skills", handled(list_skills), methods=["GET"]),
        Route("/skills/{name}", handled(manage_skill), methods=["GET", "DELETE"]),
        Route("/agents/{id}/hide", handled(hide_agent), methods=["POST"]),
        Route("/agents/{id}/unhide", handled(unhide_agent), methods=["POST"]),
        Route("/conversations", handled(conversations), methods=["GET", "POST"]),
        Route("/conversations/{id}", handled(manage_conversation), methods=["PATCH", "DELETE"]),
        Route("/conversations/{id}/events", handled(history), methods=["GET"]),
        Route("/conversations/{id}/messages", handled(send_message), methods=["POST"]),
        Route("/conversations/{id}/messages/{seq}/media/{block}/{element}/{index}", handled(message_media), methods=["GET"]),
        Route("/conversations/{id}/messages/{seq}/media/{block}/{element}/{index}/content", handled(message_media), methods=["GET"]),
        Route("/conversations/{id}/ui-submissions", handled(submit_ui), methods=["POST"]),
        Route("/conversations/{id}/stop", handled(stop), methods=["POST"]),
        Route("/conversations/{id}/read", handled(mark_read), methods=["POST"]),
        Route("/events", handled(events), methods=["GET"]),
        Route("/browser-tasks", handled(browser_tasks), methods=["GET"]),
        Route("/browser-tasks/{id}", handled(browser_task), methods=["GET", "DELETE"]),
        Route("/browser-tasks/{id}/pages/{page}", handled(browser_page), methods=["DELETE"]),
        Route("/browser-tasks/{id}/takeover", handled(browser_control), methods=["POST"]),
        Route("/browser-tasks/{id}/handback", handled(browser_control), methods=["POST"]),
        Route("/browser-tasks/{id}/thumbnail", handled(browser_thumbnail), methods=["GET"]),
        WebSocketRoute("/browser-tasks/{browser_task_id}/stream", browser_stream),
    ]
    async def framework_error(request, error: HTTPException):
        # 路由不存在、方法不允许等由框架抛出，也用统一格式；保留原状态码和 Allow 等响应头。
        codes = {404: "not_found", 405: "method_not_allowed"}
        messages = {404: "请求的页面或接口不存在", 405: "该接口不支持此请求方法"}
        response = _error(
            error.status_code, codes.get(error.status_code, "http_error"),
            messages.get(error.status_code, "请求无法处理，请检查地址或请求方式。"),
        )
        response.headers.update(error.headers or {})
        if request.url.path.startswith("/uploads"):
            response.headers["Tus-Resumable"] = TUS_VERSION
        return response

    async def internal_error(request, error: Exception):
        response = _error(500, "internal_error", "网关内部错误")
        if request.url.path.startswith("/uploads"):
            response.headers["Tus-Resumable"] = TUS_VERSION
        return response

    app = Starlette(
        routes=routes,
        exception_handlers={HTTPException: framework_error, Exception: internal_error},
    )
    app.state.gateway = gateway
    app.state.device_auth = auth
    return app


def stream_cursor(headers, query) -> int:
    """事件流从哪条之后开始。Last-Event-ID 优先：EventSource 自动重连会保留原 URL（含最初的 after），
    只在请求头里带上收到的最后一条；先看 after 会重复补发已经收到的事件。"""
    return _int(headers.get("last-event-id") or query.get("after"), "after", 0)


def _accepted(event, created: bool) -> JSONResponse:
    """新命令 202；同一 client_id 的重试返回第一次的事件，并标明是重放。"""
    return JSONResponse(
        {"event": event.to_dict(), "replayed": not created},
        status_code=202 if created else 200,
    )


class _EventStreamResponse(StreamingResponse):
    """Revocation owns the response send, not just the event generator."""

    def __init__(self, gateway: Gateway, after: int, auth: DeviceAuth, device_id: str | None):
        super().__init__(
            _sse(gateway, after),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
        )
        self.auth = auth
        self.device_id = device_id

    async def stream_response(self, send) -> None:
        with anyio.CancelScope() as revoked:
            unsubscribe = self.auth.register(self.device_id, revoked.cancel)
            if unsubscribe is None:
                await send({"type": "http.response.start", "status": 401, "headers": []})
                await send({"type": "http.response.body", "body": b""})
                return
            try:
                # Cancellation during send leaves the generator suspended at yield.
                # Close both iterators explicitly instead of relying on asyncgen GC.
                async with aclosing(self.body_iterator):
                    await super().stream_response(send)
            finally:
                unsubscribe()
        if revoked.cancel_called:
            # Idle streams finish normally. A non-reading peer cannot hold cleanup
            # hostage: if the HTTP terminator also blocks, return and let ASGI abort.
            with anyio.move_on_after(1):
                await send({"type": "http.response.body", "body": b"", "more_body": False})


async def _sse(gateway: Gateway, after: int):
    async with aclosing(gateway.stream(after)) as events:
        async for kind, payload in events:
            if kind == "event":
                # 持久事件带 id：断线后 EventSource 会用 Last-Event-ID 自动续传。
                yield f"id: {payload['seq']}\nevent: {payload['type']}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            elif kind == "transient":
                yield f"event: {payload['type']}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            elif kind == "resync":
                yield "event: resync_required\ndata: {}\n\n"
            else:
                yield ": heartbeat\n\n"
