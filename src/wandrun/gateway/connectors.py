"""连接器的写入规则与公开投影；原始凭据只交给存储和运行时，不进入响应。"""

import re
import logging

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from wandrun.config import _connection, _display_name
from wandrun.gateway.error_messages import connector_validation
from wandrun.integrations.mcp_oauth import GITHUB_MCP_URL

logger = logging.getLogger(__name__)


class UnknownConnector(LookupError):
    pass


class InvalidConnector(ValueError):
    pass


class ConnectorConflict(ValueError):
    def __init__(self, message: str, details: dict, *, code: str = "rejected", status: int = 409):
        super().__init__(message)
        self.details, self.code, self.status = details, code, status


_CONNECTION_FIELDS = {"command", "args", "env", "url", "transport", "headers"}

# Fixed catalog entries. A key entry declares where the single Key travels:
# `key.in` is "header" (sent as the named request header) or "query" (the gateway moves the
# saved secret into the URL query only when building connection parameters; the public url and
# every response keep only the key name). Adding a similar service is a catalog-only change.
MCP_APPS = {
    "notion": {
        "name": "Notion", "description": "连接 Notion 工作区的 MCP 工具",
        "connector_description": "Notion 工作区", "url": "https://mcp.notion.com/mcp",
        "auth": {"type": "oauth"},
    },
    "github": {
        "name": "GitHub", "description": "连接 GitHub 仓库、Issue 与 Pull Request",
        "connector_description": "GitHub 仓库与协作", "url": GITHUB_MCP_URL,
        "auth": {"type": "device"},
    },
    # https://lbs.amap.com/api/mcp-server/gettingstarted (updated 2026-03-17): Streamable HTTP,
    # the Key is accepted only as the `key` URL query parameter.
    "amap": {
        "name": "高德地图", "description": "地点搜索、路线规划、天气与地理编码",
        "connector_description": "高德地图地点搜索、路线规划、天气与地理编码", "url": "https://mcp.amap.com/mcp",
        "auth": {"type": "key", "key_url": "https://lbs.amap.com/api/mcp-server/create-project-and-key",
                 "headers": {}, "key": {"in": "query", "name": "key"}},
        # AMap rejects invalid keys with HTTP 200, outside JSON-RPC.
        "key_auth_failures": [{"status": "0", "info": "INVALID_USER_KEY"}],
    },
}


def _catalog_key(definition: dict) -> dict | None:
    app = MCP_APPS.get(definition.get("app_id") or "")
    return app["auth"].get("key") if app and definition.get("auth_type") == "key" else None


def _catalog_key_name(definition: dict) -> str | None:
    key = _catalog_key(definition)
    return key["name"] if key else None


def _query_key(definition: dict) -> str | None:
    key = _catalog_key(definition)
    return key["name"] if key and key["in"] == "query" else None


def connection_fields(definition: dict) -> dict:
    """Runtime connection parameters; a catalog query Key leaves headers for the URL here only."""
    connection = {key: value for key, value in definition.items() if key in _CONNECTION_FIELDS}
    name = _query_key(definition)
    if name and "url" in connection:
        headers = dict(connection.get("headers", {}))
        secret = headers.pop(name, None)
        connection["headers"] = headers
        if secret:
            parts = urlsplit(connection["url"])
            query = [(item, value) for item, value in parse_qsl(parts.query) if item != name] + [(name, secret)]
            connection["url"] = urlunsplit(parts._replace(query=urlencode(query)))
    if _catalog_key(definition):
        app = MCP_APPS[definition["app_id"]]
        connection["_key_auth_failures"] = app.get("key_auth_failures", [])
    return connection


