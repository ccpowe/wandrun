import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeGateway, assertNoUnhandledGatewayRequests, gatewayRoutes, unsupportedGatewayRoutes } from '../src/dev/fake-gateway.ts';

import { appRoutes, normalizeGatewayRoute as normalize } from './gateway-route-extractor.ts';
import { assertUniqueGatewayRoutes, combineGatewayRoutes } from '../src/dev/fake-gateway/route-registry.ts';

test('每个 App 网关请求都有共享实现或有理由的显式不支持声明', () => {
  const actual = appRoutes();
  const supported = new Set(gatewayRoutes.map(normalize));
  const exceptions = new Map(Object.entries(unsupportedGatewayRoutes).map(([key, reason]) => [normalize(key), reason]));
  const missing = [...actual].filter(key => !supported.has(key) && !exceptions.has(key));
  assert.deepEqual(missing, [], `缺少假网关接口：\n${missing.join('\n')}`);
  for (const [key, reason] of exceptions) {
    assert.ok(reason.trim().length > 0, `${key} 必须说明不支持原因`);
    assert.ok(actual.has(key), `${key} 是过期的不支持声明`);
    assert.ok(!supported.has(key), `${key} 已实现，应删除不支持声明`);
  }
});

test('完整路径与方法精确匹配，未声明的路径不被静默接受', async () => {
  const peer = new FakeGateway();
  const error = console.error;
  const messages: string[] = [];
  console.error = (message: string) => { messages.push(message); };
  try {
    for (const [method, path] of [['PUT', '/agents/planner'], ['GET', '/agents/planner/extra'], ['POST', '/unknown'], ['GET', '/browser-tasks/example/stream'], ['GET', '/agents//memory'], ['GET', '/memory/profile/details/'], ['HEAD', '/uploads/']]) {
      await assert.rejects(peer.fetch(`https://story.invalid${path}`, { method }), new RegExp(`${method} ${path}`));
    }
    assert.throws(assertNoUnhandledGatewayRequests, /PUT \/agents\/planner/);
    assert.ok(messages.some(message => message.includes('GET /browser-tasks/example/stream') && message.includes('不建立真实浏览器画面')));
  } finally { console.error = error; }
});


test('请求提取保留局部选项、展开与 shorthand 中的方法，并拒绝未知方法', () => {
  const sources = [
    `function remove() { const method = 'DELETE'; const options = { headers: {} }; const init = { ...options, method }; fetch('/agents/a', init); }`,
    `function update() { const method = 'PATCH'; this.api.consumeResponse('/agents/a', { method, headers: {} }, consume); }`,
    `function probe() { const init = { method: 'HEAD' } satisfies RequestInit; fetch('/uploads/u', init); }`,
    `function override() { const headers = { headers: {} }; const nested = { ...headers }; fetch('/settings', { method: 'PUT', ...nested }); }`,
    `function updateSettings() { const headers = { headers: {} }; const nested = { ...headers }; fetch('/settings', { ...nested, method: 'PATCH' }); }`,
  ];
  assert.deepEqual([...appRoutes(sources)].sort(), ['DELETE /agents/a', 'HEAD /uploads/u', 'PATCH /agents/a', 'PATCH /settings', 'PUT /settings']);
  assert.throws(() => appRoutes([`function unknown(init: RequestInit) { fetch('/agents', init); }`]), /无法静态识别请求选项/);
  assert.throws(() => appRoutes([`function unknown(method: string) { fetch('/agents', { method }); }`]), /无法静态识别请求方法/);
});

test('被形参遮蔽、重赋值或属性修改的请求绑定不能静默提取成旧方法', () => {
  for (const source of [
    `const init = { method: 'GET' }; function remove(init: RequestInit) { fetch('/agents/a', init); } remove({ method: 'DELETE' });`,
    `function remove() { let method = 'GET'; method = 'DELETE'; fetch('/agents/a', { method }); }`,
    `function remove() { const init = { method: 'GET' }; init.method = 'DELETE'; fetch('/agents/a', init); }`,
  ]) assert.throws(() => appRoutes([source]), /无法静态识别/);
});

test('请求绑定只允许单一使用，透明包装别名、对象持有及其他引用统一拒绝', () => {
  for (const source of [
    `function remove() { const init = { method: 'GET' }; const alias = init as RequestInit; alias.method = 'DELETE'; fetch('/agents/a', init); }`,
    `function remove() { const init = { method: 'GET' }; const holder = { init }; holder.init.method = 'DELETE'; fetch('/agents/a', init); }`,
    `function remove() { const init = { method: 'DELETE' }; console.log(init); fetch('/agents/a', init); }`,
    `function remove() { const init = { method: 'DELETE' }; fetch('/agents/a', init); fetch('/agents/b', init); }`,
  ]) assert.throws(() => appRoutes([source]), /只接受单一使用/);
});

test('URL 路径变量可同时作为缓存键，单一使用只约束 init 与方法选项', () => {
  const source = "function preview(id: string) { const key = encodeURIComponent(id); const cached = cache.get(key); if (cached) return cached; const result = this.request('GET', `/files/${key}/preview`); cache.set(key, result); return result; }";
  assert.deepEqual([...appRoutes([source])], ['GET /files/:param/preview']);
});

test('资源注册拒绝精确重复、参数重名及实现与不支持清单之间的路径重复', () => {
  const handler = () => new Response();
  assert.throws(() => combineGatewayRoutes({ 'GET /agents': handler }, { 'GET /agents': handler }), /重复的假网关路由/);
  assert.throws(() => combineGatewayRoutes({ 'GET /agents/:id': handler }, { 'GET /agents/:agent': handler }), /重复的假网关路由/);
  assert.throws(() => combineGatewayRoutes({ 'POST /agents/:id/schedules': '理由一' }, { 'POST /agents/:agent/schedules': '理由二' }), /重复的假网关路由/);
  assert.throws(() => assertUniqueGatewayRoutes({ 'GET /agents/:id': handler }, { 'GET /agents/:agent': '理由' }), /重复的假网关路由/);
  const routes = combineGatewayRoutes({ 'GET /agents/:id': handler }, { 'DELETE /agents/:agent': () => new Response(null, { status: 204 }) });
  assert.equal(routes['GET /agents/:id']().status, 200);
  assert.equal(routes['DELETE /agents/:agent']().status, 204);
});

test('SSE 推送与断开共用资源事件，已经中止的订阅不会接收后续事件', async () => {
  const peer = new FakeGateway();
  const abort = new AbortController();
  const response = await peer.fetch('https://story.invalid/events', { signal: abort.signal });
  const reader = response.body!.getReader();
  await reader.read(); // Initial heartbeat.
  const pending = reader.read();
  const event = peer.event('resource.changed', { kind: 'skill', id: 'notes' });
  peer.emit(event);
  assert.equal(new TextDecoder().decode((await pending).value), `event: resource.changed\ndata: ${JSON.stringify(event)}\n\n`);
  const ended = reader.read();
  abort.abort();
  assert.equal((await ended).done, true);
  peer.emit(peer.event('resource.changed', { kind: 'skill', id: 'later' }));
  assert.equal((await reader.read()).done, true);
  peer.disconnect();
});
