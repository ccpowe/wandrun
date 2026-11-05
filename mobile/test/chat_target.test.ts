import assert from "node:assert/strict";
import { test } from "node:test";

import type { GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { ChatTargetSeek, chatTargetReducer, initialChatTarget, selectChatTarget, type ChatTargetState } from "../src/lib/chat-target.ts";

const seeking: ChatTargetState = { status: "seeking", seq: 42, highlight: true };
const placed: ChatTargetState = { status: "placed", seq: 42, placement: 1, highlight: true, reading: true };
const facts = { missing: false, historyFailed: false, targetIndex: 3, itemCount: 10 };

// chat.C6 / C7 / T2 / T3 / T4 rows; state first, then event.
test("route target starts seeking; no or invalid seq starts latest", () => {
  assert.deepEqual(initialChatTarget(42), seeking);
  assert.deepEqual(initialChatTarget(undefined), { status: "latest" });
  assert.deepEqual(initialChatTarget(Number.NaN), { status: "latest" });
});

test("latest ignores every target event", () => {
  const latest = initialChatTarget(undefined);
  for (const event of [{ type: "placed", placement: 1 }, { type: "cancel" }, { type: "touched" }, { type: "highlight-expired", placement: 1 }, { type: "reached-end" }] as const) {
    assert.equal(chatTargetReducer(latest, event), latest);
  }
});

test("C6 seeking → placed holds READ and keeps the highlight", () => {
  assert.deepEqual(chatTargetReducer(seeking, { type: "placed", placement: 1 }), placed);
});

test("touch while seeking (failed target showing history) clears only the future highlight", () => {
  const touched = chatTargetReducer(seeking, { type: "touched" });
  assert.deepEqual(touched, { ...seeking, highlight: false });
  assert.equal(chatTargetReducer(touched, { type: "placed", placement: 1 }).status, "placed");
});

test("T2 / T4 cancel (drag, local send, return, dismissing not-found) ends any target", () => {
  assert.deepEqual(chatTargetReducer(seeking, { type: "cancel" }), { status: "latest" });
  assert.deepEqual(chatTargetReducer(placed, { type: "cancel" }), { status: "latest" });
});

test("T4 highlight expiry belongs to its placement and does not end READ", () => {
  assert.equal(chatTargetReducer(placed, { type: "highlight-expired", placement: 2 }), placed);
  assert.deepEqual(chatTargetReducer(placed, { type: "highlight-expired", placement: 1 }), { ...placed, highlight: false });
  assert.deepEqual(chatTargetReducer(placed, { type: "touched" }), { ...placed, highlight: false });
  assert.equal(chatTargetReducer(seeking, { type: "highlight-expired", placement: 1 }), seeking);
});

test("reached-end releases READ once and is latched", () => {
  const released = chatTargetReducer(placed, { type: "reached-end" });
  assert.deepEqual(released, { ...placed, reading: false });
  assert.equal(chatTargetReducer(released, { type: "reached-end" }), released);
  assert.equal(chatTargetReducer(released, { type: "placed", placement: 2 }), released, "a remount never re-places");
});

test("selector: seeking / failed / missing projections", () => {
  assert.deepEqual(selectChatTarget(seeking, { ...facts, targetIndex: -1 }), {
    seeking: true, failed: false, missing: false, reading: true, highlighted: true, placement: null, targetIsLast: false,
  });
  assert.equal(selectChatTarget(seeking, { ...facts, historyFailed: true }).failed, true);
  const missing = selectChatTarget(seeking, { ...facts, targetIndex: -1, missing: true });
  assert.deepEqual(missing, { seeking: false, failed: false, missing: true, reading: false, highlighted: false, placement: null, targetIsLast: false });
});

test("selector: placed projections and last-row release condition", () => {
  assert.deepEqual(selectChatTarget(placed, facts), {
    seeking: false, failed: false, missing: false, reading: true, highlighted: true, placement: 1, targetIsLast: false,
  });
  assert.equal(selectChatTarget(placed, { ...facts, targetIndex: 9 }).targetIsLast, true);
  assert.equal(selectChatTarget({ ...placed, highlight: false }, facts).placement, null);
  assert.equal(selectChatTarget({ status: "latest" }, facts).reading, false);
});

const message = (seq: number): GatewayEvent => ({ seq, type: "message.user", conversation_id: "c", at: seq, data: { text: `m${seq}` } });
function fixture() {
  const reads: { before: string | null; resolve(events: GatewayEvent[] | null): void }[] = [];
  const session = new ChatSession({ baseUrl: "http://seek-test", token: "dev" }, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/events")) return new Promise<Response>((resolve) => reads.push({ before: url.searchParams.get("before"), resolve: (events) => resolve(
      new Response(JSON.stringify(events ? { events, as_of_seq: 200 } : { error: { message: "down" } }), { status: events ? 200 : 503, headers: { "content-type": "application/json" } })) }));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  session.agents.close();
  session["reset"]([{ id: "c", agent_id: "agent", title: "Chat", created_at: 1, updated_at: 200, status: "idle", read_seq: 200, last_agent_seq: 199,
    unread: false, last_text: "Latest", source: "user", schedule_origin: null, last_activity_seq: 200, last_activity_at: 200 }], 200);
  session.connection = "open";
  Object.assign(session.timeline("c"), { events: [message(150), message(151)], oldest: 150, loaded: true });
  return { session, reads };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const page = (first: number, count = 50) => Array.from({ length: count }, (_, index) => message(first + index));

