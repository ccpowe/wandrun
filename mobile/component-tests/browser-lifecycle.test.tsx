/** @jest-environment @shopify/react-native-skia/jestEnv.js */
import { ImageFormat, Skia } from '@shopify/react-native-skia';
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { AppState, Dimensions, StatusBar, StyleSheet, Text } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import BrowserTakeover from '../src/app/browser-takeover';
import BrowserViewer from '../src/app/browser-viewer';
import type { BrowserStream } from '../src/browser/stream';
import type { FramePacket, Pages } from '../src/browser/protocol';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { browserStoryTask } from '../src/dev/browser-scene';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

const mockClients: { closed: boolean; events: ConstructorParameters<typeof BrowserStream>[3]; displayedFrame: jest.Mock; newPage: jest.Mock }[] = [];
const mockKeyboardListeners = new Map<string, (event: { height: number }) => void>();
jest.mock('../src/browser/stream', () => ({ BrowserStream: class {
  closed = false;
  measurements = { connectionId: `lifecycle-${mockClients.length}`, canvasRendered: jest.fn() };
  events: ConstructorParameters<typeof BrowserStream>[3];
  constructor(_api: unknown, _id: string, _control: boolean, mockEvents: typeof mockClients[number]['events']) {
    this.events = mockEvents; mockClients.push(this); mockEvents.state('connecting');
    mockEvents.hello?.({ t: 'hello', protocol: 3, connection_id: 'lifecycle-test', transport: 'jpeg',
      video_support: { available: false, reason: 'environment-unsupported' }, ping_supported: false,
      window_mode: 'adaptive', max_in_flight: 2, max_in_flight_limit: 32 });
  }
  get isOpen() { return !this.closed; }
  close() { this.closed = true; }
  input() { return null; }
  switchPage() { return null; }
  sendClientStats = jest.fn();
  displayedFrame = jest.fn(() => !this.closed);
  discardFrame = jest.fn();
  newPage = jest.fn(() => 1);
} }));
jest.mock('react-native-keyboard-controller', () => ({
  ...jest.requireActual('react-native-keyboard-controller/jest'),
  KeyboardEvents: { addListener: (name: string, callback: (event: { height: number }) => void) => {
    mockKeyboardListeners.set(name, callback); return { remove: () => mockKeyboardListeners.delete(name) };
  } },
}));
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock(Reflect.get(globalThis, 'CanvasKit')));
let peer: FakeGateway;
let appListeners: Set<(state: typeof AppState.currentState) => void>;
let jpeg: Uint8Array;
let mockFrameReaction: (() => void) | undefined;
const initialWindow = Dimensions.get('window'), initialScreen = Dimensions.get('screen');
beforeAll(() => {
  // Upstream CanvasKit environment + official Skia mock: real CPU JPEG encode/decode,
  // not a replacement FrameCanvas/Screen. UI confirmation is supplied at its native callback boundary.
  const surface = Skia.Surface.MakeOffscreen(2, 2)!;
  const image = surface.makeImageSnapshot();
  jpeg = image.encodeToBytes(ImageFormat.JPEG, 80);
  image.dispose(); surface.dispose();
});
beforeEach(() => {
  jest.useFakeTimers(); mockClients.length = 0; mockKeyboardListeners.clear();
  peer = new FakeGateway({ browserTasks: [browserStoryTask('human')] }); seedGatewayAgent(peer);
  AppState.currentState = 'active'; appListeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    appListeners.add(callback); return { remove: () => { appListeners.delete(callback); } };
  });
  mockFrameReaction = undefined;
  // The official mock cannot execute a UI mapper. Capture that native boundary;
  // production FrameCanvas, commit publication, next-rAF ACK and Router stay real.
  jest.spyOn(Reanimated, 'useAnimatedReaction').mockImplementation((prepare, react) => {
    mockFrameReaction = () => react(prepare(), null);
  });
});
afterEach(() => {
  peer.disconnect(); Dimensions.set({ window: initialWindow, screen: initialScreen });
  jest.restoreAllMocks(); jest.useRealTimers();
});
function OtherRoute() { return <Text>其他页面</Text>; }
async function mount() {
  return renderGateway(peer, BrowserTakeover, '/browser-takeover', { '/settings': OtherRoute }, '/browser-takeover?id=lease');
}
async function appState(value: typeof AppState.currentState) {
  await act(() => { AppState.currentState = value; for (const listener of appListeners) listener(value); });
  await tick();
}
test('browser.A3 A4 失焦撤销旧流，返回建立新订阅；旧结束事件不能终止新访问，session 停止优先', async () => {
  const view = await mount(), first = mockClients.at(-1)!;
  expect(first.closed).toBe(false);
  await act(() => router.push('/settings')); await tick(); expect(first.closed).toBe(true);
  await act(() => router.back()); await tick(); const second = mockClients.at(-1)!;
  expect(second).not.toBe(first); expect(second.closed).toBe(false);
  await act(() => first.events.ended('task_cancelled')); await tick();
  expect(screen.queryByText('任务已结束，浏览器已关闭')).toBeNull();
  await act(() => peer.emit(peer.event('browser_task.updated', { ...peer.state.browserTasks[0], state: 'stopping' }))); await tick();
  expect(second.closed).toBe(true);
  expect(screen.getByText('页面已结束，可让 Agent 重新打开')).toBeOnTheScreen();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  await view.unmount(); expect(mockKeyboardListeners.size).toBe(0);
});
test('browser.B2 URL 输入期间后台丢失 hide 事件也结束编辑；迟到 show 不占空间，回前台重建流', async () => {
  const view = await mount();
  await fireEvent.press(screen.getByRole('button', { name: '编辑网址' }));
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://draft.example');
  await act(() => mockKeyboardListeners.get('keyboardWillShow')?.({ height: 296 }));
  const first = mockClients.at(-1)!;
  await appState('background'); expect(first.closed).toBe(true);
  await act(() => mockKeyboardListeners.get('keyboardWillShow')?.({ height: 296 }));
  expect(screen.queryByLabelText('网址')).toBeNull();
  await appState('active');
  expect(mockClients.at(-1)).not.toBe(first);
  expect(screen.getByRole('button', { name: '编辑网址' })).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '编辑网址' }));
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://example.com/release');
  await view.unmount(); expect(mockKeyboardListeners.size).toBe(0);
});
test('browser.T8 交还在途时仍可编辑 URL，明确失败后保留草稿且不把编辑当作命令完成', async () => {
  await mount();
  const handback = Promise.withResolvers<Response>();
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease/handback') ? handback.promise : peer.fetch(input, init));
  await fireEvent.press(screen.getByTestId('takeover-handback')); await tick();
  expect(screen.getByTestId('takeover-handback')).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: '编辑网址' }));
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://draft.example/while-pending');
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://draft.example/while-pending');
  expect(screen.getByTestId('takeover-handback')).toBeDisabled();
  await act(() => handback.resolve(jsonResponse({ error: { code: 'conflict', message: '当前不能交还' } }, 409))); await tick();
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://draft.example/while-pending');
  expect(screen.getByTestId('takeover-handback')).toBeEnabled();
});
test('browser.T17/R1 自动重连不影响在途交还命令或重发该命令', async () => {
  await mount();
  const handback = Promise.withResolvers<Response>();
  const writes = jest.fn(() => handback.promise);
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith('/browser-tasks/lease/handback') ? writes() : peer.fetch(input, init));
  await fireEvent.press(screen.getByTestId('takeover-handback')); await tick();
  const first = mockClients.at(-1)!;
  await act(() => first.events.state('closed')); await tick();
  await tick(500);
  expect(first.closed).toBe(true);
  expect(mockClients.at(-1)).not.toBe(first);
  expect(screen.getByTestId('takeover-handback')).toBeDisabled();
  expect(writes).toHaveBeenCalledTimes(1);
  await act(() => handback.resolve(jsonResponse({ error: { code: 'conflict', message: '当前不能交还' } }, 409))); await tick();
  expect(screen.getByTestId('takeover-handback')).toBeEnabled();
});

