"""Controlled, in-process OAuth 2.0 + Streamable HTTP MCP peer for gateway protocol tests.

Standalone smoke peer: .venv/bin/python tests/oauth_server.py --port 18888
The authorization endpoint deliberately redirects rather than pretending to be a browser;
follow the Location from a local HTTP client or paste it into the gateway callback API.
"""

import argparse
import asyncio
import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlencode

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import Route


class ProtocolState:
    def __init__(self, origin: str):
        self.origin = origin.rstrip("/")
        self.resource = self.origin + "/mcp"
        self.clients = {}
        self.codes = {}
        self.access = set()
        self.refresh = set()
        self.requests = []
        self.revocations = []
        self.denied_calls = 0
        self.force_invalid_grant = False
        self.force_unavailable = False
        self.support_dcr = True
        self.support_s256 = True
        self.registration_unavailable = False
        self.metadata_unavailable = False
        self.unsafe_second_metadata = False
        self.metadata_reads = 0
        self.extra_scope = False
        self.challenge_scope = True
        self.prm_scope = True
        self.stream_get = False
        self.get_stream_started = asyncio.Event()
        self.expires_in = 3600
        self.refresh_started = asyncio.Event()
        self.refresh_release: asyncio.Event | None = None
        self.refresh_rotated = asyncio.Event()
        self.refresh_response_release: asyncio.Event | None = None


