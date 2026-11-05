import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatSession } from "../src/gateway/session.ts";

// Session-only stop receipt rules (chat.T7), moved from the former hand-written page host
// (test/chat_target_loading.test.ts); the page-visible stop rules are in
// component-tests/chat-timeline-contract.test.tsx.
function fixture() {
  const stops: { resolve(response: Response): void }[] = [];
  const session = new ChatSession({ baseUrl: "http://stop-test", token: "dev" }, async (input) => {
    if (new URL(String(input)).pathname.endsWith("/stop")) return new Promise<Response>((resolve) => stops.push({ resolve }));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  session.agents.close();
  session["reset"]([{ id: "c", agent_id: "agent", title: "Chat", created_at: 1, updated_at: 200, status: "working", read_seq: 200, last_agent_seq: 199,
    unread: false, last_text: "Latest", source: "user", schedule_origin: null, last_activity_seq: 200, last_activity_at: 200 }], 200);
  session.connection = "open";
  return { session, stops };
}
const stopFailure = () => new Response(JSON.stringify({ error: { message: "stop unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });

test("deletion before a failed stop response cannot restore its error", async () => {
  const { session, stops } = fixture();
  try {
    const stopping = session.stop("c");
    session["apply"]({ seq: 201, type: "conversation.deleted", conversation_id: "c", at: 201, data: { id: "c" } });
    stops[0].resolve(stopFailure());
    await stopping;
    assert.equal(session.isDeleted("c"), true);
    assert.equal(session.stopErrors.has("c"), false);
  } finally { await session.close(); }
});

test("deletion after an unresolved stop error removes its receipt identity", async () => {
  const { session, stops } = fixture();
  try {
    const stopping = session.stop("c");
    stops[0].resolve(stopFailure());
    await stopping;
    assert.equal(session["stopRequests"].has("c"), true);
    session["apply"]({ seq: 201, type: "conversation.deleted", conversation_id: "c", at: 201, data: { id: "c" } });
    assert.equal(session.stopErrors.has("c"), false);
    assert.equal(session["stopRequests"].has("c"), false);
  } finally { await session.close(); }
});

test("resync discards an unresolved failed stop identity from the replaced event store", async () => {
  const { session, stops } = fixture();
  let resync: Promise<void> | undefined;
  try {
    const stopping = session.stop("c");
    stops[0].resolve(stopFailure());
    await stopping;
    assert.equal(session["stopRequests"].has("c"), true);
    resync = session["resync"]();
    assert.equal(session.stopErrors.has("c"), false);
    assert.equal(session["stopRequests"].has("c"), false);
  } finally {
    await session.close();
    await resync;
  }
});

test("terminal idle and a matching receipt release the receipt identity", async () => {
  const { session, stops } = fixture();
  try {
    let stopping = session.stop("c");
    stops[0].resolve(stopFailure());
    await stopping;
    session["apply"]({ seq: 202, type: "conversation.status", conversation_id: "c", at: 202, data: { status: "idle" } });
    assert.equal(session["stopRequests"].has("c"), false);
    session["apply"]({ seq: 203, type: "conversation.status", conversation_id: "c", at: 203, data: { status: "working" } });
    stopping = session.stop("c");
    stops[1].resolve(stopFailure());
    await stopping;
    const { clientId } = session["stopRequests"].get("c")!;
    session["apply"]({ seq: 204, type: "turn.stopped", conversation_id: "c", client_id: clientId, at: 204, data: { was_working: true } });
    assert.equal(session.conversations.get("c")!.status, "working", "a stop receipt need not include idle yet");
    assert.equal(session["stopRequests"].has("c"), false);
  } finally { await session.close(); }
});
