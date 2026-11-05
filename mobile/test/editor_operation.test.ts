import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { GatewayApi, type AgentDetail, type Connector, type GatewayEvent } from '../src/gateway/api.ts';
import { EditorOperations } from '../src/gateway/editor-operation.ts';
import { draftFromAgent } from '../src/lib/agent-editor.ts';

const detail: AgentDetail = { id: 'a', name: '原名', avatar: 0, description: '说明', workers: [], system_prompt: '提示词', model: 'offline', reasoning_effort: 'medium', fast_mode: false, code_mode: true, environment: 'local', skills: [], mcp_servers: [], searchable_mcp_servers: [], member_of: [] };
const createFields = draftFromAgent(detail);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const unavailable = () => json({ error: { code: 'unavailable', message: '暂不可用' } }, 503);
const missing = () => json({ error: { code: 'not_found', message: '不存在' } }, 404);
const receipt = (client: string, id = 'a'): GatewayEvent => ({ seq: 1, at: 1, type: 'resource.changed', client_id: client, data: { kind: 'agent', id, op: 'created' } });
function api(fetcher: typeof fetch) { return new GatewayApi({ baseUrl: 'https://editor.invalid', token: 'test', computerId: 'test' }, fetcher); }

test('editor-operation: 未确认编辑恢复只读回；重复提交被挡住；当前资源不同不猜成功', async t => {
  let writes = 0;
  let reads = 0;
  let online = true;
  let readable = false;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'PATCH') { writes++; return unavailable(); }
    reads++; return readable ? json(detail) : unavailable();
  });
  const operations = new EditorOperations(gateway, () => online, () => {});
  t.after(() => operations.close());
  await assert.rejects(operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save', fields: { name: '新名' } }, () => gateway.updateAgent('a', { name: '新名' })));
  await settle();
  assert.equal(operations.get('agent:a')?.status, 'unknown');
  const operationId = operations.get('agent:a')!.operationId;
  assert.equal(await operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save' }, () => gateway.updateAgent('a', { name: '再试' })), null);
  online = false;
  const before = reads; operations.recover(); await settle(); assert.equal(reads, before);
  online = true; readable = true; operations.recover(); await settle();
  assert.equal(writes, 1);
  assert.equal(operations.get('agent:a')?.status, 'synced');
  assert.equal(operations.get('agent:a')?.operationId, operationId);
  assert.equal(operations.get('agent:a')?.value && (operations.get('agent:a')!.value as AgentDetail).name, '原名');
});

test('editor-operation: 没有精确 client_id 回执的新建永不凭字段猜测或重放', async t => {
  let writes = 0; let reads = 0;
  const gateway = api(async (_input, init) => { if (init?.method === 'POST') { writes++; return unavailable(); } reads++; return json(detail); });
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:new', { operationId: crypto.randomUUID(), resource: 'agent', action: 'save', clientId: 'wanted', fields: { name: detail.name } }, () => gateway.createAgent('wanted', createFields)));
  operations.observe(receipt('other')); operations.recover(); await settle();
  assert.equal(operations.get('agent:new')?.status, 'unknown'); assert.equal(reads, 0);
  assert.equal(await operations.run('agent:new', { operationId: crypto.randomUUID(), resource: 'agent', action: 'save', clientId: 'wanted' }, () => gateway.createAgent('wanted', createFields)), null);
  assert.equal(writes, 1);
});

for (const early of [true, false]) test(`editor-operation: 创建回执${early ? '先于' : '晚于'}未确认应答，读回后切换已有项身份`, async t => {
  let writes = 0;
  let readable = false;
  let operations: EditorOperations;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'POST') { writes++; if (early) operations.observe(receipt('wanted')); return unavailable(); }
    return readable ? json(detail) : unavailable();
  });
  operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:new', { operationId: crypto.randomUUID(), resource: 'agent', action: 'save', clientId: 'wanted', fields: { name: detail.name } }, () => gateway.createAgent('wanted', createFields)));
  await settle();
  if (!early) operations.observe(receipt('wanted'));
  await settle();
  assert.equal(operations.get('agent:new')?.status, 'unknown');
  readable = true; operations.recover(); await settle();
  assert.equal(operations.get('agent:new')?.status, 'confirmed');
  assert.equal(operations.get('agent:a'), operations.get('agent:new'));
  const operationId = operations.get('agent:new')!.operationId;
  operations.handoffCreation('agent', 'older-operation', 'a');
  operations.handoffCreation('agent', operationId, 'other-resource');
  assert.equal(operations.get('agent:new'), operations.get('agent:a'));
  operations.handoffCreation('agent', operationId, 'a');
  assert.equal(operations.get('agent:new'), undefined);
  assert.equal(operations.get('agent:a')?.id, 'a'); assert.equal(writes, 1);
});

