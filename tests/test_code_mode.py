"""run_code：脚本接口、退出收尾、图中断、时限与取消（ADR-0010），使用真实 Monty 池与本地 backend。"""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pydantic_monty as pm
from langchain_core.tools import StructuredTool
from langchain_core.tools import ToolException
from langgraph.errors import GraphInterrupt

from wandrun.config import load_config
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.integrations.shell_backend import ManagedShellBackend
from wandrun.metrics import RunMetrics
from wandrun.runtime.code_mode import CodeModeCatalog, CodeModeMiddleware, code_mode_tool, script_name
from wandrun.runtime.session import open_runtime
from wandrun.runtime.tool_search import ToolNamespace
from wandrun.runtime.workspace import Workspace


def make_tool(name, coroutine, description="", **kwargs):
    return StructuredTool.from_function(
        coroutine=coroutine, name=name, description=description or name, **kwargs
    )


class CodeModeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.backend = ManagedShellBackend(
            root_dir=self.root, virtual_mode=True, timeout=30, termination_grace=0.1
        )
        self.pool = await pm.AsyncMonty().__aenter__()
        self.effects = []

        async def lookup(id: str) -> str:
            return f"item {id}"

        async def stats() -> tuple:
            return [{"type": "text", "text": "2 items"}], {"structured_content": {"count": 2}}

        async def failing() -> str:
            raise ToolException("upstream 500")

        async def slow_write() -> str:
            await asyncio.sleep(0.4)
            self.effects.append("written")
            return "done"

        async def hang() -> str:
            await asyncio.sleep(30)
            return "late"

        async def interrupting() -> str:
            await asyncio.sleep(0.05)
            raise self.interrupt

        async def ask_question(question: str) -> str:
            return f"answer: {question}"

        self.interrupt = GraphInterrupt(("need input",))
        direct = [
            make_tool("svc_lookup", lookup, "Look up an item by id."),
            make_tool("svc_stats", stats, response_format="content_and_artifact"),
            make_tool("svc_failing", failing, handle_tool_error=True),
            make_tool("svc_slow_write", slow_write),
            make_tool("svc_hang", hang),
            make_tool("svc_interrupting", interrupting),
        ]
        namespaces = [
            ToolNamespace(
                "deepwiki", "Repository documentation", (make_tool("ask_question", ask_question, "Ask about a repo."),)
            )
        ]
        self.catalog = CodeModeCatalog(direct, namespaces)
        (self.tool,) = CodeModeMiddleware(self.pool, self.backend, self.catalog).tools

    async def asyncTearDown(self):
        await self.pool.__aexit__(None, None, None)
        self.backend.close()
        self.directory.cleanup()

    async def run_code(self, code, **args):
        return await self.tool.ainvoke(
            {"type": "tool_call", "id": "call_1", "name": "run_code", "args": {"code": code, **args}}
        )

    def test_names_and_conflicts(self):
        self.assertEqual(script_name("deepwiki.ask_question"), "deepwiki__ask_question")
        self.assertEqual(script_name("my-server_tool"), "my_server_tool")
        with self.assertRaises(ValueError):
            CodeModeCatalog(
                [make_tool("a__b", self.asyncSetUp)],
                [ToolNamespace("a", "x", (make_tool("b", self.asyncSetUp),))],
            )

    async def test_script_calls_tools_and_returns_output(self):
        result = await self.run_code(
            "a = await tools.svc_lookup(id='1')\n"
            "b = await call_tool('deepwiki.ask_question', question='q')\n"
            "c = await tools.deepwiki__ask_question(question='r')\n"
            "print(a, b, c, sep=' | ')\n"
            "await tools.svc_stats()"
        )
        self.assertEqual(result.status, "success")
        self.assertIn("item 1 | answer: q | answer: r", result.content)
        self.assertIn('"count": 2', result.content)
        self.assertEqual(
            [(r["name"], r["status"]) for r in result.artifact["calls"]],
            [("svc_lookup", "succeeded"), ("deepwiki.ask_question", "succeeded"),
             ("deepwiki.ask_question", "succeeded"), ("svc_stats", "succeeded")],
        )

    async def test_search_and_describe_tools(self):
        result = await self.run_code(
            "found = search_tools('repo documentation question')\n"
            "[found[0]['raw_name'], describe_tool(found[0]['name'])['parameters']['required']]"
        )
        self.assertIn('"deepwiki.ask_question"', result.content)
        self.assertIn('"question"', result.content)

    async def test_tool_errors_are_runtime_errors(self):
        caught = await self.run_code(
            "try:\n    await tools.svc_failing()\nexcept RuntimeError as e:\n    r = str(e)\nr"
        )
        self.assertEqual(caught.status, "success")
        self.assertIn("svc_failing 调用失败：upstream 500", caught.content)

        uncaught = await self.run_code("print('before')\nawait tools.svc_lookup(id='1')\nawait tools.svc_failing()")
        self.assertEqual(uncaught.status, "error")
        self.assertIn("before", uncaught.content)
        self.assertIn("RuntimeError", uncaught.content)
        self.assertIn("line 3", uncaught.content)
        self.assertIn("svc_lookup(succeeded), svc_failing(failed)", uncaught.content)

    async def test_script_failure_cancels_calls_still_running(self):
        result = await self.run_code(
            "import asyncio\nawait asyncio.gather(tools.svc_slow_write(), tools.svc_failing())"
        )
        self.assertEqual(result.status, "error")
        await asyncio.sleep(0.6)
        self.assertEqual(self.effects, [])
        self.assertIn(("svc_slow_write", "cancelled"), [(r["name"], r["status"]) for r in result.artifact["calls"]])

    async def test_graph_interrupt_terminates_run_and_reraises_original(self):
        # 脚本吞掉注入的异常并继续等待写调用；宿主仍须立即终止并把原始中断交给图。
        code = (
            "import asyncio\n"
            "async def tolerate():\n"
            "    try:\n"
            "        await tools.svc_interrupting()\n"
            "    except BaseException:\n"
            "        return 'caught'\n"
            "await asyncio.gather(tools.svc_slow_write(), tolerate())"
        )
        with self.assertRaises(GraphInterrupt) as raised:
            await self.run_code(code)
        self.assertIs(raised.exception, self.interrupt)
        await asyncio.sleep(0.6)
        self.assertEqual(self.effects, [])

    async def test_wall_timeout_includes_tool_waits_and_cancels_calls(self):
        started = asyncio.get_running_loop().time()
        result = await self.run_code("await tools.svc_hang()", timeout=1)
        self.assertLess(asyncio.get_running_loop().time() - started, 3)
        self.assertEqual(result.status, "error")
        self.assertIn("墙钟时限", result.content)
        self.assertEqual(result.artifact["calls"], [{"name": "svc_hang", "status": "cancelled"}])

    async def test_backend_functions(self):
        result = await self.run_code(
            "await write('/notes.txt', 'alpha\\nbeta\\n')\n"
            "await edit('/notes.txt', 'beta', 'gamma')\n"
            "text = (await read('/notes.txt'))['file_data']['content']\n"
            "run = await execute('cat notes.txt; exit 3')\n"
            "try:\n    await read('/missing.txt')\n    missing = 'no error'\n"
            "except RuntimeError as e:\n    missing = 'error'\n"
            "[text, run['exit_code'], missing]"
        )
        self.assertEqual(result.status, "success", result.content)
        self.assertEqual((self.root / "notes.txt").read_text(), "alpha\ngamma\n")
        self.assertIn('"alpha\\ngamma\\n"', result.content)
        self.assertIn("3,", result.content)
        self.assertIn('"error"', result.content)

    async def test_cleanup_finishes_when_cancelled_during_cleanup(self):
        # 脚本报错进入收尾，宿主调用在 finally 中异步释放资源；此时取消 run_code 不能打断释放。
        async def holding() -> str:
            try:
                await asyncio.sleep(30)
            finally:
                self.effects.append("releasing")
                await asyncio.sleep(0.3)
                self.effects.append("released")
            return "never"

        async def failing_soon() -> str:
            await asyncio.sleep(0.05)
            raise ToolException("boom")

        catalog = CodeModeCatalog(
            [make_tool("svc_holding", holding), make_tool("svc_failing_soon", failing_soon, handle_tool_error=True)], []
        )
        tool = code_mode_tool(self.pool, self.backend, catalog)
        running = asyncio.create_task(tool.ainvoke({
            "type": "tool_call", "id": "c", "name": "run_code",
            "args": {"code": "import asyncio\nawait asyncio.gather(tools.svc_holding(), tools.svc_failing_soon())"},
        }))
        async with asyncio.timeout(3):
            while "releasing" not in self.effects:
                await asyncio.sleep(0.01)
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(running, 3)
        self.assertEqual(self.effects, ["releasing", "released"])

    async def test_timeout_covers_waiting_for_an_interpreter(self):
        async with pm.AsyncMonty(max_processes=1) as pool:
            tool = code_mode_tool(pool, self.backend, self.catalog)
            async with pool.checkout():
                started = asyncio.get_running_loop().time()
                result = await asyncio.wait_for(
                    tool.ainvoke({"type": "tool_call", "id": "c", "name": "run_code", "args": {"code": "42", "timeout": 1}}),
                    5,
                )
                self.assertLess(asyncio.get_running_loop().time() - started, 2)
            self.assertEqual(result.status, "error")
            self.assertIn("墙钟时限", result.content)

    async def test_structured_result_keeps_non_text_blocks(self):
        image = {"type": "image", "base64": "iVBORw0KGgo=", "mime_type": "image/png"}

        async def chart() -> tuple:
            return [{"type": "text", "text": "chart"}, image], {"structured_content": {"count": 2}}

        catalog = CodeModeCatalog([make_tool("svc_chart", chart, response_format="content_and_artifact")], [])
        tool = code_mode_tool(self.pool, self.backend, catalog)
        result = await tool.ainvoke({
            "type": "tool_call", "id": "c", "name": "run_code",
            "args": {"code": "r = await tools.svc_chart()\n[r['structured_content'], r['text'], r['content'][0]['mime_type']]"},
        })
        self.assertEqual(result.status, "success", result.content)
        self.assertIn('"count": 2', result.content)
        self.assertIn('"image/png"', result.content)

    def test_signatures_show_real_defaults_only(self):
        async def paged(query: str, page: int = 1) -> str:
            return "ok"

        cursor = StructuredTool.from_function(
            coroutine=paged, name="svc_cursor", description="Cursor listing.",
            args_schema={"type": "object", "properties": {"cursor": {"type": "string"}}, "required": []},
        )
        description = code_mode_tool(
            self.pool, self.backend, CodeModeCatalog([make_tool("svc_paged", paged), cursor], [])
        ).description
        self.assertIn("tools.svc_paged(query, page=1)", description)
        self.assertIn("tools.svc_cursor([cursor])", description)
        self.assertNotIn("page=None", description)
        self.assertNotIn("cursor=None", description)

    async def test_type_check_rejects_mistakes_before_any_tool_call(self):
        # 评测中模型漏写 import、用了不存在的 decimal：错误在取完数据后才暴露，重试时重复全部调用。
        scripts = [
            "import asyncio\nr = await asyncio.gather(tools.svc_slow_write())\njson.dumps(r)",
            "from decimal import Decimal\nawait tools.svc_slow_write()",
            "await tools.svc_slow_wrte()",
            "await tools.svc_lookup(key='1')",
        ]
        for code in scripts:
            result = await self.run_code(code)
            self.assertEqual(result.status, "error", code)
            self.assertIn("类型检查未通过", result.content)
            self.assertEqual(result.artifact["calls"], [], code)
        await asyncio.sleep(0.5)
        self.assertEqual(self.effects, [])

    async def test_type_check_allows_tools_with_non_identifier_parameters(self):
        dashed = StructuredTool.from_function(
            coroutine=self.asyncSetUp, name="svc_dashed", description="Dashed params.",
            args_schema={"type": "object", "properties": {"from": {"type": "string"}}, "required": ["from"]},
        )
        tool = code_mode_tool(self.pool, self.backend, CodeModeCatalog([dashed], []))
        result = await tool.ainvoke({
            "type": "tool_call", "id": "c", "name": "run_code", "args": {"code": "1 + 1"},
        })
        self.assertEqual(result.status, "success", result.content)

    async def test_stubs_are_not_stricter_than_tool_schemas(self):
        received = []

        async def extra(**arguments) -> str:
            received.append(arguments)
            return "ok"

        def schema_tool(name, additional):
            schema = {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
            if additional is not None:
                schema["additionalProperties"] = additional
            return StructuredTool.from_function(coroutine=extra, name=name, description=name, args_schema=schema)

        catalog = CodeModeCatalog(
            [schema_tool("svc_open", True), schema_tool("svc_default", None), schema_tool("svc_closed", False)], []
        )
        tool = code_mode_tool(self.pool, self.backend, catalog)

        async def run(code):
            return await tool.ainvoke({"type": "tool_call", "id": "c", "name": "run_code", "args": {"code": code}})

        # 允许额外属性（显式 true 或未声明）时，额外参数不能被预检拒绝，并原样交给工具。
        for name in ("svc_open", "svc_default"):
            received.clear()
            result = await run(f"await tools.{name}(query='x', limit=2)")
            self.assertEqual(result.status, "success", (name, result.content))
            self.assertEqual(received, [{"query": "x", "limit": 2}], name)
        # 明确禁止额外属性时，必填参数正确、另带一个额外参数，也在执行前拒绝。
        received.clear()
        closed = await run("await tools.svc_closed(query='x', limit=2)")
        self.assertIn("类型检查未通过", closed.content)
        self.assertEqual((closed.artifact["calls"], received), ([], []))
        # 缺少必填参数在任何情况下都能预检出来。
        missing = await run("await tools.svc_open(limit=2)")
        self.assertIn("类型检查未通过", missing.content)
        # 工具方法只接受关键字参数，开放 Schema 也不例外：位置参数在之前的写操作发生前被拒绝。
        for name in ("svc_open", "svc_closed"):
            positional = await run(f"await write('/effect.txt', 'written')\nawait tools.{name}('x')")
            self.assertIn("类型检查未通过", positional.content, name)
            self.assertFalse((self.root / "effect.txt").exists(), name)

    async def test_call_tool_names_are_checked_only_at_runtime(self):
        # 说明中只承诺检查静态可识别的名字：call_tool 的工具名错误在之前的调用执行后才暴露。
        result = await self.run_code("await write('/effect.txt', 'x')\nawait call_tool('svc_lokup', id='1')")
        self.assertEqual(result.status, "error")
        self.assertNotIn("类型检查未通过", result.content)
        self.assertEqual((self.root / "effect.txt").read_text(), "x")
        self.assertEqual(result.artifact["calls"], [{"name": "write", "status": "succeeded"}])

    async def test_cancelling_run_code_kills_running_command(self):
        running = asyncio.create_task(self.run_code("await execute('echo $$ > pgid; sleep 30')"))
        pgid_file = self.root / "pgid"
        async with asyncio.timeout(5):
            while not pgid_file.is_file() or not pgid_file.read_text():
                await asyncio.sleep(0.01)
        pgid = int(pgid_file.read_text())
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(running, 3)
        with self.assertRaises(ProcessLookupError):
            os.killpg(pgid, 0)


def configure(root: Path, code_mode="true") -> Workspace:
    workspace = Workspace(root)
    workspace.runtime_dir.mkdir()
    workspace.agents_config.write_text(
        'main_agent = "main"\n[agents.main]\n'
        'description = "Root"\nsystem_prompt = "Complete the task."\n'
        f'model = "offline"\ncode_mode = {code_mode}\n',
        encoding="utf-8",
    )
    (workspace.runtime_dir / "mcps.toml").write_text("[mcp_servers]\n", encoding="utf-8")
    workspace.environments_config.write_text(
        'default = "local"\n[environments.local]\ntype = "local"\n', encoding="utf-8"
    )
    return workspace


def completed(*items):
    return {"type": "response.completed", "response": {"status": "completed", "output": list(items)}}


class CodeModeRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def test_config_requires_boolean(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory), code_mode='"yes"')
            with self.assertRaisesRegex(ValueError, "code_mode"):
                load_config(workspace.agents_config)

    async def test_model_runs_code_through_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = configure(Path(directory))
            bodies = []

            async def respond(model, body):
                bodies.append(body)
                tools = {tool.get("name") for tool in body["tools"]}
                assert "run_code" in tools, tools
                if len(bodies) == 1:
                    yield completed({
                        "type": "function_call", "id": "fc_code", "call_id": "call_code", "name": "run_code",
                        "arguments": json.dumps({"code": "r = await execute('echo from-script')\nprint(r['output'])"}),
                    })
                else:
                    payload = {"messages": [{"to": "human", "task_id": None, "message": "ok", "attachments": []}], "next": "done"}
                    yield completed({
                        "type": "message", "id": "m", "role": "assistant", "phase": "final_answer",
                        "content": [{"type": "output_text", "text": json.dumps(payload)}],
                    })

            with patch.object(CodexSubscriptionModel, "_arequest", respond):
                async with open_runtime(
                    workspace, metrics=RunMetrics(workspace.runs_dir), on_human=lambda *_: None
                ) as runtime:
                    runtime.workers.start("go", "root")
                    self.assertEqual((await runtime.workers.wait("root"))["status"], "completed")
            outputs = [
                item["output"] for item in bodies[1]["input"]
                if item.get("type") == "function_call_output" and item.get("call_id") == "call_code"
            ]
            self.assertEqual(len(outputs), 1)
            self.assertIn("from-script", str(outputs[0]))