function pageSnapshot(state: Pages['state'] = 'human', change: Partial<Pages> = {}): Pages {
  const task = peer.state.browserTasks[0];
  return { t: 'pages', pages: task.pages, current: task.current, state, epoch: 1, vp: 1,
    environment_id: task.environment_id, environment_name: task.environment_name, capacity: task.capacity,
    capacity_rejection: null, css: [800, 600], dpr: 1, ...change };
}
function framePacket(seq = 1): FramePacket {
  return { jpeg, frame: { t: 'frame', seq, page: 'release', epoch: 1, vp: 1, css: [800, 600], dpr: 1,
    scroll: [0, 0], pageScale: 1, offsetTop: 0, max_in_flight: 2, in_flight: 1, in_flight_bytes: jpeg.byteLength,
    byte_budget: 1024 * 1024, stop_reason: 'none', frame_age_ms: null, credit_wait_ms: 0, send_lock_ms: null,
    ack_baseline_ms: null, ack_smoothed_ms: null, queue_delay_ms: null, delivery_rate_bps: null } };
}
async function showFrame(client = mockClients.at(-1)!, state: Pages['state'] = 'human', acknowledge = true) {
  const viewport = screen.container.queryAll(node => node.props.collapsable === false && typeof node.props.onLayout === 'function')[0];
  await fireEvent(viewport, 'layout', { nativeEvent: { layout: { width: 720, height: 900 } } });
  await act(() => { client.events.state('open'); client.events.pages(pageSnapshot(state)); client.events.frame(framePacket()); });
  const image = currentImage();
  if (acknowledge) await acknowledgeFrame();
  return image;
}
function currentImage() { return screen.container.queryAll(node => node.type === 'skImage')[0].props.image.value; }
async function acknowledgeFrame() {
  expect(mockFrameReaction).toBeDefined();
  await tick(20); // Official Worklets mock publishes shared values on its first UI rAF.
  await act(() => mockFrameReaction!());
  await tick(20);
}
test.each([false, true])('browser.A3 control=%s JPEG 握手完成但首帧未到时仍显示等帧提示', async control => {
  const path = control ? '/browser-takeover' : '/browser-viewer';
  await renderGateway(peer, control ? BrowserTakeover : BrowserViewer, path, {}, `${path}?id=lease`);
  await act(() => mockClients.at(-1)!.events.pages(pageSnapshot()));
  expect(screen.getByText('正在连接画面…')).toBeOnTheScreen();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
});
test.each([false, true])('browser.A3 control=%s 无旧帧的 JPEG 解码失败保留原因提示', async control => {
  const path = control ? '/browser-takeover' : '/browser-viewer';
  await renderGateway(peer, control ? BrowserTakeover : BrowserViewer, path, {}, `${path}?id=lease`);
  const client = mockClients.at(-1)!;
  await act(() => { client.events.pages(pageSnapshot()); client.events.frame({ ...framePacket(), jpeg: new Uint8Array([0]) }); });
  expect(screen.getByText('画面解码失败')).toBeOnTheScreen();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
});
// Assembly check only; the geometry cases are L1 (test/browser_protocol.test.ts `browser.B8 portrait picture`).
// Screen 1200 high; the stage row starts 100 below the top (top bar + address bar) and ends above the dock.
test.each([
  { css: [1600, 900] as [number, number], areaHeight: 900, top: 297.5, height: 405 }, // centered on the whole screen
])('browser.B8 CSS $css / 舞台高 $areaHeight：整屏居中；左右键以中线居中、滚轮底边对齐；键盘弹起时在剩余舞台内居中', async ({ css, areaHeight, top, height }) => {
  await mount();
  await showFrame();
  const packet = framePacket(2);
  await act(() => {
    mockClients.at(-1)!.events.pages(pageSnapshot('human', { css, vp: 2 }));
    mockClients.at(-1)!.events.frame({ ...packet, frame: { ...packet.frame, css, vp: 2 } });
  });
  await fireEvent(screen.getByTestId('browser-root'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 720, height: 1200 } } });
  await fireEvent(screen.getByTestId('browser-row'), 'layout', { nativeEvent: { layout: { x: 0, y: 100, width: 720, height: areaHeight } } });
  await fireEvent(screen.getByTestId('browser-stage'), 'layout', { nativeEvent: { layout: { width: 720, height: areaHeight } } });
  const picture = screen.getByTestId('browser-picture');
  const controls = screen.getByTestId('takeover-button-area');
  const imageBox = StyleSheet.flatten(picture.props.style);
  const band = StyleSheet.flatten(controls.props.style);
  const left = StyleSheet.flatten(within(controls).getByLabelText('左键').props.style);
  const right = StyleSheet.flatten(within(controls).getByLabelText('右键').props.style);
  const wheel = StyleSheet.flatten(within(controls).getByLabelText('滚动条').props.style);
  expect(imageBox.top).toBeCloseTo(top);
  expect(imageBox.height).toBeCloseTo(height);
  expect(imageBox.top + imageBox.height).toBeLessThanOrEqual(areaHeight - band.height + 1e-9);
  expect(within(picture).queryByLabelText('滚动条')).toBeNull();
  expect(left.width).toBe(52);
  expect(right.width).toBe(left.width);
  expect(right.left - left.left - left.width).toBe(16);
  expect((left.left + right.left + right.width) / 2).toBe(720 / 2);
  expect(wheel.right).toBe(24);
  expect(wheel.bottom).toBe(band.height - left.top - left.height);
  expect(wheel.height + wheel.bottom).toBeLessThanOrEqual(band.height);
  expect(left.top).toBeGreaterThanOrEqual(0);
  await fireEvent.press(screen.getByTestId('takeover-mode'));
  expect(screen.queryByLabelText('左键')).toBeNull();
  expect(picture).toHaveStyle({ top: imageBox.top, height: imageBox.height });
  await act(() => mockKeyboardListeners.get('keyboardWillShow')?.({ height: 296 }));
  // Keyboard open (browser.B8 原机制): centered in the remaining stage, not pushed to its bottom edge.
  await fireEvent(screen.getByTestId('browser-stage'), 'layout', { nativeEvent: { layout: { width: 720, height: 600 } } });
  expect(picture).toHaveStyle({ top: (600 - 405) / 2, height: 405 });
  await fireEvent(screen.getByTestId('browser-stage'), 'layout', { nativeEvent: { layout: { width: 720, height: 400 } } });
  expect(picture).toHaveStyle({ top: 0, height: 400 });
  expect(screen.queryByLabelText('滚动条')).toBeNull();
});

