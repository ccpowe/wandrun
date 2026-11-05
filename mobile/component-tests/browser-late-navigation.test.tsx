import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import BrowserViewer from '../src/app/browser-viewer';
import BrowserTakeover from '../src/app/browser-takeover';
import SettingsComputer from '../src/app/settings-computer';
import SettingsRoute from '../src/app/settings';
import ChatRoute from '../src/app/chat';
import type { BrowserTask } from '../src/gateway/api';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock({}));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers();
  peer = new FakeGateway();
  seedGatewayAgent(peer);
  seedGatewayConversation(peer);
  const task: BrowserTask = {
    id: 'lease', task_id: 'root', root_id: 'root', agent_id: 'research', entry_agent_id: 'research',
    entry_agent_name: '研究员', conversation_title: '网页核对', state: 'requested', epoch: 1,
    pages: [{ id: 'release', title: '发布页面', url: 'https://example.com/release' }], current: 'release',
    environment_id: 'local', environment_name: '本机',
    capacity: { pages_used: 1, pages_registered: 1, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 },
    capacity_rejection: null, reason: null, requested_reason: null,
  };
  peer.state.browserTasks.push(task);
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

type Command = 'takeover' | 'handback';
const commands: Command[] = ['takeover', 'handback'];
const button = (command: Command) => command === 'takeover' ? 'viewer-takeover' : 'takeover-handback';

async function start(command: Command) {
  peer.state.browserTasks[0].state = command === 'takeover' ? 'requested' : 'human';
  await renderGateway(peer, SettingsComputer, '/settings-computer', {
    '/browser-viewer': BrowserViewer, '/browser-takeover': BrowserTakeover,
    '/settings': SettingsRoute, '/chat': ChatRoute,
  });
  await act(() => router.push({ pathname: command === 'takeover' ? '/browser-viewer' : '/browser-takeover', params: { id: 'lease' } }));
  await tick();
  const gate = Promise.withResolvers<Response>();
  // FakeGateway does not implement control sessions. Only the HTTP command boundary
  // is supplied; route/focus/session ownership and reads remain production code.
  const request = jest.fn(() => gate.promise);
  jest.mocked(globalThis.fetch).mockImplementation((input, init) =>
    String(input).endsWith(`/browser-tasks/lease/${command}`) && init?.method === 'POST'
      ? request() : peer.fetch(input, init));
  await fireEvent.press(screen.getByTestId(button(command)));
  return {
    gate, request,
    async succeed() {
      const task: BrowserTask = { ...peer.state.browserTasks[0], state: command === 'takeover' ? 'human' : 'agent' };
      peer.state.browserTasks[0] = task;
      await act(() => {
        peer.emit(peer.event('browser_task.updated', { ...task }));
        gate.resolve(jsonResponse({ browser_task: task, replayed: false }));
      });
      await tick();
    },
  };
}

test.each(commands)('%s：离开页面后迟到成功不得抢走当前页面，资源仍完成', async (command) => {
  const pending = await start(command);
  if (command === 'takeover') await fireEvent.press(screen.getByTestId('viewer-close'));
  else await act(() => router.back());
  await tick();
  await pending.succeed();
  expect(screen.queryByTestId('takeover-handback')).toBeNull();
  expect(screen.queryByTestId('composer-input')).toBeNull();
  expect(screen.getByTestId('settings-computer-page-lease-release')).toBeOnTheScreen();
  // Reopening observes the completed resource, rather than cancelling the command.
  await fireEvent.press(screen.getByTestId('settings-computer-page-lease-release'));
  await tick();
  expect(screen.getByText(command === 'takeover' ? /你接管中/ : /Agent 操作中/)).toBeOnTheScreen();
});

test.each(commands)('%s：保留路由失焦再返回也不能恢复旧导航意图', async (command) => {
  const pending = await start(command);
  await act(() => router.push('/settings'));
  await tick();
  await act(() => router.back());
  await tick();
  await pending.succeed();
  expect(screen.getByTestId(command === 'takeover' ? 'viewer-close' : 'takeover-url')).toBeOnTheScreen();
  expect(screen.queryByTestId('composer-input')).toBeNull();
  if (command === 'takeover') expect(screen.queryByTestId('takeover-handback')).toBeNull();
});

test.each(commands)('%s：页面仍聚焦时正常导航，在途重复点击只执行一次', async (command) => {
  const pending = await start(command);
  expect(screen.getByTestId(button(command))).toBeDisabled();
  await fireEvent.press(screen.getByTestId(button(command)));
  expect(pending.request).toHaveBeenCalledTimes(1);
  await pending.succeed();
  expect(screen.getByTestId(command === 'takeover' ? 'takeover-handback' : 'composer-input')).toBeOnTheScreen();
  await act(() => router.back());
  await tick();
  expect(screen.getByTestId(command === 'takeover' ? 'viewer-close' : 'settings-computer-page-lease-release')).toBeOnTheScreen();
});

test.each(commands)('%s：失败留在原页并允许显式重试', async (command) => {
  const pending = await start(command);
  await act(() => pending.gate.resolve(jsonResponse({ error: { code: 'conflict', message: '控制权暂不可用' } }, 409)));
  await tick();
  expect(screen.getByTestId(button(command))).toBeEnabled();
  expect(screen.getByText('控制权暂不可用')).toBeOnTheScreen();
  const retry = Promise.withResolvers<Response>();
  pending.request.mockImplementation(() => retry.promise);
  await fireEvent.press(screen.getByTestId(button(command)));
  expect(pending.request).toHaveBeenCalledTimes(2);
  await act(() => retry.resolve(jsonResponse({ browser_task: { ...peer.state.browserTasks[0], state: command === 'takeover' ? 'human' : 'agent' }, replayed: false })));
  await tick();
  expect(screen.getByTestId(command === 'takeover' ? 'takeover-handback' : 'composer-input')).toBeOnTheScreen();
});
