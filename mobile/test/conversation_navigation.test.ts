import assert from "node:assert/strict";
import { test } from "node:test";
import { BaseRouter } from "expo-router/build/react-navigation/routers/BaseRouter.js";

import type { SearchResult } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { liveSearchDestination, missingConversationAction, switchConversation } from "../src/lib/conversation-navigation.ts";

test("confirmed deletion removes stale chat search destinations, but not independent file results", async () => {
  const session = new ChatSession({ baseUrl: "http://unused", token: "dev" });
  session.agents.close();
  try {
    const conversation: SearchResult = { kind: "conversation", id: "gone", title: "gone", agent_id: "agent" };
    const message: SearchResult = { kind: "message", id: "message", title: "match", text: "match", conversation_id: "gone", agent_id: "agent", seq: 42 };
    const file: SearchResult = { kind: "file", id: "file", title: "report", file: {
      id: "file", name: "report.txt", size: 12, media_type: "text/plain", conversation_id: "gone",
      agent_id: "agent", task_id: "task", created_at: 1, remote_environment: null,
    } };
    assert.deepEqual(liveSearchDestination(message, session), { pathname: "/c/[id]", params: { id: "gone", message_seq: "42" } });
    assert.deepEqual(missingConversationAction(session, "gone", undefined), { type: "wait" });

    session["apply"]({ seq: 10, type: "conversation.deleted", at: 10, data: { id: "gone", agent_id: "agent" } });
    assert.equal(liveSearchDestination(conversation, session), null);
    assert.equal(liveSearchDestination(message, session), null);
    assert.deepEqual(liveSearchDestination(file, session), { pathname: "/files/[id]", params: { id: "file" } });
    assert.deepEqual(missingConversationAction(session, "gone", undefined), { type: "leave" });
    assert.deepEqual(missingConversationAction(session, "gone", "agent"), { type: "wait" });
    session.connection = "open";
    assert.deepEqual(missingConversationAction(session, "gone", "agent"), { type: "recover", agentId: "agent" });
  } finally {
    await session.close();
  }
});

test("conversation switches clear previous message target as one navigation intent", () => {
  const state = {
    stale: false as const, key: "stack", type: "stack", index: 0, routeNames: ["chat"],
    routes: [{ key: "chat", name: "chat", params: { id: "old", message_seq: "42" } }],
  };
  const transitions: unknown[] = [];
  switchConversation("new", (params) => {
    transitions.push(BaseRouter.getStateForAction(state, { type: "SET_PARAMS", payload: { params } }));
  });
  assert.deepEqual(transitions, [{
    ...state, routes: [{ key: "chat", name: "chat", params: { id: "new", message_seq: undefined } }],
  }]);
});
