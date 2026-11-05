import assert from "node:assert/strict";
import { test } from "node:test";

import { chatPinAnchorKey, chatPinFrozen, chatPinHolds, chatPinKeepsIdleRow, chatPinReducer, initialChatPin, type ChatPin, type ChatPinEvent } from "../src/lib/chat-pin.ts";

const run = (events: ChatPinEvent[], from: ChatPin = initialChatPin) => events.reduce(chatPinReducer, from);
const closing: ChatPin = { phase: "closing", request: "a" };
const pinned: ChatPin = { phase: "pinned", request: "a" };
const user: ChatPin = { phase: "user", request: "a" };

// chat.T36–T40 rows; state first, then event.
test("ordinary has no anchor, hold or freeze and ignores everything but a send", () => {
  assert.equal(chatPinAnchorKey(initialChatPin), null);
  assert.equal(chatPinHolds(initialChatPin), false);
  assert.equal(chatPinFrozen(initialChatPin), false);
  assert.equal(chatPinReducer(initialChatPin, { type: "user-navigation" }), initialChatPin);
  assert.equal(chatPinReducer(initialChatPin, { type: "keyboard-closed", clientId: "a" }), initialChatPin);
});

test("T36 a send enters closing: anchor = the sent row key, end-follow held, keyboard not yet frozen", () => {
  const state = run([{ type: "send", clientId: "a" }]);
  assert.deepEqual(state, closing);
  assert.equal(chatPinAnchorKey(state), "pa");
  assert.equal(chatPinHolds(state), true);
  assert.equal(chatPinFrozen(state), false);
});

test("T37 only the matching dismiss completion enters pinned isolation (hold + freeze)", () => {
  assert.equal(chatPinReducer(closing, { type: "keyboard-closed", clientId: "other" }), closing);
  const state = chatPinReducer(closing, { type: "keyboard-closed", clientId: "a" });
  assert.deepEqual(state, pinned);
  assert.equal(chatPinHolds(state), true);
  assert.equal(chatPinFrozen(state), true);
});

test("T38 user navigation from closing or pinned releases hold and freeze but keeps the anchor", () => {
  for (const from of [closing, pinned]) {
    const state = chatPinReducer(from, { type: "user-navigation" });
    assert.deepEqual(state, user);
    assert.equal(chatPinHolds(state), false);
    assert.equal(chatPinFrozen(state), false);
    assert.equal(chatPinAnchorKey(state), "pa");
  }
  assert.equal(chatPinReducer(user, { type: "user-navigation" }), user);
});

test("T38 a late dismiss after user navigation never re-enters isolation", () => {
  assert.deepEqual(run([{ type: "send", clientId: "a" }, { type: "user-navigation" }, { type: "keyboard-closed", clientId: "a" }]), user);
});

test("T39 a newer send replaces the earlier request; the earlier dismiss is ignored", () => {
  const state = run([{ type: "send", clientId: "a" }, { type: "send", clientId: "b" }, { type: "keyboard-closed", clientId: "a" }]);
  assert.deepEqual(state, { phase: "closing", request: "b" });
  assert.deepEqual(run([{ type: "keyboard-closed", clientId: "b" }], state), { phase: "pinned", request: "b" });
  // From pinned or user a new send starts a fresh closing phase again.
  assert.deepEqual(chatPinReducer(pinned, { type: "send", clientId: "c" }), { phase: "closing", request: "c" });
  assert.deepEqual(chatPinReducer(user, { type: "send", clientId: "c" }), { phase: "closing", request: "c" });
});

test("T40 pinned ignores a repeated dismiss completion", () => {
  assert.equal(chatPinReducer(pinned, { type: "keyboard-closed", clientId: "a" }), pinned);
});

// chat.C9b / T41: the blank placeholder that keeps the working row after the turn ended, same lifetime as the anchor.
test("turn-ended marks idle only while an anchor exists; ordinary ignores it", () => {
  assert.deepEqual(run([{ type: "turn-ended" }]), initialChatPin);
  assert.deepEqual(run([{ type: "turn-ended" }], closing), { phase: "closing", request: "a", idle: true });
  assert.deepEqual(run([{ type: "turn-ended" }], pinned), { phase: "pinned", request: "a", idle: true });
  assert.deepEqual(run([{ type: "turn-ended" }], user), { phase: "user", request: "a", idle: true });
  assert.equal(chatPinKeepsIdleRow(run([{ type: "turn-ended" }], pinned)), true);
  assert.equal(chatPinKeepsIdleRow(pinned), false);
  assert.equal(chatPinKeepsIdleRow(initialChatPin), false);
});

test("idle survives dismiss completion and user navigation, and a repeated turn-ended", () => {
  const idle = run([{ type: "turn-ended" }], closing);
  assert.deepEqual(run([{ type: "keyboard-closed", clientId: "a" }], idle), { phase: "pinned", request: "a", idle: true });
  assert.deepEqual(run([{ type: "user-navigation" }], run([{ type: "turn-ended" }], pinned)), { phase: "user", request: "a", idle: true });
  assert.equal(run([{ type: "turn-ended" }], idle), idle);
});

test("the next send clears idle in every phase (the new anchor takes over)", () => {
  for (const from of [closing, pinned, user]) {
    assert.deepEqual(run([{ type: "send", clientId: "b" }], run([{ type: "turn-ended" }], from)), { phase: "closing", request: "b" });
  }
});
