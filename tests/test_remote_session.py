"""ADR-0014：远端会话服务的调用生命周期，在本机直接运行同一份脚本（经 stdin/stdout 驱动）。"""

import asyncio
import contextlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from wandrun.integrations import remote_session

SCRIPT = remote_session.__file__


class Server:
    """一个会话服务进程：按行发送请求、按 id 收集结果。"""

    def __init__(self, process):
        self.process = process
        self.messages = []

    @classmethod
    async def start(cls, workdir, grace=0.3):
        process = await asyncio.create_subprocess_exec(
            sys.executable, SCRIPT, str(workdir), str(grace),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            limit=64 * 1024 * 1024,
        )
        server = cls(process)
        ready = await server.next()
        assert ready["type"] == "ready" and ready["termination_grace"] == grace, ready
        return server

    async def send(self, **message):
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        await self.process.stdin.drain()

    async def run(self, call_id, command, timeout=10, max_output=100_000):
        await self.send(type="run", id=call_id, command=command, timeout=timeout, max_output=max_output)

    async def next(self, timeout=20):
        line = await asyncio.wait_for(self.process.stdout.readline(), timeout)
        assert line, "session closed its output"
        return json.loads(line)

    async def result(self, call_id, timeout=20):
        for message in self.messages:
            if message.get("id") == call_id:
                self.messages.remove(message)
                return message
        while True:
            message = await self.next(timeout)
            if message.get("id") == call_id:
                return message
            self.messages.append(message)

    async def stop(self):
        if self.process.returncode is None:
            self.process.stdin.close()
            await asyncio.wait_for(self.process.wait(), 20)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="wandrun session ")  # 路径含空格
        self.root = Path(self.directory.name)
        self.tag = f"wses{os.getpid()}x{time.monotonic_ns()}"
        self.server = await Server.start(self.root)

    async def asyncTearDown(self):
        await self.server.stop()
        subprocess.run(["pkill", "-f", f"[{self.tag[0]}]{self.tag[1:]}"], check=False)
        self.directory.cleanup()

    def tagged(self) -> int:
        result = subprocess.run(["pgrep", "-f", f"[{self.tag[0]}]{self.tag[1:]}"], capture_output=True, text=True)
        return len(result.stdout.split())

    async def test_result_fields_and_working_directory(self):
        await self.server.run("a", "pwd; echo err >&2; exit 3")
        result = await self.server.result("a")
        self.assertEqual(
            {k: result[k] for k in ("reason", "exit_code", "cleanup", "truncated", "stderr")},
            {"reason": "exited", "exit_code": 3, "cleanup": "confirmed", "truncated": False, "stderr": "err\n"},
        )
        self.assertEqual(result["stdout"].strip(), str(self.root))

    async def test_plain_exit_124_and_sigpipe_default(self):
        await self.server.run("a", "printf actual-error; exit 124")
        await self.server.run("b", "yes | head -n 1")
        a, b = await self.server.result("a"), await self.server.result("b")
        self.assertEqual((a["reason"], a["exit_code"], a["stdout"]), ("exited", 124, "actual-error"))
        self.assertEqual((b["reason"], b["stdout"]), ("exited", "y\n"))

    async def test_output_limit_is_reported(self):
        await self.server.run("a", "python3 -c \"print('中' * 100000)\"", max_output=1000)
        result = await self.server.result("a")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["stdout"].encode()), 1000)

    async def test_deadline_terminates_redirected_descendants_and_term_ignorers(self):
        command = (
            f"sh -c 'trap \"\" TERM; sleep 2; echo escaped > escaped # {self.tag}' >/dev/null 2>&1 & "
            f"sleep 10 # {self.tag}"
        )
        await self.server.run("a", command, timeout=1)
        result = await self.server.result("a")
        self.assertEqual((result["reason"], result["cleanup"]), ("timeout", "confirmed"))
        await asyncio.sleep(2)
        self.assertFalse((self.root / "escaped").exists())
        self.assertEqual(self.tagged(), 0)

    async def test_background_holder_keeps_call_open_under_the_deadline(self):
        started = time.monotonic()
        await self.server.run("a", f"sh -c 'sleep 30 # {self.tag}' & echo started", timeout=1)
        result = await self.server.result("a")
        self.assertEqual((result["reason"], result["stdout"]), ("timeout", "started\n"))
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(self.tagged(), 0)

    async def test_redirected_background_survives_normal_completion(self):
        await self.server.run("a", f"sh -c 'sleep 30 # {self.tag}' >/dev/null 2>&1 & echo done")
        result = await self.server.result("a")
        self.assertEqual((result["reason"], result["stdout"]), ("exited", "done\n"))
        self.assertEqual(self.tagged(), 1)

    async def test_cancel_during_run_terminates_the_group(self):
        await self.server.run("a", f"sh -c 'trap \"\" TERM; sleep 30 # {self.tag}' & sleep 30 # {self.tag}")
        while self.tagged() < 2:
            await asyncio.sleep(0.05)
        await self.server.send(type="cancel", id="a")
        result = await self.server.result("a")
        self.assertEqual((result["reason"], result["cleanup"]), ("cancelled", "confirmed"))
        self.assertEqual(self.tagged(), 0)

    async def test_cancel_right_after_run_never_runs_the_command(self):
        self.server.process.stdin.write(
            (json.dumps({"type": "run", "id": "a", "command": "sleep 0.3; touch started",
                         "timeout": 10, "max_output": 100}) + "\n"
             + json.dumps({"type": "cancel", "id": "a"}) + "\n").encode()
        )
        await self.server.process.stdin.drain()
        result = await self.server.result("a")
        self.assertIn(result["reason"], {"not_started", "cancelled"})
        self.assertEqual(result["cleanup"], "confirmed")
        await asyncio.sleep(0.5)
        self.assertFalse((self.root / "started").exists())

    async def test_calls_run_concurrently(self):
        started = time.monotonic()
        for index in range(5):
            await self.server.run(f"c{index}", "sleep 1")
        for index in range(5):
            self.assertEqual((await self.server.result(f"c{index}"))["reason"], "exited")
        self.assertLess(time.monotonic() - started, 3)

    async def test_stdin_eof_cancels_everything_and_reports_closed(self):
        await self.server.run("a", f"sleep 30 # {self.tag}")
        while self.tagged() < 1:
            await asyncio.sleep(0.05)
        self.server.process.stdin.close()
        result = await self.server.result("a")
        closed = await self.server.next()
        self.assertEqual((result["reason"], closed), ("cancelled", {"type": "closed", "unconfirmed": []}))
        self.assertEqual(self.tagged(), 0)
        await asyncio.wait_for(self.server.process.wait(), 10)

    async def test_shutdown_request_closes_after_cleanup(self):
        await self.server.run("a", f"sleep 30 # {self.tag}")
        while self.tagged() < 1:
            await asyncio.sleep(0.05)
        await self.server.send(type="shutdown")
        self.assertEqual((await self.server.result("a"))["reason"], "cancelled")
        self.assertEqual(await self.server.next(), {"type": "closed", "unconfirmed": []})
        self.assertEqual(await asyncio.wait_for(self.server.process.wait(), 10), 0)

    async def test_failed_protocol_writes_count_as_disconnect(self):
        await self.server.run("a", f"sleep 30 # {self.tag}")
        while self.tagged() < 1:
            await asyncio.sleep(0.05)
        self.server.process._transport.get_pipe_transport(1).close()  # 宿主侧关闭读端
        await self.server.run("b", "true")  # 它的结果写不出去
        await asyncio.wait_for(self.server.process.wait(), 15)
        self.assertEqual(self.tagged(), 0)


