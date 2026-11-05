"""Instabox browser transport resources; authorization remains on the host.

The CDP forward uses its own SSH connection. Each task endpoint instead owns an
independent exec on the command connection, with one immutable host destination.
Exec source is sent as a quoted python -c argument: no remote staging file or
persistent relay daemon is needed. Cancellation never discards accepted execs.
"""

from __future__ import annotations

import asyncio
import contextlib
import shlex
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import urlsplit

import asyncssh

from wandrun.integrations import remote_browser_relay
from wandrun.integrations.remote_browser_relay import ByteRelay
from wandrun.integrations.shell_backend import CleanupUnconfirmedError

OPEN_LIMIT = 30.0
CLOSE_LIMIT = 25.0
RELAY_COMMAND = "exec python3 -c " + shlex.quote(Path(remote_browser_relay.__file__).read_text())


def _consume(task):
    if not task.cancelled():
        task.exception()


def endpoint_destination(url: str) -> tuple[str, int]:
    """Only host-created loopback HTTP endpoints may become fixed destinations."""
    parsed = urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1", "localhost")
            or not parsed.port or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("浏览器任务接入点必须是回环 HTTP 地址")
    return parsed.hostname, parsed.port


class BrowserRelay:
    """One remote exec, retained until its exit is confirmed, even after EOF.

    Construct immediately after create_process, before waiting for R. The owner
    retains this object if open/close fails; closing a local SSH channel alone
    is never reported as proof that the sandbox listener has stopped.
    """

    def __init__(self, process, destination, on_disconnect: Callable[[], None]):
        self.process = process
        self.mux = ByteRelay(process.stdout, process.stdin, destination)
        self._on_disconnect = on_disconnect
        self._intentional = False
        self._closing = None
        self._draining = None
        self.confirmed = False
        self._reading = asyncio.create_task(self._read(), name="browser-relay-read")
        self._reading.add_done_callback(_consume)
        self._stderr = asyncio.create_task(self._discard_stderr(), name="browser-relay-stderr")
        self._stderr.add_done_callback(_consume)

    async def _discard_stderr(self):
        while await self.process.stderr.read(65536):
            pass  # Never retain potentially unbounded remote diagnostics in memory.

    async def _read(self):
        try:
            await self.mux.run()
        finally:
            if not self._intentional:
                self._on_disconnect()

    async def open(self) -> str:
        async with asyncio.timeout(OPEN_LIMIT):
            port = await asyncio.shield(self.mux.ready)
        return f"http://127.0.0.1:{port}"

    async def _drain(self):
        try:
            async with asyncio.timeout(CLOSE_LIMIT):
                await self.mux.finish_sending()
                self.process.stdin.write_eof()
                await self.mux.drain()
                await self.process.wait_closed()
                if self.process.exit_status != 0:
                    raise CleanupUnconfirmedError("浏览器 relay 未确认正常排空退出")
        except Exception as error:
            raise CleanupUnconfirmedError("浏览器 relay 响应排空未确认") from error

    async def drain(self):
        """Finish accepted byte streams and remote EOF cleanup before forceful stop."""
        self._intentional = True
        if self._draining is None:
            self._draining = asyncio.create_task(self._drain(), name="browser-relay-drain")
            self._draining.add_done_callback(_consume)
        await asyncio.shield(self._draining)

    async def _close(self):
        try:
            async with asyncio.timeout(CLOSE_LIMIT):
                # EOF may already have arrived with a terminal exit report.
                # A failed send is not decisive: still wait for the remote exit.
                with contextlib.suppress(Exception):
                    self.process.stdin.write_eof()
                # EOF shares the backpressured byte path. The exec handle is
                # the independent stop control; only its terminal report confirms exit.
                with contextlib.suppress(OSError, asyncssh.Error):
                    self.process.terminate()
                await self.process.wait_closed()
                # A lost SSH channel has no remote exit status. Do not infer exit
                # from EOF, cancellation, or closing the local process object.
                self.confirmed = (self.process.exit_status is not None
                                  and self.process.exit_status >= 0) or self.process.exit_signal is not None
                if not self.confirmed:
                    raise CleanupUnconfirmedError("浏览器 relay 远端退出未确认")
        except Exception as error:
            raise CleanupUnconfirmedError("浏览器 relay 远端退出未确认") from error
        finally:
            self.process.close()
            for task in (self._reading, self._stderr):
                if not task.done():
                    task.cancel()
            await asyncio.gather(self._reading, self._stderr, return_exceptions=True)

    async def aclose(self):
        self._intentional = True
        if (self._closing is None or self._closing.done()
                and self._closing.exception() is not None):
            self._closing = asyncio.create_task(self._close(), name="browser-relay-close")
            self._closing.add_done_callback(_consume)
        await asyncio.shield(self._closing)


