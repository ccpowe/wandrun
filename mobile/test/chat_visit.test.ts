import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatVisit, chatWelcomeReducer, chatWelcomeVisible, initialChatWelcome } from '../src/lib/chat-visit.ts';

test('chat.O4 promotion preserves the initiating target, including a background binding', () => {
  const visit = new ChatVisit({});
  const close = visit.activate();
  const submitted = visit.capture();
  assert.equal(visit.promote(submitted, 'created-root'), true);
  visit.admit({ id: 'created-root' });
  assert.equal(visit.allows(submitted), true);
  assert.equal(visit.getSnapshot(), submitted.generation);
  close();
});

test('chat.O14 T31 switching a focused route revokes old creation even after returning to draft', () => {
  const visit = new ChatVisit({});
  const close = visit.activate();
  const old = visit.capture();
  visit.admit({ id: 'another-root' });
  assert.equal(visit.promote(old, 'late-created-root'), false);
  visit.admit({});
  assert.equal(visit.promote(old, 'late-created-root'), false);
  const current = visit.capture();
  assert.equal(visit.promote(current, 'new-created-root'), true);
  close();
});

test('chat.O16 a new message placement invalidates old UI callbacks, ordinary updates do not', () => {
  const visit = new ChatVisit({ id: 'root', messageSeq: 15 });
  const close = visit.activate();
  const first = visit.capture();
  visit.admit({ id: 'root', messageSeq: 15 });
  assert.equal(visit.allows(first), true);
  visit.admit({ id: 'root', messageSeq: 42 });
  assert.equal(visit.allows(first), false);
  const second = visit.capture();
  visit.admit({ id: 'root', messageSeq: 42 });
  assert.equal(visit.allows(second), true);
  close();
});

test('chat.O15 two draft route instances cannot claim each other’s binding result', () => {
  const first = new ChatVisit({});
  const second = new ChatVisit({});
  const closeFirst = first.activate();
  const closeSecond = second.activate();
  const lease = first.capture();
  assert.equal(second.promote(lease, 'created-root'), false);
  assert.equal(first.promote(lease, 'created-root'), true);
  assert.equal(second.allows(second.capture()), true);
  assert.equal(first.promote(lease, 'different-root'), false);
  closeFirst();
  closeSecond();
});

test('chat.O17 removal and repeated mount cleanup never restore a previous result’s permission', () => {
  const visit = new ChatVisit({});
  let close = visit.activate();
  const removed = visit.capture();
  visit.admit(null);
  assert.equal(visit.promote(removed, 'late-root'), false);
  close();
  close = visit.activate();
  assert.equal(visit.promote(removed, 'late-root'), false);
  const current = visit.capture();
  assert.equal(visit.promote(current, 'current-root'), true);
  close();
  assert.equal(visit.allows(current), false);
});

test('chat.O17 a store replacement revokes the prior callback without blocking a fresh visit at the same URL', () => {
  const visit = new ChatVisit({ id: 'root' });
  const close = visit.activate();
  const old = visit.capture();
  visit.invalidate();
  assert.equal(visit.allows(old), false);
  assert.equal(visit.matches({ id: 'root' }), true);
  assert.equal(visit.allows(visit.capture()), true);
  close();
});

test('chat.O2 focus ends welcome permanently for that visit; blur does not bring it back', () => {
  assert.equal(chatWelcomeVisible(initialChatWelcome, 0), true);
  const focused = chatWelcomeReducer(initialChatWelcome, { type: 'focus', generation: 0 });
  assert.equal(chatWelcomeVisible(focused, 0), false);
  const blurred = chatWelcomeReducer(focused, { type: 'blur', generation: 0 });
  assert.equal(chatWelcomeVisible(blurred, 0), false);
  assert.equal(chatWelcomeVisible(blurred, 1), true);
});

test('chat.O2 an already focused retained input never revives welcome when the target generation changes', () => {
  const focused = chatWelcomeReducer(initialChatWelcome, { type: 'focus', generation: 0 });
  assert.equal(chatWelcomeVisible(focused, 1), false);
  const blurred = chatWelcomeReducer(focused, { type: 'blur', generation: 1 });
  assert.equal(chatWelcomeVisible(blurred, 1), false);
});

test('chat.O11 first attachment ends welcome without inventing a keyboard event', () => {
  const engaged = chatWelcomeReducer(initialChatWelcome, { type: 'engage', generation: 0 });
  assert.equal(chatWelcomeVisible(engaged, 0), false);
  assert.equal(engaged.status, 'unfocused');
  assert.equal(chatWelcomeReducer(initialChatWelcome, { type: 'blur', generation: 0 }), initialChatWelcome);
});
