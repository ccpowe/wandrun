#!/usr/bin/env python3
"""Wandrun 远端会话服务（ADR-0014）。只用标准库，由 SSH backend 上传并经一个 SSH exec 通道启动。

    python3 remote_session.py <工作目录> <termination_grace>

stdin/stdout 上每行一个 JSON 消息：宿主发 run / cancel / shutdown，服务发 ready / result / closed；日志写 stderr。
一个环境的所有活动调用都由这一个进程持有，取消就是修改内存中的调用状态。

一次调用：先登记并开始计时，再派生 `sh -c`（独立进程组，stdin 为 /dev/null）。
- 正常结束：直接子进程退出，且 stdout、stderr 都读到 EOF。不占管道的后台进程保留。
- 取消或到期：对整组 SIGTERM，宽限期后仍有成员则 SIGKILL，等整组消失；SIGKILL 后最多再等 SETTLE 秒，
  仍有成员则 cleanup=unconfirmed。一旦开始终止就做完，不因直接子进程或输出先结束而中止。
- 派生前被取消或已到期：不派生（not_started）。

协议输出由事件循环的管道传输异步写出，进程管理从不等待写完；发送缓冲超过上限、写失败或 stdin EOF，
都按宿主断开处理：取消全部调用并收尾。
"""

import asyncio
import codecs
import hashlib
import json
import math
import os
import signal
import sys
import time

PROTOCOL = 1
SETTLE = 5.0  # SIGKILL 后等待整组消失的上限（成员可能处于不可中断睡眠）
POLL = 0.05
READ_CHUNK = 65536
MAX_PENDING_OUTPUT = 16 * 1024 * 1024  # 协议发送缓冲上限
MAX_LINE = 16 * 1024 * 1024  # 单条请求（含命令）的长度上限


def log(text):
    try:
        sys.stderr.write(text + "\n")
        sys.stderr.flush()
    except OSError:
        pass


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        pass


class Output:
    """一个输出流：最多保留 limit 字节，其余读出丢弃并计数。"""

    def __init__(self, limit):
        self.limit = limit
        self.kept = bytearray()
        self.total = 0

    async def drain(self, stream):
        while True:
            chunk = await stream.read(READ_CHUNK)
            if not chunk:
                return
            if len(self.kept) < self.limit:
                self.kept += chunk[: self.limit - len(self.kept)]
            self.total += len(chunk)

    def text(self):
        # 截断时丢掉末尾不完整的多字节序列，而不是把它替换成额外的字符。
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        return decoder.decode(bytes(self.kept), final=self.total == len(self.kept))


class Call:
    def __init__(self, session, call_id, command, timeout, max_output):
        self.session = session
        self.id = call_id
        self.command = command
        self.timeout = timeout
        self.stdout = Output(max_output)
        self.stderr = Output(max_output)
        self.stop_reason = None  # "cancelled" 或 "timeout"
        self.stopping = asyncio.Event()
        loop = asyncio.get_running_loop()
        # 登记即开始计时：期限覆盖排队与派生。
        self.timer = loop.call_later(timeout, self.stop, "timeout")
        self.task = loop.create_task(self.run())

    def stop(self, reason):
        if self.stop_reason is None:
            self.stop_reason = reason
            self.stopping.set()

    async def run(self):
        try:
            result = await self.execute()
        except Exception as error:  # 不让单个调用的意外错误拖垮整个会话
            log(f"call {self.id} failed: {type(error).__name__}: {error}")
            result = {"reason": "not_started", "exit_code": -1, "cleanup": "unconfirmed",
                      "stderr": f"会话服务内部错误：{type(error).__name__}: {error}"}
        finally:
            self.timer.cancel()
        self.session.finish(self.id, {
            "type": "result", "id": self.id, "stdout": self.stdout.text(),
            "stderr": self.stderr.text(),
            "truncated": self.stdout.total > len(self.stdout.kept)
            or self.stderr.total > len(self.stderr.kept),
            **result,
        })

    async def execute(self):
        if self.stop_reason is not None:
            return {"reason": "not_started", "exit_code": -1, "cleanup": "confirmed"}
        try:
            process = await asyncio.create_subprocess_exec(
                "sh", "-c", self.command,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=self.session.workdir,
                start_new_session=True,  # 返回时子进程已 setsid 并完成 exec，进程组已存在
            )
        except OSError as error:
            self.stderr.kept += str(error).encode()
            return {"reason": "not_started", "exit_code": 127, "cleanup": "confirmed"}
        pgid = process.pid
        readers = [
            asyncio.ensure_future(self.stdout.drain(process.stdout)),
            asyncio.ensure_future(self.stderr.drain(process.stderr)),
        ]
        finished = asyncio.ensure_future(asyncio.gather(process.wait(), *readers))
        stopping = asyncio.ensure_future(self.stopping.wait())
        try:
            await asyncio.wait({finished, stopping}, return_when=asyncio.FIRST_COMPLETED)
            if finished.done() and not finished.cancelled() and finished.exception() is None:
                # 先于停止完成：直接子进程退出且两个输出流都 EOF，命令真实结束。
                return {"reason": "exited", "exit_code": exit_code(process.returncode), "cleanup": "confirmed"}
            if finished.done():
                # 读取输出失败不等于命令结束：进程可能仍在运行，进入终止与确认。
                log(f"call {self.id} output failed: {finished.exception()!r}")
                self.stop("error")
            confirmed = await self.terminate(pgid, process)
        except Exception as error:  # 派生之后的任何意外：先终止进程组，再报告
            log(f"call {self.id} failed after spawn: {type(error).__name__}: {error}")
            self.stop("error")
            confirmed = await self.terminate(pgid, process)
        finally:
            stopping.cancel()
        if confirmed:
            # 成员已全部结束，管道随之关闭；读完剩余输出。
            await asyncio.wait({finished}, timeout=1)
        if not finished.done():
            finished.cancel()
            await asyncio.gather(finished, return_exceptions=True)
        return {
            "reason": self.stop_reason,
            "exit_code": exit_code(process.returncode),
            "cleanup": "confirmed" if confirmed else "unconfirmed",
        }

    async def terminate(self, pgid, process):
        """整组 SIGTERM → 宽限 → SIGKILL → 等整组消失。返回是否确认已全部结束。"""
        grace = self.session.grace

        def done():
            return process.returncode is not None and not group_alive(pgid)

        signal_group(pgid, signal.SIGTERM)
        deadline = time.monotonic() + grace
        while not done() and time.monotonic() < deadline:
            await asyncio.sleep(POLL)
        if not done():
            signal_group(pgid, signal.SIGKILL)
            deadline = time.monotonic() + SETTLE
            while not done() and time.monotonic() < deadline:
                await asyncio.sleep(POLL)
        return done()


