import assert from 'node:assert/strict';
import { test } from 'node:test';

import { viewerMedia } from '../src/components/rich-message/media-viewer-source.ts';
import { boundMediaZoom, MAX_MEDIA_ZOOM, moveMediaZoom, RESET_ZOOM } from '../src/components/rich-message/media-zoom.ts';

const box = { w: 360, h: 600 };
const wide = { w: 2400, h: 600 };
const tall = { w: 600, h: 2400 };

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test('wide image: pinch grows tiny text, follows the focal point, and cannot leave blank edges', () => {
  const center = { x: 180, y: 300 };
  const enlarged = moveMediaZoom(RESET_ZOOM, center, center, 5, box, wide);
  assert.equal(enlarged.z, 5);
  const dragged = moveMediaZoom(enlarged, center, { x: -9999, y: 9999 }, 1, box, wide);
  // Fit is 360×90 with 255dp vertical letterboxing; after 5×, horizontal/vertical edges bound independently.
  near(dragged.tx, -1440);
  near(dragged.ty, -1200);
  const focused = moveMediaZoom(RESET_ZOOM, { x: 100, y: 300 }, { x: 110, y: 300 }, 2, box, wide);
  near(focused.tx + focused.z * 100, 110);
  const capped = moveMediaZoom(focused, center, center, 1000, box, wide);
  assert.equal(capped.z, MAX_MEDIA_ZOOM);
  assert.deepEqual(moveMediaZoom(capped, center, center, 0, box, wide), RESET_ZOOM);
});

test('short axis remains centered; switching image aspect and orientation changes bounds', () => {
  const zoomed = moveMediaZoom(RESET_ZOOM, { x: 180, y: 300 }, { x: 180, y: 300 }, 2, box, wide);
  near(zoomed.ty, -300);
  const nowTall = boundMediaZoom(zoomed, box, tall);
  near(nowTall.tx, -180);
  assert.ok(nowTall.ty <= 0 && nowTall.ty >= -600);
  assert.deepEqual(boundMediaZoom(RESET_ZOOM, { w: 600, h: 360 }, tall), RESET_ZOOM);
});

test('gallery image caption is complete for remote and authorized attachment paths', () => {
  const caption = '可辨认的文字'.repeat(33) + '末尾';
  assert.equal(caption.length, 200);
  const spec = JSON.stringify({ root: 'gallery', elements: { gallery: { type: 'Gallery', props: { items: [
    { url: 'https://images.example/wide.png', alt: '宽图', caption },
    { attachment: 'photos/a.png', alt: '附件', caption },
  ] }, children: [] } }, state: {} });
  const text = `前文\n\n\`\`\`wandrun-ui\n${spec}\n\`\`\``;
  const at = (index: number) => ({ conversationId: 'c', messageSeq: 42, block: 0, element: 'gallery', index });
  const status = [{ block: 0, valid: true, files: { 'photos/a.png': 'file-1' } }];
  const files = [{ id: 'file-1', media_type: 'image/png' }];
  assert.deepEqual(viewerMedia(text, at(0), status, files), { caption, fileId: undefined });
  assert.deepEqual(viewerMedia(text, at(1), status, files), { caption, fileId: 'file-1' });
  assert.equal(viewerMedia(text, at(1), status, [{ id: 'file-1', media_type: 'text/plain' }]), null);
  assert.equal(viewerMedia(text, at(2), status, files), null);
  assert.equal(viewerMedia(text, at(0), [{ block: 0, valid: false }], files), null);
});

test('local diagram source is resolved only from the selected closed and validated message block', () => {
  const source = 'flowchart LR\n  A[received] --> B[reply]';
  const spec = JSON.stringify({ root: 'diagram', elements: {
    diagram: { type: 'Mermaid', props: { source, title: 'Flow' }, children: [] },
  }, state: {} });
  const text = `Before\n\n\`\`\`wandrun-ui\n${spec}\n\`\`\``;
  const at = { conversationId: 'c', messageSeq: 50, block: 0, element: 'diagram', index: 0 };
  assert.deepEqual(viewerMedia(text, at, [{ block: 0, valid: true }]), { mermaid: source });
  assert.equal(viewerMedia(text, { ...at, index: 1 }), null);
  assert.equal(viewerMedia(text, { ...at, element: 'another' }), null);
  assert.equal(viewerMedia(text, at, [{ block: 0, valid: false }]), null);
  assert.equal(viewerMedia(`\`\`\`wandrun-ui\n${spec}`, at), null);
  assert.equal(viewerMedia(`\`\`\`mermaid\n${source}\n\`\`\``, at), null);
});
