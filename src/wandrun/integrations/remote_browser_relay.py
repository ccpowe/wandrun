#!/usr/bin/env python3
"""One exec, loopback TCP only; no CDP or lease knowledge.

Frames use !cII (kind, connection id, payload length): O opens, D carries bytes,
H half-closes the sending direction, C resets one stream, R reports the listener
port (id zero, four-byte network-order port). Payloads are at most 64 KiB.
A broken socket resets only its stream; malformed framing ends the exec.
The host imports the same mux, with a fixed destination supplied out of band.
"""

import asyncio
import contextlib
import struct
import sys

HEADER = struct.Struct("!cII")
PORT = struct.Struct("!I")
MAX_FRAME = 65536
MAX_STREAMS = 128
QUEUE_FRAMES = 16  # At most 1 MiB queued per socket, then backpressure the exec.
CONNECT_LIMIT = 10.0
EOF_DRAIN_LIMIT = 25.0  # A lost host mustn't leave the remote exec waiting forever.


class _Stream:
    def __init__(self, reader=None, writer=None):
        self.reader = reader
        self.writer = writer
        self.incoming = asyncio.Queue(maxsize=QUEUE_FRAMES)
        self.task = None
        self.half_closed = False
        self.reset = False
        self.reading = None
        self.sent = asyncio.get_running_loop().create_future()