test('browser.B10 接管页聚焦且在前台时隐藏状态栏；后台、失焦、卸载恢复，观看页不隐藏', async () => {
  const hidden = jest.spyOn(StatusBar, 'setHidden');
  const last = () => hidden.mock.calls.at(-1)?.[0];
  const view = await mount();
  expect(last()).toBe(true);
  await appState('background'); expect(last()).toBe(false);
  await appState('active'); expect(last()).toBe(true);
  await act(() => router.push('/settings')); await tick(); expect(last()).toBe(false);
  await act(() => router.back()); await tick(); expect(last()).toBe(true);
  await view.unmount(); expect(last()).toBe(false);
  hidden.mockClear();
  await renderGateway(peer, BrowserViewer, '/browser-viewer', {}, '/browser-viewer?id=lease');
  expect(hidden).not.toHaveBeenCalledWith(true, expect.anything());
});

test('browser.B6 横屏 B：最左滚轮列、右侧控件列依次为交还 / 左右键 / 鼠标键盘更多；无状态文字；后退刷新页面在更多', async () => {
  await act(() => Dimensions.set({ window: { width: 1200, height: 720, scale: 2.5, fontScale: 1 } }));
  await mount();
  await showFrame();
  // The picture subtree (Skia canvas, video surface, gesture regions) keeps one instance through the columns appearing
  // and disappearing (keyboard, rotation; below): the viewport and the frame marker inside it stay the same host
  // instances, which a remount would replace.
  const picture = screen.getByTestId('browser-picture'), canvas = screen.getByTestId('takeover-frame');
  await fireEvent.press(screen.getByTestId('takeover-more'));
  await fireEvent.press(screen.getByRole('switch', { name: '横屏' }));
  expect(screen.getByTestId('browser-picture')).toBe(picture);
  expect(screen.getByTestId('takeover-frame')).toBe(canvas);
  const wheelColumn = screen.getByTestId('takeover-wheel-column');
  const controlColumn = screen.getByTestId('takeover-control-column');
  expect(within(wheelColumn).getByLabelText('滚动条')).toBeOnTheScreen();
  expect(within(screen.getByTestId('browser-stage')).queryByLabelText('滚动条')).toBeNull();
  expect(within(screen.getByTestId('browser-stage')).queryByLabelText('左键')).toBeNull();
  // Top-to-bottom order inside the column, all on its midline (items-center).
  const order = ['takeover-handback', '左键', '右键', 'takeover-mode', 'takeover-keyboard', 'takeover-more'];
  const inColumn = (node: { parent: unknown } | null): boolean => !!node && (node === controlColumn || inColumn(node.parent as { parent: unknown } | null));
  const nodes = screen.container.queryAll(node => (order.includes(node.props.testID) || order.includes(node.props.accessibilityLabel)) && inColumn(node));
  const seen = nodes.map(node => node.props.testID && order.includes(node.props.testID) ? node.props.testID : node.props.accessibilityLabel)
    .filter((value, index, all) => all.indexOf(value) === index);
  expect(seen).toEqual(order);
  expect(StyleSheet.flatten(controlColumn.props.style)).toMatchObject({ width: 84 });
  expect(StyleSheet.flatten(wheelColumn.props.style)).toMatchObject({ width: 76 });
  expect(screen.queryByText('操作中')).toBeNull();
  expect(screen.queryByTestId('takeover-url')).toBeNull();
  await fireEvent.press(screen.getByTestId('takeover-more'));
  expect(screen.getByTestId('takeover-landscape-back')).toBeEnabled();
  expect(screen.getByText('左侧滚动条')).toBeOnTheScreen();
  expect(screen.getByTestId('takeover-landscape-reload')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('takeover-landscape-pages'));
  expect(screen.getByTestId('takeover-new-page')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('关闭弹层'));
  await fireEvent.press(screen.getByTestId('takeover-mode'));
  expect(within(controlColumn).queryByLabelText('左键')).toBeNull();
  expect(within(wheelColumn).getByLabelText('滚动条')).toBeOnTheScreen();
  // Keyboard open hides both columns, close restores them, rotating back is portrait: same picture instance throughout.
  await act(() => mockKeyboardListeners.get('keyboardWillShow')?.({ height: 296 }));
  expect(screen.queryByTestId('takeover-control-column')).toBeNull();
  expect(screen.getByTestId('browser-picture')).toBe(picture);
  await act(() => mockKeyboardListeners.get('keyboardDidHide')?.({ height: 0 }));
  expect(screen.getByTestId('takeover-control-column')).toBeOnTheScreen();
  expect(screen.getByTestId('browser-picture')).toBe(picture);
  await act(() => Dimensions.set({ window: { width: 720, height: 1200, scale: 2.5, fontScale: 1 } }));
  expect(screen.getByTestId('takeover-button-area')).toBeOnTheScreen();
  expect(screen.getByTestId('browser-picture')).toBe(picture);
  expect(screen.getByTestId('takeover-frame')).toBe(canvas);
});

