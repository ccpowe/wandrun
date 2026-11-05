/** @jest-environment @shopify/react-native-skia/jestEnv.js */
import { ImageFormat, Skia } from '@shopify/react-native-skia';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { AppState, StyleSheet, Text } from 'react-native';
import { PointerType, State, type GestureTouchEvent, type GestureType } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import * as Reanimated from 'react-native-reanimated';
import { BrowserStream } from '../src/browser/stream';
import BrowserTakeover from '../src/app/browser-takeover';
import { FakeGateway } from '../src/dev/fake-gateway';
import { FakeBrowserStream, installFakeBrowserStreams } from '../src/dev/fake-gateway/browser-stream';
import { browserStoryTask } from '../src/dev/browser-scene';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock(Reflect.get(globalThis, 'CanvasKit')));
let release: (() => void) | undefined;
let peer: FakeGateway;
let sockets: FakeBrowserStream[];
beforeEach(() => {
  jest.useFakeTimers(); AppState.currentState = 'active'; sockets = [];
  peer = new FakeGateway({ browserTasks: [browserStoryTask('human')] }); seedGatewayAgent(peer);
});
afterEach(() => { release?.(); release = undefined; peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
function OtherRoute() { return <Text>其他页面</Text>; }
async function mount(jpeg?: Uint8Array) {
  release = installFakeBrowserStreams('https://gateway-l2.invalid', peer.state.browserTasks[0], { jpeg }, socket => sockets.push(socket));
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', { '/settings': OtherRoute }, '/browser-takeover?id=lease');
}

test('browser.B4 more keeps landscape/help/debug and removes picture/input selectors', async () => {
  await mount(); await fireEvent.press(screen.getByRole('button', { name: '更多' }));
  expect(screen.getByLabelText('横屏')).toBeVisible();
  expect(screen.getByText('鼠标模式怎么操作')).toBeVisible();
  expect(screen.getByLabelText('显示调试信息')).toBeVisible();
  expect(screen.queryByRole('radio', { name: '画面：截图' })).toBeNull();
  expect(screen.queryByRole('radio', { name: '画面：视频' })).toBeNull();
  expect(screen.queryByRole('radio', { name: '输入：整组' })).toBeNull();
  expect(screen.queryByRole('radio', { name: '输入：流式' })).toBeNull();
});
test('browser.D10 持续满三秒才显示未确认横幅，期间不锁交还，离开立即撤销', async () => {
  const surface = Skia.Surface.MakeOffscreen(2, 2)!;
  const image = surface.makeImageSnapshot();
  const jpeg = image.encodeToBytes(ImageFormat.JPEG, 80);
  image.dispose(); surface.dispose();
  let confirmFrame: (() => void) | undefined;
  // Official Reanimated mock cannot execute the UI mapper; confirm at its native boundary.
  jest.spyOn(Reanimated, 'useAnimatedReaction').mockImplementation((prepare, react) => {
    confirmFrame = () => react(prepare(), null);
  });
  const displayed = jest.spyOn(BrowserStream.prototype, 'displayedFrame');
  await mount(jpeg);
  const viewport = screen.container.queryAll(node => node.props.collapsable === false && typeof node.props.onLayout === 'function')[0];
  await fireEvent(viewport, 'layout', { nativeEvent: { layout: { width: 720, height: 900 } } });
  await tick();
  await act(() => confirmFrame?.());
  await tick();
  const client = displayed.mock.contexts.at(-1)!;
  const socket = sockets.at(-1)!;
  socket.holdInputs = true;
  let id: number | null = null;
  await act(() => { id = client.input({ t: 'pointer', x: 400, y: 300, buttons: 1, ts: performance.now() }); });
  expect(id).not.toBeNull();
  await act(() => socket.done(id!, 'unknown'));
  expect(screen.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
  expect(screen.getByRole('button', { name: '交还浏览器' })).toBeEnabled();
  await tick(2999);
  expect(screen.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
  await tick(1);
  expect(screen.getByText('部分操作结果未确认，请检查页面')).toBeVisible();
  expect(screen.queryByRole('button', { name: '关闭提示' })).toBeNull();
  expect(screen.getByRole('button', { name: '交还浏览器' })).toBeEnabled();
  await act(() => router.push('/settings')); await tick();
  expect(screen.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
  await act(() => router.back()); await tick(3000);
  expect(screen.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
});
test('browser.D10 unmatched input replies never create a stale banner across page visits', async () => {
  await mount();
  const socket = sockets.at(-1)!;
  await act(() => socket.emit({ t: 'input_done', id: 999, outcome: 'unknown', input_lock_wait_ms: 0, input_dispatch_ms: 0, input_cdp_ms: 0 }));
  expect(screen.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
  expect(screen.getByRole('button', { name: '交还浏览器' })).toBeEnabled();
  await act(() => router.push('/settings')); await tick();
  await act(() => router.back()); await tick();
  expect(screen.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
});

// RNGH's official fireGestureHandler models state/update callbacks, not Manual's
// raw onTouches* boundary. Invoke that public native boundary; keep Stage,
// recognizers, runtime, coordinate projection and the actual socket client real.
function region(label: 'takeover-trackpad' | '左键' | '滚动条'): GestureType {
  const id = label === 'takeover-trackpad' ? 'browser-surface' : label === '左键' ? 'browser-left' : 'browser-wheel';
  return getByGestureTestId(id);
}
async function contact(target: GestureType, type: 'down' | 'move' | 'up' | 'cancel', x: number, y: number, id = 1) {
  const touch = { id, x, y, absoluteX: x, absoluteY: y };
  const native: GestureTouchEvent = { handlerTag: target.handlerTag, state: State.ACTIVE,
    eventType: type === 'down' ? 1 : type === 'move' ? 2 : type === 'up' ? 3 : 4,
    numberOfTouches: type === 'up' || type === 'cancel' ? 0 : 1, allTouches: [touch], changedTouches: [touch],
    pointerType: PointerType.TOUCH };
  const manager = { handlerTag: target.handlerTag, begin() {}, activate() {}, end() {}, fail() {} };
  await act(() => {
    if (type === 'down') target.handlers.onTouchesDown!(native, manager);
    if (type === 'move') target.handlers.onTouchesMove!(native, manager);
    if (type === 'up') target.handlers.onTouchesUp!(native, manager);
    if (type === 'cancel') {
      target.handlers.onTouchesCancelled!(native, manager);
      fireGestureHandler(target, [{ state: State.BEGAN }, { state: State.ACTIVE }, { state: State.CANCELLED }]);
    }
  });
  await tick(20);
}
async function readyTrackpad() {
  const surface = Skia.Surface.MakeOffscreen(2, 2)!;
  const image = surface.makeImageSnapshot();
  const jpeg = image.encodeToBytes(ImageFormat.JPEG, 80);
  image.dispose(); surface.dispose();
  let confirm: (() => void) | undefined;
  jest.spyOn(Reanimated, 'useAnimatedReaction').mockImplementation((prepare, react) => { confirm = () => react(prepare(), null); });
  await mount(jpeg);
  await fireEvent(screen.getByTestId('browser-stage'), 'layout', { nativeEvent: { layout: { width: 720, height: 1200 } } });
  await fireEvent(screen.getByTestId('browser-picture'), 'layout', { nativeEvent: { layout: { width: 720, height: 540 } } });
  await tick(20);
  await act(() => confirm!());
  await tick(20);
  const socket = sockets.at(-1)!;
  socket.holdInputs = true;
  socket.inputs.length = 0;
  return { socket, pad: region('takeover-trackpad') };
}
test.each([100, 600, 950])('browser.B9 在触摸板 y=%s（上黑区/画面/下黑区）滑动使用相同相对坐标', async y => {
  const { socket, pad } = await readyTrackpad();
  await contact(pad, 'down', 300, y);
  await contact(pad, 'move', 330, y + 15);
  await contact(pad, 'up', 330, y + 15);
  const pointer = socket.inputs.filter(input => input.t === 'pointer');
  expect(pointer).toEqual([expect.objectContaining({ buttons: 0, x: expect.closeTo(400 + 30 / 0.9), y: expect.closeTo(300 + 15 / 0.9) })]);
});
test.each([100, 950])('browser.B9 黑区 y=%s 轻点不发单击，随后画面轻点仍可单击', async y => {
  const { socket, pad } = await readyTrackpad();
  await contact(pad, 'down', 300, y);
  await contact(pad, 'up', 300, y);
  expect(socket.inputs).toEqual([]);
  await contact(pad, 'down', 300, 600);
  await contact(pad, 'up', 300, 600);
  expect(socket.inputs.map(input => input.buttons)).toEqual([1, 0]);
});
test('browser.B9 画面跨黑区连续滑动不换 owner，也不追加单击', async () => {
  const { socket, pad } = await readyTrackpad();
  await contact(pad, 'down', 300, 340);
  await contact(pad, 'move', 300, 300);
  await contact(pad, 'move', 330, 290);
  await contact(pad, 'up', 330, 290);
  expect(socket.inputs.at(-1)).toMatchObject({ buttons: 0, x: expect.closeTo(400 + 30 / 0.9), y: expect.closeTo(300 - 50 / 0.9) });
  expect(socket.inputs.every(input => input.buttons === 0)).toBe(true);
});
test.each(['up', 'cancel'] as const)('browser.B9 左键按住+黑区移动为拖动；%s 结清后下一次可重新移动', async ending => {
  const { socket, pad } = await readyTrackpad();
  const left = region('左键');
  await contact(left, 'down', 30, 30, 0);
  await contact(pad, 'down', 300, 100);
  await contact(pad, 'move', 303, 102);
  await contact(pad, ending, 303, 102);
  await contact(left, 'up', 30, 30, 0);
  expect(socket.inputs).toEqual([
    expect.objectContaining({ buttons: 1, x: 400, y: 300 }),
    expect.objectContaining({ buttons: 1, x: expect.closeTo(400 + 3 / 0.9), y: expect.closeTo(300 + 2 / 0.9) }),
    expect.objectContaining({ buttons: 0 }),
  ]);
  socket.inputs.length = 0;
  await contact(pad, 'down', 300, 950);
  await contact(pad, 'move', 330, 950);
  await contact(pad, 'up', 330, 950);
  expect(socket.inputs).toEqual([expect.objectContaining({ buttons: 0, x: expect.closeTo(400 + 33 / 0.9) })]);
});
test.each([1060, 1180])('browser.B9 按钮带空白 y=%s 也是触摸板：滑动移动光标，轻点不单击', async y => {
  const { socket, pad } = await readyTrackpad();
  const band = screen.getByTestId('takeover-button-area');
  expect(band.props.pointerEvents).toBe('box-none');
  expect(StyleSheet.flatten(screen.getByTestId('takeover-trackpad').props.style).bottom).toBe(0);
  await contact(pad, 'down', 100, y);
  await contact(pad, 'up', 100, y);
  expect(socket.inputs).toEqual([]);
  await contact(pad, 'down', 100, y);
  await contact(pad, 'move', 130, y - 15);
  await contact(pad, 'up', 130, y - 15);
  expect(socket.inputs).toEqual([expect.objectContaining({ buttons: 0, x: expect.closeTo(400 + 30 / 0.9), y: expect.closeTo(300 - 15 / 0.9) })]);
});
test('browser.B9 按钮带上的左键与滚轮仍各自生效，不产生光标位移', async () => {
  const { socket } = await readyTrackpad();
  for (const label of ['左键', '滚动条'] as const) {
    const target = region(label);
    await contact(target, 'down', 20, 30);
    await contact(target, 'move', 50, 60);
    await contact(target, 'up', 50, 60);
  }
  const pointers = socket.inputs.filter(input => input.t === 'pointer');
  expect(pointers.map(input => input.buttons)).toEqual([1, 0]);
  expect(pointers.every(input => input.x === 400 && input.y === 300)).toBe(true);
  expect(socket.inputs.some(input => input.t === 'wheel')).toBe(true);
});
test('browser.B9 按住左键 + 另一指在按钮带空白滑动为拖动', async () => {
  const { socket, pad } = await readyTrackpad();
  const left = region('左键');
  await contact(left, 'down', 30, 30, 0);
  await contact(pad, 'down', 100, 1100);
  await contact(pad, 'move', 103, 1102);
  await contact(pad, 'up', 103, 1102);
  await contact(left, 'up', 30, 30, 0);
  expect(socket.inputs).toEqual([
    expect.objectContaining({ buttons: 1, x: 400, y: 300 }),
    expect.objectContaining({ buttons: 1, x: expect.closeTo(400 + 3 / 0.9), y: expect.closeTo(300 + 2 / 0.9) }),
    expect.objectContaining({ buttons: 0 }),
  ]);
});
