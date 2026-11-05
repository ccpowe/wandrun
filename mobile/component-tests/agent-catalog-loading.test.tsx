import { act, fireEvent, screen } from '@testing-library/react-native';
import AgentEditorRoute from '../src/app/agent-editor';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';
import { onlineManager } from '@tanstack/react-query';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
let peer: FakeGateway;
beforeEach(() => { jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer); });
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

for (const catalog of [
  { route: 'GET /skills', panel: 'editor-skills', empty: '没有可用技能' },
  { route: 'GET /connectors', panel: 'editor-connectors', empty: '暂无连接器，请在设置 › 连接器添加。' },
] as const) test(`agent-catalog-loading：${catalog.route}尚未返回时不能呈现确定空态`, async () => {
  const gate = Promise.withResolvers<void>();
  peer.overrides[catalog.route] = async () => { await gate.promise; };
  await renderGateway(peer, AgentEditorRoute, '/agent-editor', {}, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId(catalog.panel));
  await tick();
  const emptyWhilePending = screen.queryByText(catalog.empty);
  await act(() => gate.resolve());
  await tick();
  // Distinguish the not-yet-read state from the same endpoint's authoritative empty result.
  expect(screen.getByText(catalog.empty)).toBeOnTheScreen();
  expect(emptyWhilePending).toBeNull();
});

test('连接器目录离线暂停刷新时不把旧空缓存显示成当前确定空态', async () => {
  await renderGateway(peer, AgentEditorRoute, '/agent-editor', {}, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId('editor-connectors')); await tick();
  expect(screen.getByText('暂无连接器，请在设置 › 连接器添加。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  try {
    onlineManager.setOnline(false);
    await fireEvent.press(screen.getByTestId('editor-connectors')); await tick();
    expect(screen.queryByText('暂无连接器，请在设置 › 连接器添加。')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  } finally {
    onlineManager.setOnline(true);
    await tick();
  }
  expect(screen.getByText('暂无连接器，请在设置 › 连接器添加。')).toBeOnTheScreen();
});

test('技能目录离线暂停刷新时不把旧空缓存显示成当前确定空态', async () => {
  await renderGateway(peer, AgentEditorRoute, '/agent-editor', {}, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId('editor-skills')); await tick();
  expect(screen.getByText('没有可用技能')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-done')); await tick();
  try {
    onlineManager.setOnline(false);
    await fireEvent.press(screen.getByTestId('editor-skills')); await tick();
    expect(screen.queryByText('没有可用技能')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  } finally { onlineManager.setOnline(true); await tick(); }
  expect(screen.getByText('没有可用技能')).toBeOnTheScreen();
});
