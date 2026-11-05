import { act, fireEvent, screen } from '@testing-library/react-native';
import { AppState, NativeModules, Platform, UIManager } from 'react-native';
import type * as ReactNative from 'react-native';
import BrowserTakeover from '../src/app/browser-takeover';
import { browserStoryTask } from '../src/dev/browser-scene';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock({}));
// Replace only SDK/native boundaries. BrowserVideoPlayer, its external-store surface,
// BrowserRuntime, real stream decoding, routing and session ownership stay real.
jest.mock('@livekit/react-native', () => {
  const { View } = jest.requireActual<typeof ReactNative>('react-native');
  return { registerGlobals() {}, VideoTrack: (props: object) => <View testID="native-video-surface" {...props}/> };
});
jest.mock('livekit-client', () => ({
  RoomEvent: Object.fromEntries(['Connected', 'Reconnected', 'Reconnecting', 'SignalReconnecting', 'Disconnected',
    'TrackPublished', 'TrackSubscribed', 'TrackUnsubscribed', 'TrackSubscriptionFailed'].map(name => [name, name])),
  ConnectionState: { Connected: 'connected' },
  Room: class {
    state = 'connected';
    listeners = new Map<string, (() => void)[]>();
    remoteParticipants = new Map([['publisher', { trackPublications: new Map(['old-track', 'new-track'].map(trackName => [trackName, {
      kind: 'video', source: 'screen_share', trackName, setSubscribed() {},
      track: { mediaStream: { toURL: () => `native-${trackName}` } },
    }])) }]]);
    on(name: string, listener: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); return this; }
    connect() { for (const listener of this.listeners.get('Connected') ?? []) listener(); return Promise.resolve(); }
    removeAllListeners() { this.listeners.clear(); }
    disconnect() { return Promise.resolve(); }
  },
}));

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { Socket.all.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
  hello() {
    this.readyState = 1; this.onopen?.();
    this.emit({ t: 'hello', protocol: 3, connection_id: `video-${Socket.all.indexOf(this)}`, ping_supported: false,
      transport: 'video', video_support: { available: true, reason: null }, window_mode: 'adaptive', max_in_flight: 2, max_in_flight_limit: 32 });
  }
  pages() {
    const task = peer.state.browserTasks[0];
    this.emit({ t: 'pages', current: task.current, pages: task.pages, state: 'human', epoch: 1, vp: 1,
      css: [800, 600], dpr: 1, environment_id: task.environment_id, environment_name: task.environment_name,
      capacity: task.capacity, capacity_rejection: null });
  }
  video(track: string) {
    this.emit({ t: 'video', state: 'ready', page: peer.state.browserTasks[0].current, vp: 1, url: 'wss://video.invalid',
      room: 'lease', track, token: 'test-only', expires_in_s: 600, renew: false });
  }
}
const originalSocket = globalThis.WebSocket;
const originalModules = { WebRTCModule: NativeModules.WebRTCModule, LivekitReactNativeModule: NativeModules.LivekitReactNativeModule };
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers(); jest.spyOn(Math, 'random').mockReturnValue(0.5);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.replaceProperty(Platform, 'OS', 'android');
  Object.assign(NativeModules, { WebRTCModule: {}, LivekitReactNativeModule: {} });
  const videoViewConfig = { Commands: {}, NativeProps: { retainLastFrame: 'boolean' },
    directEventTypes: { onFrameRendered: { registrationName: 'onFrameRendered' } } };
  jest.spyOn(UIManager, 'getViewManagerConfig').mockReturnValue(videoViewConfig);
  AppState.currentState = 'active'; Socket.all = []; globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  peer = new FakeGateway({ browserTasks: [browserStoryTask('human')] }); seedGatewayAgent(peer);
});
afterEach(() => {
  peer.disconnect(); globalThis.WebSocket = originalSocket; Object.assign(NativeModules, originalModules);
  jest.restoreAllMocks(); jest.useRealTimers();
});
async function draw() {
  const surface = screen.getByTestId('native-video-surface');
  const source = surface.props.trackRef.publication.track.mediaStream.toURL();
  await fireEvent(surface, 'frameRendered', { nativeEvent: { source, context: surface.props.frameContext,
    width: 800, height: 600, at_ms: performance.now() } });
}
test('browser.R1/R3 旧视频表面跨 hello、pages、入房等帧保持同一挂载，真实新帧才恢复输入，放弃后卸载', async () => {
  await renderGateway(peer, BrowserTakeover, '/browser-takeover', {}, '/browser-takeover?id=lease');
  const first = Socket.all[0];
  await act(() => { first.hello(); first.pages(); first.video('old-track'); }); await draw();
  expect(screen.getByTestId('takeover-keyboard')).toBeEnabled();
  const retainedSurface = screen.getByTestId('native-video-surface');
  await act(() => first.close()); await tick(250);
  const replacement = Socket.all.at(-1)!;
  await act(() => replacement.hello());
  expect(screen.getByTestId('native-video-surface')).toBe(retainedSurface);
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  await act(() => { replacement.pages(); replacement.video('new-track'); });
  expect(screen.getByTestId('native-video-surface')).toBe(retainedSurface);
  expect(screen.getByTestId('takeover-keyboard')).toBeDisabled();
  await draw();
  expect(screen.getByTestId('takeover-keyboard')).toBeEnabled();
  expect(screen.getByTestId('native-video-surface')).toBe(retainedSurface);
  await act(() => replacement.close()); await tick(30_000);
  expect(screen.queryByTestId('native-video-surface')).toBeNull();
  expect(screen.getByTestId('browser-reconnect')).toBeOnTheScreen();
});
