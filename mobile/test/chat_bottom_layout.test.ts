import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_LAYOUT, chatBottomLayout } from '../src/components/chat/chat-surface.ts';

test('list uses 16dp side insets, composer sits safe area + 12 closed and keyboard + 8 open', () => {
  for (const width of [320, 390, 720]) {
    assert.equal(width - 2 * CHAT_LAYOUT.contentInsetHorizontal, width - 32);
  }
  const screenHeight = 900;
  for (const safeBottom of [0, 16, 34]) {
    for (const capsuleHeight of [52, 120, 260]) {
      const measuredHeight = capsuleHeight + CHAT_LAYOUT.composerBottomGap;
      const layout = chatBottomLayout(measuredHeight, safeBottom);
      const closedCapsuleBottom = screenHeight - safeBottom - CHAT_LAYOUT.composerBottomGap;
      assert.equal(screenHeight - closedCapsuleBottom, safeBottom + 12);
      const keyboardHeight = 300;
      const openedWrapperBottom = screenHeight - safeBottom - keyboardHeight + layout.keyboardOffset;
      assert.equal(screenHeight - keyboardHeight - (openedWrapperBottom - CHAT_LAYOUT.composerBottomGap), 8);
    }
  }
});

test('list clearance (not pinned), jump control and fade track measured composer size throughout keyboard motion', () => {
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
        // Not pinned (chat.C9): while a sent message is pinned the content does not follow the keyboard, so this
        // clearance relation is only the library's keyboard compensation for the ordinary, following state.
        const lastMessageBottom = screenHeight - safeBottom - measuredHeight - lift - CHAT_LAYOUT.listBottomGap;
        assert.equal(capsuleTop - lastMessageBottom, 16);
        assert.equal(capsuleTop - (wrapperBottom - layout.returnButtonBottom), CHAT_LAYOUT.returnButtonGap);
        // Solid only below the bar; the fade ends a short transition above the composer top.
        assert.equal(wrapperBottom - layout.fadeSolidHeight, wrapperBottom - CHAT_LAYOUT.composerBottomGap);
        assert.equal(wrapperBottom - layout.fadeHeight, capsuleTop - CHAT_LAYOUT.bottomFadeAboveComposer);
        assert.equal(layout.stickyPaddingTop, CHAT_LAYOUT.returnButtonGap + CHAT_LAYOUT.returnButtonSize);
      }
    }
  }
});
