"""Offline credential lifecycle tests; every token and endpoint response is synthetic."""

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import warnings

import httpx

from codex_test_home import assert_isolated_codex_home, isolate_codex_home

from wandrun.integrations.codex_credentials import CodexCredentials, CredentialError


def token(exp=None, *, user="same-user", account="account"):
    claims = {"https://api.openai.com/auth": {"chatgpt_account_id": account}}
    if user is not None:
        claims["https://api.openai.com/auth"]["chatgpt_user_id"] = user
    if exp is not None:
        claims["exp"] = exp
    encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"synthetic.{encoded}.signature"


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.original_home = Path(os.environ["HOME"])
        isolate_codex_home(self)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "gateway"
        self.home.mkdir()
        self.now = time.time()
        self.auth = {
            "auth_mode": "chatgpt", "custom": {"retain": True},
            "tokens": {"access_token": token(self.now + 240), "refresh_token": "old-synthetic",
                       "id_token": token(), "account_id": "account", "custom": "retain"},
            "last_refresh": datetime.now(timezone.utc).isoformat(),
        }
        self.save()
        self.calls = []

    def test_isolates_original_codex_home(self):
        assert_isolated_codex_home(self, self.original_home)

    def save(self):
        (self.home / "auth.json").write_text(json.dumps(self.auth))

    def owner(self, response=None, handler=None):
        if handler is None:
            response = response or {"access_token": token(self.now + 3600), "refresh_token": "new-synthetic"}
            handler = lambda request: httpx.Response(200, json=response)
        def trace(request):
            self.calls.append((request.url, json.loads(request.content)))
            return handler(request)
        instance = CodexCredentials.gateway(self.home, _transport=httpx.MockTransport(trace))
        self.addCleanup(instance.close)
        return instance

    def test_proactive_refresh_wire_identity_atomic_permissions_and_unknown_fields(self):
        self.home.chmod(0o777)
        (self.home / "auth.json").chmod(0o666)
        owner = self.owner()
        old = owner.peek()
        fresh = owner.get()
        self.assertEqual(self.calls, [(httpx.URL("https://auth.openai.com/oauth/token"), {
            "grant_type": "refresh_token", "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
            "refresh_token": "old-synthetic"})])
        self.assertEqual(old.identity, fresh.identity)
        self.assertNotEqual(old.version, fresh.version)
        self.assertEqual(fresh.tokens["refresh_token"], "new-synthetic")
        self.assertEqual(fresh.headers["ChatGPT-Account-ID"], "account")
        self.assertEqual(json.loads((self.home / "auth.json").read_text())["custom"], {"retain": True})
        self.assertEqual(fresh.tokens["custom"], "retain")
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.home / "auth.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual(owner.status()["status"], "ready")
        owner.get()
        self.assertEqual(len(self.calls), 1)

    def test_detached_lock_owner_cannot_race_replacement_owner_refresh(self):
        for keep_inode in (False, True):
            with self.subTest(keep_inode=keep_inode):
                self.save()
                self.calls.clear()
                old = self.owner()
                replacement = None
                try:
                    lock = self.home / ".wandrun-credentials.lock"
                    if keep_inode:
                        lock.rename(self.home / "detached-lock")
                    else:
                        lock.unlink()
                    replacement = self.owner()
                    # Both owners have read the old token and checked rotation
                    # before either publishes a marker or sends a request.
                    ready = threading.Barrier(2)
                    def gated(mark):
                        def run(refresh_token):
                            ready.wait(timeout=5)
                            return mark(refresh_token)
                        return run
                    with patch.object(old, "_mark_uncertain", gated(old._mark_uncertain)), \
                         patch.object(replacement, "_mark_uncertain", gated(replacement._mark_uncertain)), \
                         ThreadPoolExecutor(max_workers=2) as executor:
                        stale = executor.submit(old.get)
                        current = executor.submit(replacement.get)
                        with self.assertRaisesRegex(CredentialError, "ownership lost"):
                            stale.result(timeout=10)
                        self.assertEqual(current.result(timeout=10).tokens["refresh_token"], "new-synthetic")
                    self.assertEqual([body["refresh_token"] for _, body in self.calls], ["old-synthetic"])
                finally:
                    old.close()
                    if replacement is not None:
                        replacement.close()

    def test_missing_or_hardlinked_lifetime_lock_refuses_refresh(self):
        for hardlinked in (False, True):
            with self.subTest(hardlinked=hardlinked):
                owner = self.owner()
                lock = self.home / ".wandrun-credentials.lock"
                alias = self.home / "lock-alias"
                try:
                    if hardlinked:
                        os.link(lock, alias)
                    else:
                        lock.unlink()
                    with self.assertRaisesRegex(CredentialError, "ownership lost"):
                        owner.get()
                    self.assertEqual(self.calls, [])
                finally:
                    owner.close()
                    alias.unlink(missing_ok=True)

    def test_unencodable_refresh_token_releases_startup_ownership(self):
        owner = self.owner()
        owner._mark_uncertain("old-synthetic")
        owner.close()
        self.auth["tokens"]["refresh_token"] = "synthetic-secret-\ud800"
        self.save()
        with self.assertRaisesRegex(CredentialError, "^Invalid Codex file login$"):
            self.owner()
        self.assertEqual(self.calls, [])
        self.auth["tokens"]["refresh_token"] = "new-login"
        self.save()
        repaired = self.owner()
        self.assertEqual(repaired.get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual([body["refresh_token"] for _, body in self.calls], ["new-login"])

    def test_unexpected_initialization_failure_releases_all_ownership(self):
        for failure in (RuntimeError("synthetic initialization failure"), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                acquired = []
                def fail(instance):
                    acquired.append((instance, instance._directory, instance._lock_file))
                    raise failure
                with patch.object(CodexCredentials, "_read", fail):
                    with self.assertRaises(type(failure)):
                        self.owner()
                instance, directory, lock = acquired[0]
                self.assertTrue(instance._closed)
                for fd in (directory, lock):
                    with self.assertRaises(OSError):
                        os.fstat(fd)
                replacement = self.owner()
                try:
                    self.assertEqual(replacement.get().tokens["refresh_token"], "new-synthetic")
                finally:
                    replacement.close()

    def test_unencodable_rotated_token_preserves_auth_and_blocks_replay(self):
        before = (self.home / "auth.json").read_bytes()
        owner = self.owner(handler=lambda request: httpx.Response(
            200, content=json.dumps({"refresh_token": "synthetic-secret-\ud800"}).encode(),
        ))
        try:
            with self.assertRaisesRegex(CredentialError, "^Invalid refreshed Codex token data$"):
                owner.get()
            self.assertEqual((self.home / "auth.json").read_bytes(), before)
            self.assertEqual(owner.status()["status"], "relogin_required")
        finally:
            owner.close()
        restarted = self.owner()
        with self.assertRaises(CredentialError):
            restarted.get()
        self.assertEqual(len(self.calls), 1)

    def test_exp_boundary_fallback_and_missing_dates(self):
        self.auth["tokens"]["access_token"] = token(self.now + 600)
        self.auth["last_refresh"] = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
        self.save()
        owner = self.owner()
        owner.get()
        self.assertEqual(len(self.calls), 0)
        self.auth["tokens"]["access_token"] = "opaque-access-token"
        self.auth["last_refresh"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
        self.save()
        owner.get()
        self.assertEqual(len(self.calls), 1)
        owner.close()
        self.auth["tokens"]["access_token"] = "opaque-access-token"
        self.auth.pop("last_refresh")
        self.save()
        another = self.owner()
        another.get()
        self.assertEqual(len(self.calls), 1)

    def test_unusable_exp_claims_follow_last_refresh_instead_of_crashing(self):
        for claims in ([], {"exp": float("nan")}, {"exp": float("inf")}):
            with self.subTest(claims=claims):
                encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
                self.auth["tokens"]["access_token"] = f"synthetic.{encoded}.signature"
                self.auth["last_refresh"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
                self.save()
                owner = self.owner()
                try:
                    self.assertEqual(owner.get().tokens["refresh_token"], "new-synthetic")
                finally:
                    owner.close()
        self.assertEqual(len(self.calls), 3)

    def test_old_refresh_refusal_cannot_poison_observed_relogin(self):
        entered, release = threading.Event(), threading.Event()
        def handler(request):
            entered.set()
            self.assertTrue(release.wait(5))
            return httpx.Response(400, json={"error": "refresh_token_reused"})
        owner = self.owner(handler=handler)
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(owner.get)
            self.assertTrue(entered.wait(5))
            self.auth["tokens"]["access_token"] = token(self.now + 7200)
            self.auth["tokens"]["refresh_token"] = "new-login"
            self.save()
            self.assertEqual(owner.status()["status"], "ready")
            release.set()
            self.assertEqual(pending.result(timeout=5).tokens["refresh_token"], "new-login")
        self.assertEqual(owner.status()["status"], "ready")
        self.assertEqual(owner.get().tokens["refresh_token"], "new-login")
        self.assertEqual(len(self.calls), 1)

    def test_external_login_observation_does_not_erase_old_rotation_barrier(self):
        before = (self.home / "auth.json").read_bytes()
        def handler(request):
            self.auth["tokens"]["access_token"] = token(self.now + 7200)
            self.auth["tokens"]["refresh_token"] = "external-login"
            self.save()
            return httpx.Response(200, json={"refresh_token": "rotated-old-login"})
        owner = self.owner(handler=handler)
        self.assertEqual(owner.get().tokens["refresh_token"], "external-login")
        owner.close()
        # Model loss of an externally written, not-yet-durable directory entry.
        (self.home / "auth.json").write_bytes(before)
        restarted = self.owner()
        with self.assertRaises(CredentialError):
            restarted.get()
        self.assertEqual(restarted.status()["status"], "relogin_required")
        self.assertEqual(len(self.calls), 1)

    def test_waiters_share_success_when_optional_access_token_is_omitted(self):
        entered, queued, release = threading.Event(), threading.Event(), threading.Event()
        def handler(request):
            queued.clear()
            entered.set()
            self.assertTrue(release.wait(5))
            return httpx.Response(200, json={"refresh_token": "rotated-only"})
        owner = self.owner(handler=handler)
        lock = owner._flight
        class NotifyingLock:
            # Observe queuing without substituting the mutual-exclusion behavior.
            def __enter__(self):
                queued.set()
                return lock.__enter__()
            def __exit__(self, *args):
                return lock.__exit__(*args)
        owner._flight = NotifyingLock()
        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(owner.get)
            self.assertTrue(entered.wait(5))
            second = executor.submit(owner.get)
            self.assertTrue(queued.wait(5))
            release.set()
            self.assertEqual(first.result(timeout=5).tokens["refresh_token"], "rotated-only")
            self.assertEqual(second.result(timeout=5).tokens["access_token"], self.auth["tokens"]["access_token"])
        self.assertEqual(len(self.calls), 1)

    def test_sync_async_single_flight_and_cancellation_close_waits(self):
        entered = threading.Event()
        release = threading.Event()
        def handler(request):
            entered.set()
            self.assertTrue(release.wait(5))
            return httpx.Response(200, json={"access_token": token(self.now + 3600), "refresh_token": "rotated"})
        owner = self.owner(handler=handler)
        async def scenario():
            first = asyncio.create_task(owner.aget())
            await asyncio.to_thread(entered.wait, 5)
            owner.accepted(owner.peek())
            self.assertEqual(owner.status()["status"], "refreshing")
            second = asyncio.create_task(owner.aget())
            sync = asyncio.create_task(asyncio.to_thread(owner.get))
            await asyncio.sleep(0.05)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            close = asyncio.create_task(owner.aclose())
            await asyncio.sleep(0.05)
            self.assertFalse(close.done())
            release.set()
            await asyncio.gather(second, sync, close, return_exceptions=True)
        asyncio.run(scenario())
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(json.loads((self.home / "auth.json").read_text())["tokens"]["refresh_token"], "rotated")
        with self.assertRaises(CredentialError):
            owner.get()

    def test_concurrent_failed_refresh_coalesces_then_future_request_retries(self):
        entered, release = threading.Event(), threading.Event()
        def handler(request):
            entered.set()
            self.assertTrue(release.wait(5))
            return httpx.Response(503, json={"error": "temporary"})
        owner = self.owner(handler=handler)
        with ThreadPoolExecutor(max_workers=12) as executor:
            tasks = [executor.submit(owner.get) for _ in range(12)]
            self.assertTrue(entered.wait(5))
            time.sleep(0.1)
            release.set()
            for future in tasks:
                with self.assertRaises(CredentialError):
                    future.result()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(owner.status()["status"], "temporarily_unavailable")
        with self.assertRaises(CredentialError):
            owner.get()
        self.assertEqual(len(self.calls), 2)

    def test_permanent_refusal_version_latch_and_relogin(self):
        owner = self.owner(handler=lambda request: httpx.Response(400, json={"error": {"code": "refresh_token_reused"}, "access_token": "secret-must-not-leak"}))
        old = owner.peek()
        for _ in range(2):
            with self.assertRaises(CredentialError) as failure:
                owner.get()
            self.assertNotIn("secret-must-not-leak", str(failure.exception))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(owner.status()["reason"], "reused")
        self.assertEqual(owner.peek().version, old.version)
        self.auth["tokens"]["access_token"] = token(self.now + 3600)
        self.auth["tokens"]["refresh_token"] = "relogin"
        self.save()
        self.assertEqual(owner.get().tokens["refresh_token"], "relogin")
        self.assertEqual(owner.status()["status"], "ready")
        owner.accepted(old)
        self.assertEqual(owner.status()["status"], "ready")

    def test_401_unknown_malformed_permanent_and_500_transient(self):
        owner = self.owner(handler=lambda request: httpx.Response(401, content=b"not json"))
        with self.assertRaises(CredentialError):
            owner.get()
        self.assertEqual(owner.status()["reason"], "rejected")
        self.assertEqual(owner.status()["status"], "reauth_required")

    def test_invalid_grant_transient_decode_and_transport_errors(self):
        owner = self.owner(handler=lambda request: httpx.Response(400, json={"error": "invalid_grant"}))
        with self.assertRaises(CredentialError):
            owner.get()
        self.assertEqual(owner.status()["reason"], "invalid_grant")
        owner.close()
        self.auth["tokens"]["refresh_token"] = "new-version"
        self.save()
        other = self.owner(handler=lambda request: httpx.Response(200, content=b"not-json"))
        with self.assertRaises(CredentialError):
            other.get()
        self.assertEqual(other.status()["status"], "relogin_required")
        other.close()
        self.auth["tokens"]["refresh_token"] = "fresh-login"
        self.save()
        failed = self.owner(handler=lambda request: (_ for _ in ()).throw(httpx.ConnectError("credential=sensitive")))
        with self.assertRaises(CredentialError) as error:
            failed.get()
        self.assertNotIn("sensitive", str(error.exception))
        self.assertEqual(failed.status()["status"], "temporarily_unavailable")

    def test_empty_login_and_readonly_never_refresh(self):
        (self.home / "auth.json").unlink()
        owner = self.owner()
        self.assertEqual(owner.status()["status"], "login_required")
        with self.assertRaises(CredentialError):
            owner.get()
        self.assertEqual(len(self.calls), 0)
        owner.close()
        self.auth["tokens"]["access_token"] = token(self.now - 3600)
        self.save()
        readonly = CodexCredentials(self.home)
        self.assertEqual(readonly.get().tokens["refresh_token"], "old-synthetic")
        self.assertEqual(readonly.status()["status"], "ready")
        readonly.close()

    def fail_auth_replace(self, source, destination, **kwargs):
        if destination == "auth.json":
            raise OSError("synthetic auth publication failure")
        return self.real_replace(source, destination, **kwargs)

    def test_write_failure_keeps_rotation_for_safe_retry(self):
        owner = self.owner()
        self.real_replace = os.replace
        with patch("wandrun.integrations.codex_credentials.os.replace", side_effect=self.fail_auth_replace):
            with self.assertRaises(CredentialError) as failure:
                owner.get()
            self.assertNotIn("secret detail", str(failure.exception))
        self.assertEqual(owner.status()["reason"], "credential_write_failed")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(owner.get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(owner.status()["status"], "ready")

    def test_uncertain_marker_blocks_unsafe_rotation_across_restart(self):
        owner = self.owner()
        self.real_replace = os.replace
        with patch("wandrun.integrations.codex_credentials.os.replace", side_effect=self.fail_auth_replace):
            with self.assertRaises(CredentialError):
                owner.get()
        owner.close()
        next_owner = self.owner()
        with self.assertRaises(CredentialError):
            next_owner.get()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(next_owner.status()["reason"], "refresh_persistence_uncertain")
        self.assertEqual(next_owner.status()["status"], "relogin_required")

    def test_marker_write_or_sync_failure_never_sends_before_restart(self):
        for operation in ("write", "fsync", "replace"):
            with self.subTest(operation=operation):
                self.calls.clear()
                self.auth["tokens"]["refresh_token"] = f"synthetic-{operation}"
                self.save()
                owner = self.owner()
                with patch(f"wandrun.integrations.codex_credentials.os.{operation}", side_effect=OSError("disk full")):
                    with self.assertRaises(CredentialError):
                        owner.get()
                self.assertEqual(self.calls, [])
                owner.close()
                restarted = self.owner()
                try:
                    restarted.get()
                except CredentialError:
                    self.assertEqual(restarted.status()["status"], "relogin_required")
                self.assertLessEqual(len(self.calls), 1)
                restarted.close()

    def test_crash_after_request_dispatch_cannot_reuse_refresh_token(self):
        # Exit inside transport dispatch, without finally/close: disk state is
        # the only communication with the restarted owner.
        code = """
import os, sys, httpx
from pathlib import Path
from wandrun.integrations.codex_credentials import CodexCredentials
def dispatched(request):
    os._exit(73)
owner = CodexCredentials.gateway(Path(sys.argv[1]), _transport=httpx.MockTransport(dispatched))
owner.get()
"""
        child = subprocess.run([sys.executable, "-c", code, str(self.home)], capture_output=True, timeout=10)
        self.assertEqual(child.returncode, 73, child.stderr)
        restarted = self.owner()
        self.assertEqual(restarted.status()["status"], "relogin_required")
        for _ in range(2):
            with self.assertRaises(CredentialError):
                restarted.get()
        self.assertEqual(self.calls, [])
        # A completed manual login is a different version and unblocks recovery.
        self.auth["tokens"]["refresh_token"] = "manual-login"
        self.save()
        self.assertEqual(restarted.get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual(self.calls[0][1]["refresh_token"], "manual-login")

    def test_lost_response_blocks_refresh_but_connection_failure_is_temporary(self):
        def lost(request):
            raise httpx.ReadTimeout("synthetic response lost")
        owner = self.owner(handler=lost)
        with self.assertRaises(CredentialError):
            owner.get()
        owner.temporary_failure(owner.peek())
        self.assertEqual(owner.status()["status"], "relogin_required")
        owner.close()
        restarted = self.owner()
        with self.assertRaises(CredentialError):
            restarted.get()
        self.assertEqual(len(self.calls), 1)
        restarted.close()
        self.auth["tokens"]["refresh_token"] = "manual-login"
        self.save()
        def disconnected(request):
            raise httpx.ConnectError("synthetic connection refused")
        offline = self.owner(handler=disconnected)
        with self.assertRaises(CredentialError):
            offline.get()
        self.assertEqual(offline.status()["status"], "temporarily_unavailable")
        offline.close()
        connected = self.owner()
        self.assertEqual(connected.get().tokens["refresh_token"], "new-synthetic")

    def test_invalid_merged_id_token_preserves_auth_and_restart_barrier(self):
        invalid_claims = [
            123, {"email": 123}, {"https://api.openai.com/profile": {"email": False}},
            {"https://api.openai.com/auth": {"chatgpt_plan_type": 5}},
            {"https://api.openai.com/auth": {"user_id": []}},
            {"https://api.openai.com/auth": {"chatgpt_account_is_fedramp": None}},
        ]
        invalid_tokens = ["invalid-synthetic-id", ".e30.signature", "h.e30=.s"] + [
            "h." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".s"
            for claims in invalid_claims
        ]
        for value in invalid_tokens + [None]:
            with self.subTest(value=value):
                self.auth["tokens"]["refresh_token"] = f"invalid-case-{len(self.calls)}"
                if value is None:
                    self.auth["tokens"].pop("id_token", None)
                self.save()
                before = (self.home / "auth.json").read_bytes()
                response = {"refresh_token": "rotated", "id_token": value}
                owner = self.owner(response=response)
                try:
                    with self.assertRaises(CredentialError):
                        owner.get()
                    self.assertEqual((self.home / "auth.json").read_bytes(), before)
                    self.assertEqual(owner.status()["status"], "relogin_required")
                finally:
                    owner.close()
                calls = len(self.calls)
                restarted = self.owner()
                try:
                    with self.assertRaises(CredentialError):
                        restarted.get()
                    self.assertEqual(len(self.calls), calls)
                finally:
                    restarted.close()

    def test_id_claims_may_be_absent_or_null_and_unknown_fields_are_preserved(self):
        for claims in ({}, {"email": None, "https://api.openai.com/auth": None},
                       {"https://api.openai.com/auth": {"chatgpt_plan_type": "future-plan", "chatgpt_account_is_fedramp": True}}):
            with self.subTest(claims=claims):
                self.auth["custom"]["claims"] = claims
                self.save()
                jwt = "h." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".s"
                owner = self.owner(response={"id_token": jwt, "access_token": token(self.now + 3600)})
                try:
                    self.assertEqual(owner.get().tokens["id_token"], jwt)
                    self.assertEqual(json.loads((self.home / "auth.json").read_bytes())["custom"]["claims"], claims)
                finally:
                    owner.close()

    def test_lost_response_reformat_cannot_replay_consumed_token(self):
        def lost(request):
            raise httpx.ReadError("synthetic response lost")
        owner = self.owner(handler=lost)
        with self.assertRaises(CredentialError):
            owner.get()
        owner.close()
        marker = (self.home / ".wandrun-credentials.rotation").read_bytes()
        self.assertNotIn(b"old-synthetic", marker)
        (self.home / "auth.json").write_text(json.dumps(self.auth, indent=4))
        restarted = self.owner()
        with self.assertRaises(CredentialError):
            restarted.get()
        self.assertEqual([body["refresh_token"] for _, body in self.calls], ["old-synthetic"])
        self.assertEqual(restarted.status()["status"], "relogin_required")
        self.auth["tokens"]["refresh_token"] = "new-login"
        self.save()
        self.assertEqual(restarted.get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual(self.calls[-1][1]["refresh_token"], "new-login")

    def test_short_marker_write_is_completed_before_atomic_publication(self):
        owner = self.owner()
        real_write = os.write
        with patch("wandrun.integrations.codex_credentials.os.write",
                   side_effect=lambda fd, data: real_write(fd, data[:8])):
            self.assertEqual(owner.get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual(len(self.calls), 1)

    def test_interrupted_marker_write_does_not_publish_partial_barrier(self):
        owner = self.owner()
        real_write = os.write
        writes = 0
        def interrupted(fd, data):
            nonlocal writes
            writes += 1
            if writes > 1:
                raise OSError("synthetic disk full")
            return real_write(fd, data[:8])
        with patch("wandrun.integrations.codex_credentials.os.write", side_effect=interrupted):
            with self.assertRaises(CredentialError):
                owner.get()
        self.assertEqual(self.calls, [])
        self.assertFalse((self.home / ".wandrun-credentials.rotation").exists())
        owner.close()
        self.auth["tokens"]["refresh_token"] = "manual-login"
        self.save()
        self.assertEqual(self.owner().get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual(self.calls[0][1]["refresh_token"], "manual-login")

    def test_corrupt_marker_recovery_requires_new_login_then_explicit_removal(self):
        """Stop, complete a new login, remove only the corrupt marker, restart.

        Merely rewriting auth.json cannot identify the consumed credential and
        must not clear a corrupt barrier. The displayed command uses && so a
        failed login cannot remove it. Never remove the lifetime lock file.
        """
        marker = self.home / ".wandrun-credentials.rotation"
        marker.write_bytes(b"partial!")
        marker.chmod(0o600)
        with self.assertLogs("wandrun.integrations.codex_credentials", level="ERROR") as logs:
            owner = self.owner()
        with self.assertRaises(CredentialError):
            owner.get()
        command = owner.status()["login_command"]
        self.assertIn(f" && rm -- {marker}", command)
        self.assertIn(command, logs.output[0])
        owner.close()
        self.auth["tokens"]["refresh_token"] = "manual-login"
        self.save()
        still_blocked = self.owner()
        with self.assertRaises(CredentialError):
            still_blocked.get()
        self.assertEqual(self.calls, [])
        still_blocked.close()
        marker.unlink()  # The post-login step displayed in App and gateway log.
        self.assertEqual(self.owner().get().tokens["refresh_token"], "new-synthetic")
        self.assertEqual(self.calls[0][1]["refresh_token"], "manual-login")

    def test_fixed_codex_id_payload_acceptance_and_rejection(self):
        cases = [
            (b'{}', True),
            (b'{"https://api.openai.com/auth":{"chatgpt_plan_type":{"plus":null}}}', True),
            (b'{"email":"a@example.test","email":"b@example.test"}', False),
            ('{}'.encode("utf-16"), False),
            (b'{"email":null,"email":null}', False),
            (b'{"https://api.openai.com/profile":{"email":null,"email":"b"}}', False),
            (b'{"https://api.openai.com/auth":{"user_id":null,"user_id":"b"}}', False),
            (b'{"https://api.openai.com/auth":{"chatgpt_plan_type":{"future":null}}}', False),
            (b'{"https://api.openai.com/auth":{"chatgpt_plan_type":{"plus":false}}}', False),
            (b'{"unknown":1,"unknown":2}', True),
            (b'[]', True),
            (b'[null,[],[null,null,null,null,false]]', True),
            (b'{"email":"\\ud800"}', False),
        ]
        for index, (payload, accepted) in enumerate(cases):
            with self.subTest(payload=payload):
                self.auth["tokens"]["refresh_token"] = f"payload-case-{index}"
                self.save()
                before = (self.home / "auth.json").read_bytes()
                jwt = "h." + base64.urlsafe_b64encode(payload).decode().rstrip("=") + ".s"
                owner = self.owner(response={"id_token": jwt, "refresh_token": "rotated"})
                try:
                    if accepted:
                        self.assertEqual(owner.get().tokens["id_token"], jwt)
                    else:
                        with self.assertRaises(CredentialError):
                            owner.get()
                        self.assertEqual((self.home / "auth.json").read_bytes(), before)
                        self.assertEqual(owner.status()["status"], "relogin_required")
                finally:
                    owner.close()

    def test_hardlinked_lock_rejects_startup_without_changing_daily_file(self):
        daily = Path(os.environ["HOME"]) / ".codex"
        daily.mkdir(exist_ok=True)
        daily_auth = daily / "auth.json"
        daily_auth.write_text(json.dumps(self.auth))
        daily_auth.chmod(0o640)
        before = daily_auth.read_bytes(), daily_auth.stat().st_mode
        os.link(daily_auth, self.home / ".wandrun-credentials.lock")
        with self.assertRaises(CredentialError):
            self.owner()
        self.assertEqual((daily_auth.read_bytes(), daily_auth.stat().st_mode), before)
        self.assertEqual(self.calls, [])

    def test_ancestor_symlink_switch_cannot_redirect_owned_directory(self):
        root = Path(self.tmp.name)
        independent = root / "independent"
        independent.mkdir()
        self.home.rename(independent / ".codex")
        daily_home = root / "daily-user"
        daily = daily_home / ".codex"
        daily.mkdir(parents=True)
        daily_auth = daily / "auth.json"
        daily_auth.write_text(json.dumps({**self.auth, "custom": "daily untouched"}))
        before = daily_auth.read_bytes(), daily_auth.stat().st_mode
        link = root / "ancestor"
        link.symlink_to(independent, target_is_directory=True)
        self.home = link / ".codex"
        with patch.dict(os.environ, {"HOME": str(daily_home)}):
            owner = self.owner()
            link.unlink()
            link.symlink_to(daily_home, target_is_directory=True)
            self.assertEqual(owner.get().tokens["refresh_token"], "new-synthetic")
            self.assertEqual((daily_auth.read_bytes(), daily_auth.stat().st_mode), before)
            saved = json.loads((independent / ".codex/auth.json").read_bytes())
            self.assertEqual(saved["tokens"]["refresh_token"], "new-synthetic")
            self.assertFalse((daily / ".wandrun-credentials.lock").exists())

    def test_opened_file_permissions_links_and_type_are_checked_on_read(self):
        owner = self.owner()
        auth = self.home / "auth.json"
        auth.chmod(0o644)
        with self.assertRaises(CredentialError):
            owner.get()
        auth.chmod(0o600)
        os.link(auth, self.home / "alias")
        with self.assertRaises(CredentialError):
            owner.get()
        auth.unlink()
        os.mkfifo(auth, 0o600)
        with self.assertRaises(CredentialError):
            owner.get()
        self.assertEqual(self.calls, [])

    def test_recover_changed_token_without_user_claim_and_no_replay_readonly(self):
        self.auth["tokens"]["access_token"] = token(self.now + 3600, user=None)
        self.save()
        owner = self.owner()
        old = owner.peek()
        self.auth["tokens"]["access_token"] = token(self.now + 7200, user=None)
        self.save()
        fresh = owner.recover(old)
        self.assertNotEqual(old.identity, fresh.identity)
        self.assertEqual(len(self.calls), 0)
        self.auth["tokens"]["account_id"] = "other"
        self.save()
        with self.assertRaises(CredentialError):
            owner.recover(fresh)
        readonly = CodexCredentials(self.home)
        current = readonly.peek()
        with self.assertRaises(CredentialError):
            readonly.recover(current)
        self.assertEqual(readonly.status()["status"], "reauth_required")
        readonly.close()

    def test_first_rejection_schedules_next_request_and_exhausted_sticks(self):
        self.auth["tokens"]["access_token"] = token(self.now + 3600)
        self.save()
        owner = self.owner()
        old = owner.get()
        owner.rejected(old)
        self.assertEqual(owner.status()["status"], "refresh_due")
        new = owner.get()
        self.assertNotEqual(old.version, new.version)
        owner.rejected(new, retry_exhausted=True)
        self.assertEqual(owner.status()["status"], "reauth_required")
        owner.accepted(old)
        owner.temporary_failure(new)
        self.assertEqual(owner.status()["status"], "reauth_required")

    def test_second_process_cannot_own_live_directory(self):
        owner = self.owner()
        code = "from pathlib import Path; from wandrun.integrations.codex_credentials import CodexCredentials, CredentialError; import sys;\ntry: CodexCredentials.gateway(Path(sys.argv[1])); sys.exit(8)\nexcept CredentialError: sys.exit(0)"
        proc = subprocess.run([sys.executable, "-c", code, str(self.home)], capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        owner.close()
        other = self.owner()
        self.assertEqual(other.peek().tokens["refresh_token"], "old-synthetic")

    def test_alias_hardlink_missing_directory_and_readonly_override(self):
        daily = Path(self.tmp.name) / ".codex"
        daily.mkdir()
        (daily / "auth.json").write_text(json.dumps(self.auth))
        with patch.dict(os.environ, {"HOME": self.tmp.name, "CODEX_HOME": str(daily)}):
            with self.assertRaises(CredentialError):
                CodexCredentials.gateway(daily)
            symlink = Path(self.tmp.name) / "alias"
            symlink.symlink_to(daily, target_is_directory=True)
            with self.assertRaises(CredentialError):
                CodexCredentials.gateway(symlink)
            with self.assertRaises(CredentialError):
                CodexCredentials.gateway(Path(self.tmp.name) / "not-yet-created")
            with self.assertRaises(CredentialError):
                CodexCredentials.gateway(Path(self.tmp.name) / "not-yet-created", allow_shared=True)
            self.assertFalse((Path(self.tmp.name) / "not-yet-created").exists())
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                readonly = CodexCredentials.gateway(self.home, allow_shared=True)
                self.assertTrue(caught)
                self.assertEqual(readonly.get().tokens["refresh_token"], "old-synthetic")
                readonly.close()
                before = (daily / "auth.json").read_bytes()
                shared = CodexCredentials.gateway(daily, allow_shared=True)
                self.assertEqual(shared.get().tokens["refresh_token"], "old-synthetic")
                shared.close()
                self.assertEqual((daily / "auth.json").read_bytes(), before)
                self.assertFalse((daily / ".wandrun-credentials.lock").exists())
            hardlink = Path(self.tmp.name) / "hardlinked"
            hardlink.mkdir()
            os.link(daily / "auth.json", hardlink / "auth.json")
            with self.assertRaises(CredentialError):
                CodexCredentials.gateway(hardlink)

    def test_default_gateway_never_reads_or_writes_daily_auth(self):
        sandbox = Path(self.tmp.name) / "sandbox"
        daily = sandbox / ".codex"
        daily.mkdir(parents=True)
        daily_auth = daily / "auth.json"
        daily_auth.write_text("DO NOT READ DAILY AUTH")
        managed = sandbox / ".local/share/wandrun/codex-home"
        managed.mkdir(parents=True)
        (managed / "auth.json").write_text(json.dumps(self.auth))
        real_read = Path.read_bytes
        def guarded_read(path):
            self.assertNotEqual(path.resolve(), daily_auth)
            return real_read(path)
        with patch.dict(os.environ, {"HOME": str(sandbox), "CODEX_HOME": str(daily)}), patch.object(Path, "read_bytes", guarded_read):
            owner = CodexCredentials.gateway(_transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"access_token": token(self.now + 3600), "refresh_token": "rotated"})))
            try:
                self.assertEqual(owner.home, managed)
                old = owner.peek()
                owner.get()
                owner.recover(old)
                owner.rejected(old)
                owner.accepted(old)
                owner.temporary_failure(old)
                owner.status()
            finally:
                owner.close()
        self.assertEqual(daily_auth.read_text(), "DO NOT READ DAILY AUTH")
