"""tus upload boundaries, durable placement, and user message attachment ownership."""

import asyncio
import base64
import errno
import os
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urljoin, urlsplit

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.uploads import UPLOAD_LIFETIME
from wandrun.runtime.files import ResolvedAttachment


def metadata(conversation_id, filename="报告.pdf", filetype="application/pdf"):
    fields = {"conversation_id": conversation_id, "filename": filename, "filetype": filetype}
    return ",".join(f"{key} {base64.b64encode(value.encode()).decode()}" for key, value in fields.items())


class UploadProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / ".wandrun" / "state" / "gateway.sqlite"
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog(
            main_agent="main", agents={"main": AgentDefinition(
                description="Test", system_prompt="Test", model="offline", environment="local",
            )},
        ))
        self.gateway = Gateway(self.store)
        self.gateway.workspace_root = self.root
        self.gateway.enable_uploads(max_size=8)
        self.prompts = []
        self.gateway.manager = SimpleNamespace(interrupt=lambda *args, **kwargs: self.prompts.append((args, kwargs)))
        self.conversation, _ = self.store.create_conversation("New", "main")
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway", headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)

    async def create(self, *, conversation_id=None, filename="报告.pdf", filetype="application/pdf", length=6):
        response = await self.client.post("/uploads", headers={
            "Tus-Resumable": "1.0.0", "Upload-Length": str(length),
            "Upload-Metadata": metadata(conversation_id or self.conversation["id"], filename, filetype),
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response

    async def patch(self, location, offset, data, *, override=False):
        return await self.client.request("POST" if override else "PATCH", location, content=data, headers={
            "Tus-Resumable": "1.0.0", "Upload-Offset": str(offset),
            "Content-Type": "application/offset+octet-stream",
            **({"X-HTTP-Method-Override": "PATCH"} if override else {}),
        })

    async def head(self, location):
        return await self.client.head(location, headers={"Tus-Resumable": "1.0.0"})

    async def test_proxy_location_preserves_external_origin_and_mount_prefix(self):
        # TLS ends before ASGI; forwarded headers must not determine the upload URL.
        for prefix in ("", "/wandrun"):
            with self.subTest(prefix=prefix):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(
                        app=create_app(self.gateway, "secret"), root_path=prefix,
                    ),
                    base_url="http://gateway",
                    headers={"Authorization": "Bearer secret", "X-Forwarded-Proto": "https"},
                ) as upstream:
                    external = f"https://gateway{prefix}/uploads"
                    created = await upstream.post(f"{prefix}/uploads", headers={
                        "Tus-Resumable": "1.0.0", "Upload-Length": "3",
                        "Upload-Metadata": metadata(self.conversation["id"]),
                    })
                    self.assertEqual(created.status_code, 201)
                    target = urlsplit(urljoin(external, created.headers["Location"]))
                    self.assertEqual((target.scheme, target.netloc), ("https", "gateway"))
                    self.assertTrue(target.path.startswith(f"{prefix}/uploads/"))
                    patched = await upstream.patch(target.path, content=b"abc", headers={
                        "Tus-Resumable": "1.0.0", "Upload-Offset": "0",
                        "Content-Type": "application/offset+octet-stream",
                    })
                    self.assertEqual(patched.status_code, 204)
                    resumed = await upstream.head(target.path, headers={"Tus-Resumable": "1.0.0"})
                    self.assertEqual(resumed.status_code, 200)
                    self.assertEqual(resumed.headers["Upload-Offset"], "3")
                    self.assertEqual(resumed.headers["Upload-File-Id"], patched.headers["Upload-File-Id"])
                    deleted = await upstream.delete(target.path, headers={"Tus-Resumable": "1.0.0"})
                    self.assertEqual(deleted.status_code, 204)

    async def test_head_does_not_create_or_terminate_uploads(self):
        created = await self.create(length=3)
        before = self.store.pending_uploads()
        seq = self.store.last_seq()
        response = await self.client.head("/uploads", headers={
            "Tus-Resumable": "1.0.0", "Upload-Length": "3",
            "Upload-Metadata": metadata(self.conversation["id"]),
        })
        self.assertEqual(response.status_code, 405)
        response = await self.head(created.headers["Location"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Upload-Offset"], "0")
        self.assertEqual(self.store.pending_uploads(), before)
        self.assertEqual(self.store.last_seq(), seq)

    async def test_creation_options_auth_version_metadata_limits_and_disk(self):
        unauth = await self.client.options("/uploads", headers={"Authorization": "Bearer wrong"})
        self.assertEqual((unauth.status_code, unauth.json()["error"]["code"]), (401, "unauthorized"))
        options = await self.client.options("/uploads", headers={"Tus-Resumable": "9.9.9"})
        self.assertEqual((options.status_code, options.headers["Tus-Extension"], options.headers["Tus-Max-Size"]),
                         (200, "creation,termination", "8"))
        version = await self.client.post("/uploads")
        self.assertEqual(version.status_code, 412)
        self.assertEqual(version.headers["Tus-Version"], "1.0.0")
        for headers in (
            {"Upload-Length": "1", "Upload-Metadata": "filename !!!"},
            {"Upload-Length": "-1", "Upload-Metadata": metadata(self.conversation["id"])},
            {"Upload-Length": "1", "Upload-Metadata": metadata("missing")},
            {"Upload-Length": "1", "Upload-Metadata": metadata(self.conversation["id"], "../bad")},
            {"Upload-Length": "1", "Upload-Metadata": metadata(self.conversation["id"]) + ",filename Zg=="},
            {"Upload-Length": "1", "Upload-Metadata": metadata(self.conversation["id"], filetype="文本/plain")},
        ):
            with self.subTest(headers=headers):
                result = await self.client.post("/uploads", headers={"Tus-Resumable": "1.0.0", **headers})
                self.assertIn(result.status_code, (400, 404))
                self.assertIn("error", result.json())
        forbidden = await self.client.post("/uploads", headers={
            "Tus-Resumable": "1.0.0", "Upload-Length": "1",
            "Upload-Metadata": metadata(self.conversation["id"], ".wandrun"),
        })
        self.assertEqual((forbidden.status_code, forbidden.json()["error"]["code"]), (400, "invalid_request"))
        too_big = await self.client.post("/uploads", headers={
            "Tus-Resumable": "1.0.0", "Upload-Length": "9",
            "Upload-Metadata": metadata(self.conversation["id"]),
        })
        self.assertEqual(too_big.status_code, 413)
        with patch("wandrun.gateway.uploads.shutil.disk_usage", return_value=SimpleNamespace(free=1)):
            result = await self.client.post("/uploads", headers={
                "Tus-Resumable": "1.0.0", "Upload-Length": "2",
                "Upload-Metadata": metadata(self.conversation["id"]),
            })
        self.assertEqual(result.status_code, 507)
        self.assertEqual(self.store.pending_uploads(), [])
        self.gateway.runtime = SimpleNamespace(files=SimpleNamespace(remote_backends={"main": object()}))
        remote = await self.client.post("/uploads", headers={
            "Tus-Resumable": "1.0.0", "Upload-Length": "1",
            "Upload-Metadata": metadata(self.conversation["id"]),
        })
        self.assertEqual((remote.status_code, remote.json()["error"]["code"]), (409, "remote_environment"))
        self.gateway.runtime = None

    async def test_protocol_header_errors_and_options_override_do_not_change_offset(self):
        created = await self.create(length=3)
        url = created.headers["Location"]
        options = await self.client.request("POST", url, headers={"X-HTTP-Method-Override": "OPTIONS",
                                                                  "Tus-Resumable": "unsupported"})
        self.assertEqual((options.status_code, options.headers["Tus-Extension"]), (200, "creation,termination"))
        bad_version = await self.client.head(url, headers={"Tus-Resumable": "0.0.1"})
        self.assertEqual(bad_version.status_code, 412)
        self.assertEqual(bad_version.headers["Tus-Version"], "1.0.0")
        missing_offset = await self.client.patch(url, content=b"abc", headers={
            "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream",
        })
        self.assertEqual(missing_offset.status_code, 400)
        wrong_type = await self.client.patch(url, content=b"abc", headers={
            "Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "text/plain",
        })
        self.assertEqual(wrong_type.status_code, 415)
        self.assertEqual((await self.head(url)).headers["Upload-Offset"], "0")
        self.assertEqual((await self.client.get("/uploads/nonexistent")).status_code, 412)
        self.assertEqual((await self.head("/uploads/nonexistent")).status_code, 404)

    async def test_offsets_completion_id_collision_download_search_and_termination(self):
        directory = self.root / "conversations" / self.conversation["id"]
        directory.mkdir(parents=True)
        original = directory / "报告.pdf"
        original.write_bytes(b"agent")
        created = await self.create()
        location = created.headers["Location"]
        self.assertEqual(created.headers["Upload-Offset"], "0")
        self.assertNotIn("Upload-File-Id", created.headers)
        first = await self.patch(location, 0, b"abc", override=True)
        self.assertEqual((first.status_code, first.headers["Upload-Offset"]), (204, "3"))
        wrong = await self.patch(location, 0, b"bad")
        self.assertEqual((wrong.status_code, wrong.json()["error"]["code"]), (409, "offset_conflict"))
        too_long = await self.patch(location, 3, b"1234")
        self.assertEqual(too_long.status_code, 413)
        during = await self.head(location)
        self.assertEqual((during.headers["Upload-Offset"], during.headers["Cache-Control"]), ("3", "no-store"))
        self.assertNotIn("Upload-File-Id", during.headers)
        self.assertEqual(during.headers["Upload-Metadata"], metadata(self.conversation["id"]))
        self.assertFalse((directory / "报告 (1).pdf").exists())
        finished = await self.patch(location, 3, b"def")
        self.assertEqual((finished.status_code, finished.headers["Upload-Offset"]), (204, "6"))
        file_id = finished.headers["Upload-File-Id"]
        self.assertEqual((await self.head(location)).headers["Upload-File-Id"], file_id)
        self.assertEqual((await self.patch(location, 3, b"def")).status_code, 409)
        self.assertEqual((await self.head(location)).headers["Upload-File-Id"], file_id)
        self.assertEqual(original.read_bytes(), b"agent")
        self.assertEqual((directory / "报告 (1).pdf").read_bytes(), b"abcdef")
        self.assertEqual((await self.client.get(f"/files/{file_id}/content")).content, b"abcdef")
        self.assertEqual((await self.client.get(f"/files/{file_id}")).json()["source"], "user_upload")
        self.assertEqual((await self.client.get("/search", params={"q": "报告 (1)"})).json()["results"][0]["id"], file_id)
        deleted = await self.client.request("POST", location, headers={
            "Tus-Resumable": "1.0.0", "X-HTTP-Method-Override": "DELETE",
        })
        self.assertEqual(deleted.status_code, 204)
        self.assertEqual((await self.head(location)).status_code, 404)
        self.assertEqual((directory / "报告 (1).pdf").read_bytes(), b"abcdef")
        self.assertEqual((await self.client.get(f"/files/{file_id}")).status_code, 200)
        self.store.begin_delete(self.conversation["id"], set())
        self.store.finish_delete(self.conversation["id"])
        self.assertEqual((await self.client.get(f"/files/{file_id}/content")).content, b"abcdef")
        retained = (await self.client.get("/search", params={"q": "报告 (1)"})).json()["results"][0]["file"]
        self.assertIsNone(retained["conversation_id"])

    async def test_zero_length_expiry_and_incomplete_termination(self):
        created = await self.create(length=0, filename="empty.txt", filetype="text/plain")
        file_id = created.headers["Upload-File-Id"]
        self.assertEqual((await self.head(created.headers["Location"])).headers["Upload-File-Id"], file_id)
        self.assertEqual((await self.client.get(f"/files/{file_id}/content")).content, b"")
        pending = await self.create(length=5, filename="pending.txt", filetype="text/plain")
        url = pending.headers["Location"]
        identity = url.rsplit("/", 1)[1]
        self.assertEqual((await self.client.delete(url, headers={"Tus-Resumable": "1.0.0"})).status_code, 204)
        self.assertFalse((self.root / ".wandrun" / "uploads" / identity).exists())
        self.assertEqual((await self.head(url)).status_code, 404)
        stale = await self.create(length=5)
        stale_id = stale.headers["Location"].rsplit("/", 1)[1]
        self.store._connection.execute("UPDATE uploads SET created_at = ? WHERE id = ?",
                                       (time.time() - UPLOAD_LIFETIME - 1, stale_id))
        self.gateway.uploads.expire()
        self.assertEqual((await self.head(stale.headers["Location"])).status_code, 404)
    async def test_termination_intent_survives_cleanup_and_database_failures(self):
        created = await self.create(filename="cancel.txt", filetype="text/plain", length=3)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        source = self.root / ".wandrun" / "uploads" / identity
        with patch.object(self.store, "mark_upload_terminating", side_effect=OSError("commit failed")):
            with self.assertRaisesRegex(OSError, "commit failed"):
                self.gateway.uploads.terminate(identity)
        self.assertTrue(source.exists())
        self.assertFalse(self.store.upload(identity)["terminating"])
        with patch.object(self.store, "remove_upload", side_effect=OSError("delete failed")):
            with self.assertRaisesRegex(OSError, "delete failed"):
                self.gateway.uploads.terminate(identity)
        self.assertTrue(self.store.upload(identity)["terminating"])
        self.assertFalse(source.exists())
        self.assertEqual((await self.head(created.headers["Location"])).status_code, 404)
        self.store.close()
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.gateway.store = self.store
        self.gateway.enable_uploads(max_size=8)
        self.gateway.uploads.recover()
        self.assertIsNone(self.store.upload(identity))
        self.assertEqual(list((self.root / "conversations").glob("**/cancel.txt")), [])

    async def test_expiry_skips_patch_waiting_for_request_body(self):
        created = await self.create(filename="slow.txt", filetype="text/plain", length=3)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        started, release = asyncio.Event(), asyncio.Event()

        async def body():
            yield b"a"
            started.set()
            await release.wait()
            yield b"bc"

        request = asyncio.create_task(self.patch(created.headers["Location"], 0, body()))
        try:
            await asyncio.wait_for(started.wait(), 2)
            self.store._connection.execute("UPDATE uploads SET created_at = ? WHERE id = ?",
                                           (time.time() - UPLOAD_LIFETIME - 1, identity))
            self.gateway.uploads.expire()
            self.assertIsNotNone(self.store.upload(identity))
            self.assertTrue((self.root / ".wandrun" / "uploads" / identity).exists())
        finally:
            release.set()
        response = await request
        self.assertEqual(response.status_code, 204, response.text)
        self.assertEqual((self.root / "conversations" / self.conversation["id"] / "slow.txt").read_bytes(), b"abc")

    async def test_head_retains_optional_empty_metadata_across_restart(self):
        header = metadata(self.conversation["id"]) + ",optional,other "
        result = await self.client.post("/uploads", headers={
            "Tus-Resumable": "1.0.0", "Upload-Length": "3", "Upload-Metadata": header,
        })
        self.assertEqual(result.status_code, 201)
        self.store.close()
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.gateway.store = self.store
        self.gateway.enable_uploads(max_size=8)
        response = await self.head(result.headers["Location"])
        self.assertEqual(response.headers["Upload-Metadata"], header)


    async def test_messages_attach_only_own_uploads_and_preserve_replay(self):
        created = await self.create(filename="notes.txt", filetype="text/plain", length=2)
        pending = await self.create(filename="waiting.txt", filetype="text/plain", length=2)
        file_id = (await self.patch(created.headers["Location"], 0, b"hi")).headers["Upload-File-Id"]
        other, _ = self.store.create_conversation("Other", "main")
        other_upload = await self.create(conversation_id=other["id"], filename="other.txt", filetype="text/plain", length=0)
        agent_path = self.root / "agent.txt"
        agent_path.write_text("agent")
        self.store.append_agent_message(self.conversation["id"], self.conversation["id"], "here", None, [
            ResolvedAttachment(str(agent_path), "agent.txt", 5, "text/plain"),
        ])
        agent_id = self.store.history(self.conversation["id"], limit=2)[0].data["attachments"][0]["id"]
        for identity in ("missing", agent_id, other_upload.headers["Upload-File-Id"],
                         self.store.upload(pending.headers["Location"].rsplit("/", 1)[1])["file_id"]):
            result = await self.client.post(f"/conversations/{self.conversation['id']}/messages", json={
                "client_id": "bad-" + identity, "text": "text", "attachments": [identity],
            })
            self.assertEqual(result.status_code, 400, result.text)
        self.assertEqual(self.prompts, [])
        endpoint = f"/conversations/{self.conversation['id']}/messages"
        first = await self.client.post(endpoint, json={"client_id": "sent", "attachments": [file_id]})
        self.assertEqual(first.status_code, 202, first.text)
        record = first.json()["event"]["data"]["attachments"][0]
        self.assertEqual((record["id"], record["source"], first.json()["event"]["data"]["text"]),
                         (file_id, "user_upload", ""))
        prompt = self.prompts[0][0][0]
        self.assertIn("notes.txt", prompt)
        self.assertIn("用户上传", prompt)
        self.assertNotIn(str(self.root), prompt)
        replay = await self.client.post(endpoint, json={"client_id": "sent", "text": "different"})
        self.assertEqual(replay.status_code, 200)
        self.assertTrue(replay.json()["replayed"])
        self.assertEqual(replay.json()["event"], first.json()["event"])
        self.assertEqual(len(self.prompts), 1)

    async def test_crash_after_placement_restarts_with_same_file_id_and_no_overwrite(self):
        created = await self.create(filename="crash.bin", filetype="application/octet-stream", length=3)
        location = created.headers["Location"]
        identity = location.rsplit("/", 1)[1]
        stable = self.store.upload(identity)["file_id"]
        with patch.object(self.store, "finish_upload", side_effect=OSError("database unavailable")):
            with self.assertRaises(OSError):
                await self.patch(location, 0, b"yes")
        destination = self.root / "conversations" / self.conversation["id"] / "crash.bin"
        self.assertEqual(destination.read_bytes(), b"yes")
        self.assertIsNone(self.store.file(stable))
        self.store.close()
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.gateway = Gateway(self.store)
        self.gateway.workspace_root = self.root
        self.gateway.enable_uploads(max_size=8)
        self.gateway.uploads.recover()
        self.assertEqual(self.store.upload(identity)["file_id"], stable)
        self.assertTrue(self.store.upload(identity)["completed"])
        self.assertEqual(self.store.file(stable)[0]["source"], "user_upload")
        self.assertEqual(destination.read_bytes(), b"yes")
        self.assertFalse((self.root / ".wandrun" / "uploads" / identity).exists())
        await self.client.aclose()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
                                        base_url="http://gateway", headers={"Authorization": "Bearer secret"})
        self.addAsyncCleanup(self.client.aclose)
        self.assertEqual((await self.head(location)).headers["Upload-File-Id"], stable)

    async def test_recovery_reuses_committed_suffixed_destination_after_original_is_removed(self):
        directory = self.root / "conversations" / self.conversation["id"]
        directory.mkdir(parents=True)
        original = directory / "same.txt"
        original.write_bytes(b"old")
        created = await self.create(filename="same.txt", filetype="text/plain", length=3)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        stable_id = self.store.upload(identity)["file_id"]
        with patch.object(self.store, "finish_upload", side_effect=OSError("commit failed")):
            with self.assertRaisesRegex(OSError, "commit failed"):
                await self.patch(created.headers["Location"], 0, b"new")
        preferred = directory / "same (1).txt"
        self.assertEqual(self.store.upload(identity)["destination"], str(preferred))
        original.unlink()
        self.gateway.uploads.recover()
        self.assertFalse(original.exists())
        self.assertEqual([path.name for path in directory.iterdir()], ["same (1).txt"])
        self.assertEqual(self.store.file(stable_id)[1], str(preferred))
        self.assertEqual(preferred.read_bytes(), b"new")

    async def test_recovery_reallocates_a_committed_destination_taken_by_another_file(self):
        created = await self.create(filename="taken.txt", filetype="text/plain", length=3)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        with patch.object(self.store, "finish_upload", side_effect=OSError("commit failed")):
            with self.assertRaisesRegex(OSError, "commit failed"):
                await self.patch(created.headers["Location"], 0, b"new")
        directory = self.root / "conversations" / self.conversation["id"]
        original = directory / "taken.txt"
        original.unlink()
        original.write_bytes(b"other")
        self.gateway.uploads.recover()
        self.assertEqual(original.read_bytes(), b"other")
        self.assertEqual((directory / "taken (1).txt").read_bytes(), b"new")
        self.assertEqual(self.store.file(self.store.upload(identity)["file_id"])[1], str(directory / "taken (1).txt"))

    async def test_collected_unpublished_upload_can_cancel_or_expire_and_published_file_survives(self):
        directory = self.root / "conversations" / self.conversation["id"]
        for filename, action in (("cancel.txt", "cancel"), ("expire.txt", "expire"), ("restart.txt", "recover")):
            created = await self.create(filename=filename, filetype="text/plain", length=3)
            identity = created.headers["Location"].rsplit("/", 1)[1]
            stage = self.root / "conversations" / (".upload-" + identity + ".stage")

            def full_disk(upload, target):
                stage.write_bytes(b"partial")
                raise OSError(errno.ENOSPC, "full")

            with patch.object(self.gateway.uploads, "_stage", side_effect=full_disk):
                with self.assertRaises(OSError):
                    await self.patch(created.headers["Location"], 0, b"abc")
                self.assertEqual(self.store.upload(identity)["offset"], 3)
                if action == "cancel":
                    self.assertEqual((await self.client.delete(created.headers["Location"],
                                    headers={"Tus-Resumable": "1.0.0"})).status_code, 204)
                else:
                    self.store._connection.execute("UPDATE uploads SET created_at = ? WHERE id = ?",
                                                   (time.time() - UPLOAD_LIFETIME - 1, identity))
                    if action == "recover":
                        self.gateway.uploads.recover()
                    else:
                        self.gateway.uploads.expire()
            self.assertIsNone(self.store.upload(identity))
            self.assertFalse(stage.exists())
            self.assertFalse((directory / filename).exists())

        created = await self.create(filename="published.txt", filetype="text/plain", length=3)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        file_id = self.store.upload(identity)["file_id"]
        with patch.object(self.store, "finish_upload", side_effect=OSError("commit failed")):
            with self.assertRaisesRegex(OSError, "commit failed"):
                await self.patch(created.headers["Location"], 0, b"yes")
        self.store._connection.execute("UPDATE uploads SET created_at = ? WHERE id = ?",
                                       (time.time() - UPLOAD_LIFETIME - 1, identity))
        self.gateway.uploads.expire()
        self.assertIsNone(self.store.upload(identity))
        self.assertEqual(self.store.file(file_id)[0]["source"], "user_upload")
        self.assertEqual((directory / "published.txt").read_bytes(), b"yes")

    async def test_cross_device_copy_recovery_and_symlink_collision(self):
        directory = self.root / "conversations" / self.conversation["id"]
        directory.mkdir(parents=True)
        (directory / "file.txt").symlink_to(self.root / "outside.txt")
        created = await self.create(filename="file.txt", filetype="text/plain", length=3)
        url = created.headers["Location"]
        source = self.root / ".wandrun" / "uploads" / url.rsplit("/", 1)[1]
        original_link = os.link

        def cross_volume(src, dst, **kwargs):
            if Path(src) == source:
                raise OSError(errno.EXDEV, "cross-device")
            return original_link(src, dst, **kwargs)

        with patch("wandrun.gateway.uploads.os.link", side_effect=cross_volume):
            finished = await self.patch(url, 0, b"abc")
        self.assertEqual(finished.status_code, 204, finished.text)
        self.assertTrue((directory / "file.txt").is_symlink())
        self.assertEqual((directory / "file (1).txt").read_bytes(), b"abc")
        self.assertEqual(list(directory.parent.glob(".upload-*.stage")), [])

    async def test_short_writes_and_failed_patch_never_advance_unwritten_bytes(self):
        created = await self.create(filename="short.bin", filetype="application/octet-stream", length=6)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        source = self.root / ".wandrun" / "uploads" / identity
        original_open = Path.open

        class PartialWriter:
            def __init__(self, stream, fail=False):
                self.stream, self.fail, self.calls = stream, fail, 0

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def __getattr__(self, key):
                return getattr(self.stream, key)

            def write(self, data):
                self.calls += 1
                if self.fail and self.calls > 1:
                    raise OSError(errno.ENOSPC, "full")
                return self.stream.write(data[:max(1, len(data) // 2)])

        async def chunks():
            yield b"abcdef"

        def partial(path, *args, fail=False, **kwargs):
            stream = original_open(path, *args, **kwargs)
            return PartialWriter(stream, fail=fail) if path == source and args[0] == "r+b" else stream

        with patch.object(Path, "open", autospec=True, side_effect=lambda path, *args, **kwargs:
                          partial(path, *args, fail=True, **kwargs)):
            with self.assertRaises(OSError):
                await self.gateway.uploads.advance(self.store.upload(identity), 0, chunks())
        self.assertEqual(self.store.upload(identity)["offset"], 0)
        self.assertEqual((await self.head(created.headers["Location"])).headers["Upload-Offset"], "0")
        with patch.object(Path, "open", autospec=True, side_effect=partial):
            result = await self.gateway.uploads.advance(self.store.upload(identity), 0, chunks())
        self.assertEqual(result["offset"], 6)
        self.assertEqual((self.root / "conversations" / self.conversation["id"] / "short.bin").read_bytes(), b"abcdef")

    async def test_recovery_of_interrupted_cross_volume_staging(self):
        created = await self.create(filename="recover.txt", filetype="text/plain", length=3)
        identity = created.headers["Location"].rsplit("/", 1)[1]
        source = self.root / ".wandrun" / "uploads" / identity
        source.write_bytes(b"abc")
        self.store.advance_upload(identity, 3)
        directory = self.root / "conversations"
        directory.mkdir()
        stage = directory / (".upload-" + identity + ".stage")
        stage.write_bytes(b"a")
        expected = self.store.upload(identity)["file_id"]
        original_link = os.link

        def cross_volume(src, dst, **kwargs):
            if Path(src) == source:
                raise OSError(errno.EXDEV, "cross-device")
            return original_link(src, dst, **kwargs)

        with patch("wandrun.gateway.uploads.os.link", side_effect=cross_volume):
            self.gateway.uploads.recover()
        self.assertTrue(self.store.upload(identity)["completed"])
        self.assertEqual(self.store.file(expected)[0]["name"], "recover.txt")
        self.assertEqual((directory / self.conversation["id"] / "recover.txt").read_bytes(), b"abc")
        self.assertFalse(stage.exists())

    async def test_legacy_schema_is_rejected_without_migration(self):
        other = self.root / "legacy.sqlite"
        with closing(sqlite3.connect(other)) as connection:
            connection.execute("PRAGMA user_version = 11")
        with self.assertRaisesRegex(RuntimeError, "不兼容"):
            GatewayStore(other)
