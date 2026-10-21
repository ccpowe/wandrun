"""Authenticated message-local resources remain scoped even when their bytes are cached."""

import asyncio
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.rich_media import ImageProxy, MediaCache, MediaData
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore


class MessageMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.store = GatewayStore(root / "gateway.sqlite")
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog(main_agent="main", agents={
            "main": AgentDefinition(description="Test", system_prompt="Test", model="offline", environment="local"),
        }))
        self.gateway = Gateway(self.store)
        self.cache = MediaCache(root / "rich-media")
        self.gateway.image_proxy = ImageProxy(self.cache)
        self.addAsyncCleanup(self.gateway.image_proxy.aclose)
        self.conversation = self.store.create_conversation("Media", "main")[0]["id"]
        self.other = self.store.create_conversation("Other", "main")[0]["id"]
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(self.gateway, "secret")),
                                       base_url="http://gateway", headers={"Authorization": "Bearer secret"})
        self.addAsyncCleanup(self.client.aclose)
        self.url = "https://images.example.org/photo.png?signature=private"
        output = io.BytesIO()
        Image.new("RGB", (3, 2), (10, 20, 30)).save(output, format="PNG")
        self.png = output.getvalue()
        self.cache.put("image-v1-" + hashlib.sha256(self.url.encode()).hexdigest(),
                       MediaData(self.png, "image/png", 3, 2))

    def message(self, text, **extra):
        return self.store.append(self.conversation, "message.agent", {"text": text, **extra})[0]

    def location(self, event, block="markdown", element="image", index=0, conversation=None):
        return f"/conversations/{conversation or self.conversation}/messages/{event.seq}/media/{block}/{element}/{index}"

    def ui(self, kind, props, **extra):
        spec = {"root": "media", "elements": {"media": {"type": kind, "props": props, "children": []}}, "state": {}}
        return self.message("```wandrun-ui\n" + json.dumps(spec) + "\n```", **extra)

    async def test_cached_markdown_is_authenticated_and_conversation_scoped(self):
        event = self.message(f"![photo]({self.url})")
        path = self.location(event)
        response = await self.client.get(path)
        self.assertEqual(response.json(), {"mime": "image/png", "width": 3, "height": 2})
        content = await self.client.get(path + "/content")
        self.assertEqual(content.content, self.png)
        self.assertEqual(content.headers["cache-control"], "no-store")
        self.assertEqual(content.headers["x-content-type-options"], "nosniff")
        self.assertEqual((await self.client.get(path + "/content", headers={"Authorization": "Bearer wrong"})).status_code, 401)
        self.assertEqual((await self.client.get(self.location(event, conversation=self.other))).status_code, 404)
        self.assertEqual((await self.client.get(path, params={"url": self.url})).status_code, 400)
        self.assertEqual((await self.client.get(path, params={"theme": "arbitrary"})).status_code, 400)

        self.assertEqual((await self.client.get(self.location(event, index=1))).status_code, 404)
        self.store.begin_delete(self.conversation, {self.conversation})
        self.assertEqual((await self.client.get(path)).status_code, 409)
        self.store.finish_delete(self.conversation)
        self.assertEqual((await self.client.get(path)).status_code, 404)

    async def test_mermaid_resource_is_not_exposed_by_image_endpoint(self):
        event = self.ui("Mermaid", {"source": "flowchart LR\n  A --> B", "title": "Flow"})
        for path in (self.location(event, "0", "media"),
                     self.location(event, "0", "media") + "/content"):
            response = await self.client.get(path)
            self.assertEqual(response.status_code, 404)
            self.assertEqual(response.json()["error"]["code"], "media_not_found")

    async def test_only_valid_media_nodes_authorize_cached_urls(self):
        for kind, props, index in (
            ("Image", {"url": self.url, "alt": "photo"}, 0),
            ("MediaCard", {"url": self.url, "alt": "photo", "title": "Phone"}, 0),
            ("Gallery", {"items": [{"url": "https://other.example.org/image", "alt": "other"},
                                   {"url": self.url, "alt": "photo"}]}, 1),
        ):
            with self.subTest(kind=kind):
                event = self.ui(kind, props)
                self.assertEqual((await self.client.get(self.location(event, "0", "media", index) + "/content")).content, self.png)
        rejected = [
            self.ui("Image", {"url": self.url, "attachment": "also.png", "alt": "ambiguous"}),
            self.ui("Text", {"text": self.url}),
            self.ui("Image", {"url": self.url, "alt": "rejected"}, ui=[{"block": 0, "valid": False}]),
        ]
        for event in rejected:
            self.assertEqual((await self.client.get(self.location(event, "0", "media"))).status_code, 404)
        prose = self.message(self.url + "\n```md\n![code](" + self.url + ")\n```")
        self.assertEqual((await self.client.get(self.location(prose))).status_code, 404)
        user = self.store.append(self.conversation, "message.user", {"text": f"![user]({self.url})"})[0]
        self.assertEqual((await self.client.get(self.location(user))).status_code, 404)

    async def test_delete_while_acquiring_resource_does_not_publish_bytes(self):
        event = self.message(f"![photo]({self.url})")
        entered, release = asyncio.Event(), asyncio.Event()
        original = self.gateway.image_proxy.get

        async def delayed(url):
            entered.set()
            await release.wait()
            return await original(url)

        with patch.object(self.gateway.image_proxy, "get", side_effect=delayed):
            pending = asyncio.create_task(self.client.get(self.location(event) + "/content"))
            await entered.wait()
            self.store.begin_delete(self.conversation, {self.conversation})
            self.store.finish_delete(self.conversation)
            release.set()
            self.assertEqual((await pending).status_code, 404)

    async def test_private_markdown_source_is_refused_not_redirected_to_client(self):
        event = self.message("![private](http://127.0.0.1/private.png)")
        response = await self.client.get(self.location(event) + "/content")
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("location", response.headers)
        self.assertNotIn("127.0.0.1", response.text)
