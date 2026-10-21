import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMemory, GatewayEvent } from "../src/gateway/api.ts";
import { beginMemoryDraft, conflictMemory, memoryLength, normalizeMemory, observeMemory, reloadMemoryBase } from "../src/lib/agent-memory.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";

function snapshot(content: string, version: string): AgentMemory {
  return { agent_id: "helper", content, version, updated_at: 1, updated_by: "user", limit: 1000 };
}

test("Unicode 码点与 LF 计数一致，组合字符仍分别计数；不会截断超限草稿", () => {
  assert.equal(memoryLength("中😀\r\n文\ré\u0301"), 7);
  assert.equal(normalizeMemory("中😀\r\n文\ré\u0301"), "中😀\n文\né\u0301");
  assert.equal(memoryLength("😀".repeat(1000)), 1000);
  assert.equal(memoryLength("😀".repeat(1001)), 1001);
  const editor = { ...beginMemoryDraft(snapshot("旧", "v1")), content: "😀".repeat(1001) };
  assert.equal(editor.content.length, 2002);
  assert.equal(memoryLength(editor.content), 1001);
});

test("远程变化和冲突只更新可查看的版本；显式重新载入更新基线但保留草稿", () => {
  const first = snapshot("# 初稿", "v1");
  const changed = snapshot("# 远程修订", "v2");
  const local = { ...beginMemoryDraft(first), content: "# 我的草稿\n😀" };
  const conflicted = observeMemory(local, changed);
  assert.equal(conflicted.base.version, "v1");
  assert.equal(conflicted.remote?.content, "# 远程修订");
  assert.equal(conflicted.content, local.content);
  const reloaded = reloadMemoryBase(conflicted, changed);
  assert.equal(reloaded.base.version, "v2");
  assert.equal(reloaded.content, local.content);
  assert.equal(reloaded.remote, null);
  assert.equal(observeMemory(reloaded, changed).content, local.content);
  assert.equal(observeMemory(null, changed).content, "# 远程修订");
  assert.equal(conflictMemory({ current: changed }, "helper")?.version, "v2");
  assert.equal(conflictMemory({ current: { ...changed, content: 5 } }, "helper"), null);
  assert.equal(conflictMemory({ current: changed }, "other"), null);
});

test("根对话成员记忆事件保留原始序号供可点击行展示；资源事件不作为聊天行", () => {
  const events: GatewayEvent[] = [
    { seq: 1, type: "message.user", conversation_id: "root", at: 1, data: { text: "记住" } },
    { seq: 2, type: "resource.changed", at: 2, data: { kind: "memory", id: "helper", op: "updated" } },
    { seq: 3, type: "memory.updated", conversation_id: "root", at: 3,
      data: { agent_id: "helper", version: "v2", summary: "已记住" } },
  ];
  assert.deepEqual(buildItems(events, []).map((item) => [item.event?.seq, item.event?.data.agent_id]), [
    [1, undefined], [3, "helper"],
  ]);
});
