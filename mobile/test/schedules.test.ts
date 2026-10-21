import assert from "node:assert/strict";
import { test } from "node:test";

import type { Schedule } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";
import { changedScheduleFields, editableSchedule } from "../src/lib/schedules.ts";

const schedule: Schedule = {
  id: "s/1", agent_id: "agent", name: "简报", content: "整理新闻", rule: { kind: "daily", time: "08:00" },
  timezone: "Asia/Shanghai", enabled: true, next_run_at: 1_800_000_000, ended: false, created_at: 1, updated_at: 2,
};

test("编辑只发送变更字段；切换或保存显示不自行计算 cron", () => {
  const original = editableSchedule(schedule);
  assert.deepEqual(changedScheduleFields(original, { ...original, name: "新名称" }), { name: "新名称" });
  assert.deepEqual(changedScheduleFields(original, { ...original, rule: { kind: "weekly", time: "09:00", weekdays: [1, 5] }, enabled: false }), {
    rule: { kind: "weekly", time: "09:00", weekdays: [1, 5] }, enabled: false,
  });
});

test("调度资源事件按序更新全局版本和墓碑；触发系统行与来源快照保留", () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  session.agents.close();
  const change = (seq: number, op: string) => session["apply"]({ seq, type: "resource.changed", at: seq, data: { kind: "schedule", id: "s", op } });
  change(4, "created");
  assert.equal(session.scheduleRevision, 1);
  change(3, "deleted");
  assert.equal(session.scheduleRevision, 1);
  assert.equal(session.deletedScheduleIds.has("s"), false);
  change(5, "deleted");
  assert.equal(session.deletedScheduleIds.has("s"), true);
  change(6, "updated");
  assert.equal(session.deletedScheduleIds.has("s"), false);
  const origin = { schedule_id: "s", run_id: 7, name: "新闻", scheduled_at: 10 };
  session["apply"]({ seq: 8, type: "conversation.created", conversation_id: "c", at: 8,
    data: { agent_id: "agent", title: "新闻", source: "schedule", schedule_origin: origin } });
  assert.deepEqual(session.conversations.get("c")?.schedule_origin, origin);
  assert.equal(session.conversations.get("c")?.source, "schedule");
  const triggered = { seq: 9, type: "schedule.triggered", conversation_id: "c", at: 9,
    data: { schedule_id: "s", run_id: 7, name: "新闻", scheduled_at: 10 } };
  session["apply"](triggered);
  assert.deepEqual(buildItems(session.timeline("c").events, []).map((item) => item.event?.type), ["schedule.triggered"]);
  void session.close();
});
