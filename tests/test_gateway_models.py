"""模型选择、默认设置与故障契约，经 HTTP 和真实订阅缓存组件验证。"""

import base64
import json
from pathlib import Path
import tempfile
import unittest

import httpx

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore
from wandrun.gateway.subscription import SubscriptionData
from codex_test_home import isolate_codex_home



def model_entry(identity="offline", efforts=("low", "medium", "xhigh", "ultra"), default="medium"):
    return {
        "slug": identity, "display_name": identity, "description": "测试目录",
        "default_reasoning_level": default, "visibility": "list", "priority": 1,
        "context_window": 272000, "max_context_window": 872000,
        "supported_reasoning_levels": [{"effort": effort, "description": effort} for effort in efforts],
    }


def subscription_fixture(case, store):
    """只替换上游 HTTP 与凭据文件；目录解析、缓存及持久化保持真实。"""
    home = isolate_codex_home(case)
    claims = base64.urlsafe_b64encode(json.dumps({"sub": "test-user"}).encode()).decode().rstrip("=")
    (home / "auth.json").write_text(json.dumps({
        "auth_mode": "chatgpt", "tokens": {"access_token": f"test.{claims}.test", "account_id": "test-account"},
    }))
    state = {"models": [model_entry()], "status": 200, "calls": 0}

    def respond(request):
        state["calls"] += 1
        if request.url.path.endswith("/usage"):
            return httpx.Response(state["status"], json={
                "plan_type": "plus", "rate_limit": {"allowed": True, "limit_reached": False,
                    "primary_window": {"used_percent": 12, "limit_window_seconds": 604800, "reset_at": 1800000000}},
            })
        return httpx.Response(state["status"], json={"models": state["models"]})

    subscription = SubscriptionData(store, transport=httpx.MockTransport(respond))
    case.addAsyncCleanup(subscription.aclose)
    return subscription, state


class GatewayModelTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = GatewayStore(Path(self.directory.name) / "gateway.sqlite")
        self.addCleanup(self.store.close)
        self.store.import_agents(AgentCatalog("entry", {
            "other": AgentDefinition("其他", "完成", "not-default", environment="local"),
            "entry": AgentDefinition("入口", "完成", "legacy", reasoning_effort="custom", environment="local"),
        }))
        self.subscription, self.upstream = subscription_fixture(self, self.store)
        self.gateway = Gateway(self.store, self.subscription)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "test")),
            base_url="http://gateway", headers={"Authorization": "Bearer test"},
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_default_priority_and_no_arbitrary_agent_fallback(self):
        entry = (await self.client.get("/settings")).json()
        self.assertEqual(entry, {"default_model": "legacy", "default_reasoning_effort": "custom"})
        self.assertEqual(self.upstream["calls"], 0)
        saved = await self.client.put("/settings", json={"default_model": "offline", "default_reasoning_effort": "xhigh"})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual((await self.client.get("/settings")).json(), saved.json())
        # 无默认入口时不选其他 Agent，而选目录首项；不返回旧模板的静态兜底。
        empty = GatewayStore(Path(self.directory.name) / "no-default.sqlite")
        self.addCleanup(empty.close)
        empty.import_agents(AgentCatalog(None, {"other": AgentDefinition("其他", "完成", "not-default", environment="local")}))
        self.gateway.store = empty
        self.assertEqual((await self.client.get("/settings")).json(), {
            "default_model": "offline", "default_reasoning_effort": "medium",
        })
        self.upstream["models"] = []
        await self.client.get("/models?refresh=true")
        self.assertEqual((await self.client.get("/settings")).json(), {
            "default_model": None, "default_reasoning_effort": None,
        })

    async def test_directory_keeps_current_context_window_through_cache_and_persistence(self):
        first = (await self.client.get("/models")).json()
        self.assertEqual(first["models"][0]["context_window"], 272000)
        self.upstream["status"] = 503
        self.assertEqual((await self.client.get("/models?refresh=true")).json(), first)
        replacement = SubscriptionData(self.store, transport=httpx.MockTransport(
            lambda request: httpx.Response(503)
        ))
        self.addAsyncCleanup(replacement.aclose)
        self.assertEqual((await replacement.models())["models"][0]["context_window"], 272000)

    async def test_new_pairs_rejected_but_unchanged_settings_survive_outage(self):
        self.upstream["status"] = 503
        same = {"default_model": "legacy", "default_reasoning_effort": "custom"}
        response = await self.client.put("/settings", json=same)
        self.assertEqual(response.status_code, 200)
        response = await self.client.put("/settings", json={"default_model": "offline", "default_reasoning_effort": "xhigh"})
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "model_catalog_unavailable"))
        self.assertEqual((await self.client.get("/settings")).json(), same)
        self.upstream["status"] = 200
        for model, effort in (("offline", "max"), ("offline", "ultra"), ("missing", "low"), ("offline", ""), ("offline", 2)):
            with self.subTest(model=model, effort=effort):
                response = await self.client.put("/settings", json={"default_model": model, "default_reasoning_effort": effort})
                self.assertEqual(response.status_code, 400, response.text)
        response = await self.client.put("/settings", json={"default_model": "offline", "default_reasoning_effort": None})
        self.assertEqual(response.status_code, 200)

    async def test_first_failure_fallback_empty_and_removed_template(self):
        self.upstream["status"] = 503
        response = await self.client.get("/models")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (503, "model_catalog_unavailable"))
        response = await self.client.get("/usage/subscription")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["auth"]["status"], "temporarily_unavailable")
        self.assertIsNone(response.json()["usage"])
        self.upstream["status"] = 200
        good = (await self.client.get("/models")).json()
        usage = (await self.client.get("/usage/subscription")).json()
        self.assertEqual(usage["usage"]["windows"][0]["window_seconds"], 604800)
        self.upstream["status"] = 500
        self.assertEqual((await self.client.get("/models?refresh=true")).json(), good)
        stale = (await self.client.get("/usage/subscription?refresh=true")).json()
        self.assertEqual(stale["usage"], usage["usage"])
        self.assertEqual(stale["auth"]["status"], "temporarily_unavailable")
        self.upstream["status"] = 200
        self.upstream["models"] = []
        self.assertEqual((await self.client.get("/models?refresh=true")).json()["models"], [])
        self.assertEqual((await self.client.get("/agent-templates")).status_code, 404)

    async def test_auth_query_validation_and_daily_usage(self):
        for path in ("/models", "/settings", "/usage/subscription", "/usage/agents"):
            self.assertEqual((await self.client.get(path, headers={"Authorization": "wrong"})).status_code, 401)
        for query in ("days=0", "days=-1", "days=x", "days=1.5"):
            self.assertEqual((await self.client.get(f"/usage/agents?{query}")).status_code, 400)
        for path in ("/models?refresh=1", "/usage/subscription?refresh=yes"):
            self.assertEqual((await self.client.get(path)).status_code, 400)
        from datetime import datetime
        self.gateway.on_usage({"agent": "entry", "finished_at": datetime.now().astimezone().isoformat(),
                               "input_tokens": 20, "cached_input_tokens": 5, "output_tokens": 8, "reasoning_tokens": 3})
        result = (await self.client.get("/usage/agents?days=7")).json()
        entry = next(item for item in result["agents"] if item["agent_id"] == "entry")
        self.assertEqual((entry["input_tokens"], entry["cached_input_tokens"], entry["output_tokens"], entry["reasoning_output_tokens"]), (20, 5, 8, 3))
        self.assertEqual(entry["daily"][0]["date"], datetime.now().astimezone().date().isoformat())
