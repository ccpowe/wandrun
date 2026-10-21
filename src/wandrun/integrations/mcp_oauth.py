"""Non-interactive MCP credentials and explicit OAuth DCR/PKCE or GitHub device flow.

The MCP SDK performs DCR discovery, registration and code exchange; GitHub's fixed
public client uses device authorization. Persistence belongs to the gateway adapter.
"""

import asyncio
import hmac
import contextvars
import logging
import math
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qs, urlsplit

import httpx2
from pydantic import PrivateAttr
from mcp.client.auth import OAuthClientProvider
from mcp.client.auth.oauth2 import (
    build_oauth_authorization_server_metadata_discovery_urls,
    build_protected_resource_metadata_discovery_urls,
    extract_resource_metadata_from_www_auth,
)
from mcp.client.auth.exceptions import OAuthRegistrationError
from mcp.shared.auth_utils import check_resource_allowed
from mcp.shared.auth import (
    AuthorizationCodeResult, OAuthClientInformationFull, OAuthClientMetadata,
    OAuthMetadata, OAuthToken, ProtectedResourceMetadata,
)


GITHUB_CLIENT_ID = "Ov23liQv3AmAOoua0HD3"
GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
_GITHUB_DEVICE_URL = "https://github.com/login/device"
_GITHUB_CODE_ENDPOINT = "https://github.com/login/device/code"
_GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token"
_GITHUB_SCOPE = "repo read:org offline_access"
_GITHUB_GRANT = "urn:ietf:params:oauth:grant-type:device_code"



class OAuthIssue(ValueError):
    """A classified, safe-to-display OAuth failure; never contains a remote response."""

    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.status = code, status


class OAuthUnavailable(OAuthIssue):
    def __init__(self, status: str = "unauthorized"):
        super().__init__("authorization_required", "连接器需要重新授权" if status == "reauthorization_required" else "连接器需要授权")

class OAuthRecords(Protocol):
    def connector_definitions(self) -> dict[str, dict]: ...
    def oauth_record(self, identity: str) -> tuple[int, dict | None]: ...
    def save_oauth(self, identity: str, generation: int, record: dict | None) -> bool: ...
    def invalidate_oauth(self, identity: str, **kwargs) -> int | None: ...
    def connector_status_changed(self, identity: str) -> object: ...


_secret_source: contextvars.ContextVar[Callable[[], tuple[str, ...]] | None] = contextvars.ContextVar(
    "mcp_oauth_secrets", default=None,
)


@contextmanager
def oauth_log_scope(source: Callable[[], tuple[str, ...]]):
    token = _secret_source.set(source)
    try:
        yield
    finally:
        _secret_source.reset(token)


def oauth_secrets() -> tuple[str, ...]:
    source = _secret_source.get()
    return source() if source is not None else ()



def _safe_url(url: str, *, origin: str | None = None) -> bool:
    try:
        parsed = urlsplit(url)
        if parsed.username or parsed.password or parsed.fragment or not parsed.hostname or parsed.query:
            return False
        if parsed.scheme == "https":
            return True
        return parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1") and (
            origin is None or urlsplit(origin).hostname in ("127.0.0.1", "localhost", "::1")
        )
    except ValueError:
        return False


class _ResourceScopedMetadata(OAuthClientMetadata):
    """Keep SDK discovery from widening the agreed resource scope before DCR."""

    _requested_scope: str | None = PrivateAttr(default=None)
    _scope_locked: bool = PrivateAttr(default=False)

    def lock_scope(self) -> None:
        self._requested_scope = self.scope
        self._scope_locked = True

    def __setattr__(self, name, value):
        if name == "scope" and getattr(self, "_scope_locked", False):
            value = self._requested_scope
        super().__setattr__(name, value)


@dataclass
class _Pending:
    identity: str
    generation: int
    state: str
    issuer: str
    redirect: str
    expires_at: float
    published: asyncio.Future
    callback: asyncio.Future
    task: asyncio.Task | None = None
    error: OAuthIssue | None = None


@dataclass
class _DevicePending:
    identity: str
    generation: int
    attempt: int
    stop: asyncio.Event
    published: asyncio.Future
    expires_at: float = 0
    task: asyncio.Task | None = None


