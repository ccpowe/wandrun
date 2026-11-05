import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { AppState, Text } from 'react-native';
import BrowserTakeover from '../src/app/browser-takeover';
import BrowserViewer from '../src/app/browser-viewer';
import { browserStoryTask } from '../src/dev/browser-scene';
import { FakeGateway } from '../src/dev/fake-gateway';
import { seedGatewayAgent, tickGateway as tick } from './gateway-harness';
import { Credentials } from '../src/lib/credentials';
import { SessionProvider, useSession } from '../src/lib/session-context';
import { SceneProviders } from '../src/dev/scene-providers';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock({}));

// Only HTTP/SSE and the native WebSocket boundary are peers. Router, session,
// BrowserStream, runtime state machine and notice display leases remain real.
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { Socket.all.push(this); }
  send() {}
  close() { this.drop(1000); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  open() {
    this.readyState = 1; this.onopen?.();
    this.emit({ t: 'hello', protocol: 3, connection_id: `connection-${Socket.all.indexOf(this)}`, ping_supported: false,
      transport: 'jpeg', video_support: { available: false, reason: 'environment-unsupported' }, window_mode: 'adaptive', max_in_flight: 2, max_in_flight_limit: 32 });
    const task = peer.state.browserTasks[0];
    this.emit({ t: 'pages', current: task.current, pages: task.pages, state: task.state, epoch: 1, vp: 1,
      css: [800, 600], dpr: 1, environment_id: task.environment_id, environment_name: task.environment_name,
      capacity: task.capacity, capacity_rejection: null });
  }
}
const nativeSocket = globalThis.WebSocket;
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers(); jest.spyOn(Math, 'random').mockReturnValue(0.5);
  AppState.currentState = 'active';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  globalThis.WebSocket = Socket as unknown as typeof WebSocket; Socket.all = [];
  peer = new FakeGateway({ browserTasks: [browserStoryTask('human')] }); seedGatewayAgent(peer);
});
afterEach(() => { peer.disconnect(); globalThis.WebSocket = nativeSocket; jest.restoreAllMocks(); jest.useRealTimers(); });
function OtherRoute() { return <Text>其他页面</Text>; }
async function mount(control = true) {
  const route = control ? '/browser-takeover' : '/browser-viewer';
  const routes = { '/settings': OtherRoute };
  const credentials = new Credentials({
    getItemAsync: async () => JSON.stringify({ computers: [{ computerId: 'reconnect-test', connectionId: 'reconnect-test',
      baseUrl: 'https://gateway-l2.invalid', token: 'test', pairingMethod: 'development' }], currentId: 'reconnect-test' }),
    setItemAsync: async () => {}, deleteItemAsync: async () => {},
  });
  function Connected() {
    if (!useSession()) return null;
    const Screen = control ? BrowserTakeover : BrowserViewer;
    return <SceneProviders path={route} location={`${route}?id=lease`} routes={routes}><Screen /></SceneProviders>;
  }
  const view = await render(<SessionProvider runtime={{ credentials, fetch: peer.fetch }}><Connected /></SessionProvider>);
  await tick();
  await act(() => Socket.all.at(-1)!.open());
  return view;
}
const reconnecting = '无法连接画面，正在重试…';

