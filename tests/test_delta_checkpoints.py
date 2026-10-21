"""Offline regression tests for message DeltaChannel persistence."""

import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from typing import Annotated

from langchain_core.messages import AnyMessage, HumanMessage, RemoveMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from typing_extensions import TypedDict

from wandrun.runtime.agents import MESSAGE_SNAPSHOT_FREQUENCY, _MessageDeltaChannel
from wandrun.runtime.conversations import conversation_config


class DeltaState(TypedDict):
    messages: Annotated[
        list[AnyMessage],
        _MessageDeltaChannel(snapshot_frequency=MESSAGE_SNAPSHOT_FREQUENCY),
    ]


def build_graph(checkpointer):
    builder = StateGraph(DeltaState)
    builder.add_node("noop", lambda state: {})
    builder.add_edge(START, "noop")
    builder.add_edge("noop", END)
    return builder.compile(checkpointer=checkpointer)


def build_plain_graph(checkpointer):
    from langgraph.graph.message import add_messages

    class PlainState(TypedDict):
        messages: Annotated[list[AnyMessage], add_messages]

    builder = StateGraph(PlainState)
    builder.add_node("noop", lambda state: {})
    builder.add_edge(START, "noop")
    builder.add_edge("noop", END)
    return builder.compile(checkpointer=checkpointer)


def database_bytes(path: Path) -> tuple[int, int]:
    files = sum(
        candidate.stat().st_size
        for candidate in path.parent.glob(f"{path.name}*")
        if candidate.is_file()
    )
    with sqlite3.connect(path) as connection:
        blobs = connection.execute(
            "SELECT COALESCE(SUM(length(checkpoint)), 0) FROM checkpoints"
        ).fetchone()[0]
    return files, blobs


class DeltaCheckpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_state_preserves_add_messages_semantics_and_ids_after_restart(self):
        with tempfile.TemporaryDirectory(
            dir=os.environ["TMPDIR"], prefix="wandrun-delta-semantics-"
        ) as directory:
            path = Path(directory) / "checkpoints.sqlite"
            config = conversation_config("delta-semantics")
            async with AsyncSqliteSaver.from_conn_string(str(path)) as saver:
                graph = build_graph(saver)
                await graph.ainvoke(
                    {"messages": [HumanMessage(content="one", id="one")]},
                    config,
                    durability="sync",
                )
                await graph.aupdate_state(
                    config,
                    {"messages": [HumanMessage(content="two")]},
                    as_node="noop",
                )
                generated_id = (await graph.aget_state(config)).values["messages"][-1].id
                self.assertTrue(generated_id)
                await graph.aupdate_state(
                    config,
                    {"messages": [HumanMessage(content="replaced", id="one")]},
                    as_node="noop",
                )
                await graph.aupdate_state(
                    config,
                    {"messages": [RemoveMessage(id=generated_id)]},
                    as_node="noop",
                )
                values = (await graph.aget_state(config)).values["messages"]
                self.assertEqual([(message.id, message.content) for message in values], [("one", "replaced")])

            async with AsyncSqliteSaver.from_conn_string(str(path)) as saver:
                values = (await build_graph(saver).aget_state(config)).values["messages"]
                self.assertEqual([(message.id, message.content) for message in values], [("one", "replaced")])

    async def test_message_like_ids_and_remove_all_survive_restart(self):
        with tempfile.TemporaryDirectory(
            dir=os.environ["TMPDIR"], prefix="wandrun-delta-message-likes-"
        ) as directory:
            path = Path(directory) / "checkpoints.sqlite"
            config = conversation_config("message-likes")
            async with AsyncSqliteSaver.from_conn_string(str(path)) as saver:
                graph = build_graph(saver)
                await graph.ainvoke({"messages": ["first"]}, config, durability="sync")
                first = (await graph.aget_state(config)).values["messages"][0]
                await graph.aupdate_state(
                    config,
                    {"messages": [
                        RemoveMessage(id=REMOVE_ALL_MESSAGES),
                        "second",
                    ]},
                    as_node="noop",
                )
                values = (await graph.aget_state(config)).values["messages"]
                self.assertEqual(len(values), 1)
                second_id = values[0].id
                self.assertTrue(second_id)
            async with AsyncSqliteSaver.from_conn_string(str(path)) as saver:
                values = (await build_graph(saver).aget_state(config)).values["messages"]
                self.assertEqual([(message.id, message.content) for message in values],
                                 [(second_id, "second")])
                self.assertNotEqual(first.id, second_id)

    async def test_long_image_history_uses_less_checkpoint_storage(self):
        with tempfile.TemporaryDirectory(
            dir=os.environ["TMPDIR"], prefix="wandrun-delta-storage-"
        ) as directory:
            root = Path(directory)
            normal_path = root / "normal.sqlite"
            delta_path = root / "delta.sqlite"

            async def fill(path: Path, factory) -> tuple[int, int]:
                async with AsyncSqliteSaver.from_conn_string(str(path)) as saver:
                    graph = factory(saver)
                    for index in range(30):
                        image = "A" * 8_000
                        await graph.ainvoke(
                            {
                                "messages": [HumanMessage(
                                    content=[
                                        {"type": "text", "text": f"message-{index}"},
                                        {"type": "image", "source": {
                                            "type": "base64", "media_type": "image/png", "data": image,
                                        }},
                                    ],
                                    id=f"message-{index}",
                                )]
                            },
                            conversation_config("storage"),
                            durability="sync",
                        )
                return database_bytes(path)

            normal = await fill(normal_path, build_plain_graph)
            delta = await fill(delta_path, build_graph)
            print(f"checkpoint storage comparison: normal={normal} delta={delta}", flush=True)
            self.assertLess(delta[0], normal[0])
            self.assertLess(delta[1], normal[1])
            self.assertLess(delta[1], normal[1] // 4)


if __name__ == "__main__":
    unittest.main()
