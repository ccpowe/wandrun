import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentMemory, GatewayEvent } from "../src/gateway/api.ts";
import { beginMemoryDraft, conflictMemory, detailBytes, managedMemorySlug, memoryLength, newDetailIndex, normalizeMemory, observeMemory, reloadMemoryBase, withoutDetailLink } from "../src/lib/agent-memory.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";

const SHA = "a".repeat(64);
const PATH = `/.wandrun/memory/profile/details/topic/${SHA}.md`;
function snapshot(content: string, version: string, scope: "profile" | "work" = "work"): AgentMemory {
  return { ...(scope === "work" ? { agent_id: "helper" } : {}), scope, content, version,
    details: {}, updated_at: 1, updated_by: "user", limit: 1000 };
}

test("Unicode code points and LF normalization do not truncate the index; detail limit counts UTF-8 bytes", () => {
  assert.equal(memoryLength("中😀\r\n文\ré\u0301"), 7);
  assert.equal(normalizeMemory("中😀\r\n文\ré\u0301"), "中😀\n文\né\u0301");
  assert.equal(memoryLength("😀".repeat(1001)), 1001);
  assert.equal(detailBytes("😀".repeat(16384)), 65536);
  assert.equal(detailBytes("😀".repeat(16385)), 65540);
  assert.equal(detailBytes("A\r\nB"), 3);
});

test("scope-matching active canonical links alone become internal navigation; removal preserves adjacent text", () => {
  const profile = { ...snapshot(`[Topic](${PATH})`, "v1", "profile"), details: { topic: { path: PATH, sha256: SHA } } };
  assert.equal(managedMemorySlug(PATH, profile), "topic");
  assert.equal(managedMemorySlug(PATH, snapshot("", "v1")), null);
  assert.equal(managedMemorySlug(PATH.replace(SHA, "b".repeat(64)), profile), null);
  assert.equal(managedMemorySlug("/.wandrun/memory/profile/details/topic.md", profile), null);
  assert.equal(managedMemorySlug("https://example.org", profile), null);
  assert.equal(newDetailIndex("# Start", "profile", "topic"), "# Start\n- [topic](/.wandrun/memory/profile/details/topic.md)\n");
  assert.equal(withoutDetailLink(`Before [Topic](${PATH}) after\n- [Topic](${PATH})\nNext`, PATH), "Before Topic after\nNext");
});
test("profile and work drafts never adopt remote changes as a save baseline until explicit reload", () => {
  for (const scope of ["profile", "work"] as const) {
    const first = snapshot("# 初稿", "v1", scope);
    const changed = snapshot("# 远程修订", "v2", scope);
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
    assert.equal(conflictMemory({ current: changed }, scope, "helper")?.version, "v2");
    assert.equal(conflictMemory({ current: { ...changed, content: 5 } }, scope, "helper"), null);
    assert.equal(conflictMemory({ current: changed }, scope === "work" ? "profile" : "work", "helper"), null);
    if (scope === "work") assert.equal(conflictMemory({ current: changed }, scope, "other"), null);
  }
});

test("work and profile memory events retain root timeline links; resource changes are not chat rows", () => {
  const events: GatewayEvent[] = [
    { seq: 1, type: "message.user", conversation_id: "root", at: 1, data: { text: "反馈" } },
    { seq: 2, type: "resource.changed", at: 2, data: { kind: "memory", scope: "profile", op: "updated" } },
    { seq: 3, type: "memory.updated", conversation_id: "root", at: 3,
      data: { scope: "profile", agent_id: "helper", version: "v2", summary: "已记住" } },
    { seq: 4, type: "memory.updated", conversation_id: "root", at: 4,
      data: { scope: "work", agent_id: "helper", version: "v3", summary: "已记住" } },
  ];
  assert.deepEqual(buildItems(events, []).map((item) => [item.event?.seq, item.event?.data.scope]), [
    [1, undefined], [3, "profile"], [4, "work"],
  ]);
});
