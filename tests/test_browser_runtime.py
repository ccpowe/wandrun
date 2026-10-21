"""Real local command paths use the owning task's CDP endpoint, including Code Mode."""

import asyncio
import json
import os
import select
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen

import pydantic_monty as pm
from langchain.messages import AIMessage, ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from wandrun.config import BrowserDefinition
from wandrun.integrations.browser_dev import ChromeDev
from wandrun.integrations.local_processes import ProcessTable
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.runtime.browser_tools import BrowserTakeoverMiddleware
from wandrun.runtime.browser import BrowserLeases, BrowserRejected
from wandrun.runtime.code_mode import CodeModeCatalog, code_mode_tool
from wandrun.runtime.files import TaskBackend
from wandrun.runtime.session import _browser_notify
from wandrun.runtime.process_tools import process_tools
from wandrun.runtime.workers import WorkerManager


# The child opens the actual task endpoint, then queries CDP targets. Environment
# forwarding alone cannot satisfy these assertions: a lease is created on connect.
CLIENT = '''import json, os
from urllib.request import urlopen
from websockets.sync.client import connect
base = os.environ["WANDRUN_BROWSER_CDP"]
with urlopen(base + "/json/version", timeout=5) as response:
    ws_url = json.load(response)["webSocketDebuggerUrl"]
with connect(ws_url, open_timeout=5) as socket:
    socket.send(json.dumps({"id": 1, "method": "Target.getTargets"}))
    while True:
        reply = json.loads(socket.recv(timeout=8))
        if reply.get("id") == 1:
            if "error" in reply:
                raise RuntimeError(reply["error"])
            print(json.dumps(sorted(target["targetId"] for target in reply["result"]["targetInfos"]
                                    if target["type"] == "page")))
            break
'''


class BrowserToolRejectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_without_page_returns_tool_feedback_and_worker_continues(self):
        browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:9222"))
        observations = []
        replies = []
        graph = None

        async def run(prompts, task_id):
            result = await graph.ainvoke(
                {"messages": prompts}, config={"configurable": {"thread_id": task_id}},
            )
            observations.extend(message for message in result["messages"] if isinstance(message, ToolMessage))
            replies.append(result["messages"][-1].content)
            return "done"

        manager = WorkerManager(run)
        (request,) = BrowserTakeoverMiddleware(manager, browser).tools
        flow = StateGraph(MessagesState)

        async def model(state):
            results = [message for message in state["messages"] if isinstance(message, ToolMessage)]
            if not results:
                return {"messages": [AIMessage(content="", tool_calls=[{
                    "name": "request_takeover", "args": {"reason": "请登录"},
                    "id": "request-1", "type": "tool_call",
                }])]}
            return {"messages": [AIMessage(
                content="先打开浏览器，再请求接管" if "任务尚未使用浏览器" in results[-1].content else "重试",
            )]}

        flow.add_node("model", model)
        flow.add_node("tools", ToolNode([request]))
        flow.add_edge(START, "model")
        flow.add_conditional_edges(
            "model", lambda state: "tools" if state["messages"][-1].tool_calls else END,
        )
        flow.add_edge("tools", "model")
        graph = flow.compile()
        try:
            manager.start("请让我接管", "root")
            result = await manager.wait("root")
            self.assertEqual(result["status"], "completed")
            self.assertEqual(len(observations), 1)
            self.assertEqual(observations[0].tool_call_id, "request-1")
            self.assertIn("浏览器接管请求被拒绝：任务尚未使用浏览器", observations[0].content)
            self.assertEqual(replies, ["先打开浏览器，再请求接管"])
        finally:
            await manager.close()

    async def test_request_only_converts_browser_rejection(self):
        class Manager:
            def ensure_active(self, task_id):
                return None

        class Browser:
            failure = None

            async def request_takeover(self, task_id, reason):
                raise self.failure

        browser = Browser()
        (request,) = BrowserTakeoverMiddleware(Manager(), browser).tools
        browser.failure = BrowserRejected("当前控制状态不能请求接管")
        feedback = await request.ainvoke(
            {"reason": "请登录"}, config={"configurable": {"thread_id": "root"}},
        )
        self.assertIn("当前控制状态不能请求接管", feedback["error"])
        for failure in (asyncio.CancelledError(), RuntimeError("browser state corrupt")):
            browser.failure = failure
            with self.subTest(failure=type(failure).__name__), self.assertRaises(type(failure)):
                await request.ainvoke(
                    {"reason": "请登录"}, config={"configurable": {"thread_id": "root"}},
                )


class BrowserOwnerNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_takeover_interrupts_only_owner_execution_then_handback_wakes_owner(self):
        owner_entered = asyncio.Event()
        other_entered = asyncio.Event()
        owner_interrupted = asyncio.Event()
        release_other = asyncio.Event()
        prompts_by_task = {}

        async def run(prompts, task_id):
            prompts_by_task.setdefault(task_id, []).append(prompts)
            if task_id == "holder" and len(prompts_by_task[task_id]) == 1:
                owner_entered.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    owner_interrupted.set()
                    raise
            if task_id == "unrelated":
                other_entered.set()
                await release_other.wait()
            return "done"

        manager = WorkerManager(
            run,
            agent_workers={"entry": ("browser", "other"), "browser": (), "other": ()},
            default_agent="entry",
        )
        try:
            manager.start("first", "root", agent_name="entry")
            await manager.wait("root")
            manager.start("browse", "holder", agent_name="browser", sender_id="root")
            manager.start("other work", "unrelated", agent_name="other", sender_id="root")
            await asyncio.wait_for(asyncio.gather(owner_entered.wait(), other_entered.wait()), 2)

            await _browser_notify(manager, "holder", "用户正在接管浏览器", True)
            await asyncio.wait_for(owner_interrupted.wait(), 2)
            self.assertEqual(manager.get("unrelated")["status"], "running")
            self.assertFalse(manager.is_stopped("holder"))
            self.assertEqual((await asyncio.wait_for(manager.wait("holder"), 2))["status"], "completed")
            takeover = prompts_by_task["holder"][1]
            self.assertTrue(any(
                item.additional_kwargs.get("source") == "runtime" and "taken_over" in item.content
                for item in takeover
            ))
            self.assertFalse(any(
                "browser_control" in item.content for batch in prompts_by_task["root"] for item in batch
            ))

            await _browser_notify(manager, "holder", "浏览器已交还", False)
            self.assertEqual((await asyncio.wait_for(manager.wait("holder"), 2))["status"], "completed")
            self.assertTrue(any(
                item.additional_kwargs.get("source") == "runtime" and "handed_back" in item.content
                for item in prompts_by_task["holder"][2]
            ))
            self.assertEqual(manager.get("unrelated")["status"], "running")
            release_other.set()
            self.assertEqual((await asyncio.wait_for(manager.wait("unrelated"), 2))["status"], "completed")
        finally:
            release_other.set()
            await manager.close()


@unittest.skipUnless(
    shutil.which("Xvfb") and (shutil.which("google-chrome") or Path("/opt/google/chrome/chrome").is_file()),
    "需要 Xvfb 与 Google Chrome",
)
class BrowserCommandEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_exec_command_and_code_mode_reach_only_their_task_pages(self):
        with tempfile.TemporaryDirectory() as directory, ChromeDev() as chrome:
            root = Path(directory)
            script = root / "cdp_client.py"
            script.write_text(CLIENT, encoding="utf-8")
            command = f"{shlex.quote(sys.executable)} {shlex.quote(str(script))}"
            leases = BrowserLeases(BrowserDefinition(chrome.cdp_url, slots=2), state_path=root / "leases.json")
            await leases.start()
            table = ProcessTable(cwd=root, log_dir=root / "logs", termination_grace=0.1)
            results = {}
            invoke = None

            async def run(_prompts, task_id):
                results[task_id] = await invoke.ainvoke(
                    {"command": command}, config={"configurable": {"thread_id": task_id}},
                )
                return "done"

            manager = WorkerManager(run)
            invoke = process_tools(manager, table, browser=leases)[0]
            try:
                leases.register("task-a", "root-a", "browser-agent", "entry-a")
                leases.register("task-b", "root-b", "browser-agent", "entry-b")
                manager.start("browse a", "task-a")
                manager.start("browse b", "task-b")
                await asyncio.gather(manager.wait("task-a"), manager.wait("task-b"))
                pages = {}
                for task_id in ("task-a", "task-b"):
                    self.assertEqual(results[task_id]["exit_code"], 0, results[task_id])
                    pages[task_id] = set(json.loads(results[task_id]["output"]))
                    self.assertEqual(len(pages[task_id]), 1)
                self.assertTrue(pages["task-a"].isdisjoint(pages["task-b"]))

                backend = ManagedShellBackend(root_dir=root, virtual_mode=False, inherit_env=True, timeout=10)
                try:
                    async with pm.AsyncMonty() as pool:
                        tool = code_mode_tool(
                            pool,
                            TaskBackend(backend, lambda _: str(root), task_id="task-a", browser=leases),
                            CodeModeCatalog([], []),
                        )
                        result = await tool.ainvoke({
                            "type": "tool_call", "id": "call_1", "name": "run_code",
                            "args": {"code": f'print((await execute({command!r}))["output"])'},
                        })
                        self.assertEqual(result.status, "success", result.content)
                        self.assertIn(next(iter(pages["task-a"])), result.content)
                        self.assertNotIn(next(iter(pages["task-b"])), result.content)
                finally:
                    backend.close()
            finally:
                await manager.close()
                await table.aclose()
                await leases.aclose()

