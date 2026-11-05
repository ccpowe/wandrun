"""Deterministic provider boundaries: no live account or machine is contacted."""

import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import asyncssh
import httpx
from deepagents.backends.protocol import ExecuteResponse, FileDownloadResponse, FileUploadResponse, ReadResult

from wandrun.integrations import instabox
from wandrun.integrations.instabox import InstaboxBackend
from wandrun.integrations.shell_backend import CleanupUnconfirmedError
from wandrun.runtime.browser.leases import BrowserEnvironmentError

MACHINE = "m_" + "a" * 26
OPERATION = "op_" + "b" * 26
SECRET = "must-never-appear-in-errors"
CLIENT = httpx.AsyncClient


class Connection:
    def __init__(self):
        self.closed = False

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True

    def abort(self):
        self.closed = True

    async def wait_closed(self):
        return None


class ReadyBackend:
    def __init__(self):
        self._channel = SimpleNamespace(broken=False, seal=lambda: None)
        self.commands = []
        self.aclose = AsyncMock()
        self.aread = AsyncMock(return_value=ReadResult(file_data=[]))
        self.aupload_files = AsyncMock(side_effect=lambda files: [FileUploadResponse(path=p) for p, _ in files])
        self.adownload_files = AsyncMock(side_effect=lambda paths: [FileDownloadResponse(path=p, content=b"data") for p in paths])

    async def aexecute(self, command, *, timeout=None):
        self.commands.append(command)
        return ExecuteResponse(output="actual", exit_code=0, truncated=False)

    def pending_transfer_owners(self):
        return set()


class InstaboxTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.state = "running"
        self.connection = Connection()
        self.ready = ReadyBackend()
        self.gate = None
        authority = asyncssh.generate_private_key("ssh-ed25519").export_public_key().decode()
        self.certificate = {
            "machineId": MACHINE, "host": "api.instabox.sh", "port": 2222,
            "username": MACHINE, "certificate": "private certificate response",
            "hostTrust": {"type": "ca", "publicKey": authority, "principals": ["api.instabox.sh"]},
        }
        self.handler = self.respond
        transport = httpx.MockTransport(self.dispatch)
        self.client_options = []

        def client(**kwargs):
            self.client_options.append(kwargs)
            return CLIENT(**kwargs, transport=transport)

        for patcher in (
            patch.dict(os.environ, {"TEST_INSTABOX_KEY": SECRET}),
            patch.object(instabox.httpx, "AsyncClient", side_effect=client),
            patch.object(instabox.asyncssh, "import_certificate", return_value=object()),
            patch.object(instabox.asyncssh, "connect", new=AsyncMock(return_value=self.connection)),
            patch.object(instabox.SSHBackend, "start", new=AsyncMock(return_value=self.ready)),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.skills = AsyncMock()
        self.backend = InstaboxBackend(MACHINE, "TEST_INSTABOX_KEY", workdir="/data/work", prepare_skills=self.skills)
        self.addAsyncCleanup(self.close)

    async def close(self):
        try:
            await self.backend.aclose()
        except CleanupUnconfirmedError:
            pass

    async def dispatch(self, request):
        self.requests.append((request.method, request.url.path))
        self.assertEqual(request.headers["X-API-Key"], os.environ["TEST_INSTABOX_KEY"])
        self.assertEqual(request.url.host, "api.instabox.sh")
        return await self.handler(request)

    async def respond(self, request):
        path = request.url.path
        if path.endswith("/resume"):
            self.state = "resuming"
            return httpx.Response(202, json={"id": OPERATION})
        if path.startswith("/v1/operations/"):
            if self.gate is not None:
                await self.gate.wait()
            self.state = "running"
            return httpx.Response(200, json={"id": OPERATION, "machineId": MACHINE, "state": "succeeded"})
        if path.endswith("/connections"):
            return httpx.Response(201, json=self.certificate)
        return httpx.Response(200, json={"id": MACHINE, "state": self.state,
                                       "operationId": None, "runtime": {"ready": self.state == "running"}})

    async def test_constructor_paths_and_unused_close_do_not_activate(self):
        self.assertEqual(self.backend.id, "instabox:" + MACHINE)
        self.assertEqual(self.backend.processes.workdir, "/data/work")
        await self.backend.aclose()
        self.assertEqual(self.requests, [])
        self.skills.assert_not_awaited()

    async def test_first_io_prepares_once_and_healthy_io_reuses_connection(self):
        feedback = AsyncMock(return_value=True)
        self.backend.bind_recovery_feedback(feedback)
        self.assertEqual((await self.backend.aexecute("one")).exit_code, 0)
        await self.backend.aread("/data/work/file")
        await self.backend.aupload_files([("a", b"bytes")])
        await self.backend.adownload_files(["a"])
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.backend.pending_transfer_owners(), set())
        self.assertEqual(self.skills.await_count, 4)
        self.assertTrue(all(call.args == (self.ready,) for call in self.skills.await_args_list))
        connect = instabox.asyncssh.connect.call_args.kwargs
        self.assertIn(b"@cert-authority [api.instabox.sh]:2222", connect["known_hosts"])
        self.assertEqual(connect["keepalive_interval"], 0)
        self.assertIsNone(connect["agent_path"])
        self.assertFalse(self.client_options[0]["follow_redirects"])
        feedback.assert_not_awaited()

    async def test_resume_singleflight_waiter_cancel_does_not_abandon_owner(self):
        self.state = "suspended"
        self.gate = asyncio.Event()
        first = asyncio.create_task(self.backend.aexecute("side-effect-one"))
        while not any(path.endswith("/resume") for _, path in self.requests):
            await asyncio.sleep(0)
        second = asyncio.create_task(self.backend.aexecute("side-effect-two"))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertFalse(self.backend._preparing.cancelled())
        self.assertEqual(self.backend.pending_transfer_owners(), {None})
        self.gate.set()
        result = await second
        self.assertIsNone(result.exit_code)
        self.assertIn("不代表已经重启", result.output)
        self.assertIn("本次环境操作未提交", result.output)
        self.assertEqual(self.ready.commands, [])
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)
        await self.backend.aexecute("new-explicit-call")
        self.assertEqual(self.ready.commands, ["new-explicit-call"])
        self.assertEqual(self.backend.pending_transfer_owners(), set())

    async def test_reconnect_reports_recovery_without_replaying_command(self):
        await self.backend.aexecute("original")
        self.ready._channel.broken = True
        replacement = ReadyBackend()
        instabox.SSHBackend.start.return_value = replacement
        result = await self.backend.aexecute("must-not-submit")
        self.assertIn("尚未核验", result.output)
        self.assertEqual(replacement.commands, [])
        self.assertEqual(instabox.asyncssh.connect.await_count, 2)
        self.assertIn("SSH 连接或执行通道已重建", result.output)

    async def test_lost_resume_ack_is_not_posted_again_and_close_reports_unknown(self):
        self.state = "suspended"

        async def fail(request):
            if request.url.path.endswith("/resume"):
                raise httpx.ReadError(SECRET, request=request)
            return await self.respond(request)

        self.handler = fail
        first = await self.backend.aexecute("never")
        second = await self.backend.aexecute("never-again")
        self.assertNotIn(SECRET, first.output + second.output)
        self.assertIn("lifecycle_unknown", second.output)
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)
        self.assertTrue(self.backend._preparing.done())
        self.assertEqual(self.backend.pending_transfer_owners(), {None})
        with self.assertRaises(CleanupUnconfirmedError):
            await self.backend.aclose()
        self.assertEqual(self.ready.commands, [])

    async def test_non_json_and_http_failures_are_classified_without_response_body(self):
        for status in (200, 401, 503):
            async def failure(request, status=status):
                return httpx.Response(status, text=SECRET)
            self.handler = failure
            result = await self.backend.aread("file")
            self.assertNotIn(SECRET, result.error)
            self.assertIn("Instabox [", result.error)
        self.assertEqual(self.ready.commands, [])

    async def test_stopped_machine_is_not_started(self):
        self.state = "stopped"
        result = await self.backend.aexecute("never")
        self.assertIn("machine_state", result.output)
        self.assertEqual(self.requests, [("GET", "/v1/machines/" + MACHINE)])

    async def test_strict_host_trust_rejects_wrong_principal(self):
        self.certificate["hostTrust"]["principals"] = ["other.example"]
        result = await self.backend.aexecute("never")
        self.assertIn("Host CA", result.output)
        instabox.asyncssh.connect.assert_not_awaited()

    async def test_skill_failure_or_cancel_never_submits_business_command(self):
        self.skills.side_effect = OSError("upload failed")
        result = await self.backend.aexecute("never")
        self.assertIn("[skills]", result.output)
        self.assertEqual(self.ready.commands, [])
        self.skills.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.backend.aexecute("never")
        self.assertEqual(self.ready.commands, [])
        self.skills.side_effect = None
        await self.backend.aexecute("explicit-new-call")
        self.assertEqual(self.ready.commands, ["explicit-new-call"])

    async def test_synchronous_file_and_execute_entries_use_owner_loop(self):
        await asyncio.to_thread(self.backend.read, "file")
        result = await asyncio.to_thread(self.backend.execute, "sync-command")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self.skills.await_count, 2)

    async def test_close_seals_new_io_and_bounds_pending_resume(self):
        self.state = "suspended"
        self.gate = asyncio.Event()
        pending = asyncio.create_task(self.backend.aexecute("never"))
        while not any(path.endswith("/resume") for _, path in self.requests):
            await asyncio.sleep(0)
        with patch.object(instabox, "CLOSE_LIMIT", 0.01):
            with self.assertRaises(CleanupUnconfirmedError):
                await self.backend.aclose()
        await asyncio.gather(pending, return_exceptions=True)
        count = len(self.requests)
        result = await self.backend.aexecute("late")
        self.assertIn("closed", result.output)
        self.assertEqual(len(self.requests), count)
        self.assertEqual(self.ready.commands, [])

    async def test_session_cleanup_failure_is_not_suppressed_and_connection_closes(self):
        await self.backend.aexecute("one")
        self.ready.aclose.side_effect = CleanupUnconfirmedError("owned command unknown")
        with self.assertRaisesRegex(CleanupUnconfirmedError, "owned command unknown"):
            await self.backend.aclose()
        self.assertTrue(self.connection.closed)

    async def test_concurrent_initial_io_shares_one_activation(self):
        results = await asyncio.gather(*(self.backend.aexecute(f"command-{i}") for i in range(8)))
        self.assertTrue(all(result.exit_code == 0 for result in results))
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(instabox.asyncssh.connect.await_count, 1)
        self.assertEqual(len(self.ready.commands), 8)

    async def test_operation_success_is_not_enough_until_runtime_ready(self):
        self.state = "suspended"
        unready = 0

        async def staged(request):
            nonlocal unready
            if request.method == "GET" and request.url.path.endswith(MACHINE) and self.state == "running":
                unready += 1
                if unready == 1:
                    return httpx.Response(200, json={
                        "id": MACHINE, "state": "running", "operationId": None, "runtime": {"ready": False},
                    })
            return await self.respond(request)

        self.handler = staged
        result = await self.backend.aexecute("not-until-ready")
        self.assertIn("[recovery]", result.output)
        self.assertEqual(unready, 2)
        self.assertEqual(self.ready.commands, [])
        self.assertEqual(self.requests[-1], ("POST", f"/v1/machines/{MACHINE}/connections"))

    async def test_all_waiters_cancelled_still_leave_pending_recovery_feedback(self):
        self.state = "suspended"
        feedback = AsyncMock(return_value=True)
        self.backend.bind_recovery_feedback(feedback)
        self.gate = asyncio.Event()
        waiter = asyncio.create_task(self.backend.aexecute("never"))
        while not any(path.endswith("/resume") for _, path in self.requests):
            await asyncio.sleep(0)
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)
        self.assertEqual(self.backend.pending_transfer_owners(), {None})
        self.gate.set()
        await self.backend._preparing
        self.assertEqual(self.backend.pending_transfer_owners(), set())
        feedback.assert_not_awaited()
        result = await self.backend.aexecute("new-but-needs-feedback")
        self.assertIn("[recovery]", result.output)
        self.assertEqual(self.ready.commands, [])
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)
        feedback.assert_awaited_once()

    async def test_close_waiter_cancel_does_not_abandon_connection_close(self):
        await self.backend.aexecute("one")
        gate = asyncio.Event()
        self.connection.wait_closed = gate.wait
        closing = asyncio.create_task(self.backend.aclose())
        while not self.connection.closed:
            await asyncio.sleep(0)
        closing.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertFalse(self.backend._closing.cancelled())
        gate.set()
        await self.backend.aclose()

    async def test_close_waits_cancelled_skill_stage_cleanup_before_closing_ssh(self):
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        release = asyncio.Event()

        async def skills(backend):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        self.backend._prepare_skills = skills
        pending = asyncio.create_task(self.backend.aexecute("must-not-be-late"))
        await entered.wait()
        pending.cancel()  # Runtime manager.close may already be cancelling the owner.
        await cleaning.wait()
        closing = asyncio.create_task(self.backend.aclose())
        await asyncio.sleep(0)
        self.assertFalse(self.connection.closed)
        self.assertEqual(pending.cancelling(), 1)
        self.assertFalse(closing.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await closing
        self.assertTrue(self.connection.closed)
        self.assertEqual(self.ready.commands, [])

    async def test_close_tracks_file_io_after_ready_until_its_cleanup_finishes(self):
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        release = asyncio.Event()

        async def upload(files):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                raise

        self.ready.aupload_files.side_effect = upload
        pending = asyncio.create_task(self.backend.aupload_files([("partial", b"bytes")]))
        await entered.wait()
        closing = asyncio.create_task(self.backend.aclose())
        await cleaning.wait()
        self.assertFalse(self.connection.closed)
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        await closing
        self.assertTrue(self.connection.closed)

    async def test_close_inside_own_io_callback_cannot_deadlock_on_itself(self):
        async def skills(backend):
            await self.backend.aclose()

        self.backend._prepare_skills = skills
        result = await asyncio.wait_for(self.backend.aexecute("never"), 1)
        self.assertIsNone(result.exit_code)
        await asyncio.wait_for(self.backend.aclose(), 1)
        self.assertEqual(self.ready.commands, [])

    async def test_explicit_resume_rejection_allows_new_credentials_without_false_unknown(self):
        self.state = "suspended"
        refusal = 401

        async def reject(request):
            if request.url.path.endswith("/resume"):
                return httpx.Response(refusal, text=SECRET)
            return await self.respond(request)

        self.handler = reject
        for status in (401, 403, 429):
            refusal = status
            result = await self.backend.aexecute("never")
            self.assertIsNone(result.exit_code)
            self.assertNotIn(SECRET, result.output)
            self.assertFalse(self.backend._resume_pending)
        os.environ["TEST_INSTABOX_KEY"] = SECRET + "-new"
        self.handler = self.respond
        result = await self.backend.aexecute("explicit-but-needs-recovery-feedback")
        self.assertIn("[recovery]", result.output)
        self.assertNotIn("lifecycle_unknown", result.output)
        self.assertEqual(self.ready.commands, [])
        await self.backend.aexecute("explicit-new-call")
        self.assertEqual(self.ready.commands, ["explicit-new-call"])

    async def test_explicit_resume_rejection_does_not_make_close_unconfirmed(self):
        self.state = "suspended"

        async def reject(request):
            if request.url.path.endswith("/resume"):
                return httpx.Response(401, text=SECRET)
            return await self.respond(request)

        self.handler = reject
        await self.backend.aexecute("never")
        await self.backend.aclose()
        self.assertFalse(self.backend._resume_pending)

    async def test_ambiguous_resume_server_error_is_not_posted_again(self):
        self.state = "suspended"

        async def fail(request):
            if request.url.path.endswith("/resume"):
                return httpx.Response(503, text=SECRET)
            return await self.respond(request)

        self.handler = fail
        await self.backend.aexecute("never")
        result = await self.backend.aexecute("never-again")
        self.assertIn("lifecycle_unknown", result.output)
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)
        with self.assertRaises(CleanupUnconfirmedError):
            await self.backend.aclose()

    async def test_failed_operation_reference_is_cleared_for_external_recovery(self):
        self.state = "suspended"

        async def failed(request):
            if request.url.path.startswith("/v1/operations/"):
                return httpx.Response(200, json={"id": OPERATION, "machineId": MACHINE, "state": "failed"})
            return await self.respond(request)

        self.handler = failed
        result = await self.backend.aexecute("original-never-submitted")
        self.assertIn("operation_failed", result.output)
        self.assertIsNone(self.backend._operation_id)
        self.assertFalse(self.backend._resume_pending)
        self.state = "running"  # Independent external recovery, not an automatic retry.
        self.handler = self.respond
        result = await self.backend.aexecute("new-explicit-call")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self.ready.commands, ["new-explicit-call"])
        self.assertEqual(sum(path.startswith("/v1/operations/") for _, path in self.requests), 1)
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)

    async def test_recovery_feedback_is_async_and_acknowledged_before_consuming_pending(self):
        self.state = "suspended"
        notices = []
        accepted = False

        async def feedback(notice):
            notices.append(notice)
            return accepted

        self.backend.bind_recovery_feedback(feedback)
        first = await self.backend.aexecute("not-submitted-first")
        self.assertIn("本次环境操作未提交", first.output)
        self.assertTrue(self.backend._recovery_pending)
        self.assertEqual(self.ready.commands, [])
        self.assertIn("尚未核验", notices[0])
        self.assertIn("已从暂停状态恢复", notices[0])
        self.assertIn("不代表已经重启", notices[0])
        self.assertNotIn("未提交", notices[0])
        second = await self.backend.aexecute("not-submitted-second")
        self.assertIn("[recovery]", second.output)
        self.assertTrue(self.backend._recovery_pending)
        self.assertEqual(self.ready.commands, [])
        accepted = True
        third = await self.backend.aexecute("not-submitted-until-new-call")
        self.assertIn("[recovery]", third.output)
        self.assertFalse(self.backend._recovery_pending)
        await self.backend.aexecute("new-explicit-call")
        self.assertEqual(self.ready.commands, ["new-explicit-call"])
        self.assertEqual(len(notices), 3)
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)

    async def test_recovery_feedback_failure_does_not_consume_pending(self):
        self.state = "suspended"

        async def failed(notice):
            raise RuntimeError(SECRET)

        self.backend.bind_recovery_feedback(failed)
        result = await self.backend.aexecute("never")
        self.assertIn("[recovery]", result.output)
        self.assertNotIn(SECRET, result.output)
        self.assertTrue(self.backend._recovery_pending)
        self.assertEqual(self.ready.commands, [])

    async def test_concurrent_recovery_waiters_deliver_once_and_do_not_submit_business_io(self):
        self.state = "suspended"
        entered, release = asyncio.Event(), asyncio.Event()
        notices = []

        async def feedback(notice):
            notices.append(notice)
            entered.set()
            await release.wait()
            return True

        self.backend.bind_recovery_feedback(feedback)
        first = asyncio.create_task(self.backend.aexecute("first-never-submitted"))
        await entered.wait()
        late_skill = asyncio.Event()
        release_skill = asyncio.Event()

        async def skills(backend):
            late_skill.set()
            await release_skill.wait()

        self.skills.side_effect = skills
        late = asyncio.create_task(self.backend.aexecute("late-never-submitted"))
        await late_skill.wait()
        release.set()
        self.assertIn("[recovery]", (await first).output)
        release_skill.set()
        self.assertIn("[recovery]", (await late).output)
        self.assertEqual(len(notices), 1)
        self.assertEqual(self.ready.commands, [])
        self.assertFalse(self.backend._recovery_pending)
        await self.backend.aexecute("new-explicit-call")
        self.assertEqual(self.ready.commands, ["new-explicit-call"])

    async def test_async_recovery_delivery_lock_serializes_overlapping_callbacks(self):
        self.state = "suspended"
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def feedback(notice):
            calls.append(notice)
            entered.set()
            await release.wait()
            return True

        self.backend.bind_recovery_feedback(feedback)
        first = asyncio.create_task(self.backend.aexecute("first"))
        await entered.wait()
        second = asyncio.create_task(self.backend.aexecute("second"))
        await asyncio.sleep(0)
        self.assertEqual(len(calls), 1)
        self.assertFalse(second.done())
        release.set()
        results = await asyncio.gather(first, second)
        self.assertTrue(all("[recovery]" in result.output for result in results))
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.ready.commands, [])

    async def test_delivery_acknowledgement_cannot_clear_a_newer_recovery(self):
        self.state = "suspended"
        entered, release, second_ready = asyncio.Event(), asyncio.Event(), asyncio.Event()
        notices = []

        async def feedback(notice):
            notices.append(notice)
            if len(notices) == 1:
                entered.set()
                await release.wait()
            return True

        self.backend.bind_recovery_feedback(feedback)
        first = asyncio.create_task(self.backend.aexecute("first-never-submitted"))
        await entered.wait()
        self.ready._channel.broken = True
        replacement = ReadyBackend()
        instabox.SSHBackend.start.return_value = replacement

        async def skills(backend):
            if backend is replacement:
                second_ready.set()

        self.skills.side_effect = skills
        second = asyncio.create_task(self.backend.aexecute("second-never-submitted"))
        await second_ready.wait()
        release.set()
        results = await asyncio.gather(first, second)
        self.assertTrue(all("[recovery]" in result.output for result in results))
        self.assertEqual(len(notices), 2)
        self.assertIn("已从暂停状态恢复", notices[0])
        self.assertIn("SSH 连接或执行通道已重建", notices[1])
        self.assertFalse(self.backend._recovery_pending)
        self.assertEqual(self.ready.commands, [])
        self.assertEqual(replacement.commands, [])

    async def test_cancelled_async_feedback_retains_pending_for_next_explicit_call(self):
        self.state = "suspended"
        entered = asyncio.Event()

        async def feedback(notice):
            entered.set()
            await asyncio.Future()

        self.backend.bind_recovery_feedback(feedback)
        pending = asyncio.create_task(self.backend.aexecute("cancelled-never-submitted"))
        await entered.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(self.backend._recovery_pending)
        self.assertEqual(self.ready.commands, [])
        retry = AsyncMock(return_value=True)
        self.backend.bind_recovery_feedback(retry)
        result = await self.backend.aexecute("retry-still-never-submitted")
        self.assertIn("[recovery]", result.output)
        retry.assert_awaited_once()
        self.assertFalse(self.backend._recovery_pending)
        self.assertEqual(self.ready.commands, [])
        await self.backend.aexecute("new-explicit-call")
        self.assertEqual(self.ready.commands, ["new-explicit-call"])

    async def test_close_reports_unresponsive_io_cleanup_instead_of_claiming_success(self):
        entered = asyncio.Event()
        release = asyncio.Event()

        async def upload(files):
            entered.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                await release.wait()
                raise

        self.ready.aupload_files.side_effect = upload
        pending = asyncio.create_task(self.backend.aupload_files([("partial", b"bytes")]))
        await entered.wait()
        try:
            with patch.object(instabox, "CLOSE_LIMIT", 0.01):
                with self.assertRaisesRegex(CleanupUnconfirmedError, "I/O"):
                    await self.backend.aclose()
            self.assertTrue(self.connection.closed)
        finally:
            release.set()
            await asyncio.gather(pending, return_exceptions=True)

    async def test_close_before_resume_submission_does_not_post_or_mark_it_unknown(self):
        self.state = "suspended"
        entered = asyncio.Event()
        release = asyncio.Event()

        async def paused_status(request):
            if request.url.path.endswith(MACHINE):
                entered.set()
                await release.wait()
            return await self.respond(request)

        self.handler = paused_status
        pending = asyncio.create_task(self.backend.aexecute("never"))
        await entered.wait()
        closing = asyncio.create_task(self.backend.aclose())
        while not self.backend._closed:
            await asyncio.sleep(0)
        release.set()
        await closing
        await asyncio.gather(pending, return_exceptions=True)
        self.assertFalse(self.backend._resume_pending)
        self.assertEqual(self.requests, [("GET", "/v1/machines/" + MACHINE)])
        instabox.asyncssh.connect.assert_not_awaited()

    async def test_public_file_and_execute_return_cleanup_unknown_without_submitting(self):
        self.skills.side_effect = CleanupUnconfirmedError(SECRET)
        read = await self.backend.aread("never-read")
        execute = await self.backend.aexecute("never-execute")
        upload, = await self.backend.aupload_files([("never-upload", b"bytes")])
        download, = await self.backend.adownload_files(["never-download"])
        sync_read = await asyncio.to_thread(self.backend.read, "never-sync-read")
        sync_execute = await asyncio.to_thread(self.backend.execute, "never-sync-execute")
        for message in (
            read.error, execute.output, upload.error, download.error,
            sync_read.error, sync_execute.output,
        ):
            self.assertIn("[cleanup_unconfirmed]", message)
            self.assertIn("清理未确认", message)
            self.assertIn("本次环境操作未提交", message)
            self.assertNotIn(SECRET, message)
        self.assertIsNone(execute.exit_code)
        self.assertIsNone(sync_execute.exit_code)
        self.ready.aread.assert_not_awaited()
        self.ready.aupload_files.assert_not_awaited()
        self.ready.adownload_files.assert_not_awaited()
        self.assertEqual(self.ready.commands, [])
        self.assertFalse(self.backend._preparation_problem)  # The skill owner retains its recoverable staging ledger.

    async def test_public_file_prepare_cancel_is_not_converted_into_a_typed_error(self):
        self.skills.side_effect = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.backend.aread("never-read")
        self.ready.aread.assert_not_awaited()
        self.assertFalse(self.backend._preparation_problem)

    async def test_recovered_skill_cleanup_does_not_create_permanent_backend_debt(self):
        self.skills.side_effect = [CleanupUnconfirmedError("recoverable skill stage"), None]
        first = await self.backend.aread("never-read")
        self.assertIn("[cleanup_unconfirmed]", first.error)
        result = await self.backend.aexecute("new-explicit-call-after-stage-cleanup")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(self.ready.commands, ["new-explicit-call-after-stage-cleanup"])
        self.assertFalse(self.backend._preparation_problem)
        await self.backend.aclose()
        self.assertTrue(self.connection.closed)

    async def test_ssh_startup_cleanup_debt_survives_later_successful_io(self):
        instabox.SSHBackend.start.side_effect = CleanupUnconfirmedError(SECRET)
        first = await self.backend.aread("never-read")
        self.assertIn("[cleanup_unconfirmed]", first.error)
        self.assertNotIn(SECRET, first.error)
        self.assertTrue(self.backend._preparation_problem)
        replacement = Connection()
        instabox.asyncssh.connect.return_value = replacement
        instabox.SSHBackend.start.side_effect = None
        result = await self.backend.aexecute("new-explicit-call-on-new-session")
        self.assertEqual(result.exit_code, 0)
        self.assertTrue(self.backend._preparation_problem)
        with self.assertRaisesRegex(CleanupUnconfirmedError, "环境准备资源清理未确认"):
            await self.backend.aclose()
        self.assertTrue(replacement.closed)

    async def test_browser_configuration_and_unused_owner_close_never_wake_machine(self):
        disconnected = AsyncMock()
        config = SimpleNamespace(cdp_port=19222, profile_dir="/data/home/wb/p")
        self.backend.configure_browser(config, disconnected, start_script="/work/start_browser.py")
        await self.backend.close_browser_endpoint("http://127.0.0.1:12345")
        await self.backend.aclose()
        self.assertEqual(self.requests, [])
        disconnected.assert_not_awaited()
        self.skills.assert_not_awaited()

    async def test_browser_command_path_is_read_once_per_connection_including_concurrent_calls(self):
        self.backend._browser = SimpleNamespace(
            command_environment=AsyncMock(side_effect=lambda env, connection: env),
            connection_lost=AsyncMock(), aclose=AsyncMock(), cleanup_pending=False,
        )
        calls = []

        async def read_path(command, **kwargs):
            calls.append(command)
            await asyncio.sleep(0)
            return ExecuteResponse(output="/remote/bin", exit_code=0, truncated=False)

        self.ready.aexecute = read_path
        env = {"WANDRUN_BROWSER_CDP": "http://127.0.0.1:12345", "KEEP": "value"}
        first, second = await asyncio.gather(*(
            self.backend.browser_command_environment(env) for _ in range(2)
        ))
        third = await self.backend.browser_command_environment(env)
        self.assertEqual(calls, ['printf %s "$PATH"'])
        for mapped in (first, second, third):
            self.assertEqual(mapped["PATH"], "/data/home/wandrun-browser/agent-browser/bin:/remote/bin")
            self.assertEqual(mapped["KEEP"], "value")

        self.connection.closed = True
        replacement = ReadyBackend()
        replacement.aexecute = AsyncMock(return_value=ExecuteResponse(
            output="/new/bin", exit_code=0, truncated=False,
        ))
        instabox.asyncssh.connect.return_value = Connection()
        instabox.SSHBackend.start.return_value = replacement
        with self.assertRaisesRegex(BrowserEnvironmentError, r"\[recovery\]"):
            await self.backend.browser_command_environment(env)
        replacement.aexecute.assert_not_awaited()
        mapped = await self.backend.browser_command_environment(env)
        again = await self.backend.browser_command_environment(env)
        self.assertEqual(mapped["PATH"], "/data/home/wandrun-browser/agent-browser/bin:/new/bin")
        self.assertEqual(again["PATH"], mapped["PATH"])
        replacement.aexecute.assert_awaited_once_with('printf %s "$PATH"')

    async def test_failed_browser_path_read_is_not_cached(self):
        self.backend._browser = SimpleNamespace(
            command_environment=AsyncMock(side_effect=lambda env, connection: env),
            aclose=AsyncMock(), cleanup_pending=False,
        )
        self.ready.aexecute = AsyncMock(side_effect=[
            ExecuteResponse(output="partial", exit_code=0, truncated=True),
            ExecuteResponse(output="failed", exit_code=1, truncated=False),
            ExecuteResponse(output="", exit_code=0, truncated=False),
        ])
        env = {"WANDRUN_BROWSER_CDP": "http://127.0.0.1:12345"}
        for _ in range(2):
            with self.assertRaisesRegex(BrowserEnvironmentError, "PATH"):
                await self.backend.browser_command_environment(env)
        self.assertEqual((await self.backend.browser_command_environment(env))["PATH"],
                         "/data/home/wandrun-browser/agent-browser/bin:")
        await self.backend.browser_command_environment(env)
        self.assertEqual(self.ready.aexecute.await_count, 3)

    async def test_suspended_browser_request_revokes_old_scene_and_stops_at_recovery_barrier(self):
        self.state = "suspended"
        disconnected = AsyncMock()
        self.backend.configure_browser(
            SimpleNamespace(cdp_port=19222, profile_dir="/data/home/wb/p"),
            disconnected, start_script="/work/start_browser.py",
        )
        with self.assertRaisesRegex(BrowserEnvironmentError, r"\[recovery\]"):
            await self.backend.browser_command_environment({"WANDRUN_BROWSER_CDP": "http://127.0.0.1:12345"})
        disconnected.assert_awaited_once_with("平台恢复")
        self.assertEqual(self.backend._browser._retained, set())
        self.assertEqual(self.ready.commands, [])
        self.assertEqual(sum(path.endswith("/resume") for _, path in self.requests), 1)

    async def test_browser_cdp_request_also_stops_at_recovery_before_creating_forward(self):
        await self.backend.aexecute("before-disconnect")
        self.ready._channel.broken = True
        disconnected = AsyncMock()
        self.backend.configure_browser(
            SimpleNamespace(cdp_port=19222, profile_dir="/data/home/wb/p"),
            disconnected, start_script="/work/start_browser.py",
        )
        instabox.SSHBackend.start.return_value = ReadyBackend()
        from wandrun.config import BrowserDefinition
        from wandrun.runtime.browser.leases import BrowserLeases

        browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:1"), transport=self.backend)
        with self.assertRaisesRegex(BrowserEnvironmentError, r"\[recovery\]") as failure:
            await browser._discover_chrome()
        self.assertNotIn("Chrome 不可达", str(failure.exception))
        disconnected.assert_awaited_once_with("浏览器连接中断")
        self.assertEqual(self.backend._browser._connections, [])

    async def test_browser_operations_only_translate_controlled_environment_errors(self):
        operations = (
            self.backend.browser_cdp_url,
            lambda: self.backend.browser_command_environment({"WANDRUN_BROWSER_CDP": "http://127.0.0.1:12345"}),
        )
        for operation in operations:
            for failure, expected in (
                (instabox.InstaboxError("credentials", "未设置凭据"), "[credentials]"),
                (CleanupUnconfirmedError(SECRET), "[cleanup_unconfirmed]"),
            ):
                with self.subTest(operation=operation, failure=type(failure).__name__):
                    with patch.object(self.backend, "_ready", side_effect=failure):
                        with self.assertRaises(BrowserEnvironmentError) as caught:
                            await operation()
                    self.assertIn(expected, str(caught.exception))
                    self.assertNotIn(SECRET, str(caught.exception))
            for failure in (asyncio.CancelledError(), RuntimeError("unexpected fault")):
                with self.subTest(operation=operation, failure=type(failure).__name__):
                    with patch.object(self.backend, "_ready", side_effect=failure):
                        with self.assertRaises(type(failure)):
                            await operation()


    async def test_execute_browser_preparation_recovery_is_tool_result_and_next_call_succeeds(self):
        await self._browser_command_recovery("execute")

    async def test_exec_command_browser_preparation_recovery_is_tool_result_and_next_call_succeeds(self):
        await self._browser_command_recovery("exec_command")

    async def _browser_command_recovery(self, entry):
        import ast
        import shlex
        import sys
        import tempfile
        from pathlib import Path

        import pydantic_monty as pm

        from wandrun.config import BrowserDefinition
        from wandrun.integrations.local_processes import ProcessTable
        from wandrun.integrations.shell_backend import ManagedShellBackend
        from wandrun.runtime.browser.leases import BrowserLeases
        from wandrun.runtime.communication.workers import WorkerManager
        from wandrun.runtime.execution.code_mode import CodeModeCatalog, code_mode_tool
        from wandrun.runtime.execution.files import TaskBackend, TaskFiles
        from wandrun.runtime.execution.process_tools import process_tools

        results = []
        invoke = None

        async def run(prompts, task_id):
            if entry == "execute":
                message = await invoke.ainvoke({
                    "type": "tool_call", "id": "recovery", "name": "run_code",
                    "args": {"code": f"print(await execute({command!r}))"},
                })
                self.assertEqual(message.status, "success", message.content)
                results.append(ast.literal_eval(message.content.split("输出：\n", 1)[1]))
            else:
                results.append(await invoke.ainvoke(
                    {"command": command}, config={"configurable": {"thread_id": task_id}},
                ))
            return "done"

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root / "submitted"
            script = (
                "import json,os,pathlib,urllib.request; "
                f"pathlib.Path({str(marker)!r}).open('a').write('submitted\\n'); "
                "print(json.load(urllib.request.urlopen("
                "os.environ['WANDRUN_BROWSER_CDP']+'/json/wandrun/status'))['state'])"
            )
            command = f"{shlex.quote(sys.executable)} -c {shlex.quote(script)}"
            manager = WorkerManager(run)
            browser = BrowserLeases(BrowserDefinition("http://127.0.0.1:1"), transport=self.backend)
            browser.register("root", "root", "worker", "worker")
            self.backend.configure_browser(
                SimpleNamespace(cdp_port=19222, profile_dir="/data/home/wb/p"),
                browser.connection_lost, start_script="/work/start_browser.py",
            )
            # Keep provider preparation real; only replace the remote byte relay
            # with the task's actual host endpoint and execute on a private shell.
            self.backend._browser.command_environment = AsyncMock(side_effect=lambda env, connection: env)
            table = ProcessTable(cwd=root, log_dir=root / "logs", termination_grace=0.1)
            shell = ManagedShellBackend(root_dir=root, virtual_mode=False, inherit_env=True)
            try:
                old = await browser.command_environment("root")
                self.ready._channel.broken = True
                replacement = ReadyBackend()
                replacement.aexecute = shell.aexecute
                instabox.SSHBackend.start.return_value = replacement
                instabox.asyncssh.connect.return_value = Connection()
                feedback = AsyncMock(return_value=True)
                self.backend.bind_recovery_feedback(feedback)
                files = TaskFiles(root, manager, {"worker": ("local", str(root))}, conversation_workdirs=False)
                async with pm.AsyncMonty() as pool:
                    invoke = (code_mode_tool(
                        pool, TaskBackend(self.backend, files, task_id="root", browser=browser),
                        CodeModeCatalog([], []),
                    ) if entry == "execute" else process_tools(manager, table, browser=browser)[0])
                    manager.start("reopen", "root")
                    first = await manager.wait("root")
                    self.assertEqual(first["status"], "completed", first)
                    error = results[0].get("error", results[0].get("output", ""))
                    self.assertIn("[recovery]", error)
                    self.assertIn("尚未核验", error)
                    self.assertIn("本次命令未提交", error + results[0].get("note", ""))
                    self.assertFalse(marker.exists())
                    async with CLIENT(trust_env=False) as client:
                        with self.assertRaises(httpx.ConnectError):
                            await client.get(old["WANDRUN_BROWSER_CDP"] + "/json/wandrun/status")
                    manager.start("check and retry", "root")
                    second = await manager.wait("root")
                    self.assertEqual(second["status"], "completed", second)
                    self.assertEqual(results[1]["exit_code"], 0, results[1])
                    self.assertEqual(results[1]["output"], "unallocated\n")
                    self.assertEqual(marker.read_text(), "submitted\n")
                    feedback.assert_awaited_once()
            finally:
                await manager.close()
                await table.aclose()
                await browser.aclose()
                shell.close()

