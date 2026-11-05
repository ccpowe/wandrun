"""协议测试网关：真实的 Gateway、WorkerManager、HTTP/SSE、SQLite 与 MCP 连接池。

Agent 执行和 MCP 传输换成可预测的桩；连接器增删改查和状态仍经过真实网关与连接池。
手动运行：uv run python test/stub_gateway.py <数据库路径> <端口>（协议测试直接启动本 worktree 解释器）
端口 0 由系统分配；stdout 首行报告 STUB_GATEWAY_PORT，之后仍须用 HTTP 确认就绪。
"""

import asyncio
import json
import os
import socket
import sys
from contextlib import AsyncExitStack
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from starlette.responses import Response
import uvicorn
from langchain.messages import AIMessage
from langchain_core.tools import StructuredTool
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from wandrun.config import (
    AgentCatalog, AgentDefinition, EnvironmentDefinition, RuntimeConfig, validate_catalog,
)
from wandrun.integrations import mcp as mcp_integration
from wandrun.integrations.codex_credentials import CodexCredentials
from wandrun.gateway.connectors import mcp_config
from wandrun.gateway.capabilities import gateway_capabilities
from wandrun.gateway.http import create_app
from wandrun.gateway.subscription import SubscriptionData
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.runtime.context.memory import MemoryStore
from wandrun.runtime.communication.messages import AgentOutput, SendMessage
from wandrun.runtime.execution.files import TaskFiles
from wandrun.runtime.agent.capabilities import ResolvedCapabilities, resolve_capabilities
from wandrun.runtime.communication.workers import WorkerManager
from wandrun.runtime.browser.leases import UnknownBrowserTask

def codex_upstream(request):
    """Only the Codex HTTP boundary is faked; gateway routes and SQLite remain real."""
    assert request.headers["Authorization"] == "Bearer x.e30.x"
    assert request.headers["ChatGPT-Account-ID"] == "mobile-test"
    if request.url.path == "/backend-api/codex/models":
        assert request.url.params["client_version"] == "0.163.0"
        return httpx.Response(200, json={"models": [{
            "slug": "offline",
            "display_name": "Offline fixture",
            "description": "Local execution fixture",
            "visibility": "list",
            "priority": 1,
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [
                {"effort": "medium", "description": "Regular"},
                {"effort": "high", "description": "Deeper"},
                {"effort": "max", "description": "Most"},
                {"effort": "ultra", "description": "Extended"},
            ],
            "multi_agent_reasoning_effort": "high",
        }]})
    assert request.url.path == "/backend-api/wham/usage"
    return httpx.Response(200, json={
        "plan_type": "plus",
        "rate_limit": {
            "allowed": True,
            "limit_reached": False,
            "primary_window": {
                "used_percent": 25, "limit_window_seconds": 604800, "reset_at": 1_760_604_800,
            },
        },
    })


class StubMCPAdapter:
    """仅代替远端 MCP 会话；连接池的共享打开、状态和关闭逻辑保持真实。"""

    def __init__(self, config):
        definition = next(iter(config.transport.config.mcpServers.values()))
        self.connection = definition.model_dump(mode="json", exclude_none=True)
        self.client = self

    async def __aenter__(self):
        if self.connection.get("url", "").endswith("/fail"):
            secret = next(iter(self.connection.get("headers", {}).values()), "transport")
            raise RuntimeError(f"transport refused credential {secret}")
        return self

    async def __aexit__(self, exc_type, exc, tb):
        pass

    async def close(self):
        pass

    async def list_tools(self, *, cache_mode=None):
        async def echo(text: str) -> str:
            return text

        return [StructuredTool.from_function(name="echo", description="Echo text", coroutine=echo)]


mcp_integration.MCPAdapter = StubMCPAdapter