def create_app(state: ProtocolState) -> Starlette:
    async def prm(request: Request):
        return JSONResponse({
            "resource": state.resource, "authorization_servers": [state.origin],
            **({"scopes_supported": ["read"]} if state.prm_scope else {}),
        })

    async def as_metadata(request: Request):
        if state.metadata_unavailable:
            return JSONResponse({"error": "temporarily_unavailable"}, status_code=503)
        state.metadata_reads += 1
        return JSONResponse({
            "issuer": state.origin,
            "authorization_endpoint": (
                "http://mcp.example/authorize" if state.unsafe_second_metadata
                and state.metadata_reads > 1 else state.origin + "/authorize"
            ),
            "token_endpoint": state.origin + "/token",
            **({"registration_endpoint": state.origin + "/register"} if state.support_dcr else {}),
            "revocation_endpoint": state.origin + "/revoke",
            "code_challenge_methods_supported": ["S256"] if state.support_s256 else [],
            "authorization_response_iss_parameter_supported": True,
            "token_endpoint_auth_methods_supported": ["none"],
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "scopes_supported": ["read", "write", "offline_access"] if state.extra_scope else ["read"],
        })

    async def register(request: Request):
        if state.registration_unavailable:
            return JSONResponse({"error": "temporarily_unavailable"}, status_code=503)
        data = await request.json()
        state.requests.append(("register", data))
        if (data.get("token_endpoint_auth_method") != "none"
                or not data.get("redirect_uris") or data.get("response_types") != ["code"]):
            return JSONResponse({"error": "invalid_client_metadata"}, status_code=400)
        client_id = "client-" + secrets.token_urlsafe(8)
        state.clients[client_id] = data
        return JSONResponse({"client_id": client_id, **data}, status_code=201)

    async def authorize(request: Request):
        query = request.query_params
        client = state.clients.get(query.get("client_id"))
        if (not client or query.get("redirect_uri") not in client["redirect_uris"]
                or query.get("code_challenge_method") != "S256"
                or query.get("resource") != state.resource or query.get("response_type") != "code"
                or not query.get("state") or not query.get("code_challenge")):
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        code = "code-" + secrets.token_urlsafe(16)
        state.codes[code] = (query["client_id"], query["redirect_uri"], query["code_challenge"])
        state.requests.append(("authorize", dict(query)))
        return RedirectResponse(query["redirect_uri"] + "?" + urlencode({
            "code": code, "state": query["state"], "iss": state.origin,
        }), status_code=302)

    def issue() -> dict:
        access, refresh = "access-" + secrets.token_urlsafe(16), "refresh-" + secrets.token_urlsafe(16)
        state.access.add(access)
        state.refresh.add(refresh)
        return {"access_token": access, "refresh_token": refresh, "token_type": "Bearer",
                "expires_in": state.expires_in, "scope": "read"}

    async def token(request: Request):
        raw = (await request.body()).decode()
        data = {key: values[0] for key, values in parse_qs(raw).items()}
        state.requests.append(("token", {key: "[secret]" if key in (
            "code", "code_verifier", "refresh_token") else value for key, value in data.items()}))
        if state.force_unavailable:
            return JSONResponse({"error": "temporarily_unavailable"}, status_code=503)
        if data.get("resource") != state.resource or data.get("client_id") not in state.clients:
            return JSONResponse({"error": "invalid_target"}, status_code=400)
        if data.get("grant_type") == "authorization_code":
            saved = state.codes.pop(data.get("code"), None)
            if not saved or saved[:2] != (data["client_id"], data.get("redirect_uri")):
                return JSONResponse({"error": "invalid_grant"}, status_code=400)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(
                data.get("code_verifier", "").encode()).digest()).rstrip(b"=").decode()
            if challenge != saved[2]:
                return JSONResponse({"error": "invalid_grant"}, status_code=400)
            return JSONResponse(issue())
        if data.get("grant_type") == "refresh_token":
            state.refresh_started.set()
            if state.refresh_release is not None:
                await state.refresh_release.wait()
            refresh_token = data.get("refresh_token")
            if state.force_invalid_grant or refresh_token not in state.refresh:
                return JSONResponse({"error": "invalid_grant"}, status_code=400)
            state.refresh.remove(refresh_token)
            updated = issue()
            state.refresh_rotated.set()
            if state.refresh_response_release is not None:
                await state.refresh_response_release.wait()
            return JSONResponse(updated)
        return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)

    async def revoke(request: Request):
        data = {key: values[0] for key, values in parse_qs((await request.body()).decode()).items()}
        token_value = data.get("token")
        state.revocations.append(data.get("token_type_hint"))
        state.access.discard(token_value)
        state.refresh.discard(token_value)
        return Response(status_code=200)

    async def mcp(request: Request):
        bearer = request.headers.get("authorization", "")
        if not bearer.startswith("Bearer ") or bearer[7:] not in state.access:
            if request.method == "POST":
                body = await request.json()
                if body.get("method") == "tools/call":
                    state.denied_calls += 1
            challenge = f'Bearer resource_metadata="{state.origin}/.well-known/oauth-protected-resource/mcp"'
            return Response(status_code=401, headers={
                "WWW-Authenticate": challenge + (', scope="read"' if state.challenge_scope else ""),
            })
        if request.method == "GET" and state.stream_get:
            async def events():
                state.get_stream_started.set()
                while True:
                    yield b": heartbeat\n\n"
                    await asyncio.sleep(0.05)
            return StreamingResponse(events(), media_type="text/event-stream")
        if request.method in ("GET", "DELETE"):
            return Response(status_code=405)
        body = await request.json()
        if body.get("method") == "notifications/initialized":
            return Response(status_code=202)
        method = body.get("method")
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "controlled-oauth-mcp", "version": "1.0"}}
        elif method == "tools/list":
            result = {"tools": [
                {"name": "read_note", "description": "Read a controlled fixture note",
                 "inputSchema": {"type": "object", "properties": {}},
                 "annotations": {"readOnlyHint": True}},
                {"name": "echo_bearer", "description": "Exercise credential redaction",
                 "inputSchema": {"type": "object", "properties": {}},
                 "annotations": {"readOnlyHint": True}},
            ]}
        elif method == "tools/call" and body.get("params", {}).get("name") == "read_note":
            result = {"content": [{"type": "text", "text": "controlled note"}], "isError": False}
        elif method == "tools/call" and body.get("params", {}).get("name") == "echo_bearer":
            result = {"content": [{"type": "text", "text": bearer[7:]}], "isError": False}
        else:
            return JSONResponse({"jsonrpc": "2.0", "id": body.get("id"), "error": {
                "code": -32601, "message": "Method not found"}}, status_code=200)
        state.requests.append(("mcp", method))
        return JSONResponse({"jsonrpc": "2.0", "id": body["id"], "result": result},
                            headers={"MCP-Protocol-Version": "2025-06-18"})

    return Starlette(routes=[
        Route("/.well-known/oauth-protected-resource/mcp", prm),
        Route("/.well-known/oauth-protected-resource/mcp/team", prm),
        Route("/.well-known/oauth-authorization-server", as_metadata),
        Route("/register", register, methods=["POST"]),
        Route("/authorize", authorize),
        Route("/token", token, methods=["POST"]),
        Route("/revoke", revoke, methods=["POST"]),
        Route("/mcp", mcp, methods=["GET", "POST", "DELETE"]),
        Route("/mcp/team", mcp, methods=["GET", "POST", "DELETE"]),
    ])


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18888)
    args = parser.parse_args()
    uvicorn.run(create_app(ProtocolState(f"http://127.0.0.1:{args.port}")), host="127.0.0.1",
                port=args.port, access_log=False)
