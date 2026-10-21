"""GitHub device authorization at the integration/store boundary, without the network."""

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs

import httpx

from wandrun.config import AgentCatalog
from wandrun.gateway.store import GatewayStore
from wandrun.integrations import mcp_oauth
from wandrun.integrations.mcp_oauth import (
    ConnectorOAuth, GITHUB_CLIENT_ID, GITHUB_MCP_URL, OAuthIssue, OAuthUnavailable,
)


DEVICE = "https://github.com/login/device"
CODE = DEVICE + "/code"
TOKEN = "https://github.com/login/oauth/access_token"


def issued(device_code="private-device-code", interval=1, expires_in=900):
    return httpx.Response(200, json={
        "device_code": device_code, "user_code": "ABCD-1234",
        "verification_uri": DEVICE, "expires_in": expires_in, "interval": interval,
    })


def granted(access="access-one", refresh="refresh-one"):
    return httpx.Response(200, json={
        "access_token": access, "refresh_token": refresh, "token_type": "bearer",
        "expires_in": 3600, "scope": "repo,read:org,offline_access",
    })


class GitHubDeviceOAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "gateway.sqlite"
        self.store = GatewayStore(self.path)
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog(None, {}), {
            "github": {"id": "github", "name": "GitHub", "description": "Official MCP",
                       "url": GITHUB_MCP_URL, "transport": "streamable-http",
                       "auth_type": "oauth", "app_id": "github"},
            "custom": {"id": "custom", "name": "Custom", "description": "Not the app",
                       "url": GITHUB_MCP_URL, "transport": "streamable-http", "auth_type": "oauth"},
        })
        self.owner = ConnectorOAuth(self.store, port=8765)
        self.addAsyncCleanup(self.owner.aclose)
        self.real_client = httpx.AsyncClient
        self.requests = []
        self.waits = []

    def transport(self, handler):
        async def capture(request):
            self.requests.append(request)
            result = handler(request)
            if asyncio.iscoroutine(result):
                return await result
            return result
        return patch.object(mcp_oauth.httpx2, "AsyncClient", side_effect=lambda **kw: self.real_client(
            transport=httpx.MockTransport(capture), **kw,
        ))

    def fast_poll(self):
        async def wait(pending, interval):
            self.waits.append(interval)
            await asyncio.sleep(0)
            return pending.stop.is_set()
        return patch.object(self.owner, "_device_wait", side_effect=wait)

    async def finish(self):
        await asyncio.gather(*tuple(self.owner._auth_tasks))

    async def authorize(self):
        def handle(request):
            if str(request.url) == CODE:
                return issued()
            if str(request.url) == TOKEN:
                return granted()
            raise AssertionError(str(request.url))
        with self.transport(handle), self.fast_poll():
            start = await self.owner.start_github("github", GITHUB_MCP_URL)
            await self.finish()
        return start

    async def test_fixed_catalog_binding_issue_pending_slowdown_and_durable_grant(self):
        steps = iter(("authorization_pending", "slow_down", "authorization_pending", None))
        def handle(request):
            form = parse_qs(request.content.decode())
            self.assertEqual(request.headers["accept"], "application/json")
            if str(request.url) == CODE:
                self.assertEqual(form, {"client_id": [GITHUB_CLIENT_ID],
                                        "scope": ["repo read:org offline_access"]})
                return issued(interval=2)
            self.assertEqual(str(request.url), TOKEN)
            self.assertEqual(form, {"client_id": [GITHUB_CLIENT_ID],
                                    "device_code": ["private-device-code"],
                                    "grant_type": ["urn:ietf:params:oauth:grant-type:device_code"]})
            error = next(steps)
            return httpx.Response(200, json={"error": error}) if error else granted()
        with self.transport(handle), self.fast_poll():
            with self.assertRaises(OAuthIssue):
                await self.owner.start_github("custom", GITHUB_MCP_URL)
            with self.assertRaises(OAuthIssue):
                await self.owner.start_github("github", GITHUB_MCP_URL.rstrip("/"))
            start = await self.owner.start_github("github", GITHUB_MCP_URL)
            self.assertEqual(start["flow"], "device_code")
            self.assertEqual(start["authorization_url"], DEVICE)
            self.assertEqual(start["user_code"], "ABCD-1234")
            self.assertGreater(start["expires_at"], time.time())
            self.assertEqual(set(start), {"flow", "authorization_url", "user_code", "expires_at"})
            await self.finish()
        self.assertEqual(self.waits, [2, 2, 7, 7])
        generation, record = self.store.oauth_record("github")
        self.assertEqual(generation, 1)
        self.assertEqual(record["provider"], "github_device")
        self.assertNotIn("redirect", record)
        self.assertNotIn("device_code", record)
        self.assertEqual(record["tokens"]["scope"], "repo read:org offline_access")
        self.assertIn("private-device-code", self.owner.secret_values("github"))
        self.assertTrue(self.owner.authorized("github", generation, GITHUB_MCP_URL))
        self.assertFalse(self.owner.authorized("github", generation, GITHUB_MCP_URL + "other"))
        self.assertEqual(self.owner.status("github", "oauth"), {
            "status": "authorized", "authorizing": False,
            "scopes": ["repo", "read:org", "offline_access"],
        })
        public = json.dumps([start, self.owner.status("github", "oauth"),
                             [event.to_dict() for event in self.store.after(0)]])
        for secret in ("private-device-code", "access-one", "refresh-one"):
            self.assertNotIn(secret, public)

    async def test_denial_expiry_and_http_200_errors_are_safe_and_new_start_clears_error(self):
        for error, expected in (("access_denied", "oauth_denied"),
                                ("expired_token", "oauth_expired"),
                                ("token_expired", "oauth_expired"),
                                ("incorrect_client_credentials", "oauth_unavailable")):
            with self.subTest(error=error):
                with self.transport(lambda request: issued() if str(request.url) == CODE else
                                    httpx.Response(200, json={"error": error,
                                                              "error_description": "secret-from-provider"})), self.fast_poll():
                    await self.owner.start_github("github", GITHUB_MCP_URL)
                    await self.finish()
                snapshot = self.owner.status("github", "oauth")
                self.assertFalse(snapshot["authorizing"])
                self.assertEqual(snapshot["error"]["code"], expected)
                self.assertNotIn("secret-from-provider", json.dumps(snapshot))
                self.assertIsNone(self.store.oauth_record("github")[1])
        with self.transport(lambda request: issued() if str(request.url) == CODE else
                            httpx.Response(200, json={"error": "authorization_pending"})):
            start = await self.owner.start_github("github", GITHUB_MCP_URL)
            self.assertEqual(start["flow"], "device_code")
            self.assertNotIn("error", self.owner.status("github", "oauth"))
            self.owner.cancel("github")
            await self.finish()
        with self.transport(lambda request: httpx.Response(200, json={"error": "bad_verification_code"})):
            with self.assertRaises(OAuthIssue) as issue:
                await self.owner.start_github("github", GITHUB_MCP_URL)
            self.assertEqual(issue.exception.code, "oauth_unavailable")

    async def test_untrusted_verification_uri_and_http_failures_never_publish_a_code(self):
        for reply in (httpx.Response(200, json={
            "device_code": "secret", "user_code": "PUBLIC", "interval": 5, "expires_in": 900,
            "verification_uri": "https://not-github.example/device",
        }), httpx.Response(503)):
            with self.subTest(status=reply.status_code), self.transport(lambda request: reply):
                with self.assertRaises(OAuthIssue) as issue:
                    await self.owner.start_github("github", GITHUB_MCP_URL)
                self.assertEqual(issue.exception.code, "oauth_unavailable")
                self.assertFalse(self.owner.status("github", "oauth")["authorizing"])
        self.assertEqual([str(request.url) for request in self.requests], [CODE, CODE])

    async def test_local_deadline_expires_without_an_extra_exchange(self):
        async def elapsed(pending, interval):
            self.assertGreaterEqual(interval, 1)
            pending.expires_at = time.time() - 1
            return False
        with self.transport(lambda request: issued(expires_in=1)), patch.object(
            self.owner, "_device_wait", side_effect=elapsed,
        ):
            started = await self.owner.start_github("github", GITHUB_MCP_URL)
            self.assertGreater(started["expires_at"], time.time())
            await self.finish()
        self.assertEqual([str(request.url) for request in self.requests], [CODE])
        self.assertEqual(self.owner.status("github", "oauth")["error"]["code"], "oauth_expired")

    async def test_cancelled_start_waiter_and_cancelled_pending_preserve_completed_exchange(self):
        issue_started, issue_release = asyncio.Event(), asyncio.Event()
        exchanged, exchange_release = asyncio.Event(), asyncio.Event()
        async def handle(request):
            if str(request.url) == CODE:
                issue_started.set()
                await issue_release.wait()
                return issued()
            exchanged.set()
            await exchange_release.wait()
            return granted()
        with self.transport(handle), self.fast_poll():
            waiter = asyncio.create_task(self.owner.start_github("github", GITHUB_MCP_URL))
            await asyncio.wait_for(issue_started.wait(), 5)
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            issue_release.set()
            await asyncio.wait_for(exchanged.wait(), 5)
            self.owner.cancel("github")
            self.assertFalse(self.owner.status("github", "oauth")["authorizing"])
            exchange_release.set()
            await self.finish()
        generation, record = self.store.oauth_record("github")
        self.assertEqual(record["tokens"]["access_token"], "access-one")
        self.assertTrue(self.owner.authorized("github", generation, GITHUB_MCP_URL))

    async def test_replacement_and_revocation_fence_old_exchange(self):
        old_exchange, old_release = asyncio.Event(), asyncio.Event()
        sequence = 0
        async def handle(request):
            nonlocal sequence
            if str(request.url) == CODE:
                sequence += 1
                return issued(f"device-{sequence}")
            code = parse_qs(request.content.decode())["device_code"][0]
            if code == "device-1":
                old_exchange.set()
                await old_release.wait()
                return granted("stale-access", "stale-refresh")
            return granted("new-access", "new-refresh")
        with self.transport(handle), self.fast_poll():
            await self.owner.start_github("github", GITHUB_MCP_URL)
            await asyncio.wait_for(old_exchange.wait(), 5)
            await self.owner.start_github("github", GITHUB_MCP_URL)
            old_release.set()
            await self.finish()
        generation, record = self.store.oauth_record("github")
        self.assertEqual(record["tokens"]["access_token"], "new-access")
        self.assertFalse(self.store.save_oauth("github", generation - 1, record))
        exchange, release = asyncio.Event(), asyncio.Event()
        async def delayed(request):
            if str(request.url) == CODE:
                return issued()
            exchange.set()
            await release.wait()
            return granted("revoked-access", "revoked-refresh")
        with self.transport(delayed), self.fast_poll():
            await self.owner.start_github("github", GITHUB_MCP_URL)
            await asyncio.wait_for(exchange.wait(), 5)
            self.assertIsNone(await self.owner.revoke("github", close=lambda identity: asyncio.sleep(0)))
            release.set()
            await self.finish()
        self.assertIsNone(self.store.oauth_record("github")[1])
        self.assertFalse(self.owner.authorized("github", generation, GITHUB_MCP_URL))

    async def test_cold_refresh_single_flight_cancellation_http_200_bad_refresh_and_local_revoke(self):
        await self.authorize()
        self.requests.clear()
        generation, record = self.store.oauth_record("github")
        self.assertTrue(self.store.save_oauth("github", generation, {**record, "expires_at": time.time() - 1}))
        reopened = GatewayStore(self.path)
        self.addCleanup(reopened.close)
        cold = ConnectorOAuth(reopened, port=9000, public_url="https://other.example")
        self.addAsyncCleanup(cold.aclose)
        started, release = asyncio.Event(), asyncio.Event()
        async def handle(request):
            self.assertEqual(str(request.url), TOKEN)
            self.assertEqual(request.headers["accept"], "application/json")
            self.assertEqual(parse_qs(request.content.decode()), {
                "grant_type": ["refresh_token"], "refresh_token": ["refresh-one"],
                "client_id": [GITHUB_CLIENT_ID],
            })
            started.set()
            await release.wait()
            return granted("access-two", "refresh-two")
        with self.transport(handle):
            waiter = asyncio.create_task(cold.token("github", generation, GITHUB_MCP_URL))
            await asyncio.wait_for(started.wait(), 5)
            joined = asyncio.create_task(cold.token("github", generation, GITHUB_MCP_URL))
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            release.set()
            self.assertEqual(await joined, "access-two")
        self.assertEqual(len([request for request in self.requests if str(request.url) == TOKEN]), 1)
        current_generation, rotated = self.store.oauth_record("github")
        self.assertEqual(current_generation, generation)
        self.assertEqual(rotated["tokens"]["refresh_token"], "refresh-two")
        self.assertEqual(await cold.token("github", generation, GITHUB_MCP_URL), "access-two")
        self.store.save_oauth("github", generation, {**rotated, "expires_at": time.time() - 1})
        with self.transport(lambda request: httpx.Response(200, json={"error": "bad_refresh_token"})):
            with self.assertRaises(OAuthUnavailable):
                await cold.token("github", generation, GITHUB_MCP_URL)
        self.assertEqual(cold.status("github", "oauth")["status"], "reauthorization_required")
        self.assertFalse(self.store.save_oauth("github", generation, rotated))
        self.assertIsNone(await cold.revoke("github", close=lambda identity: asyncio.sleep(0)))

    async def test_revoke_during_github_refresh_cannot_restore_rotated_credentials(self):
        await self.authorize()
        generation, record = self.store.oauth_record("github")
        self.store.save_oauth("github", generation, {**record, "expires_at": time.time() - 1})
        rotated, release = asyncio.Event(), asyncio.Event()
        async def handle(request):
            rotated.set()
            await release.wait()
            return granted("late-access", "late-refresh")
        with self.transport(handle):
            refreshing = asyncio.create_task(self.owner.token("github", generation, GITHUB_MCP_URL))
            await asyncio.wait_for(rotated.wait(), 5)
            self.assertIsNone(await self.owner.revoke(
                "github", close=lambda identity: asyncio.sleep(0),
            ))
            release.set()
            with self.assertRaises(OAuthUnavailable):
                await refreshing
        self.assertIsNone(self.store.oauth_record("github")[1])

    async def test_old_credential_expiry_does_not_discard_replacement_device_grant(self):
        for missing_refresh, cancelled in ((True, False), (False, False), (True, True), (False, True)):
            with self.subTest(missing_refresh=missing_refresh, cancelled=cancelled):
                await self.authorize()
                generation, record = self.store.oauth_record("github")
                tokens = dict(record["tokens"])
                if missing_refresh:
                    tokens.pop("refresh_token")
                self.store.save_oauth("github", generation, {
                    **record, "tokens": tokens, "expires_at": time.time() - 1,
                })
                exchanging, release = asyncio.Event(), asyncio.Event()

                async def handle(request):
                    if str(request.url) == CODE:
                        return issued()
                    grant = parse_qs(request.content.decode())["grant_type"][0]
                    if grant == "refresh_token":
                        return httpx.Response(200, json={"error": "bad_refresh_token"})
                    exchanging.set()
                    await release.wait()
                    return granted("replacement-access", "replacement-refresh")

                with self.transport(handle), self.fast_poll():
                    await self.owner.start_github("github", GITHUB_MCP_URL)
                    await asyncio.wait_for(exchanging.wait(), 5)
                    if cancelled:
                        self.owner.cancel("github")
                        self.assertFalse(self.owner.status("github", "oauth")["authorizing"])
                    with self.assertRaises(OAuthUnavailable):
                        await self.owner.token("github", generation, GITHUB_MCP_URL)
                    release.set()
                    await self.finish()
                replacement_generation, replacement = self.store.oauth_record("github")
                self.assertEqual(replacement["tokens"]["access_token"], "replacement-access")
                self.assertTrue(self.owner.authorized("github", replacement_generation, GITHUB_MCP_URL))
                self.assertFalse(self.owner.authorized("github", generation, GITHUB_MCP_URL))
