"""Replay direct user turns against real gateway roots and collaboration tasks.

The caller owns the HTTP client, gateway, case isolation, and memory snapshots.
A replay owns only conversations it creates; it does not stop them between turns.
``turn`` returns accepted identity and post-acceptance raw events, including failures.
``child`` resolves task.created from the latest root turn against /tasks/{id}; a
member is never synthesized from its Agent ID. Failures raise RunCaseError with
partial evidence in ``result``; cancellation propagates after stop cleanup.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any
from uuid import uuid4

import httpx

from wandrun.evaluation.gateway_replay import (
    MAX_MESSAGE_CHARS, RunCaseError, _events_since, _kind, _post,
)

_AGENT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
_TASK_SETTLED = {"waiting", "completed", "failed", "cancelled", "unavailable"}


class MemoryReplay:
    """Own root conversations across turns; call ``finish`` after the scenario.

    ``timeout`` bounds each create, turn, child lookup and stop operation.
    Root turns settle on a post-acceptance idle/failed conversation status;
    child turns settle on a post-acceptance task status (waiting is valid).
    No model answer is required for a delegated or waiting task. On operational
    failure all owned roots are stopped and RunCaseError.result holds evidence.
    """

    def __init__(self, client: httpx.AsyncClient, timeout: float = 180):
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.client = client
        self.timeout = timeout
        self._roots: dict[str, str] = {}
        self._latest_root_seq: dict[str, int] = {}
        self._children: dict[str, dict[str, Any]] = {}

    async def create(self, agent_id: str, title: str, *,
                     required_workers: tuple[str, ...] = ()) -> str:
        """Create a root only if its required direct delegations are available.

        Required workers come from the scenario, not the Agent's answer. A live
        catalog miss raises unsupported_scenario with status=uncovered before
        creating a conversation or submitting a model-bound message.
        """
        if not isinstance(agent_id, str) or not _AGENT_ID.fullmatch(agent_id) or agent_id == "human":
            raise ValueError("invalid agent_id")
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValueError("conversation title must be 1–200 nonblank characters")
        if (not isinstance(required_workers, tuple)
                or any(not isinstance(worker, str) or not _AGENT_ID.fullmatch(worker)
                       for worker in required_workers)):
            raise ValueError("required_workers must be a tuple of Agent IDs")
        evidence: dict[str, Any] = {"agent_id": agent_id, "title": title, "conversation_id": None}
        try:
            async with asyncio.timeout(self.timeout):
                if required_workers:
                    response = await self.client.get(f"/agents/{agent_id}")
                    response.raise_for_status()
                    definition = response.json()
                    workers = definition.get("workers")
                    if (definition.get("id") != agent_id or not isinstance(workers, list)
                            or any(not isinstance(worker, str) for worker in workers)):
                        raise ValueError("invalid gateway delegation directory")
                    missing = [worker for worker in required_workers if worker not in workers]
                    if missing:
                        evidence.update(status="uncovered", required_workers=list(required_workers),
                                        available_workers=workers, missing_workers=missing)
                        raise RunCaseError("unsupported_scenario", evidence,
                                           f"unavailable direct delegation: {agent_id} -> {missing}")
                created = await _post(self.client, "/conversations", {"agent_id": agent_id, "title": title})
                identity = created["id"]
                evidence["conversation_id"] = identity
                if identity in self._roots:
                    raise ValueError("gateway reused an owned conversation ID")
                self._roots[identity] = agent_id
                return identity
        except BaseException as error:
            await self._failure(error, evidence)
            raise AssertionError("unreachable")

    async def turn(self, conversation_id: str, text: str, task_id: str | None = None) -> dict[str, Any]:
        """Submit one direct user message; return IDs, accepted event, events and outputs.

        For child feedback use a task ID returned by ``child``. The gateway
        requires POST /tasks/{id}/messages, *not* a task_id field on a root
        message. ``events`` excludes the accepted message (in ``accepted_event``)
        and belongs only to the addressed root/task timeline, not the whole
        branch. A failed Agent turn raises RunCaseError with this record as result.
        """
        if conversation_id not in self._roots:
            raise ValueError("conversation is not owned by this replay")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_MESSAGE_CHARS:
            raise ValueError(f"message must be nonblank text of at most {MAX_MESSAGE_CHARS} characters")
        child = self._children.get(task_id) if task_id is not None else None
        if task_id is not None and (child is None or child["root_id"] != conversation_id):
            raise ValueError("task_id must come from child() for this root")
        agent_id = child["agent_id"] if child else self._roots[conversation_id]
        record: dict[str, Any] = {
            "conversation_id": conversation_id, "root_id": conversation_id,
            "task_id": task_id or conversation_id, "agent_id": agent_id,
            "text": text, "submitted_seq": None, "accepted_event": None,
            "terminal_status": None, "events": [], "outputs": [],
        }
        try:
            async with asyncio.timeout(self.timeout):
                path = (f"/tasks/{task_id}/messages" if task_id is not None
                        else f"/conversations/{conversation_id}/messages")
                sent = await _post(self.client, path, {"client_id": str(uuid4()), "text": text})
                accepted = sent["event"]
                submitted_seq = accepted["seq"]
                record.update(accepted_event=accepted, submitted_seq=submitted_seq)
                if task_id is None:
                    self._latest_root_seq[conversation_id] = submitted_seq
                while True:
                    events = await _events_since(
                        self.client, task_id or conversation_id, submitted_seq,
                        timeline="task" if child else "conversation",
                    )
                    record["events"] = events
                    record["outputs"] = [
                        event["data"]["text"] for event in events
                        if event["type"] == "message.agent"
                        and event["data"].get("status") == "completed"
                        and (event["data"].get("task_id", conversation_id) == record["task_id"])
                    ]
                    statuses = [
                        event["data"]["status"] for event in events
                        if (event["type"] == ("task.status" if child else "conversation.status")
                            and (not child or event["data"].get("task_id") == task_id))
                    ]
                    if statuses and statuses[-1] in (_TASK_SETTLED if child else {"idle", "failed"}):
                        record["terminal_status"] = statuses[-1]
                        break
                    await asyncio.sleep(0.1)
                if record["terminal_status"] in {"failed", "cancelled", "unavailable"}:
                    failure = next((
                        event["data"].get("error") for event in reversed(events)
                        if (event["type"] == ("task.status" if child else "turn.failed")
                            and (not child or event["data"].get("task_id") == task_id))
                    ), None)
                    raise RunCaseError("agent_failed", record, str(failure or "Agent failed"))
                return record
        except BaseException as error:
            await self._failure(error, record)
            raise AssertionError("unreachable")

    async def child(self, conversation_id: str, agent_id: str) -> dict[str, Any]:
        """Find a real delegated direct child from the most recent root turn.

        Returns the gateway /tasks/{id} object with task_id, root_id,
        creator_task_id, agent_id and status. Old tasks, including those of the
        same Agent, cannot satisfy discovery. Raises on zero (timeout) or
        ambiguous matching tasks; operational failures stop owned roots.
        """
        if conversation_id not in self._latest_root_seq:
            raise ValueError("a root turn is required before child discovery")
        if not isinstance(agent_id, str) or not _AGENT_ID.fullmatch(agent_id):
            raise ValueError("invalid agent_id")
        evidence: dict[str, Any] = {
            "conversation_id": conversation_id, "root_id": conversation_id,
            "agent_id": agent_id, "after_seq": self._latest_root_seq[conversation_id], "events": [],
        }
        try:
            async with asyncio.timeout(self.timeout):
                while True:
                    events = await _events_since(
                        self.client, conversation_id, evidence["after_seq"], timeline="conversation",
                    )
                    evidence["events"] = events
                    matches = [e["data"] for e in events if e["type"] == "task.created"
                               and e["data"].get("agent_id") == agent_id
                               and e["data"].get("creator_task_id") == conversation_id]
                    if len(matches) > 1:
                        raise ValueError("multiple matching collaboration children")
                    if matches:
                        task_id = matches[0]["task_id"]
                        response = await self.client.get(f"/tasks/{task_id}")
                        response.raise_for_status()
                        task = response.json()
                        if (task.get("task_id") != task_id or task.get("root_id") != conversation_id
                                or task.get("creator_task_id") != conversation_id
                                or task.get("agent_id") != agent_id):
                            raise ValueError("collaboration identity does not match creation event")
                        self._children[task_id] = task
                        return task
                    await asyncio.sleep(0.1)
        except BaseException as error:
            await self._failure(error, evidence)
            raise AssertionError("unreachable")

    async def finish(self) -> None:
        """Stop owned roots; propagate termination after cleanup, ahead of ordinary errors.

        Stop failures remain retryable and are recorded as evidence/exception
        notes. Successful roots are forgotten. No conversations are deleted.
        """
        first_error: BaseException | None = None
        evidence: dict[str, Any] = {"stopped_ids": [], "stop_errors": {}}
        for identity in tuple(self._roots):
            try:
                async with asyncio.timeout(self.timeout):
                    await _post(self.client, f"/conversations/{identity}/stop", {"client_id": str(uuid4())})
                self._roots.pop(identity)
                evidence["stopped_ids"].append(identity)
            except BaseException as error:
                evidence["stop_errors"][identity] = f"{type(error).__name__}: {error}"
                if first_error is None or (isinstance(first_error, Exception)
                                           and not isinstance(error, Exception)):
                    first_error = error
        if first_error is not None:
            if not isinstance(first_error, Exception):
                for identity, message in evidence["stop_errors"].items():
                    first_error.add_note(f"stop cleanup failed for {identity}: {message}")
                raise first_error
            raise RunCaseError(_kind(first_error), evidence, str(first_error)) from first_error
        self._latest_root_seq.clear()
        self._children.clear()

    async def _failure(self, error: BaseException, evidence: dict[str, Any]) -> None:
        # A later cancellation must supersede an ordinary operation/cleanup error.
        termination = error if not isinstance(error, Exception) else None
        for identity in tuple(self._roots):
            try:
                async with asyncio.timeout(min(self.timeout, 5)):
                    await _post(self.client, f"/conversations/{identity}/stop", {"client_id": str(uuid4())})
                self._roots.pop(identity)
            except BaseException as cleanup_error:
                error.add_note(f"stop cleanup failed for {identity}: {cleanup_error}")
                if termination is None and not isinstance(cleanup_error, Exception):
                    termination = cleanup_error
        if termination is not None:
            if termination is not error:
                for note in getattr(error, "__notes__", ()):
                    termination.add_note(note)
                raise termination from error
            raise termination
        if isinstance(error, RunCaseError):
            raise error
        raise RunCaseError(_kind(error), evidence, str(error)) from error
