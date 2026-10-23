"""Count actual HTTP sends, including aiohttp's retry after a dropped response."""

import asyncio
import io
import socket
import tempfile
import unittest
from collections import Counter
from pathlib import Path
from unittest.mock import patch

import aiohttp.connector
from PIL import Image

from wandrun.gateway.rich_media import ImageProxy, MediaCache, MediaError


class HttpSendBudgetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proxy = ImageProxy(MediaCache(Path(self.temp.name)))
        self.received = []
        self.counts = Counter()
        self.disconnect_first = False
        image = Image.new("RGB", (12, 8), (255, 30, 45))
        output = io.BytesIO()
        image.save(output, format="PNG")
        self.image = output.getvalue()
        self.peer = await asyncio.start_server(self.respond, "127.0.0.1", 0)
        self.port = self.peer.sockets[0].getsockname()[1]
        self.loop = asyncio.get_running_loop()
        self.original_connect = aiohttp.connector.aiohappyeyeballs.start_connection
        self.dns_patch = patch.object(self.loop, "getaddrinfo", self.public_dns)
        self.connect_patch = patch("aiohttp.connector.aiohappyeyeballs.start_connection", self.reroute_socket)
        self.dns_patch.start()
        self.connect_patch.start()
        self.addCleanup(self.dns_patch.stop)
        self.addCleanup(self.connect_patch.stop)

    async def asyncTearDown(self):
        await self.proxy.aclose()
        self.peer.close()
        await self.peer.wait_closed()

    def url(self, path):
        return f"http://example.test/{path}"

    async def public_dns(self, host, port, *, type):
        self.assertEqual((host, port, type), ("example.test", 80, socket.SOCK_STREAM))
        return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("8.8.8.8", port))]

    async def reroute_socket(self, *args, **kwargs):
        # Keep production's DNS/policy validation intact; divert only its pinned
        # public connection to this raw peer after the addresses have been checked.
        self.assertEqual([info[4][0] for info in kwargs["addr_infos"]], ["8.8.8.8"])
        kwargs["addr_infos"] = [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", self.port))
        ]
        return await self.original_connect(*args, **kwargs)

    async def respond(self, reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            method, path, _ = headers.split(b"\r\n", 1)[0].decode("ascii").split(" ")
            self.assertEqual(method, "GET")
            self.assertIn(b"\r\nHost: example.test\r\n", headers)
            self.received.append(path)
            self.counts[path] += 1
            if self.disconnect_first and self.counts[path] == 1:
                # No response headers: aiohttp retries this idempotent GET internally.
                return
            resource, _, hop_text = path.lstrip("/").partition("/")
            hop = int(hop_text)
            self.assertEqual(resource, "image")
            if hop < 3:
                status = b"302 Found"
                body = b""
                extra_headers = f"Location: /{resource}/{hop + 1}\r\n".encode("ascii")
            else:
                self.assertEqual(hop, 3)
                status = b"200 OK"
                body = self.image
                extra_headers = b"Content-Type: image/png\r\n"
            writer.write(b"HTTP/1.1 " + status + b"\r\n" + extra_headers
                         + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode("ascii") + body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_image_budget_counts_disconnected_gets_before_next_redirect(self):
        self.disconnect_first = True
        with self.assertRaises(MediaError) as failure:
            await self.proxy.get(self.url("image/0"))
        self.assertEqual(failure.exception.code, "media_redirect")
        self.assertEqual(self.received, ["/image/0", "/image/0", "/image/1", "/image/1"])
        self.assertLessEqual(len(self.received), 4)

    async def test_three_redirects_still_succeed_for_image(self):
        result = await self.proxy.get(self.url("image/0"))
        self.assertEqual((result.mime, result.width, result.height), ("image/jpeg", 12, 8))
        self.assertEqual(self.received, [
            "/image/0", "/image/1", "/image/2", "/image/3",
        ])