test.each([
  { height: 600, compact: false },
  { height: 304, compact: true }, // 360 window with a one-line banner (geometry: L1 `browser.B6/W7`)
])('browser.W7 横屏右列高 $height：底栏紧凑=$compact，三组在列中部聚拢且都在', async ({ height, compact }) => {
  await act(() => Dimensions.set({ window: { width: 1200, height: 720, scale: 2.5, fontScale: 1 } }));
  await mount();
  await showFrame();
  await fireEvent.press(screen.getByTestId('takeover-more'));
  await fireEvent.press(screen.getByRole('switch', { name: '横屏' }));
  await fireEvent(screen.getByTestId('takeover-control-column'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 84, height } } });
  const dock = screen.getByTestId('takeover-control-dock');
  for (const id of ['takeover-handback', 'takeover-mode', 'takeover-keyboard', 'takeover-more']) expect(screen.getByTestId(id)).toBeOnTheScreen();
  expect(within(screen.getByTestId('takeover-control-column')).getByLabelText('左键')).toBeOnTheScreen();
  expect(within(dock).queryByText('更多') === null).toBe(compact);
  expect(within(dock).getByLabelText('更多')).toBeOnTheScreen();
});

test('browser.B6 覆盖恢复：横屏仅由显式开关决定，几何变化不改选择，失焦重入重置且不因开关重连', async () => {
  await act(() => Dimensions.set({ window: { width: 1200, height: 720, scale: 2.5, fontScale: 1 } }));
  await mount();
  const orientation = () => screen.container.queryAll(node => node.type === 'RNSScreen' && !node.props['aria-hidden'])[0].props.screenOrientation;
  const client = mockClients.at(-1)!;
  expect(orientation()).toBe('portrait');
  await fireEvent.press(screen.getByTestId('takeover-more'));
  await fireEvent.press(screen.getByRole('switch', { name: '横屏' }));
  expect(orientation()).toBe('landscape');
  expect(mockClients.at(-1)).toBe(client); expect(client.closed).toBe(false);
  await act(() => Dimensions.set({ window: initialWindow }));
  await fireEvent.press(screen.getByTestId('takeover-more'));
  expect(screen.getByRole('switch', { name: '横屏' })).toBeChecked();
  await fireEvent.press(screen.getByLabelText('关闭弹层'));
  await act(() => router.push('/settings')); await tick();
  await act(() => router.back()); await tick();
  expect(orientation()).toBe('portrait');
  await fireEvent.press(screen.getByTestId('takeover-more'));
  expect(screen.getByRole('switch', { name: '横屏' })).not.toBeChecked();
});
test.each([false, true].flatMap(control => ['released', 'stopping'].flatMap(state => [false, true].map(disconnected => ({ control, state, disconnected })))))(
  'browser.A4 覆盖恢复：control=$control，$state，disconnected=$disconnected，无 ended 事件仍按快照清画面 / 禁重连并显示原因',
  async ({ control, state, disconnected }) => {
    const path = control ? '/browser-takeover' : '/browser-viewer';
    await renderGateway(peer, control ? BrowserTakeover : BrowserViewer, path, {}, `${path}?id=lease`);
    await showFrame();
    const client = mockClients.at(-1)!;
    if (disconnected) {
      await act(() => client.events.state('closed')); await tick();
      expect(screen.queryByTestId('browser-reconnect')).toBeNull();
    }
    const task = { ...peer.state.browserTasks[0], state, reason: state === 'stopping' ? '平台恢复' : null };
    await act(() => peer.emit(peer.event('browser_task.updated', task))); await tick();
    expect(client.closed).toBe(true);
    expect(screen.queryByTestId(control ? 'takeover-frame' : 'viewer-frame')).toBeNull();
    expect(screen.queryByTestId('browser-reconnect')).toBeNull();
    expect(screen.getByText(state === 'stopping' ? '运行环境已恢复，旧页面已结束，可让 Agent 重新打开' : '页面已结束，可让 Agent 重新打开')).toBeOnTheScreen();
    if (control) expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  });
