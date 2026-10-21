"""Synthetic credentials exercise real request/recovery boundaries, never real login."""

import asyncio
import base64
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import httpx

from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.subscription import SubscriptionData
from wandrun.integrations.codex_credentials import CodexCredentials, CredentialError
from wandrun.integrations.codex_subscription import CodexSubscriptionModel, CodexSubscriptionHTTPError
from wandrun.integrations.image_generation import generate_image, ImageGenerationError
from codex_test_home import assert_isolated_codex_home, isolate_codex_home



def token(tag):
    claims = {"sub": "synthetic-owner", "exp": time.time() + 3600,
              "https://api.openai.com/auth": {"chatgpt_account_id": "synthetic-account",
                                              "chatgpt_user_id": "synthetic-owner"}}
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"synthetic.{encoded}.{tag}"


def events(*items):
    return "".join("data: " + json.dumps(item) + "\n\n" for item in items).encode()


COMPLETED = {"type": "response.completed", "response": {"status": "completed", "output": []}}


class AuthRequestTests(unittest.IsolatedAsyncioTestCase):
    def test_isolates_original_codex_home(self):
        assert_isolated_codex_home(self, self.original_home)

    def setUp(self):
        self.original_home = Path(os.environ["HOME"])
        isolate_codex_home(self)
        directory = tempfile.TemporaryDirectory(prefix="codex-auth-requests-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.home = self.root / "gateway-login"
        self.home.mkdir()
        self.old, self.new = token("old"), token("new")
        self.auth = {"auth_mode": "chatgpt", "tokens": {
            "access_token": self.old, "refresh_token": "synthetic-refresh", "account_id": "synthetic-account",
            "id_token": token("identity"),
        }}
        self.write_login()
        self.refreshes = []
        self.refresh_status = 200
        self.refresh_payload = {
            "access_token": self.new, "refresh_token": "synthetic-rotated",
            "id_token": token("identity"),
        }
        self.credentials = CodexCredentials.gateway(self.home, _transport=httpx.MockTransport(self.refresh))
        self.addAsyncCleanup(self.credentials.aclose)
        self.model = CodexSubscriptionModel(credentials=self.credentials)
        self.body = {"model": "offline", "stream": True, "tools": []}
        self.real_client = httpx.AsyncClient

    def write_login(self):
        (self.home / "auth.json").write_text(json.dumps(self.auth))

    def refresh(self, request):
        self.refreshes.append(json.loads(request.content))
        return httpx.Response(self.refresh_status, json=self.refresh_payload)

    def provider(self, handler):
        return patch("wandrun.integrations.codex_subscription.httpx.AsyncClient",
                     side_effect=lambda **kw: self.real_client(transport=httpx.MockTransport(handler), **kw))

    async def test_model_header_401_refreshes_once_and_replays_with_new_token(self):
        requests = []
        def handle(request):
            requests.append(request.headers["authorization"])
            return httpx.Response(401) if len(requests) == 1 else httpx.Response(200, content=events(COMPLETED))
        with self.provider(handle):
            result = [event async for event in self.model._arequest(self.body)]
        self.assertEqual(result, [COMPLETED])
        self.assertEqual(requests, ["Bearer " + self.old, "Bearer " + self.new])
        self.assertEqual(len(self.refreshes), 1)
        self.assertEqual(self.credentials.status()["status"], "ready")

    async def test_second_model_401_latches_reauth_without_third_request(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(401)
        with self.provider(handle):
            with self.assertRaises(CodexSubscriptionHTTPError):
                _ = [event async for event in self.model._arequest(self.body)]
            with self.assertRaises(CredentialError):
                _ = [event async for event in self.model._arequest(self.body)]
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(self.refreshes), 1)
        self.assertEqual(self.credentials.status()["status"], "reauth_required")

    async def test_started_stream_reports_rejection_without_replay(self):
        requests = []
        error = {"type": "error", "error": {"code": "invalid_token"}}
        def handle(request):
            requests.append(request)
            return httpx.Response(200, content=events({"type": "response.created"}, error))
        with self.provider(handle):
            result = [event async for event in self.model._arequest(self.body)]
        self.assertEqual(result[-1], error)
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.refreshes, [])
        self.assertEqual(self.credentials.status()["status"], "refresh_due")

    async def test_image_header_401_is_never_replayed(self):
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(401)
        with self.provider(handle):
            with self.assertRaises(ImageGenerationError):
                await generate_image("synthetic prompt", credentials=self.credentials)
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.refreshes, [])
        self.assertEqual(self.credentials.status()["status"], "refresh_due")

    async def test_sync_model_401_obeys_same_single_recovery_boundary(self):
        requests = []
        def respond(request, **kwargs):
            requests.append(request.get_header("Authorization"))
            if len(requests) == 1:
                raise HTTPError(request.full_url, 401, "rejected", {}, io.BytesIO(b"{}"))
            return io.BytesIO(events(COMPLETED))
        with patch("wandrun.integrations.codex_subscription.urlopen", side_effect=respond):
            result = await asyncio.to_thread(lambda: list(self.model._request(self.body)))
        self.assertEqual(result, [COMPLETED])
        self.assertEqual(requests, ["Bearer " + self.old, "Bearer " + self.new])
        self.assertEqual(len(self.refreshes), 1)

    async def test_quota_status_preserves_history_but_not_false_ready(self):
        store = GatewayStore(self.root / "gateway.sqlite")
        self.addCleanup(store.close)
        status = 200
        requests = []
        def handle(request):
            requests.append(request)
            return httpx.Response(status, json={"plan_type": "plus", "rate_limit": {"allowed": True}})
        subscription = SubscriptionData(store, credentials=self.credentials, transport=httpx.MockTransport(handle))
        self.addAsyncCleanup(subscription.aclose)
        gateway = Gateway(store, subscription)
        async with self.real_client(transport=httpx.ASGITransport(app=create_app(gateway, "dev")), base_url="http://local", headers={"Authorization": "Bearer dev"}) as client:
            good = (await client.get("/usage/subscription?refresh=true")).json()
            self.assertEqual(good["auth"]["status"], "ready")
            status = 503
            transient = (await client.get("/usage/subscription?refresh=true")).json()
            self.assertEqual(transient["usage"], good["usage"])
            self.assertEqual(transient["auth"]["status"], "temporarily_unavailable")
            status = 401
            self.refresh_status = 400
            self.refresh_payload = {"error": "refresh_token_reused"}
            rejected = await client.get("/usage/subscription?refresh=true")
            self.assertEqual(rejected.status_code, 200)
            rejected = rejected.json()
            self.assertEqual(rejected["usage"], good["usage"])
            self.assertEqual(rejected["auth"]["status"], "reauth_required")
            self.assertIn(str(self.home), rejected["auth"]["login_command"])
            count = len(requests)
            await client.get("/usage/subscription?refresh=true")
            self.assertEqual(len(requests), count)
            self.assertEqual(len(self.refreshes), 1)
            self.auth["tokens"]["access_token"] = token("relogin")
            self.auth["tokens"]["refresh_token"] = "synthetic-relogin"
            self.write_login()
            status = 200
            restored = (await client.get("/usage/subscription?refresh=true")).json()
            self.assertEqual(restored["auth"]["status"], "ready")
            self.assertEqual((await client.get("/usage/subscription", headers={"Authorization": "wrong"})).status_code, 401)

    async def test_catalog_401_recovery_uses_shared_owner(self):
        store = GatewayStore(self.root / "gateway.sqlite")
        self.addCleanup(store.close)
        requests = []
        def handle(request):
            requests.append(request.headers["authorization"])
            return httpx.Response(401) if len(requests) == 1 else httpx.Response(200, json={"models": []})
        subscription = SubscriptionData(store, credentials=self.credentials, transport=httpx.MockTransport(handle))
        self.addAsyncCleanup(subscription.aclose)
        self.assertEqual((await subscription.models())["models"], [])
        self.assertEqual(requests, ["Bearer " + self.old, "Bearer " + self.new])
        self.assertEqual(len(self.refreshes), 1)
