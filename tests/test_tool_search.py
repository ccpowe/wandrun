"""可搜索工具：目录检索、历史推导和真实角色图中的加载与执行；不访问远端模型。"""

from collections import defaultdict
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from deepagents.backends import LocalShellBackend
from langchain.messages import AIMessage, HumanMessage, ToolMessage
from langchain.tools import tool
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.prebuilt.tool_node import ToolCallRequest

from wandrun.config import AgentDefinition
from wandrun.runtime.agents import build_agents, run_conversation
from wandrun.runtime.conversations import conversation_config
from wandrun.runtime.messages import AgentOutput, SendMessage
from wandrun.runtime.tool_search import (
    ToolNamespace,
    ToolSearchMiddleware,
    loaded_tool_names,
)
from wandrun.runtime.workers import WorkerManager
from wandrun.runtime.environments import Environment


@tool
def get_weather(city: str) -> str:
    """Get current weather for a city."""
    return f"{city}: light rain"


@tool
def send_email(to: str, body: str) -> str:
    """Send an email message."""
    return "sent"


@tool
def list_issues(repo: str) -> str:
    """List open issues of a repository."""
    return "[]"


CATALOG = (
    ToolNamespace("weather", "天气查询", (get_weather,)),
    ToolNamespace("gmail", "Gmail mailbox", (send_email,)),
    ToolNamespace("github", "GitHub repositories", (list_issues,)),
)


def call(name, args, call_id, *, native_search=False):
    """与真实适配器相同的形态：LangChain 工具调用加原始输出项。"""
    if native_search:
        item = {"type": "tool_search_call", "execution": "client", "call_id": call_id,
                "status": "completed", "arguments": args}
    else:
        namespace, _, remote = name.rpartition(".")
        item = {"type": "function_call", "call_id": call_id, "name": remote,
                "arguments": json.dumps(args), **({"namespace": namespace} if namespace else {})}
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}],
        additional_kwargs={"codex_output_items": [item]},
    )


class ToolSearchTests(unittest.TestCase):
    def test_search_ranks_groups_and_skips_loaded(self):
        middleware = ToolSearchMiddleware(CATALOG)
        result = middleware.search("send an email via gmail", set())
        self.assertEqual([n["name"] for n in result], ["gmail"])
        self.assertEqual(result[0]["tools"][0]["name"], "send_email")
        self.assertTrue(result[0]["tools"][0]["defer_loading"])
        self.assertEqual(middleware.search("查询天气", set())[0]["name"], "weather")
        self.assertEqual(middleware.search("send email", {"gmail.send_email"}), [])
        self.assertEqual(middleware.search("unrelated", set()), [])

    def test_loaded_names_come_only_from_native_search_results(self):
        loaded = ToolSearchMiddleware(CATALOG).search("weather", set())
        messages = [
            call("tool_search", {"query": "weather"}, "1", native_search=True),
            ToolMessage(content="ok", tool_call_id="1", name="tool_search", artifact=loaded),
            call("other", {}, "2"),
            ToolMessage(content="x", tool_call_id="2", name="other", artifact=loaded),
            call("tool_search", {"query": "x"}, "3", native_search=True),
            ToolMessage(content="cancelled", tool_call_id="3", name="tool_search"),
            # 远端工具也可能叫 tool_search，其结构化结果不是加载记录。
            call("docs.tool_search", {"q": "x"}, "4"),
            ToolMessage(content="r", tool_call_id="4", name="tool_search", artifact={"hits": []}),
        ]
        self.assertEqual(loaded_tool_names(messages), {"weather.get_weather"})

    def test_plain_function_named_tool_search_is_not_intercepted(self):
        middleware = ToolSearchMiddleware(CATALOG)
        message = call("tool_search", {"query": "weather"}, "plain")
        request = ToolCallRequest(
            tool_call=message.tool_calls[0], tool=None, state={"messages": [message]}, runtime=None
        )
        forwarded = []
        middleware.wrap_tool_call(request, lambda r: forwarded.append(r) or "executed")
        self.assertEqual([r.tool_call["id"] for r in forwarded], ["plain"])

    def test_catalog_validation(self):
        for namespaces in (
            (),
            (ToolNamespace("a.b", "", (get_weather,)),),
            (CATALOG[0], CATALOG[0]),
            (ToolNamespace("weather", "", (get_weather, get_weather)),),
        ):
            with self.subTest(namespaces=namespaces), self.assertRaises(ValueError):
                ToolSearchMiddleware(namespaces)