class UnreadOutputTests(unittest.TestCase):
    """宿主不读协议输出（读端保持打开）：底层管道写满后，结果堆在服务的发送缓冲里。"""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.tag = f"wunread{os.getpid()}x{time.monotonic_ns()}"
        # 用阻塞的 Popen，测试从不读取 stdout，管道真正被写满。
        self.process = subprocess.Popen(
            [sys.executable, SCRIPT, self.directory.name, "0.3"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )

    def tearDown(self):
        self.process.kill()
        self.process.communicate(timeout=30)
        subprocess.run(["pkill", "-f", f"[{self.tag[0]}]{self.tag[1:]}"], check=False)
        self.directory.cleanup()

    def send(self, **message):
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        self.process.stdin.flush()

    def tagged(self):
        result = subprocess.run(["pgrep", "-f", f"[{self.tag[0]}]{self.tag[1:]}"], capture_output=True, text=True)
        return len(result.stdout.split())

    def test_deadlines_and_cancellation_still_happen_on_time(self):
        deadline = time.monotonic() + 10
        self.send(type="run", id="probe", command=f"sleep 30 # {self.tag}z", timeout=1, max_output=100)
        while not self.tagged():  # 先确认服务已运行
            self.assertLess(time.monotonic(), deadline, "会话服务没有启动")
            time.sleep(0.05)
        for index in range(3):
            self.send(type="run", id=f"big{index}", command="python3 -c \"print('x' * 400000)\"",
                      timeout=10, max_output=1_000_000)
        self.send(type="run", id="slow", command=f"sleep 30 # {self.tag}x", timeout=1, max_output=100)
        self.send(type="run", id="cancel-me", command=f"sleep 30 # {self.tag}y", timeout=30, max_output=100)
        time.sleep(0.5)
        self.send(type="cancel", id="cancel-me")
        time.sleep(1.5)
        self.assertEqual(self.tagged(), 0)

    def test_backlog_over_the_limit_counts_as_disconnect(self):
        self.send(type="run", id="holder", command=f"sleep 30 # {self.tag}", timeout=60, max_output=100)
        deadline = time.monotonic() + 10
        while not self.tagged():  # 先确认服务已运行、holder 已启动，否则“没有进程”不能说明它被终止
            self.assertLess(time.monotonic(), deadline, "holder 没有启动")
            time.sleep(0.05)
        for index in range(2):  # 两个约 9 MB 的结果超过 16 MiB 发送上限
            self.send(type="run", id=f"big{index}", command="python3 -c \"print('x' * 9000000)\"",
                      timeout=30, max_output=9_500_000)
        deadline = time.monotonic() + 20
        while self.tagged() and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertEqual(self.tagged(), 0)  # 按宿主断开处理：取消了其余调用


class SessionArgumentTests(unittest.TestCase):
    def test_invalid_grace_refuses_to_start(self):
        for grace in ("0", "-1", "inf", "nan", "abc"):
            with self.subTest(grace=grace):
                result = subprocess.run(
                    [sys.executable, SCRIPT, tempfile.gettempdir(), grace],
                    input=b"", capture_output=True, timeout=10,
                )
                self.assertEqual(result.returncode, 2)


class InternalFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_output_read_failure_terminates_instead_of_reporting_success(self):
        tag = f"wread{os.getpid()}x{time.monotonic_ns()}"
        sent = []

        class Transport:
            def write(self, data):
                sent.append(json.loads(data))

            def get_write_buffer_size(self):
                return 0

        async def broken(self, stream):
            await asyncio.sleep(0.2)
            raise OSError("read failed")

        session = remote_session.Session(tempfile.gettempdir(), 0.2)
        session.transport = Transport()
        with patch.object(remote_session.Output, "drain", broken):
            session.handle(json.dumps({"type": "run", "id": "a", "command": f"sleep 30 # {tag}",
                                       "timeout": 30, "max_output": 100}))
            await asyncio.wait_for(session.calls["a"].task, 10)
        (result,) = sent
        self.assertEqual((result["reason"], result["cleanup"]), ("error", "confirmed"))
        found = subprocess.run(["pgrep", "-f", f"[{tag[0]}]{tag[1:]}"], capture_output=True, text=True)
        self.assertEqual(found.stdout.split(), [])  # 进程组已被终止，而不是报告“已完成”后继续运行


class UnconfirmedCleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_members_that_cannot_be_killed_are_reported_unconfirmed(self):
        sent = []

        class Transport:
            def write(self, data):
                sent.append(json.loads(data))

            def get_write_buffer_size(self):
                return 0

        session = remote_session.Session(tempfile.gettempdir(), 0.1)
        session.transport = Transport()
        spawn = asyncio.create_subprocess_exec

        async def reap(process):
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)  # start_new_session：组号即 pid
            await process.wait()

        async def spawn_and_keep(*args, **kwargs):
            # 模拟之外进程其实可杀：派生后立即登记回收，测试失败时也执行。
            process = await spawn(*args, **kwargs)
            self.addAsyncCleanup(reap, process)
            return process

        # 模拟无法杀死的成员（如不可中断睡眠）：信号不生效，整组一直“存活”。
        with patch.object(remote_session, "signal_group", lambda *args: None), \
                patch.object(remote_session.asyncio, "create_subprocess_exec", spawn_and_keep), \
                patch.object(remote_session, "group_alive", lambda pgid: True), \
                patch.object(remote_session, "SETTLE", 0.2):
            session.handle(json.dumps({"type": "run", "id": "a", "command": "sleep 3", "timeout": 10, "max_output": 100}))
            await asyncio.sleep(0.2)
            session.calls["a"].stop("cancelled")
            await asyncio.wait_for(session.calls["a"].task, 5)
        (result,) = sent
        self.assertEqual((result["reason"], result["cleanup"]), ("cancelled", "unconfirmed"))
        await session.close()
        self.assertEqual(sent[-1], {"type": "closed", "unconfirmed": ["a"]})  # 关闭时报告此前未确认的调用


if __name__ == "__main__":
    unittest.main()