class _Storage:
    def __init__(self, owner: "ConnectorOAuth", pending: _Pending, metadata: dict):
        self.owner, self.pending, self.metadata = owner, pending, metadata
        self.identity, self.generation = pending.identity, pending.generation

    async def get_tokens(self):
        return None  # Explicit start always asks the user; existing authorization stays usable until replacement.

    async def get_client_info(self):
        generation, record = self.owner.store.oauth_record(self.identity)
        if generation != self.generation or record is None or record.get("url") != self.metadata["url"]:
            return None
        registration = record.get("pending_registration")
        if not registration or registration.get("oauth_metadata") != self.metadata["oauth_metadata"]:
            registration = record
        client = registration.get("client")
        if (client and registration.get("issuer") == self.metadata["issuer"]
                and registration.get("redirect") == self.metadata["redirect"]
                and registration.get("url") == self.metadata["url"]
                and registration.get("oauth_metadata") == self.metadata["oauth_metadata"]):
            return OAuthClientInformationFull.model_validate(client)
        return None

    async def set_client_info(self, client):
        if (client.token_endpoint_auth_method != "none" or client.client_secret
                or self.owner.redirect not in {str(uri) for uri in client.redirect_uris}):
            raise OAuthIssue("unsupported_oauth", "授权服务器未注册所需的公共客户端回调")
        generation, record = self.owner.store.oauth_record(self.identity)
        if generation != self.generation or self.owner._pending.get(self.identity) is not self.pending:
            raise OAuthUnavailable()
        registered = {**self.metadata, "client": client.model_dump(mode="json")}
        if record and record.get("tokens"):
            next_record = {**record, "pending_registration": registered}
        else:
            next_record = {**(record or {}), **registered}
        self.owner._save(self.identity, self.generation, next_record)

    async def set_tokens(self, tokens):
        generation, record = self.owner.store.oauth_record(self.identity)
        if (generation != self.generation or record is None
                or self.owner._pending.get(self.identity) is not self.pending):
            raise OAuthUnavailable()
        next_generation = self.owner.store.invalidate_oauth(
            self.identity, expected_generation=self.generation,
        )
        if next_generation is None:
            raise OAuthUnavailable()
        registration = record.get("pending_registration")
        if not registration or registration.get("oauth_metadata") != self.metadata["oauth_metadata"]:
            registration = record
        next_record = {**record, **registration, "tokens": tokens.model_dump(mode="json"),
                       "expires_at": time.time() + tokens.expires_in if tokens.expires_in is not None else None,
                       "status": "authorized"}
        next_record.pop("pending_registration", None)
        self.owner._save(self.identity, next_generation, next_record)
        self.owner._remember_tokens(self.identity, tokens.access_token, tokens.refresh_token)