class ToolSearchAssemblyTests(unittest.TestCase):
    def test_direct_tool_named_tool_search_conflicts_with_catalog(self):
        @tool("tool_search")
        def direct(query: str) -> str:
            """A direct tool that happens to use the reserved name."""
            return query

        definitions = {"solo": AgentDefinition(description="solo", system_prompt="p", model="test", code_mode=False)}
        kwargs = dict(
            definitions=definitions,
            models={"solo": FakeMessagesListChatModel(responses=[])},
            tools={"solo": [direct]},
            environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=Path(tempfile.gettempdir()), virtual_mode=True), "/skills", "/")),
            checkpointer=InMemorySaver(),
        )
        build_agents(None, **kwargs)  # 没有可搜索目录时这个名称不受限
        with self.assertRaisesRegex(ValueError, "tool_search"):
            build_agents(None, searchable={"solo": CATALOG}, **kwargs)


class ToolSearchGraphTests(unittest.IsolatedAsyncioTestCase):
    async def test_search_load_and_call_in_role_graph(self):
        seen_tools = []

        class Model(FakeMessagesListChatModel):
            def bind_tools(self, tools, **kwargs):
                return self.bind(bound=tools)

            async def _agenerate(self, messages, **kwargs):
                seen_tools.append(kwargs["bound"])
                results = [m for m in messages if isinstance(m, ToolMessage)]
                if "你是 plain" in str(messages[0].content):
                    result = AgentOutput(messages=[], next="done")
                    response = AIMessage(
                        content=result.model_dump_json(),
                        additional_kwargs={"wandrun_agent_output": result.model_dump()},
                    )
                elif not results:
                    # 加载前调用目录工具会被拒绝，而不是越过搜索直接执行。
                    response = call("weather.get_weather", {"city": "Paris"}, "early")
                elif len(results) == 1:
                    response = call("tool_search", {"query": "weather"}, "search", native_search=True)
                elif len(results) == 2:
                    response = call("weather.get_weather", {"city": "Paris"}, "weather")
                else:
                    result = AgentOutput(
                        messages=[SendMessage(to="human", task_id=None, message=results[-1].content)],
                        next="done",
                    )
                    response = AIMessage(
                        content=result.model_dump_json(),
                        additional_kwargs={"wandrun_agent_output": result.model_dump()},
                    )
                return ChatResult(generations=[ChatGeneration(message=response)])

        definitions = {
            "solo": AgentDefinition(description="solo", system_prompt="你是 solo", model="test", code_mode=False),
            "plain": AgentDefinition(description="plain", system_prompt="你是 plain", model="test", code_mode=False),
        }
        shown, delivered = [], asyncio.Event()

        async def run(prompts, task_id):
            name = manager.agent_name(task_id)
            return await run_conversation(agents[name].graph, prompts, task_id, name)

        def show(sender, text, attachments, draft_id):
            shown.append(text)
            delivered.set()

        manager = WorkerManager(
            run, agent_workers={"solo": (), "plain": ()}, default_agent="solo", on_human=show
        )
        self.addAsyncCleanup(manager.close)
        with tempfile.TemporaryDirectory() as directory:
            agents = build_agents(
                manager,
                definitions=definitions,
                models={name: Model(responses=[]) for name in definitions},
                tools={name: [] for name in definitions},
                environments=defaultdict(lambda: Environment("local", LocalShellBackend(root_dir=Path(directory), virtual_mode=True), "/skills", "/")),
                checkpointer=InMemorySaver(),
                searchable={"solo": CATALOG},
            )
            manager.start("weather?", "root")
            await asyncio.wait_for(delivered.wait(), 5)
            await manager.wait("root")
        self.assertEqual(shown, ["Paris: light rain"])
        declarations = [t for t in seen_tools[0] if isinstance(t, dict)]
        self.assertEqual([d["type"] for d in declarations], ["tool_search"])
        self.assertIn("weather: 天气查询", declarations[0]["description"])
        # 目录工具从不进入顶层工具列表。
        self.assertFalse(
            any(getattr(t, "name", None) == "get_weather" for tools in seen_tools for t in tools)
        )
        snapshot = await agents["solo"].graph.aget_state(conversation_config("root"))
        results = [m for m in snapshot.values["messages"] if isinstance(m, ToolMessage)]
        self.assertEqual([m.status for m in results], ["error", "success", "success"])
        self.assertIn("尚未加载", results[0].content)
        self.assertEqual(results[1].artifact[0]["tools"][0]["name"], "get_weather")
        self.assertEqual(loaded_tool_names(snapshot.values["messages"]), {"weather.get_weather"})

        # 没有目录的角色不声明 tool_search。
        plain = await agents["plain"].graph.ainvoke(
            {"messages": [HumanMessage(content="hi")], "agent_name": "plain"},
            config=conversation_config("plain-1"),
            context={"task_id": "plain-1"},
        )
        self.assertFalse(any(isinstance(t, dict) for t in seen_tools[-1]))
        self.assertIn("structured_response", plain)


if __name__ == "__main__":
    unittest.main()
