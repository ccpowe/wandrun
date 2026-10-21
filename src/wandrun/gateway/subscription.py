"""Private Codex catalog and quota snapshots for gateway read APIs.

The responses adapter owns authentication. The catalog retains the current
context_window (not max_context_window or subscription quota) for runtime budgeting.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Coroutine, Mapping
from typing import Any

import httpx

from wandrun.integrations.codex_credentials import CodexCredentials, CredentialError
from wandrun.integrations.codex_subscription import prepare_subscription_request


class SubscriptionUnavailable(RuntimeError):
    """No successful snapshot exists for the current login and compatibility version."""

    def __init__(self, code: str):
        message = (
            "暂时无法获取模型目录，不能保存新的模型与推理强度组合"
            if code == "model_catalog_unavailable"
            else "暂时无法获取订阅额度"
        )
        super().__init__(message)
        self.code = code


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _number(value: Any) -> int | float | None:
    return value if type(value) in (int, float) else None


def _models(payload: Any, fetched_at: float) -> dict:
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        raise ValueError("invalid model catalog")
    models = []
    for raw in payload["models"]:
        if not isinstance(raw, dict) or not isinstance(raw.get("slug"), str) or not raw["slug"]:
            raise ValueError("invalid catalog entry")
        if "visibility" in raw and not isinstance(raw["visibility"], str):
            raise ValueError("invalid visibility")
        if raw.get("visibility") != "list":
            continue
        raw_efforts = raw.get("supported_reasoning_levels")
        if raw_efforts is None:
            raw_efforts = []
        if not isinstance(raw_efforts, list):
            raise ValueError("invalid reasoning levels")
        efforts = []
        for option in raw_efforts:
            if not isinstance(option, dict) or not isinstance(option.get("effort"), str):
                raise ValueError("invalid reasoning level")
            if "description" in option and not isinstance(option["description"], str):
                raise ValueError("invalid reasoning description")
            if option["effort"] != "ultra":
                efforts.append({"effort": option["effort"], "description": _text(option.get("description")) or ""})
        for field in ("display_name", "description", "default_reasoning_level"):
            if raw.get(field) is not None and not isinstance(raw[field], str):
                raise ValueError(f"invalid {field}")
        if "priority" in raw and type(raw["priority"]) is not int:
            raise ValueError("invalid priority")
        # Catalog's current context budget, not its opt-in maximum. Use the raw
        # context_window unchanged; 80% triggering and output/tool headroom belong
        # to runtime budgeting (auto_compact_token_limit may be null).
        context_window = raw.get("context_window")
        if context_window is not None and (type(context_window) is not int or context_window <= 0):
            raise ValueError("invalid context_window")
        default = _text(raw.get("default_reasoning_level"))
        if default == "ultra":
            supported = [entry["effort"] for entry in efforts]
            default = "max" if "max" in supported else (supported[-1] if supported else "medium")
        models.append({
            "id": raw["slug"],
            "display_name": _text(raw.get("display_name")) or raw["slug"],
            "description": _text(raw.get("description")) or "",
            "default_reasoning_effort": default,
            "supported_reasoning_efforts": efforts,
            "visibility": "list",
            "priority": raw["priority"] if type(raw.get("priority")) is int else 0,
            "context_window": context_window,
        })
    return {"fetched_at": fetched_at, "models": models}


def _usage(payload: Any, fetched_at: float) -> dict:
    if not isinstance(payload, dict) or "rate_limit" not in payload:
        raise ValueError("invalid subscription usage")
    if payload.get("plan_type") is not None and not isinstance(payload["plan_type"], str):
        raise ValueError("invalid plan type")
    rate = payload["rate_limit"]
    if rate is not None and not isinstance(rate, dict):
        raise ValueError("invalid rate limit")
    rate = rate or {}
    for field in ("allowed", "limit_reached"):
        if rate.get(field) is not None and type(rate[field]) is not bool:
            raise ValueError(f"invalid {field}")
    windows = []

    def add_windows(bucket: Mapping, prefix: str = "") -> None:
        for key in ("primary", "secondary"):
            window = bucket.get(f"{key}_window")
            if window is None:
                continue
            if not isinstance(window, dict):
                raise ValueError("invalid rate limit window")
            for field in ("used_percent", "limit_window_seconds", "reset_at"):
                if field in window and _number(window[field]) is None:
                    raise ValueError(f"invalid {field}")
            used = _number(window.get("used_percent"))
            seconds = _number(window.get("limit_window_seconds"))
            reset = _number(window.get("reset_at"))
            # Incomplete windows are unknown, not zero usage or a guessed reset time.
            if used is None or seconds is None or reset is None:
                continue
            windows.append({
                "name": prefix + key,
                "used_percent": used,
                "window_seconds": seconds,
                "reset_at": reset,
            })

    add_windows(rate)
    additional = payload.get("additional_rate_limits")
    if additional is None:
        additional = []
    if not isinstance(additional, list):
        raise ValueError("invalid additional rate limits")
    for bucket in additional:
        if not isinstance(bucket, dict):
            raise ValueError("invalid additional rate limit")
        for field in ("limit_name", "metered_feature"):
            if bucket.get(field) is not None and not isinstance(bucket[field], str):
                raise ValueError(f"invalid {field}")
        name = _text(bucket.get("limit_name")) or _text(bucket.get("metered_feature"))
        nested = bucket.get("rate_limit")
        if nested is not None and not isinstance(nested, dict):
            raise ValueError("invalid additional bucket")
        if name and isinstance(nested, dict):
            add_windows(nested, name + ".")
    return {
        "plan_type": _text(payload.get("plan_type")),
        "allowed": rate.get("allowed") if type(rate.get("allowed")) is bool else None,
        "limit_reached": rate.get("limit_reached") if type(rate.get("limit_reached")) is bool else None,
        "windows": windows,
        "fetched_at": fetched_at,
    }


class SubscriptionData:
    """Lazy fixed-host reads with identity/version-scoped last-success snapshots.

    A forced refresh coalesces concurrent calls. Cancelling one caller does not cancel the
    shared request; failed upstream reads return the latest successful snapshot, including an
    empty catalog, but storage failures propagate rather than masquerading as upstream failure.
    """

    def __init__(
        self,
        store,
        *,
        client_version: str = "0.157.1",
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
        credentials: CodexCredentials | None = None,
    ) -> None:
        if not client_version:
            raise ValueError("client_version must be nonempty")
        self.store = store
        self.client_version = client_version
        self._transport = transport
        self._timeout = timeout
        self.credentials = credentials if credentials is not None else CodexCredentials()
        self._client: httpx.AsyncClient | None = None
        self._snapshots: dict[tuple[str, str, str], dict] = {}
        # Separate flights keep preparation tasks from awaiting each other.
        self._preparations: dict[tuple[str, str, str], asyncio.Task[tuple[dict, str]]] = {}
        self._refreshes: dict[tuple[str, str, str], asyncio.Task[tuple[dict, str]]] = {}
        self._closed = False

    async def models(self, refresh: bool = False) -> dict:
        snapshot = await self._get("models", refresh)
        visible = sorted(
            (model for model in snapshot["models"] if model["visibility"] == "list"),
            key=lambda model: model["priority"],
        )
        return {
            "models": [{key: model[key] for key in (
                "id", "display_name", "description", "default_reasoning_effort",
                "supported_reasoning_efforts", "context_window",
            )} for model in visible],
            "fetched_at": snapshot["fetched_at"],
        }

    async def usage(self, refresh: bool = False) -> dict:
        snapshot = await self._get("usage", refresh)
        return {key: snapshot[key] for key in (
            "plan_type", "allowed", "limit_reached", "windows", "fetched_at",
        )}

    async def status(self, refresh: bool = False) -> dict:
        """Current authentication is independent of the last successful quota read."""
        try:
            usage = await self.usage(refresh)
        except SubscriptionUnavailable:
            usage = None
        return {"auth": self.credentials.status(), "usage": usage}

    def _cached(self, key: tuple[str, str, str]) -> dict | None:
        if key not in self._snapshots:
            snapshot = self.store.load_subscription_snapshot(*key)
            if snapshot is not None:
                self._snapshots[key] = snapshot
        return self._snapshots.get(key)

    async def _get(self, kind: str, refresh: bool) -> dict:
        if self._closed:
            raise RuntimeError("subscription data is closed")
        code = "model_catalog_unavailable" if kind == "models" else "subscription_usage_unavailable"
        try:
            credential = self.credentials.peek()
        except RuntimeError:
            raise SubscriptionUnavailable(code) from None
        key = (kind, credential.identity, self.client_version)
        if refresh:
            # Register preparation before aget yields; a prepared request takes priority.
            task = self._refreshes.get(key) or self._preparations.get(key)
            if task is None:
                task = self._start_refresh(self._preparations, key, self._prepared(key, code, refresh=True))
            result, identity = await asyncio.shield(task)
        else:
            result, identity = await self._prepared(key, code, refresh=False)
        if not self._same_identity((kind, identity, self.client_version)):
            raise SubscriptionUnavailable(code)
        return result

    def _start_refresh(
        self, flights: dict[tuple[str, str, str], asyncio.Task[tuple[dict, str]]],
        key: tuple[str, str, str], work: Coroutine[Any, Any, tuple[dict, str]],
    ) -> asyncio.Task[tuple[dict, str]]:
        task = asyncio.create_task(work)
        flights[key] = task

        def clear(done: asyncio.Task) -> None:
            if flights.get(key) is done:
                del flights[key]
            # Nobody may still await after all waiters cancelled; consume that exception.
            if not done.cancelled():
                done.exception()

        task.add_done_callback(clear)
        return task

    async def _prepared(
        self, key: tuple[str, str, str], code: str, *, refresh: bool,
    ) -> tuple[dict, str]:
        try:
            credential = await self.credentials.aget()
        except CredentialError:
            if self._closed:
                raise RuntimeError("subscription data is closed") from None
            stale = self._cached(key)
            if stale is not None and self._same_identity(key):
                return stale, key[1]
            raise SubscriptionUnavailable(code) from None
        if self._closed:
            raise RuntimeError("subscription data is closed")
        key = (key[0], credential.identity, key[2])
        stale = self._cached(key)
        if not refresh:
            ttl = 300 if key[0] == "models" else 60
            if stale is not None and time.time() - stale["fetched_at"] < ttl:
                return stale, key[1]
        task = self._refreshes.get(key)
        if task is None:
            task = self._start_refresh(self._refreshes, key, self._refresh(key, credential, stale, code))
        return await asyncio.shield(task)

    async def _refresh(self, key: tuple[str, str, str], credential, stale: dict | None, code: str) -> tuple[dict, str]:
        try:
            if self._client is None:
                self._client = httpx.AsyncClient(
                    timeout=self._timeout, follow_redirects=False, transport=self._transport,
                )
            for attempt in range(2):
                request = prepare_subscription_request(key[0], client_version=self.client_version, credential=credential)
                response = await self._client.get(request.full_url, headers=dict(request.header_items()))
                if response.status_code == 401:
                    self.credentials.rejected(credential, retry_exhausted=bool(attempt))
                    if attempt == 0:
                        credential = await self.credentials.arecover(credential)
                        if credential.identity != key[1]:
                            key = (key[0], credential.identity, key[2])
                            stale = self._cached(key)
                        continue
                response.raise_for_status()
                self.credentials.accepted(credential)
                break
            payload = response.json()
            snapshot = (_models if key[0] == "models" else _usage)(payload, time.time())
        except (httpx.HTTPError, ValueError, KeyError, TypeError, CredentialError) as error:
            if not isinstance(error, CredentialError) and not (
                isinstance(error, httpx.HTTPStatusError) and error.response.status_code < 500
            ):
                self.credentials.temporary_failure(credential)
            if stale is None:
                raise SubscriptionUnavailable(code) from None
            return stale, key[1]
        if not self._same_identity(key):
            raise SubscriptionUnavailable(code)
        # Persisting is a separate failure domain: never claim an upstream error or hide it.
        self.store.save_subscription_snapshot(*key, snapshot)
        self._snapshots[key] = snapshot
        return snapshot, key[1]

    def _same_identity(self, key: tuple[str, str, str]) -> bool:
        try:
            return self.credentials.peek().identity == key[1]
        except RuntimeError:
            return False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        tasks = {*self._preparations.values(), *self._refreshes.values()}
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if self._client is not None:
            await self._client.aclose()
