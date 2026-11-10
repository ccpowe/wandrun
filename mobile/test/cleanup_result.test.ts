import assert from 'node:assert/strict';
import test from 'node:test';
import { CleanupResults } from '../src/lib/cleanup-result.ts';
import type { GatewayEvent } from '../src/gateway/api.ts';

function navigation(name = 'agent-editor') {
  let route = { name, key: `${name}-visit` };
  const listeners = new Set<() => void>();
  return {
    getState: () => ({ index: 0, routes: [route] }),
    addListener(_type: 'state', listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    go(name: string, key = `${name}-visit`) { route = { name, key }; for (const listener of listeners) listener(); },
  };
}
const deletion: GatewayEvent = { seq: 19, at: 1, type: 'resource.changed', data: { kind: 'agent', op: 'deleted', id: 'a', cleanup_unconfirmed: [{ resource: 'browser', error: 'TimeoutError' }] } };

test('删除先 SSE 后 HTTP，仅实际最终导航落点领取一次；入口重定向不丢结果', () => {
  const owner = new CleanupResults(); const nav = navigation();
  owner.observeDeletion(deletion); assert.equal(owner.claim('chat-visit'), null);
  owner.begin('delete-1', 'delete-agent', 'a', () => true, nav);
  owner.observeDeletion(deletion);
  assert.equal(owner.claim('agent-editor-visit'), null);
  nav.go('index');
  nav.go('chat');
  const result = owner.claim('chat-visit');
  assert.deepEqual(result, { operationId: 'delete-1', seq: 19, kind: 'delete-agent' });
  owner.confirm('delete-1', deletion); owner.observeDeletion(deletion);
  assert.equal(owner.claim('chat-visit'), null);
});

test('迟到结果、无残留成功及离开目标访问都不会把告知带去无关页', () => {
  for (const mode of ['late', 'clean', 'different-destination'] as const) {
    const owner = new CleanupResults(); const nav = navigation(); let current = true;
    owner.begin(mode, 'delete-agent', 'a', () => current, nav);
    if (mode === 'late') { nav.go('agents'); current = false; }
    owner.observeDeletion(mode === 'clean' ? { ...deletion, data: { ...deletion.data, cleanup_unconfirmed: [] } } : deletion);
    nav.go('agents');
    nav.go('chat');
    assert.equal(owner.claim('chat-visit'), null);
  }
});

test('删除另一对话可在原聊天访问领取；切换不采信别的设备 SSE 或只读核对', () => {
  const owner = new CleanupResults(); const nav = navigation('chat');
  const event = { ...deletion, type: 'conversation.deleted', data: { ...deletion.data, id: 'other' } };
  owner.begin('delete-other', 'delete-conversation', 'other', () => true, nav, true);
  owner.observeDeletion(event);
  assert.equal(owner.claim('chat-visit')?.kind, 'delete-conversation');
  owner.begin('switch-1', 'switch', 'a', () => true, nav);
  owner.observeDeletion(deletion); nav.go('agents');
  owner.confirm('switch-1', deletion);
  assert.equal(owner.claim('agents-visit'), null);
});

test('导航状态已撤销时放弃本次告知，不在后续页面恢复', () => {
  const owner = new CleanupResults(); const nav = navigation();
  let available = true;
  owner.begin('old', 'delete-agent', 'a', () => true, {
    ...nav, getState: () => available ? nav.getState() : undefined,
  });
  owner.observeDeletion(deletion);
  available = false;
  nav.go('agents');
  available = true;
  owner.observeDeletion(deletion);
  nav.go('chat');
  assert.equal(owner.claim('chat-visit'), null);
  owner.begin('new', 'switch', 'a', () => true, nav);
  owner.confirm('new', deletion);
  nav.go('agents');
  assert.deepEqual(owner.claim('agents-visit'), { operationId: 'new', seq: 19, kind: 'switch' });
});

test('CleanupResultNotice.expired 失败撤销只认原操作，不丢较新操作或已到达的权威成功', () => {
  const owner = new CleanupResults(); const nav = navigation('chat');
  owner.begin('failed', 'delete-agent', 'a', () => true, nav, true);
  owner.reject('failed');
  owner.observeDeletion(deletion);
  assert.equal(owner.claim('chat-visit'), null);
  owner.begin('new', 'delete-agent', 'a', () => true, nav, true);
  owner.reject('failed');
  owner.observeDeletion(deletion);
  owner.reject('new');
  assert.deepEqual(owner.claim('chat-visit'), { operationId: 'new', seq: 19, kind: 'delete-agent' });
});
