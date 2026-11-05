import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StrictMode, useState } from 'react';
import { Uniwind } from 'uniwind';
import { Credentials } from '../src/lib/credentials';
import { useTranslation } from '../src/lib/i18n';
import { applyLanguage } from '../src/lib/locale-store';
import { Pressable, Text, TextInput } from 'react-native';
import type { SavedComputer } from '../src/lib/credentials';
import { SessionProvider, useGateway } from '../src/lib/session-context';

let mockSaved: string | null = null;
let mockFailStorage = false;
let mockHoldWrite: (() => Promise<void>) | null = null;
const mockSessions: { owner: SavedComputer; refuse: (reason: 'invalid' | 'revoked') => void; closed: boolean }[] = [];
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => mockSaved,
  setItemAsync: async (_key: string, value: string) => {
    if (mockHoldWrite) await mockHoldWrite();
    if (mockFailStorage) throw new Error('keychain unavailable');
    mockSaved = value;
  },
  deleteItemAsync: async () => {
    if (mockHoldWrite) await mockHoldWrite();
    if (mockFailStorage) throw new Error('keychain unavailable');
    mockSaved = null;
  },
}));
jest.mock('../src/lib/upload-drafts', () => ({
  suspendComputerUploads: async () => {}, reconcileConversationDrafts() {}, acknowledgeFirstSendDraft() {}, discardConversationDraft() {},
}));
// Keep real session identity/API/close contracts; only suppress background SSE startup in this storage-focused suite.
jest.mock('../src/gateway/session', () => {
  const { ChatSession } = jest.requireActual('../src/gateway/session');
  return { ChatSession: class extends ChatSession {
    state: (typeof mockSessions)[number];
    constructor(owner: SavedComputer, fetch: unknown, options: unknown, refuse: (reason: 'invalid' | 'revoked') => void) {
      super(owner, fetch, options, refuse);
      this.state = { owner, refuse, closed: false };
      mockSessions.push(this.state);
    }
    async start() {}
    async close() { this.state.closed = true; await super.close(); }
  } };
});

const a: SavedComputer = { computerId: 'a', connectionId: 'a1', baseUrl: 'http://a', token: 'a-secret', pairingMethod: 'manual' };
const b: SavedComputer = { computerId: 'b', connectionId: 'b1', baseUrl: 'http://b', token: 'b-secret', pairingMethod: 'manual' };
let result: 'pending' | 'done' | 'storage-error';
// The remote-revoke outcome goes only to the caller (settings.T6); this stand-in caller shows it.
function Controls() {
  const gateway = useGateway();
  const [remoteFailed, setRemoteFailed] = useState(false);
  return <>
    <Text testID="selection">{gateway.config?.computerId ?? 'none'}</Text>
    <Text testID="revoked">{String(gateway.revoked)}</Text>
    {remoteFailed ? <Text testID="disconnect-notice">remote failed</Text> : null}
    <Pressable testID="disconnect" onPress={() => {
      result = 'pending';
      void gateway.disconnect(undefined, () => setRemoteFailed(true)).then(() => { result = 'done'; }, () => { result = 'storage-error'; });
    }} />
  </>;
}
const flush = async () => act(async () => { await jest.advanceTimersByTimeAsync(0); });
beforeEach(() => {
  jest.useFakeTimers();
  mockSaved = JSON.stringify({ computers: [a, b], currentId: 'b' });
  mockFailStorage = false;
  mockHoldWrite = null;
  mockSessions.length = 0;
  result = 'pending';
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

async function open() {
  const view = await render(<SessionProvider><Controls /></SessionProvider>);
  await flush();
  expect(screen.getByTestId('selection')).toHaveTextContent('b');
  return view;
}

test('网关挂起不阻塞本地删除、旧连接关闭与剩余电脑落点，超时后仅显示中性说明', async () => {
  let signal: AbortSignal | undefined;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    expect(JSON.parse(mockSaved!).computers).toEqual([a]);
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer b-secret' });
    signal = init?.signal ?? undefined;
    return Promise.withResolvers<Response>().promise;
  });
  await open();
  await fireEvent.press(screen.getByTestId('disconnect'));
  await flush();
  expect(result).toBe('done');
  expect(screen.getByTestId('selection')).toHaveTextContent('a');
  expect(mockSessions.find(row => row.owner.computerId === 'b')?.closed).toBe(true);
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
  await act(async () => { await jest.advanceTimersByTimeAsync(15_000); });
  expect(signal?.aborted).toBe(true);
  expect(screen.getByTestId('disconnect-notice')).toBeOnTheScreen();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockSaved!).computers).toEqual([a]);
});

