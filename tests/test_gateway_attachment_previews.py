"""Gateway-derived attachment metadata and thumbnail boundaries."""

from __future__ import annotations

import asyncio
import io
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import av
import httpx
from PIL import Image

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.attachment_previews import (
    AttachmentPreviewService,
    PreviewCache,
    PreviewUnavailable,
    _Source,
    _run_worker,
    _valid_metadata,
)
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.runtime.files import ResolvedAttachment


def image_bytes(width: int = 1200, height: int = 600) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (width, height), (20, 80, 140)).save(output, format="PNG")
    return output.getvalue()


def video_file(path: Path) -> None:
    with av.open(str(path), mode="w", format="mp4") as container:
        stream = container.add_stream("mpeg4", rate=2)
        stream.width, stream.height = 320, 180
        stream.pix_fmt = "yuv420p"
        for color in ((200, 20, 20), (20, 200, 20), (20, 20, 200), (200, 200, 20)):
            frame = av.VideoFrame.from_image(Image.new("RGB", (320, 180), color))
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def audio_file(path: Path) -> None:
    with av.open(str(path), mode="w", format="wav") as container:
        stream = container.add_stream("pcm_s16le", rate=8000)
        frame = av.AudioFrame(format="s16", layout="mono", samples=8000)
        frame.sample_rate = 8000
        frame.planes[0].update(b"\0\0" * 8000)
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def pdf_file(page_count: int = 2, encrypted: bool = False) -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (f"<< /Type /Pages /Kids [{' '.join(f'{i} 0 R' for i in range(3, 3 + page_count))}] "
         f"/Count {page_count} >>").encode(),
    ]
    content_number = 3 + page_count
    objects.extend(
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] "
            f"/Contents {content_number} 0 R /Resources << >> >>"
        ).encode()
        for _ in range(page_count)
    )
    objects.append(b"<< /Length 0 >>\nstream\n\nendstream")
    encrypt_ref = ""
    if encrypted:
        objects.append(
            b"<< /Filter /Standard /V 1 /Length 40 /R 2 /O "
            b"0000000000000000000000000000000000000000 /U "
            b"0000000000000000000000000000000000000000 /P -4 >>"
        )
        encrypt_ref = f" /Encrypt {len(objects)} 0 R"
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode())
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    output.extend(b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:]))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /ID [<01><01>]{encrypt_ref} >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(output)


class AttachmentPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = GatewayStore(self.root / "gateway.sqlite")
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog("main", {
            "main": AgentDefinition("Test", "Test", "offline", environment="local"),
        }))
        self.gateway = Gateway(self.store)
        self.gateway.workspace_root = self.root
        self.gateway.manager = SimpleNamespace(root_of=lambda sender: sender, agent_name=lambda sender: "main")
        self.conversation = self.store.create_conversation("Preview", "main")[0]["id"]
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway",
            headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)
        self.service = AttachmentPreviewService(self.root / ".wandrun" / "state" / "previews")
        self.gateway.attachment_previews = self.service
        self.addAsyncCleanup(self.service.aclose)

    def deliver(self, path: Path, media_type: str) -> dict:
        self.gateway.on_human(self.conversation, "Attached", [
            ResolvedAttachment(str(path), path.name, path.stat().st_size, media_type),
        ])
        return self.store.history(self.conversation, limit=2)[0].data["attachments"][0]

    async def test_preview_fields_cover_image_video_audio_and_pdf(self):
        samples = [
            ("photo.png", image_bytes(), "image/png", {"kind": "image", "width": 1200, "height": 600, "duration_ms": None, "page_count": None}),
            ("clip.mp4", None, "video/mp4", {"kind": "video", "width": 320, "height": 180, "page_count": None}),
            ("sound.wav", None, "audio/wav", {"kind": "audio", "width": None, "height": None, "page_count": None}),
            ("document.pdf", pdf_file(), "application/pdf", {"kind": "pdf", "width": 200, "height": 100, "duration_ms": None, "page_count": 2}),
        ]
        for name, content, media_type, expected in samples:
            with self.subTest(name=name):
                path = self.root / name
                if name.endswith(".mp4"):
                    video_file(path)
                elif name.endswith(".wav"):
                    audio_file(path)
                else:
                    path.write_bytes(content)
                record = self.deliver(path, media_type)
                response = await self.client.get(f"/files/{record['id']}/preview")
                self.assertEqual(response.status_code, 200, response.text)
                actual = response.json()
                for key, value in expected.items():
                    self.assertEqual(actual[key], value)
                if name.endswith(".mp4") or name.endswith(".wav"):
                    self.assertGreater(actual["duration_ms"], 0)
                if name.endswith((".mp4", ".pdf")):
                    thumbnail = await self.client.get(f"/files/{record['id']}/thumbnail?w=240")
                    self.assertEqual((thumbnail.status_code, thumbnail.headers["content-type"]), (200, "image/jpeg"))

    async def test_thumbnail_width_whitelist_and_aspect_ratio(self):
        path = self.root / "photo.png"
        path.write_bytes(image_bytes())
        record = self.deliver(path, "image/png")
        for width in (240, 480, 960):
            response = await self.client.get(f"/files/{record['id']}/thumbnail", params={"w": width})
            self.assertEqual((response.status_code, response.headers["content-type"]), (200, "image/jpeg"))
            with Image.open(io.BytesIO(response.content)) as image:
                self.assertEqual(image.size, (width, width // 2))
        for value in (None, "241", "0", "abc"):
            params = {} if value is None else {"w": value}
            response = await self.client.get(f"/files/{record['id']}/thumbnail", params=params)
            self.assertEqual(response.status_code, 400)

    async def test_remote_audio_thumbnail_and_bad_pdfs_return_contract_errors(self):
        remote, _ = self.store.append_agent_message(
            self.conversation, self.conversation, "remote", "main",
            [ResolvedAttachment("/remote/file.mp4", "remote.mp4", 1, "video/mp4", remote_environment="ssh")],
        )
        response = await self.client.get(f"/files/{remote.data['attachments'][0]['id']}/preview")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "remote_file_unsupported"))

        audio = self.root / "sound.wav"
        audio_file(audio)
        audio_record = self.deliver(audio, "audio/wav")
        response = await self.client.get(f"/files/{audio_record['id']}/thumbnail?w=240")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (422, "preview_unavailable"))

        for name, content in (("broken.pdf", b"not a pdf"), ("locked.pdf", pdf_file(encrypted=True))):
            path = self.root / name
            path.write_bytes(content)
            record = self.deliver(path, "application/pdf")
            response = await self.client.get(f"/files/{record['id']}/preview")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (422, "preview_unavailable"))

    async def test_cache_hit_file_change_and_single_flight(self):
        path = self.root / "photo.png"
        path.write_bytes(image_bytes())
        record = self.deliver(path, "image/png")
        import wandrun.gateway.attachment_previews as previews
        original = previews._run_worker
        counted = AsyncMock(wraps=original)
        with patch.object(previews, "_run_worker", counted):
            first = await self.client.get(f"/files/{record['id']}/preview")
            second = await self.client.get(f"/files/{record['id']}/preview")
            self.assertEqual((first.status_code, second.status_code, counted.await_count), (200, 200, 1))
            timestamp = time_ns_now()
            os.utime(path, ns=(timestamp, timestamp))
            changed = await self.client.get(f"/files/{record['id']}/preview")
            self.assertEqual((changed.status_code, changed.headers["etag"] != first.headers["etag"], counted.await_count), (200, True, 2))

        entered = asyncio.Event()
        release = asyncio.Event()

        async def delayed(source, width):
            entered.set()
            await release.wait()
            return await original(source, width)

        with patch.object(previews, "_run_worker", side_effect=delayed) as worker:
            first_task = asyncio.create_task(self.client.get(f"/files/{record['id']}/thumbnail?w=240"))
            await entered.wait()
            second_task = asyncio.create_task(self.client.get(f"/files/{record['id']}/thumbnail?w=240"))
            release.set()
            first_response, second_response = await asyncio.gather(first_task, second_task)
            self.assertEqual((first_response.status_code, second_response.status_code, worker.call_count), (200, 200, 1))

    async def test_cache_rejects_semantically_invalid_metadata_and_deletes_it(self):
        valid_image = {
            "kind": "image",
            "width": 1200,
            "height": 600,
            "duration_ms": None,
            "page_count": None,
        }
        self.assertTrue(_valid_metadata(valid_image))
        for invalid in (
            {**valid_image, "height": True},
            {**valid_image, "duration_ms": 1},
            {**valid_image, "width": 4097},
            {**valid_image, "kind": "audio"},
            {**valid_image, "kind": "pdf", "page_count": 0, "duration_ms": None},
            {key: value for key, value in valid_image.items() if key != "height"},
        ):
            self.assertFalse(_valid_metadata(invalid))

        cache = PreviewCache(self.root / "cache")
        key = "invalid-metadata"
        cache.put(key, ".json", b'{"kind":"image","width":1}')
        self.assertIsNone(cache.get(key, ".json", _valid_metadata))
        self.assertFalse((cache.root / f"{key}.json").exists())

    async def test_timeout_kills_worker_and_lru_evicts_old_entries(self):
        root = self.root / "cache"
        with patch("wandrun.gateway.attachment_previews.CACHE_BYTES", 1000):
            cache = PreviewCache(root)
            cache.put("one", ".jpg", b"a" * 400)
            cache.put("two", ".jpg", b"b" * 400)
            self.assertIsNone(cache.get("one", ".jpg"))
            self.assertEqual(cache.get("two", ".jpg"), b"b" * 400)

        path = self.root / "photo.png"
        path.write_bytes(image_bytes())
        fd = os.open(path, os.O_RDONLY)
        source = _Source("f", {"media_type": "image/png", "name": path.name}, fd, path.stat().st_size, path.stat().st_mtime_ns, "image")

        class HangingProcess:
            pid = 123
            returncode = None

            async def communicate(self):
                await asyncio.sleep(1)
                return b"", b""

            async def wait(self):
                self.returncode = -9

        process = HangingProcess()
        with patch("wandrun.gateway.attachment_previews.PREVIEW_TIMEOUT", 0.01), \
             patch("wandrun.gateway.attachment_previews.asyncio.create_subprocess_exec", AsyncMock(return_value=process)), \
             patch("wandrun.gateway.attachment_previews._kill_process") as kill:
            with self.assertRaises(PreviewUnavailable):
                await _run_worker(source, None)
            kill.assert_called_once_with(123)
        os.close(fd)


def time_ns_now() -> int:
    return time.time_ns() + 1_000_000


if __name__ == "__main__":
    unittest.main()