async def main(database: str, port: int) -> None:
    # This subprocess also runs directly from pnpm tests, without a shell-provided
    # sandbox. Keep even credential-directory metadata checks in its fixture.
    home = Path(database + ".home").absolute()
    home.mkdir(exist_ok=True)
    os.environ.update(HOME=str(home), CODEX_HOME=str(Path(database + ".codex").absolute()))
    os.environ.pop("WANDRUN_CODEX_HOME", None)
    store = GatewayStore(Path(database))
    if not store.has_imported_agents():
        # 换库的用例也要有可用的入口 Agent；桩的执行不看定义内容。
        def definition(description, workers=()):
            return AgentDefinition(description=description, system_prompt="桩", model="offline", workers=workers, environment="local")

        store.import_agents(AgentCatalog("assistant", {
            "assistant": definition("测试用 Agent", ("helper",)),
            "helper": definition("assistant 的成员"),
        }))
    auth_dir = Path(database + ".codex")
    auth_dir.mkdir(exist_ok=True)
    (auth_dir / "auth.json").write_text(json.dumps({
        "auth_mode": "chatgpt",
        "tokens": {"access_token": "x.e30.x", "account_id": "mobile-test"},
    }))
    credentials = CodexCredentials.gateway(auth_dir)
    subscription = SubscriptionData(store, transport=httpx.MockTransport(codex_upstream), credentials=credentials)
    gateway = Gateway(store, subscription=subscription)
    memory = MemoryStore(Path(database + ".memory"))
    workspace = Path(database + ".workspace")
    workspace.mkdir(exist_ok=True)
    gateway.skills_dir = workspace / ".wandrun" / "skills"
    files = TaskFiles(workspace, None,
                      {name: ("local", str(workspace)) for name in store.agent_catalog().agents},
                      conversation_workdirs=True)
    manager: WorkerManager

    async def run(prompts, task_id):
        text = prompts[-1].content
        if text == "COLLAB_DELEGATE":
            manager.dispatch(AgentOutput(messages=[
                SendMessage(to="helper", task_id=None, message="COLLAB_MEMBER_WAIT"),
            ], next="wait"), task_id)
            return AgentOutput(messages=[], next="wait")
        if text.endswith("COLLAB_MEMBER_WAIT"):
            # 只由成员 HTTP 插话取消；不靠睡眠猜测委派是否已经开始。
            await asyncio.Event().wait()
        if text.startswith("COLLAB_RESULT:"):
            result = text.removeprefix("COLLAB_RESULT:")
            _, parent = manager.task_identity(task_id)
            manager.dispatch(AgentOutput(messages=[
                SendMessage(to="human", task_id=None, message=f"成员私有正文：{result}"),
                SendMessage(to="assistant", task_id=parent, message=f"COLLAB_PARENT:{result}"),
            ], next="done"), task_id)
            return AgentOutput(messages=[], next="done")
        if "COLLAB_PARENT:" in text:
            result = text.rsplit("COLLAB_PARENT:", 1)[1]
            manager.dispatch(AgentOutput(messages=[
                SendMessage(to="human", task_id=None, message=f"收到协作结果：{result}"),
            ], next="done"), task_id)
            return AgentOutput(messages=[], next="done")
        if text in {"UI_FORM", "UI_SEND"}:
            spec = {
                "root": "root",
                "elements": {
                    "root": {"type": "Stack", "props": {}, "children": ["choice", "note", "submit"]},
                    "choice": {"type": "ChoiceGroup", "props": {
                        "stateKey": "plan", "label": "选择方案",
                        "options": [{"value": "A", "label": "方案甲"}, {"value": "B", "label": "方案乙"}],
                    }, "children": []},
                    "note": {"type": "TextInput", "props": {"stateKey": "note", "label": "备注"}, "children": []},
                    "submit": {"type": "Submit", "props": {"label": "提交"}, "children": []},
                },
                "state": {"plan": "", "note": ""},
            }
            if text == "UI_SEND":
                spec = {"root": "follow", "elements": {
                    "follow": {"type": "FollowUps", "props": {"items": [
                        {"label": "举例", "text": "请给出一个具体例子。"},
                        {"label": "展开", "text": "请继续展开上一条结论。"},
                    ]}, "children": []},
                }, "state": {}}
            manager.dispatch(AgentOutput(messages=[
                SendMessage(to="human", task_id=None,
                            message="```wandrun-ui\n" + json.dumps(spec, ensure_ascii=False) + "\n```"),
            ], next="wait"), task_id)
            return "done"
        if text.startswith("FILE_DELIVERY:"):
            await files.prepare(task_id)
            name = text.removeprefix("FILE_DELIVERY:")
            (Path(files.directory(task_id)) / name).write_text("original:" + name)
            manager.dispatch(AgentOutput(messages=[
                SendMessage(to="human", task_id=None, message="文件已交付", attachments=[name]),
            ], next="wait"), task_id)
            return "done"
        marker = "MEMORY_UPDATE_MEMBER:"
        if marker in text:
            target, content = text.rsplit(marker, 1)[1].split(":", 1)
            if text.startswith(marker):
                manager.dispatch(AgentOutput(messages=[
                    SendMessage(to=target, task_id=None, message=text),
                ], next="wait"), task_id)
                return "done"
            if manager.agent_name(task_id) == target:
                snapshot = memory.read(target)
                memory.save(target, content, snapshot.version, task_id=task_id)
                manager.dispatch(AgentOutput(messages=[
                    SendMessage(to="human", task_id=None, message="成员记忆已更新"),
                ], next="wait"), task_id)
                return "done"
        if text == "CONTEXT_COMPACT_CHILD":
            manager.start("CONTEXT_COMPACT_RUN:child", sender_id=task_id, agent_name="helper")
            return "done"
        if text == "CONTEXT_COMPACT_ROOT" or text.endswith("CONTEXT_COMPACT_RUN:child"):
            event = {
                "status": "completed", "agent_name": manager.agent_name(task_id),
                "event_id": "compacted-1", "generation": 1, "reason": "threshold", "cutoff_index": 20,
                "summary_text": "## 目标\n保留原话与完整摘要\n\n## 关键标识\n末尾事实 42",
                "archive_path": "/workspace/.wandrun/artifacts/compaction/index.md",
                "created_at": "2026-10-12T10:00:00+00:00",
                "keep_tokens": 2000, "retained_tokens": 2048, "retention_reason": "target",
                "summary_model": "offline", "summary_usage": {"input_tokens": 300},
            }
            gateway.on_compaction(task_id, event)
            gateway.on_compaction(task_id, event)
            if text.endswith(":child"):
                gateway.on_compaction(task_id, {
                    "status": "failed", "agent_name": "helper",
                    "error": "ArchiveError", "message": "留档无法写入",
                })
            return "done"
        if "慢" in text:
            tool_call = {"name": "exec_command", "args": {}, "id": "call-1"}
            gateway.on_update(task_id, {"type": "updates", "data": {"model": {"messages": [AIMessage("", tool_calls=[tool_call])]}}})
            await asyncio.Event().wait()
        reply = AgentOutput(messages=[SendMessage(to="human", task_id=None, message=f"收到：{text}")], next="wait")
        manager.dispatch(reply, task_id)
        return "done"

    manager = WorkerManager(
        run, agent_workers={name: agent.workers for name, agent in store.agent_catalog().agents.items()},
        default_agent=store.agent_catalog().main_agent, on_human=gateway.on_human,
        on_task=gateway.on_task, validate_human=gateway.validate_human,
        on_task_created=gateway.on_task_created, on_task_message=gateway.on_task_message,
        notify_human_of_roots=False, attachment_resolver=files.resolve_attachments)
    files.manager = manager
    servers, descriptions = mcp_config(store.connector_definitions())
    class StubRuntime:
        """桩执行沿用真实目录校验和 MCP 连接池，不构造模型图。"""

        default_environment = "local"

        def __init__(self, mcp):
            self.browsers = {}
            self.mcp = mcp
            self.memory = memory
            self.files = files
            self.config = RuntimeConfig(
                main_agent=store.agent_catalog().main_agent,
                agents=store.agent_catalog().agents,
                mcp_servers=servers,
                mcp_descriptions=descriptions,
                environments={"local": EnvironmentDefinition(type="local")},
            )
            self.environment_definitions = self.config.environments
            self.agent_tasks_pending = manager.running_tasks
            self.file_transfers_pending = lambda _agent: False
            self._entry_capabilities = gateway_capabilities(gateway)
            self._assemblies = self._snapshots(self.config.agents)

        def browser_for_lease(self, lease_id):
            """The stub owns no browser resources, just like an empty Runtime."""
            raise UnknownBrowserTask(lease_id)

        def _snapshots(self, agents):
            # The test runner substitutes execution, but keeps the gateway's committed
            # assembly boundary. These tool names model installed local stub tools.
            environment = SimpleNamespace(name="local", type="local", processes=object())
            installed = {
                "files": ("ls", "read_file", "write_file", "edit_file", "delete", "glob", "grep"),
                "processes": ("exec_command", "kill_process"),
                "schedule": ("create_schedule",),
                "image_generation": ("generate_image",),
                "uploads": ("fetch_upload",),
            }
            result = {}
            for identity, definition in agents.items():
                resolved = resolve_capabilities(
                    definition, environment, memory=memory, files=files,
                    searchable=definition.searchable_mcp_servers, browser=None,
                    browser_environments=(), entry_capabilities=self._entry_capabilities,
                )
                entries = {
                    key: replace(entry, tools=installed.get(key, ()) if entry.status == "enabled" else ())
                    for key, entry in resolved.entries.items()
                }
                result[identity] = SimpleNamespace(capabilities=ResolvedCapabilities(entries, resolved.browser))
            return result

        def _assembly_for(self, identity):
            return self._assemblies[identity]

        async def prepare_agents(self, catalog, model_context_windows=None):
            prepared = validate_catalog(catalog, self.config)
            for definition in prepared.agents.values():
                for server in (*definition.mcp_servers, *definition.searchable_mcp_servers):
                    await self.mcp.open(server, prepared.mcp_servers[server])
            snapshots = self._snapshots(prepared.agents)
            manager._check_agent_workers(
                {name: definition.workers for name, definition in prepared.agents.items()},
                prepared.main_agent,
            )

            def commit():
                manager.replace_agent_workers(
                    {name: definition.workers for name, definition in prepared.agents.items()},
                    prepared.main_agent,
                )
                files.update_environments(
                    {name: ("local", str(workspace)) for name in prepared.agents}, {},
                )
                self.config = prepared
                self._assemblies = snapshots

            return commit

        def prepare_connectors(self, servers, descriptions):
            prepared = validate_catalog(
                self.config.catalog,
                replace(self.config, mcp_servers=servers, mcp_descriptions=descriptions),
            )

            def commit():
                self.config = prepared

            return commit


    resources = AsyncExitStack()
    mcp = await resources.enter_async_context(mcp_integration.MCPConnectionPool())
    checkpointer = await resources.enter_async_context(
        AsyncSqliteSaver.from_conn_string(database + ".checkpoints.sqlite")
    )
    gateway.attach(manager, checkpointer, runtime=StubRuntime(mcp))
    gateway.enable_uploads()
    gateway.uploads.recover()
    await gateway.resume_deletions()
    app = create_app(gateway, "dev", management_token="mobile-test-management")

    def require_file_auth(request):
        if app.state.device_auth.identify(request.headers.get("authorization")) is None:
            return Response(json.dumps({"error": {"code": "unauthorized"}}),
                            status_code=401, media_type="application/json")
        return None

    async def file_preview(request):
        unauthorized = require_file_auth(request)
        if unauthorized is not None:
            return unauthorized
        file_id = request.path_params["file_id"].lower()
        if "video" in file_id:
            kind = "video"
            width, height, duration_ms, page_count = 1920, 1080, 73_000, None
        elif "audio" in file_id:
            kind = "audio"
            width, height, duration_ms, page_count = None, None, 42_000, None
        elif "pdf" in file_id:
            kind = "pdf"
            width, height, duration_ms, page_count = 612, 792, None, 8
        else:
            kind = "image"
            width, height, duration_ms, page_count = 1200, 800, None, None
        return Response(json.dumps({
            "kind": kind,
            "width": width,
            "height": height,
            "duration_ms": duration_ms,
            "page_count": page_count,
        }), media_type="application/json")

    async def file_thumbnail(request):
        unauthorized = require_file_auth(request)
        if unauthorized is not None:
            return unauthorized
        if request.query_params.get("w") not in {"240", "480", "960"}:
            return Response(json.dumps({"error": {"code": "invalid_thumbnail_width"}}),
                            status_code=400, media_type="application/json")
        return Response(b"\xff\xd8\xff\xd9", media_type="image/jpeg")

    app.add_route("/files/{file_id}/preview", file_preview, methods=["GET"])
    async def fire_schedule(request):
        unauthorized = require_file_auth(request)
        if unauthorized is not None:
            return unauthorized
        schedule = store.schedule(request.path_params["schedule_id"])
        if schedule is None:
            return Response(status_code=404)
        if schedule["next_run_at"] is not None:
            # 仅推进真实调度消费这一同步边界；不替造 runs、source 或 SSE。
            due = schedule["next_run_at"]
            with patch("wandrun.gateway.service.time.time", return_value=due):
                gateway._consume_due(due, recovery=False)
        return Response(status_code=204)

    app.add_route("/__protocol/schedules/{schedule_id}/fire", fire_schedule, methods=["POST"])
    app.add_route("/files/{file_id}/thumbnail", file_thumbnail, methods=["GET"])
    server = uvicorn.Server(uvicorn.Config(
        app,
        host="127.0.0.1", port=port, log_level="warning",
    ))
    original = server.handle_exit

    def handle_exit(sig, frame):
        original(sig, frame)
        asyncio.get_running_loop().call_soon_threadsafe(gateway.end_streams)

    server.handle_exit = handle_exit
    video_streams = None
    try:
        # 端口由 OS 分配并由本子进程持有；先报告冷启动完成，再由 Node 验证真实 HTTP 就绪。
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", port))
            listener.listen()
            if "--browser-stream" in sys.argv[3:]:
                from browser_stream_peer import install

                video_streams = install(
                    gateway, app, home, f"http://127.0.0.1:{listener.getsockname()[1]}"
                )
            print(f"STUB_GATEWAY_PORT={listener.getsockname()[1]}", flush=True)
            await server.serve(sockets=[listener])
    finally:
        try:
            await gateway.drain_deletions()
            if video_streams is not None:
                await video_streams.aclose()
            await manager.close()
        finally:
            await resources.aclose()
            await subscription.aclose()
            await credentials.aclose()
            store.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], int(sys.argv[2])))
