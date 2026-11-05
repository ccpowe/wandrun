"""Instabox 底层 SSH 传输与远端会话服务对真实主机运行。

设置 WANDRUN_SSH_TEST=user@host:port 时运行（认证使用本机 ~/.ssh），否则跳过。
每个测试在远端新建独立工作目录（路径含空格），结束后删除并确认已删除。
"""

import asyncio
import json
import os
import shlex
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import asyncssh

from langchain_core.messages import HumanMessage
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.integrations.ssh_backend import SSHBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.execution.environments import Environment
from wandrun.runtime.context.compaction_archive import CompactionArchive
from wandrun.runtime.execution.files import TaskBackend, TaskFiles, _current_task
from wandrun.runtime.communication.messages import AgentOutput, SendMessage
from wandrun.runtime.communication.workers import WorkerManager
from wandrun.runtime.session import open_runtime
from wandrun.runtime.execution.workspace import Workspace

TARGET = os.environ.get("WANDRUN_SSH_TEST")
q = shlex.quote


def target() -> tuple[str, str, int]:
    user, _, rest = TARGET.rpartition("@")
    host, _, port = rest.partition(":")
    return user, host, int(port or 22)


def connect():
    user, host, port = target()
    return asyncssh.connect(host, port=port, username=user)


def unmatched(tag: str) -> str:
    """pkill/pgrep 的模式：匹配带标签的进程，但不匹配执行它的 shell 自身的命令行。"""
    return q(f"[{tag[0]}]{tag[1:]}")


async def cleanup(connection, tag: str, *paths: str) -> None:
    await connection.run(f"pkill -f {unmatched(tag)}", check=False)
    for path in paths:
        await connection.run(f"find {q(path)} -type d -exec chmod u+w {{}} + 2>/dev/null; rm -rf {q(path)}", check=False)
        assert (await connection.run(f"test -e {q(path)}", check=False)).exit_status != 0, path


@asynccontextmanager
async def prepared_remote_environment(workdir: str):
    """Bind a real SSH session to its Instabox owner, bypassing only provider discovery.

    The explicit SSH test target remains opt-in; no real Instabox account is used.
    No process-table tools or skill publication are needed by these scenarios.
    """
    connection = await connect()
    owner = InstaboxBackend("m_" + "a" * 26, workdir=workdir, termination_grace=0.5)
    owner._connection = connection
    owner._connections.append(connection)
    try:
        backend = await SSHBackend.start(
            connection, label=target()[1], workdir=workdir, timeout=20, termination_grace=0.5,
        )
        owner._backend = backend
        owner._sessions.append(backend)
        yield Environment(
            "vps", owner, f"{workdir}/.wandrun/skills", f"{workdir}/.wandrun/artifacts",
            description=f"远端工作区：{workdir}", type="instabox",
        )
    finally:
        await owner.aclose()


