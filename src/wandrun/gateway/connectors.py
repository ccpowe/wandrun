"""连接器的写入规则与公开投影；原始凭据只交给存储和运行时，不进入响应。"""

import re
import logging

from wandrun.config import _connection, _display_name
from wandrun.gateway.error_messages import connector_validation

logger = logging.getLogger(__name__)


class UnknownConnector(LookupError):
    pass


class InvalidConnector(ValueError):
    pass


class ConnectorConflict(ValueError):
    def __init__(self, message: str, details: dict):
        super().__init__(message)
        self.details = details


_CONNECTION_FIELDS = {"command", "args", "env", "url", "transport", "headers"}


def connection_fields(definition: dict) -> dict:
    return {key: value for key, value in definition.items() if key in _CONNECTION_FIELDS}


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
        raise InvalidConnector("应用连接器的地址和授权方式由应用目录管理")
    result = dict(previous or {"id": identity, "description": "", "auth_type": "none"})
    result.setdefault("auth_type", "none")
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
    if result["auth_type"] not in ("none", "oauth"):
        raise InvalidConnector("auth_type 只支持 none 或 oauth")
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
    }


def mcp_config(definitions: dict[str, dict]) -> tuple[dict[str, dict], dict[str, str]]:
    """把网关显示字段与 MCP 连接参数分开；空说明不满足可搜索服务的要求。"""
    return (
        {identity: connection_fields(value) for identity, value in definitions.items()},
        {identity: value["description"] for identity, value in definitions.items()
         if value["description"].strip()},
    )