def exit_code(returncode):
    if returncode is None:
        return -1
    return 128 - returncode if returncode < 0 else returncode


class Session:
    def __init__(self, workdir, grace):
        self.workdir = workdir
        self.grace = grace
        self.calls = {}
        self.unconfirmed = []  # 本会话内所有清理未确认的调用，关闭时一并报告
        self.accepting = True
        self.shutdown = asyncio.Event()  # 宿主请求关闭：仍可回复 closed
        self.disconnected = asyncio.Event()  # 无法再写协议输出
        self.transport = None

    def send(self, message):
        """只交给传输的缓冲，从不等待写完；超过上限或写失败按宿主断开处理。"""
        if self.disconnected.is_set() or self.transport is None:
            return
        data = (json.dumps(message, ensure_ascii=False) + "\n").encode()
        try:
            self.transport.write(data)
        except Exception as error:
            log(f"protocol write failed: {error}")
            self.disconnected.set()
            return
        if self.transport.get_write_buffer_size() > MAX_PENDING_OUTPUT:
            log("protocol output backlog exceeded; treating host as disconnected")
            self.disconnected.set()

    def finish(self, call_id, result):
        self.calls.pop(call_id, None)
        if result["cleanup"] == "unconfirmed":
            self.unconfirmed.append(call_id)
        self.send(result)

    def handle(self, line):
        try:
            message = json.loads(line)
            kind = message["type"]
        except (ValueError, KeyError, TypeError):
            log(f"invalid message: {line[:200]!r}")
            return
        if kind == "run":
            call_id = message.get("id")
            if not self.accepting or not isinstance(call_id, str) or call_id in self.calls:
                log(f"rejected run: {call_id!r}")
                return
            try:
                timeout = float(message["timeout"])
                max_output = int(message["max_output"])
                command = message["command"]
                if not (math.isfinite(timeout) and timeout > 0 and max_output > 0 and isinstance(command, str)):
                    raise ValueError
            except (KeyError, TypeError, ValueError):
                self.send({"type": "result", "id": call_id, "reason": "not_started", "exit_code": -1,
                           "cleanup": "confirmed", "stdout": "", "stderr": "无效的 run 参数", "truncated": False})
                return
            self.calls[call_id] = Call(self, call_id, command, timeout, max_output)
        elif kind == "cancel":
            call = self.calls.get(message.get("id"))
            if call is not None:  # 未知 id 说明已经结束：宿主保证 run 先于 cancel 发出
                call.stop("cancelled")
        elif kind == "shutdown":
            self.shutdown.set()
        else:
            log(f"unknown message type: {kind!r}")

    async def close(self):
        """停止接收，取消全部调用并等它们收尾。"""
        self.accepting = False
        for call in list(self.calls.values()):
            call.stop("cancelled")
        await asyncio.gather(*(call.task for call in list(self.calls.values())), return_exceptions=True)
        self.send({"type": "closed", "unconfirmed": self.unconfirmed})


class _Writer(asyncio.Protocol):
    def __init__(self, session):
        self.session = session

    def connection_lost(self, exc):
        self.session.disconnected.set()


async def main(argv):
    workdir = argv[1]
    try:
        grace = float(argv[2])
        if not (math.isfinite(grace) and grace > 0):
            raise ValueError
    except (IndexError, ValueError):
        log("termination_grace 必须是有限正数")
        return 2
    loop = asyncio.get_running_loop()
    session = Session(workdir, grace)
    reader = asyncio.StreamReader(limit=MAX_LINE)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    session.transport, _ = await loop.connect_write_pipe(lambda: _Writer(session), sys.stdout)
    with open(__file__, "rb") as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    session.send({"type": "ready", "protocol": PROTOCOL, "hash": digest, "termination_grace": grace})

    async def read_requests():
        while True:
            try:
                line = await reader.readline()
            except (ValueError, asyncio.LimitOverrunError) as error:
                log(f"request too long: {error}")
                return
            if not line:
                return  # stdin EOF：宿主断开
            session.handle(line)

    waits = [
        asyncio.ensure_future(read_requests()),
        asyncio.ensure_future(session.shutdown.wait()),
        asyncio.ensure_future(session.disconnected.wait()),
    ]
    await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
    for waiting in waits:
        waiting.cancel()
    await session.close()
    # 尽量把 closed 送出；宿主已断开时不等待。
    deadline = time.monotonic() + 5
    while (
        not session.disconnected.is_set()
        and session.transport.get_write_buffer_size()
        and time.monotonic() < deadline
    ):
        await asyncio.sleep(POLL)
    session.transport.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv)))