@unittest.skipUnless(TARGET, "设置 WANDRUN_SSH_TEST=user@host:port 以运行 SSH 集成测试")
class SSHBackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.connection = await connect()
        self.probe = await connect()  # 观察远端进程，不经被测会话
        self.workdir = f"/tmp/wandrun-test-{uuid4().hex[:12]} dir"
        self.tag = uuid4().hex[:10]
        self.backend = await self.start(self.connection)

    async def start(self, connection, workdir=None):
        return await SSHBackend.start(
            connection, label=target()[1], workdir=workdir or self.workdir, timeout=20, termination_grace=0.5
        )

    async def asyncTearDown(self):
        try:
            await self.backend.aclose()
        except BaseException:
            pass
        await cleanup(self.probe, self.tag, self.workdir, f"{self.workdir}-outside")
        for connection in (self.connection, self.probe):
            connection.close()
            await connection.wait_closed()

    async def running(self, tag=None) -> int:
        result = await self.probe.run(f"pgrep -f {unmatched(tag or self.tag)} | wc -l", check=False)
        return int(result.stdout)

    async def wait_running(self, count=1, tag=None):
        async with asyncio.timeout(20):
            while await self.running(tag) < count:
                await asyncio.sleep(0.1)

    def tree(self) -> str:
        """一个忽略 SIGTERM 的后台子进程加一个前台进程，都带标签。"""
        return f"sh -c 'trap \"\" TERM; sleep 30 # {self.tag}' & sleep 30 # {self.tag}\nwait"

    async def test_execute_runs_in_workdir_and_formats_result(self):
        result = await self.backend.aexecute("pwd; echo out; echo err >&2; exit 3")
        self.assertEqual(result.exit_code, 3)
        self.assertIn(self.workdir, result.output)
        self.assertIn("[stderr] err", result.output)
        self.assertIn("Exit code: 3", result.output)

    async def test_compaction_archive_is_readable_on_role_ssh_host(self):
        archive = CompactionArchive(f"{self.workdir}/.wandrun/artifacts", self.backend)
        raw = [HumanMessage(content="远端早期事实：圆锥编号 R-17", id="early")]
        segment = await archive.segment("ssh-thread", raw, 0, 1)
        index = await archive.index("ssh-thread", [segment])
        self.assertTrue(segment.startswith(f"{self.workdir}/.wandrun/artifacts/compaction/"))
        self.assertIn("R-17", str((await self.backend.aread(segment)).file_data))
        self.assertIn(segment, str((await self.backend.aread(index)).file_data))
        self.assertEqual(await archive.segment("ssh-thread", raw, 0, 1), segment)
        self.assertEqual((await self.probe.run(f"test -e {q(segment)}", check=False)).exit_status, 0)

    async def test_timeout_and_plain_124(self):
        result = await self.backend.aexecute(self.tree(), timeout=1)
        self.assertEqual(result.exit_code, 124)
        self.assertIn("timed out after 1 seconds", result.output)
        self.assertEqual(await self.running(), 0)
        plain = await self.backend.aexecute("printf actual-error; exit 124")
        self.assertIn("actual-error", plain.output)
        self.assertNotIn("timed out", plain.output)

    async def test_cancel_terminates_remote_group_before_propagating(self):
        running = asyncio.create_task(self.backend.aexecute(self.tree()))
        await self.wait_running(2)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertEqual(await self.running(), 0)

    async def test_background_holder_stays_cancellable(self):
        running = asyncio.create_task(self.backend.aexecute(f"sh -c 'sleep 30 # {self.tag}' & echo started"))
        await self.wait_running()
        await asyncio.sleep(0.5)
        self.assertFalse(running.done())
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        self.assertEqual(await self.running(), 0)

    async def test_early_cancellations_leave_the_session_usable(self):
        # 已写出的 run 可能在 cancel 到达前就执行完（契约只承诺“处理取消后不再启动”）；
        # 这里检查每次取消都以确认清理的 CancelledError 结束，且会话之后仍可用。
        for index in range(12):
            running = asyncio.create_task(self.backend.aexecute(f"sleep 0.5 # {self.tag}"))
            await asyncio.sleep(0)
            running.cancel()
            (outcome,) = await asyncio.gather(running, return_exceptions=True)
            self.assertIsInstance(outcome, asyncio.CancelledError)
        self.assertIn("still-usable", (await self.backend.aexecute("echo still-usable")).output)
        self.assertEqual(await self.running(), 0)

    async def test_many_concurrent_calls_and_cancelling_one(self):
        tags = [f"{self.tag}x{index}y" for index in range(12)]  # 多于 OpenSSH 默认每连接 10 个会话
        calls = [asyncio.create_task(self.backend.aexecute(f"sleep 30 # {tag}")) for tag in tags]
        for tag in tags:
            await self.wait_running(tag=tag)
        calls[0].cancel()
        with self.assertRaises(asyncio.CancelledError):
            await calls[0]
        self.assertEqual(await self.running(tags[0]), 0)
        self.assertEqual([await self.running(tag) for tag in tags[1:]], [1] * 11)
        for call in calls[1:]:
            call.cancel()
        await asyncio.gather(*calls, return_exceptions=True)
        self.assertEqual(await self.running(), 0)

    async def test_lost_host_connection_ends_remote_commands(self):
        # 宿主连接直接断开（不取消、不关闭）：会话服务读到 EOF，取消全部调用，不等命令期限。
        running = asyncio.create_task(self.backend.aexecute(f"sleep 30; touch late # {self.tag}"))
        await self.wait_running()
        self.connection.abort()
        await asyncio.gather(running, return_exceptions=True)
        async with asyncio.timeout(15):
            while await self.running():
                await asyncio.sleep(0.2)
        self.connection = await connect()
        self.backend = await self.start(self.connection)  # 同一工作目录可以重新打开

    async def test_close_stops_running_commands_and_rejects_new_ones(self):
        running = asyncio.create_task(self.backend.aexecute(self.tree()))
        await self.wait_running(2)
        await asyncio.to_thread(self.backend.close)  # 运行时在工作线程中调用
        self.assertEqual(await self.running(), 0)
        self.assertIn("远端没有完成该命令（cancelled）", (await running).output)
        with self.assertRaises(RuntimeError):
            await self.backend.aexecute("echo late")

    async def test_byte_truncation_is_reported_for_multibyte_output(self):
        result = await self.backend.aexecute("python3 -c \"print('中' * 100000)\"")
        self.assertTrue(result.truncated)
        self.assertIn("Output truncated", result.output)

    async def test_file_operations_through_base_sandbox(self):
        written = await self.backend.awrite(f"{self.workdir}/a/b/note.txt", "hello\nworld\n")
        self.assertIsNone(written.error)
        read = await self.backend.aread("a/b/note.txt")
        self.assertIn("world", str(read.file_data))
        self.assertIsNone((await self.backend.aedit(f"{self.workdir}/a/b/note.txt", "world", "there")).error)
        self.assertTrue((await self.backend.agrep("there", self.workdir)).matches)
        listing = await self.backend.als(f"{self.workdir}/a/b")
        self.assertEqual([entry["path"].rsplit("/", 1)[-1] for entry in listing.entries], ["note.txt"])
        download, missing, directory = await self.backend.adownload_files(["a/b/note.txt", "a/missing.txt", "a"])
        self.assertEqual(download.content, b"hello\nthere\n")
        self.assertEqual((missing.error, directory.error), ("file_not_found", "is_directory"))
        await self.backend.aupload_files([("parent.txt", b"file")])
        (nested,) = await self.backend.aupload_files([("parent.txt/child.bin", b"x")])
        self.assertEqual(nested.error, "invalid_path")

    async def test_transfer_paths_resolve_on_the_remote_side(self):
        await self.probe.run(
            f"cd {q(self.workdir)} && mkdir -p other/sub && echo other-marker > other/note "
            f"&& echo work-marker > note && ln -s other/sub link",
            check=True,
        )
        shell = await self.backend.aexecute("cat link/../note")
        (download,) = await self.backend.adownload_files(["link/../note"])
        self.assertIn("other-marker", shell.output)
        self.assertEqual(download.content, b"other-marker\n")

    async def test_start_refuses_managed_directories_linked_outside(self):
        outside = f"{self.workdir}-outside"
        workdir = f"{self.workdir}/linked"
        await self.probe.run(
            f"mkdir -p {q(outside)}/skills {q(workdir)} && touch {q(outside)}/skills/sentinel "
            f"&& ln -s {q(outside)} {q(workdir)}/.wandrun",
            check=True,
        )
        with self.assertRaisesRegex(RuntimeError, "符号链接"):
            await self.start(self.connection, workdir)
        sentinel = await self.probe.run(f"test -e {q(outside)}/skills/sentinel", check=False)
        self.assertEqual(sentinel.exit_status, 0)

    async def test_cancelling_sftp_setup_does_not_leak_channels(self):
        baseline = len(self.connection._channels)  # AsyncSSH 内部的通道表
        for _ in range(5):
            transfer = asyncio.create_task(self.backend.adownload_files(["missing.txt"]))
            await asyncio.sleep(0)  # SFTP 客户端尚在创建
            transfer.cancel()
            await asyncio.gather(transfer, return_exceptions=True)
        async with asyncio.timeout(10):
            while len(self.connection._channels) > baseline:
                await asyncio.sleep(0.1)

    async def test_sync_interface_from_worker_thread_only(self):
        result = await asyncio.to_thread(self.backend.execute, "echo threaded")
        self.assertIn("threaded", result.output)
        with self.assertRaises(RuntimeError):
            self.backend.execute("echo on-loop")


