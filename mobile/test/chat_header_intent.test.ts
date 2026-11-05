import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collaborationPanelReducer as panel } from '../src/lib/chat-header-intent.ts';

test('chat.I1 I8 协作面板展开、关闭中保留、匹配退出完成才卸载', () => {
  const open = panel({ status: 'closed' }, { type: 'open', visitId: 'visit-1' });
  assert.deepEqual(open, { status: 'open', visitId: 'visit-1' });
  assert.equal(panel(open, { type: 'closed', visitId: 'visit-1' }), open);
  const closing = panel(open, { type: 'close' });
  assert.deepEqual(closing, { status: 'closing', visitId: 'visit-1' });
  assert.equal(panel(closing, { type: 'closed', visitId: 'old' }), closing);
  assert.deepEqual(panel(closing, { type: 'closed', visitId: 'visit-1' }), { status: 'closed' });
});
test('chat.I8 收起期间重开，新访问不被旧动画的完成关闭', () => {
  const reopened = panel({ status: 'closing', visitId: 'old' }, { type: 'open', visitId: 'new' });
  assert.equal(panel(reopened, { type: 'closed', visitId: 'old' }), reopened);
  assert.deepEqual(panel(panel(reopened, { type: 'close' }), { type: 'closed', visitId: 'new' }), { status: 'closed' });
});
