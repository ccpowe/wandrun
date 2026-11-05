import assert from "node:assert/strict";
import { test } from "node:test";

import { newChatChips, recentAgentOrder } from "../src/lib/new-chat-agents.ts";

const agents = ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((agent) => agent.id).join("");

test("chat.N2 recent order: latest conversation activity first, unused Agents follow in catalog order", () => {
  const conversations = [
    { agent_id: "c", last_activity_seq: 5 },
    { agent_id: "e", last_activity_seq: 9 },
    { agent_id: "c", last_activity_seq: 12 },
    { agent_id: "gone", last_activity_seq: 99 },
    { agent_id: "f", last_activity_seq: null },
  ];
  assert.equal(ids(recentAgentOrder(agents, conversations)), "cefabdg");
  assert.equal(ids(recentAgentOrder(agents, [])), "abcdefg");
});

test("agent-list.A7 creation baseline, equal activity, new and deleted Agents use one ranking", () => {
  const roots = [
    { agent_id: "d", last_activity_seq: 8 },
    { agent_id: "b", last_activity_seq: 8 },
    { agent_id: "f", last_activity_seq: null },
  ];
  // Equal activity preserves the gateway baseline, independent of the roots' iteration order.
  assert.equal(ids(recentAgentOrder(agents, roots)), "bdfaceg");
  const added = [...agents, { id: "new" }];
  assert.deepEqual(recentAgentOrder(added, roots).map(agent => agent.id), ["b", "d", "f", "a", "c", "e", "g", "new"]);
  const deleted = added.filter(agent => agent.id !== "b");
  assert.deepEqual(recentAgentOrder(deleted, roots).map(agent => agent.id), ["d", "f", "a", "c", "e", "g", "new"]);
  // Removing the last root makes that Agent unused again, without losing its baseline position.
  assert.equal(ids(recentAgentOrder(agents, roots.filter(root => root.agent_id !== "f"))), "bdacefg");
});

test("chat.N2 chips: first five in place, a selection beyond them leads the row", () => {
  assert.equal(ids(newChatChips(agents, "c")), "abcde");
  assert.equal(ids(newChatChips(agents, "g")), "gabcd");
  assert.equal(ids(newChatChips(agents.slice(0, 3), "b")), "abc");
  assert.equal(ids(newChatChips(agents, "missing")), "abcde");
});
