import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MERMAID_INLINE_MAX, MERMAID_INLINE_WAITING, mermaidInlineHeight } from '../src/lib/mermaid-inline.ts';

test('Mermaid.waiting reserves 160 until a size and width are known', () => {
  assert.deepEqual(mermaidInlineHeight(undefined, 360), { height: MERMAID_INLINE_WAITING, tall: false });
  assert.deepEqual(mermaidInlineHeight({ width: 300, height: 100 }, 0), { height: MERMAID_INLINE_WAITING, tall: false });
  assert.deepEqual(mermaidInlineHeight({ width: 0, height: 100 }, 360), { height: MERMAID_INLINE_WAITING, tall: false });
});

test('Mermaid.fit uses the fitted natural height without enlarging small diagrams', () => {
  assert.deepEqual(mermaidInlineHeight({ width: 300, height: 90 }, 360), { height: 90, tall: false }, 'narrower than the box: natural height');
  assert.deepEqual(mermaidInlineHeight({ width: 720, height: 400 }, 360), { height: 200, tall: false }, 'wider: scaled to the box width');
  assert.deepEqual(mermaidInlineHeight({ width: 300, height: 20 }, 360), { height: 48, tall: false }, 'a minimum keeps the tap target');
});

test('Mermaid.tall caps at 320 and flags the diagram for the open hint', () => {
  assert.deepEqual(mermaidInlineHeight({ width: 300, height: 1640 }, 360), { height: MERMAID_INLINE_MAX, tall: true });
  assert.deepEqual(mermaidInlineHeight({ width: 360, height: 320 }, 360), { height: 320, tall: false }, 'exactly 320 is not tall');
});