def connector_fields(identity: str, fields: dict, previous: dict | None = None) -> dict:
    """校验完整候选定义。密钥补丁逐键合并，null/空字符串删除，省略保留。

    切换连接方式时丢弃另一种方式的字段，避免把旧环境密钥发送为 HTTP 参数。
    校验错误只描述字段，不回显请求值。
    """
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identity) is None:
        raise InvalidConnector("连接器 id 必须是 1～64 个 ASCII 字母、数字、下划线或连字符")
    if fields.keys() - (_CONNECTION_FIELDS | {"name", "description", "auth_type"}):
        raise InvalidConnector("连接器包含不可编辑的字段")
    if previous is not None and previous.get("app_id") and fields.keys() & (_CONNECTION_FIELDS | {"auth_type"}):
        # A catalog key connector accepts only writes / clears of its declared Key;
        # address, auth and any other header stay catalog-owned.
        declared = _catalog_key_name(previous)
        if not (declared and fields.keys() & (_CONNECTION_FIELDS | {"auth_type"}) == {"headers"}):
            raise InvalidConnector("应用连接器的地址和授权方式由应用目录管理")
        if not isinstance(fields["headers"], dict) or set(fields["headers"]) - {declared}:
            raise InvalidConnector("应用连接器只能填写目录声明的 Key")
    result = dict(previous or {
        "id": identity, "name": "远程连接器" if "url" in fields else "本地连接器",
        "description": "", "auth_type": "none", "name_source": "auto", "description_source": "auto",
        "icon": None,
    })
    result.setdefault("auth_type", "none")
    for field in ("name", "description"):
        if field in fields and (previous is None or fields[field] != previous.get(field)):
            result[field + "_source"] = "user"
    if fields.get("auth_type") == "oauth" and result.get("auth_type") != "oauth":
        result.pop("headers", None)
    if "url" in fields and "command" not in fields and "command" in result:
        for key in ("command", "args", "env", "transport"):
            result.pop(key, None)
    if "command" in fields and "url" not in fields and "url" in result:
        for key in ("url", "headers", "transport"):
            result.pop(key, None)
    for key, value in fields.items():
        if key not in ("headers", "env"):
            result[key] = value
            continue
        if not isinstance(value, dict):
            raise InvalidConnector(f"{key} 必须是密钥补丁对象")
        secrets = dict(result.get(key, {}))
        for name, secret in value.items():
            if not isinstance(name, str) or not name:
                raise InvalidConnector(f"{key} 的键必须是非空字符串")
            if secret is None or secret == "":
                secrets.pop(name, None)
            elif isinstance(secret, str):
                secrets[name] = secret
            else:
                raise InvalidConnector(f"{key} 的值必须是字符串或 null")
        result[key] = secrets
    if result["auth_type"] not in ("none", "key", "oauth"):
        raise InvalidConnector("auth_type 只支持 none、key 或 oauth")
    automatic_transport = "transport" in fields and fields["transport"] is None
    if automatic_transport and "url" not in result:
        raise InvalidConnector("自动传输只适用于远程连接器")
    if "transport" in fields:
        result["transport_source"] = "auto" if automatic_transport else "user"
    if "url" in result and (automatic_transport or "transport" not in fields and (
        previous is None or ("url" in fields and (
            "transport" not in result or result.get("transport_source") == "auto"
        ))
    )):
        try:
            result["transport"] = "sse" if urlsplit(result["url"]).path.endswith("/sse") else "streamable-http"
            result["transport_source"] = "auto"
        except (ValueError, TypeError, AttributeError):
            raise InvalidConnector("请填写有效的连接器地址") from None
    if "command" in result and result["auth_type"] != "none":
        raise InvalidConnector("本地命令不支持认证方式")
    if result["auth_type"] == "oauth":
        if "url" not in result or result.get("transport", "http") == "sse" or result.get("headers"):
            raise InvalidConnector("OAuth 仅支持不含静态请求头的 Streamable HTTP 连接器")
    try:
        _display_name(result.get("name"), "连接器 name")
        if not isinstance(result.get("description"), str):
            raise ValueError("连接器 description 必须是字符串")
        _connection(connection_fields(result), identity)
    except ValueError as error:
        logger.info("连接器配置校验失败", exc_info=True)
        raise InvalidConnector(connector_validation(error)) from error
    return result


def public_connector(definition: dict) -> dict:
    """Only display fields and redacted connection fields cross the HTTP boundary."""
    return {
        **{key: {name: True for name in value} if key in ("headers", "env") else value
           for key, value in definition.items() if key != "app_id"},
        "auth_type": definition.get("auth_type", "none"),
        "app_id": definition.get("app_id"),
        "name_source": definition.get("name_source", "user"),
        "description_source": definition.get("description_source", "user"),
        "transport_source": definition.get("transport_source", "user" if "transport" in definition else "auto"),
        "icon": definition.get("icon"),
        "description_missing": not definition.get("description", "").strip(),
    }


def mcp_config(definitions: dict[str, dict]) -> tuple[dict[str, dict], dict[str, str]]:
    """把网关显示字段与 MCP 连接参数分开；空说明不满足可搜索服务的要求。"""
    return (
        {identity: connection_fields(value) for identity, value in definitions.items()},
        {identity: value["description"] for identity, value in definitions.items()
         if value["description"].strip()},
    )