class ByteRelay:
    """Multiplex ordered TCP bytes, retaining independent EOF in each direction.

    destination is fixed on the host; None denotes the listening sandbox side.
    run() owns all sockets and always finishes their cleanup before returning.
    Queues are bounded. A slow socket can backpressure the shared exec; this
    protocol does not promise per-stream fairness or independent flow windows.
    """

    def __init__(self, reader, writer, destination=None):
        self.reader = reader
        self.writer = writer
        self.destination = destination
        self.streams = {}
        self.tasks = set()
        self._resetting = set()
        self.server = None
        self.ready = asyncio.get_running_loop().create_future()
        self._write_lock = asyncio.Lock()
        self._next_id = 1
        self.closed = False
        self.input_closed = False

    async def send(self, kind, identity, payload=b""):
        async with self._write_lock:
            self.writer.write(HEADER.pack(kind, identity, len(payload)) + payload)
            await self.writer.drain()

    def _start(self, identity, stream):
        self.streams[identity] = stream
        stream.task = asyncio.create_task(self._serve(identity, stream))
        self.tasks.add(stream.task)
        stream.task.add_done_callback(self.tasks.discard)

    async def _accept(self, reader, writer):
        if self.closed or len(self.streams) >= MAX_STREAMS or self._next_id > 0xFFFFFFFF:
            writer.close()
            await writer.wait_closed()
            return
        identity = self._next_id
        self._next_id += 1  # Never reuse identities within an exec.
        stream = _Stream(reader, writer)
        self._start(identity, stream)

    async def _serve(self, identity, stream):
        pumps = []
        failed = True
        try:
            if self.destination is None:
                await self.send(b"O", identity)
            else:
                async with asyncio.timeout(CONNECT_LIMIT):
                    stream.reader, stream.writer = await asyncio.open_connection(*self.destination)

            async def read_socket():
                # Publish only after the coroutine starts: cancelling an unstarted
                # task would skip its EOF path and cancel the queued reply pump.
                stream.reading = asyncio.current_task()
                try:
                    while not self.input_closed and (data := await stream.reader.read(MAX_FRAME)):
                        await self.send(b"D", identity, data)
                except asyncio.CancelledError:
                    if not self.input_closed:
                        raise
                # On remote exec EOF no more requests can be forwarded. Finish
                # the reply direction without waiting for the daemon to hang up.
                await self.send(b"H", identity)
                if not stream.sent.done():
                    stream.sent.set_result(None)

            async def write_socket():
                while True:
                    data = await stream.incoming.get()
                    if data is None:
                        stream.writer.write_eof()
                        await stream.writer.drain()
                        return
                    stream.writer.write(data)
                    await stream.writer.drain()

            pumps = [asyncio.create_task(read_socket()), asyncio.create_task(write_socket())]
            await asyncio.gather(*pumps)
            failed = False
        except Exception:
            # Socket failures belong to this connection, never the dispatch loop.
            pass
        finally:
            for pump in pumps:
                if not pump.done():
                    pump.cancel()
            await asyncio.gather(*pumps, return_exceptions=True)
            if not stream.sent.done():
                stream.sent.set_result(None)
            self.streams.pop(identity, None)
            if stream.writer is not None:
                if self.closed or stream.reset:
                    stream.writer.transport.abort()
                else:
                    stream.writer.close()
                try:
                    async with asyncio.timeout(5):
                        await stream.writer.wait_closed()
                except Exception:
                    failed = True
                    stream.writer.transport.abort()
            # H in both directions completes a healthy stream. C is a reset,
            # not a close acknowledgement: sending it after H can overtake the
            # peer's queued socket writes and truncate an otherwise valid reply.
            if failed and not self.closed and not stream.reset:
                task = asyncio.current_task()
                self._resetting.add(task)
                try:
                    with contextlib.suppress(Exception):
                        await self.send(b"C", identity)
                finally:
                    self._resetting.discard(task)

    async def _reset(self, identity, *, notify):
        stream = self.streams.pop(identity, None)
        if stream is not None:
            stream.reset = True
            stream.task.cancel()
            if stream.writer is not None:
                stream.writer.transport.abort()
        if notify:
            await self.send(b"C", identity)

    async def _enqueue(self, stream, data):
        if not stream.incoming.full():
            stream.incoming.put_nowait(data)
            return
        # Burst size is not an error: dropping/resetting on queue saturation
        # truncates healthy multi-MiB replies. Stop reading instead. A failed
        # socket must also release this wait, even if it never drains the queue.
        queued = asyncio.create_task(stream.incoming.put(data))
        try:
            await asyncio.wait((queued, stream.task), return_when=asyncio.FIRST_COMPLETED)
        finally:
            if not queued.done():
                queued.cancel()
            await asyncio.gather(queued, return_exceptions=True)

    async def _dispatch(self):
        while True:
            kind, identity, length = HEADER.unpack(await self.reader.readexactly(HEADER.size))
            if length > MAX_FRAME or kind not in (b"O", b"D", b"H", b"C", b"R"):
                raise ValueError("invalid relay frame")
            if kind in (b"O", b"H", b"C") and (length or not identity):
                raise ValueError("invalid relay control frame")
            if kind == b"D" and not identity:
                raise ValueError("invalid relay stream identity")
            try:
                data = await self.reader.readexactly(length)
            except asyncio.IncompleteReadError as error:
                raise ValueError("truncated relay payload") from error
            if kind == b"R":
                if self.destination is None or identity or length != PORT.size or self.ready.done():
                    raise ValueError("invalid relay ready frame")
                port = PORT.unpack(data)[0]
                if not 1 <= port <= 65535:
                    raise ValueError("invalid relay port")
                self.ready.set_result(port)
            elif kind == b"O":
                if self.destination is None or identity in self.streams:
                    raise ValueError("invalid relay open frame")
                if len(self.streams) >= MAX_STREAMS:
                    await self.send(b"C", identity)
                else:
                    self._start(identity, _Stream())
            elif kind == b"C":
                await self._reset(identity, notify=False)
            else:
                stream = self.streams.get(identity)
                if stream is None:
                    continue  # In-flight data may follow a locally reset connection.
                if stream.half_closed:
                    await self._reset(identity, notify=True)
                    continue
                if kind == b"H":
                    stream.half_closed = True
                    await self._enqueue(stream, None)
                else:
                    await self._enqueue(stream, data)

    async def finish_sending(self):
        """Flush local socket EOFs before closing the shared exec input.

        The caller must stop admission and close its destination sockets first.
        Waiting only for this direction leaves peer-held connections independent
        of the final response's delivery in the other direction.
        """
        while pending := [stream.sent for stream in self.streams.values() if not stream.sent.done()]:
            await asyncio.gather(*(asyncio.shield(sent) for sent in pending))

    async def drain(self):
        """Observe existing socket pumps without cancelling their byte delivery."""
        while self.tasks:
            # Reset streams have no remaining pumps; they mustn't cancel drain.
            await asyncio.gather(*(asyncio.shield(task) for task in tuple(self.tasks)),
                                 return_exceptions=True)

    async def run(self):
        try:
            if self.destination is None:
                self.server = await asyncio.start_server(self._accept, "127.0.0.1", 0)
                await self.send(b"R", 0, PORT.pack(self.server.sockets[0].getsockname()[1]))
            await self._dispatch()
        except asyncio.IncompleteReadError as error:
            if error.partial:
                raise ValueError("truncated relay frame") from error
            if self.destination is None:
                # Stop new accepts, then flush complete D/H sequences. An EOF
                # caused by SSH loss may leave incomplete streams: reset them
                # instead of waiting for frames which can no longer arrive.
                self.server.close()
                self.input_closed = True
                for stream in tuple(self.streams.values()):
                    if not stream.half_closed:
                        stream.reset = True
                        stream.task.cancel()
                    elif stream.reading is not None:
                        # Preserve queued responses and H; only stop reading new
                        # requests from a peer which may keep its TCP side open.
                        stream.reading.cancel()
                # Failed-stream reset notifications carry no response bytes.
                # After host EOF they mustn't hold up healthy socket flushing.
                for task in tuple(self._resetting):
                    task.cancel()
                async with asyncio.timeout(EOF_DRAIN_LIMIT):
                    await self.drain()
        finally:
            self.closed = True
            if not self.ready.done():
                self.ready.set_exception(ConnectionError("browser relay closed before ready"))
                self.ready.exception()
            if self.server is not None:
                self.server.close()
            for stream in tuple(self.streams.values()):
                if stream.writer is not None:
                    stream.writer.transport.abort()
            # Retiring streams may already be out of the routing map while
            # waiting to flush C or close a socket. They still belong to this exec.
            for task in tuple(self.tasks):
                task.cancel()
            await asyncio.gather(*tuple(self.tasks), return_exceptions=True)
            if self.server is not None:
                # wait_closed includes accepted connections on supported Python.
                # Their pumps must finish (or abort) before waiting on the server.
                await self.server.wait_closed()


class _PipeWriter(asyncio.streams.FlowControlMixin):
    pass


async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    protocol = _PipeWriter(loop=loop)
    transport, _ = await loop.connect_write_pipe(lambda: protocol, sys.stdout.buffer)
    writer = asyncio.StreamWriter(transport, protocol, None, loop)
    try:
        await ByteRelay(reader, writer).run()
    finally:
        writer.close()


if __name__ == "__main__":
    asyncio.run(main())
