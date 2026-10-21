// 聊天页纯逻辑：时间线筛选排序、失败提示、输入区按钮选择。

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayEvent } from "../src/gateway/api.ts";
import type { Pending } from "../src/gateway/session.ts";
import { buildItems, composerAction, isMessageTarget, showFailedHint } from "../src/lib/chat-timeline.ts";

function event(seq: number, type: string, data: Record<string, any> = {}): GatewayEvent {
  return { seq, type, conversation_id: "c", at: seq, data };
}

const pending: Pending = {
  clientId: "x",
  conversationId: "c",
  text: "hi",
  status: "sending",
  retryable: true,
  error: null,
};

test("时间线只含可见事件，正序，本地未确认消息排在最新", () => {
  const items = buildItems(
    [
      event(1, "message.user"),
      event(2, "conversation.status", { status: "working" }),
      event(3, "message.agent"),
      event(4, "conversation.read"),
    ],
    [pending],
  );
  assert.deepEqual(items.map((i) => i.key), ["e1", "e3", "px"]);
});

test("只有已持久化且 seq 匹配的消息才高亮，未指定定位时待发送消息不命中", () => {
  const items = buildItems([event(42, "message.user")], [pending]);
  assert.equal(isMessageTarget(items[0], undefined), false);
  assert.equal(isMessageTarget(items[0], 41), false);
  assert.equal(isMessageTarget(items[0], 42), true);
  assert.equal(isMessageTarget(items[1], undefined), false);
  assert.equal(isMessageTarget(items[1], 42), false);
});

test("空停止（没有一轮在跑）不占行", () => {
  const items = buildItems([event(1, "turn.stopped", { was_working: false }), event(2, "turn.stopped", { was_working: true })], []);
  assert.deepEqual(items.map((i) => i.key), ["e2"]);
});

test("不可展示的收件、文件、状态和缺少目标的记忆事件不占列表项", () => {
  const events = [
    event(1, "task.read", { task_id: "child", seq: 0 }),
    event(2, "conversation.read", { seq: 0 }),
    event(3, "file.produced", { id: "file" }),
    event(4, "task.status", { task_id: "child", creator_task_id: "other", agent_id: "worker", status: "completed" }),
    event(5, "browser_task.updated", {}),
    event(6, "memory.updated", { summary: "missing owner" }),
    event(7, "turn.stopped", { was_working: false }),
    event(8, "memory.updated", { agent_id: "worker", summary: "已记住" }),
    event(9, "message.task_preview", { task_id: "child", agent_id: "worker", message_seq: 10, text: "给你的结果" }),
  ];
  assert.deepEqual(buildItems(events, [], undefined, [], undefined, "c").map((row) => row.key), ["e8", "e9"]);
});

test("分页只有 task.status 时仍生成一个可见委派，后续状态更新不另占行", () => {
  const events = [
    event(1, "task.status", { task_id: "child", creator_task_id: "c", agent_id: "worker", status: "running" }),
    event(2, "task.status", { task_id: "child", creator_task_id: "c", agent_id: "worker", status: "completed" }),
  ];
  const items = buildItems(events, [], undefined, [], undefined, "c");
  assert.deepEqual(items.map((row) => [row.key, row.event?.seq, row.delegation]), [
    ["tchild", 1, { taskId: "child", agentId: "worker", status: "completed" }],
  ]);
  assert.deepEqual(buildItems(events, [], undefined, [], undefined, "child"), []);
});

test("失败提示：失败状态下最新可见事件已是 turn.failed 就不重复", () => {
  const failed = { status: "failed" as const };
  assert.equal(showFailedHint(failed, buildItems([event(1, "message.user")], [])), true);
  assert.equal(showFailedHint(failed, buildItems([event(1, "message.user"), event(2, "turn.failed", { error: "x" })], [])), false);
  assert.equal(showFailedHint(failed, buildItems([event(1, "turn.failed"), event(2, "message.user")], [])), true);
  assert.equal(showFailedHint(failed, buildItems([event(1, "message.user"), event(2, "turn.failed")], [pending])), false);
  assert.equal(showFailedHint({ status: "idle" }, []), false);
  assert.equal(showFailedHint(undefined, []), false);
});

test("输入区按钮：有输入发送（含工作中打断），工作中无输入停止，空闲无输入置灰", () => {
  assert.equal(composerAction(false, "  "), "disabled");
  assert.equal(composerAction(false, "a"), "send");
  assert.equal(composerAction(true, "a"), "send");
  assert.equal(composerAction(true, "   "), "stop");
});

