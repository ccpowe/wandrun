"""Gateway replay transport shared by history-material and direct-user protocols.

A root conversation timeline is NOT the union of its members' timelines. Callers
must select the addressed root or task explicitly; seq remains gateway-global.
"""

from __future__ import annotations

from typing import Any, Literal

import httpx

MAX_MESSAGE_CHARS = 20_000
_PAGE_SIZE = 200


class RunCaseError(RuntimeError):
    """Failed replay with partial evidence and an original exception as its cause."""

    def __init__(self, kind: str, result: dict[str, Any], message: str):
        super().__init__(message)
        self.kind = kind
        self.result = result


async def _post(client: httpx.AsyncClient, path: str, payload: dict) -> dict:
    response = await client.post(path, json=payload)
    response.raise_for_status()
    return response.json()


async def _events_since(
    client: httpx.AsyncClient, identity: str, submitted_seq: int, *,
    timeline: Literal["conversation", "task"],
) -> list[dict]:
    """Read one addressed timeline after acceptance, across newest-first pages.

    Each page is ascending and capped at 200 by the gateway. Member bodies are
    available only from /tasks/{id}/events, not the root preview timeline.
    """
    if timeline not in {"conversation", "task"}:
        raise ValueError("timeline must be conversation or task")
    resource = "conversations" if timeline == "conversation" else "tasks"
    pages: list[list[dict]] = []
    before: int | None = None
    while True:
        params = {"limit": _PAGE_SIZE}
        if before is not None:
            params["before"] = before
        response = await client.get(f"/{resource}/{identity}/events", params=params)
        response.raise_for_status()
        page = response.json()["events"]
        if not page:
            break
        pages.append(page)
        oldest = page[0]["seq"]
        if oldest <= submitted_seq or len(page) < _PAGE_SIZE:
            break
        if before is not None and oldest >= before:
            raise ValueError("gateway history pagination did not advance")
        before = oldest
    return [event for page in reversed(pages) for event in page if event["seq"] > submitted_seq]


def _kind(error: Exception) -> str:
    if isinstance(error, RunCaseError):
        return error.kind
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, httpx.HTTPStatusError):
        return "http_error"
    if isinstance(error, httpx.RequestError):
        return "network_failed"
    if isinstance(error, ValueError):
        return "invalid_case"
    return "lifecycle_error"