test('editor-operation: 删除读回 404 是最终已删除；保存读回 404 不报告保存成功', async t => {
  const gateway = api(async (_input, init) => init?.method === 'GET' ? missing() : unavailable());
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'delete' }, () => gateway.deleteAgent('a'))); await settle();
  assert.equal(operations.get('agent:a')?.status, 'confirmed'); assert.equal(operations.get('agent:a')?.value, null);
  await assert.rejects(operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save', fields: { name: '新名' } }, () => gateway.updateAgent('a', { name: '新名' }))); await settle();
  assert.equal(operations.get('agent:a')?.status, 'synced'); assert.equal(operations.get('agent:a')?.value, null);
});

test('editor-operation: 明确拒绝允许有意识地再提交，不把 408 误判为明确失败', async t => {
  let status = 400;
  const gateway = api(async (_input, init) => init?.method === 'GET' ? unavailable() : json({ error: { code: 'invalid_request', message: '不能保存' } }, status));
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  const save = () => operations.run('schedule:s', { operationId: crypto.randomUUID(), resource: 'schedule', id: 's', action: 'save' }, () => gateway.updateSchedule('s', { name: '名称' }));
  await assert.rejects(save()); assert.equal(operations.get('schedule:s')?.status, 'failed');
  status = 408; await assert.rejects(save()); await settle(); assert.equal(operations.get('schedule:s')?.status, 'unknown');
});

test('editor-operation: 写入期限到达转为未知，迟到成功不重新导航或覆盖核对结果', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers<Response>();
  const gateway = api(async (_input, init) => init?.method === 'GET' ? json(detail) : held.promise);
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  const pending = operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save', fields: { name: '新名' } }, () => gateway.updateAgent('a', { name: '新名' }));
  const failed = assert.rejects(pending); t.mock.timers.tick(15_000); await failed; await settle();
  assert.equal(operations.get('agent:a')?.status, 'synced');
  held.resolve(json({ agent: { ...detail, name: '新名' }, event: null })); await settle();
  assert.equal(operations.get('agent:a')?.status, 'synced');
});

test('editor-operation: 关闭会话后迟到读回不能发布结果或留下重试', async t => {
  const held = Promise.withResolvers<Response>();
  let notifications = 0;
  const gateway = api(async (_input, init) => init?.method === 'GET' ? held.promise : unavailable());
  const operations = new EditorOperations(gateway, () => true, () => { notifications++; }); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save', fields: { name: '新名' } }, () => gateway.updateAgent('a', { name: '新名' }))); await settle();
  operations.close(); const before = notifications; held.resolve(json({ ...detail, name: '新名' })); await settle();
  assert.equal(notifications, before); assert.equal(operations.get('agent:a'), undefined);
});

test('editor-operation: 精确回执到达即绑定资源 owner，核对期间不能从列表再提交', async t => {
  const held = Promise.withResolvers<Response>();
  let writes = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'GET') return held.promise;
    writes++; return unavailable();
  });
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:new', { operationId: crypto.randomUUID(), resource: 'agent', action: 'save', clientId: 'wanted', fields: { name: detail.name } }, () => gateway.createAgent('wanted', createFields)));
  operations.observe(receipt('wanted'));
  assert.equal(operations.get('agent:a'), operations.get('agent:new'));
  assert.equal(await operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save' }, () => gateway.updateAgent('a', { name: '再提交' })), null);
  held.resolve(json(detail)); await settle();
  assert.equal(operations.get('agent:a')?.status, 'confirmed'); assert.equal(writes, 1);
});

