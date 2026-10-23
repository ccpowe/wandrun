import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_LAYOUT, chatBottomLayout } from '../src/components/chat/chat-surface.ts';

test('capsule uses 16dp side margins, safe area + 20 closed and keyboard + 8 open', () => {
  for (const width of [320, 390, 720]) {
    assert.equal(width - 2 * CHAT_LAYOUT.contentInsetHorizontal, width - 32);
  }
  const screenHeight = 900;
  for (const safeBottom of [0, 16, 34]) {
    for (const capsuleHeight of [52, 120, 260]) {
      const measuredHeight = capsuleHeight + CHAT_LAYOUT.composerBottomGap;
      const layout = chatBottomLayout(measuredHeight, safeBottom);
      const closedCapsuleBottom = screenHeight - safeBottom - CHAT_LAYOUT.composerBottomGap;
      assert.equal(screenHeight - closedCapsuleBottom, safeBottom + 20);
      const keyboardHeight = 300;
      const openedWrapperBottom = screenHeight - safeBottom - keyboardHeight + layout.keyboardOffset;
      assert.equal(screenHeight - keyboardHeight - (openedWrapperBottom - CHAT_LAYOUT.composerBottomGap), 8);
    }
  }
});

test('list clearance, jump control and fade track measured composer size throughout keyboard motion', () => {
  const screenHeight = 900;
  const keyboardHeight = 300;
  for (const safeBottom of [0, 16, 34]) {
    for (const capsuleHeight of [52, 120, 260]) {
      const measuredHeight = capsuleHeight + CHAT_LAYOUT.composerBottomGap;
      const layout = chatBottomLayout(measuredHeight, safeBottom);
      for (const progress of [0, 0.5, 1]) {
        // Installed StickyView adds an interpolated offset; KeyboardChatScrollView
        // subtracts that same offset proportionally from the keyboard padding.
        const lift = progress * (keyboardHeight - layout.keyboardOffset);
        const wrapperBottom = screenHeight - safeBottom - lift;
        const capsuleTop = wrapperBottom - measuredHeight;
        const lastMessageBottom = screenHeight - safeBottom - measuredHeight - lift - CHAT_LAYOUT.listBottomGap;
        assert.equal(capsuleTop - lastMessageBottom, 16);
        assert.equal(capsuleTop - (wrapperBottom - layout.returnButtonBottom), CHAT_LAYOUT.returnButtonGap);
        assert.equal(wrapperBottom - layout.fadeSolidHeight,
          wrapperBottom - CHAT_LAYOUT.composerBottomGap - capsuleHeight / 2);
        assert.ok(layout.fadeHeight >= 130);
        assert.ok(layout.fadeHeight >= layout.fadeSolidHeight + CHAT_LAYOUT.bottomFadeAboveMidpoint);
        assert.equal(layout.stickyPaddingTop, CHAT_LAYOUT.returnButtonGap + CHAT_LAYOUT.returnButtonSize);
      }
    }
  }
});
