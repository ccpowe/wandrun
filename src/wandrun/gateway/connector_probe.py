"""一次独立 MCP 初始化；不读取已保存连接、不注册客户端、不发送凭据。"""

import asyncio

import httpx2
from fastmcp import Client
from fastmcp.client.transports.http import StreamableHttpTransport
from fastmcp.client.transports.sse import SSETransport

from wandrun.gateway.connectors import connector_fields, connection_fields
from wandrun.integrations.mcp import _safe_reason
from wandrun.integrations.mcp_oauth import OAuthIssue


async def probe_remote(fields: dict, oauth, *, response=None) -> dict:
    """Reuse a failed open's sanitized 401/403 instead of initializing that URL again."""
    definition = connector_fields("probe", fields)
    transport = definition["transport"]
    connection = connection_fields(definition)
    if response is None:
        async def received(reply):
            nonlocal response
            if reply.status_code in (401, 403):
                response = reply

        def http_client(**kwargs):
            kwargs["timeout"] = httpx2.Timeout(10)
            client = httpx2.AsyncClient(**kwargs)
            client.event_hooks.setdefault("response", []).append(received)
            return client

        peer = (SSETransport if transport == "sse" else StreamableHttpTransport)(
            connection["url"], httpx_client_factory=http_client,
        )
        try:
            async with asyncio.timeout(15):
                async with Client(peer):
                    return {"result": "none", "transport": transport}
        except Exception as error:
            if response is None:
                return {"result": "failed", "transport": transport,
                        "error": {"code": "connection_failed", "message": _safe_reason(error)}}
    try:
        async with asyncio.timeout(15):
            metadata = await oauth.discover(connection["url"], response=response, require_dcr=False)
        asm = metadata["oauth_metadata"]
        return {"result": "oauth", "transport": transport, "oauth": {
            "dcr_supported": bool(asm.get("registration_endpoint")),
            "pkce_supported": "S256" in (asm.get("code_challenge_methods_supported") or []),
            "issuer": metadata["issuer"],
        }}
    except OAuthIssue as error:
        # A challenge explicitly advertising OAuth is not a static-key inference.
        if "resource_metadata" in response.headers.get("www-authenticate", ""):
            return {"result": "failed", "transport": transport,
                    "error": {"code": error.code, "message": str(error)}}
        return {"result": "key", "transport": transport}
    except TimeoutError:
        return {"result": "failed", "transport": transport,
                "error": {"code": "connection_failed", "message": "请求超时"}}
