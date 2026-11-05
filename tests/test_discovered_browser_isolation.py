"""Two picker-discovered machines share defaults, never browser ownership.

Only provider/SSH boundaries are substituted. Runtime assembly, task relays,
lease accounting and the gateway remain real; no external machine is contacted.
"""

import asyncio
import base64
from contextlib import AsyncExitStack
import json
import os
from pathlib import Path
from uuid import uuid4
import shutil
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from deepagents.backends.protocol import ExecuteResponse
import asyncssh
import httpx
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.integrations.ssh_backend import SSHBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.execution.workspace import Workspace
from wandrun.runtime.session import open_runtime

from test_browser_leases import Client, discovery, until
from test_browser_relay import ExecConnection
from test_browser_stream import Viewer
from test_gateway_pairing import live_gateway
from test_instabox import ReadyBackend
from wandrun.gateway.http import create_app


class CommandConnection(ExecConnection):
    """Local relay execs with the same closure signal as a command SSH session."""

    def __init__(self, name, ssh):
        super().__init__()
        self.name = name
        self.ssh = ssh

    async def forward_local_port(self, *args, **kwargs):
        return await self.ssh.forward_local_port(*args, **kwargs)

    def is_closed(self):
        return self.closed.is_set()

    def close(self):
        self.closed.set()
        self.ssh.close()

    async def wait_closed(self):
        await super().wait_closed()
        await self.ssh.wait_closed()

    abort = close


