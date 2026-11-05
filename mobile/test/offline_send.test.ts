import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatSession } from '../src/gateway/session.ts';

test('chat.G3 T5 T6 T9 离线首发和手动重试立即失败，恢复不重放，在线重试沿用身份', async () => {
  const requests: { client_id: string; text: string }[] = [];
  const session = new ChatSession({ baseUrl: 'http://offline-send', token: 'test' }, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return new Response(JSON.stringify({ event: { seq: 1, type: 'message.user', conversation_id: 'root',
      client_id: body.client_id, at: 100, data: { text: body.text } } }), { headers: { 'content-type': 'application/json' } });
  });
  session.agents.close();
  try {
    session.connection = 'reconnecting';
    await session.send('root', 'keep this message');
    const pending = session.pendingFor('root')[0];
    assert.equal(requests.length, 0, 'offline must not issue an HTTP command');
    assert.equal(pending.status, 'failed');
    assert.equal(pending.retryable, true);
    assert.equal(pending.reason, 'offline');
    await session.retry(pending.clientId);
    assert.equal(requests.length, 0);
    assert.equal(pending.status, 'failed');
    session.connection = 'open';
    session['changed']();
    await Promise.resolve();
    assert.equal(requests.length, 0, 'reconnection does not retry failed messages');
    await session.retry(pending.clientId);
    assert.deepEqual(requests, [{ client_id: pending.clientId, text: 'keep this message', attachments: [] }]);
    assert.deepEqual(session.pendingFor('root'), []);
    assert.equal(session.timeline('root')?.events.filter(event => event.client_id === pending.clientId).length, 1);
  } finally { await session.close(); }
});

test('chat.D2 T6 root and member sends expire, retry the same identity, and accept a late stream receipt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: { client_id: string; text: string }[] = [];
  let reply = false;
  const session = new ChatSession({ baseUrl: 'http://send-deadline', token: 'test' }, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    if (!reply) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ event: { seq: 10, type: 'message.user', conversation_id: 'root',
      client_id: body.client_id, at: 100, data: { text: body.text } } }));
  });
  session.agents.close();
  session.connection = 'open';
  try {
    const sending = session.send('root', 'keep', [], 'same-id');
    t.mock.timers.tick(14_999);
    await Promise.resolve();
    assert.equal(session.pending.get('same-id')?.status, 'sending');
    t.mock.timers.tick(1);
    // Let the transport race and session catch settle, without awaiting an unbounded old implementation.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(session.pending.get('same-id')?.status, 'failed');
    await sending;
    assert.equal(session.pending.get('same-id')?.error, '结果未确认');
    assert.equal(session.pending.get('same-id')?.reason, 'timeout');
    assert.equal(session.pending.get('same-id')?.retryable, true);
    const retrying = session.retry('same-id');
    t.mock.timers.tick(15_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(session.pending.get('same-id')?.status, 'failed');
    await retrying;
    reply = true;
    await session.retry('same-id');
    assert.deepEqual(writes.map(write => write.client_id), ['same-id', 'same-id', 'same-id']);
    assert.equal(session.pending.has('same-id'), false);
    assert.deepEqual(session.timeline('root').events.map(event => event.client_id), ['same-id']);

    reply = false;
    session['apply']({ seq: 11, at: 101, type: 'task.created', conversation_id: 'root', data: {
      task_id: 'child', creator_task_id: 'root', creator_agent_id: 'parent', agent_id: 'member',
      title: 'Child', status: 'running', timeline_ids: ['root', 'child'],
    } });
    const memberSending = session.send('child', 'member message', [], 'member-id');
    t.mock.timers.tick(15_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert.equal(session.pending.get('member-id')?.error, '结果未确认');
    await memberSending;
    session['apply']({ seq: 12, at: 102, type: 'message.user', conversation_id: 'root', client_id: 'member-id',
      data: { task_id: 'child', text: 'member message', timeline_ids: ['child'] } });
    assert.equal(session.pending.has('member-id'), false);
    assert.deepEqual(session.timeline('child').events.filter(event => event.type === 'message.user').map(event => event.client_id), ['member-id']);
  } finally { await session.close(); }
});
