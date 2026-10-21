"""ADR-0014：SSH backend 的宿主侧（能确认时确认；无法确认时如实告知 Agent、事后报告）。

不需要远端主机：会话通道接在本机运行的同一份会话服务上，或接在按脚本回复的假服务上。
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from wandrun.integrations import remote_session, ssh_backend
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.integrations.ssh_backend import SESSION_HASH, SSHBackend, SessionChannel
from wandrun.metrics import RunMetrics
from wandrun.runtime.environments import Environment
from wandrun.runtime.session import RuntimeCleanupError, open_runtime
from wandrun.runtime.workspace import Workspace

GRACE = 0.2
UNCONFIRMED = "可能仍在 fake 上运行"


class FakeRemote:
    """假会话服务：截获宿主写出的消息，按 on_message 回复。"""

    def __init__(self, on_message=None):
        self.reader = asyncio.StreamReader()
        self.received = []
        self.on_message = on_message or (lambda remote, message: None)
        self.drain_blocked = False
        self.drain_released = asyncio.Event()  # 放行此前被阻塞的 drain
        self.drain_error = None
        self.drain_error_delay = 0.01  # 失败前让读取者先处理已到达的数据
        self.write_error = None
        self.written = asyncio.Event()

    def write(self, data):
        if self.write_error is not None:
            raise self.write_error
        for line in data.decode().splitlines():
            message = json.loads(line)
            self.received.append(message)
            self.written.set()
            self.on_message(self, message)

    async def drain(self):
        if self.drain_error is not None:
            await asyncio.sleep(self.drain_error_delay)
            raise self.drain_error
        if self.drain_blocked:
            await self.drain_released.wait()

    def runs(self):
        return [message for message in self.received if message["type"] == "run"]

    def reply(self, **message):
        self.reader.feed_data((json.dumps(message) + "\n").encode())

    def result(self, call_id, reason, cleanup, **extra):
        self.reply(type="result", id=call_id, reason=reason, cleanup=cleanup, exit_code=extra.pop("exit_code", 0),
                   stdout=extra.pop("stdout", ""), stderr="", truncated=False)

    async def backend(self, grace=GRACE, timeout=5):
        channel = SessionChannel(self.reader, self)
        self.reply(type="ready", protocol=remote_session.PROTOCOL, hash=SESSION_HASH, termination_grace=grace)
        await channel.open(GRACE)
        return SSHBackend(channel, connection=None, label="fake", workdir="/w", timeout=timeout, termination_grace=GRACE)


def short_limits():
    return [patch.object(ssh_backend, "NETWORK_SLACK", 0.2), patch.object(remote_session, "SETTLE", 0.2)]


def closes_cleanly(remote, message):
    if message["type"] == "shutdown":
        remote.reply(type="closed", unconfirmed=[])


class HostWithLocalSessionTests(unittest.IsolatedAsyncioTestCase):
    """宿主侧经真实会话服务（本机进程）执行。"""

    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.tag = f"whost{os.getpid()}x{time.monotonic_ns()}"
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, remote_session.__file__, self.directory.name, repr(GRACE),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            # A remote host does not inherit the local CLI's browser endpoint.
            env={key: value for key, value in os.environ.items()
                 if key not in ("WANDRUN_BROWSER_CDP", "AGENT_BROWSER_SESSION")},
        )
        channel = SessionChannel(self.process.stdout, self.process.stdin)
        await channel.open(GRACE)
        self.backend = SSHBackend(
            channel, connection=None, label="local", workdir=self.directory.name, timeout=10, termination_grace=GRACE
        )

    async def asyncTearDown(self):
        try:
            await self.backend.aclose()
        finally:
            await asyncio.wait_for(self.process.wait(), 10)
            subprocess.run(["pkill", "-f", f"[{self.tag[0]}]{self.tag[1:]}"], check=False)
            self.directory.cleanup()

    def tagged(self):
        result = subprocess.run(["pgrep", "-f", f"[{self.tag[0]}]{self.tag[1:]}"], capture_output=True, text=True)
        return len(result.stdout.split())

    @unittest.skipUnless(
        shutil.which("Xvfb") and (shutil.which("google-chrome") or Path("/opt/google/chrome/chrome").is_file()),
        "需要 Xvfb 与 Google Chrome",
    )
    async def test_browser_skill_on_ssh_receives_no_local_endpoint(self):
        """Use the real SSH execution protocol, with its remote process on this host."""
        from deepagents.backends.protocol import FileDownloadResponse

        workspace = Workspace(Path(self.directory.name))
        workspace.ensure_config()
        skill = workspace.skills_dir / "browser"
        skill.mkdir(parents=True, exist_ok=True)
        (skill / "SKILL.md").write_text("---\nname: browser\ndescription: browser\n---\nBrowser\n")
        workspace.agents_config.write_text(
            'main_agent="remote"\n[agents.remote]\ndescription="remote"\n'
            'system_prompt="check environment"\nmodel="offline"\n'
            'environment="ssh"\nskills=["browser"]\n',
        )
        workspace.mcps_config.write_text("[mcp_servers]\n")
        command = (
            "printf 'cdp=<%s> session=<%s>' "
            '"${WANDRUN_BROWSER_CDP-unset}" "${AGENT_BROWSER_SESSION-unset}"'
        )
        responses = [call("env", "execute", {"command": command}), answer("checked")]
        bodies = []

        async def model(_, body):
            bodies.append(body)
            yield responses[min(len(bodies), len(responses)) - 1]

        async def environments(config, workspace, stack, opened, *, include_default=False, builtin_source=None):
            remote = Environment("ssh", self.backend, str(workspace.skills_dir), str(workspace.root / "artifacts"))
            opened.append(remote)
            return {"remote": remote}

        async def download_skills(paths):
            # This fixture has the real exec protocol but no SSH/SFTP transport.
            # Read actual skill files locally; execute still uses SSHBackend.
            return [FileDownloadResponse(path=path, content=Path(path).read_bytes()) for path in paths]

        with ChromeDev() as chrome:
            workspace.environments_config.write_text(
                'default="local"\n[environments.local]\ntype="local"\n'
                f'[environments.local.browser]\ncdp_url="{chrome.cdp_url}"\n'
                '[environments.ssh]\ntype="ssh"\nhost="test-session"\n'
                f'workdir="{self.directory.name}"\n',
            )
            with (
                patch.object(CodexSubscriptionModel, "_arequest", model),
                patch("wandrun.runtime.session.open_environments", environments),
                patch.object(self.backend, "adownload_files", download_skills),
            ):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None,
                ) as runtime:
                    runtime.workers.start("inspect the remote command environment", "ssh-browser")
                    result = await asyncio.wait_for(runtime.workers.wait("ssh-browser"), 15)
                    self.assertEqual(result["status"], "completed", result)
                    outputs = [item["output"] for item in bodies[1]["input"]
                               if item.get("type") == "function_call_output"]
                    self.assertIn("cdp=<unset> session=<unset>", "\n".join(outputs))
                    self.assertEqual(runtime.browser.list_tasks(), [])

    async def test_managed_memory_file_and_code_mode_share_host_content(self):
        from types import SimpleNamespace

        import pydantic_monty as pm

        from wandrun.runtime.code_mode import CodeModeCatalog, code_mode_tool
        from wandrun.runtime.memory import MemoryStore
        from wandrun.runtime.memory_runtime import MEMORY_PATH, ManagedMemoryBackend, MemoryMiddleware

        with tempfile.TemporaryDirectory() as host:
            store = MemoryStore(Path(host) / "memory")
            initial = store.save("ssh-agent", "旧背景\n保留", store.read("ssh-agent").version)
            backend = ManagedMemoryBackend(self.backend, store, "ssh-agent")
            request = SimpleNamespace(
                runtime=SimpleNamespace(context={"task_id": "ssh-task"}),
                state={"memory_version": initial.version},
            )

            async def ordinary(_request):
                return await backend.aedit(MEMORY_PATH, "旧背景", "SSH 更新")

            middleware = MemoryMiddleware(store, "ssh-agent")
            self.assertIsNone((await middleware.awrap_tool_call(request, ordinary)).error)
            request.state["memory_version"] = store.read("ssh-agent").version
            async with pm.AsyncMonty() as pool:
                tool = code_mode_tool(pool, backend, CodeModeCatalog([], []))

                async def code(_request):
                    return await tool.ainvoke({
                        "type": "tool_call", "id": "ssh-memory", "name": "run_code",
                        "args": {"code": (
                            f"await edit('{MEMORY_PATH}', 'SSH 更新', 'Code Mode 更新')\n"
                            f"result = await read('{MEMORY_PATH}')\n"
                            "print(result['file_data']['content'])\n"
                        )},
                    })

                result = await middleware.awrap_tool_call(request, code)
            self.assertEqual(result.status, "success", result.content)
            self.assertIn("Code Mode 更新", result.content)
            self.assertEqual(store.read("ssh-agent").content, "Code Mode 更新\n保留")
            self.assertFalse((Path(self.directory.name) / ".wandrun" / "memory.md").exists())

    async def test_execute_timeout_and_cancel(self):
        result = await self.backend.aexecute("echo out; echo err >&2; exit 3")
        self.assertEqual(result.exit_code, 3)
        self.assertIn("[stderr] err", result.output)
        timed = await self.backend.aexecute(f"sleep 30 # {self.tag}", timeout=1)
        self.assertEqual(timed.exit_code, 124)
        self.assertIn("timed out after 1 seconds", timed.output)
        running = asyncio.create_task(self.backend.aexecute(f"sleep 30 # {self.tag}"))
        while self.tagged() < 1:
            await asyncio.sleep(0.05)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertEqual(self.tagged(), 0)

    async def test_close_cancels_running_calls(self):
        running = asyncio.create_task(self.backend.aexecute(f"sleep 30 # {self.tag}"))
        while self.tagged() < 1:
            await asyncio.sleep(0.05)
        await self.backend.aclose()  # 全部确认清理：不报告
        self.assertEqual(self.tagged(), 0)
        self.assertIn("远端没有完成该命令（cancelled）", (await running).output)
        with self.assertRaises(RuntimeError):
            await self.backend.aexecute("echo late")


class HostTests(unittest.IsolatedAsyncioTestCase):
    """无法确认时如实告诉 Agent、照常继续，退出时汇总报告。用假服务精确控制回复。"""

    async def asyncSetUp(self):
        for limit in short_limits():
            limit.start()
            self.addCleanup(limit.stop)

    async def assert_reported_at_close(self, backend, *fragments):
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        for fragment in fragments:
            self.assertIn(fragment, str(raised.exception))
        self.assertIsNone(await backend.aclose())  # 只报告一次

    async def test_unconfirmed_result_tells_the_agent_and_later_calls_still_run(self):
        def respond(remote, message):
            if message["type"] == "run" and message["command"] == "first":
                remote.result(message["id"], "timeout", "unconfirmed")
            elif message["type"] == "run":
                remote.result(message["id"], "exited", "confirmed", stdout="ok\n")
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        first = await backend.aexecute("first")
        self.assertIn(UNCONFIRMED, first.output)
        self.assertIn("先检查实际状态", first.output)
        self.assertIsNone(first.exit_code)
        self.assertIn("ok", (await backend.aexecute("second")).output)  # 不封锁
        await self.assert_reported_at_close(backend, remote.runs()[0]["id"])

    async def test_missing_result_is_unconfirmed_within_the_limit(self):
        remote = FakeRemote(closes_cleanly)
        backend = await remote.backend()
        started = time.monotonic()
        self.assertIn(UNCONFIRMED, (await backend.aexecute("work", timeout=1)).output)
        self.assertLess(time.monotonic() - started, 3)
        await self.assert_reported_at_close(backend, "等待结果超时")

    async def test_stuck_send_counts_toward_the_limit(self):
        remote = FakeRemote()
        backend = await remote.backend()
        remote.drain_blocked = True
        result = await asyncio.wait_for(backend.aexecute("work", timeout=1), 5)
        self.assertIn(UNCONFIRMED, result.output)  # 已写入缓冲，远端可能已收到

    async def test_transport_errors_distinguish_written_from_not_written(self):
        remote = FakeRemote(closes_cleanly)
        backend = await remote.backend()
        remote.write_error = BrokenPipeError("closed")
        not_sent = await backend.aexecute("work")
        self.assertIn("命令没有发出", not_sent.output)
        remote.write_error = None
        remote.drain_error = ConnectionResetError("reset")  # 已进入写缓冲后出错：等结果，等不到才是无法确认
        sent = await backend.aexecute("work", timeout=1)
        self.assertIn(UNCONFIRMED, sent.output)
        remote.drain_error = None
        await self.assert_reported_at_close(backend, remote.runs()[0]["id"])

    async def test_channel_eof_after_sending_is_unconfirmed(self):
        remote = FakeRemote(lambda r, m: m["type"] == "run" and r.reader.feed_eof())
        backend = await remote.backend()
        self.assertIn(UNCONFIRMED, (await backend.aexecute("work")).output)

    async def test_cancel_confirmed_propagates_and_is_not_reported(self):
        def respond(remote, message):
            if message["type"] == "cancel":
                remote.result(message["id"], "cancelled", "confirmed")
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        running = asyncio.create_task(backend.aexecute("work"))
        await remote.written.wait()
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertEqual([m["type"] for m in remote.received], ["run", "cancel"])
        await backend.aclose()  # 没有未确认：不报告

    async def test_cancel_unconfirmed_or_unanswered_still_propagates_and_is_reported(self):
        for respond, case in (
            (lambda r, m: m["type"] == "cancel" and r.result(m["id"], "cancelled", "unconfirmed"), "unconfirmed"),
            (lambda r, m: None, "unanswered"),  # 取消确认超时也照常传播取消
        ):
            with self.subTest(case=case):
                remote = FakeRemote(respond)
                backend = await remote.backend()
                running = asyncio.create_task(backend.aexecute("work"))
                await remote.written.wait()
                running.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(running, 5)
                await self.assert_reported_at_close(backend, remote.runs()[0]["id"])

    async def test_cancel_before_sending_sends_nothing(self):
        remote = FakeRemote()
        backend = await remote.backend()
        remote.drain_blocked = True
        holder = asyncio.create_task(backend.aexecute("first"))  # 占住发送锁
        await remote.written.wait()
        waiting = asyncio.create_task(backend.aexecute("second"))
        await asyncio.sleep(0.05)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual([m["command"] for m in remote.runs()], ["first"])
        holder.cancel()
        await asyncio.gather(holder, return_exceptions=True)

    async def test_file_operations_report_unconfirmed_as_errors(self):
        # 解析器会把“可能仍在运行”的说明吞成成功的空结果；必须出现在结果的 error 里。
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "unconfirmed")
            closes_cleanly(remote, message)

        backend = await FakeRemote(respond).backend()
        results = [
            await backend.als("/w"),
            await backend.aread("/w/a.txt"),
            await backend.agrep("x", "/w"),
            await backend.aglob("*.py", "/w"),
            await backend.aedit("/w/a.txt", "a", "b"),
            await backend.adelete("/w/a.txt"),  # 协议默认经线程走同步 execute
        ]
        for result in results:
            self.assertIn(UNCONFIRMED, result.error or "", type(result).__name__)
        direct = await backend.aexecute("work")  # Agent 直接调用 execute 仍得到如实说明
        self.assertIn(UNCONFIRMED, direct.output)
        with self.assertRaises(CleanupUnconfirmedError):
            await backend.aclose()

    async def test_timeout_before_sending_is_not_unconfirmed(self):
        remote = FakeRemote(closes_cleanly)
        backend = await remote.backend()
        remote.drain_blocked = True
        holder = asyncio.create_task(backend.aexecute("first"))  # 占住发送锁
        await remote.written.wait()
        waiting = await backend.aexecute("second", timeout=1)  # 在锁上等到超时，从未写出
        self.assertIn("命令没有发出", waiting.output)
        self.assertEqual([m["command"] for m in remote.runs()], ["first"])
        holder.cancel()
        await asyncio.gather(holder, return_exceptions=True)

    async def test_result_that_arrived_while_sending_is_used(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "exited", "confirmed", stdout="done\n")
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        remote.drain_blocked = True  # 结果已到，发送方仍卡在 drain
        result = await backend.aexecute("work", timeout=1)
        self.assertIn("done", result.output)
        remote.drain_blocked = False
        await backend.aclose()  # 没有未确认

    async def test_records_added_while_closing_are_reported(self):
        def respond(remote, message):
            if message["type"] == "shutdown":
                # 关闭等待期间，进行中的调用才拿到“未确认”结果，随后才是 closed。
                remote.result(remote.runs()[0]["id"], "timeout", "unconfirmed")
                asyncio.get_running_loop().call_later(0.05, lambda: remote.reply(type="closed", unconfirmed=[]))

        remote = FakeRemote(respond)
        backend = await remote.backend()
        running = asyncio.create_task(backend.aexecute("work"))
        await remote.written.wait()
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        self.assertIn(remote.runs()[0]["id"], str(raised.exception))
        await asyncio.gather(running, return_exceptions=True)

    async def test_calls_still_without_result_at_close_are_reported(self):
        remote = FakeRemote(closes_cleanly)
        backend = await remote.backend()
        running = asyncio.create_task(backend.aexecute("work"))
        await remote.written.wait()
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        self.assertIn(remote.runs()[0]["id"], str(raised.exception))
        self.assertIn(UNCONFIRMED, (await running).output)

    async def test_sync_file_operations_and_unsent_commands_return_errors(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "unconfirmed")
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        listing = await asyncio.to_thread(backend.ls, "/w")  # 同步入口（从工作线程调用）
        self.assertIn(UNCONFIRMED, listing.error or "")
        remote.write_error = BrokenPipeError("closed")  # 写出之前失败：确定没有发出
        unsent = await backend.als("/w")
        self.assertIn("命令没有发出", unsent.error or "")
        remote.write_error = None
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        self.assertEqual(str(raised.exception).count("（"), 1)  # 只有已写出的那一次计入未确认

    async def test_close_reports_a_call_whose_wait_ended_before_it_was_recorded(self):
        # run 已写出；取消消息与 shutdown 都排在被占住的发送锁后；通道 EOF 先让等待结束，记账还没发生。
        remote = FakeRemote()
        backend = await remote.backend()
        target = asyncio.create_task(backend.aexecute("target"))
        await remote.written.wait()
        remote.drain_blocked = True
        holder = asyncio.create_task(backend.aexecute("holder"))  # 写出后卡在 drain，占住发送锁
        while len(remote.runs()) < 2:
            await asyncio.sleep(0.01)
        target.cancel()  # 取消流程在锁上排队
        await asyncio.sleep(0.05)
        remote.reader.feed_eof()
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        self.assertIn(remote.runs()[0]["id"], str(raised.exception))
        remote.drain_released.set()
        await asyncio.gather(target, holder, return_exceptions=True)

    async def test_result_received_before_a_send_failure_is_kept(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "exited", "confirmed", stdout="done\n")
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        remote.drain_error = ConnectionResetError("reset")  # 结果已到，随后 drain 失败
        self.assertIn("done", (await backend.aexecute("work")).output)
        remote.drain_error = BrokenPipeError("gone")
        remote.on_message = closes_cleanly
        remote.reader.feed_eof()  # 发送失败且通道断开、没有结果：才是无法确认
        self.assertIn(UNCONFIRMED, (await backend.aexecute("work")).output)
        remote.drain_error = None
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        first, second = (message["id"] for message in remote.runs())
        self.assertIn(second, str(raised.exception))  # 只有没有结果的那一次计入
        self.assertNotIn(first, str(raised.exception))

    async def test_result_arriving_after_a_send_failure_is_used(self):
        def respond(remote, message):
            if message["type"] == "run":  # 结果在发送失败之后才到达
                asyncio.get_running_loop().call_later(
                    0.05, lambda: remote.result(message["id"], "exited", "confirmed", stdout="late\n")
                )
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        remote.drain_error, remote.drain_error_delay = ConnectionResetError("reset"), 0
        self.assertIn("late", (await backend.aexecute("work", timeout=1)).output)
        remote.drain_error = None
        await backend.aclose()  # 没有未确认

    async def test_confirmed_result_while_cancel_waits_to_be_sent_is_kept(self):
        remote = FakeRemote(closes_cleanly)
        backend = await remote.backend()
        target = asyncio.create_task(backend.aexecute("target"))
        await remote.written.wait()
        remote.drain_blocked = True
        holder = asyncio.create_task(backend.aexecute("holder"))
        while len(remote.runs()) < 2:
            await asyncio.sleep(0.01)
        target.cancel()  # 取消消息排在锁后
        await asyncio.sleep(0.05)
        remote.result(remote.runs()[0]["id"], "cancelled", "confirmed")  # 确认结果先到
        remote.write_error = BrokenPipeError("closed")  # 随后取消消息写入失败
        remote.drain_released.set()
        with self.assertRaises(asyncio.CancelledError):
            await target
        remote.write_error = None
        remote.result(remote.runs()[1]["id"], "exited", "confirmed")
        await holder
        await backend.aclose()  # 不应把 target 记为未确认

    async def test_confirmed_timeout_is_an_error_for_file_operations(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "confirmed")
            closes_cleanly(remote, message)

        backend = await FakeRemote(respond).backend()
        for result in (
            await backend.als("/w"),
            await asyncio.to_thread(backend.ls, "/w"),
            await backend.adelete("/w/a"),  # 预检超时不能被说成“不存在”
        ):
            self.assertIn("已终止", result.error or "", type(result).__name__)
        self.assertEqual((await backend.aexecute("work")).exit_code, 124)  # 普通 execute 仍是超时结果
        await backend.aclose()  # 清理都已确认：不报告

    async def test_report_reason_comes_from_the_result_when_there_is_one(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "unconfirmed")
            closes_cleanly(remote, message)

        backend = await FakeRemote(respond).backend()
        await backend.aexecute("work")
        with self.assertRaises(CleanupUnconfirmedError) as raised:
            await backend.aclose()
        self.assertIn("远端报告 timeout 后仍有进程未结束", str(raised.exception))
        self.assertNotIn("通道断开", str(raised.exception))

    async def test_cancelled_delete_does_not_send_rm(self):
        def respond(remote, message):
            if message["type"] == "cancel":
                remote.result(message["id"], "cancelled", "confirmed")
            closes_cleanly(remote, message)

        remote = FakeRemote(respond)
        backend = await remote.backend()
        deleting = asyncio.create_task(backend.adelete("/w/a"))  # 预检发出后一直没有结果
        await remote.written.wait()
        deleting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await deleting
        await asyncio.sleep(0.1)
        self.assertEqual([m["command"].split()[0] for m in remote.runs()], ["test"])  # 没有新发出 rm
        await backend.aclose()

    async def test_handshake_mismatch_is_rejected(self):
        remote = FakeRemote()
        channel = SessionChannel(remote.reader, remote)
        remote.reply(type="ready", protocol=remote_session.PROTOCOL, hash=SESSION_HASH, termination_grace=GRACE * 2)
        with self.assertRaisesRegex(RuntimeError, "握手不符"):
            await channel.open(GRACE)

    async def test_close_merges_host_and_session_unconfirmed_calls(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "unconfirmed")
            elif message["type"] == "shutdown":
                remote.reply(type="closed", unconfirmed=["remote-only"])

        remote = FakeRemote(respond)
        backend = await remote.backend()
        await backend.aexecute("work")
        await self.assert_reported_at_close(backend, "remote-only", remote.runs()[0]["id"])

    async def test_close_without_closed_reply_is_reported(self):
        backend = await (FakeRemote()).backend()
        await self.assert_reported_at_close(backend, "关闭会话")


def call(call_id, name, arguments):
    return {"type": "response.completed", "response": {"status": "completed", "output": [{
        "type": "function_call", "id": f"fc_{call_id}", "call_id": call_id, "name": name,
        "arguments": json.dumps(arguments),
    }]}}


def answer(text):
    payload = {"messages": [{"to": "human", "task_id": None, "message": text}], "next": "done"}
    return {"type": "response.completed", "response": {"status": "completed", "output": [{
        "type": "message", "id": "m", "role": "assistant", "phase": "final_answer",
        "content": [{"type": "output_text", "text": json.dumps(payload)}],
    }]}}


class AgentSeesUncertaintyTests(unittest.IsolatedAsyncioTestCase):
    """WorkerManager → 真实工具层（execute 工具）→ SSHBackend → 假会话服务。"""

    async def asyncSetUp(self):
        for limit in short_limits():
            limit.start()
            self.addCleanup(limit.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.workspace = Workspace(Path(self.directory.name))
        self.workspace.ensure_config()
        # This fake SSH service models command uncertainty, not a synced skill filesystem.
        # Keep its role independent of the real workspace's built-in skill selection.
        self.workspace.agents_config.write_text(
            'main_agent = "main"\n[agents.main]\ndescription = "m"\nsystem_prompt = "m"\n'
            'model = "offline"\nskills = []\n',
            encoding="utf-8",
        )
        self.workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
        )

    async def run_chain(self, responses, respond, interrupt=False):
        remote = FakeRemote(respond)
        bodies = []

        async def model(_, body):
            bodies.append(body)
            yield responses[min(len(bodies), len(responses)) - 1]

        async def environments(config, workspace, stack, opened, *, include_default=False, builtin_source=None):
            environment = Environment("fake", await remote.backend(), "/skills", "/artifacts")
            opened.append(environment)
            return {role: environment for role in config.agents}

        status = close_error = None
        try:
            with (
                patch.object(CodexSubscriptionModel, "_arequest", model),
                patch("wandrun.runtime.session.open_environments", environments),
            ):
                async with open_runtime(
                    self.workspace, metrics=RunMetrics(self.workspace.runs_dir), on_human=lambda *_: None
                ) as runtime:
                    runtime.workers.start("go", "root")
                    if interrupt:
                        await asyncio.wait_for(remote.written.wait(), 10)
                        await asyncio.sleep(0.05)
                        runtime.workers.interrupt("stop that", "root")
                    status = await asyncio.wait_for(runtime.workers.wait("root"), 20)
        except RuntimeCleanupError as error:
            close_error = error
        return status, bodies, close_error

    @staticmethod
    def tool_outputs(body):
        return [str(item["output"]) for item in body["input"] if item.get("type") == "function_call_output"]

    async def test_model_is_told_the_command_may_still_run(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "unconfirmed")
            closes_cleanly(remote, message)

        status, bodies, close_error = await self.run_chain(
            [call("c1", "execute", {"command": "work"}), answer("checked")], respond
        )
        self.assertEqual(status["status"], "completed")  # Worker 照常继续，由 Agent 决定怎么处理
        (output,) = self.tool_outputs(bodies[1])
        self.assertIn(UNCONFIRMED, output)
        self.assertIsNotNone(close_error)  # 运行时退出时汇总报告

    async def test_ls_tool_and_code_mode_see_unconfirmed_instead_of_empty_results(self):
        def respond(remote, message):
            if message["type"] == "run":
                remote.result(message["id"], "timeout", "unconfirmed")
            closes_cleanly(remote, message)

        self.workspace.agents_config.write_text(
            'main_agent = "main"\n[agents.main]\ndescription = "m"\nsystem_prompt = "m"\n'
            'model = "offline"\ncode_mode = true\n',
            encoding="utf-8",
        )
        code = "try:\n    await ls('/w')\nexcept Exception as error:\n    print('ls failed:', error)\n"
        status, bodies, _ = await self.run_chain(
            [call("c1", "ls", {"path": "/w"}), call("c2", "run_code", {"code": code}), answer("checked")], respond
        )
        self.assertEqual(status["status"], "completed")
        (ls_output,) = self.tool_outputs(bodies[1])
        self.assertIn(UNCONFIRMED, ls_output)
        self.assertNotIn("No files found", ls_output)
        code_output = self.tool_outputs(bodies[2])[-1]
        self.assertIn("ls failed", code_output)
        self.assertIn(UNCONFIRMED, code_output)

    async def test_interrupted_delete_tool_does_not_send_rm_afterwards(self):
        remote_ref = []

        def respond(remote, message):
            remote_ref[:] = [remote]
            if message["type"] == "cancel":
                remote.result(message["id"], "cancelled", "confirmed")
            closes_cleanly(remote, message)

        status, bodies, _ = await self.run_chain(
            [call("c1", "delete", {"file_path": "/w/a"}), answer("checked")], respond, interrupt=True
        )
        self.assertEqual(status["status"], "completed")
        await asyncio.sleep(0.2)
        (remote,) = remote_ref
        self.assertFalse([m for m in remote.runs() if m["command"].startswith("rm ")])

    async def test_interrupt_with_unconfirmed_cancel_resumes_with_the_interrupted_notice(self):
        def respond(remote, message):
            if message["type"] == "cancel":
                remote.result(message["id"], "cancelled", "unconfirmed")
            closes_cleanly(remote, message)

        status, bodies, close_error = await self.run_chain(
            [call("c1", "execute", {"command": "work"}), answer("checked")], respond, interrupt=True
        )
        self.assertEqual(status["status"], "completed")
        (output,) = self.tool_outputs(bodies[1])
        self.assertIn("外部操作可能已经发生", output)  # 已有的中断提示让 Agent 先检查
        self.assertIsNotNone(close_error)


if __name__ == "__main__":
    unittest.main()
