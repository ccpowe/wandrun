import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { ExpoRoot, router, usePathname, type Href } from 'expo-router';
import { getRoutes } from 'expo-router/build/getRoutes';
import type { RouteNode } from 'expo-router/build/Route';
import requireContext from 'expo-router/build/testing-library/require-context-ponyfill';
import type { RequireContext } from 'expo-router/build/types';
import type { ReactNode } from 'react';
import { Button, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useMountEffect } from '../src/lib/use-mount-effect';
import { ChatSession } from '../src/gateway/session';
import { FakeGateway } from '../src/dev/fake-gateway';
import { seedGatewayAgent } from './gateway-harness';
import { useNewConversation, useNewConversationStore } from '../src/lib/new-conversation-context';
import type { NewChatHost } from '../src/lib/new-conversation';

jest.mock('../global.css', () => ({}));
jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
// Supply the external pairing/storage facts, not the navigation policy under test.
jest.mock('../src/lib/session-context.tsx', () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
  useGateway: () => ({ config: mockPaired ? {} : null, ready: true, sessionKey: mockPaired ? mockSessionKey : 0 }),
  useSession: () => mockLiveSession,
}));
jest.mock('../src/lib/appearance-context.tsx', () => ({
  AppearanceProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../src/lib/new-conversation-storage.ts', () => ({
  nativeNewConversation: () => jest.requireActual('../src/lib/new-conversation').memoryNewConversation(),
}));

let mockPaired = false;
let mockSessionKey = 1;
let mockLiveSession: ChatSession | null = null;
let mockDraftHost: NewChatHost | null = null;

function DraftProbe() {
  const store = useNewConversationStore();
  const state = useNewConversation();
  return <>
    <Text testID="draft-status">{state.status}</Text>
    <Text testID="draft-text">{state.status === 'loading' ? '' : state.saved.text}</Text>
    <Button title="发送首条" onPress={() => {
      if (!mockDraftHost) return;
      store.select('epoch-server', 'research');
      store.setText('换库后新的首条消息');
      void store.submit(mockDraftHost, { create: 'epoch-creation', message: 'epoch-message' });
    }} />
  </>;
}

const visits: { sessionKey: number; path: string }[] = [];
function Visit({ sessionKey, path }: { sessionKey: number; path: string }) {
  useMountEffect(() => { visits.push({ sessionKey, path }); return () => {}; });
  return null;
}
function Page() {
  const path = usePathname();
  const sessionKey = mockPaired ? mockSessionKey : 0;
  return <><Text testID="admitted-path">{path}</Text><Visit key={`${sessionKey}:${path}`} sessionKey={sessionKey} path={path} />
    {mockDraftHost && <DraftProbe />}</>;
}
function context(extraPage?: string): RequireContext {
  const source = requireContext(resolve(__dirname, '../src/app'), true, /\.[jt]sx?$/);
  const keys = [...source.keys(), ...(extraPage ? [extraPage] : [])];
  return Object.assign((key: string) => key === './_layout.tsx' || key === './+native-intent.tsx'
    ? source(key) : { default: Page }, {
    keys: () => keys, resolve: (key: string) => key, id: 'unpaired-production-root',
  }) as RequireContext;
}
function paths(node: RouteNode, prefix = ''): string[] {
  const path = [prefix, node.route].filter(Boolean).join('/');
  if (node.type === 'route' && !node.generated && !node.internal) {
    return [`/${path.replace(/(^|\/)index$/, '').replace(/\[\.\.\.[^\]]+\]/g, 'review/path').replace(/\[[^\]]+\]/g, 'review-id')}`];
  }
  return node.children.flatMap((child) => paths(child, path));
}
const tick = () => act(async () => { await jest.advanceTimersByTimeAsync(100); });
const publicPaths = new Set(['/connect', '/gateway-connection', '/settings-appearance']);
async function reachablePrivatePages(routes: RequireContext): Promise<string[]> {
  const tree = getRoutes(routes, { platform: 'android', skipGenerated: true });
  if (!tree) throw new Error('Production routes were not discovered');
  await render(<SafeAreaProvider><ExpoRoot context={routes} location="/connect" /></SafeAreaProvider>);
  await tick();
  expect(screen.getByTestId('admitted-path').props.children).toBe('/connect');
  const admitted: string[] = [];
  for (const path of paths(tree)) {
    await act(() => router.replace(path as Href)); await tick();
    const visible = screen.getByTestId('admitted-path').props.children as string;
    if (publicPaths.has(path)) expect(visible).toBe(path);
    else if (visible !== '/connect') admitted.push(visible);
    await act(() => router.replace('/connect')); await tick();
  }
  return admitted;
}

