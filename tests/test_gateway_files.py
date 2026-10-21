"""Original-file delivery, live authenticated reads, and unified search boundaries."""

import asyncio
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import _OpenedFileResponse, create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.runtime.files import ResolvedAttachment, TaskFiles


class FileDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = GatewayStore(self.root / "gateway.sqlite")
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog(
            main_agent="main",
            agents={"main": AgentDefinition(
                description="Test Agent", system_prompt="Test", model="offline", environment="local",
            )},
        ))
        self.gateway = Gateway(self.store)
        self.gateway.workspace_root = self.root
        self.gateway.manager = SimpleNamespace(root_of=lambda sender: sender, agent_name=lambda sender: "main")
        self.conversation, _ = self.store.create_conversation("Report", "main")
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
            base_url="http://gateway", headers={"Authorization": "Bearer secret"},
        )
        self.addAsyncCleanup(self.client.aclose)

    def deliver(self, name="report.txt", content=b"abcdef"):
        path = self.root / name
        path.write_bytes(content)
        self.gateway.on_human(self.conversation["id"], "Here it is", [
            ResolvedAttachment(str(path), name, len(content), "text/plain")
        ])
        message, produced = self.store.history(self.conversation["id"], limit=2)
        self.assertEqual((message.type, produced.type), ("message.agent", "file.produced"))
        record = message.data["attachments"][0]
        self.assertEqual(produced.data, {"file": record, "message_id": str(message.seq)})
        return path, record

    async def test_authenticated_live_range_download_and_unavailable_file(self):
        path, record = self.deliver()
        identity = record["id"]
        url = f"/files/{identity}/content"
        denied = await self.client.get(url, headers={"Authorization": "Bearer wrong"})
        self.assertEqual(denied.status_code, 401)
        partial = await self.client.get(url, headers={"Range": "bytes=1-3"})
        self.assertEqual((partial.status_code, partial.content), (206, b"bcd"))
        self.assertEqual(partial.headers["content-range"], "bytes 1-3/6")
        suffix = await self.client.get(url, headers={"Range": "bytes=-2"})
        self.assertEqual(suffix.content, b"ef")
        invalid = await self.client.get(url, headers={"Range": "bytes=8-9"})
        self.assertEqual((invalid.status_code, invalid.headers["content-range"]), (416, "bytes */6"))
        oversized = await self.client.get(url, headers={"Range": "bytes=" + "9" * 5000 + "-"})
        self.assertEqual(oversized.status_code, 416)
        path.write_bytes(b"new content")
        fresh = await self.client.get(f"/files/{identity}")
        self.assertEqual((fresh.json()["size"], fresh.json()["available"]), (11, True))
        self.assertEqual((await self.client.get(url)).content, b"new content")
        self.assertIn("attachment", (await self.client.get(url + "?download=true")).headers["content-disposition"])
        path.unlink()
        self.assertEqual((await self.client.get(f"/files/{identity}")).json()["available"], False)
        self.assertEqual((await self.client.get(url)).status_code, 410)
        self.assertEqual((await self.client.get("/files/missing")).status_code, 404)

    async def test_replacement_symlink_cannot_escape_and_active_content_cannot_preview(self):
        path, record = self.deliver("report.html", b"<script>bad()</script>")
        response = await self.client.get(f"/files/{record['id']}/content")
        self.assertIn("attachment", response.headers["content-disposition"])
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        outside = self.root.parent / (self.root.name + "-outside.txt")
        outside.write_bytes(b"secret")
        self.addCleanup(outside.unlink)
        path.unlink()
        path.symlink_to(outside)
        self.assertEqual((await self.client.get(f"/files/{record['id']}/content")).status_code, 410)
        path.unlink()
        inside = self.root / "other-public.txt"
        inside.write_bytes(b"not the registered file")
        path.symlink_to(inside)
        self.assertEqual((await self.client.get(f"/files/{record['id']}/content")).status_code, 410)
        path.unlink()
        control = self.root / ".wandrun"
        control.mkdir()
        (control / "credential").write_bytes(b"secret")
        path.symlink_to(control / "credential")
        self.assertEqual((await self.client.get(f"/files/{record['id']}/content")).status_code, 410)
        path.unlink()
        path.mkdir()
        self.assertEqual((await self.client.get(f"/files/{record['id']}")).json()["available"], False)
        path.rmdir()
        os.mkfifo(path)
        self.assertEqual((await self.client.get(f"/files/{record['id']}/content")).status_code, 410)

    async def test_control_directory_alias_is_rejected_at_registration_and_download(self):
        control = self.root / "control"
        control.mkdir()
        secret = control / "credential"
        secret.write_bytes(b"private")
        (self.root / ".wandrun").symlink_to(control, target_is_directory=True)
        (self.root / "control-alias").symlink_to(control, target_is_directory=True)
        files = TaskFiles(self.root, None, {}, conversation_workdirs=False)
        for candidate in (self.root / ".wandrun/credential", secret,
                          self.root / "control-alias/credential"):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                files.resolve_delivery(str(candidate))

        path = self.root / "public.txt"
        path.write_bytes(b"public")
        attachment = files.resolve_delivery(str(path))
        self.gateway.on_human(self.conversation["id"], "report", [attachment])
        record = self.store.history(self.conversation["id"], limit=2)[0].data["attachments"][0]
        url = f"/files/{record['id']}/content"
        self.assertEqual((await self.client.get(url)).content, b"public")
        path.unlink()
        path.symlink_to(secret)
        self.assertFalse((await self.client.get(f"/files/{record['id']}")).json()["available"])
        self.assertEqual((await self.client.get(url)).status_code, 410)

    async def test_download_uses_fd_dentry_not_replaced_control_name(self):
        path, record = self.deliver("public.txt", b"public")
        control = self.root / "control"
        control.mkdir()
        secret = control / "credential"
        secret.write_bytes(b"private")
        (self.root / ".wandrun").symlink_to(control, target_is_directory=True)
        path.unlink()
        path.symlink_to(secret)
        original_readlink = os.readlink
        opened_fd = []

        def replace_after_fd_readlink(link):
            actual = original_readlink(link)
            if str(link).startswith("/proc/self/fd/") and actual == str(secret):
                opened_fd.append(int(str(link).rsplit("/", 1)[1]))
                secret.rename(control / "held")
                secret.symlink_to(self.root / "safe.txt")
                (self.root / "safe.txt").write_bytes(b"public")
            return actual

        with patch("wandrun.runtime.files.os.readlink", side_effect=replace_after_fd_readlink):
            with self.assertRaises(OSError):
                self.gateway.open_file(record["id"])
        self.assertEqual(len(opened_fd), 1)
        with self.assertRaises(OSError):
            os.fstat(opened_fd[0])
        self.assertTrue((control / "held").is_file())

    async def test_literal_like_scope_pages_and_deleted_source_retention(self):
        path, record = self.deliver("name%_\\.txt")
        identity = record["id"]
        for query in ("%", "_", "\\"):
            found = (await self.client.get("/search", params={"q": query})).json()
            self.assertEqual([row["id"] for row in found["results"]], [identity])
        found = (await self.client.get("/search", params={"q": "name", "agent_id": "main", "limit": 1})).json()
        self.assertEqual((found["total"], found["results"][0]["kind"]), (1, "file"))
        self.assertEqual((await self.client.get("/search", params={"q": "name", "offset": 1})).json()["results"], [])
        self.assertEqual((await self.client.get("/search")).json()["results"], [])
        self.assertEqual((await self.client.get("/search", params={"q": "Here it is"})).json()["total"], 1)
        self.store.begin_delete(self.conversation["id"], set())
        self.store.finish_delete(self.conversation["id"])
        self.assertTrue(path.exists())
        self.assertEqual((await self.client.get("/search", params={"q": "Here it is"})).json()["results"], [])
        self.assertEqual((await self.client.get("/search", params={"q": "Report"})).json()["results"], [])
        retained = (await self.client.get("/search", params={"q": "name"})).json()["results"][0]["file"]
        self.assertIsNone(retained["conversation_id"])
        self.store.begin_delete_agent("main")
        self.store.finish_delete_agent("main")
        retained = (await self.client.get("/search", params={"q": "name"})).json()["results"][0]["file"]
        self.assertIsNone(retained["agent_id"])
        self.assertEqual((await self.client.get(f"/files/{identity}/content")).content, path.read_bytes())

    async def test_mixed_kind_pagination_keeps_order_and_total(self):
        self.deliver("Report.txt")
        self.store.append(self.conversation["id"], "message.user", {"text": "Report summary"})
        first = (await self.client.get("/search", params={"q": "Report", "limit": 1})).json()
        second = (await self.client.get("/search", params={"q": "Report", "limit": 1, "offset": 1})).json()
        third = (await self.client.get("/search", params={"q": "Report", "limit": 1, "offset": 2})).json()
        self.assertEqual((first["total"], second["total"], third["total"]), (3, 3, 3))
        self.assertEqual([page["results"][0]["kind"] for page in (first, second, third)],
                         ["conversation", "message", "file"])
        self.assertEqual((await self.client.get("/search", params={"q": "Report", "limit": 0})).status_code, 400)

    async def test_repeated_intentional_delivery_registers_new_ids_without_copying(self):
        path, first = self.deliver()
        path.write_bytes(b"changed")
        self.gateway.on_human(self.conversation["id"], "Updated", [
            ResolvedAttachment(str(path), path.name, 7, "text/plain")
        ])
        second = self.store.history(self.conversation["id"], limit=2)[0].data["attachments"][0]
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["size"], 6)
        self.assertEqual((await self.client.get(f"/files/{first['id']}/content")).content, b"changed")

    async def test_file_disappearing_after_preflight_does_not_fail_text_delivery(self):
        path = self.root / "gone.txt"
        path.write_bytes(b"done")
        accepted = ResolvedAttachment(str(path), path.name, 4, "text/plain")
        path.unlink()
        self.gateway.on_human(self.conversation["id"], "The file moved", [accepted])
        self.assertIsNone(self.gateway.failure)
        message = self.store.history(self.conversation["id"], limit=2)[0]
        self.assertEqual(message.data["text"], "The file moved")
        metadata = await self.client.get(f"/files/{message.data['attachments'][0]['id']}")
        self.assertEqual((metadata.status_code, metadata.json()["available"]), (200, False))

    async def test_stream_start_cancellation_closes_fd_before_body_iteration(self):
        path = self.root / "cancel.txt"
        path.write_bytes(b"content")
        fd = os.open(path, os.O_RDONLY)

        async def unread_body():
            self.fail("response body must not be consumed before response.start")
            yield b"unexpected"

        async def cancelled_send(message):
            self.assertEqual(message["type"], "http.response.start")
            raise asyncio.CancelledError()

        async def receive():
            return {"type": "http.disconnect"}

        response = _OpenedFileResponse(unread_body(), fd)
        scope = {"type": "http", "asgi": {"spec_version": "2.4"}}
        with self.assertRaises(asyncio.CancelledError):
            await response(scope, receive, cancelled_send)
        with self.assertRaises(OSError):
            os.fstat(fd)

    async def test_message_and_file_rows_roll_back_together_on_insert_failure(self):
        one = self.root / "one.png"
        two = self.root / "blocked.txt"
        one.write_bytes(b"one")
        two.write_bytes(b"two")
        self.store._connection.execute("""
            CREATE TRIGGER reject_file BEFORE INSERT ON files
            WHEN NEW.name = 'blocked.txt' BEGIN SELECT RAISE(FAIL, 'blocked'); END
        """)
        attachments = [ResolvedAttachment(str(one), one.name, 3, "image/png"),
                       ResolvedAttachment(str(two), two.name, 3, "text/plain")]
        before = self.store.last_seq()
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.append_agent_message(
                self.conversation["id"], self.conversation["id"], "text", None, attachments,
                ui=[{"block": 0, "valid": True}], ui_files={0: {str(one)}},
            )
        self.assertEqual(self.store.last_seq(), before)
        self.assertEqual([e.type for e in self.store.history(self.conversation["id"])], ["conversation.created"])
        self.assertEqual(self.store._connection.execute("SELECT COUNT(*) FROM files").fetchone()[0], 0)