class SSHStartupCompensationTests(unittest.IsolatedAsyncioTestCase):
    def connection(self, upload_error, cleanup_error=None):
        sftp = SimpleNamespace(
            exists=AsyncMock(return_value=False), put=AsyncMock(side_effect=upload_error),
            posix_rename=AsyncMock(), remove=AsyncMock(side_effect=cleanup_error),
            exit=lambda: None, wait_closed=AsyncMock(),
        )
        connection = SimpleNamespace(
            run=AsyncMock(return_value=SimpleNamespace(exit_status=0)),
            start_sftp_client=AsyncMock(return_value=sftp), create_process=AsyncMock(),
        )
        return connection, sftp

    async def test_partial_session_upload_failure_or_cancel_removes_its_stage(self):
        for error in (OSError("upload failed"), asyncio.CancelledError()):
            with self.subTest(error=type(error).__name__):
                connection, sftp = self.connection(error)
                with self.assertRaises(type(error)):
                    await instabox.SSHBackend.start(
                        connection, label="test", workdir="/data/work", timeout=10, termination_grace=0.1,
                    )
                temporary = sftp.put.await_args.args[1]
                sftp.remove.assert_awaited_once_with(temporary)
                sftp.posix_rename.assert_not_awaited()
                connection.create_process.assert_not_awaited()

    async def test_session_upload_cleanup_failure_is_not_suppressed(self):
        connection, sftp = self.connection(OSError("upload failed"), OSError("cleanup failed"))
        with self.assertRaises(CleanupUnconfirmedError):
            await instabox.SSHBackend.start(
                connection, label="test", workdir="/data/work", timeout=10, termination_grace=0.1,
            )
        connection.create_process.assert_not_awaited()
