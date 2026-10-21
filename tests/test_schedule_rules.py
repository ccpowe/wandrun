"""日历规则的行为边界：UTC 比较、DST、编辑与已处理时间。"""

import unittest
from datetime import datetime
from unittest.mock import patch

from wandrun.gateway.schedules import InvalidSchedule, next_run_at, schedule_fields


def stamp(value: str) -> float:
    return datetime.fromisoformat(value).timestamp()


class ScheduleRuleTests(unittest.TestCase):
    def create(self, rule, *, now="2026-10-09T00:00:00+00:00", **fields):
        return schedule_fields(
            {"name": "日报", "content": "整理新闻", "rule": rule, "timezone": "UTC", **fields},
            now=stamp(now),
        )

    def test_weekly_uses_iso_sunday_and_can_include_exact_boundary(self):
        rule = {"kind": "weekly", "time": "08:00", "weekdays": [7]}
        sunday = stamp("2026-10-11T00:00:00+00:00")
        self.assertEqual(next_run_at(rule, "Asia/Shanghai", sunday, inclusive=True), sunday)
        self.assertEqual(next_run_at(rule, "Asia/Shanghai", sunday), stamp("2026-10-18T00:00:00+00:00"))

    def test_spring_gap_is_not_shifted_or_caught_up(self):
        rule = {"kind": "daily", "time": "02:30"}
        self.assertEqual(
            next_run_at(rule, "Europe/Berlin", stamp("2026-03-28T03:00:00+00:00")),
            stamp("2026-03-30T00:30:00+00:00"),
        )
        with self.assertRaises(InvalidSchedule):
            self.create({"kind": "once", "local_at": "2026-03-29T02:30"},
                        timezone="Europe/Berlin", now="2026-03-28T00:00:00+00:00")

    def test_fall_fold_runs_only_first_even_when_reconstructed_in_second_hour(self):
        rule = {"kind": "daily", "time": "02:30"}
        first = stamp("2026-10-25T00:30:00+00:00")
        tomorrow = stamp("2026-10-26T01:30:00+00:00")
        self.assertEqual(next_run_at(rule, "Europe/Berlin", first - 60), first)
        self.assertEqual(next_run_at(rule, "Europe/Berlin", first), tomorrow)
        self.assertEqual(next_run_at(rule, "Europe/Berlin", stamp("2026-10-25T01:15:00+00:00")), tomorrow)

    def test_half_hour_dst_gap_is_also_skipped(self):
        self.assertEqual(
            next_run_at({"kind": "cron", "expression": "15 2 * * *"}, "Australia/Lord_Howe",
                        stamp("2026-10-03T12:00:00+00:00")),
            stamp("2026-10-04T15:15:00+00:00"),
        )

    def test_leap_day_and_cron_day_or_weekday(self):
        self.assertEqual(
            self.create({"kind": "cron", "expression": "0 8 29 2 *"})["next_run_at"],
            stamp("2028-02-29T08:00:00+00:00"),
        )
        self.assertEqual(
            next_run_at({"kind": "cron", "expression": "0 8 1 * MON"}, "UTC",
                        stamp("2026-10-01T08:00:00+00:00")),
            stamp("2026-10-05T08:00:00+00:00"),
        )

    def test_rejects_rules_that_cannot_be_scheduled(self):
        for rule in (
            {"kind": "cron", "expression": "* * * * * *"},
            {"kind": "cron", "expression": "@daily"},
            {"kind": "cron", "expression": "0 0 31 2 *"},
            {"kind": "daily", "time": "24:00"},
            {"kind": "weekly", "time": "08:00", "weekdays": []},
            {"kind": "weekly", "time": "08:00", "weekdays": [True]},
            {"kind": "once", "local_at": "2026-02-30T08:00"},
            {"kind": "once", "local_at": "2026-10-08T08:00"},
            {"kind": "daily", "time": "08:00", "expression": "0 8 * * *"},
        ):
            with self.subTest(rule=rule), self.assertRaises(InvalidSchedule):
                self.create(rule)

    def test_bad_cron_field_reports_affected_part_without_library_detail(self):
        with self.assertRaises(InvalidSchedule) as invalid:
            self.create({"kind": "cron", "expression": "99 * * * *"})
        self.assertIn("分钟", str(invalid.exception))
        self.assertNotIn("Bad minute", str(invalid.exception))


    def test_next_run_failure_does_not_expose_library_diagnostic(self):
        with patch("wandrun.gateway.schedules.CronSim", side_effect=ValueError("private library detail")):
            with self.assertRaises(InvalidSchedule) as invalid:
                next_run_at({"kind": "daily", "time": "08:00"}, "UTC", stamp("2026-10-09T00:00:00+00:00"))
        self.assertIn("下次运行", str(invalid.exception))
        self.assertNotIn("private library detail", str(invalid.exception))

    def test_rename_does_not_hide_unconsumed_due_time(self):
        previous = self.create({"kind": "daily", "time": "08:00"})
        changed = schedule_fields({"name": "新名字"}, previous, now=stamp("2026-10-10T12:00:00+00:00"))
        self.assertEqual(changed["next_run_at"], stamp("2026-10-09T08:00:00+00:00"))
        self.assertEqual(changed["name"], "新名字")

    def test_edit_and_reenable_respect_processed_watermark_after_clock_rollback(self):
        previous = self.create({"kind": "daily", "time": "08:00"})
        previous["processed_through"] = stamp("2026-10-12T09:00:00+00:00")
        previous["enabled"] = False
        previous["next_run_at"] = None
        for fields in ({"enabled": True}, {"enabled": True, "rule": {"kind": "daily", "time": "09:00"}}):
            with self.subTest(fields=fields):
                changed = schedule_fields(fields, previous, now=stamp("2026-10-09T00:00:00+00:00"))
                hour = "09" if "rule" in fields else "08"
                self.assertEqual(changed["next_run_at"], stamp(f"2026-10-13T{hour}:00:00+00:00"))

    def test_consumed_once_can_be_edited_but_not_reenabled_in_the_past(self):
        previous = self.create({"kind": "once", "local_at": "2026-10-09T08:00"})
        previous.update(enabled=False, next_run_at=None, processed_through=previous["next_run_at"])
        now = stamp("2026-10-10T00:00:00+00:00")
        changed = schedule_fields({"content": "补充说明"}, previous, now=now)
        self.assertEqual(changed["content"], "补充说明")
        self.assertIsNone(changed["next_run_at"])
        with self.assertRaises(InvalidSchedule):
            schedule_fields({"enabled": True}, previous, now=now)
        changed = schedule_fields({"enabled": True, "rule": {"kind": "once", "local_at": "2026-10-11T08:00"}}, previous, now=now)
        self.assertEqual(changed["next_run_at"], stamp("2026-10-11T08:00:00+00:00"))

    def test_pause_removes_next_time_and_reenable_does_not_backfill(self):
        previous = self.create({"kind": "daily", "time": "08:00"})
        paused = schedule_fields({"enabled": False}, previous, now=stamp("2026-10-09T01:00:00+00:00"))
        self.assertIsNone(paused["next_run_at"])
        resumed = schedule_fields({"enabled": True}, paused, now=stamp("2026-10-12T09:00:00+00:00"))
        self.assertEqual(resumed["next_run_at"], stamp("2026-10-13T08:00:00+00:00"))

    def test_invalid_fields_are_not_silently_ignored(self):
        valid = self.create({"kind": "daily", "time": "08:00"})
        for fields in ({"agent_id": "other"}, {"enabled": 1}, {"timezone": "not/a-zone"}, {"name": "two\nlines"}, {"content": " "}):
            with self.subTest(fields=fields), self.assertRaises(InvalidSchedule):
                schedule_fields(fields, valid, now=stamp("2026-10-09T00:00:00+00:00"))