def call(call_id: str, command: str) -> dict:
    return {"type": "response.completed", "response": {"status": "completed", "output": [{
        "type": "function_call", "id": f"fc_{call_id}", "call_id": call_id,
        "name": "execute", "arguments": json.dumps({"command": command}),
    }]}}


def answer(text: str) -> dict:
    payload = {"messages": [{"to": "human", "task_id": None, "message": text}], "next": "done"}
    return {"type": "response.completed", "response": {"status": "completed", "output": [{
        "type": "message", "id": "m", "role": "assistant", "phase": "final_answer",
        "content": [{"type": "output_text", "text": json.dumps(payload)}],
    }]}}


@unittest.skipUnless(TARGET, "设置 WANDRUN_SSH_TEST=user@host:port 以运行 SSH 集成测试")
class SSHRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_role_executes_remotely_and_worker_cancel_stops_remote_command(self):
        workdir = f"/tmp/wandrun-test-{uuid4().hex[:12]}"
        tag = uuid4().hex[:10]
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.ensure_config()
            workspace.environments_config.write_text(
                'default = "vps"\n[environments.vps]\ntype = "instabox"\n'
                f'machine_id = "m_{"a" * 26}"\nworkdir = "{workdir}"\ntermination_grace = 0.5\n',
                encoding="utf-8",
            )
            bodies = []
            owners = []

            async def environments(config, workspace, stack, opened, **kwargs):
                environment = await stack.enter_async_context(prepared_remote_environment(workdir))
                opened.append(environment)
                owners.append(environment.backend)
                return {name: environment for name in config.agents}

            async def respond(model, body):
                bodies.append(body)
                if len(bodies) == 1:
                    yield call("where", "hostname; pwd")
                elif len(bodies) == 2:
                    yield answer("checked")
                else:
                    yield call("long", f"sleep 60 # {tag}")

            try:
                with (
                    patch.object(CodexSubscriptionModel, "_arequest", respond),
                    patch("wandrun.runtime.session.open_environments", environments),
                ):
                    async with open_runtime(
                        workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None
                    ) as runtime:
                        runtime.workers.start("where are you", "root")
                        self.assertEqual((await runtime.workers.wait("root"))["status"], "completed")
                        (output,) = [
                            item["output"] for item in bodies[1]["input"]
                            if item.get("type") == "function_call_output"
                        ]
                        self.assertIn(workdir, output)
                        self.assertNotIn(os.uname().nodename, output)

                        runtime.workers.start("run long", "root")
                        async with connect() as probe:
                            count = f"pgrep -f {unmatched(tag)} | wc -l"
                            async with asyncio.timeout(15):
                                while int((await probe.run(count, check=False)).stdout) < 1:
                                    await asyncio.sleep(0.2)
                            await asyncio.wait_for(runtime.workers.cancel("root"), 15)
                            self.assertEqual(runtime.workers.get("root")["status"], "cancelled")
                            self.assertEqual(int((await probe.run(count, check=False)).stdout), 0)
                    self.assertIsNotNone(owners[0]._recovery_feedback)
                    self.assertTrue(owners[0]._closed)
                    self.assertTrue(owners[0]._connection.is_closed())
            finally:
                async with connect() as connection:
                    await cleanup(connection, tag, workdir)


    async def test_same_ssh_conversation_uses_one_cwd_and_validated_peer_attachment(self):
        workdir = f"/tmp/wandrun-test-{uuid4().hex[:12]}"
        with tempfile.TemporaryDirectory() as directory:
            workspace = Workspace(Path(directory))
            workspace.ensure_config()
            try:
                async with prepared_remote_environment(workdir) as environment:
                    async def run(prompts, task_id):
                        return AgentOutput(messages=[], next="wait")

                    shown = []
                    manager = WorkerManager(
                        run, agent_workers={"main": ("child",), "child": ()},
                        default_agent="main",
                        on_human=lambda sender, text, attachments, draft_id: shown.append((text, attachments)),
                    )
                    files = TaskFiles(
                        workspace.root, manager,
                        {"main": ("vps", workdir), "child": ("vps", workdir)},
                        remote_backends={"main": environment.backend, "child": environment.backend},
                        conversation_workdirs=True,
                    )
                    manager._attachment_resolver = files.resolve_attachments
                    manager._attachment_preflight = files.prepare_attachments
                    try:
                        manager.start("begin", "root", agent_name="main")
                        await manager.wait("root")
                        manager.start("delegate", "child-task", sender_id="root", agent_name="child")
                        await manager.wait("child-task")
                        self.assertEqual(files.directory("root"), files.directory("child-task"))
                        path = files.directory("root")
                        view = TaskBackend(environment.backend, files)
                        token = _current_task.set("child-task")
                        try:
                            self.assertIsNone((await view.awrite("shared.txt", "remote-proof")).error)
                            self.assertIn(path, (await view.aexecute("pwd")).output)
                            bound = view.for_code_call()
                        finally:
                            _current_task.reset(token)
                        self.assertIn("remote-proof", str((await bound.aread("shared.txt")).file_data))
                        output = AgentOutput(messages=[
                            SendMessage(to="main", task_id="root", message="see file",
                                        attachments=["shared.txt", "absent.txt"]),
                        ], next="done")
                        prepared = await manager.prepare_attachments(output, "child-task")
                        self.assertEqual([item["accepted"] for item in prepared[0].resolution.receipts], [True, False])
                        self.assertEqual(prepared[0].resolution.attachments[0].path, f"{path}/shared.txt")
                        delivered = manager.dispatch(output, "child-task", prepared=prepared)[0]
                        self.assertTrue(delivered["accepted"])
                        self.assertEqual([item["accepted"] for item in delivered["attachments"]], [True, False])
                        await manager.wait("root")
                        cross = manager.dispatch(AgentOutput(messages=[
                            SendMessage(to="human", task_id=None, message="text survives",
                                        attachments=["shared.txt"]),
                        ], next="done"), "child-task")[0]
                        self.assertTrue(cross["accepted"])
                        self.assertFalse(cross["attachments"][0]["accepted"])
                        self.assertEqual(shown[-1], ("text survives", []))
                        await files.cleanup_conversation("root")
                        self.assertEqual((await environment.backend.aexecute(f"test -d {q(path)}")).exit_code, 0)
                        self.assertIsNone((await bound.adelete("shared.txt")).error)
                        await files.cleanup_conversation("root")
                        self.assertNotEqual((await environment.backend.aexecute(f"test -e {q(path)}")).exit_code, 0)
                    finally:
                        await manager.close()
            finally:
                async with connect() as connection:
                    await cleanup(connection, uuid4().hex, workdir)

if __name__ == "__main__":
    unittest.main()
