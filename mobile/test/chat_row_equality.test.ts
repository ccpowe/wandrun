import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayEvent } from "../src/gateway/api.ts";
import { chatRowsEqual, rowLayout } from "../src/lib/chat-row-equality.ts";
import type { ChatRow } from "../src/lib/chat-timeline.ts";

// chat.C9: a send window must not re-render settled rows; every visible change still must.
const event = { type: "message.agent", seq: 1, data: { text: "hi" } } as unknown as GatewayEvent;
const agent = (over: Partial<ChatRow> = {}): ChatRow => ({ kind: "agent", phase: "final", key: "e1", event, senderName: "A", submissions: new Map(), ...over }) as ChatRow;
const submission = { values: { a: 1 }, createdAt: "t" };

test("a fresh projection of the same content is equal (new objects, same fields)", () => {
  assert.equal(chatRowsEqual(agent(), agent()), true);
  assert.equal(chatRowsEqual(agent({ submissions: new Map([[0, submission]]) }), agent({ submissions: new Map([[0, submission]]) })), true);
});

test("each displayed field makes a changed row unequal", () => {
  const base = agent();
  const changed: Partial<ChatRow>[] = [
    { event: { ...event } as GatewayEvent }, { phase: "interrupted" }, { senderName: "B" }, { agentName: "x" }, { creatorName: "c" },
    { label: "l" }, { key: "e2" }, { counterpart: { incoming: true, name: "n", avatar: 1 } },
    { submissions: new Map([[0, submission]]) },
    { draft: { draft_id: "d" } as ChatRow["draft"] }, { browser: { id: "b" } as ChatRow["browser"] },
    { delegation: { taskId: "t", agentId: "a", status: "running" } },
  ];
  for (const over of changed) assert.equal(chatRowsEqual(base, agent(over as Partial<ChatRow>)), false, JSON.stringify(Object.keys(over)));
  assert.equal(chatRowsEqual(agent({ submissions: new Map([[0, submission]]) }), agent({ submissions: new Map([[0, { ...submission }]]) })), false);
  assert.equal(chatRowsEqual(agent({ delegation: { taskId: "t", agentId: "a", status: "running" } }), agent({ delegation: { taskId: "t", agentId: "a", status: "completed" } })), false);
});

test("user delivery / retryability and the counterpart are compared", () => {
  const user = (over: object = {}) => ({ kind: "user", key: "e2", event, delivery: "sent", retryable: false, ...over }) as ChatRow;
  assert.equal(chatRowsEqual(user(), user()), true);
  assert.equal(chatRowsEqual(user(), user({ delivery: "failed" })), false);
  assert.equal(chatRowsEqual(user(), user({ retryable: true })), false);
});

test("pending rows are never equal (their retry / discard handlers belong to the render)", () => {
  const pending = { kind: "user", key: "pc", delivery: "sending", retryable: false, pending: { clientId: "c", text: "t", status: "sending", retryable: false, error: null } } as ChatRow;
  assert.equal(chatRowsEqual(pending, pending), false);
  assert.equal(chatRowsEqual(agent(), pending), false);
});

test("rowLayout covers the inputs of a row's leading space: first row identity and delegation neighbors", () => {
  const del = (key: string) => agent({ key, delegation: { taskId: "t", agentId: "a", status: "running" } });
  assert.equal(rowLayout([]), ";");
  // Prepending changes the first row, so the old first row gets its gap (the list never re-runs renderItem for a new index).
  assert.notEqual(rowLayout([agent({ key: "a" }), agent({ key: "b" })]), rowLayout([agent({ key: "z" }), agent({ key: "a" }), agent({ key: "b" })]));
  // A row inserted next to a delegation row changes that neighbor's spacing even though the delegation keys are the same.
  assert.notEqual(rowLayout([agent({ key: "a" }), del("d"), agent({ key: "x" })]), rowLayout([agent({ key: "a" }), del("d"), agent({ key: "y" }), agent({ key: "x" })]));
  // Unrelated appends at the end leave it unchanged (no re-render of every row per new message).
  assert.equal(rowLayout([agent({ key: "a" }), agent({ key: "b" })]), rowLayout([agent({ key: "a" }), agent({ key: "b" }), agent({ key: "c" })]));
});
