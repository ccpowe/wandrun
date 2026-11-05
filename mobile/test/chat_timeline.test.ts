// 聊天页纯逻辑：时间线筛选排序、失败提示、输入区按钮选择。

import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayEvent } from "../src/gateway/api.ts";
import type { Pending } from "../src/gateway/session.ts";
import { projectChatRows, composerAction, isMessageTarget } from "../src/lib/chat-timeline.ts";

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
  const items = projectChatRows({ events: [
    event(1, "message.user"),
    event(2, "conversation.status", { status: "working" }),
    event(3, "message.agent"),
    event(4, "conversation.read"),
  ], pending: [pending] }).rows;
  assert.deepEqual(items.map((i) => i.key), ["e1", "e3", "px"]);
});

test("首条消息确认后保留本地发送项身份，消息定位仍按正式 seq", () => {
  const local = projectChatRows({ events: [], pending: [pending] }).rows[0];
  const confirmed: GatewayEvent = { ...event(42, "message.user", { text: pending.text }), client_id: pending.clientId };
  const accepted = projectChatRows({ events: [confirmed], pending: [] }).rows[0];
  assert.equal(accepted.key, local.key);
  assert.equal(isMessageTarget(accepted, 42), true);
  const different = projectChatRows({ events: [{ ...confirmed, seq: 43, client_id: "other-send" }], pending: [] }).rows[0];
  assert.notEqual(different.key, accepted.key);
});

test("只有已持久化且 seq 匹配的消息才高亮，未指定定位时待发送消息不命中", () => {
  const items = projectChatRows({ events: [event(42, "message.user")], pending: [pending] }).rows;
  assert.equal(isMessageTarget(items[0], undefined), false);
  assert.equal(isMessageTarget(items[0], 41), false);
  assert.equal(isMessageTarget(items[0], 42), true);
  assert.equal(isMessageTarget(items[1], undefined), false);
  assert.equal(isMessageTarget(items[1], 42), false);
});

test("空停止（没有一轮在跑）不占行", () => {
  const items = projectChatRows({ events: [event(1, "turn.stopped", { was_working: false }), event(2, "turn.stopped", { was_working: true })], pending: [] }).rows;
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
  ];
  assert.deepEqual(projectChatRows({ events: events, pending: [], timelineId: "c" }).rows.map((row) => row.key), ["e8"]);
});

test("分页只有 task.status 时仍生成一个可见委派，后续状态更新不另占行", () => {
  const events = [
    event(1, "task.status", { task_id: "child", creator_task_id: "c", agent_id: "worker", status: "running" }),
    event(2, "task.status", { task_id: "child", creator_task_id: "c", agent_id: "worker", status: "completed" }),
  ];
  const items = projectChatRows({ events: events, pending: [], timelineId: "c" }).rows;
  assert.deepEqual(items.map((row) => [row.key, row.event?.seq, row.delegation]), [
    ["tchild", 1, { taskId: "child", agentId: "worker", status: "completed" }],
  ]);
  assert.deepEqual(projectChatRows({ events: events, pending: [], timelineId: "child" }).rows, []);
});

test("chat.D10 失败保留在发生位置，之后的用户消息不移除或复制失败行", () => {
  const items = projectChatRows({ events: [
    event(1, "message.user", { text: "开始" }),
    event(2, "turn.failed", { error: "模型尚未登录，请先在电脑上登录模型。" }),
    event(3, "message.user", { text: "继续" }),
  ], pending: [] }).rows;
  assert.deepEqual(items.map((row) => row.event?.type), ["message.user", "turn.failed", "message.user"]);
  assert.equal(items[1].event?.data.error, "模型尚未登录，请先在电脑上登录模型。");
});

test("输入区按钮：有输入发送（含工作中打断），工作中无输入停止，空闲无输入置灰", () => {
  assert.equal(composerAction(false, "  "), "disabled");
  assert.equal(composerAction(false, "a"), "send");
  assert.equal(composerAction(true, "a"), "send");
  assert.equal(composerAction(true, "   "), "stop");
});

