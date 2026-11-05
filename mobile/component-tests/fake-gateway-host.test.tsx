import { File, Paths } from 'expo-file-system';
import { FakeGateway, assertNoUnhandledGatewayRequests } from '../src/dev/fake-gateway';
import { installFakeGatewayHost } from '../src/dev/fake-gateway-host';
import { ChatSession } from '../src/gateway/session';
import { createSceneRuntime } from '../src/dev/scene-session';

const detail = (id: string) => ({ id, name: `${id}.bin`, size: 3, media_type: 'application/octet-stream', conversation_id: null, agent_id: 'a', task_id: 'root', created_at: 1, remote_environment: null, available: true, error: null, error_message: null });
function peer(bytes: number[]) {
  return new FakeGateway({ files: new Map([['original', detail('original')]]), fileBytes: new Map([['original', new Uint8Array(bytes)]]) });
}

test('原生 DownloadTask 经共享 peer 按电脑隔离，写入响应的实际二进制而非 SDK 空成功', async () => {
  const first = peer([0, 128, 255]);
  const second = peer([3, 2, 1]);
  const requests: string[] = [];
  const restore = installFakeGatewayHost({ baseUrls: ['https://one.invalid', 'https://two.invalid'], fetch: (input, init) => {
    const url = new URL(String(input));
    requests.push(`${url.host}:${new Headers(init?.headers).get('Authorization')}`);
    return (url.host === 'one.invalid' ? first : second).fetch(input, init);
  } });
  const one = new File(Paths.cache, 'host-one.bin');
  const two = new File(Paths.cache, 'host-two.bin');
  try {
    const task = File.createDownloadTask('https://one.invalid/files/original/content', one, { headers: { Authorization: 'Bearer one' } });
    const saved = await task.downloadAsync();
    expect(task.state).toBe('completed');
    expect(await saved!.bytes()).toEqual(new Uint8Array([0, 128, 255]));
    await File.createDownloadTask('https://two.invalid/files/original/content', two, { headers: { Authorization: 'Bearer two' } }).downloadAsync();
    expect(await two.bytes()).toEqual(new Uint8Array([3, 2, 1]));
    expect(requests).toEqual(['one.invalid:Bearer one', 'two.invalid:Bearer two']);
  } finally { restore(); one.delete(); two.delete(); }
});

test('未知原生路径与未注册电脑不会绕过严格账本', async () => {
  const gateway = peer([0, 128, 255]);
  const restore = installFakeGatewayHost({ baseUrls: ['https://one.invalid'], fetch: gateway.fetch });
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const destination = new File(Paths.cache, 'host-unhandled.bin');
  try {
    await expect(File.createDownloadTask('https://one.invalid/missing-content', destination).downloadAsync()).rejects.toThrow('没有实现此接口');
    await expect(File.createDownloadTask('https://other.invalid/files/original/content', destination).downloadAsync()).rejects.toThrow('没有注册此电脑');
    gateway.state.files.set('original', { ...gateway.state.files.get('original')!, available: false });
    await expect(File.createDownloadTask('https://one.invalid/files/original/content', destination).downloadAsync()).rejects.toThrow('HTTP 410');
    expect(destination.exists).toBe(false);
    expect(() => assertNoUnhandledGatewayRequests()).toThrow(/missing-content[\s\S]*没有注册此电脑/);
  } finally { restore(); error.mockRestore(); }
});

test('取消与宿主关闭使等待中的原生下载结束，旧响应不能写入新场景', async () => {
  const gate = Promise.withResolvers<void>();
  const gateway = new FakeGateway({}, { 'GET /files/:id/content': async () => { await gate.promise; return new Response(new Uint8Array([9])); } });
  let restore = installFakeGatewayHost({ baseUrls: ['https://one.invalid'], fetch: gateway.fetch });
  const cancelled = new File(Paths.cache, 'host-cancelled.bin');
  const closed = new File(Paths.cache, 'host-closed.bin');
  const fresh = new File(Paths.cache, 'host-fresh.bin');
  try {
    const task = File.createDownloadTask('https://one.invalid/files/original/content', cancelled);
    const pending = task.downloadAsync();
    task.cancel();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(task.state).toBe('cancelled');
    const closing = File.createDownloadTask('https://one.invalid/files/original/content', closed).downloadAsync();
    restore();
    await expect(closing).rejects.toMatchObject({ name: 'AbortError' });
    restore = installFakeGatewayHost({ baseUrls: ['https://one.invalid'], fetch: peer([1, 2, 3]).fetch });
    await File.createDownloadTask('https://one.invalid/files/original/content', fresh).downloadAsync();
    gate.resolve();
    await Promise.resolve();
    expect(cancelled.exists).toBe(false);
    expect(closed.exists).toBe(false);
    expect(await fresh.bytes()).toEqual(new Uint8Array([1, 2, 3]));
  } finally { gate.resolve(); restore(); if (fresh.exists) fresh.delete(); }
});

test('场景从独立 session 交给 Provider session 时先结束旧 owner，场景清理不双关 Provider', async () => {
  const gateway = new FakeGateway();
  const config = {
    baseUrl: 'https://scene-owner.invalid', token: 'story', computerId: 'scene-owner',
    connectionId: 'scene-owner', pairingMethod: 'development' as const,
  };
  const owner = createSceneRuntime(config, gateway.fetch);
  const standalone = owner.session;
  const provided = new ChatSession(config, gateway.fetch);
  try {
    await owner.start();
    expect(owner.session).toBe(standalone);
    expect(standalone.api.signal.aborted).toBe(false);
    await owner.start(provided);
    expect(standalone.api.signal.aborted).toBe(true);
    expect(owner.session).toBe(provided);
    await owner.start(provided);
    owner.stop();
    expect(provided.api.signal.aborted).toBe(false);
  } finally {
    owner.stop();
    await provided.close();
    gateway.disconnect();
  }
});
