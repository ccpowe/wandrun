import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { Credentials } from '../src/lib/credentials.ts';
import { PairingCoordinator } from '../src/lib/pairing.ts';

function durable(beforeWrite?: () => Promise<void> | void) {
  let value: string | null = null;
  return { getItemAsync: async () => value,
    setItemAsync: async (_key: string, next: string) => { await beforeWrite?.(); value = next; },
    deleteItemAsync: async () => { value = null; } };
}
const exchange = (id: string) => new Response(JSON.stringify({ token: `token-${id}`, device_id: id,
  computer_name: 'pairing-host', gateway_version: '1.0', paired_at: '2026-10-30T00:00:00Z' }));

test('配对 owner 同步占槽，兑换与安全写入中跨入口防重，成功码不能因访问重建再兑换', async t => {
  const response = Promise.withResolvers<Response>();
  const writing = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const storage = durable(async () => { entered.resolve(); await writing.promise; });
  const credentials = new Credentials(storage);
  await credentials.restore();
  const owner = new PairingCoordinator();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return response.promise; });
  const save = (config: Parameters<Credentials['install']>[0]) => credentials.install(config);
  const first = owner.connect('https://pairing.invalid/path/', 'ab12-cd34', 'manual', save);
  await owner.connect('https://pairing.invalid/path', 'AB12CD34', 'qr', save);
  assert.equal(owner.snapshot().phase, 'exchanging');
  assert.equal(requests, 1);
  response.resolve(exchange('first'));
  await entered.promise;
  assert.equal(owner.snapshot().phase, 'saving');
  await owner.connect('https://pairing.invalid/path', 'ZX98CV76', 'manual', save);
  assert.equal(requests, 1);
  assert.equal(credentials.snapshot().config, null);
  writing.resolve();
  await first;
  const restored = new Credentials(storage);
  await restored.restore();
  assert.equal(restored.snapshot().config?.token, 'token-first');
  const committed = restored.snapshot().config;
  await owner.connect('https://pairing.invalid/path/', 'ab12 cd34', 'qr', save);
  assert.equal(requests, 1);
  assert.deepEqual(credentials.snapshot().config, committed);
});

test('配对期限释放应用槽，旧请求迟到不能覆盖下一次成功安装', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = Promise.withResolvers<Response>();
  const storage = durable();
  const credentials = new Credentials(storage);
  await credentials.restore();
  const owner = new PairingCoordinator();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1 ? late.promise : exchange('fresh'));
  const save = (config: Parameters<Credentials['install']>[0]) => credentials.install(config);
  const first = owner.connect('https://pairing.invalid', 'AB12CD34', 'qr', save);
  t.mock.timers.tick(15_000);
  await first;
  assert.equal(owner.snapshot().phase, 'idle');
  assert.equal(credentials.snapshot().config, null);
  await owner.connect('https://pairing.invalid', 'ZX98CV76', 'manual', save);
  const committed = credentials.snapshot().config;
  assert.equal(committed?.deviceId, 'fresh');
  late.resolve(exchange('late'));
  await setImmediate();
  assert.deepEqual(credentials.snapshot().config, committed);
  assert.equal(requests, 2);
});

test('安全保存失败仍消耗一码，解除存储故障不能重兑旧码，新的码可安装', async t => {
  let unavailable = true;
  const storage = durable(() => { if (unavailable) throw new Error('private keychain failure'); });
  const credentials = new Credentials(storage);
  await credentials.restore();
  const owner = new PairingCoordinator();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => exchange(`device-${++requests}`));
  const save = (config: Parameters<Credentials['install']>[0]) => credentials.install(config);
  await owner.connect('https://pairing.invalid', 'AB12CD34', 'manual', save);
  assert.equal(owner.snapshot().phase, 'idle');
  assert.equal(credentials.snapshot().config, null);
  unavailable = false;
  await owner.connect('https://pairing.invalid/', 'ab12 cd34', 'qr', save);
  assert.equal(requests, 1);
  assert.equal(credentials.snapshot().config, null);
  await owner.connect('https://pairing.invalid', 'ZX98CV76', 'manual', save);
  assert.equal(requests, 2);
  const restored = new Credentials(storage);
  await restored.restore();
  assert.equal(restored.snapshot().config?.deviceId, 'device-2');
});