beforeEach(() => {
  mockPaired = false;
  mockSessionKey = 1;
  mockLiveSession = null;
  mockDraftHost = null;
  visits.length = 0;
  jest.useFakeTimers();
  // jest-expo installs this native global as a property; RN types declare it lexically.
  jest.replaceProperty(globalThis as typeof globalThis & { __DEV__: boolean }, '__DEV__', false);
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('未配对时，SDK 发现的全部正式页面均受真实 RootLayout 保护；原生意图不是页面', async () => {
  const routes = context();
  const tree = getRoutes(routes, { platform: 'android', skipGenerated: true });
  expect(tree).not.toBeNull();
  expect(paths(tree!)).not.toContain('/+native-intent');
  expect(await reachablePrivatePages(routes)).toEqual([]);
}, 20_000);

test('新增未登记普通页面会被实际访问检测捕获，不会误报为已受保护', async () => {
  expect(await reachablePrivatePages(context('./review-unregistered.tsx'))).toEqual(['/review-unregistered']);
}, 20_000);

test('已配对后真实根 Stack 可挂载并进入全部正式入口，未把拒绝全部访问误当保护成功', async () => {
  mockPaired = true;
  const routes = context();
  const tree = getRoutes(routes, { platform: 'android', skipGenerated: true });
  if (!tree) throw new Error('Production routes were not discovered');
  await render(<SafeAreaProvider><ExpoRoot context={routes} location="/" /></SafeAreaProvider>);
  await tick();
  for (const path of paths(tree)) {
    await act(() => router.replace('/')); await tick();
    await act(() => router.replace(path as Href)); await tick();
    expect(screen.getByTestId('admitted-path').props.children).toBe(path.startsWith('/dev/') ? '/' : path);
  }
}, 20_000);

test('G1 真实根宿主：旧服务器深链及受保护历史移除后才准入新服务器；同 id 不恢复旧 URL', async () => {
  mockPaired = true;
  const routes = context();
  const host = await render(<SafeAreaProvider><ExpoRoot context={routes} location={'/chat?id=shared-id&server=old'} /></SafeAreaProvider>);
  await tick();
  await act(() => router.replace('/chat?id=shared-id&server=old' as Href)); await tick();
  await act(() => router.push('/settings')); await tick();
  expect(router.canGoBack()).toBe(true);
  mockSessionKey = 2;
  await host.rerender(<SafeAreaProvider><ExpoRoot context={routes} location={'/chat?id=shared-id&server=old'} /></SafeAreaProvider>);
  await tick();
  expect(visits.filter(visit => visit.sessionKey === 2)).toEqual([
    { sessionKey: 2, path: '/connect' }, { sessionKey: 2, path: '/' },
  ]);
  expect(screen.getByTestId('admitted-path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false);
  await act(() => router.replace('/chat?id=shared-id&server=new' as Href)); await tick();
  expect(screen.getByTestId('admitted-path').props.children).toBe('/chat');
  mockPaired = false;
  await host.rerender(<SafeAreaProvider><ExpoRoot context={routes} location={'/chat?id=shared-id&server=old'} /></SafeAreaProvider>);
  await tick();
  expect(screen.getByTestId('admitted-path').props.children).toBe('/connect');
  expect(router.canGoBack()).toBe(false);
});

test('G1 真实根宿主 sessionKey 1→0→2：关闭期间只提交公共入口，新身份先清历史再放行', async () => {
  mockPaired = true;
  const routes = context();
  const host = await render(<SafeAreaProvider><ExpoRoot context={routes} location="/" /></SafeAreaProvider>);
  await tick(); await act(() => router.push('/chat?id=shared-id' as Href)); await tick();
  mockSessionKey = 0;
  await host.rerender(<SafeAreaProvider><ExpoRoot context={routes} location="/" /></SafeAreaProvider>); await tick();
  expect(screen.getByTestId('admitted-path').props.children).toBe('/connect');
  expect(router.canGoBack()).toBe(false);
  expect(visits.filter(visit => visit.sessionKey === 0)).toEqual([{ sessionKey: 0, path: '/connect' }]);
  mockSessionKey = 2;
  await host.rerender(<SafeAreaProvider><ExpoRoot context={routes} location="/" /></SafeAreaProvider>); await tick();
  expect(visits.filter(visit => visit.sessionKey === 2)).toEqual([
    { sessionKey: 2, path: '/connect' }, { sessionKey: 2, path: '/' },
  ]);
  expect(screen.getByTestId('admitted-path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false);
});

test('ADR-0079 G1 同一根宿主换库后，后续通知不再作废新的首次动作', async () => {
  const peer = new FakeGateway();
  seedGatewayAgent(peer);
  const session = new ChatSession({ baseUrl: 'https://epoch.invalid', token: 'test', computerId: 'epoch-server' }, peer.fetch);
  mockPaired = true;
  mockLiveSession = session;
  mockDraftHost = {
    computerId: 'epoch-server', online: () => session.connection === 'open',
    current: () => !session.api.signal.aborted, storeVersion: () => session.storeVersion,
    create: (agent, key) => session.createConversation(agent, undefined, key),
    bind: (id, attempt) => ({ preserveDraft: false, send: () => session.send(id, attempt.text, [], attempt.messageClientId) }),
  };
  try {
    await session.start(); await tick();
    await render(<SafeAreaProvider><ExpoRoot context={context()} location="/" /></SafeAreaProvider>);
    await tick();
    await act(() => peer.emit(peer.event('resync_required', {}))); await tick();
    expect(session.storeVersion).toBe(1);
    expect(session.connection).toBe('open');
    await fireEvent.press(screen.getByText('发送首条')); await tick();
    expect(peer.state.conversations).toHaveLength(1);
    const id = peer.state.conversations[0].id;
    expect(peer.state.histories.get(id)?.filter(event => event.type === 'message.user').map(event => event.client_id)).toEqual(['epoch-message']);
    expect(screen.getByTestId('draft-status').props.children).toBe('editing');
    expect(screen.getByTestId('draft-text').props.children).toBe('');
  } finally {
    await act(() => session.close());
    peer.disconnect();
  }
});