class MachineCDP:
    """Small remote CDP peer: real sockets, deterministic pages and tagged frames.

    Target identifiers deliberately overlap between machines, like remote CDP
    namespaces do. Only the wire payload identifies which machine rendered it.
    """

    def __init__(self, name):
        self.name = name
        self.pages = {}
        self.next_page = 0
        self.streaming = set()
        self.frame_id = 0
        self.inputs = []

    def version(self):
        return {"Browser": "Chrome/test-peer", "Protocol-Version": "1.3",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/test"}

    async def discovery(self, connection, request):
        if request.path in ("/json/version", "/json/list"):
            value = self.version() if request.path == "/json/version" else [
                {"id": target, **info} for target, info in self.pages.items()
            ]
            body = json.dumps(value).encode()
            return Response(200, "OK", Headers({"Content-Type": "application/json",
                                               "Content-Length": str(len(body))}), body)

    async def emit_frame(self):
        self.frame_id += 1
        jpeg = b"\xff\xd8" + f"machine-{self.name}:{self.frame_id}".encode() + b"\xff\xd9"
        event = {"method": "Page.screencastFrame", "params": {
            "sessionId": self.frame_id, "data": base64.b64encode(jpeg).decode(),
            "metadata": {"deviceWidth": 800, "deviceHeight": 600,
                         "pageScaleFactor": 1, "offsetTop": 0,
                         "scrollOffsetX": 0, "scrollOffsetY": 0},
        }}
        for socket in tuple(self.streaming):
            await socket.send(json.dumps(event))
        return jpeg

    async def handle(self, socket):
        target = socket.request.path.rsplit("/", 1)[-1]
        try:
            async for raw in socket:
                message = json.loads(raw)
                method, params = message["method"], message.get("params", {})
                result = {}
                if method == "Browser.getVersion":
                    result = {"product": "Chrome/test-peer", "protocolVersion": "1.3"}
                elif method == "Target.getTargets":
                    result = {"targetInfos": list(self.pages.values())}
                elif method == "Target.createTarget":
                    self.next_page += 1
                    page = f"page-{self.next_page}"
                    self.pages[page] = {"targetId": page, "type": "page",
                                        "url": params["url"], "title": self.name, "value": ""}
                    result = {"targetId": page}
                elif method == "Target.closeTarget":
                    self.pages.pop(params["targetId"], None)
                    result = {"success": True}
                elif method == "Page.navigate":
                    self.pages[target]["url"] = params["url"]
                    await socket.send(json.dumps({"method": "Page.frameNavigated", "params": {
                        "frame": {"id": target, "url": params["url"], "loaderId": "loaded"},
                    }}))
                    result = {"frameId": target, "loaderId": "loaded"}
                elif method == "Runtime.evaluate":
                    expression = params["expression"]
                    if expression == "void 0":
                        evaluation = {"type": "undefined"}
                    elif expression == "[innerWidth,innerHeight,devicePixelRatio]":
                        evaluation = {"value": [800, 600, 1]}
                    elif expression == "document.querySelector('input').value":
                        evaluation = {"value": self.pages[target]["value"]}
                    else:
                        raise AssertionError(f"unexpected expression: {expression}")
                    result = {"result": evaluation}
                elif method == "Input.insertText":
                    self.inputs.append((target, params["text"]))
                    self.pages[target]["value"] += params["text"]
                elif method == "Page.startScreencast":
                    self.streaming.add(socket)
                    await self.emit_frame()
                elif method == "Page.stopScreencast":
                    self.streaming.discard(socket)
                elif method not in {"Target.setDiscoverTargets", "Page.enable", "Page.stopLoading",
                                    "Emulation.setFocusEmulationEnabled", "Page.screencastFrameAck"}:
                    raise AssertionError(f"unexpected CDP method: {method}")
                await socket.send(json.dumps({"id": message["id"], "result": result}))
        finally:
            self.streaming.discard(socket)


class MachineSSH(asyncssh.SSHServer):
    """Each loopback SSH server resolves the same remote 9222 to its own peer."""

    def __init__(self, port):
        self.port = port

    def connection_made(self, connection):
        self.connection = connection

    def begin_auth(self, username):
        return False

    def connection_requested(self, dest_host, dest_port, orig_host, orig_port):
        if (dest_host, dest_port) != ("127.0.0.1", 9222):
            return False
        return self.connection.forward_connection("127.0.0.1", self.port)


class DiscoveredBrowserIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = AsyncExitStack()
        self.addAsyncCleanup(self.stack.aclose)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.remotes = await self.stack.enter_async_context(AsyncExitStack())
        self.workspace = Workspace(Path(directory))
        self.workspace.runtime_dir.mkdir()
        self.workspace.environments_config.write_text(
            'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8",
        )
        self.workspace.mcps_config.write_text('[mcp_servers]\n', encoding="utf-8")
        shutil.copytree(
            Path(__file__).parents[1] / "src/wandrun/defaults/skills/browser",
            self.workspace.skills_dir / "browser",
        )
        agent = AgentDefinition("Work", "Work", "offline", environment="local",
                                skills=("browser",), code_mode=False)
        catalog = AgentCatalog("a", {"a": agent, "b": agent})
        self.store = GatewayStore(self.workspace.state_dir / "gateway.sqlite")
        self.stack.callback(self.store.close)
        self.store.import_agents(catalog)
        self.gateway = Gateway(self.store)
        self.machines = {name: "m_" + name * 26 for name in ("a", "b")}
        self.browsers, self.owners, self.connections = {}, {}, {}
        self.paths = {name: f"/machine-{name}/bin:/usr/bin:/bin" for name in self.machines}
        await self.open_browser_peers()
        client, connect_ssh = httpx.AsyncClient, asyncssh.connect
        authority = asyncssh.generate_private_key("ssh-ed25519").export_public_key().decode()

        def respond(request):
            path = request.url.path
            if path == "/v1/machines":
                return httpx.Response(200, json={"machines": [
                    {"id": machine, "name": name, "state": "running"}
                    for name, machine in self.machines.items()
                ]})
            machine = path.split("/")[3]
            name = next(name for name, identity in self.machines.items() if identity == machine)
            if path == f"/v1/machines/{machine}/connections":
                return httpx.Response(201, json={
                    "machineId": machine, "host": "127.0.0.1", "port": self.ssh[name].get_port(),
                    "username": machine, "certificate": "test-certificate",
                    "hostTrust": {"type": "ca", "publicKey": authority, "principals": ["127.0.0.1"]},
                })
            self.assertEqual(path, f"/v1/machines/{machine}")
            return httpx.Response(200, json={
                "id": machine, "state": "running", "operationId": None, "runtime": {"ready": True},
            })

        def http_client(**kwargs):
            if kwargs.get("base_url") == "https://api.instabox.sh":
                kwargs["transport"] = httpx.MockTransport(respond)
            return client(**kwargs)

        async def connect(host, *, port, username, **kwargs):
            name = next(name for name, machine in self.machines.items() if machine == username)
            # Only authentication is replaced: route using the provider endpoint,
            # never the owner for which product code intended to open a connection.
            ssh = await self.remotes.enter_async_context(connect_ssh(
                host, port=port, username=username, known_hosts=None, config=None, agent_path=None,
            ))
            connection = CommandConnection(name, ssh)
            self.remotes.push_async_callback(connection.cleanup)
            return connection

        async def start(connection, **kwargs):
            session = ReadyBackend()
            session.aexecute = AsyncMock(return_value=ExecuteResponse(
                output=self.paths[connection.name], exit_code=0, truncated=False,
            ))
            self.connections[connection.name] = connection
            return session

        for patcher in (
            patch.dict(os.environ, {"INSTABOX_API_KEY": "test-only"}),
            patch("wandrun.integrations.instabox.httpx.AsyncClient", new=http_client),
            patch("wandrun.integrations.instabox.asyncssh.import_certificate", return_value=object()),
            patch("wandrun.integrations.instabox.asyncssh.connect", side_effect=connect),
            patch.object(SSHBackend, "start", side_effect=start),
        ):
            self.stack.enter_context(patcher)
        self.runtime = await self.stack.enter_async_context(open_runtime(
            self.workspace, metrics=RunMetrics(self.workspace.runs_dir), agent_catalog=catalog,
            on_human=lambda *_: None, notify_human_of_roots=False,
        ))
        self.gateway.attach(self.runtime.workers, self.runtime.checkpointer, runtime=self.runtime)
        await self.gateway.list_execution_environments()
        for name, machine in self.machines.items():
            selected = "instabox-" + machine
            await self.gateway.update_agent(name, {"environment": selected})
            browser = self.runtime._assembly_for(name).capabilities.browser
            owner = browser.transport
            # Skill publication is unrelated to SSH machine selection.
            owner._prepare_skills = None
            self.browsers[name], self.owners[name] = browser, owner
            root = self.gateway.create_conversation("Machine " + name, name, client_id=uuid4().hex)[0]["id"]
            browser.register(name + "-task", root, name, name)

    async def open_browser_peers(self):
        if hasattr(self, "peers"):
            return
        self.ssh = {}
        self.peers = {}
        for name in ("a", "b"):
            peer = MachineCDP(name)
            server = await self.remotes.enter_async_context(serve(
                peer.handle, "127.0.0.1", 0, process_request=peer.discovery,
            ))
            port = server.sockets[0].getsockname()[1]
            ssh = await self.remotes.enter_async_context(await asyncssh.listen(
                "127.0.0.1", 0, server_factory=lambda port=port: MachineSSH(port),
                server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
            ))

            self.ssh[name] = ssh
            self.peers[name] = peer

    async def client(self, name, task=None):
        browser = self.browsers[name]
        task = task or name + "-task"
        environment = await browser.command_environment(task)
        client = Client(await connect(await discovery(environment), proxy=None))
        self.stack.push_async_callback(client.close)
        reply = await client.call("Browser.getVersion")
        self.assertIn("result", reply)
        return client, browser.lease_for_task(task)

    async def test_discovered_agents_map_commands_and_cache_path_per_machine(self):
        environments = await asyncio.gather(*(
            self.browsers[name].command_environment(name + "-task") for name in ("a", "b")
        ))
        cli = "/data/home/wandrun-browser/agent-browser"
        for name, environment in zip(("a", "b"), environments):
            self.assertEqual(environment["WANDRUN_BROWSER_CLI_DIR"], cli)
            self.assertEqual(environment["PATH"], cli + "/bin:" + self.paths[name])
            self.assertEqual(environment["WANDRUN_BROWSER_PORT"], "9222")
            self.assertEqual(environment["WANDRUN_BROWSER_PROFILE"], "/data/home/wandrun-browser/profile")
            relay, = self.connections[name].processes
            self.assertEqual(relay.child.returncode, None)
            again = await self.browsers[name].command_environment(name + "-task")
            self.assertEqual(again, environment)
            self.owners[name]._backend.aexecute.assert_awaited_once_with('printf %s "$PATH"')
            # Query through the actual mapped exec, not just inspect its URL.
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.get(environment["WANDRUN_BROWSER_CDP"] + "/json/wandrun/status")
            payload = response.json()
            self.assertEqual(payload["environment_id"], "instabox:" + self.machines[name])
        self.assertNotEqual(environments[0]["WANDRUN_BROWSER_CDP"], environments[1]["WANDRUN_BROWSER_CDP"])

    async def test_full_machine_does_not_consume_other_machines_page_budget(self):
        await self.open_browser_peers()
        (a, aid), (b, bid) = await asyncio.gather(self.client("a"), self.client("b"))
        limit = self.browsers["a"].config.max_pages
        for _ in range(limit - 1):
            self.assertIn("result", await a.call("Target.createTarget", {"url": "about:blank"}))
        denied = await a.call("Target.createTarget", {"url": "about:blank"})
        self.assertIn("页面总数已达上限", denied["error"]["message"])
        capacities = {row["environment_id"]: row["capacity"] for row in self.gateway.computer()["environments"]}
        self.assertEqual(capacities["instabox:" + self.machines["a"]]["pages_used"], limit)
        self.assertEqual(capacities["instabox:" + self.machines["b"]]["pages_used"], 1)
        self.assertIn("result", await b.call("Target.createTarget", {"url": "about:blank"}))
        self.assertEqual(self.browsers["b"].capacity()["pages_used"], 2)
        await self.gateway.close_browser_task(aid)
        self.assertEqual(self.gateway.browser_task(aid)["state"], "released")
        self.assertEqual(self.gateway.browser_task(bid)["state"], "agent")
        self.assertEqual(self.browsers["b"].capacity()["pages_used"], 2)
        self.assertIn("result", await b.call("Browser.getVersion"))

    async def test_phone_streams_and_input_stay_with_selected_machine(self):
        await self.open_browser_peers()
        (_, aid), (_, bid) = await asyncio.gather(self.client("a"), self.client("b"))
        await asyncio.gather(
            self.gateway.browser_control(aid, "takeover", "take-a"),
            self.gateway.browser_control(bid, "takeover", "take-b"),
        )
        app = create_app(self.gateway, token="isolation-device-token")
        async with live_gateway(app) as origin, AsyncExitStack() as viewers:
            clients = {}
            for name, lease in (("a", aid), ("b", bid)):
                socket = await viewers.enter_async_context(connect(
                    origin.replace("http:", "ws:") + f"/browser-tasks/{lease}/stream?mode=control",
                    additional_headers={"Authorization": "Bearer isolation-device-token"}, proxy=None,
                ))
                clients[name] = Viewer(socket)
            shown_a, shown_b = await asyncio.gather(clients["a"].frame(), clients["b"].frame())
            self.assertIn(b"machine-a:", shown_a["jpeg"])
            self.assertIn(b"machine-b:", shown_b["jpeg"])
            # Identical page IDs on the remote peers must not collapse ownership.
            self.assertEqual(shown_a["page"], shown_b["page"])
            reply = await clients["a"].command("text", shown_a, text="only-A")
            self.assertEqual(reply["t"], "input_done")
            self.assertEqual(self.peers["a"].inputs, [(shown_a["page"], "only-A")])
            self.assertEqual(self.peers["b"].inputs, [])
            for name, lease, expected in (("a", aid, "only-A"), ("b", bid, "")):
                value = await self.runtime.browser_for_lease(lease).page_call(
                    lease, self.gateway.browser_task(lease)["current"], "Runtime.evaluate",
                    {"expression": "document.querySelector('input').value", "returnByValue": True},
                )
                self.assertEqual(value["result"]["value"], expected)
            next_a, next_b = await asyncio.gather(
                self.peers["a"].emit_frame(), self.peers["b"].emit_frame(),
            )
            frame_a, frame_b = await asyncio.gather(
                clients["a"].frame(), clients["b"].frame(),
            )
            self.assertEqual(frame_a["jpeg"], next_a)
            self.assertEqual(frame_b["jpeg"], next_b)
            self.assertNotEqual(frame_a["jpeg"], frame_b["jpeg"])

    async def test_command_reconnect_revokes_only_own_lease_and_path_cache(self):
        await self.open_browser_peers()
        (_, aid), (b, bid) = await asyncio.gather(self.client("a"), self.client("b"))
        before_b = await self.browsers["b"].command_environment("b-task")
        old_a = self.owners["a"]._backend
        self.connections["a"].close()
        await until(lambda: self.browsers["a"].detail(aid)["state"] == "stopping")
        await self.owners["a"]._browser._loss
        self.assertEqual(self.gateway.browser_task(bid)["state"], "agent")
        self.assertEqual(self.browsers["b"].capacity()["pages_pending_cleanup"], 0)
        self.assertIn("result", await b.call("Browser.getVersion"))

        new_path = "/machine-a/reconnected:/usr/bin:/bin"
        self.paths["a"] = new_path
        # Reconnect through real preparation; the first operation must report
        # recovery without replay, before the unchanged old-scene checks below.
        # No model worker consumes feedback in this fixture; acknowledge its sink.
        self.owners["a"].bind_recovery_feedback(AsyncMock(return_value=True))
        recovered = await self.owners["a"].aexecute("must-not-replay")
        self.assertIsNone(recovered.exit_code)
        session = self.owners["a"]._backend
        session.aexecute.assert_not_awaited()
        notice = await self.browsers["a"].command_environment("a-task")
        self.assertEqual(notice["PATH"], "/data/home/wandrun-browser/agent-browser/bin:" + new_path)
        stale = Client(await connect(await discovery(notice), proxy=None))
        self.stack.push_async_callback(stale.close)
        self.assertIn("error", await stale.call("Browser.getVersion"))
        _, replacement = await self.client("a")
        self.assertNotEqual(replacement, aid)
        self.assertEqual(self.gateway.browser_task(aid)["state"], "released")
        self.assertEqual(self.browsers["a"].capacity()["pages_pending_cleanup"], 0)
        session.aexecute.assert_awaited_once_with('printf %s "$PATH"')
        old_a.aexecute.assert_awaited_once_with('printf %s "$PATH"')
        after_b = await self.browsers["b"].command_environment("b-task")
        self.assertEqual(after_b, before_b)
        self.owners["b"]._backend.aexecute.assert_awaited_once_with('printf %s "$PATH"')
        self.assertEqual(self.gateway.browser_task(bid)["state"], "agent")
        self.assertIn("result", await b.call("Browser.getVersion"))
