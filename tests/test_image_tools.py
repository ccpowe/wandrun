"""Image tool publishes only completed local PNGs for the invoking task."""

import asyncio
import base64
import os
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from wandrun.gateway.image_tools import image_tools
from wandrun.integrations.image_generation import (
    GeneratedImage, ImageGenerationError, MAX_REFERENCE_BYTES, MAX_REFERENCE_IMAGES,
)
from wandrun.integrations.codex_subscription import CodexSubscriptionModel
from wandrun.runtime.execution.files import TaskFiles
from wandrun.runtime.communication.workers import WorkerManager


def image_bytes(format="PNG", color="red"):
    output = io.BytesIO()
    Image.new("RGB", (8, 12), color).save(output, format=format)
    return output.getvalue()


PNG = image_bytes()
GENERATED = GeneratedImage(data=PNG, quality="medium", width=8, height=12)


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

    async def invoke(self, task_id="root-task", prompt="画只猫", **kwargs):
        return await self.tool.ainvoke(
            {"prompt": prompt, **kwargs}, config={"configurable": {"thread_id": task_id}},
        )

    async def test_two_saves_skip_existing_symlink_and_keep_bytes_out_of_model(self):
        directory = Path(self.files.directory("root-task"))
        outside = self.root / "outside.png"
        outside.write_bytes(b"must remain")
        (directory / "generated.png").symlink_to(outside)
        calls = []

        async def fake(prompt, **kwargs):
            calls.append((prompt, kwargs["model_name"]))
            return GENERATED

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
        self.assertNotIn(base64.b64encode(PNG).decode(), repr(first))

    async def test_child_saves_to_root_conversation_directory(self):
        self.manager.start("child", "child-task", sender_id="root-task", agent_name="child")
        await self.files.prepare("child-task")

        async def fake(prompt, **kwargs):
            return GENERATED

        with patch("wandrun.gateway.image_tools.request_image", fake):
            result = await self.invoke("child-task")
        self.assertEqual(Path(result["path"]), Path(self.files.directory("root-task")) / "generated.png")
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertFalse((self.root / "conversations" / "child-task").exists())

    async def test_cancelled_and_failed_generation_never_publish(self):
        directory = Path(self.files.directory("root-task"))
        begun = asyncio.Event()
        resume = asyncio.Event()

        async def pending(prompt, **kwargs):
            begun.set()
            await resume.wait()
            return GENERATED

        with patch("wandrun.gateway.image_tools.request_image", pending):
            invocation = asyncio.create_task(self.invoke())
            await asyncio.wait_for(begun.wait(), 2)
            invocation.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await invocation
        self.assertEqual(list(directory.iterdir()), [])

        async def failed(prompt, **kwargs):
            raise ImageGenerationError("image_generation_failed", "服务端拒绝了请求")

        with patch("wandrun.gateway.image_tools.request_image", failed):
            result = await self.invoke()
        self.assertEqual(result, {"error": {"code": "image_generation_failed", "detail": "服务端拒绝了请求"}})
        self.assertEqual(list(directory.iterdir()), [])

    async def test_failed_write_removes_only_its_own_incomplete_file(self):
        directory = Path(self.files.directory("root-task"))
        existing = directory / "generated.png"
        existing.write_bytes(b"existing")

        async def fake(prompt, **kwargs):
            return GENERATED

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

        async def fake(prompt, **kwargs):
            return GENERATED

        def interleaved_write(fd, view):
            os.replace(other, public)
            return real_write(fd, view)

        with patch("wandrun.gateway.image_tools.request_image", fake), patch(
            "wandrun.runtime.execution.files.os.write", side_effect=interleaved_write,
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

        async def fake(prompt, **kwargs):
            return GENERATED

        def interleaved_failure(fd, view):
            os.replace(other, public)
            raise OSError("disk full")

        with patch("wandrun.gateway.image_tools.request_image", fake), patch(
            "wandrun.runtime.execution.files.os.write", side_effect=interleaved_failure,
        ):
            result = await self.invoke()
        self.assertEqual(result["error"]["code"], "image_generation_failed")
        self.assertIn("disk full", result["error"]["detail"])
        self.assertEqual(public.read_bytes(), b"OTHER-WORKER-FILE")
        self.assertEqual({path.name for path in directory.iterdir()}, {"generated.png"})

    async def test_quota_error_and_stopped_during_network(self):
        async def quota(prompt, **kwargs):
            raise ImageGenerationError("image_generation_quota_exhausted", "额度用尽", resets_at=1234)

        with patch("wandrun.gateway.image_tools.request_image", quota):
            result = await self.invoke()
        self.assertEqual(result, {"error": {
            "code": "image_generation_quota_exhausted", "detail": "额度用尽", "resets_at": 1234,
        }})

        begun = asyncio.Event()
        resume = asyncio.Event()

        async def pending(prompt, **kwargs):
            begun.set()
            await resume.wait()
            return GENERATED

        with patch("wandrun.gateway.image_tools.request_image", pending):
            invocation = asyncio.create_task(self.invoke())
            await asyncio.wait_for(begun.wait(), 2)
            await self.manager.cancel("root-task")
            resume.set()
            with self.assertRaises(asyncio.CancelledError):
                await invocation
        self.assertEqual(list(Path(self.files.directory("root-task")).iterdir()), [])

        async def forbidden(prompt, **kwargs):
            self.fail("stopped task must not request an image")

        with patch("wandrun.gateway.image_tools.request_image", forbidden):
            with self.assertRaises(asyncio.CancelledError):
                await self.invoke()

    async def test_rejects_missing_remote_and_unprepared_directory_before_network(self):
        async def forbidden(prompt, **kwargs):
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

    async def test_three_references_reach_request_in_order_and_report_actual_output(self):
        directory = Path(self.files.directory("root-task"))
        raws = [image_bytes("PNG", "red"), image_bytes("JPEG", "green"), image_bytes("WEBP", "blue")]
        paths = ["cardigan.png", "skirt.jpg", "bag.webp"]
        for name, raw in zip(paths, raws):
            (directory / name).write_bytes(raw)
        bodies = []

        async def respond(model, body):
            bodies.append(body)
            yield {"type": "response.output_item.done", "item": {
                "type": "image_generation_call", "status": "completed",
                "result": base64.b64encode(PNG).decode(), "quality": "medium",
                "size": "1024x1536",
            }}
            yield {"type": "response.completed", "response": {"status": "completed", "output": []}}

        with patch.object(CodexSubscriptionModel, "_arequest", respond):
            result = await self.invoke(reference_image_paths=paths, size="1024x1536")
        parts = bodies[0]["input"][0]["content"]
        self.assertEqual(
            [part["image_url"] for part in parts[1:]],
            [
                f"data:image/{kind};base64,{base64.b64encode(raw).decode()}"
                for kind, raw in zip(("png", "jpeg", "webp"), raws)
            ],
        )
        self.assertEqual(bodies[0]["tools"][0]["size"], "1024x1536")
        self.assertEqual((result["width"], result["height"], result["quality"]), (8, 12, "medium"))
        self.assertTrue(result["used_reference_images"])
        self.assertEqual(Path(result["path"]).read_bytes(), PNG)
        self.assertNotIn(base64.b64encode(PNG).decode(), repr(result))

    async def test_unsafe_or_invalid_references_fail_before_billable_request(self):
        directory = Path(self.files.directory("root-task"))
        (directory / "valid.png").write_bytes(PNG)
        (directory / "not-image.png").write_text("not an image")
        (directory / "broken.png").write_bytes(PNG[:30])
        (directory / "unsupported.gif").write_bytes(image_bytes("GIF"))
        outside = self.root / "outside.png"
        outside.write_bytes(PNG)
        other = self.root / "conversations" / "another-task"
        other.mkdir()
        (other / "private.png").write_bytes(PNG)
        (directory / "link.png").symlink_to(directory / "valid.png")
        (directory / "linked-dir").symlink_to(other, target_is_directory=True)
        (directory / ".wandrun").mkdir()
        (directory / ".wandrun" / "secret.png").write_bytes(PNG)
        os.mkfifo(directory / "pipe.png")
        with (directory / "large.png").open("wb") as source:
            source.truncate(MAX_REFERENCE_BYTES + 1)
        billed = []

        async def forbidden(model, body):
            billed.append(body)
            raise AssertionError("invalid references must not make a billable request")
            yield  # Keep the same async-generator contract as the adapter.

        cases = [
            [str(outside)], [str(other / "private.png")], ["../../outside.png"],
            ["../another-task/private.png"], ["link.png"], ["linked-dir/private.png"],
            ["not-image.png"], ["broken.png"], ["unsupported.gif"], ["large.png"],
            ["."], ["pipe.png"], [".wandrun/secret.png"],
            ["https://example.com/product.png"], ["file://" + str(outside)],
            ["data:image/png;base64,AAAA"], ["valid.png"] * (MAX_REFERENCE_IMAGES + 1),
        ]
        with patch.object(CodexSubscriptionModel, "_arequest", forbidden):
            for paths in cases:
                with self.subTest(paths=paths):
                    result = await self.invoke(reference_image_paths=paths)
                    self.assertEqual(result["error"]["code"], "image_generation_failed")
                    self.assertFalse((directory / "generated.png").exists())
        self.assertEqual(billed, [])

    async def test_child_references_use_root_conversation_and_allow_its_absolute_paths(self):
        self.manager.start("child", "child-task", sender_id="root-task", agent_name="child")
        await self.files.prepare("child-task")
        directory = Path(self.files.directory("root-task"))
        source = directory / "product.png"
        source.write_bytes(PNG)
        self.assertEqual(self.files.read_local_file("child-task", str(source), max_bytes=len(PNG)), PNG)
        with self.assertRaises(ValueError):
            self.files.read_local_file("child-task", str(source), max_bytes=len(PNG) - 1)

    async def test_reference_read_uses_verified_handle_when_name_is_replaced(self):
        directory = Path(self.files.directory("root-task"))
        path = directory / "product.png"
        path.write_bytes(PNG)
        private = self.root / "private.png"
        private.write_bytes(b"must not read replacement")
        real_fdopen = os.fdopen

        def replace_before_read(descriptor, *args, **kwargs):
            path.unlink()
            path.symlink_to(private)
            return real_fdopen(descriptor, *args, **kwargs)

        with patch("wandrun.runtime.execution.files.os.fdopen", side_effect=replace_before_read):
            self.assertEqual(self.files.read_local_file("root-task", "product.png", max_bytes=len(PNG)), PNG)