test('editor-operation: 晚到的创建回执与读回不能覆盖资源上较新的 pending / unknown 操作', async t => {
  const held = Promise.withResolvers<Response>();
  let readable = true;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'POST') return unavailable();
    if (init?.method === 'PATCH') return held.promise;
    return readable ? json(detail) : unavailable();
  });
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:new', { operationId: crypto.randomUUID(), resource: 'agent', action: 'save', clientId: 'wanted', fields: { name: detail.name } }, () => gateway.createAgent('wanted', createFields)));
  const editing = operations.run('agent:a', { operationId: crypto.randomUUID(), resource: 'agent', id: 'a', action: 'save', fields: { name: '较新改名' } }, () => gateway.updateAgent('a', { name: '较新改名' }));
  const newer = operations.get('agent:a');
  operations.observe(receipt('wanted')); await settle();
  assert.equal(operations.get('agent:new')?.status, 'confirmed');
  assert.equal(operations.get('agent:a'), newer);
  assert.equal(newer?.status, 'pending');
  readable = false;
  const rejected = assert.rejects(editing); held.resolve(unavailable()); await rejected; await settle();
  assert.equal(operations.get('agent:a'), newer); assert.equal(newer?.status, 'unknown');
});

for (const applied of [false, true]) test(`settings-models.T3：默认设置${applied ? '相同' : '不同'}只证明当前值，不证明原请求成功且不重放`, async t => {
  let writes = 0;
  let readable = false;
  const wanted = { default_model: 'careful', default_reasoning_effort: 'high' };
  const current = applied ? wanted : { default_model: 'offline', default_reasoning_effort: null };
  const gateway = api(async (_input, init) => {
    if (init?.method === 'PUT') { writes++; return unavailable(); }
    return readable ? json(current) : unavailable();
  });
  const operations = new EditorOperations(gateway, () => true, () => {});
  t.after(() => operations.close());
  const save = () => operations.run('settings:models', { operationId: crypto.randomUUID(), resource: 'settings', action: 'save', fields: wanted }, () => gateway.updateSettings(wanted));
  await assert.rejects(save()); await settle();
  assert.equal(operations.get('settings:models')?.status, 'unknown');
  assert.equal(await save(), null);
  readable = true; operations.recover(); await settle();
  assert.equal(operations.get('settings:models')?.status, 'synced');
  assert.deepEqual(operations.get('settings:models')?.value, current);
  assert.equal(writes, 1);
});

test('settings-models.B4：模型目录校验 503 明确发生在持久化之前，不误报结果未知', async t => {
  let reads = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'GET') reads++;
    return json({ error: { code: 'model_catalog_unavailable', message: '不能保存新组合' } }, 503);
  });
  const operations = new EditorOperations(gateway, () => true, () => {});
  t.after(() => operations.close());
  await assert.rejects(operations.run('settings:models', { operationId: crypto.randomUUID(), resource: 'settings', action: 'save' }, () => gateway.updateSettings({ default_model: 'new', default_reasoning_effort: null })));
  assert.equal(operations.get('settings:models')?.status, 'failed');
  assert.equal(reads, 0);
});

test('settings-connector-editor.B7/B8 精确创建回执恢复连接器身份；密钥已设置不证明覆盖成功', async t => {
  let writes = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method !== 'GET') { writes++; return unavailable(); }
    return json({ id: 'docs', name: '资料', headers: { Authorization: true } });
  });
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('connector:new', { operationId: crypto.randomUUID(), resource: 'connector', action: 'save', clientId: 'wanted', fields: { name: '资料', headers: { Authorization: 'new-secret' } }, }, () => gateway.createConnector('wanted', { name: '资料', url: 'https://example.invalid/mcp' })));
  operations.observe({ ...receipt('other', 'docs'), data: { kind: 'connector', id: 'docs', op: 'created' } });
  await settle();
  assert.equal(operations.get('connector:new')?.status, 'unknown');
  operations.observe({ ...receipt('wanted', 'docs'), data: { kind: 'connector', id: 'docs', op: 'created' } });
  await settle();
  assert.equal(operations.get('connector:new')?.status, 'synced');
  assert.equal(operations.get('connector:docs'), operations.get('connector:new'));
  assert.equal(writes, 1);
});
test('connector-add.N8 502 connection_failed 是确定写前失败，修改后可重试而不读回或重放', async t => {
  let writes = 0; let reads = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'GET') { reads++; return missing(); }
    writes++;
    return writes === 1 ? json({ error: { code: 'connection_failed', message: '连接失败', probe: { result: 'failed', error: { code: 'connection_failed', message: '请求超时' } } } }, 502)
      : json({ connector: { id: 'created', name: '修正后的服务' }, event: { ...receipt('retry', 'created'), data: { kind: 'connector', id: 'created', op: 'created' } } }, 201);
  });
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('connector:new', { operationId: 'first', resource: 'connector', action: 'save', clientId: 'first' }, () => gateway.createConnector('first', { url: 'https://wrong.invalid/mcp' })));
  assert.equal(operations.get('connector:new')?.status, 'failed');
  await settle(); assert.equal(reads, 0);
  await operations.run('connector:new', { operationId: 'retry', resource: 'connector', action: 'save', clientId: 'retry' }, () => gateway.createConnector('retry', { url: 'https://fixed.invalid/mcp' }));
  assert.equal(operations.get('connector:new')?.status, 'confirmed');
  assert.equal(writes, 2); assert.equal(reads, 0);
});