test.each([true, false])('browser.R1/R2/R3 control=%s 短断不闪提醒，持续满3秒才显示，当前握手恢复立即撤销', async control => {
  await mount(control);
  await act(() => Socket.all.at(-1)!.drop());
  await tick(250); await act(() => Socket.all.at(-1)!.open());
  await tick(3000);
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  await act(() => Socket.all.at(-1)!.drop());
  await tick(2999);
  expect(screen.queryByText(reconnecting)).toBeNull();
  await tick(1);
  expect(screen.getByText(reconnecting)).toBeOnTheScreen();
  expect(screen.queryByTestId('browser-error-dismiss')).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  await act(() => Socket.all.at(-1)!.open());
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
});
test('browser.R4/R5/RT8 30秒耗尽才显示手动重连；明确重连建立新轮次，旧连接消息不能结束新页面', async () => {
  await mount(); const first = Socket.all[0];
  await act(() => first.drop());
  await tick(29_999);
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  await tick(1);
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.getByTestId('browser-reconnect')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('browser-reconnect'));
  await act(() => { Socket.all.at(-1)!.open(); first.emit({ t: 'ended', reason: 'task_cancelled' }); });
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  expect(screen.queryByText('任务已结束，浏览器已关闭')).toBeNull();
  expect(screen.getByTestId('takeover-handback')).toBeEnabled();
});
test.each(['released', 'stopping'])('browser.R6 session %s 优先取消重连等待，无手动复活入口', async state => {
  await mount(); const first = Socket.all[0];
  await act(() => first.drop());
  await act(() => peer.emit(peer.event('browser_task.updated', { ...peer.state.browserTasks[0], state })));
  await tick(31_000);
  expect(Socket.all).toHaveLength(1);
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
});
test.each([
  { state: 'agent', boundary: '断线前' },
  { state: 'requested', boundary: '退避中' },
  { state: 'revoking', boundary: '握手中' },
  { state: 'agent', boundary: '手动恢复前' },
] as const)('browser.R6/B3 $boundary session 收回为 $state 仍可恢复只看画面，不停在空白区', async ({ state, boundary }) => {
  await mount(); const first = Socket.all[0];
  const revoke = async () => {
    peer.state.browserTasks[0].state = state;
    await act(() => peer.emit(peer.event('browser_task.updated', peer.state.browserTasks[0])));
  };
  if (boundary === '断线前') await revoke();
  await act(() => first.drop());
  if (boundary === '退避中') await revoke();
  if (boundary === '手动恢复前') {
    await tick(30_000); await revoke();
    expect(screen.getByTestId('browser-reconnect')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('browser-reconnect'));
  } else await tick(250);
  if (boundary === '握手中') await revoke();
  const retry = Socket.all.at(-1)!;
  expect(retry).not.toBe(first);
  await act(() => retry.open());
  expect(screen.getByText('正在连接画面…')).toBeOnTheScreen();
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
});
test('browser.R6 4401 立即撤销会话，即使 native error 先于 close 也不继续重连', async () => {
  await mount(); const first = Socket.all[0];
  await act(() => { first.onerror?.(); first.drop(4401); });
  await tick(31_000);
  expect(Socket.all).toHaveLength(1);
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  expect(screen.queryByTestId('takeover-handback')).toBeNull();
});
test('browser.R6 ended 与4404是租约终态，不能自动或手动复活', async () => {
  const firstView = await mount();
  await act(() => Socket.all.at(-1)!.emit({ t: 'ended', reason: 'task_cancelled' }));
  await tick(31_000);
  expect(Socket.all).toHaveLength(1);
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  await firstView.unmount();
  await mount(); const attempts = Socket.all.length;
  await act(() => Socket.all.at(-1)!.drop(4404));
  await tick(31_000);
  expect(Socket.all).toHaveLength(attempts);
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
});
test('browser.R7 失焦撤销在途重连；返回新订阅不接受旧握手和 ended', async () => {
  await mount(); const first = Socket.all[0];
  await act(() => first.drop()); await tick(250); const retry = Socket.all.at(-1)!;
  await act(() => router.push('/settings')); await tick(31_000);
  expect(retry.readyState).toBe(3); expect(Socket.all).toHaveLength(2);
  await act(() => router.back()); await tick(0);
  await act(() => { Socket.all.at(-1)!.open(); retry.open(); retry.emit({ t: 'ended', reason: 'task_cancelled' }); });
  expect(screen.queryByText(reconnecting)).toBeNull();
  expect(screen.queryByText('任务已结束，浏览器已关闭')).toBeNull();
  expect(screen.getByTestId('takeover-handback')).toBeEnabled();
});

test('browser.R2 网关离线横幅优先，不叠加画面连接提醒', async () => {
  await mount();
  peer.overrides['GET /events'] = () => { throw new TypeError('offline'); };
  await act(() => { Socket.all.at(-1)!.drop(); peer.disconnect(); });
  await tick(3000);
  expect(screen.getByText('连接断开，正在重连…')).toBeOnTheScreen();
  expect(screen.queryByText(reconnecting)).toBeNull();
});

test('browser.R5 无效协议立即提供手动重连，不以重复连接掩盖协议错误', async () => {
  await mount();
  await act(() => Socket.all[0].emit({ t: 'hello', protocol: 99 }));
  expect(screen.getByTestId('browser-reconnect')).toBeOnTheScreen();
  expect(screen.queryByText(reconnecting)).toBeNull();
  await tick(31_000);
  expect(Socket.all).toHaveLength(1);
});