test.each([204, 401])('网关 %s 不改变已删除结果，也不显示同步失败说明', async (status) => {
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    expect(JSON.parse(mockSaved!).computers).toEqual([a]);
    return new Response(null, { status });
  });
  await open();
  await fireEvent.press(screen.getByTestId('disconnect'));
  await flush();
  expect(result).toBe('done');
  expect(screen.getByTestId('selection')).toHaveTextContent('a');
  expect(screen.getByTestId('revoked')).toHaveTextContent('false');
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
});

test('最后一台电脑网关不可达仍删除凭据，无电脑落点也保留同步说明', async () => {
  mockSaved = JSON.stringify({ computers: [b], currentId: 'b' });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
  await open();
  await fireEvent.press(screen.getByTestId('disconnect'));
  await flush();
  expect(result).toBe('done');
  expect(mockSaved).toBeNull();
  expect(screen.getByTestId('selection')).toHaveTextContent('none');
  expect(screen.getByTestId('disconnect-notice')).toBeOnTheScreen();
});

test('安全存储失败保留原记录并报告失败，不发送撤销；重试可完成', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await open();
  mockFailStorage = true;
  await fireEvent.press(screen.getByTestId('disconnect'));
  await flush();
  expect(result).toBe('storage-error');
  expect(JSON.parse(mockSaved!).computers).toEqual([a, b]);
  expect(screen.getByTestId('selection')).toHaveTextContent('b');
  expect(globalThis.fetch).not.toHaveBeenCalled();
  mockFailStorage = false;
  await fireEvent.press(screen.getByTestId('disconnect'));
  await flush();
  expect(result).toBe('done');
  expect(screen.getByTestId('selection')).toHaveTextContent('a');
});

test('本地删除写入期间及完成后的 SSE 拒绝不误报撤销，也不影响剩余电脑', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await open();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  mockHoldWrite = () => held;
  await fireEvent.press(screen.getByTestId('disconnect'));
  await flush();
  const old = mockSessions.find(row => row.owner.computerId === 'b')!;
  await act(() => old.refuse('revoked'));
  expect(screen.getByTestId('revoked')).toHaveTextContent('false');
  release();
  await flush();
  await act(() => old.refuse('revoked'));
  await flush();
  expect(result).toBe('done');
  expect(screen.getByTestId('selection')).toHaveTextContent('a');
  expect(screen.getByTestId('revoked')).toHaveTextContent('false');
  expect(JSON.parse(mockSaved!).computers).toEqual([a]);
});

test('G1 StrictMode 重放与主题语言切换保留同一 session 和本地草稿；真正卸载关闭当前 owner', async () => {
  const credentials = new Credentials({
    getItemAsync: async () => JSON.stringify({ computers: [a, b], currentId: 'b' }),
    setItemAsync: async () => {}, deleteItemAsync: async () => {},
  });
  const fetch = async () => new Response(null, { status: 204 });
  function Draft() {
    const gateway = useGateway();
    const [draft, change] = useState('');
    const { language } = useTranslation();
    return <><Text testID="host-session">{gateway.sessionKey}</Text><Text testID="host-language">{language}</Text>
      <TextInput testID="host-draft" value={draft} onChangeText={change} /></>;
  }
  function Host() { return <StrictMode><SessionProvider runtime={{ credentials, fetch }}><Draft /></SessionProvider></StrictMode>; }
  const previousTheme = Uniwind.currentTheme;
  try {
    const host = await render(<Host />); await flush();
    const key = screen.getByTestId('host-session').props.children;
    expect(key).not.toBe(0);
    await fireEvent.changeText(screen.getByTestId('host-draft'), '未提交文字');
    await act(() => { Uniwind.setTheme('dark'); applyLanguage('en'); });
    await host.rerender(<Host />); await flush();
    expect(screen.getByTestId('host-session').props.children).toBe(key);
    expect(screen.getByTestId('host-draft').props.value).toBe('未提交文字');
    expect(screen.getByTestId('host-language')).toHaveTextContent('en');
    expect(mockSessions.filter(session => !session.closed)).toHaveLength(1);
    await host.unmount(); await flush();
    expect(mockSessions.every(session => session.closed)).toBe(true);
  } finally {
    await act(() => { Uniwind.setTheme(previousTheme); applyLanguage('zh'); });
  }
});