test('editor-operation: 新建访问保留未解决操作，只消费已解决 new 别名并保护资源 owner', async t => {
  const gateway = api(async (_input, init) => init?.method === 'GET' ? json(detail) : unavailable());
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('agent:new', { operationId: 'create-1', resource: 'agent', action: 'save', clientId: 'wanted' }, () => gateway.createAgent('wanted', createFields)));
  operations.beginCreationVisit('agent');
  assert.equal(operations.get('agent:new')?.operationId, 'create-1');
  operations.observe(receipt('wanted')); await settle();
  operations.beginCreationVisit('agent');
  assert.equal(operations.get('agent:new'), undefined);
  assert.equal(operations.get('agent:a')?.operationId, 'create-1');
  const held = Promise.withResolvers<unknown>();
  const pending = operations.run('agent:new', { operationId: 'create-2', resource: 'agent', action: 'save' }, () => held.promise);
  operations.handoffCreation('agent', 'create-1', 'a');
  operations.beginCreationVisit('agent');
  assert.equal(operations.get('agent:new')?.operationId, 'create-2');
  held.resolve({}); await pending;
});

const createdConnector: Connector = {
  id: 'created', name: '资料', description: '', url: 'https://example.invalid/mcp', auth_type: 'none', app_id: null,
  auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null,
  tool_count: 1, used_by: [], pending_restart: false,
};
const connectorReceipt = (clientId: string, id = createdConnector.id): GatewayEvent => ({
  ...receipt(clientId, id), data: { kind: 'connector', id, op: 'created' },
});

for (const mode of ['remote', 'local'] as const) for (const accepted of [true, false]) {
  test(`connector-create.S1 ${mode} 正常连接超过15秒，仍等待网关${accepted ? '成功' : '确定写前拒绝'}而不提前unknown`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const held = Promise.withResolvers<Response>();
    let writes = 0; let reads = 0;
    const gateway = api(async (_input, init) => {
      if (init?.method === 'POST') { writes++; return held.promise; }
      reads++; return unavailable();
    });
    const operations = new EditorOperations(gateway, () => true, () => {});
    t.after(() => { held.resolve(unavailable()); operations.close(); });
    const fields = mode === 'remote' ? { url: createdConnector.url! } : { command: 'npx', args: ['-y', 'example-mcp'] };
    const finished = operations.run('connector:new', {
      operationId: 'slow-create', resource: 'connector', action: 'save', clientId: 'slow-create', fields,
    }, () => gateway.createConnector('slow-create', fields)).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    t.mock.timers.tick(15_001); await settle();
    assert.equal(operations.get('connector:new')?.status, 'pending', '首次连接仍在网关合法期限内，不能提前变为结果未知');
    t.mock.timers.tick(9_999);
    held.resolve(accepted
      ? json({ connector: createdConnector, event: connectorReceipt('slow-create'), replayed: false }, 201)
      : json({ error: { code: 'connection_failed', message: '连接失败' } }, 502));
    const result = await finished;
    assert.equal(operations.get('connector:new')?.status, accepted ? 'confirmed' : 'failed');
    assert.equal(!!result.error, !accepted);
    assert.equal(writes, 1); assert.equal(reads, 0);
  });
}

