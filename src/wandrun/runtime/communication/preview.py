"""Execution-scoped ownership of transient human previews.

The adapter sees this scope through a ContextVar; shared model objects never hold a
current task. All callbacks are synchronous, so sealing precedes task cancellation.
"""

import logging
from collections.abc import Callable
from contextvars import ContextVar
from uuid import uuid4

from langgraph.errors import GraphBubbleUp


logger = logging.getLogger(__name__)


class PreviewPersistenceError(RuntimeError):
    """A failed durable interrupted-preview write; the user command must fail."""

class PreviewExecution:
    """Own one Worker execution and its independent model request attempts."""

    def __init__(self, sender: str, callback: Callable[[str, dict], list[dict] | None]):
        self.sender = sender
        self.execution_id = uuid4().hex
        self._callback = callback
        self._active: dict[str, str] = {}
        self._open_attempts: set[str] = set()
        self._closed = False
        self._close_emitted = False
        try:
            self._callback(self.sender, {"kind": "start", "execution_id": self.execution_id})
        except GraphBubbleUp:
            raise
        except Exception:
            logger.exception("Preview start observer failed for execution %s", self.execution_id)
            self._disable()

    @property
    def enabled(self) -> bool:
        return not self._closed

    def begin(self) -> str:
        """Start a fresh HTTP attempt; a sealed execution cannot publish it."""
        identity = uuid4().hex
        if not self._closed:
            self._open_attempts.add(identity)
        return identity

    def update(self, attempt_id: str, output_index: int, message_index: int, text: str,
               phase: str | None) -> str | None:
        if self._closed or attempt_id not in self._open_attempts:
            return None
        draft_id = f"{self.execution_id}:{attempt_id}:{output_index}:{message_index}"
        self._active[draft_id] = attempt_id
        try:
            self._callback(self.sender, {
                "kind": "update", "draft_id": draft_id,
                "execution_id": self.execution_id, "attempt_id": attempt_id,
                "text": text, "phase": phase,
            })
        except GraphBubbleUp:
            raise
        except Exception:
            logger.exception("Preview update observer failed for execution %s", self.execution_id)
            self._disable()
            return None
        return draft_id

    def id_for(self, attempt_id: str, output_index: int, message_index: int) -> str | None:
        identity = f"{self.execution_id}:{attempt_id}:{output_index}:{message_index}"
        return identity if identity in self._active and not self._closed else None

    def end(self, draft_ids: list[str]) -> None:
        ended = [identity for identity in draft_ids if self._active.pop(identity, None) is not None]
        if ended and not self._close_emitted:
            try:
                self._callback(self.sender, {
                    "kind": "end", "execution_id": self.execution_id, "draft_ids": ended,
                })
            except GraphBubbleUp:
                raise
            except Exception:
                logger.exception("Preview end observer failed for execution %s", self.execution_id)
                self._disable()

    def complete_attempt(self, attempt_id: str) -> None:
        """Stop late deltas without losing draft identity needed for formal delivery."""
        self._open_attempts.discard(attempt_id)

    def failed_attempt(self, attempt_id: str) -> None:
        self._open_attempts.discard(attempt_id)
        self.end([identity for identity, owner in self._active.items() if owner == attempt_id])

    def _emit_close(self) -> None:
        if self._close_emitted:
            return
        self._close_emitted = True
        try:
            self._callback(self.sender, {"kind": "close", "execution_id": self.execution_id})
        except GraphBubbleUp:
            raise
        except Exception:
            logger.exception("Preview close observer failed for execution %s", self.execution_id)

    def _disable(self) -> None:
        self._closed = True
        self._open_attempts.clear()
        self._active.clear()
        self._emit_close()

    def disable(self) -> None:
        """A parser failure cannot affect the authoritative model response."""
        if not self._closed:
            self._disable()

    def close(self) -> None:
        if self._close_emitted:
            return
        self._open_attempts.clear()
        self._closed = True
        self.end(list(self._active))
        self._emit_close()

    def interrupt(self) -> list[dict]:
        """Seal then freeze; durable failure rejects the command, graph control flow propagates."""
        if self._close_emitted:
            return []
        self._closed = True
        self._open_attempts.clear()
        identities = list(self._active)
        self._active.clear()
        try:
            if identities:
                return self._callback(self.sender, {
                    "kind": "interrupt", "execution_id": self.execution_id,
                    "draft_ids": identities,
                }) or []
            return []
        except (PreviewPersistenceError, GraphBubbleUp):
            raise
        except Exception:
            logger.exception("Preview interrupt observer failed for execution %s", self.execution_id)
            return []
        finally:
            self._emit_close()


current_preview: ContextVar[PreviewExecution | None] = ContextVar("wandrun_human_preview", default=None)