test("T3 seek pages one request per cursor until found, only while active", async () => {
  const { session, reads } = fixture();
  const seek = new ChatTargetSeek(session, "c", 42);
  try {
    const deactivate = seek.activate();
    assert.deepEqual(reads.map((read) => read.before), ["150"]);
    reads[0].resolve(page(100));
    await settle();
    assert.deepEqual(reads.map((read) => read.before), ["150", "100"]);
    deactivate();
    reads[1].resolve(page(50));
    await settle();
    assert.equal(reads.length, 2, "an ended visit stops paging, without clearing history");
    seek.activate();
    assert.deepEqual(reads.map((read) => read.before), ["150", "100", "50"]);
    reads[2].resolve(page(1, 50));
    await settle();
    assert.equal(reads.length, 3, "found: no more pages");
    assert.equal(seek.getSnapshot(), false);
  } finally { await session.close(); }
});

test("C7 failure does not page or report missing; exhaustion after success latches missing", async () => {
  const { session, reads } = fixture();
  const seek = new ChatTargetSeek(session, "c", 7);
  let notified = 0;
  seek.subscribe(() => { notified++; });
  try {
    seek.activate();
    reads[0].resolve(null);
    await settle();
    assert.equal(reads.length, 1, "history recovery belongs to the page's retry resource");
    assert.equal(seek.getSnapshot(), false);
    void session.loadOlder("c"); // the background retry of the same cursor
    reads[1].resolve([message(100)]);
    await settle();
    assert.equal(seek.getSnapshot(), true);
    assert.equal(notified, 1);
    // Resync replacing history must not re-enter seeking (that would remount the list).
    Object.assign(session.timeline("c"), { loaded: false, complete: false });
    session["changed"]();
    assert.equal(seek.getSnapshot(), true);
  } finally { await session.close(); }
});

test("deleted conversation or Agent is navigation, not search exhaustion", async () => {
  const { session } = fixture();
  Object.assign(session.timeline("c"), { complete: true });
  session.agents.deletedIds.add("agent");
  const seek = new ChatTargetSeek(session, "c", 7);
  try {
    seek.activate();
    assert.equal(seek.getSnapshot(), false);
    session.agents.deletedIds.delete("agent");
    session.conversations.delete("c");
    session["changed"]();
    assert.equal(seek.getSnapshot(), false);
  } finally { await session.close(); }
});

// Opus 1: the seek owner and the page share one definition of "the target is a visible row".
test("C7 an event that never renders as a row is not 'found': exhaustion reports missing", async () => {
  const { session, reads } = fixture();
  const hidden: GatewayEvent = { seq: 7, type: "turn.stopped", conversation_id: "c", at: 7, data: { was_working: false } };
  const seek = new ChatTargetSeek(session, "c", 7);
  try {
    seek.activate();
    reads[0].resolve([hidden, message(8)]);
    await settle();
    assert.equal(session.timeline("c").complete, true);
    assert.equal(seek.getSnapshot(), true, "the page would never get a target row, so this is not found");
  } finally { await session.close(); }
});
