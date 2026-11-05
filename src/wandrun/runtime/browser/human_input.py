"""Lease-owned human writes: ordered sends, bounded replies and ReleaseAll.

The lease lock protects admission and physical sends, never reply waits. A
request becomes potentially effective immediately before entering ws.send;
only a confirmed release removes a held edge. No timeout replays an input.
"""

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import time

from wandrun.runtime.browser.cdp import CDPError, CDPRejected


class HumanInputUnknown(CDPError):
    """A batched write was attempted, but Chrome did not confirm its result."""


class _ReleaseSuperseded(Exception):
    """The held version was replaced before its cleanup could be sent."""


@dataclass(slots=True)
class _Admission:
    connection: str
    target: str
    fenced: bool = False


@dataclass
class _Release:
    dispatched: asyncio.Future
    task: asyncio.Task | None = None


@dataclass(eq=False)
class HumanCommand:
    target: str
    connection: str
    method: str
    params: dict
    observer: object
    release: bool = False
    sequence: object | None = None
    sent_at: float | None = None
    deadline: float | None = None
    sent: bool = False
    outcome: str | None = None
    result: dict = field(default_factory=dict)
    error: BaseException | None = None
    task: asyncio.Task | None = None
    dispatched: asyncio.Event = field(default_factory=asyncio.Event)
    done: asyncio.Event = field(default_factory=asyncio.Event)
    releasing: dict = field(default_factory=dict)

    async def wait(self):
        await self.done.wait()
        if self.error is not None:
            raise self.error
        return self.result


class HumanInputState:
    """A connection's ordered state baseline and post-release re-press gate.

    Plans do not advance the remote baseline until all ordered sends complete.
    Reset replaces the generation synchronously, so a late send/reply cannot
    restore a state belonging to an earlier page or rejected sequence.
    """

    def __init__(self, family):
        self.family = family
        self.generation = 0
        self.position = None
        self.buttons = 0
        self.touches = {}
        self.blocked_buttons = 31
        self.blocked_touches = None
        self.sequence = None

    def reset(self):
        self.generation += 1
        self.buttons = 0
        self.touches = {}
        self.blocked_buttons = 31
        self.blocked_touches = None
        self.sequence = None

    def pointer(self, x, y, buttons, count=1):
        self.blocked_buttons &= buttons
        accepted = buttons & ~self.blocked_buttons
        current = self.buttons
        commands = []
        if self.position != (x, y):
            # Apply the final drag position before its release edge, even when
            # the client skipped the last held-motion snapshot.
            commands.append(("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "button": next((button for button, bit in (
                    ("left", 1), ("right", 2), ("middle", 4), ("back", 8), ("forward", 16))
                    if current & bit), "none"), "buttons": current, "x": x, "y": y}))
        for button, bit in (("left", 1), ("right", 2), ("middle", 4), ("back", 8), ("forward", 16)):
            if current & bit and not accepted & bit:
                current &= ~bit
                commands.append(("Input.dispatchMouseEvent", {
                    "type": "mouseReleased", "button": button, "buttons": current,
                    "x": x, "y": y, "clickCount": count}))
        for button, bit in (("left", 1), ("right", 2), ("middle", 4), ("back", 8), ("forward", 16)):
            if accepted & bit and not current & bit:
                current |= bit
                commands.append(("Input.dispatchMouseEvent", {
                    "type": "mousePressed", "button": button, "buttons": current,
                    "x": x, "y": y, "clickCount": count}))
        return commands, (x, y, accepted)

    def touch(self, touches):
        points = {point["id"]: point for point in touches}
        if self.blocked_touches is None:
            self.blocked_touches = set(points)
        else:
            self.blocked_touches.intersection_update(points)
        accepted = {key: point for key, point in points.items() if key not in self.blocked_touches}
        commands = []
        if self.touches and not accepted:
            commands.append(("Input.dispatchTouchEvent", {
                "type": "touchEnd", "touchPoints": []}))
        elif accepted.keys() - self.touches.keys():
            commands.append(("Input.dispatchTouchEvent", {
                "type": "touchStart", "touchPoints": list(accepted.values())}))
        elif accepted and accepted != self.touches:
            # CDP takes all active contacts and synthesizes removed IDs' ends.
            # touchEnd itself only permits an empty contact array.
            commands.append(("Input.dispatchTouchEvent", {
                "type": "touchMove", "touchPoints": list(accepted.values())}))
        return commands, accepted

    def commit(self, generation, value):
        if generation != self.generation:
            return
        if self.family == "pointer":
            x, y, self.buttons = value
            self.position = x, y
        else:
            self.touches = value


