import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Network from 'expo-network';
import * as stories from '../src/dev/settings-models.stories';
import { modelsScenario } from '../src/dev/settings-models-scenario';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const Models = composeStories(stories);
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Network, 'addNetworkStateListener').mockReturnValue({ remove() {} });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const tick = async (ms = 100) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

test('settings-models.A1/B1/C2：首载不冒充空，慢读取才显示加载指示', async () => {
  const peer = modelsScenario('loading');
  await render(<Models.A1 scenario={peer} />); await tick(100);
  expect(screen.queryByRole('progressbar', { name: '加载中…' })).toBeNull();
  expect(screen.queryByText('最近 7 天暂无用量')).toBeNull();
  expect(screen.queryByText('暂时无法获取额度')).toBeNull();
  await tick(300);
  expect(screen.getAllByRole('progressbar', { name: '加载中…' })[0]).toBeOnTheScreen();
  expect(screen.getByTestId('settings-model-default')).toBeDisabled();
  await act(() => peer.release()); await tick();
  expect(screen.queryByRole('progressbar', { name: '加载中…' })).toBeNull();
  expect(screen.getByTestId('settings-usage-models-agent-0')).toHaveTextContent(/100K tokens/);
});

test('settings-models.A2/B1/T2：多资源失败一条横幅，后台恢复且没有手动重试', async () => {
  const peer = modelsScenario('read-failure');
  await render(<Models.A2 scenario={peer} />); await tick();
  await tick(3000);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent(/登录状态.*默认模型.*用量.*模型目录/);
  expect(screen.queryByText('重试')).toBeNull();
  expect(screen.queryByText('尚未登录')).toBeNull();
  expect(screen.getByTestId('settings-model-default')).toBeDisabled();
  await act(() => peer.recover()); await tick(1500);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('settings-model-default')).toHaveTextContent(/日常模型/);
  expect(screen.getByTestId('settings-usage-models-agent-0')).toHaveTextContent(/100K tokens/);
});

test('settings-models.A2/A5/C2/T2：刷新失败保留用量与历史额度，不保留当前登录证据', async () => {
  const peer = modelsScenario('read-stale');
  await render(<Models.T2 scenario={peer} />); await tick();
  expect(screen.getByTestId('settings-subscription-auth')).toHaveTextContent('已登录');
  await tick(3500);
  await tick(3000);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent(/内容可能不是最新的/);
  expect(screen.getByTestId('settings-subscription-auth')).toHaveTextContent('登录状态待检查');
  expect(screen.getByTestId('settings-subscription-quota-date')).toHaveTextContent(/历史额度，不代表当前登录状态/);
  expect(screen.getByTestId('settings-usage-models-agent-0')).toHaveTextContent(/100K tokens/);
  await act(() => peer.recover()); await tick(1500);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('settings-subscription-auth')).toHaveTextContent('已登录');
});

test('settings-models.B2：未知模型和强度先保留，无交互返回不写入', async () => {
  const peer = modelsScenario('model-unlisted');
  await render(<Models.B2Unlisted scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default')); await tick();
  expect(screen.getByTestId('model-current-unlisted')).toHaveTextContent(/retired-model/);
  expect(screen.getByTestId('model-effort-value')).toHaveTextContent('retired-effort');
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(peer.writes).toBe(0);
  expect(screen.getByTestId('settings-model-default')).toHaveTextContent(/retired-model/);
});

test('settings-models.C1/C3：用量行跟随 SSE 后当前 Agent 名字与删除，不显示历史身份', async () => {
  const peer = modelsScenario();
  await render(<Models.C3 scenario={peer} />); await tick();
  const id = 'models-agent-0';
  peer.gateway.state.agents = peer.gateway.state.agents.map(agent => agent.id === id ? { ...agent, name: '当前名字' } : agent);
  await act(() => peer.gateway.emit(peer.gateway.event('resource.changed', { kind: 'agent', id, op: 'updated' }))); await tick();
  expect(screen.getByTestId(`settings-usage-${id}`)).toHaveTextContent(/当前名字/);
  const removed = peer.gateway.state.agents.map(agent => agent.id);
  peer.gateway.state.agents = [];
  await act(() => { for (const id of removed) peer.gateway.emit(peer.gateway.event('resource.changed', { kind: 'agent', id, op: 'deleted' })); }); await tick();
  expect(screen.queryByTestId(`settings-usage-${id}`)).toBeNull();
  expect(screen.getByText('还没有 Agent')).toBeOnTheScreen();
});