class InstaboxBrowserTransport:
    """Owner-local lazy transport shared by all aliases of the same Instabox.

    Preparation/recovery feedback is enforced by InstaboxBackend before entry.
    A passive disconnect revokes the old scene once, closes its transport, and
    permits only a subsequent explicit call to create fresh connection resources.
    Unconfirmed execs remain in _retained and are reported at owner shutdown.
    """

    def __init__(self, config, on_disconnect: Callable[[str], Awaitable[None]], *,
                 start_script: str, connect: Callable[[], Awaitable]):
        self.config = config
        self.start_script = start_script
        self._on_disconnect = on_disconnect
        self._connect = connect
        self._connection = None
        self._forward = None
        self._url = None
        self._forward_opening = None
        self._relay_opening = {}
        self._relays = {}
        self._retained = set()
        self._openings = set()
        self._unconfirmed_open = set()
        self._connections = []
        self._forwards = []
        self._watchers = set()
        self._command_connection = None
        self._loss = None
        self._live = False
        self._revision = 0
        self._closed = False
        self._closing = None
        self._revoked = set()

    def _own_opening(self, coroutine, name):
        task = asyncio.create_task(coroutine, name=name)
        self._openings.add(task)
        task.add_done_callback(self._openings.discard)
        task.add_done_callback(_consume)
        return task

    def _watch(self, awaitable, current):
        async def watch():
            try:
                await awaitable
            except Exception:
                pass  # Both a failed wait and EOF are passive transport loss.
            if not self._closed and current():
                self._signal_loss()
        task = asyncio.create_task(watch(), name="instabox-browser-watch")
        self._watchers.add(task)
        task.add_done_callback(self._watchers.discard)
        task.add_done_callback(_consume)

    def _signal_loss(self):
        if self._closed or not self._live:
            return
        self._live = False
        self._revision += 1  # Also invalidates in-progress opens before publication.
        self._loss = asyncio.create_task(self._lost("浏览器连接中断"), name="instabox-browser-lost")
        self._loss.add_done_callback(_consume)

    async def _lost(self, reason):
        connection, forward = self._connection, self._forward
        self._connection = self._forward = self._url = None
        self._forward_opening = None
        self._revoked.update(self._relay_opening)
        try:
            # Revoke first, before closing the forward can produce a generic CDP
            # loss notification with a less precise reason.
            await self._on_disconnect(reason)
        finally:
            if forward is not None:
                forward.close()
            if connection is not None:
                connection.close()
            relays = tuple(self._retained)
            await asyncio.gather(*(relay.aclose() for relay in relays), return_exceptions=True)
            for relay in relays:
                if relay.confirmed:
                    self._retained.discard(relay)
            self._relays = {url: relay for url, relay in self._relays.items() if not relay.confirmed}
            self._relay_opening.clear()

    async def connection_lost(self, reason: str):
        """Known platform recovery also revokes persisted scenes not yet used here."""
        if self._loss is not None:
            await asyncio.shield(self._loss)
        if self._closed:
            return
        self._live = False
        self._revision += 1
        self._loss = asyncio.create_task(self._lost(reason), name="instabox-browser-recovery")
        self._loss.add_done_callback(_consume)
        await asyncio.shield(self._loss)

    async def _before_use(self, command_connection):
        if self._loss is not None:
            await asyncio.shield(self._loss)
        if self._closed:
            raise RuntimeError("浏览器传输已关闭")
        if command_connection is not self._command_connection:
            self._command_connection = command_connection
            self._watch(command_connection.wait_closed(), lambda: self._command_connection is command_connection)
        self._live = True

    async def _open_forward(self):
        revision = self._revision
        connection = None
        try:
            async with asyncio.timeout(OPEN_LIMIT):
                connection = await self._connect()
                self._connections.append(connection)
                if self._closed or revision != self._revision:
                    raise ConnectionError("浏览器连接已失效，本次操作未提交")
                self._connection = connection
                self._watch(connection.wait_closed(), lambda: self._connection is connection)
                forward = await connection.forward_local_port("127.0.0.1", 0, "127.0.0.1", self.config.cdp_port)
                self._forwards.append(forward)
                if self._closed or revision != self._revision:
                    forward.close()
                    raise ConnectionError("浏览器转发已失效，本次操作未提交")
                self._forward = forward
                self._watch(forward.wait_closed(), lambda: self._forward is forward)
                self._url = f"http://127.0.0.1:{forward.get_port()}"
                return self._url
        except BaseException:
            if connection is not None:
                if self._connection is connection:
                    self._connection = None
                connection.close()
            raise

    async def cdp_url(self, command_connection) -> str:
        await self._before_use(command_connection)
        if self._url is not None:
            return self._url
        if self._forward_opening is None or self._forward_opening.done():
            self._forward_opening = self._own_opening(self._open_forward(), "instabox-cdp-forward")
        return await asyncio.shield(self._forward_opening)

    async def _open_relay(self, url, command_connection):
        destination = endpoint_destination(url)
        revision = self._revision
        async with asyncio.timeout(OPEN_LIMIT):
            try:
                process = await command_connection.create_process(RELAY_COMMAND, encoding=None)
            except asyncssh.ChannelOpenError:
                raise  # Explicit channel rejection cannot have started an exec.
            except BaseException:
                # A lost exec acknowledgement cannot prove that no listener was
                # started. There is no PID-based reconnect/signal fallback.
                self._unconfirmed_open.add(url)
                raise
            relay = BrowserRelay(
                process, destination,
                lambda: self._signal_loss() if revision == self._revision else None,
            )
            self._retained.add(relay)  # Record responsibility before waiting for R.
            self._relays[url] = relay
            try:
                remote_url = await relay.open()
                if self._closed or url in self._revoked or revision != self._revision:
                    raise ConnectionError("浏览器任务接入点已撤销")
                return remote_url
            except BaseException:
                await relay.aclose()
                if relay.confirmed:
                    self._retained.discard(relay)
                    self._relays.pop(url, None)
                raise

    async def command_environment(self, env: dict[str, str], command_connection) -> dict[str, str]:
        await self._before_use(command_connection)
        url = env["WANDRUN_BROWSER_CDP"]
        endpoint_destination(url)
        if url in self._revoked:
            raise ConnectionError("浏览器任务接入点已撤销")
        opening = self._relay_opening.get(url)
        if opening is None:
            opening = self._own_opening(self._open_relay(url, command_connection), "instabox-browser-relay")
            self._relay_opening[url] = opening
        try:
            remote_url = await asyncio.shield(opening)
        except asyncssh.ChannelOpenError:
            # Explicit refusal owns no exec. A later explicit call can prepare
            # again; a late waiter must not erase a newer preparation.
            if self._relay_opening.get(url) is opening:
                self._relay_opening.pop(url)
            raise
        return {**env, "WANDRUN_BROWSER_CDP": remote_url,
                "WANDRUN_BROWSER_PORT": str(self.config.cdp_port),
                "WANDRUN_BROWSER_PROFILE": self.config.profile_dir,
                "WANDRUN_BROWSER_START": self.start_script}

    async def drain_endpoint(self, url: str):
        self._revoked.add(url)
        relay = self._relays.get(url)
        if relay is not None:
            await relay.drain()

    async def close_endpoint(self, url: str):
        self._revoked.add(url)
        opening = self._relay_opening.pop(url, None)
        if opening is not None:
            try:
                await asyncio.shield(opening)
            except CleanupUnconfirmedError:
                raise
            except Exception:
                pass  # A revoked opening closes its accepted relay before failing.
        if url in self._unconfirmed_open:
            raise CleanupUnconfirmedError("浏览器 relay exec 提交结果未确认")
        relay = self._relays.get(url)
        if relay is not None:
            await relay.aclose()
            self._retained.discard(relay)
            self._relays.pop(url, None)

    @property
    def cleanup_pending(self):
        return bool(self._unconfirmed_open or self._openings or any(
            relay.mux.closed or relay._draining is not None or relay._closing is not None
            for relay in self._retained
        ))

    async def _close(self):
        problems = []
        openings = set(self._openings)
        if self._loss is not None:
            openings.add(self._loss)
        if openings:
            _, pending = await asyncio.wait(openings, timeout=CLOSE_LIMIT)
            for task in pending:
                task.cancel()
            if pending:
                problems.append("浏览器传输准备收尾未确认")
        if self._unconfirmed_open:
            problems.append("浏览器 relay exec 提交结果未确认")
        relays = tuple(self._retained)
        results = await asyncio.gather(*(relay.aclose() for relay in relays), return_exceptions=True)
        if any(isinstance(result, BaseException) for result in results):
            problems.append("浏览器 relay 远端退出未确认")
        for relay in relays:
            if relay.confirmed:
                self._retained.discard(relay)
        for forward in self._forwards:
            forward.close()
            try:
                async with asyncio.timeout(CLOSE_LIMIT):
                    await forward.wait_closed()
            except Exception:
                problems.append("CDP 正向转发关闭未确认")
        for connection in self._connections:
            connection.close()
            try:
                async with asyncio.timeout(CLOSE_LIMIT):
                    await connection.wait_closed()
            except Exception:
                connection.abort()
                problems.append("浏览器 SSH 关闭未确认")
        for task in tuple(self._watchers):
            task.cancel()
        await asyncio.gather(*tuple(self._watchers), return_exceptions=True)
        if problems:
            raise CleanupUnconfirmedError("Instabox 浏览器收尾未确认：" + "；".join(problems))

    async def aclose(self):
        if self._closing is None:
            self._closed = True
            self._closing = asyncio.create_task(self._close(), name="instabox-browser-close")
            self._closing.add_done_callback(_consume)
        await asyncio.shield(self._closing)