@unittest.skipUnless(
    shutil.which("Xvfb") and (shutil.which("google-chrome") or Path("/opt/google/chrome/chrome").is_file()),
    "需要 Xvfb 与 Google Chrome",
)
class BrowserLauncherTests(unittest.TestCase):
    def test_private_xvfb_ignores_host_gnome_wayland_session(self):
        desktop = {
            "XDG_SESSION_TYPE": "wayland",
            "XDG_CURRENT_DESKTOP": "GNOME",
            "DESKTOP_SESSION": "gnome",
            "WAYLAND_DISPLAY": "wayland-0",
            "GNOME_DESKTOP_SESSION_ID": "this-is-deprecated",
            "GNOME_SHELL_SESSION_MODE": "ubuntu",
        }
        with patch.dict(os.environ, desktop), ChromeDev() as chrome:
            with urlopen(f"{chrome.cdp_url}/json/version", timeout=5) as response:
                self.assertTrue(json.load(response)["webSocketDebuggerUrl"])

    def test_startup_failure_reports_bounded_chrome_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            fake_chrome = Path(directory) / "chrome"
            fake_chrome.write_text(
                "#!/bin/sh\nprintf '%5000s' '' >&2\n"
                "printf 'synthetic chrome failed\\n' >&2\nexit 7\n",
            )
            fake_chrome.chmod(0o700)
            with self.assertRaisesRegex(RuntimeError, "synthetic chrome failed") as failure:
                with ChromeDev(chrome_path=str(fake_chrome)):
                    self.fail("A failed Chrome must never expose CDP")
            self.assertIn("退出码 7", str(failure.exception))
            self.assertLessEqual(len(str(failure.exception)), 4200)

    def test_occupied_cdp_port_is_rejected(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            with self.assertRaises(OSError):
                with ChromeDev(port=occupied.getsockname()[1]):
                    self.fail("An occupied CDP port must not be treated as our Chrome")

    def test_sigterm_cleans_profile_and_child_processes(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            sock.close()
            launcher = subprocess.Popen(
                [sys.executable, "-m", "wandrun.integrations.browser_dev", "--port", str(port)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                env={**os.environ, "TMPDIR": directory},
            )
            children = []
            try:
                ready, _, _ = select.select([launcher.stdout], [], [], 25)
                self.assertTrue(ready, "Chrome launcher did not become ready")
                line = launcher.stdout.readline()
                self.assertIn("profile=", line)
                profile = Path(line.split("profile=", 1)[1].strip())
                children = [
                    int(pid) for pid in
                    Path(f"/proc/{launcher.pid}/task/{launcher.pid}/children").read_text().split()
                ]
                self.assertGreaterEqual(len(children), 2)
                launcher.send_signal(signal.SIGTERM)
                self.assertEqual(launcher.wait(timeout=10), 143)
                self.assertFalse(profile.exists())
                for pid in children:
                    self.assertFalse(Path(f"/proc/{pid}").exists(), f"child {pid} survived SIGTERM")
            finally:
                if launcher.poll() is None:
                    launcher.kill()
                    launcher.wait(timeout=10)
                for pid in children:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                launcher.stdout.close()