// GET reports an attempt outcome, not "no row = not created": an in-flight or unseen POST
// must stay unknown. A terminal rejection is explicit and never implemented by replaying POST.
for (const terminal of ['created', 'not_created'] as const) {
  test(`connector-create.S1 无id/无created事件按相同client_id只读核对并收敛${terminal}`, async t => {
    const clientId = 'lost/response?client=one';
    const requests: { method: string; url: URL }[] = [];
    let result: 'pending' | typeof terminal = 'pending';
    const gateway = api(async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? 'GET';
      requests.push({ method, url });
      if (method === 'POST') return unavailable();
      if (url.pathname === '/connectors/creation-result') return json(result === 'created'
        ? { status: result, connector: createdConnector, event: connectorReceipt(clientId) }
        : { status: result });
      if (url.pathname === '/connectors/created') return json(createdConnector);
      return missing();
    });
    const operations = new EditorOperations(gateway, () => true, () => {});
    t.after(() => operations.close());
    await assert.rejects(operations.run('connector:new', {
      operationId: 'lost-create', resource: 'connector', action: 'save', clientId, fields: { url: createdConnector.url },
    }, () => gateway.createConnector(clientId, { url: createdConnector.url! })));
    await settle();
    assert.equal(operations.get('connector:new')?.status, 'unknown');
    assert.equal(operations.get('connector:new')?.id, undefined);
    result = terminal; operations.recover(); await settle();
    const queries = requests.filter(request => request.url.pathname === '/connectors/creation-result');
    assert.ok(queries.length > 0, '无资源id也必须读取创建回执，不能永远跳过核对');
    assert.ok(queries.every(request => request.method === 'GET' && request.url.searchParams.get('client_id') === clientId));
    assert.equal(requests.filter(request => request.method === 'POST').length, 1, '只读核对不得重放POST');
    const outcome = operations.get('connector:new');
    assert.equal(outcome?.status, terminal === 'created' ? 'confirmed' : 'failed');
    assert.equal(outcome?.reconciled, true);
    if (terminal === 'created') {
      assert.equal(outcome?.id, 'created');
      assert.equal(operations.get('connector:created'), outcome);
      assert.deepEqual(outcome?.value, createdConnector);
      assert.ok(requests.some(request => request.method === 'GET' && request.url.pathname === '/connectors/created'), '回执只认身份，仍须读取资源当前值');
    } else {
      assert.equal(outcome?.value, null);
      assert.equal(outcome?.id, undefined);
      assert.equal(operations.get('connector:undefined'), undefined);
    }
  });
}

for (const unresolved of ['pending', 'unknown'] as const) {
  test(`connector-create.S1 只读回执${unresolved}不能误判未创建，也不重放POST`, async t => {
    let writes = 0; let queries = 0;
    const gateway = api(async (input, init) => {
      if (init?.method === 'POST') { writes++; return unavailable(); }
      const url = new URL(String(input));
      assert.equal(url.pathname, '/connectors/creation-result');
      assert.equal(url.searchParams.get('client_id'), 'still-running');
      queries++; return json({ status: unresolved });
    });
    const operations = new EditorOperations(gateway, () => true, () => {});
    t.after(() => operations.close());
    await assert.rejects(operations.run('connector:new', {
      operationId: 'still-running', resource: 'connector', action: 'save', clientId: 'still-running',
    }, () => gateway.createConnector('still-running', { url: createdConnector.url! })));
    await settle(); operations.recover(); await settle();
    assert.ok(queries > 0, '必须实际查询回执，不能靠缺少id永久搁置');
    assert.equal(operations.get('connector:new')?.status, 'unknown');
    assert.equal(operations.get('connector:new')?.reconciled, false);
    assert.equal(writes, 1);
  });
}

