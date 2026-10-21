"""Offline subscription catalog and quota behavior against the actual parser/cache."""

import asyncio
import base64
import json
import tempfile
from contextlib import closing
from pathlib import Path
import unittest
from unittest.mock import patch

import httpx

from wandrun.gateway.store import GatewayStore
from wandrun.gateway.subscription import SubscriptionData, SubscriptionUnavailable
from codex_test_home import isolate_codex_home



class SnapshotStore:
    def __init__(self):
        self.data = {}
        self.fail_save = False

    def load_subscription_snapshot(self, kind, identity, version):
        return self.data.get((kind, identity, version))

    def save_subscription_snapshot(self, kind, identity, version, snapshot):
        if self.fail_save:
            raise OSError("database unavailable")
        # Simulate JSON persistence rather than accidentally sharing mutable response objects.
        self.data[(kind, identity, version)] = json.loads(json.dumps(snapshot))


def model(slug, priority, visibility="list"):
    return {
        "slug": slug, "priority": priority, "visibility": visibility,
        "display_name": slug.upper(), "description": "A model",
        "default_reasoning_level": "medium",
        "supported_reasoning_levels": [
            {"effort": "medium", "description": "Balanced"},
            {"effort": "ultra", "description": "Delegation"},
        ],
        "base_instructions": "SECRET-INSTRUCTIONS",
        "user_email": "secret@example.test",
    }


class SubscriptionDataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        home = isolate_codex_home(self)
        claims = base64.urlsafe_b64encode(b"{}").decode().rstrip("=")
        self.auth = {
            "auth_mode": "chatgpt", "tokens": {
                "access_token": f"test.{claims}.test", "account_id": "account-a",
            },
        }
        self.auth_path = home / "auth.json"
        self.auth_path.write_text(json.dumps(self.auth))
        self.store = SnapshotStore()
        self.calls = []
        self.catalog = {"models": [
            model("gpt-6-sol", 3), model("hidden", 1, "hide"),
            model("gpt-6-astra", 2), model("tie", 3),
        ], "email": "secret@example.test"}
        self.quota = {
            "plan_type": "plus", "email": "secret@example.test",
            "rate_limit": {
                "allowed": True, "limit_reached": False,
                "primary_window": {"used_percent": 9, "limit_window_seconds": 604800, "reset_at": 1791949150},
                "secondary_window": None,
            },
            "additional_rate_limits": [{
                "metered_feature": "feature", "limit_name": "extra",
                "rate_limit": {"primary_window": {
                    "used_percent": 55, "limit_window_seconds": 3600, "reset_at": 1791949200,
                }},
            }],
        }
        self.status = 200
        self.error = None
        self.service = SubscriptionData(self.store, transport=httpx.MockTransport(self.respond))
        self.addAsyncCleanup(self.service.aclose)

    def respond(self, request):
        self.calls.append(request)
        self.assertEqual(request.url.host, "chatgpt.com")
        self.assertEqual(request.headers["chatgpt-account-id"], self.auth["tokens"]["account_id"])
        self.assertEqual(request.headers["accept"], "application/json")
        if self.error:
            raise self.error
        payload = self.catalog if request.url.path.endswith("/models") else self.quota
        return httpx.Response(self.status, json=payload)

    def login(self, user, *, claim="chatgpt_user_id", rotation=0):
        claims = {"https://api.openai.com/auth": {"chatgpt_account_id": "shared-workspace"}}
        if claim == "chatgpt_user_id":
            claims["https://api.openai.com/auth"][claim] = user
        else:
            claims[claim] = user
        encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        self.auth["tokens"] = {
            "account_id": "shared-workspace",
            "access_token": f"test.{encoded}.signature-{rotation}",
        }
        self.auth_path.write_text(json.dumps(self.auth))

    async def test_shared_workspace_users_cannot_reuse_memory_or_stale_snapshots(self):
        self.login("synthetic-user-a")
        original = {kind: await getattr(self.service, kind)() for kind in ("models", "usage")}
        self.login("synthetic-user-b")
        self.status = 503
        for kind in original:
            for refresh in (False, True):
                with self.subTest(kind=kind, refresh=refresh):
                    with self.assertRaises(SubscriptionUnavailable):
                        await getattr(self.service, kind)(refresh=refresh)
        self.assertEqual(len(self.calls), 6)
        self.login("synthetic-user-a", rotation=1)
        for kind, snapshot in original.items():
            self.assertEqual(await getattr(self.service, kind)(), snapshot)
        self.assertEqual(len(self.calls), 6)

    async def test_rotated_tokens_reuse_cache_for_each_stable_user_claim(self):
        for claim in ("chatgpt_user_id", "sub"):
            with self.subTest(claim=claim):
                self.login("synthetic-owner", claim=claim)
                original = {kind: await getattr(self.service, kind)() for kind in ("models", "usage")}
                calls = len(self.calls)
                self.login("synthetic-owner", claim=claim, rotation=1)
                for kind, snapshot in original.items():
                    self.assertEqual(await getattr(self.service, kind)(), snapshot)
                self.assertEqual(len(self.calls), calls)
                self.login("synthetic-other", claim=claim)
                self.status = 503
                for kind in original:
                    with self.assertRaises(SubscriptionUnavailable):
                        await getattr(self.service, kind)()
                self.status = 200

    async def test_unconfirmed_user_identity_falls_back_to_token(self):
        for user in (None, "", " ", 123, ["not-a-user"]):
            with self.subTest(user=user):
                self.login(user)
                self.status = 200
                await self.service.models()
                self.login(user, rotation=1)
                self.status = 503
                with self.assertRaises(SubscriptionUnavailable):
                    await self.service.models()

    async def test_user_switch_during_refresh_rejects_success_and_stale_fallback(self):
        for kind in ("models", "usage"):
            for status in (200, 503):
                with self.subTest(kind=kind, status=status):
                    self.login("synthetic-user-a")
                    store = SnapshotStore()
                    service = SubscriptionData(store, transport=httpx.MockTransport(self.respond))
                    self.addAsyncCleanup(service.aclose)
                    await getattr(service, kind)()
                    before = dict(store.data)
                    entered, release = asyncio.Event(), asyncio.Event()

                    async def delayed(request):
                        entered.set()
                        await release.wait()
                        return httpx.Response(status, json=self.catalog if kind == "models" else self.quota)

                    await service.aclose()
                    service = SubscriptionData(store, transport=httpx.MockTransport(delayed))
                    self.addAsyncCleanup(service.aclose)
                    pending = asyncio.create_task(getattr(service, kind)(refresh=True))
                    try:
                        await asyncio.wait_for(entered.wait(), 5)
                        self.login("synthetic-user-b")
                    finally:
                        release.set()
                    with self.assertRaises(SubscriptionUnavailable):
                        await pending
                    self.assertEqual(store.data, before)

    async def test_sqlite_restart_isolates_users_and_reuses_rotated_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gateway.sqlite"
            self.login("synthetic-user-a")
            with closing(GatewayStore(path)) as store:
                service = SubscriptionData(store, transport=httpx.MockTransport(self.respond))
                try:
                    original = {kind: await getattr(service, kind)() for kind in ("models", "usage")}
                finally:
                    await service.aclose()
            self.login("synthetic-user-b")
            self.status = 503
            with closing(GatewayStore(path)) as store:
                service = SubscriptionData(store, transport=httpx.MockTransport(self.respond))
                try:
                    for kind in original:
                        with self.assertRaises(SubscriptionUnavailable):
                            await getattr(service, kind)()
                    self.login("synthetic-user-a", rotation=1)
                    for kind, snapshot in original.items():
                        self.assertEqual(await getattr(service, kind)(refresh=True), snapshot)
                finally:
                    await service.aclose()
            database = path.read_bytes()
            for private in (b"synthetic-user-a", b"synthetic-user-b", b"shared-workspace", b"signature-"):
                self.assertNotIn(private, database)

    async def test_models_sort_hide_whitelist_and_refresh_replaces_empty(self):
        first = await self.service.models()
        self.assertEqual([entry["id"] for entry in first["models"]], [
            "gpt-6-astra", "gpt-6-sol", "tie",
        ])
        self.assertEqual(first["models"][0]["supported_reasoning_efforts"], [
            {"effort": "medium", "description": "Balanced"},
        ])
        persisted = json.dumps(list(self.store.data.values()))
        self.assertNotIn("hidden", persisted)
        self.assertNotIn("SECRET-INSTRUCTIONS", persisted)
        self.assertNotIn("secret@example.test", persisted)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0].url.params["client_version"], "0.157.1")
        self.assertEqual(await self.service.models(), first)
        self.assertEqual(len(self.calls), 1)
        self.catalog = {"models": []}
        empty = await self.service.models(refresh=True)
        self.assertEqual(empty["models"], [])
        self.assertEqual(len(self.store.data), 1)
        self.status = 503
        self.assertEqual(await self.service.models(refresh=True), empty)

    async def test_cache_ttls_are_per_resource(self):
        catalog = await self.service.models()
        quota = await self.service.usage()
        self.assertEqual(len(self.calls), 2)
        with patch("wandrun.gateway.subscription.time.time", return_value=quota["fetched_at"] + 61):
            await self.service.models()
            await self.service.usage()
        self.assertEqual(len(self.calls), 3)
        with patch("wandrun.gateway.subscription.time.time", return_value=catalog["fetched_at"] + 301):
            await self.service.models()
        self.assertEqual(len(self.calls), 4)

    async def test_malformed_catalog_returns_last_success(self):
        good = await self.service.models()
        self.catalog = {"models": "not a catalog"}
        self.assertEqual(await self.service.models(refresh=True), good)

    async def test_ultra_catalog_default_is_displayable_without_offering_ultra(self):
        cases = (
            (("low", "max", "ultra"), "max"),
            (("low", "xhigh", "ultra"), "xhigh"),
            (("ultra",), "medium"),
        )
        for levels, expected in cases:
            with self.subTest(levels=levels):
                entry = model("candidate", 1)
                entry["default_reasoning_level"] = "ultra"
                entry["supported_reasoning_levels"] = [
                    {"effort": level, "description": level} for level in levels
                ]
                self.catalog = {"models": [entry]}
                response = await self.service.models(refresh=True)
                self.assertEqual(response["models"][0]["default_reasoning_effort"], expected)
                self.assertEqual(
                    [item["effort"] for item in response["models"][0]["supported_reasoning_efforts"]],
                    [level for level in levels if level != "ultra"],
                )

    async def test_stale_snapshot_survives_restart_but_not_identity_or_version(self):
        original = await self.service.models()
        self.status = 503
        self.assertEqual(await self.service.models(refresh=True), original)
        restarted = SubscriptionData(self.store, transport=httpx.MockTransport(self.respond))
        self.addAsyncCleanup(restarted.aclose)
        self.assertEqual(await restarted.models(refresh=True), original)
        self.auth["tokens"]["account_id"] = "account-b"
        self.auth_path.write_text(json.dumps(self.auth))
        with self.assertRaises(SubscriptionUnavailable) as error:
            await restarted.models(refresh=True)
        self.assertEqual(error.exception.code, "model_catalog_unavailable")
        self.auth["tokens"]["account_id"] = "account-a"
        self.auth_path.write_text(json.dumps(self.auth))
        other_version = SubscriptionData(
            self.store, client_version="0.160.0", transport=httpx.MockTransport(self.respond),
        )
        self.addAsyncCleanup(other_version.aclose)
        with self.assertRaises(SubscriptionUnavailable):
            await other_version.models(refresh=True)

    async def test_malformed_quota_does_not_erase_last_success(self):
        good = await self.service.usage()
        for invalid in ({}, {"rate_limit": []}, {"rate_limit": {"allowed": "yes"}},
                        {"rate_limit": {"primary_window": {"used_percent": "bad"}}}):
            with self.subTest(payload=invalid):
                self.quota = invalid
                self.assertEqual(await self.service.usage(refresh=True), good)

    async def test_identity_change_during_refresh_never_publishes_old_account(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def delayed(request):
            entered.set()
            await release.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        pending = asyncio.create_task(service.models(refresh=True))
        await asyncio.wait_for(entered.wait(), 5)
        self.auth["tokens"]["account_id"] = "account-b"
        self.auth_path.write_text(json.dumps(self.auth))
        release.set()
        with self.assertRaises(SubscriptionUnavailable) as error:
            await pending
        self.assertEqual(error.exception.code, "model_catalog_unavailable")
        self.assertEqual(self.store.data, {})

    async def test_quota_all_windows_unknown_values_and_stale_failure(self):
        first = await self.service.usage()
        self.assertEqual(first["windows"], [
            {"name": "primary", "used_percent": 9, "window_seconds": 604800, "reset_at": 1791949150},
            {"name": "extra.primary", "used_percent": 55, "window_seconds": 3600, "reset_at": 1791949200},
        ])
        self.assertEqual(first["allowed"], True)
        self.quota = {"rate_limit": {"primary_window": None}}
        unknown = await self.service.usage(refresh=True)
        self.assertEqual(unknown["windows"], [])
        self.assertIsNone(unknown["allowed"])
        self.assertIsNone(unknown["limit_reached"])
        self.assertIsNone(unknown["plan_type"])
        self.error = httpx.ConnectError("offline")
        self.assertEqual(await self.service.usage(refresh=True), unknown)
        self.store.fail_save = True
        self.error = None
        with self.assertRaisesRegex(OSError, "database unavailable"):
            await self.service.usage(refresh=True)

    async def test_initial_usage_failure_has_stable_code(self):
        self.status = 401
        with self.assertRaises(SubscriptionUnavailable) as error:
            await self.service.usage()
        self.assertEqual(error.exception.code, "subscription_usage_unavailable")

    async def test_nonforced_waiter_uses_refresh_completed_during_credential_read(self):
        entered, release_request = asyncio.Event(), asyncio.Event()
        waiting, release_credential = asyncio.Event(), asyncio.Event()
        calls = []

        async def delayed(request):
            calls.append(request)
            if len(calls) == 2:
                entered.set()
                await release_request.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        old = await service.models()
        original_aget = service.credentials.aget
        credential_reads = 0

        async def gated_aget():
            nonlocal credential_reads
            credential_reads += 1
            if credential_reads == 2:
                waiting.set()
                await release_credential.wait()
            return await original_aget()

        with patch("wandrun.gateway.subscription.time.time", return_value=old["fetched_at"] + 301):
            with patch.object(service.credentials, "aget", gated_aget):
                first = asyncio.create_task(service.models(refresh=True))
                try:
                    await asyncio.wait_for(entered.wait(), 5)
                    second = asyncio.create_task(service.models())
                    await asyncio.wait_for(waiting.wait(), 5)
                    release_request.set()
                    refreshed = await asyncio.wait_for(first, 5)
                    release_credential.set()
                    self.assertEqual(await asyncio.wait_for(second, 5), refreshed)
                    self.assertEqual(len(calls), 2)
                finally:
                    release_request.set()
                    release_credential.set()

    async def test_close_during_credential_preparation_stops_nonforced_request(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        def respond(request):
            calls.append(request)
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(respond))
        self.addAsyncCleanup(service.aclose)

        async def gated_aget():
            entered.set()
            await release.wait()
            return service.credentials.peek()

        with patch.object(service.credentials, "aget", gated_aget):
            pending = asyncio.create_task(service.models())
            try:
                await asyncio.wait_for(entered.wait(), 5)
                await service.aclose()
                release.set()
                with self.assertRaisesRegex(RuntimeError, "subscription data is closed"):
                    await asyncio.wait_for(pending, 5)
                self.assertEqual(calls, [])
            finally:
                release.set()

    async def test_forced_refresh_joins_during_credential_preparation(self):
        entered, release_request = asyncio.Event(), asyncio.Event()
        release_second_credential = asyncio.Event()
        calls = []

        async def delayed(request):
            calls.append(request)
            entered.set()
            await release_request.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        original_aget = service.credentials.aget
        credential_reads = 0

        async def gated_aget():
            nonlocal credential_reads
            credential_reads += 1
            if credential_reads == 2:
                await release_second_credential.wait()
            return await original_aget()

        second_started = asyncio.Event()

        async def second_request():
            second_started.set()
            return await service.models(refresh=True)

        with patch.object(service.credentials, "aget", gated_aget):
            first = asyncio.create_task(service.models(refresh=True))
            try:
                await asyncio.wait_for(entered.wait(), 5)
                second = asyncio.create_task(second_request())
                await second_started.wait()
                release_request.set()
                original = await asyncio.wait_for(first, 5)
                # A late second aget must not start a new GET after the first completes.
                release_second_credential.set()
                self.assertEqual(await asyncio.wait_for(second, 5), original)
                self.assertEqual(len(calls), 1)
                self.assertEqual(credential_reads, 1)
            finally:
                release_request.set()
                release_second_credential.set()

    async def test_forced_refresh_coalesces_on_identity_after_preparation(self):
        self.login("synthetic-a")
        preparing, finish_preparation = asyncio.Event(), asyncio.Event()
        request_started, finish_request = asyncio.Event(), asyncio.Event()
        calls = []

        async def delayed(request):
            calls.append(request)
            request_started.set()
            await finish_request.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        original_aget = service.credentials.aget

        async def gated_aget():
            preparing.set()
            await finish_preparation.wait()
            return await original_aget()

        with patch.object(service.credentials, "aget", gated_aget):
            first = asyncio.create_task(service.models(refresh=True))
            try:
                await asyncio.wait_for(preparing.wait(), 5)
                self.login("synthetic-b")
                finish_preparation.set()
                await asyncio.wait_for(request_started.wait(), 5)
                second_peeked = asyncio.Event()
                original_peek = service.credentials.peek

                def observed_peek():
                    second_peeked.set()
                    return original_peek()

                with patch.object(service.credentials, "peek", observed_peek):
                    second = asyncio.create_task(service.models(refresh=True))
                    await asyncio.wait_for(second_peeked.wait(), 5)
                first.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                finish_request.set()
                result = await asyncio.wait_for(second, 5)
                self.assertEqual(len(calls), 1)
                self.assertEqual(
                    calls[0].headers["authorization"], f"Bearer {self.auth['tokens']['access_token']}",
                )
                self.assertEqual(result["models"][0]["id"], "gpt-6-astra")
            finally:
                finish_preparation.set()
                finish_request.set()

    async def test_forced_refresh_joins_existing_prepared_identity_flight(self):
        self.login("synthetic-b")
        request_started, finish_request = asyncio.Event(), asyncio.Event()
        preparing, finish_preparation = asyncio.Event(), asyncio.Event()
        calls = []

        async def delayed(request):
            calls.append(request)
            request_started.set()
            await finish_request.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        original_aget = service.credentials.aget

        prepared = asyncio.Event()

        async def gated_aget():
            preparing.set()
            await finish_preparation.wait()
            credential = await original_aget()
            prepared.set()
            return credential

        owner = asyncio.create_task(service.models(refresh=True))
        try:
            await asyncio.wait_for(request_started.wait(), 5)
            self.login("synthetic-a")
            with patch.object(service.credentials, "aget", gated_aget):
                joining = asyncio.create_task(service.models(refresh=True))
                await asyncio.wait_for(preparing.wait(), 5)
                self.login("synthetic-b")
                finish_preparation.set()
                await asyncio.wait_for(prepared.wait(), 5)
                finish_request.set()
                expected = await asyncio.wait_for(owner, 5)
                self.assertEqual(await asyncio.wait_for(joining, 5), expected)
            self.assertEqual(len(calls), 1)
        finally:
            finish_preparation.set()
            finish_request.set()

    async def test_crossed_prepared_identities_do_not_deadlock(self):
        self.login("synthetic-a")
        first_preparing, second_preparing = asyncio.Event(), asyncio.Event()
        finish_first, finish_second = asyncio.Event(), asyncio.Event()
        requests_started, finish_requests = asyncio.Event(), asyncio.Event()
        calls = []
        reads = 0

        async def gated_aget():
            nonlocal reads
            reads += 1
            if reads == 1:
                first_preparing.set()
                await finish_first.wait()
                return b
            second_preparing.set()
            await finish_second.wait()
            return a

        async def delayed(request):
            calls.append(request)
            if len(calls) == 2:
                requests_started.set()
            await finish_requests.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        a = service.credentials.peek()

        with patch.object(service.credentials, "aget", gated_aget):
            first = asyncio.create_task(service.models(refresh=True))
            try:
                await asyncio.wait_for(first_preparing.wait(), 5)
                self.login("synthetic-b")
                b = service.credentials.peek()
                second = asyncio.create_task(service.models(refresh=True))
                await asyncio.wait_for(second_preparing.wait(), 5)
                finish_first.set()
                finish_second.set()
                await asyncio.wait_for(requests_started.wait(), 5)
                finish_requests.set()
                self.assertEqual((await asyncio.wait_for(first, 5))["models"][0]["id"], "gpt-6-astra")
                with self.assertRaises(SubscriptionUnavailable):
                    await asyncio.wait_for(second, 5)
                self.assertEqual(len(calls), 2)
            finally:
                finish_first.set()
                finish_second.set()
                finish_requests.set()

    async def test_close_cancels_preparation_and_final_identity_request(self):
        self.login("synthetic-a")
        preparing, finish_preparation = asyncio.Event(), asyncio.Event()
        request_started, request_cancelled = asyncio.Event(), asyncio.Event()
        finish_request = asyncio.Event()

        async def delayed(request):
            request_started.set()
            try:
                await finish_request.wait()
            finally:
                request_cancelled.set()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        original_aget = service.credentials.aget

        async def gated_aget():
            preparing.set()
            await finish_preparation.wait()
            return await original_aget()

        with patch.object(service.credentials, "aget", gated_aget):
            first = asyncio.create_task(service.models(refresh=True))
            try:
                await asyncio.wait_for(preparing.wait(), 5)
                self.login("synthetic-b")
                finish_preparation.set()
                await asyncio.wait_for(request_started.wait(), 5)
                second_peeked = asyncio.Event()
                original_peek = service.credentials.peek

                def observed_peek():
                    second_peeked.set()
                    return original_peek()

                with patch.object(service.credentials, "peek", observed_peek):
                    second = asyncio.create_task(service.models(refresh=True))
                    await asyncio.wait_for(second_peeked.wait(), 5)
                await asyncio.wait_for(service.aclose(), 5)
                await asyncio.wait_for(request_cancelled.wait(), 5)
                for caller in (first, second):
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(caller, 5)
                self.assertEqual(service._refreshes, {})
                self.assertEqual(service._preparations, {})
            finally:
                finish_preparation.set()
                finish_request.set()

    async def test_forced_refresh_singleflight_and_waiter_cancellation(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        calls = []

        async def delayed(request):
            calls.append(request)
            entered.set()
            await release.wait()
            return httpx.Response(200, json=self.catalog)

        service = SubscriptionData(self.store, transport=httpx.MockTransport(delayed))
        self.addAsyncCleanup(service.aclose)
        first = asyncio.create_task(service.models(refresh=True))
        await asyncio.wait_for(entered.wait(), 5)
        second = asyncio.create_task(service.models(refresh=True))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        result = await second
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["models"][0]["id"], "gpt-6-astra")
        self.assertEqual(await service.models(), result)
