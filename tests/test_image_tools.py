"""Image tool publishes only completed local PNGs for the invoking task."""

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from langchain_core.utils.function_calling import convert_to_openai_tool

from wandrun.gateway.image_tools import image_tools
from wandrun.integrations.image_generation import ImageGenerationError
from wandrun.runtime.files import TaskFiles
from wandrun.runtime.workers import WorkerManager


PNG = b"\x89PNG\r\n\x1a\ncomplete image"


class ImageToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.running = asyncio.Event()
        self.release = asyncio.Event()

        async def run(prompts, task_id):
            self.running.set()
            await self.release.wait()
            return "done"

        self.manager = WorkerManager(
            run, agent_workers={"main": ("child",), "child": ()}, default_agent="main",
        )
        self.files = TaskFiles(
            self.root, self.manager,
            {"main": ("local", str(self.root)), "child": ("local", str(self.root))},
            conversation_workdirs=True,
        )
        self.tool, = image_tools(self.manager, self.files, model_name="configured-model")
        self.manager.start("generate", "root-task", agent_name="main")
        await self.files.prepare("root-task")
        await asyncio.wait_for(self.running.wait(), 2)

    async def asyncTearDown(self):
        self.release.set()
        await self.manager.close()

    async def invoke(self, task_id="root-task", prompt="画只猫"):
        return await self.tool.ainvoke({"prompt": prompt}, config={"configurable": {"thread_id": task_id}})

    async def test_two_saves_skip_existing_symlink_and_keep_bytes_out_of_model(self):
        schema = convert_to_openai_tool(self.tool)["function"]["parameters"]
        self.assertEqual(set(schema["properties"]), {"prompt"})
        directory = Path(self.files.directory("root-task"))
        outside = self.root / "outside.png"
        outside.write_bytes(b"must remain")
        (directory / "generated.png").symlink_to(outside)
        calls = []

        async def fake(prompt, *, model_name, credentials):
            calls.append((prompt, model_name))
            return PNG

        with patch("wandrun.gateway.image_tools.request_image", fake):
            first = await self.invoke()
            second = await self.invoke(prompt="画只狗")
        self.assertEqual(calls, [("画只猫", "configured-model"), ("画只狗", "configured-model")])
        self.assertEqual(Path(first["path"]), directory / "generated (1).png")
        self.assertEqual(Path(second["path"]), directory / "generated (2).png")
        self.assertEqual(Path(first["path"]).read_bytes(), PNG)
        self.assertEqual(Path(second["path"]).read_bytes(), PNG)
        self.assertEqual(outside.read_bytes(), b"must remain")
        self.assertTrue((directory / "generated.png").is_symlink())
        self.assertIn("附件", first["message"])
        self.assertNotIn("complete image", repr(first))

    async def test_child_saves_to_root_conversation_directory(self):
        self.manager.start("child", "child-task", sender_id="root-task", agent_name="child")
        await self.files.prepare("child-task")

        async def fake(prompt, *, model_name, credentials):
            return PNG

        with patch("wandrun.gateway.image_tools.request_image", fake):
            result = await self.invoke("child-task")
        self.assertEqual(Path(result["path"]), Path(self.files.directory("root-task")) / "generated.png")
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertFalse((self.root / "conversations" / "child-task").exists())

    async def test_cancelled_and_failed_generation_never_publish(self):
        directory = Path(self.files.directory("root-task"))
        begun = asyncio.Event()
        resume = asyncio.Event()

        async def pending(prompt, *, model_name, credentials):
            begun.set()
            await resume.wait()
            return PNG

        with patch("wandrun.gateway.image_tools.request_image", pending):
            invocation = asyncio.create_task(self.invoke())
            await asyncio.wait_for(begun.wait(), 2)
            invocation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await invocation
        self.assertEqual(list(directory.iterdir()), [])

        async def failed(prompt, *, model_name, credentials):
            raise ImageGenerationError("image_generation_failed", "服务端拒绝了请求")

        with patch("wandrun.gateway.image_tools.request_image", failed):
            result = await self.invoke()
        self.assertEqual(result, {"error": {"code": "image_generation_failed", "detail": "服务端拒绝了请求"}})
        self.assertEqual(list(directory.iterdir()), [])

    async def test_failed_write_removes_only_its_own_incomplete_file(self):
        directory = Path(self.files.directory("root-task"))
        existing = directory / "generated.png"
        existing.write_bytes(b"existing")

        async def fake(prompt, *, model_name, credentials):
            return PNG

        with patch("wandrun.gateway.image_tools.request_image", fake), patch(
            "wandrun.gateway.image_tools.os.write", side_effect=OSError("disk full"),
        ):
            result = await self.invoke()
        self.assertEqual(result["error"]["code"], "image_generation_failed")
        self.assertIn("disk full", result["error"]["detail"])
        self.assertEqual(existing.read_bytes(), b"existing")
        self.assertFalse((directory / "generated (1).png").exists())

    async def test_interleaved_public_name_replacement_does_not_report_other_workers_file(self):
        directory = Path(self.files.directory("root-task"))
        public = directory / "generated.png"
        other = self.root / "other-worker.png"
        other.write_bytes(b"OTHER-WORKER-FILE")
        real_write = os.write

        async def fake(prompt, *, model_name, credentials):
            return PNG

        def interleaved_write(fd, view):
            os.replace(other, public)
            return real_write(fd, view)

        with patch("wandrun.gateway.image_tools.request_image", fake), patch(
            "wandrun.runtime.files.os.write", side_effect=interleaved_write,
        ):
            result = await self.invoke()
        self.assertEqual(Path(result["path"]), directory / "generated (1).png")
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertEqual(public.read_bytes(), b"OTHER-WORKER-FILE")
        self.assertEqual({path.name for path in directory.iterdir()}, {"generated.png", "generated (1).png"})

    async def test_interleaved_failed_write_does_not_delete_other_workers_file(self):
        directory = Path(self.files.directory("root-task"))
        public = directory / "generated.png"
        other = self.root / "other-worker.png"
        other.write_bytes(b"OTHER-WORKER-FILE")

        async def fake(prompt, *, model_name, credentials):
            return PNG

        def interleaved_failure(fd, view):
            os.replace(other, public)
            raise OSError("disk full")

        with patch("wandrun.gateway.image_tools.request_image", fake), patch(
            "wandrun.runtime.files.os.write", side_effect=interleaved_failure,
        ):
            result = await self.invoke()
        self.assertEqual(result["error"]["code"], "image_generation_failed")
        self.assertIn("disk full", result["error"]["detail"])
        self.assertEqual(public.read_bytes(), b"OTHER-WORKER-FILE")
        self.assertEqual({path.name for path in directory.iterdir()}, {"generated.png"})

    async def test_quota_error_and_stopped_during_network(self):
        async def quota(prompt, *, model_name, credentials):
            raise ImageGenerationError("image_generation_quota_exhausted", "额度用尽", resets_at=1234)

        with patch("wandrun.gateway.image_tools.request_image", quota):
            result = await self.invoke()
        self.assertEqual(result, {"error": {
            "code": "image_generation_quota_exhausted", "detail": "额度用尽", "resets_at": 1234,
        }})

        begun = asyncio.Event()
        resume = asyncio.Event()

        async def pending(prompt, *, model_name, credentials):
            begun.set()
            await resume.wait()
            return PNG

        with patch("wandrun.gateway.image_tools.request_image", pending):
            invocation = asyncio.create_task(self.invoke())
            await asyncio.wait_for(begun.wait(), 2)
            await self.manager.cancel("root-task")
            resume.set()
            with self.assertRaises(asyncio.CancelledError):
                await invocation
        self.assertEqual(list(Path(self.files.directory("root-task")).iterdir()), [])

        async def forbidden(prompt, *, model_name):
            self.fail("stopped task must not request an image")

        with patch("wandrun.gateway.image_tools.request_image", forbidden):
            with self.assertRaises(asyncio.CancelledError):
                await self.invoke()

    async def test_rejects_missing_remote_and_unprepared_directory_before_network(self):
        async def forbidden(prompt, *, model_name):
            self.fail("invalid task must never generate an image")

        with patch("wandrun.gateway.image_tools.request_image", forbidden):
            self.assertEqual((await self.tool.ainvoke({"prompt": "x"}))["error"]["code"], "image_generation_failed")
            with self.assertRaises(asyncio.CancelledError):
                await self.invoke("missing-task")
            self.files.remote_backends["main"] = object()
            remote = await self.invoke()
            self.assertEqual(remote["error"]["code"], "image_generation_failed")
            self.files.remote_backends.clear()
            directory = Path(self.files.directory("root-task"))
            directory.rmdir()
            outsider = self.root / "outside"
            outsider.mkdir()
            directory.symlink_to(outsider, target_is_directory=True)
            swapped = await self.invoke()
            self.assertEqual(swapped["error"]["code"], "image_generation_failed")
            self.assertEqual(list(outsider.iterdir()), [])
            directory.unlink()
            self.files.conversation_workdirs = False
            disabled = await self.invoke()
            self.assertEqual(disabled["error"]["code"], "image_generation_failed")