test('connector-create.S1 新空白访问不被旧unknown锁住，旧核对继续且不挤占新创建', async t => {
  const newerResponse = Promise.withResolvers<Response>();
  let oldReadable = false; let writes = 0; let oldQueries = 0;
  const receipts: string[] = [];
  const gateway = api(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      writes++;
      return writes === 1 ? unavailable() : newerResponse.promise;
    }
    if (url.pathname === '/connectors/creation-result') {
      assert.equal(url.searchParams.get('client_id'), 'old-client');
      oldQueries++;
      return oldReadable ? json({ status: 'created', connector: createdConnector, event: connectorReceipt('old-client') }) : unavailable();
    }
    if (url.pathname === '/connectors/created') return json(createdConnector);
    return missing();
  });
  const operations = new EditorOperations(gateway, () => true, receipt => { if (receipt) receipts.push(receipt.operationId); });
  t.after(() => { newerResponse.resolve(unavailable()); operations.close(); });
  await assert.rejects(operations.run('connector:new', {
    operationId: 'old-operation', resource: 'connector', action: 'save', clientId: 'old-client', fields: { url: createdConnector.url },
  }, () => gateway.createConnector('old-client', { url: createdConnector.url! })));
  await settle();
  const old = operations.get('connector:new');
  assert.equal(old?.status, 'unknown');
  operations.beginCreationVisit('connector');
  assert.equal(operations.get('connector:new'), undefined, '新访问必须得到空白创建槽，旧unknown仍由session追踪');
  const newer = operations.run('connector:new', {
    operationId: 'new-operation', resource: 'connector', action: 'save', clientId: 'new-client',
  }, () => gateway.createConnector('new-client', { url: 'https://other.invalid/mcp' })).catch(() => null);
  const current = operations.get('connector:new');
  assert.equal(current?.operationId, 'new-operation'); assert.equal(current?.status, 'pending');
  const before = oldQueries;
  oldReadable = true; operations.recover(); await settle();
  assert.ok(oldQueries > before, '解除new别名不能停止旧创建核对');
  assert.equal(old?.status, 'confirmed');
  assert.equal(operations.get('connector:created'), old);
  assert.ok(receipts.includes('old-operation'), '旧创建仍须发布自己的最终结果');
  assert.equal(operations.get('connector:new'), current);
  assert.equal(current?.status, 'pending');
  operations.handoffCreation('connector', 'old-operation', 'created');
  assert.equal(operations.get('connector:new'), current);
  newerResponse.resolve(json({ connector: { ...createdConnector, id: 'new-created' }, event: connectorReceipt('new-client', 'new-created'), replayed: false }, 201));
  await newer;
  assert.equal(operations.get('connector:new')?.operationId, 'new-operation');
  assert.equal(operations.get('connector:new')?.status, 'confirmed');
  assert.equal(writes, 2);
});