test.each([false, true])('browser.A4 覆盖恢复：control=%s，revoking 优先于旧 human 帧，禁输入但不冒充已结束', async control => {
  const path = control ? '/browser-takeover' : '/browser-viewer';
  await renderGateway(peer, control ? BrowserTakeover : BrowserViewer, path, {}, `${path}?id=lease`);
  await showFrame();
  await act(() => peer.emit(peer.event('browser_task.updated', { ...peer.state.browserTasks[0], state: 'revoking' }))); await tick();
  expect(screen.getByText(/正在结束/)).toBeOnTheScreen();
  expect(screen.getByTestId(control ? 'takeover-frame' : 'viewer-frame')).toBeOnTheScreen();
  expect(mockClients.at(-1)!.closed).toBe(false);
  expect(screen.queryByText('页面已结束，可让 Agent 重新打开')).toBeNull();
  if (control) expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  else expect(screen.getByTestId('viewer-takeover')).toBeDisabled();
});
test('browser.B5 覆盖恢复：零页保留 human 租约，其他任务占满环境额度时禁新建，额度释放后可建', async () => {
  const task = peer.state.browserTasks[0];
  peer.state.browserTasks.push({ ...task, id: 'other', pages: Array.from({ length: 8 }, (_, index) => ({ id: `other-${index}`, title: '其他页面', url: 'https://other.example' })) });
  await mount();
  const client = mockClients.at(-1)!;
  const capacity = { ...task.capacity, pages_used: 8, pages_registered: 8 };
  await act(() => { client.events.state('open'); client.events.pages(pageSnapshot('human', { pages: [], current: null, capacity })); });
  expect(screen.getByTestId('takeover-empty-new-page')).toBeDisabled();
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  expect(screen.getByTestId('takeover-handback')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('takeover-empty-new-page'));
  expect(client.newPage).not.toHaveBeenCalled();
  await act(() => client.events.pages(pageSnapshot('human', { pages: [], current: null, capacity: { ...capacity, pages_used: 7, pages_registered: 7 } })));
  expect(screen.getByTestId('takeover-empty-new-page')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('takeover-empty-new-page'));
  expect(client.newPage).toHaveBeenCalledTimes(1);
});
test.each([false, true])('browser.B3 control=%s 未获 UI 确认的候选跨控制提示变化保留，确认入口仍绑定该候选，画面代际变化才移除', async control => {
  const path = control ? '/browser-takeover' : '/browser-viewer';
  await renderGateway(peer, control ? BrowserTakeover : BrowserViewer, path, {}, `${path}?id=lease`);
  const candidate = await showFrame(mockClients.at(-1)!, 'human', false), client = mockClients.at(-1)!;
  expect(client.displayedFrame).not.toHaveBeenCalled();
  await act(() => client.events.pages(pageSnapshot('agent')));
  expect(screen.getByTestId(control ? 'takeover-frame' : 'viewer-frame')).toBeOnTheScreen();
  await act(() => client.events.pages(pageSnapshot('requested')));
  expect(currentImage()).toBe(candidate);
  expect(client.closed).toBe(false); expect(client.displayedFrame).not.toHaveBeenCalled();
  await acknowledgeFrame();
  expect(client.displayedFrame).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, page: 'release' }));
  await act(() => client.events.pages(pageSnapshot('requested', { vp: 2 })));
  expect(screen.queryByTestId(control ? 'takeover-frame' : 'viewer-frame')).toBeNull();
});
test.each(['agent', 'requested'] as const)('browser.B3 接管入口 session 仍为 %s 时，当前 WS 的 human 画面正常显示', async state => {
  peer.state.browserTasks[0].state = state;
  await mount(); await showFrame();
  expect(screen.getByTestId('takeover-frame')).toBeOnTheScreen();
  expect(screen.getByTestId('takeover-keyboard')).toBeEnabled();
  expect(mockClients.at(-1)!.closed).toBe(false);
});
test('browser.R1/R3 B2 自动重连保留旧帧但必须等新帧 UI 确认才启用键盘，原生 hide 接线结束键盘会话', async () => {
  await mount(); await showFrame();
  expect(screen.getByTestId('takeover-keyboard')).toBeEnabled();
  await fireEvent(screen.getByTestId('takeover-input-text'), 'focus');
  await act(() => mockKeyboardListeners.get('keyboardWillShow')?.({ height: 296 }));
  expect(screen.getByTestId('takeover-keyboard-hide')).toBeOnTheScreen();
  await act(() => mockKeyboardListeners.get('keyboardDidHide')?.({ height: 0 }));
  expect(screen.queryByTestId('takeover-keyboard-hide')).toBeNull();
  const first = mockClients.at(-1)!, picture = currentImage();
  await act(() => first.events.state('closed'));
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  await tick(500);
  const next = mockClients.at(-1)!;
  await act(() => { next.events.state('open'); next.events.pages(pageSnapshot()); first.events.frame(framePacket(2)); });
  expect(currentImage()).toBe(picture);
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  await showFrame(next, 'human', false);
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  await acknowledgeFrame();
  expect(screen.getByTestId('takeover-keyboard')).toBeEnabled();
});
test.each(['agent', 'requested', 'revoking'] as const)('browser.R6/B3 重连 pages 收回为 %s 后显示真实新帧，只看且不恢复键盘', async state => {
  await mount(); await showFrame();
  const oldPicture = currentImage(), first = mockClients.at(-1)!;
  await act(() => first.events.state('closed'));
  await tick(500);
  const retry = mockClients.at(-1)!;
  expect(retry).not.toBe(first);
  await showFrame(retry, state);
  expect(screen.getByTestId('takeover-frame')).toBeOnTheScreen();
  expect(currentImage()).not.toBe(oldPicture);
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  expect(screen.queryByText('无法连接画面，正在重试…')).toBeNull();
  expect(screen.queryByTestId('browser-reconnect')).toBeNull();
  expect(retry.closed).toBe(false);
});
