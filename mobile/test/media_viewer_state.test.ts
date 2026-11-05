import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachmentFiles, galleryPage, galleryReducer, mediaViewerLocation, type GalleryState } from '../src/lib/media-viewer.ts';

const browsing: GalleryState = { status: 'browsing', page: 1 };
const zoomed: GalleryState = { status: 'zoomed', page: 1 };
test('media.T1 最近可见页即时成为动作目标', () => {
  assert.deepEqual(galleryReducer(browsing, { type: 'scroll', page: 2 }), { status: 'browsing', page: 2 });
  assert.equal(galleryPage(550, 360, 3), 2);
  assert.equal(galleryPage(-30, 360, 3), 0);
  assert.equal(galleryPage(5000, 360, 3), 2);
});
test('media.T2 当前页放大锁住翻页', () => {
  assert.deepEqual(galleryReducer(browsing, { type: 'zoom', page: 1, zoom: 2 }), zoomed);
});
test('media.T3 缩回适配大小恢复翻页', () => {
  assert.deepEqual(galleryReducer(zoomed, { type: 'zoom', page: 1, zoom: 1 }), browsing);
});
test('media.T4 离屏图片的迟到缩放回调不改变当前页能力', () => {
  assert.equal(galleryReducer(browsing, { type: 'zoom', page: 0, zoom: 2 }), browsing);
  assert.equal(galleryReducer(zoomed, { type: 'zoom', page: 0, zoom: 1 }), zoomed);
});
test('media.T5 滚动结束选择最终页并清缩放锁', () => {
  for (const state of [browsing, zoomed]) assert.deepEqual(galleryReducer(state, { type: 'momentum-end', page: 2 }), { status: 'browsing', page: 2 });
});
test('media.T6 原生滚动尚未结束时不提前清缩放锁', () => {
  assert.deepEqual(galleryReducer(zoomed, { type: 'scroll', page: 2 }), { status: 'zoomed', page: 2 });
});
test('media.A1 只接收合法持久消息坐标', () => {
  const params = { id: 'conversation', seq: '3', block: 'markdown', element: 'image', index: '2' };
  assert.deepEqual(mediaViewerLocation(params), { conversationId: 'conversation', messageSeq: 3, block: 'markdown', element: 'image', index: 2 });
  for (const patch of [{ seq: '-1' }, { block: '-1' }, { index: '1.5' }, { element: '' }, { id: '' }]) {
    assert.equal(mediaViewerLocation({ ...params, ...patch }), undefined);
  }
});
test('media.B1 附件仅取图片，保持路由顺序并保留独立选定 id', () => {
  const raw = [{ id: 'a', name: 'A', media_type: 'image/png' }, { id: 'text', name: 'T', media_type: 'text/plain' }];
  assert.deepEqual(attachmentFiles(raw, 'invalid', 'b'), [raw[0], { id: 'b', name: 'b', media_type: 'image/*' }]);
  assert.deepEqual(attachmentFiles(raw, '["b","a"]', 'a').map(file => file.id), ['b', 'a']);
});
