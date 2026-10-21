"""Archive recovery and publication boundaries through the file tool."""

import base64
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest

from deepagents.backends import FilesystemBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from wandrun.runtime.compaction_archive import CompactionArchive


class ArchiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_data_remains_exact_and_only_content_media_is_detached(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"),
                                        FilesystemBackend(root_dir=root, virtual_mode=False))
            image = b"\x89PNG\r\n\x1a\nactual image"
            encoded = base64.b64encode(image).decode()
            arguments = {"type": ["string", "null"], "mime_type": 42,
                         "business": {"type": "image", "mime_type": "image/png", "base64": encoded},
                         "long": "Q" * 85000 + "ARGUMENT-TAIL"}
            artifact = {"type": ["file", "null"], "mime_type": "image/png", "base64": encoded}
            metadata = {"type": ["string", "null"], "mime_type": 42, "base64": encoded}
            messages = [AIMessage(id="call", content="", tool_calls=[
                {"name": "search", "id": "tool", "args": arguments}],
                additional_kwargs={"business": metadata, "codex_output_items": [
                    {"type": "function_call", "arguments": arguments},
                    {"type": "message", "content": [
                        {"type": "input_image", "image_url": f"data:image/png;base64,{encoded}"}
                    ]}]}),
                ToolMessage(id="result", tool_call_id="tool", content=[
                    {"type": "image", "mime_type": "image/png", "base64": encoded},
                    {"type": ["string", "null"], "mime_type": 42, "base64": encoded},
                    {"type": "image", "mime_type": 42, "base64": encoded}],
                    artifact=artifact, response_metadata=metadata)]
            path = await archive.segment("task", messages, 0, len(messages))
            records = self._records(Path(path))
            self.assertEqual(records[0]["tool_calls"][0]["args"], arguments)
            self.assertEqual(records[0]["additional_kwargs"]["business"], metadata)
            self.assertEqual(records[0]["additional_kwargs"]["codex_output_items"][0]["arguments"], arguments)
            provider_media = records[0]["additional_kwargs"]["codex_output_items"][1]["content"][0]
            self.assertEqual(Path(provider_media["archive_path"]).read_bytes(), image)
            self.assertEqual(records[1]["artifact"], artifact)
            self.assertEqual(records[1]["response_metadata"], metadata)
            self.assertEqual(records[1]["content"][1], messages[1].content[1])
            self.assertEqual(records[1]["content"][2], messages[1].content[2])
            self.assertEqual(Path(records[1]["content"][0]["archive_path"]).read_bytes(), image)

    async def test_no_symlink_in_directory_chain_or_conflict_target(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            outside = root / "outside"
            outside.mkdir()
            artifacts = root / ".wandrun/artifacts"
            artifacts.mkdir(parents=True)
            archive = CompactionArchive(str(artifacts),
                                        FilesystemBackend(root_dir=root, virtual_mode=False))
            message = [HumanMessage(id="one", content="do not escape")]
            compaction = artifacts / "compaction"
            compaction.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                await archive.segment("task", message, 0, 1)
            self.assertEqual(list(outside.iterdir()), [])
            compaction.unlink()
            compaction.mkdir()
            task_dir = Path(archive.directory("task"))
            task_dir.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                await archive.segment("task", message, 0, 1)
            task_dir.unlink()
            path = await archive.segment("task", message, 0, 1)
            original = Path(path).read_bytes()
            target = outside / "segment"
            target.write_bytes(original)
            Path(path).unlink()
            Path(path).symlink_to(target)
            with self.assertRaises(OSError):
                await archive.segment("task", message, 0, 1)
            self.assertEqual(target.read_bytes(), original)
            Path(path).unlink()
            media_dir = task_dir / "media"
            media_dir.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(OSError):
                await archive.segment("task", [HumanMessage(id="media", content=[
                    {"type": "image", "mime_type": "image/png", "base64": base64.b64encode(b"png").decode()}
                ])], 0, 1)
            self.assertEqual([entry.name for entry in outside.iterdir()], ["segment"])

    async def test_formal_read_file_reaches_long_multiline_and_single_line_tails(self):
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            backend = FilesystemBackend(root_dir=root, virtual_mode=False)
            archive = CompactionArchive(str(root / ".wandrun/artifacts"), backend)
            content = "start\n" + "detail\n" * 12000 + "MULTILINE-TAIL"
            long_line = "one line " + "X" * 100000 + "SINGLE-LINE-TAIL"
            messages = [HumanMessage(id="long", content=content),
                        HumanMessage(id="single", content=long_line)]
            path = await archive.segment("task", messages, 0, 2)
            tool = FilesystemMiddleware(backend=backend, tools=["read_file"]).tools[0]
            rows = []
            # One source line per tool call; continuation gutters on wrapped rows
            # are removed before decoding the JSONL record.
            for offset in range(len(Path(path).read_text().splitlines())):
                response = await tool.coroutine(file_path=path, offset=offset, limit=1,
                                                runtime=SimpleNamespace(tool_call_id="read"))
                self.assertEqual(response.status, "success")
                pieces = []
                for row in response.content.splitlines():
                    match = re.match(r"\s*\d+(?:\.\d+)?  (.*)$", row)
                    if match:
                        pieces.append(match.group(1))
                rows.append(json.loads("".join(pieces)))
            recovered = []
            for index in range(2):
                chunks = [row for row in rows[1:] if row["message_index"] == index]
                recovered.append(json.loads("".join(part["json"] for part in chunks)))
            self.assertEqual([item["content"] for item in recovered], [content, long_line])

    @staticmethod
    def _records(path):
        lines = [json.loads(line) for line in path.read_text().splitlines()]
        return [json.loads("".join(row["json"] for row in lines[1:]
                                   if row["message_index"] == index))
                for index in range(lines[0]["start_index"], lines[0]["end_index"])]
