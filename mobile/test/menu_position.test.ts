import assert from 'node:assert/strict';
import { test } from 'node:test';

import { placeMenu } from '../src/components/ui/menu-position.ts';

const viewport = { x: 0, y: 0, width: 390, height: 760 };
const content = { width: 220, height: 158 };
const insets = { top: 24, right: 0, bottom: 34, left: 0 };
const position = (triggerY: number, options: Partial<Parameters<typeof placeMenu>[0]> = {}) => placeMenu({
  trigger: { x: 16, y: triggerY, width: 44, height: 44 },
  content, viewport, insets, side: 'bottom', align: 'start', sideOffset: 0, alignOffset: 0,
  avoidCollisions: true, ...options,
});

test('a menu by the composer flips above its trigger instead of losing its last item below the viewport', () => {
  const menu = position(654);
  assert.equal(menu.top, 496);
  assert.equal(menu.top + content.height, 654);
  assert.ok(menu.top + content.height <= viewport.height - insets.bottom);
  assert.equal(menu.left, 16);
  assert.equal(position(400).top, 444, 'when there is room, the requested bottom side remains anchored');
});

test('collision limits use the portal bounds and page origin, not the physical screen dimensions', () => {
  const menu = position(800, { viewport: { x: 8, y: 180, width: 340, height: 600 },
    trigger: { x: 24, y: 800, width: 44, height: 44 } });
  assert.equal(menu.top, 408); // Portal bottom is 180 + 600 - 34, even though the trigger sits below it.
  assert.equal(menu.left, 16);
  assert.ok(menu.top + content.height <= 600 - insets.bottom);
});

test('an open keyboard bounds the menu to the unobscured region and falls back to the opposite side', () => {
  const menu = position(460, { keyboardHeight: 260 });
  assert.equal(menu.top, 302);
  assert.ok(menu.top + content.height <= 500);
  assert.equal(position(295, { keyboardHeight: 260 }).top, 339);
});

test('requested top side flips down when only below fits; short viewports remain scrollable', () => {
  const flipped = position(34, { side: 'top' });
  assert.equal(flipped.top, 78);
  const tiny = position(65, { viewport: { x: 0, y: 0, width: 390, height: 130 },
    insets: { top: 10, bottom: 10 }, content: { width: 220, height: 180 } });
  assert.equal(tiny.top, 10);
  assert.equal(tiny.maxHeight, 110);
});

test('align=end and horizontal safe areas keep the menu reachable near the screen edge', () => {
  const menu = position(200, { trigger: { x: 370, y: 200, width: 44, height: 44 },
    align: 'end', insets: { top: 24, bottom: 34, left: 12, right: 20 } });
  assert.equal(menu.left, 150);
  assert.equal(menu.left + content.width, viewport.width - 20);
});
