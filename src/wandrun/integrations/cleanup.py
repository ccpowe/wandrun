"""Admitted request deadlines and short-lived, same-Agent connection facts.

Requests keep their own immutable deadline. Actual resource owners retain their
first close result; overlapping requests share decisions, not timers or retries.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field

LIMIT = 25.0


@dataclass
class Batch:
    """Same-Agent overlapping requests share decisions, never a deadline.

    A private connection belongs to the batch, not its first waiter. Its local
    handles expire at the latest still-participating request's fixed deadline.
    """

    machines: dict[object, asyncio.Future] = field(default_factory=dict)
    participants: dict[object, float] = field(default_factory=dict)
    _deciding: set[asyncio.Task] = field(default_factory=set)
    _handles: list[Callable[[], None]] = field(default_factory=list)
    _expiry: asyncio.TimerHandle | None = None
    on_empty: Callable[[], None] | None = None

    def join(self, operation: CleanupOperation, *, participant=None) -> None:
        self.participants[operation if participant is None else participant] = operation.deadline
        self._schedule_close()

    def leave(self, operation: CleanupOperation, *, participant=None) -> None:
        self.participants.pop(operation if participant is None else participant)
        self._schedule_close()
        if not self.participants:
            self.machines.clear()
            callback, self.on_empty = self.on_empty, None
            if callback is not None:
                callback()

    def track(self, operation: CleanupOperation, task: asyncio.Future) -> None:
        """Keep facts/handles until each actual resource or local-commit user ends."""
        self.join(operation, participant=task)
        task.add_done_callback(lambda finished: self.leave(operation, participant=finished))

    def retain(self, close) -> None:
        """Register synchronous, local-only release of a private cleanup handle."""
        self._handles.append(close)
        self._schedule_close()

    def _schedule_close(self) -> None:
        if self._expiry is not None:
            self._expiry.cancel()
            self._expiry = None
        if not self.participants:
            self._close_handles()
        elif self._handles:
            self._expiry = asyncio.get_running_loop().call_at(
                max(self.participants.values()), self._close_handles,
            )

    def _close_handles(self) -> None:
        handles, self._handles = self._handles, []
        for close in handles:
            close()


@dataclass(frozen=True, eq=False)
class CleanupOperation:
    """One admitted request: immutable deadline/policy plus its Agent's facts."""

    deadline: float
    remote: bool = True
    batch: Batch = field(default_factory=Batch)

    @classmethod
    def begin(cls, *, remote: bool = True, batch: Batch | None = None):
        return cls(asyncio.get_running_loop().time() + LIMIT, remote, batch or Batch())

    def remaining(self) -> float:
        return max(0.0, self.deadline - asyncio.get_running_loop().time())

    async def wait(self, awaitable):
        """Bound this resource's network wait without waiting for late cancellation."""
        task = asyncio.ensure_future(awaitable)
        try:
            async with asyncio.timeout_at(self.deadline):
                await asyncio.wait({task})
        except BaseException:
            task.cancel()
            task.add_done_callback(_consume)
            raise
        return task.result()

    def decide(self, identity, factory):
        """Publish before factory execution; shield each waiter from the others."""
        loop = asyncio.get_running_loop()
        if not self.remote or self.remaining() <= 0:
            skipped = loop.create_future()
            skipped.set_exception(OSError("远端清理已跳过，可能残留目录或进程"))
            return asyncio.shield(skipped)
        result = self.batch.machines.get(identity)
        if result is None:
            result = loop.create_future()
            result.add_done_callback(_consume)
            self.batch.machines[identity] = result

            async def decide():
                try:
                    async with asyncio.timeout_at(self.deadline):
                        value = await factory(self.deadline)
                except BaseException as error:
                    if not result.done():
                        result.set_exception(error)
                else:
                    result.set_result(value)

            task = asyncio.create_task(decide(), name="cleanup-machine-decision")
            self.batch._deciding.add(task)
            task.add_done_callback(self.batch._deciding.discard)
        return asyncio.shield(result)


def _consume(task):
    if not task.cancelled():
        task.exception()