class ConnectorOAuth:
    """Owner for explicit transactions, durable generations, refresh and invalidation."""

    def __init__(self, store: OAuthRecords, *, port: int, public_url: str | None = None):
        self.store = store
        self.port = port
        self.redirect = (public_url.rstrip("/") if public_url else f"http://127.0.0.1:{port}") + "/oauth/callback"
        self.manual_callback = public_url is None
        self._pending: dict[str, _Pending] = {}
        self._device_pending: dict[str, _DevicePending] = {}
        self._device_attempts: dict[str, int] = {}
        self._device_errors: dict[str, tuple[int, OAuthIssue]] = {}
        self._closing = False
        self._auth_tasks: set[asyncio.Task] = set()
        self._refresh_tasks: dict[tuple[str, int], asyncio.Task[str]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.on_change = None
        self.on_authorized = None
        self.on_invalidate = None
        self._cleanup_tasks: set[asyncio.Task] = set()
        self._secret_history: dict[str, set[str]] = {}
        # The SDK logs raw exceptions (including token/code body) on failure; no SDK
        # OAuth diagnostics may escape its protocol boundary into gateway logs.
        logging.getLogger("mcp.client.auth.oauth2").disabled = True
        for definition in store.connector_definitions().values():
            if definition.get("auth_type") == "oauth":
                _, record = store.oauth_record(definition["id"])
                if record and record.get("tokens"):
                    self._remember_tokens(
                        definition["id"], record["tokens"].get("access_token"),
                        record["tokens"].get("refresh_token"),
                    )

    def _remember_tokens(self, identity: str, *values: str | None) -> None:
        self._secret_history.setdefault(identity, set()).update(value for value in values if value)

    def secret_values(self, identity: str) -> tuple[str, ...]:
        return tuple(self._secret_history.get(identity, ()))

    def _save(self, identity: str, generation: int, record: dict | None) -> None:
        if not self.store.save_oauth(identity, generation, record):
            raise OAuthUnavailable()
        if self.on_change:
            self.on_change()

    def generation(self, identity: str) -> int:
        return self.store.oauth_record(identity)[0]

    def status(self, identity: str, auth_type: str) -> dict:
        if auth_type != "oauth":
            return {"status": "not_required", "authorizing": False, "scopes": []}
        generation, record = self.store.oauth_record(identity)
        pending = self._pending.get(identity)
        if pending is not None and (pending.expires_at <= time.time() or pending.task and pending.task.done()):
            self._pending.pop(identity, None)
            pending = None
        device = self._device_pending.get(identity)
        token = record.get("tokens") if record else None
        status = record.get("status", "unauthorized") if record else "unauthorized"
        if record and not self._matches_redirect(record) and status == "authorized":
            status, token = "reauthorization_required", None
        result = {"status": status, "authorizing": pending is not None or (
                      device is not None and not device.stop.is_set()),
                  "scopes": (token.get("scope") or "").split() if token else []}
        error = self._device_errors.get(identity)
        if error is not None and error[0] == generation:
            result["error"] = {"code": error[1].code, "message": str(error[1])}
        return result

    def _matches_redirect(self, record: dict) -> bool:
        if record.get("provider") == "github_device":
            return record.get("url") == GITHUB_MCP_URL
        return record.get("redirect") == self.redirect
    def authorized(self, identity: str, generation: int, resource_url: str) -> bool:
        current, record = self.store.oauth_record(identity)
        return bool(
            current == generation and record and record.get("status") == "authorized"
            and record.get("tokens") and self._matches_redirect(record)
            and record.get("url") == resource_url
        )
    async def _discover(self, url: str) -> dict:
        if not _safe_url(url):
            raise OAuthIssue("unsupported_oauth", "OAuth 服务必须使用 HTTPS", 400)
        try:
            async with httpx2.AsyncClient(timeout=10, follow_redirects=False) as client:
                response = await client.get(url, headers={"Accept": "application/json, text/event-stream"})
                if response.status_code == 429 or response.status_code >= 500:
                    raise OAuthIssue("oauth_unavailable", "OAuth 服务暂时不可用", 503)
                if response.status_code != 401:
                    raise OAuthIssue("unsupported_oauth", "远端未提供 OAuth 挑战")
                challenge = extract_resource_metadata_from_www_auth(response)
                candidates = build_protected_resource_metadata_discovery_urls(challenge, url)
                prm = None
                transient = False
                for candidate in candidates:
                    if not _safe_url(candidate, origin=url):
                        raise OAuthIssue("unsupported_oauth", "资源元数据地址不安全")
                    reply = await client.get(candidate)
                    if reply.status_code == 429 or reply.status_code >= 500:
                        transient = True
                    if reply.status_code == 200:
                        prm_url = candidate
                        try:
                            prm = ProtectedResourceMetadata.model_validate(reply.json())
                        except (ValueError, TypeError):
                            raise OAuthIssue("unsupported_oauth", "受保护资源元数据无效") from None
                        break
                if prm is None and transient:
                    raise OAuthIssue("oauth_unavailable", "资源元数据服务暂时不可用", 503)
                if prm is None or not check_resource_allowed(url, str(prm.resource)):
                    raise OAuthIssue("unsupported_oauth", "受保护资源元数据不匹配")
                if not prm.authorization_servers:
                    raise OAuthIssue("unsupported_oauth", "资源未声明授权服务器")
                issuer = str(prm.authorization_servers[0])
                if not _safe_url(issuer, origin=url):
                    raise OAuthIssue("unsupported_oauth", "授权服务器地址不安全")
                asm = None
                transient = False
                for candidate in build_oauth_authorization_server_metadata_discovery_urls(issuer, url):
                    if not _safe_url(candidate, origin=url):
                        raise OAuthIssue("unsupported_oauth", "授权元数据地址不安全")
                    reply = await client.get(candidate)
                    if reply.status_code == 429 or reply.status_code >= 500:
                        transient = True
                    if reply.status_code == 200:
                        try:
                            asm = OAuthMetadata.model_validate(reply.json())
                        except (ValueError, TypeError):
                            raise OAuthIssue("unsupported_oauth", "授权服务器元数据无效") from None
                        break
                if asm is None and transient:
                    raise OAuthIssue("oauth_unavailable", "授权元数据服务暂时不可用", 503)
                if asm is None or str(asm.issuer) != issuer:
                    raise OAuthIssue("unsupported_oauth", "授权服务器 issuer 不匹配")
                if not asm.registration_endpoint or "S256" not in (asm.code_challenge_methods_supported or []):
                    raise OAuthIssue("unsupported_oauth", "该服务暂不支持 DCR 与 PKCE S256 接入")
                endpoints = [asm.authorization_endpoint, asm.token_endpoint, asm.registration_endpoint]
                if asm.revocation_endpoint:
                    endpoints.append(asm.revocation_endpoint)
                if any(not _safe_url(str(endpoint), origin=issuer) for endpoint in endpoints):
                    raise OAuthIssue("unsupported_oauth", "授权服务器端点不安全")
                scope = response.headers.get("www-authenticate", "")
                import re
                matched = re.search(r'(?:^|[, ])scope="([^\"]*)"', scope)
                requested_scope = matched.group(1) if matched else " ".join(prm.scopes_supported or [])
                return {"url": url, "issuer": issuer, "resource": str(prm.resource),
                        "resource_metadata_url": prm_url,
                        "oauth_metadata": asm.model_dump(mode="json"),
                        "protected_metadata": prm.model_dump(mode="json"),
                        "scope": requested_scope, "redirect": self.redirect}
        except OAuthIssue:
            raise
        except (httpx2.HTTPError, ValueError, KeyError) as error:
            raise OAuthIssue("oauth_unavailable", "无法安全发现 OAuth 服务", 503) from None

    async def start(self, identity: str, url: str) -> dict:
        if self._closing:
            raise OAuthIssue("oauth_unavailable", "授权服务正在关闭", 503)
        self.cancel(identity)
        self._device_attempts[identity] = self._device_attempts.get(identity, 0) + 1
        self._device_errors.pop(identity, None)
        metadata = await self._discover(url)
        if self._closing:
            raise OAuthIssue("oauth_unavailable", "授权服务正在关闭", 503)
        generation, _ = self.store.oauth_record(identity)
        loop = asyncio.get_running_loop()
        pending = _Pending(identity, generation, "", metadata["issuer"], self.redirect,
                           time.time() + 600, loop.create_future(), loop.create_future())
        self._pending[identity] = pending
        self.store.connector_status_changed(identity)
        if self.on_change:
            self.on_change()
        pending.task = asyncio.create_task(self._authorize(pending, metadata))
        self._auth_tasks.add(pending.task)
        def settled(done):
            self._auth_tasks.discard(done)
            if not done.cancelled():
                done.exception()
        pending.task.add_done_callback(settled)
        try:
            return await asyncio.wait_for(asyncio.shield(pending.published), 30)
        except TimeoutError:
            self.cancel(identity)
            raise OAuthIssue("oauth_unavailable", "OAuth 授权准备超时", 503) from None

    async def start_github(self, identity: str, url: str) -> dict:
        """Issue a code only for the catalog's fixed GitHub MCP integration."""
        definition = self.store.connector_definitions().get(identity)
        if (url != GITHUB_MCP_URL or not definition or definition.get("app_id") != "github"
                or definition.get("url") != GITHUB_MCP_URL or definition.get("auth_type") != "oauth"):
            raise OAuthIssue("unsupported_oauth", "GitHub 授权仅适用于官方连接器", 400)
        if self._closing:
            raise OAuthIssue("oauth_unavailable", "授权服务正在关闭", 503)
        self.cancel(identity)
        attempt = self._device_attempts.get(identity, 0) + 1
        self._device_attempts[identity] = attempt
        self._device_errors.pop(identity, None)
        generation, record = self.store.oauth_record(identity)
        if generation == 0 and record is None:
            # Unlike DCR, device flow has no registration write to seed the CAS row.
            self._save(identity, generation, None)
        pending = _DevicePending(identity, generation, attempt, asyncio.Event(),
                                 asyncio.get_running_loop().create_future())
        pending.published.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        self._device_pending[identity] = pending
        self.store.connector_status_changed(identity)
        if self.on_change:
            self.on_change()
        pending.task = asyncio.create_task(self._github_device(pending))
        self._auth_tasks.add(pending.task)
        def settled(done):
            self._auth_tasks.discard(done)
            if not done.cancelled():
                done.exception()
        pending.task.add_done_callback(settled)
        try:
            return await asyncio.wait_for(asyncio.shield(pending.published), 30)
        except TimeoutError:
            if self._device_pending.get(identity) is pending:
                self.cancel(identity)
            raise OAuthIssue("oauth_unavailable", "GitHub 授权准备超时", 503) from None

    async def _device_wait(self, pending: _DevicePending, interval: float) -> bool:
        try:
            await asyncio.wait_for(
                pending.stop.wait(), min(interval, max(0, pending.expires_at - time.time())),
            )
            return True
        except TimeoutError:
            return False

    async def _github_device(self, pending: _DevicePending) -> None:
        identity = pending.identity
        try:
            with oauth_log_scope(lambda: self.secret_values(identity)):
                async with httpx2.AsyncClient(timeout=15, follow_redirects=False) as client:
                    response = await client.post(
                        _GITHUB_CODE_ENDPOINT, data={"client_id": GITHUB_CLIENT_ID, "scope": _GITHUB_SCOPE},
                        headers={"Accept": "application/json"},
                    )
                    if response.status_code != 200:
                        raise OAuthIssue("oauth_unavailable", "GitHub 授权服务暂时不可用", 503)
                    issued = response.json()
                    if not isinstance(issued, dict) or issued.get("error"):
                        raise OAuthIssue("oauth_unavailable", "GitHub 授权服务暂时不可用", 503)
                    code, user_code = issued.get("device_code"), issued.get("user_code")
                    if (not isinstance(code, str) or not code or not isinstance(user_code, str) or not user_code
                            or issued.get("verification_uri") != _GITHUB_DEVICE_URL
                            or not isinstance(issued.get("expires_in"), (int, float))
                            or isinstance(issued["expires_in"], bool) or issued["expires_in"] <= 0
                            or not math.isfinite(issued["expires_in"])
                            or not isinstance(issued.get("interval"), (int, float))
                            or isinstance(issued["interval"], bool) or issued["interval"] < 0
                            or not math.isfinite(issued["interval"])):
                        raise OAuthIssue("oauth_unavailable", "GitHub 授权响应无效", 503)
                    self._remember_tokens(identity, code)
                    pending.expires_at = time.time() + issued["expires_in"]
                    interval = max(1, issued["interval"])
                    if pending.stop.is_set() or self._device_attempts.get(identity) != pending.attempt:
                        return
                    pending.published.set_result({
                        "flow": "device_code", "authorization_url": _GITHUB_DEVICE_URL,
                        "user_code": user_code, "expires_at": pending.expires_at,
                    })
                    while time.time() < pending.expires_at:
                        if await self._device_wait(pending, interval):
                            return
                        if time.time() >= pending.expires_at or pending.stop.is_set():
                            break
                        response = await client.post(
                            _GITHUB_TOKEN_ENDPOINT,
                            data={"client_id": GITHUB_CLIENT_ID, "device_code": code, "grant_type": _GITHUB_GRANT},
                            headers={"Accept": "application/json"},
                        )
                        body = response.json()
                        if not isinstance(body, dict):
                            raise OAuthIssue("oauth_unavailable", "GitHub 授权响应无效", 503)
                        error = body.get("error")
                        if error == "authorization_pending" and response.status_code in (200, 400):
                            continue
                        if error == "slow_down" and response.status_code in (200, 400):
                            interval += 5
                            suggested = body.get("interval")
                            if (isinstance(suggested, (int, float)) and not isinstance(suggested, bool)
                                    and math.isfinite(suggested)):
                                interval = max(interval, suggested)
                            continue
                        if error == "access_denied" and response.status_code in (200, 400):
                            raise OAuthIssue("oauth_denied", "用户未同意 GitHub 授权")
                        if error in ("expired_token", "token_expired") and response.status_code in (200, 400):
                            raise OAuthIssue("oauth_expired", "GitHub 授权码已过期")
                        if response.status_code != 200 or error:
                            raise OAuthIssue("oauth_unavailable", "GitHub 授权服务暂时不可用", 503)
                        tokens = OAuthToken.model_validate(body).model_dump(mode="json")
                        if tokens.get("token_type", "").lower() != "bearer":
                            raise OAuthIssue("oauth_unavailable", "GitHub 授权响应无效", 503)
                        tokens["scope"] = " ".join((tokens.get("scope") or "").replace(",", " ").split())
                        # Cancel stops further polling, but a completed exchange must be
                        # committed unless a newer start or revoke fenced this generation.
                        if self._device_attempts.get(identity) != pending.attempt:
                            return
                        next_generation = self.store.invalidate_oauth(
                            identity, expected_generation=pending.generation,
                        )
                        if next_generation is None:
                            return
                        record = {
                            "provider": "github_device", "url": GITHUB_MCP_URL,
                            "tokens": tokens, "status": "authorized",
                            "expires_at": time.time() + tokens["expires_in"]
                            if tokens.get("expires_in") is not None else None,
                        }
                        self._save(identity, next_generation, record)
                        self._remember_tokens(identity, tokens["access_token"], tokens.get("refresh_token"))
                        self._device_errors.pop(identity, None)
                        if self.on_authorized:
                            await self.on_authorized(identity, next_generation)
                        return
                    raise OAuthIssue("oauth_expired", "GitHub 授权码已过期")
        except Exception as error:
            issue = error if isinstance(error, OAuthIssue) else OAuthIssue(
                "oauth_unavailable", "GitHub 授权服务暂时不可用", 503,
            )
            if not pending.published.done():
                pending.published.set_exception(issue)
            elif (not pending.stop.is_set() and self._device_pending.get(identity) is pending
                    and self._device_attempts.get(identity) == pending.attempt
                    and self.generation(identity) == pending.generation):
                self._device_errors[identity] = (pending.generation, issue)
        finally:
            if self._device_pending.get(identity) is pending:
                self._device_pending.pop(identity, None)
                self.store.connector_status_changed(identity)
                if self.on_change:
                    self.on_change()

    async def _authorize(self, pending: _Pending, metadata: dict) -> None:
        async def redirect(url):
            query = parse_qs(urlsplit(url).query)
            context = provider.context
            asm = context.oauth_metadata
            expected_endpoint = metadata["oauth_metadata"]["authorization_endpoint"]
            actual = urlsplit(url)
            endpoint = urlsplit(expected_endpoint)
            if (asm is None or str(asm.issuer) != metadata["issuer"]
                    or str(asm.authorization_endpoint) != expected_endpoint
                    or str(asm.token_endpoint) != metadata["oauth_metadata"]["token_endpoint"]
                    or str(asm.registration_endpoint) != metadata["oauth_metadata"]["registration_endpoint"]
                    or (actual.scheme, actual.netloc, actual.path) !=
                       (endpoint.scheme, endpoint.netloc, endpoint.path)
                    or not _safe_url(expected_endpoint, origin=metadata["issuer"])
                    or query.get("code_challenge_method") != ["S256"]
                    or query.get("resource") != [metadata["resource"]]
                    or query.get("redirect_uri") != [self.redirect]
                    or query.get("scope", [None]) != [metadata["scope"] or None]
                    or len(query.get("state", [])) != 1):
                raise OAuthIssue("unsupported_oauth", "授权参数与资源元数据不匹配")
            pending.state = query["state"][0]
            if not pending.published.done():
                pending.published.set_result({"flow": "authorization_code",
                                              "authorization_url": url, "expires_at": pending.expires_at,
                                              "redirect_uri": self.redirect, "manual_callback": self.manual_callback})

        async def callback():
            return await pending.callback

        client_metadata = _ResourceScopedMetadata(
            client_name="Wandrun MCP", redirect_uris=[self.redirect,
                f"http://127.0.0.1:{self.port}/oauth/callback"] if not self.manual_callback else [self.redirect],
            scope=metadata["scope"] or None, token_endpoint_auth_method="none",
            grant_types=["authorization_code", "refresh_token"], response_types=["code"],
        )
        client_metadata.lock_scope()
        provider = OAuthClientProvider(
            metadata["url"], client_metadata, _Storage(self, pending, metadata), redirect, callback,
        )
        allowed = {metadata["url"], metadata["oauth_metadata"]["registration_endpoint"],
                   metadata["oauth_metadata"]["token_endpoint"]}
        allowed.add(metadata["resource_metadata_url"])
        allowed.update(build_protected_resource_metadata_discovery_urls(None, metadata["url"]))
        allowed.update(build_oauth_authorization_server_metadata_discovery_urls(metadata["issuer"], metadata["url"]))
        # The challenge URL may be a nonstandard well-known location; restrict it to
        # the resource's origin and metadata path, never forward credentials there.
        async def guard(request):
            target = str(request.url)
            if target not in allowed and not (request.method == "GET" and
                urlsplit(target).netloc == urlsplit(metadata["url"]).netloc and
                urlsplit(target).path.startswith("/.well-known/oauth-protected-resource")):
                raise OAuthIssue("unsupported_oauth", "OAuth 请求目标超出已验证端点")
        async def classify_response(response):
            target = str(response.request.url)
            status = response.status_code
            if target == metadata["oauth_metadata"]["registration_endpoint"]:
                if status == 429 or status >= 500:
                    raise OAuthIssue("oauth_unavailable", "客户端注册服务暂时不可用", 503)
                if status not in (200, 201):
                    raise OAuthIssue("unsupported_oauth", "授权服务器未接受公共客户端动态注册")
            elif target == metadata["oauth_metadata"]["token_endpoint"] and status >= 400:
                if status == 400:
                    await response.aread()
                    try:
                        error_code = response.json().get("error")
                    except (ValueError, TypeError, AttributeError):
                        error_code = None
                    if error_code == "invalid_grant":
                        raise OAuthIssue("invalid_callback", "授权码无效或已过期", 400)
                raise OAuthIssue("oauth_unavailable", "授权服务器未能兑换凭据", 503)
        try:
            with oauth_log_scope(lambda: self.secret_values(pending.identity)):
                async with asyncio.timeout(max(0, pending.expires_at - time.time())):
                    async with httpx2.AsyncClient(auth=provider, timeout=15, follow_redirects=False,
                                                  event_hooks={"request": [guard], "response": [classify_response]}) as client:
                        async with client.stream("GET", metadata["url"],
                                                 headers={"Accept": "application/json, text/event-stream"}):
                            pass  # A live MCP SSE GET must not delay authorization completion.
            if self._pending.get(pending.identity) is pending:
                self._pending.pop(pending.identity, None)
                self.store.connector_status_changed(pending.identity)
                if self.on_change:
                    self.on_change()
                if self.on_authorized:
                    await self.on_authorized(pending.identity, self.generation(pending.identity))
        except asyncio.CancelledError:
            if not pending.published.done():
                pending.published.set_exception(OAuthIssue("oauth_cancelled", "授权已取消"))
            raise
        except Exception as error:
            pending.error = error if isinstance(error, OAuthIssue) else (
                OAuthIssue("unsupported_oauth", "授权服务器不支持公共客户端动态注册")
                if isinstance(error, OAuthRegistrationError) else
                OAuthIssue("oauth_unavailable", "授权兑换或连接准备失败", 503)
            )
            if not pending.published.done():
                pending.published.set_exception(pending.error)
            if not pending.callback.done():
                pending.callback.set_exception(OAuthIssue("oauth_unavailable", "授权失败"))
                pending.callback.exception()
            if self._pending.get(pending.identity) is pending:
                self._pending.pop(pending.identity, None)
                self.store.connector_status_changed(pending.identity)
                if self.on_change:
                    self.on_change()

    def cancel(self, identity: str) -> None:
        pending = self._pending.pop(identity, None)
        device = self._device_pending.get(identity)  # Retain ownership until an in-flight exchange settles.
        error = self._device_errors.pop(identity, None)
        if pending:
            if pending.task:
                pending.task.cancel()
            if not pending.callback.done():
                pending.callback.cancel()
        if device:
            device.stop.set()
            if not device.published.done():
                device.published.set_exception(OAuthIssue("oauth_cancelled", "授权已取消"))
        if pending or device or error:
            self.store.connector_status_changed(identity)
            if self.on_change:
                self.on_change()

    async def callback(self, url: str, identity: str | None = None) -> str:
        """Validate a full URL locally; never fetch a user-supplied callback URL."""
        if len(url) > 8192 or url != url.strip() or any(ord(char) < 32 for char in url):
            raise OAuthIssue("invalid_callback", "回调地址无效", 400)
        try:
            parts = urlsplit(url)
            query = parse_qs(parts.query, keep_blank_values=True, strict_parsing=True)
        except ValueError:
            raise OAuthIssue("invalid_callback", "回调地址无效", 400) from None
        states = query.get("state", [])
        if any(not value.isascii() for value in states):
            raise OAuthIssue("invalid_callback", "授权状态无效", 400)
        candidate = self._pending.get(identity) if identity else next(
            (p for p in self._pending.values() if p.state and any(
                hmac.compare_digest(value, p.state) for value in states)), None)
        if candidate is None or candidate.expires_at <= time.time() or candidate.callback.done():
            raise OAuthIssue("invalid_callback", "授权事务不存在或已过期", 400)
        expected = urlsplit(candidate.redirect)
        if ((parts.scheme, parts.netloc, parts.path) != (expected.scheme, expected.netloc, expected.path)
                or parts.fragment or len(query.get("state", [])) != 1
                or not hmac.compare_digest(query["state"][0], candidate.state)
                or any(len(query.get(key, [])) != 1 for key in ("iss", "code") if key in query)
                or query.get("iss", [candidate.issuer])[0] != candidate.issuer):
            raise OAuthIssue("invalid_callback", "回调地址或授权参数不匹配", 400)
        asm = self.store.oauth_record(candidate.identity)[1]
        require_iss = (asm or {}).get("oauth_metadata", {}).get("authorization_response_iss_parameter_supported", False)
        if require_iss and "iss" not in query:
            raise OAuthIssue("invalid_callback", "回调缺少 issuer", 400)
        if "error" in query:
            candidate.callback.set_exception(OAuthIssue("oauth_denied", "用户未同意授权"))
            candidate.callback.exception()
            self._pending.pop(candidate.identity, None)
            self.store.connector_status_changed(candidate.identity)
            if self.on_change:
                self.on_change()
            raise OAuthIssue("oauth_denied", "用户未同意授权")
        if len(query.get("code", [])) != 1 or not query["code"][0]:
            raise OAuthIssue("invalid_callback", "回调缺少授权码", 400)
        candidate.callback.set_result(AuthorizationCodeResult(
            code=query["code"][0], state=candidate.state, iss=query.get("iss", [None])[0]))
        try:
            await asyncio.shield(candidate.task)
        except asyncio.CancelledError:
            raise OAuthIssue("oauth_cancelled", "授权已取消") from None
        if candidate.error is not None:
            raise candidate.error
        _, record = self.store.oauth_record(candidate.identity)
        if record is None or record.get("status") != "authorized":
            raise OAuthIssue("oauth_unavailable", "授权兑换失败，请重新授权", 503)
        return candidate.identity

    async def token(
        self, identity: str, generation: int, resource_url: str, *,
        rejected_access: str | None = None,
    ) -> str:
        """Share an owned refresh; cancelling a caller never abandons token rotation."""
        if self._closing:
            raise OAuthIssue("oauth_unavailable", "授权服务正在关闭", 503)
        current, record = self.store.oauth_record(identity)
        if (current != generation or not record or record.get("status") != "authorized"
                or not record.get("tokens") or not self._matches_redirect(record)
                or record.get("url") != resource_url):
            raise OAuthUnavailable("reauthorization_required" if record else "unauthorized")
        key = (identity, generation)
        task = self._refresh_tasks.get(key)
        if task is None:
            tokens = record["tokens"]
            if rejected_access is not None and tokens["access_token"] != rejected_access:
                return tokens["access_token"]
            if rejected_access is None and (
                record.get("expires_at") is None or record["expires_at"] > time.time()
            ):
                return tokens["access_token"]
            task = asyncio.create_task(self._active_token(
                identity, generation, resource_url, rejected_access=rejected_access,
            ))
            self._refresh_tasks[key] = task
            def settled(done):
                if self._refresh_tasks.get(key) is done:
                    del self._refresh_tasks[key]
                if not done.cancelled():
                    done.exception()  # Cancelled waiters do not own error reporting.
            task.add_done_callback(settled)
        return await asyncio.shield(task)

    async def _active_token(
        self, identity: str, generation: int, resource_url: str, *,
        rejected_access: str | None = None,
    ) -> str:
        """Single-flight refresh, bound to endpoint and authorization generation."""
        lock = self._locks.setdefault(identity, asyncio.Lock())
        async with lock:
            current, record = self.store.oauth_record(identity)
            if (current != generation or not record or record.get("status") != "authorized"
                    or not record.get("tokens") or not self._matches_redirect(record)
                    or record.get("url") != resource_url):
                raise OAuthUnavailable("reauthorization_required" if record else "unauthorized")
            tokens = record["tokens"]
            if rejected_access is not None and tokens["access_token"] != rejected_access:
                return tokens["access_token"]  # Another request already rotated it; never replay this call.
            if rejected_access is None and (
                record.get("expires_at") is None or record["expires_at"] > time.time()
            ):
                return tokens["access_token"]
            if not tokens.get("refresh_token"):
                self._expire_generation(identity, generation)
                raise OAuthUnavailable("reauthorization_required")
            github = record.get("provider") == "github_device"
            try:
                with oauth_log_scope(lambda: self.secret_values(identity)):
                    async with httpx2.AsyncClient(timeout=15, follow_redirects=False) as client:
                        data = {
                            "grant_type": "refresh_token", "refresh_token": tokens["refresh_token"],
                            "client_id": GITHUB_CLIENT_ID if github else record["client"]["client_id"],
                        }
                        if not github:
                            data["resource"] = record["resource"]
                        response = await client.post(
                            _GITHUB_TOKEN_ENDPOINT if github else record["oauth_metadata"]["token_endpoint"],
                            data=data, headers={"Accept": "application/json"} if github else None,
                        )
                        body = response.json() if response.status_code in (200, 400, 401) else {}
                        if not isinstance(body, dict):
                            raise OAuthIssue("oauth_unavailable", "授权服务暂时不可用", 503)
                        error_code = body.get("error")
                        if error_code in ({"invalid_grant", "bad_refresh_token"} if github else {"invalid_grant"}):
                            self._expire_generation(identity, generation)
                            raise OAuthUnavailable("reauthorization_required")
                        if response.status_code != 200 or error_code:
                            raise OAuthIssue("oauth_unavailable", "授权服务暂时不可用", 503)
                        updated = OAuthToken.model_validate(body).model_dump(mode="json")
                        if github:
                            if updated.get("token_type", "").lower() != "bearer":
                                raise OAuthIssue("oauth_unavailable", "GitHub 授权响应无效", 503)
                            updated["scope"] = " ".join((updated.get("scope") or tokens.get("scope") or "")
                                                        .replace(",", " ").split())
            except OAuthIssue:
                raise
            except (ValueError, httpx2.HTTPError):
                raise OAuthIssue("oauth_unavailable", "授权服务暂时不可用", 503) from None
            updated["refresh_token"] = updated.get("refresh_token") or tokens["refresh_token"]
            updated["scope"] = updated.get("scope") or tokens.get("scope")
            next_record = {**record, "tokens": updated,
                           "expires_at": time.time() + updated["expires_in"] if updated.get("expires_in") is not None else None}
            try:
                self._save(identity, generation, next_record)
            except OAuthUnavailable:
                raise  # A concurrent revoke or reauthorization won.
            except Exception:
                self._expire_generation(identity, generation)
                raise
            self._remember_tokens(identity, updated["access_token"], updated["refresh_token"])
            # A successful refresh retains this authorization generation and its
            # running MCP session. Only explicit revocation/invalid_grant retires it.
            return updated["access_token"]

    def _expire_generation(self, identity: str, generation: int) -> None:
        invalidated = self.store.invalidate_oauth(
            identity, reauthorization_required=True, expected_generation=generation,
        )
        if invalidated is not None:
            pending = self._device_pending.get(identity)
            if (pending is not None and pending.generation == generation
                    and self._device_attempts.get(identity) == pending.attempt):
                # Retiring old credentials is not an explicit revoke of the new consent.
                pending.generation = invalidated
            self._schedule_invalidation(identity, invalidated)

    def _schedule_invalidation(self, identity: str, generation: int) -> None:
        if self.on_invalidate is None:
            return
        task = asyncio.create_task(self.on_invalidate(identity, generation))
        self._cleanup_tasks.add(task)
        def settled(done):
            self._cleanup_tasks.discard(done)
            if not done.cancelled():
                done.exception()  # Gateway callback reports cleanup failure as fatal.
        task.add_done_callback(settled)

    async def revoke(self, identity: str, *, close) -> bool | None:
        self.cancel(identity)
        _, record = self.store.oauth_record(identity)
        self.store.invalidate_oauth(identity)
        if self.on_change:
            self.on_change()
        release_error = None
        try:
            await close(identity)
        except Exception as error:
            release_error = error
        revoked = None
        if (record and record.get("provider") != "github_device" and record.get("tokens")
                and record["oauth_metadata"].get("revocation_endpoint")):
            tokens = record["tokens"]
            self._remember_tokens(identity, tokens["access_token"], tokens.get("refresh_token"))
            revoked = True
            try:
                with oauth_log_scope(lambda: self.secret_values(identity)):
                    async with httpx2.AsyncClient(timeout=15, follow_redirects=False) as client:
                        for name in ("access_token", "refresh_token"):
                            token = tokens.get(name)
                            if not token or (name == "refresh_token" and token == tokens["access_token"]):
                                continue
                            try:
                                response = await client.post(record["oauth_metadata"]["revocation_endpoint"], data={
                                    "token": token, "token_type_hint": name,
                                    "client_id": record["client"]["client_id"],
                                })
                                revoked = response.status_code in (200, 204) and revoked
                            except httpx2.HTTPError:
                                revoked = False
            except httpx2.HTTPError:
                revoked = False
        if release_error is not None:
            raise release_error
        return revoked

    async def aclose(self):
        self._closing = True
        for identity in set(self._pending) | set(self._device_pending):
            self.cancel(identity)
        deadline = asyncio.get_running_loop().time() + 60
        while self._refresh_tasks or self._auth_tasks or self._cleanup_tasks:
            tasks = {*self._refresh_tasks.values(), *self._auth_tasks, *self._cleanup_tasks}
            try:
                await asyncio.wait_for(
                    asyncio.gather(*(asyncio.shield(task) for task in tasks), return_exceptions=True),
                    max(0, deadline - asyncio.get_running_loop().time()),
                )
            except TimeoutError:
                raise RuntimeError("OAuth 授权、刷新或失效清理未能确认完成") from None
            await asyncio.sleep(0)  # Let settled callbacks release task ownership.