for (const success of [true, false]) test(`connector-test.B9 慢连接超过15秒仍等待真实健康检查结果${success}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers<Response>();
  let writes = 0; let reads = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'POST') { writes++; return held.promise; }
    reads++; return json(createdConnector);
  });
  const operations = new EditorOperations(gateway, () => true, () => {});
  t.after(() => { held.resolve(unavailable()); operations.close(); });
  const finished = operations.run('connector:created', {
    operationId: 'test-slow', resource: 'connector', id: 'created', action: 'test',
  }, () => gateway.testConnector('created')).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  t.mock.timers.tick(25_000); await settle();
  assert.equal(operations.get('connector:created')?.status, 'pending');
  const response = { success, tool_count: success ? 1 : 0, error: success ? null : '连接失败', pending_restart: false };
  held.resolve(json(response));
  const result = await finished;
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, response);
  assert.equal(operations.get('connector:created')?.status, 'confirmed');
  assert.equal(writes, 1); assert.equal(reads, 0);
});

test('connector-create.S1 创建期限后POST仍进行只保持unknown，结束拒绝后GET收敛不重放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers<Response>();
  let result: 'pending' | 'not_created' = 'pending';
  let writes = 0; let queries = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'POST') { writes++; return held.promise; }
    queries++; return json({ status: result });
  });
  const operations = new EditorOperations(gateway, () => true, () => {});
  t.after(() => { held.resolve(unavailable()); operations.close(); });
  const finished = operations.run('connector:new', {
    operationId: 'expired-create', resource: 'connector', action: 'save', clientId: 'expired-create',
  }, () => gateway.createConnector('expired-create', { url: createdConnector.url! })).catch(() => null);
  t.mock.timers.tick(90_000); await finished; await settle();
  assert.ok(queries > 0);
  assert.equal(operations.get('connector:new')?.status, 'unknown');
  assert.equal(operations.get('connector:new')?.reconciled, false);
  held.resolve(json({ error: { code: 'connection_failed', message: '连接失败' } }, 502)); await settle();
  result = 'not_created'; operations.recover(); await settle();
  assert.equal(operations.get('connector:new')?.status, 'failed');
  assert.equal(operations.get('connector:new')?.reconciled, true);
  assert.equal(operations.get('connector:new')?.value, null);
  assert.equal(writes, 1);
});

test('connector-create.S1 查询接口404不是未创建证明，保留unknown继续只读核对', async t => {
  let queries = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'POST') return unavailable();
    queries++; return missing();
  });
  const operations = new EditorOperations(gateway, () => true, () => {});
  t.after(() => operations.close());
  await assert.rejects(operations.run('connector:new', {
    operationId: 'missing-query', resource: 'connector', action: 'save', clientId: 'missing-query',
  }, () => gateway.createConnector('missing-query', { url: createdConnector.url! })));
  await settle(); operations.recover(); await settle();
  assert.ok(queries >= 2);
  assert.equal(operations.get('connector:new')?.status, 'unknown');
  assert.equal(operations.get('connector:new')?.reconciled, false);
});

test('connector-create.S1 查询中的pending晚于精确created事件返回，继续读取真实资源', async t => {
  const held = Promise.withResolvers<Response>();
  let queries = 0; let reads = 0;
  const gateway = api(async (input, init) => {
    if (init?.method === 'POST') return unavailable();
    if (new URL(String(input)).pathname === '/connectors/creation-result') { queries++; return held.promise; }
    reads++; return json(createdConnector);
  });
  const operations = new EditorOperations(gateway, () => true, () => {});
  t.after(() => { held.resolve(json({ status: 'pending' })); operations.close(); });
  await assert.rejects(operations.run('connector:new', {
    operationId: 'sse-wins', resource: 'connector', action: 'save', clientId: 'sse-wins',
  }, () => gateway.createConnector('sse-wins', { url: createdConnector.url! })));
  await settle(); assert.equal(queries, 1);
  operations.observe(connectorReceipt('sse-wins'));
  held.resolve(json({ status: 'pending' })); await settle();
  assert.equal(reads, 1);
  assert.equal(operations.get('connector:new')?.status, 'confirmed');
  assert.equal(operations.get('connector:created'), operations.get('connector:new'));
});

test('connector-create.S1 关闭session中止脱离访问的GET，迟到结果不发布或重新安排核对', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = Promise.withResolvers<Response>();
  let querySignal: AbortSignal | undefined; let queries = 0; let notifications = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'POST') return unavailable();
    querySignal = init?.signal ?? undefined; queries++; return held.promise;
  });
  const operations = new EditorOperations(gateway, () => true, () => { notifications++; });
  t.after(() => { held.resolve(json({ status: 'not_created' })); operations.close(); });
  await assert.rejects(operations.run('connector:new', {
    operationId: 'closed-create', resource: 'connector', action: 'save', clientId: 'closed-create',
  }, () => gateway.createConnector('closed-create', { url: createdConnector.url! })));
  await settle(); operations.beginCreationVisit('connector');
  operations.close();
  assert.equal(querySignal?.aborted, true);
  const before = notifications;
  held.resolve(json({ status: 'created', connector: createdConnector, event: connectorReceipt('closed-create') }));
  await settle(); t.mock.timers.tick(120_000); await settle();
  assert.equal(notifications, before);
  assert.equal(queries, 1);
  assert.equal(operations.get('connector:new'), undefined);
  assert.equal(operations.get('connector:created'), undefined);
});
for (const intent of [
  { action: 'delete' as const, fields: undefined, actual: { state: 'released', pages: [] }, expected: 'confirmed' },
  { action: 'save' as const, fields: { state: 'human' }, actual: { state: 'human', pages: [] }, expected: 'confirmed' },
  { action: 'save' as const, fields: { state: 'agent' }, actual: { state: 'human', pages: [] }, expected: 'synced' },
  { action: 'save' as const, fields: { closedPage: 'page' }, actual: { state: 'human', pages: [{ id: 'other' }] }, expected: 'confirmed' },
]) test(`browser.A7 C2 ${JSON.stringify(intent.fields ?? intent.action)} unknown recovery reads current lease and never replays a command`, async t => {
  let writes = 0;
  const gateway = api(async (_input, init) => {
    if (init?.method === 'GET') return json({ id: 'lease', ...intent.actual });
    writes++; return unavailable();
  });
  const operations = new EditorOperations(gateway, () => true, () => {}); t.after(() => operations.close());
  await assert.rejects(operations.run('browser:lease', { operationId: 'browser-op', resource: 'browser', id: 'lease', action: intent.action, fields: intent.fields },
    () => intent.action === 'delete' ? gateway.closeBrowser('lease') : intent.fields?.closedPage ? gateway.closeBrowserPage('lease', intent.fields.closedPage) : intent.fields?.state === 'agent' ? gateway.handbackBrowser('lease', 'browser-op') : gateway.takeoverBrowser('lease', 'browser-op')));
  await settle();
  assert.equal(operations.get('browser:lease')?.status, intent.expected);
  assert.equal(operations.get('browser:lease')?.reconciled, true);
  assert.equal(operations.get('browser:lease')?.operationId, 'browser-op');
  assert.equal(writes, 1);
});
