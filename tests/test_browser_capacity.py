"""Environment-wide admission and cleanup accounting at the controlled CDP boundary."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from wandrun.config import BrowserDefinition
from wandrun.runtime.browser.cdp import CDPError, CDPRejected
from wandrun.runtime.browser.leases import BrowserLeases, BrowserRejected, _Lease
from wandrun.runtime.session import Runtime


class PageSocket:
    def __init__(self, url, on_event):
        self.on_event = on_event

    async def open(self):
        pass

    async def close(self):
        pass

    async def call(self, method, params=None, *, timeout=10, before_send=None):
        if before_send is not None:
            before_send()
        if method == "Page.navigate":
            await self.on_event({"method": "Page.navigatedWithinDocument", "params": {"url": params["url"]}})
        return {}


class Chrome:
    """Only Chrome I/O is replaced: reservation, discovery and ownership are real."""

    def __init__(self, browser):
        self.browser = browser
        self.targets = {}
        self.sent = asyncio.Queue()
        self.release = asyncio.Event()
        self.release.set()
        self.discover = True
        self.lost_reply = False
        self.reject_create = False
        self.reject_close = False
        self.next_id = 0

    async def call(self, method, params=None, **kwargs):
        if method == "Target.createTarget":
            if self.reject_create:
                raise CDPRejected("create explicitly rejected")
            self.next_id += 1
            target = f"target-{self.next_id}"
            info = {"type": "page", "targetId": target, "url": params["url"]}
            self.targets[target] = info
            if self.discover:
                await self.browser._chrome_event({"method": "Target.targetCreated", "params": {"targetInfo": info}})
            self.sent.put_nowait(target)
            await self.release.wait()
            if self.lost_reply:
                raise CDPError("create reply lost")
            return {"targetId": target}
        if method == "Target.closeTarget":
            if self.reject_close:
                return {"success": False}
            self.targets.pop(params["targetId"], None)
            return {"success": True}
        if method == "Target.getTargets":
            return {"targetInfos": list(self.targets.values())}
        raise AssertionError(method)


class BrowserCapacityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.patch = patch("wandrun.runtime.browser.leases.CDPSocket", PageSocket)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def browser(self, limit=2, name="local"):
        browser = BrowserLeases(BrowserDefinition("http://unused", max_pages=limit),
                                environment_id=name, environment_name=name)
        browser._browser_ws = "ws://unused/devtools/browser/test"
        browser._chrome = Chrome(browser)
        return browser

    def owner(self, browser, task, *, human=True):
        browser.register(task, "root", "agent", "entry")
        lease = _Lease(task, task, "root", "agent", "entry", state="human" if human else "agent")
        browser._leases[task] = lease
        browser._tasks[task].lease = lease
        return lease

    async def test_concurrent_leases_reserve_before_cdp_and_transfer_without_double_count(self):
        browser = self.browser(1)
        first, second = self.owner(browser, "first"), self.owner(browser, "second")
        updates = []
        browser.subscribe(second.id, updates.append)
        browser._chrome.release.clear()
        creating = asyncio.create_task(browser.new_page(first.id, first.epoch))
        await asyncio.wait_for(browser._chrome.sent.get(), 1)
        self.assertEqual(browser.capacity(), {
            "pages_used": 1, "pages_registered": 0, "pages_creating": 1,
            "pages_pending_cleanup": 0, "pages_limit": 1,
        })
        with self.assertRaisesRegex(BrowserRejected, "页面总数已达上限"):
            await browser.new_page(second.id, second.epoch)
        self.assertTrue(browser._chrome.sent.empty())
        self.assertEqual(updates[-1]["id"], second.id)
        self.assertEqual(updates[-1]["capacity"]["pages_creating"], 1)
        browser._chrome.release.set()
        target = await creating
        self.assertEqual(browser.detail(first.id)["pages"][0]["id"], target)
        self.assertEqual(browser.capacity()["pages_used"], 1)
        self.assertEqual(browser.capacity()["pages_registered"], 1)
        self.assertEqual(updates[-1]["capacity"]["pages_registered"], 1)

    async def test_popup_and_agent_creation_compete_and_failed_popup_close_stays_charged(self):
        browser = self.browser(2)
        agent, popup_owner = self.owner(browser, "agent"), self.owner(browser, "popup")
        opener = await browser.new_page(popup_owner.id, popup_owner.epoch)
        browser._chrome.release.clear()
        creating = browser._start_page(agent, "https://example.test/")
        await asyncio.wait_for(browser._chrome.sent.get(), 1)  # opener's create
        await asyncio.wait_for(browser._chrome.sent.get(), 1)  # Agent's create
        info = {"type": "page", "targetId": "popup-target", "openerId": opener, "url": "about:blank"}
        browser._chrome.targets[info["targetId"]] = info
        browser._chrome.reject_close = True
        try:
            with self.assertRaises(CDPError):
                await browser._chrome_event({"method": "Target.targetCreated", "params": {"targetInfo": info}})
            self.assertIn("popup-target", popup_owner.rejected_popups)
            self.assertEqual(browser.capacity()["pages_used"], 3)
            self.assertEqual(browser.capacity()["pages_pending_cleanup"], 1)
            with self.assertRaises(BrowserRejected):
                browser._start_page(agent, "about:blank")
        finally:
            browser._chrome.reject_close = False
            browser._chrome.release.set()
            await creating
        await browser._claim_popup(info)
        self.assertEqual(browser.capacity()["pages_used"], 2)
        self.assertNotIn("popup-target", popup_owner.rejected_popups)

    async def test_multiple_unknown_results_and_late_discovery_do_not_release_or_duplicate(self):
        browser = self.browser(2)
        lease = self.owner(browser, "unknown")
        browser._chrome.discover = False
        browser._chrome.lost_reply = True
        for _ in range(2):
            with self.assertRaises(CDPError):
                await browser.new_page(lease.id, lease.epoch)
        self.assertEqual(browser.capacity()["pages_pending_cleanup"], 2)
        self.assertEqual(len(lease.uncertain_creations), 2)
        with self.assertRaises(BrowserRejected):
            await browser.new_page(lease.id, lease.epoch)
        for info in list(browser._chrome.targets.values()):
            await browser._chrome_event({"method": "Target.targetCreated", "params": {"targetInfo": info}})
        self.assertEqual(browser.capacity()["pages_used"], 2)
        await browser.close(lease.id)
        self.assertEqual(browser.capacity()["pages_used"], 0)
        self.assertEqual(lease.state, "released")

    async def test_explicit_create_failure_returns_budget_but_unconfirmed_close_does_not(self):
        browser = self.browser(1)
        lease = self.owner(browser, "owner")
        browser._chrome.reject_create = True
        with self.assertRaises(CDPRejected):
            await browser.new_page(lease.id, lease.epoch)
        self.assertEqual(browser.capacity()["pages_used"], 0)
        browser._chrome.reject_create = False
        target = await browser.new_page(lease.id, lease.epoch)
        browser._chrome.reject_close = True
        with self.assertRaisesRegex(BrowserRejected, "页面关闭未确认"):
            await browser.close_page(lease.id, target)
        self.assertEqual(browser.capacity()["pages_pending_cleanup"], 1)
        with self.assertRaises(BrowserRejected):
            await browser.new_page(lease.id, lease.epoch)
        browser._chrome.reject_close = False
        await browser.close_page(lease.id, target)
        self.assertEqual(browser.capacity()["pages_used"], 0)
        self.assertEqual(lease.state, "human")

    async def test_zero_page_human_owner_must_compete_again_after_another_lease_uses_budget(self):
        browser = self.browser(1)
        first, second = self.owner(browser, "first"), self.owner(browser, "second")
        target = await browser.new_page(first.id, first.epoch)
        await browser.close_page(first.id, target)
        self.assertEqual((first.state, first.pages), ("human", {}))
        other = await browser.new_page(second.id, second.epoch)
        with self.assertRaises(BrowserRejected):
            await browser.new_page(first.id, first.epoch)
        await browser.close_page(second.id, other)
        reopened = await browser.new_page(first.id, first.epoch)
        self.assertNotEqual(target, reopened)

    async def test_environments_are_independent_and_old_lease_routes_by_identity_not_current_choice(self):
        left, right = self.browser(1, "left"), self.browser(1, "right")
        first, second = self.owner(left, "old"), self.owner(right, "new")
        await left.new_page(first.id, first.epoch)
        await right.new_page(second.id, second.epoch)
        runtime = SimpleNamespace(browsers={"left": left, "alias": left, "right": right},
                                  environment_definitions={"agent": "right"})
        self.assertIs(Runtime.browser_for_lease(runtime, first.id), left)
        self.assertIs(Runtime.browser_for_lease(runtime, second.id), right)
        await Runtime.browser_for_lease(runtime, first.id).close(first.id)
        self.assertEqual(left.capacity()["pages_used"], 0)
        self.assertEqual(right.capacity()["pages_used"], 1)

    async def test_external_page_counts_without_owner_and_stale_discovery_cannot_resurrect_it(self):
        browser = self.browser(1)
        lease = self.owner(browser, "owner")
        info = {"type": "page", "targetId": "external", "url": "https://external.test/"}
        browser._chrome.targets["external"] = info
        await browser._chrome_event({"method": "Target.targetCreated", "params": {"targetInfo": info}})
        self.assertEqual(browser.capacity()["pages_pending_cleanup"], 1)
        self.assertEqual(lease.targets, set())
        with self.assertRaises(BrowserRejected):
            await browser.new_page(lease.id, lease.epoch)
        await browser._close_target("external")
        await browser._chrome_event({"method": "Target.targetInfoChanged", "params": {"targetInfo": info}})
        self.assertEqual(browser.capacity()["pages_used"], 0)

    async def test_old_census_cannot_retire_another_leases_newly_claimed_popup(self):
        browser = self.browser(2)
        closing = self.owner(browser, "closing")
        active = self.owner(browser, "active")
        opener = await browser.new_page(active.id, active.epoch)
        captured, resume = asyncio.Event(), asyncio.Event()
        call = browser._chrome.call

        async def delayed_census(method, params=None, **kwargs):
            result = await call(method, params, **kwargs)
            if method == "Target.getTargets":
                captured.set()
                await resume.wait()
            return result

        with patch.object(browser._chrome, "call", side_effect=delayed_census):
            census = asyncio.create_task(browser._remaining_targets(closing))
            try:
                await asyncio.wait_for(captured.wait(), 1)
                info = {"type": "page", "targetId": "new-popup", "openerId": opener, "url": "about:blank"}
                browser._chrome.targets["new-popup"] = info
                # Independent relay discovery can claim before the manager's
                # browser-level event worker reaches this same target.
                await browser._claim_popup(info)
            finally:
                resume.set()
            self.assertEqual(await census, set())
        self.assertNotIn("new-popup", browser._retired_targets)
        self.assertIn("new-popup", active.pages)
        self.assertEqual(browser.capacity()["pages_used"], 2)
        with self.assertRaises(BrowserRejected):
            browser._start_page(active, "about:blank")
