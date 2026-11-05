"""Picker API uses read-only provider pages and publishes only safe machine metadata."""

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from wandrun.config import AgentCatalog, EnvironmentDefinition, load_config_for_catalog
from wandrun.gateway.http import create_app
from wandrun.gateway.service import Gateway
from wandrun.gateway.store import GatewayStore


class EnvironmentChoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = GatewayStore(Path(temporary.name) / "gateway.sqlite")
        self.addCleanup(self.store.close)
        self.gateway = Gateway(self.store)
        self.gateway.runtime = SimpleNamespace(environment_definitions={
            "local": EnvironmentDefinition(type="local"),
        })
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=create_app(self.gateway, "test-token")),
            base_url="http://gateway", headers={"Authorization": "Bearer test-token"},
        )
        self.addAsyncCleanup(self.client.aclose)

    def provider(self, handler):
        original = httpx.AsyncClient
        transport = httpx.MockTransport(handler)
        return patch("wandrun.gateway.environments.httpx.AsyncClient",
                     side_effect=lambda **kwargs: original(transport=transport, **kwargs))

    async def test_provider_pages_are_whitelisted_and_aliases_share_machine_selection(self):
        first, second = "m_" + "a" * 26, "m_" + "b" * 26
        definition = EnvironmentDefinition(type="instabox", machine_id=first,
                                           workdir="/data/existing", api_key_env="CHOICE_TEST_KEY")
        self.gateway.runtime.environment_definitions.update({"cloud": definition, "alias": definition})
        calls = []

        def upstream(request):
            calls.append((request.method, request.url.path, dict(request.url.params)))
            self.assertEqual(request.headers["X-API-Key"], "host-test-value")
            machine = {"id": first, "name": "Existing machine", "state": "suspended",
                       "orgId": "not-public", "metadata": {"private": "not-public"}, "vault": {"private": True}}
            if request.url.params.get("cursor") == "page+2":
                machine = {**machine, "id": second, "name": "Other machine", "state": "running"}
                cursor = None
            else:
                cursor = "page+2"
            return httpx.Response(200, json={"machines": [machine, machine], "nextCursor": cursor})

        with patch.dict(os.environ, {"CHOICE_TEST_KEY": "host-test-value"}), self.provider(upstream):
            one = await self.client.get("/execution-environments")
            self.assertEqual(one.status_code, 200, one.text)
            body = one.json()
            self.assertEqual(body["next_cursor"], "page+2")
            self.assertEqual(body["environments"], [
                {"id": "local", "name": "Local", "type": "local", "status": None},
                {"id": "cloud", "machine_id": first, "name": "Existing machine", "type": "instabox", "status": "suspended"},
            ])
            two = await self.client.get("/execution-environments", params={"cursor": body["next_cursor"]})
            self.assertEqual(two.status_code, 200, two.text)
            self.assertIsNone(two.json()["next_cursor"])
            selected = two.json()["environments"][1]
            self.assertEqual(selected["machine_id"], second)
            binding = self.gateway.runtime.environment_definitions[selected["id"]]
            self.assertEqual((binding.machine_id, binding.workdir), (second, "/data/home/wandrun"))
            self.assertEqual(self.store.environment_definitions(), {})  # reading the picker does not persist a selection
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "environments.toml"
                path.write_text(
                    'default = "cloud"\n[environments.cloud]\ntype = "instabox"\n'
                    f'machine_id = "{second}"\nworkdir = "/data/home/wandrun"\n'
                    '[environments.cloud.browser]\n',
                )
                parsed = load_config_for_catalog(
                    AgentCatalog(None, {}), None, path, mcp_servers={},
                ).environments["cloud"]
            self.assertEqual(binding.browser, parsed.browser)
            self.assertEqual(
                (binding.browser.cdp_port, binding.browser.profile_dir,
                 binding.browser.max_pages, binding.browser.idle_timeout),
                (9222, "/data/home/wandrun-browser/profile", 8, 7200),
            )
        self.assertEqual(calls, [
            ("GET", "/v1/machines", {"limit": "50"}),
            ("GET", "/v1/machines", {"limit": "50", "cursor": "page+2"}),
        ])

    async def test_failure_preserves_bindings_and_never_returns_provider_body_or_host_key(self):
        before = dict(self.gateway.runtime.environment_definitions)
        with patch.dict(os.environ, {"INSTABOX_API_KEY": "host-test-value"}), self.provider(
            lambda request: httpx.Response(403, json={"error": "provider-private-body"}),
        ):
            response = await self.client.get("/execution-environments")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "environment_catalog_unavailable")
        self.assertNotIn("provider-private-body", response.text)
        self.assertNotIn("host-test-value", response.text)
        self.assertEqual(self.gateway.runtime.environment_definitions, before)

    async def test_empty_catalog_and_authentication_have_no_machine_side_effects(self):
        calls = []
        def upstream(request):
            calls.append(request.method)
            return httpx.Response(200, json={"machines": [], "nextCursor": None})
        with patch.dict(os.environ, {"INSTABOX_API_KEY": "host-test-value"}), self.provider(upstream):
            rejected = await self.client.get("/execution-environments", headers={"Authorization": "Bearer wrong"})
            self.assertEqual(rejected.status_code, 401)
            self.assertEqual(calls, [])
            response = await self.client.get("/execution-environments")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual([item["type"] for item in response.json()["environments"]], ["local"])
        self.assertEqual(calls, ["GET"])
