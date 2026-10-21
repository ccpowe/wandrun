"""Gateway usage persistence and completed-request observer behavior."""

import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime, time, timedelta
from pathlib import Path
from unittest.mock import patch

from wandrun.config import AgentCatalog, AgentDefinition
from wandrun.gateway.store import GatewayStore
from wandrun.metrics import RunMetrics, record_request, summarize_log


def definition():
    return AgentDefinition(
        description="描述", system_prompt="提示", model="offline", environment="local"
    )


def local_noon(day):
    return datetime.combine(day, time(12)).timestamp()


class UsageStoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "gateway.sqlite"

    def test_settings_replace_effort_and_survive_restart(self):
        with closing(GatewayStore(self.path)) as store:
            self.assertIsNone(store.get_model_settings())
            store.import_agents(AgentCatalog("planner", {"planner": definition()}))
            store.set_model_settings("gpt-first", "high")
            self.assertEqual(store.get_model_settings(), {
                "default_model": "gpt-first", "default_reasoning_effort": "high",
            })
            store.set_model_settings("gpt-second", None)
            self.assertEqual(store.agent_catalog().main_agent, "planner")
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual(store.get_model_settings(), {
                "default_model": "gpt-second", "default_reasoning_effort": None,
            })

    def test_snapshot_recovers_per_identity_version_kind_and_replaces(self):
        model = {
            "id": "visible", "display_name": "Visible", "description": "说明",
            "default_reasoning_effort": "medium",
            "supported_reasoning_efforts": [{"effort": "max", "description": "strong"}],
            "visibility": "list", "priority": 4,
        }
        snapshot = {"models": [model], "fetched_at": 123.5}
        usage = {
            "plan_type": "plus", "allowed": True, "limit_reached": False,
            "windows": [{"name": "weekly", "used_percent": 20.0,
                         "window_seconds": 604800, "reset_at": 100.0}],
            "fetched_at": 124.0,
        }
        with closing(GatewayStore(self.path)) as store:
            store.save_subscription_snapshot("models", "opaque-a", "0.157.1", snapshot)
            store.save_subscription_snapshot("usage", "opaque-a", "0.157.1", usage)
            self.assertIsNone(store.load_subscription_snapshot("models", "opaque-b", "0.157.1"))
            self.assertIsNone(store.load_subscription_snapshot("models", "opaque-a", "0.158.0"))
            self.assertIsNone(store.load_subscription_snapshot("usage", "opaque-b", "0.157.1"))
            self.assertEqual(
                store.load_subscription_snapshot("models", "opaque-a", "0.157.1"), snapshot
            )
            store.save_subscription_snapshot("models", "opaque-a", "0.157.1", {
                "fetched_at": 125.0, "models": [],
            })
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual(store.load_subscription_snapshot("models", "opaque-a", "0.157.1"), {
                "fetched_at": 125.0, "models": [],
            })
            self.assertEqual(
                store.load_subscription_snapshot("usage", "opaque-a", "0.157.1"), usage
            )

    @patch("wandrun.gateway.store.date")
    def test_usage_sums_by_local_day_bounds_and_cascades_on_delete(self, calendar):
        today = date(2025, 1, 10)
        calendar.today.return_value = today
        calendar.fromordinal.side_effect = date.fromordinal
        yesterday = today - timedelta(days=1)
        old = today - timedelta(days=2)
        with closing(GatewayStore(self.path)) as store:
            store.import_agents(AgentCatalog("a", {"a": definition(), "b": definition()}))
            store.record_agent_usage("a", {
                "input_tokens": 10, "cached_input_tokens": 3,
                "output_tokens": 5, "reasoning_tokens": 2,
            }, at=local_noon(today))
            store.record_agent_usage("a", {
                "input_tokens": 7, "cached_input_tokens": None,
                "output_tokens": 4, "reasoning_tokens": 1,
            }, at=local_noon(today))
            store.record_agent_usage("a", {
                "input_tokens": 2, "cached_input_tokens": 1,
                "output_tokens": 3, "reasoning_tokens": None,
            }, at=local_noon(yesterday))
            store.record_agent_usage("a", {"input_tokens": 99}, at=local_noon(old))
            store.record_agent_usage("b", {"input_tokens": None}, at=local_noon(today))
            self.assertEqual(store.agent_usage(1), [{
                "agent_id": "a", "input_tokens": 17, "cached_input_tokens": 3,
                "output_tokens": 9, "reasoning_output_tokens": 3,
                "daily": [{"date": today.isoformat(), "input_tokens": 17,
                           "cached_input_tokens": 3, "output_tokens": 9,
                           "reasoning_output_tokens": 3}],
            }, {
                "agent_id": "b", "input_tokens": 0, "cached_input_tokens": 0,
                "output_tokens": 0, "reasoning_output_tokens": 0, "daily": [],
            }])
            self.assertEqual(store.agent_usage(2)[0]["input_tokens"], 19)
            self.assertEqual([item["date"] for item in store.agent_usage(2)[0]["daily"]],
                             [yesterday.isoformat(), today.isoformat()])
            for invalid in (0, -1, True, 1.5, "2"):
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    store.agent_usage(invalid)
            with self.assertRaises(ValueError):
                store.record_agent_usage("a", {"input_tokens": -1}, at=local_noon(today))
            with self.assertRaises(sqlite3.IntegrityError):
                store.record_agent_usage("missing", {"input_tokens": 1}, at=local_noon(today))
            store.begin_delete_agent("a")
            store.finish_delete_agent("a")
            self.assertEqual([item["agent_id"] for item in store.agent_usage(7)], ["b"])
        with sqlite3.connect(self.path) as connection:
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM agent_daily_usage WHERE agent_id = 'a'"
            ).fetchone()[0], 0)
        with closing(GatewayStore(self.path)) as store:
            self.assertEqual(store.agent_usage(7)[0]["daily"], [])


class RecordObserverTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def test_completed_observer_receives_final_record_on_worker_thread_once(self):
        records = []
        metrics = RunMetrics(self.directory, on_record=lambda record: records.append(
            (threading.current_thread().name, record)
        ))

        def work():
            with metrics.agent_scope("task", "planner"):
                with record_request("gpt") as request:
                    request.observe({"type": "response.completed", "response": {
                        "id": "response", "status": "completed", "usage": {
                            "input_tokens": 10, "output_tokens": 5,
                            "input_tokens_details": {"cached_tokens": 3},
                            "output_tokens_details": {"reasoning_tokens": 2},
                        },
                    }})

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="usage-worker") as pool:
            pool.submit(work).result()
        self.assertEqual(len(records), 1)
        thread_name, record = records[0]
        self.assertTrue(thread_name.startswith("usage-worker"))
        self.assertEqual((record["agent"], record["status"]), ("planner", "completed"))
        self.assertEqual([record[key] for key in (
            "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens",
        )], [10, 3, 5, 2])
        self.assertIsNotNone(datetime.fromisoformat(record["finished_at"]).tzinfo)
        lines = [json.loads(line) for line in metrics.log_path.read_text().splitlines()]
        self.assertEqual(len(lines), 3)  # running, observed usage, finalized
        self.assertEqual(lines[-1], record)
        self.assertEqual(summarize_log(metrics.log_path), metrics.summary())

    def test_failed_request_callback_propagates_and_log_is_finalized(self):
        records = []
        metrics = RunMetrics(self.directory, on_record=records.append)
        with metrics.agent_scope("task", "planner"):
            with self.assertRaisesRegex(OSError, "transport"):
                with record_request("gpt"):
                    raise OSError("transport")
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["status"], "failed")
        self.assertEqual(records[0]["error_type"], "OSError")
        self.assertIsNone(records[0]["input_tokens"])

        def fail(_record):
            raise RuntimeError("persistence error")

        failing = RunMetrics(self.directory, on_record=fail)
        with failing.agent_scope("task", "planner"):
            with self.assertRaisesRegex(RuntimeError, "persistence error"):
                with record_request("gpt"):
                    pass
        latest = json.loads(failing.log_path.read_text().splitlines()[-1])
        self.assertEqual(latest["status"], "completed")
        self.assertIsNotNone(latest["finished_at"])


if __name__ == "__main__":
    unittest.main()