class HumanInputs:
    def __init__(self, lease):
        self.lease = lease
        # Input groups stay indivisible to other viewers, but lifecycle release
        # bypasses this gate and never waits for a whole batch's replies.
        self.groups = asyncio.Lock()
        self.window = 16
        self.reply_timeout = 5
        self.held_idle = 10
        self.commands = set()
        self.held = {}  # (target, family, identity) -> (connection, release params)
        self.held_versions = {}
        self.sealed = False
        self.stopped_pages = set()
        self.observers = {}
        self.barriers = {}
        self.changed = asyncio.Event()
        self.deadlines = {}
        self.releases = {}
        self._admissions = {}
        self.idle_task = None
        self.last_activity = {}
        self.pending_work = set()
        self.group_connection = None
        self.unknown = 0
        self.states = {}

    def state(self, connection, target, family):
        key = connection, target, family
        if key not in self.states:
            self.states[key] = HumanInputState(family)
        return self.states[key]

    def configure(self, *, window, reply_timeout, held_idle):
        self.window, self.reply_timeout, self.held_idle = window, reply_timeout, held_idle

    def event(self, connection):
        self.last_activity[connection] = time.monotonic()
        self.changed.set()

    def set_pending_work(self, connection, pending):
        """Track one connection's accepted FIFO, not a second command ledger."""
        if pending:
            self.pending_work.add(connection)
        elif connection in self.pending_work:
            self.pending_work.remove(connection)
            self.event(connection)
        self.changed.set()

    def forget_connection(self, connection):
        """Called only after disconnect settlement has finished."""
        self.pending_work.discard(connection)
        self.last_activity.pop(connection, None)
        for key in tuple(self.states):
            if key[0] == connection:
                del self.states[key]
        self.changed.set()

    def _busy(self, connection):
        return (connection in self.pending_work or self.group_connection == connection
                or any(c.connection == connection for c in self.commands)
                or any(w.connection == connection for w in self._admissions.values()))

    def _matches(self, command, connection, target):
        return (connection is None or command.connection == connection) and (
            target is None or command.target == target)

    def _blocked(self, connection, target):
        return any(s is None and (c is None or c == connection) and (p is None or p == target)
                   for c, p, s in self.barriers)

    async def _admit(self, connection, target, operation, validate=None, check_admission=None):
        """Check persistent fences before constructing an interruptible wait."""
        if check_admission is not None:
            check_admission()
        if self.sealed or target in self.stopped_pages or self._blocked(connection, target):
            if validate is not None:
                validate()  # Control/epoch rejection retains its existing priority.
            raise ValueError("not-human" if self.sealed else "stale-viewport")
        task = asyncio.current_task()
        waiting = _Admission(connection, target)
        self._admissions[task] = waiting
        try:
            return await operation()
        except asyncio.CancelledError:
            if waiting.fenced:
                task.uncancel()  # Remove only the cancellation owned by the fence.
                if not task.cancelling():
                    if validate is not None:
                        validate()
                    raise ValueError("not-human" if self.sealed else "stale-viewport") from None
            raise
        finally:
            self._admissions.pop(task, None)

    @asynccontextmanager
    async def group(self, connection, target, validate=None, check_admission=None):
        try:
            await self._admit(connection, target, self.groups.acquire, validate, check_admission)
        except BaseException:
            self.event(connection)
            raise
        self.group_connection = connection
        try:
            yield
        finally:
            self.group_connection = None
            self.event(connection)
            self.groups.release()

    def _interrupt_admissions(self, connection, target):
        for task, waiting in tuple(self._admissions.items()):
            if (not waiting.fenced and (connection is None or waiting.connection == connection)
                    and (target is None or waiting.target == target)):
                waiting.fenced = True
                # One admission per initiating Task; callers must not swallow its cancellation.
                task.cancel()

    def _observe(self, command, event, **values):
        if command.observer is not None:
            command.observer(event, method=command.method, **values)

    def _finish(self, command, outcome, error=None, result=None):
        if command.outcome is not None:
            return
        command.outcome, command.error = outcome, error
        command.result = result or {}
        self.commands.discard(command)
        self.event(command.connection)
        if outcome == "unknown":
            self.unknown += 1
            self._observe(command, "unknown")
        elif outcome == "sent":
            self._track(command, confirmed=True)
        elif outcome == "rejected" and isinstance(error, CDPRejected):
            self._observe(command, "rejected")
        command.done.set()
        command.dispatched.set()
        self.changed.set()

    def cancel(self, command):
        """Cancel waiting, never declare an already attempted send settled."""
        if command.outcome is None:
            uncertain = command.sent or command.release
            self._finish(command, "unknown" if uncertain else "rejected",
                         None if uncertain else asyncio.CancelledError())
            command.task.cancel()

    async def send(self, target, connection, method, params, *, validate, observer=None,
                   on_dispatch=None, release=False, sequence=None, check_admission=None):
        """Return after the ordered send, with a lease-owned reply handle."""
        command = HumanCommand(target, connection, method, params, observer,
                               release=release, sequence=sequence)
        try:
            while True:
                if release:
                    await self.lease.lock.acquire()
                else:
                    await self._admit(connection, target, self.lease.lock.acquire, validate, check_admission)
                if sum(c.target == target for c in self.commands) < self.window:
                    break
                self.changed.clear()
                self.lease.lock.release()
                if release:
                    await self.changed.wait()
                else:
                    await self._admit(connection, target, self.changed.wait, validate, check_admission)
        except asyncio.CancelledError:
            if release:
                # The release budget can expire before a slot is available.
                # Its effect is still unconfirmed, unlike an unsent user input.
                self._finish(command, "unknown")
            raise
        try:
            if not release and (self.sealed or target in self.stopped_pages
                                or self._blocked(connection, target)):
                # A queued write must still report control/epoch errors first.
                validate()
                raise ValueError("not-human" if self.sealed else "stale-viewport")
            page = self.lease.pages.get(target)
            if page is None:
                raise ValueError("no-such-page")

            def before_send():
                validate()
                if not release and (self.sealed or target in self.stopped_pages
                                    or self._blocked(connection, target)):
                    raise ValueError("not-human" if self.sealed else "stale-viewport")
                self._admissions.pop(admitting, None)
                # ws.send cancellation cannot establish that no bytes escaped.
                command.sent = True
                command.sent_at = time.monotonic()
                self.commands.add(command)
                self._track(command, confirmed=False)
                self._observe(command, "dispatch", release=release, in_flight=sum(
                    c.target == target for c in self.commands))

            def sent():
                if on_dispatch is not None:
                    on_dispatch()
                command.dispatched.set()

            async def execute():
                try:
                    async with asyncio.timeout(self.reply_timeout) as budget:
                        command.deadline = budget.when()
                        result = await page.cdp.call(method, params, before_send=before_send,
                                                     on_sent=sent, timeout=self.reply_timeout)
                except asyncio.CancelledError:
                    uncertain = command.sent or release
                    self._finish(command, "unknown" if uncertain else "rejected",
                                 None if uncertain else asyncio.CancelledError())
                except CDPRejected as error:
                    self._finish(command, "unknown" if release else "rejected",
                                 None if release else error)
                except (CDPError, ConnectionError, TimeoutError) as error:
                    uncertain = release or command.sent
                    self._finish(command, "unknown" if uncertain else "rejected",
                                 None if uncertain else error)
                except BaseException as error:
                    self._finish(command, "rejected", error)
                else:
                    self._finish(command, "sent", result=result)
                finally:
                    command.dispatched.set()

            admitting = asyncio.current_task()
            command.task = asyncio.create_task(execute())
            try:
                if release:
                    await command.dispatched.wait()
                else:
                    await self._admit(connection, target, command.dispatched.wait, validate, check_admission)
            except BaseException as error:
                self.cancel(command)
                if isinstance(error, asyncio.CancelledError) and not release:
                    self.settle("disconnect", connection=connection)
                raise
        finally:
            self.lease.lock.release()
        if command.error is not None and not command.sent:
            raise command.error
        return command

    def _track(self, command, *, confirmed):
        target, params = command.target, command.params
        kind = params.get("type")
        family, identity, release = None, None, None
        if command.method == "Input.dispatchMouseEvent":
            family, identity = "mouse", params.get("button", "none")
            if kind == "mouseMoved":
                if confirmed:
                    return
                for key, (connection, held) in tuple(self.held.items()):
                    if key[:2] == (target, "mouse"):
                        self.held[key] = (connection, {**held, "x": params.get("x", 0),
                                                       "y": params.get("y", 0)})
                self._sync_held()
                return
            if kind == "mousePressed":
                release = {k: v for k, v in params.items() if k != "timestamp"}
                release.update(type="mouseReleased", buttons=0)
            elif kind != "mouseReleased":
                return
        elif command.method == "Input.dispatchKeyEvent":
            family = "key"
            identity = params.get("code") or params.get("key") or str(params.get("windowsVirtualKeyCode", ""))
            if kind in ("keyDown", "rawKeyDown"):
                release = {k: v for k, v in params.items() if k not in ("text", "unmodifiedText", "timestamp")}
                release["type"] = "keyUp"
            elif kind != "keyUp":
                return
        elif command.method == "Input.dispatchTouchEvent":
            family, identity = "touch", 0
            if kind != "touchCancel" and params.get("touchPoints"):
                release = {"type": "touchCancel", "touchPoints": []}
        else:
            return
        key = target, family, identity
        if release is not None and not confirmed:
            self.held[key] = (command.connection, release)
            self.held_versions[key] = command
            if self.idle_task is None or self.idle_task.done():
                self.idle_task = asyncio.create_task(self._idle())
        elif release is None:
            if not confirmed:
                command.releasing[key] = self.held_versions.get(key)
            elif self.held_versions.get(key) is command.releasing.get(key):
                self.held.pop(key, None)
                self.held_versions.pop(key, None)
        self._sync_held()

    def _sync_held(self):
        # Preserve the lease's existing state projection for diagnostics.
        self.lease.mouse.clear()
        self.lease.keys.clear()
        self.lease.touching = None
        for (target, family, identity), (_, params) in self.held.items():
            if family == "mouse":
                self.lease.mouse[identity] = (target, params.get("x", 0), params.get("y", 0))
            elif family == "key":
                self.lease.keys[identity] = {"target": target, **params}
            else:
                self.lease.touching = target

    async def _idle(self):
        while self.held:
            self.changed.clear()
            now = time.monotonic()
            expired, remaining = [], None
            for connection in {owner for owner, _ in self.held.values()}:
                if self._busy(connection) or self._blocked(connection, None):
                    continue
                delay = self.last_activity.get(connection, 0) + self.held_idle - now
                if delay <= 0:
                    expired.append(connection)
                else:
                    remaining = delay if remaining is None else min(remaining, delay)
            if expired:
                # Existing scope tasks own completion; the monitor only schedules expiry.
                for connection in expired:
                    self.settle("held-idle", connection=connection)
            elif remaining is None:
                await self.changed.wait()
            else:
                try:
                    async with asyncio.timeout(remaining):
                        await self.changed.wait()
                except TimeoutError:
                    pass

    async def before_state_press(self, connection, target, family, validate):
        """An observed up cannot let a new state overwrite an unsent old up."""
        async def dispatch_releases():
            releases = []
            for key, value in tuple(self.held.items()):
                if value[0] != connection or key[:2] != (target, "touch" if family == "touch" else "mouse"):
                    continue
                version = self.held_versions[key]
                if any(self._matches(version, owner, page) and (
                        sequence is None or version.sequence is sequence)
                       for owner, page, sequence in self.barriers):
                    releases.append(self._release(key, value, version, "sequence-rejected", version.sequence))
            if releases and not all(await asyncio.gather(*(
                    asyncio.shield(operation.dispatched) for operation in releases))):
                raise ValueError("stale-viewport")

        await self._admit(connection, target, dispatch_releases, validate, validate)
        validate()

    def _release(self, key, value, version, trigger, sequence):
        release_key = key, version
        if release_key in self.releases:
            return self.releases[release_key]
        operation = _Release(asyncio.get_running_loop().create_future())

        async def release():
            page, family, _ = key
            owner, params = value
            methods = {"mouse": "Input.dispatchMouseEvent", "key": "Input.dispatchKeyEvent",
                       "touch": "Input.dispatchTouchEvent"}
            observer = version.observer or self.observers.get(owner)
            if observer is not None:
                observer("release", trigger=trigger, sequence=sequence)
            handles = []

            def validate_release():
                current = self.held_versions.get(key)
                if current is not version and not (current is None and handles):
                    raise _ReleaseSuperseded()
                if handles and family == "mouse" and any(
                        k[:2] == key[:2] and v is not version for k, v in self.held_versions.items()):
                    raise _ReleaseSuperseded()

            def dispatched():
                return bool(handles) and all(command.sent and command.outcome not in ("unknown", "rejected")
                                             for command in handles)

            try:
                # Early re-entry and the original settlement share this one
                # bounded operation, including a cancelled initiating waiter.
                async with asyncio.timeout(self.reply_timeout):
                    if page in self.lease.pages:
                        handles.append(await self.send(page, owner, methods[family], params,
                            validate=validate_release, observer=observer, release=True))
                        if family == "mouse":
                            handles.append(await self.send(page, owner, "Input.cancelDragging", {},
                                validate=validate_release, observer=observer, release=True))
                        operation.dispatched.set_result(dispatched())
                        await asyncio.gather(*(command.wait() for command in handles))
            except _ReleaseSuperseded:
                if not operation.dispatched.done():
                    # Version protection may skip cancelDragging after its up
                    # was sent; it must never cancel another, newer drag.
                    operation.dispatched.set_result(dispatched())
            except (asyncio.CancelledError, TimeoutError):
                for command in handles:
                    self.cancel(command)
                if asyncio.current_task().cancelling():
                    raise
            finally:
                if not operation.dispatched.done():
                    operation.dispatched.set_result(False)
                if self.held_versions.get(key) is version:
                    self.held.pop(key, None)
                    self.held_versions.pop(key, None)
                    self._sync_held()

        operation.task = asyncio.create_task(release())
        operation.task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        self.releases[release_key] = operation
        return operation

    def settle(self, trigger, *, connection=None, target=None, timeout=None, sequence=None):
        """Fence now; drain to one deadline, then share bounded release attempts.

        Overlapping scopes never wait for one another's entire drain budget.
        They share each held edge's release operation, so an earlier caller's
        deadline can also shorten an existing connection drain.
        """
        scope = connection, target, sequence
        if sequence is None:
            self._interrupt_admissions(connection, target)
        deadline = time.monotonic() + (self.reply_timeout if timeout is None else timeout)
        for (owner, page, _), state in self.states.items():
            if ((connection is None or owner == connection) and (target is None or page == target)
                    and (sequence is None or state.sequence is sequence)):
                state.reset()
        if scope in self.barriers:
            self.deadlines[scope] = min(self.deadlines[scope], deadline)
            self.changed.set()
            return self.barriers[scope]
        self.deadlines[scope] = deadline


        async def settle():
            try:
                pending = [c for c in self.commands if self._matches(c, connection, target)
                           and (sequence is None or c.sequence is sequence)]
                while any(c.outcome is None for c in pending):
                    remaining = self.deadlines[scope] - time.monotonic()
                    if remaining <= 0:
                        break
                    self.changed.clear()
                    wake = asyncio.create_task(self.changed.wait())
                    try:
                        await asyncio.wait([wake, *(c.task for c in pending if c.outcome is None)],
                                           timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        wake.cancel()
                        await asyncio.gather(wake, return_exceptions=True)
                for command in pending:
                    if command.outcome is None:
                        self.cancel(command)
                unknown = sum(command.outcome == "unknown" for command in pending)
                attempts = []
                for key, value in tuple(self.held.items()):
                    if (connection is not None and value[0] != connection
                            or target is not None and key[0] != target):
                        continue
                    version = self.held_versions[key]
                    if sequence is not None and version.sequence is not sequence:
                        continue
                    attempts.append(self._release(key, value, version, trigger, sequence).task)
                if attempts:
                    _, unfinished = await asyncio.wait(attempts, timeout=self.reply_timeout)
                    for operation in unfinished:
                        operation.cancel()
                    await asyncio.gather(*attempts, return_exceptions=True)
                self.releases = {key: operation for key, operation in self.releases.items()
                                 if not operation.task.done()}
                return unknown
            finally:
                self.barriers.pop(scope, None)
                self.deadlines.pop(scope, None)
                self.changed.set()

        task = asyncio.create_task(settle())
        self.barriers[scope] = task
        return task
