"""A request's cancellation/deadline must not restart another request's decision."""

import asyncio
import unittest

from wandrun.integrations.cleanup import Batch, CleanupOperation


class CleanupDecisionTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_first_waiter_preserves_shared_pending_decision(self):
        batch = Batch()
        first = CleanupOperation(asyncio.get_running_loop().time() + 1, batch=batch)
        second = CleanupOperation(first.deadline + 1, batch=batch)
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def connect(deadline):
            calls.append(deadline)
            entered.set()
            await release.wait()
            return "connected"

        async def wait(operation):
            return await operation.decide("machine", connect)

        waiter = asyncio.create_task(wait(first))
        await entered.wait()
        other = asyncio.create_task(wait(second))
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        release.set()
        self.assertEqual(await other, "connected")
        self.assertEqual(await second.decide("machine", connect), "connected")
        self.assertEqual(calls, [first.deadline])

    async def test_decision_expires_at_first_deadline_without_restart(self):
        loop = asyncio.get_running_loop()
        first = CleanupOperation(loop.time() + 0.02)
        second = CleanupOperation(first.deadline + 1, batch=first.batch)
        calls, closed = [], []

        async def connect(deadline):
            calls.append(deadline)
            try:
                await asyncio.Future()
            finally:
                closed.append(loop.time())

        with self.assertRaises(TimeoutError):
            await first.decide("machine", connect)
        with self.assertRaises(TimeoutError):
            await second.decide("machine", connect)
        self.assertEqual(calls, [first.deadline])
        self.assertLessEqual(closed[0], first.deadline + 0.05)

    async def test_disabled_or_expired_waiter_does_not_poison_live_request(self):
        loop = asyncio.get_running_loop()
        batch = Batch()
        calls = []

        async def connect(deadline):
            calls.append(deadline)
            return "connected"

        disabled = CleanupOperation(loop.time() + 1, remote=False, batch=batch)
        expired = CleanupOperation(loop.time(), batch=batch)
        live = CleanupOperation(loop.time() + 1, batch=batch)
        for request in (disabled, expired):
            with self.assertRaises(OSError):
                await request.decide("machine", connect)
        self.assertEqual(await live.decide("machine", connect), "connected")
        self.assertEqual(calls, [live.deadline])

    async def test_eager_concurrent_first_decision_retains_one_failure(self):
        loop = asyncio.get_running_loop()
        operation = CleanupOperation(loop.time() + 1)
        calls = []

        async def failed(deadline):
            calls.append(deadline)
            raise OSError("suspended")

        old_factory = loop.get_task_factory()
        loop.set_task_factory(asyncio.eager_task_factory)
        try:
            results = await asyncio.gather(
                operation.decide("machine", failed), operation.decide("machine", failed),
                return_exceptions=True,
            )
        finally:
            loop.set_task_factory(old_factory)
        self.assertEqual([str(result) for result in results], ["suspended", "suspended"])
        self.assertEqual(calls, [operation.deadline])
