import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { BackHandler } from 'react-native';
import SettingsRoute from '../src/app/settings';
import SettingsModelsRoute from '../src/app/settings-models';
import AgentEditorRoute from '../src/app/agent-editor';
import { FakeGateway, unavailable } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
let peer: FakeGateway;
const routes = { '/settings-models': SettingsModelsRoute, '/agent-editor': AgentEditorRoute };
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer);
  peer.state.models.models.push({ id: 'careful', display_name: '深入模型', description: '用于复杂任务', default_reasoning_effort: 'medium', supported_reasoning_efforts: [{ effort: 'medium', description: '' }, { effort: 'high', description: '' }] });
  peer.state.subscription = { auth: { status: 'ready', reason: null, checked_at: 1, codex_home: '/fixture/codex', login_command: 'codex login' }, usage: { plan_type: 'plus', allowed: true, limit_reached: false, fetched_at: 1, windows: [{ name: 'primary', used_percent: 25, window_seconds: 18000, reset_at: 2000000000 }] } };
  peer.state.usage = { days: 7, agents: [{ agent_id: 'research', input_tokens: 1000, cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 50, daily: [] }] };
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
const open = () => renderGateway(peer, SettingsRoute, '/settings', routes);

test('settings-models.B5：返回自动保存；新建 Agent 继承模型与档位，既有 Agent 不变', async () => {
  await open();
  await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.getByTestId('settings-usage-research')).toHaveTextContent(/研究员/);
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  await fireEvent(screen.getByTestId('model-effort-slider'), 'valueChange', 1);
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(screen.queryByTestId('editor-leave-sheet')).toBeNull();
  expect(screen.getByTestId('settings-model-default')).toHaveTextContent(/深入模型/);
  await act(async () => router.push('/agent-editor')); await tick();
  expect(screen.getByTestId('editor-model')).toHaveTextContent(/深入模型/);
  expect(screen.getByTestId('editor-reasoning-value')).toHaveTextContent('高');
  expect(peer.state.agentDetails.get('research')!.model).toBe('offline');
});

test('settings-models.A2/B4：订阅读取失败不冒充未登录；明确拒绝恢复原选择，再返回可退出', async () => {
  peer.overrides['GET /usage/subscription'] = () => unavailable('账户状态暂不可用');
  peer.overrides['PUT /settings'] = () => unavailable('默认模型未保存', 400);
  await open();
  await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.queryByText('未登录')).toBeNull();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  await fireEvent.press(screen.getByTestId('settings-model-save')); await tick();
  expect(screen.getByText('默认模型未保存')).toBeOnTheScreen();
  expect(screen.getByTestId('model-row-offline')).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
  expect(peer.state.settings.default_model).toBe('offline');
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(screen.getByTestId('settings-model-default')).toBeOnTheScreen();
});

test('settings-models.B3/T1：无改动不写入，返回保存进行中不能重复提交', async () => {
  let writes = 0;
  const gate = Promise.withResolvers<void>();
  peer.overrides['PUT /settings'] = async () => { writes++; await gate.promise; };
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('settings-model-save')); await tick();
  expect(writes).toBe(0);
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(screen.getByTestId('settings-model-save')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('settings-model-back'));
  expect(writes).toBe(1);
  await act(() => gate.resolve()); await tick();
  expect(screen.getByTestId('settings-model-default')).toHaveTextContent(/深入模型/);
  expect(writes).toBe(1);
});

test('settings-models.B5：Android 返回与顶部返回同样自动保存', async () => {
  const subscription = jest.spyOn(BackHandler, 'addEventListener');
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  const handler = subscription.mock.calls.filter(([name]) => name === 'hardwareBackPress').at(-1)![1];
  await act(() => { expect(handler({ type: 'hardwareBackPress', timeStamp: 0 })).toBe(true); }); await tick();
  expect(screen.getByTestId('settings-model-default')).toHaveTextContent(/深入模型/);
});

test('settings-models.B5/T1：原生移除先保存，再继续原返回动作', async () => {
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('settings-models')).toBeOnTheScreen();
  expect(peer.state.settings.default_model).toBe('careful');
});

for (const applied of [false, true]) test(`settings-models.B4/T3：未知${applied ? '已写入' : '未写入'}可离开重入，核对后返回不隐式重放`, async () => {
  let writes = 0;
  let recovered = false;
  peer.overrides['PUT /settings'] = async (_context, respond) => { writes++; if (applied) await respond(); return unavailable(); };
  peer.overrides['GET /settings'] = () => writes && !recovered ? unavailable() : undefined;
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  await tick(3000);
  expect(screen.getByText('结果未确认，恢复连接后会核对')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-model-save')).toBeDisabled();
  expect(screen.getByTestId('model-row-offline')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default')); await tick();
  expect(screen.getByTestId('settings-model-save')).toBeDisabled();
  recovered = true; await tick(1500);
  expect(screen.getByTestId(`model-row-${applied ? 'careful' : 'offline'}`)).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(screen.getByTestId('settings-model-default')).toBeOnTheScreen();
  expect(writes).toBe(1);
});

test('settings-models.B6：已离线返回恢复原选择，明确提示未保存且不发写请求', async () => {
  let writes = 0;
  peer.overrides['PUT /settings'] = () => { writes++; };
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  peer.overrides['GET /events'] = () => unavailable();
  await act(() => peer.disconnect()); await tick(1500);
  expect(screen.getByTestId('settings-model-save')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(screen.getByText('网络连接失败，未保存')).toBeOnTheScreen();
  expect(screen.getByTestId('model-row-offline')).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  expect(screen.getByTestId('settings-model-default')).toBeOnTheScreen();
  expect(writes).toBe(0);
});

test('settings-models.A2 A4 A5 历史额度与当前登录证据独立：失败不继续显示旧登录指令', async () => {
  peer.state.subscription!.auth.status = 'login_required';
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.getByTestId('settings-subscription-login')).toBeOnTheScreen();
  expect(screen.getByRole('progressbar', { value: { now: 25 } })).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('settings-models-back')); await tick();
  peer.overrides['GET /usage/subscription'] = () => unavailable();
  await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.queryByTestId('settings-subscription-login')).toBeNull();
  expect(screen.getByRole('progressbar', { value: { now: 25 } })).toBeOnTheScreen();
  await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
});

test('settings-models.B1 M1 新访问不能用旧缓存建立默认选择，等待本次成功读取再采纳', async () => {
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-models-back')); await tick();
  peer.state.settings = { default_model: 'careful', default_reasoning_effort: 'high' };
  const gate = Promise.withResolvers<void>();
  peer.overrides['GET /settings'] = async () => { await gate.promise; };
  try {
    await fireEvent.press(screen.getByTestId('settings-models')); await tick();
    expect(screen.getByTestId('settings-model-default')).toBeDisabled();
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId('settings-model-default')).toBeEnabled();
    await fireEvent.press(screen.getByTestId('settings-model-default'));
    expect(screen.getByTestId('model-row-careful')).toHaveProp('accessibilityState', expect.objectContaining({ selected: true }));
  } finally { await act(() => gate.resolve()); }
});

test('审查 G1：原生断网暂停撤销当前登录和阻断证据，保留历史额度，恢复后读取新事实', async () => {
  peer.state.subscription!.usage!.allowed = false;
  peer.state.subscription!.usage!.limit_reached = true;
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.getByTestId('settings-subscription-warning')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-subscription-auth')).toHaveTextContent('已登录');
  peer.overrides['GET /events'] = () => unavailable();
  try {
    await act(() => { onlineManager.setOnline(false); peer.disconnect(); }); await tick(1500);
    expect(screen.queryByTestId('settings-subscription-warning')).toBeNull();
    expect(screen.getByTestId('settings-subscription-auth')).not.toHaveTextContent('已登录');
    expect(screen.getByTestId('settings-subscription-quota-date')).toHaveTextContent(/历史额度/);
    expect(screen.getByRole('progressbar', { value: { now: 25 } })).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('settings-models-back')); await tick();
    expect(screen.getByTestId('settings-models')).not.toHaveTextContent(/额度受限/);
  } finally {
    delete peer.overrides['GET /events'];
    peer.state.subscription!.usage = { ...peer.state.subscription!.usage!, fetched_at: 2, allowed: true, limit_reached: false,
      windows: [{ name: 'primary', used_percent: 42, window_seconds: 18000, reset_at: 2000000000 }] };
    await act(() => onlineManager.setOnline(true)); await tick(5000);
  }
  await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.getByTestId('settings-subscription-auth')).toHaveTextContent('已登录');
  expect(screen.getByTestId('settings-subscription-quota-date')).not.toHaveTextContent(/历史额度/);
  expect(screen.getByRole('progressbar', { value: { now: 42 } })).toBeOnTheScreen();
  expect(screen.queryByTestId('settings-subscription-warning')).toBeNull();
});

test('审查 G2：核对提示属于本次采纳，重入读取失败可见且下次成功不重放历史提示', async () => {
  let writes = 0;
  peer.overrides['PUT /settings'] = () => { writes++; return unavailable(); };
  await open(); await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await fireEvent.press(screen.getByTestId('settings-model-default'));
  await fireEvent.press(screen.getByTestId('model-row-careful'));
  await fireEvent.press(screen.getByTestId('settings-model-save')); await tick(1500);
  expect(screen.getByRole('alert')).toHaveTextContent(/已核对/);
  await fireEvent.press(screen.getByTestId('settings-model-back')); await tick();
  await fireEvent.press(screen.getByTestId('settings-models-back')); await tick();
  peer.overrides['GET /usage/subscription'] = () => unavailable();
  await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  await tick(3000);
  expect(screen.getByRole('alert')).toHaveTextContent(/无法加载.*登录状态/);
  expect(screen.getByRole('alert')).toHaveTextContent(/可能不是最新/);
  await fireEvent.press(screen.getByTestId('settings-models-back')); await tick();
  delete peer.overrides['GET /usage/subscription'];
  await fireEvent.press(screen.getByTestId('settings-models')); await tick();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(writes).toBe(1);
});

test('审查 G1：网络已暂停但 SSE 尚未断开时，首页与详情都不把历史额度当当前证据', async () => {
  peer.state.subscription!.usage!.allowed = false;
  peer.state.subscription!.usage!.limit_reached = true;
  await open();
  expect(screen.getByTestId('settings-models')).toHaveTextContent(/额度受限/);
  try {
    await act(() => onlineManager.setOnline(false));
    await fireEvent.press(screen.getByTestId('settings-models')); await tick();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('settings-subscription-warning')).toBeNull();
    expect(screen.getByTestId('settings-subscription-auth')).not.toHaveTextContent('已登录');
    expect(screen.getByTestId('settings-subscription-quota-date')).toHaveTextContent(/历史额度/);
    await fireEvent.press(screen.getByTestId('settings-models-back')); await tick();
    expect(screen.getByTestId('settings-models')).toBeEnabled();
    expect(screen.getByTestId('settings-models')).not.toHaveTextContent(/额度受限/);
  } finally { await act(() => onlineManager.setOnline(true)); await tick(); }
});

test('settings-models.T2 提醒读取身份：订阅恢复与默认设置失败并发回包，新错误重新等待三秒', async () => {
  let subscriptionReads = 0;
  const subscriptionRetry = Promise.withResolvers<void>();
  const settingsReply = Promise.withResolvers<void>();
  peer.overrides['GET /usage/subscription'] = async () => {
    if (++subscriptionReads === 1) return unavailable();
    await subscriptionRetry.promise;
  };
  peer.overrides['GET /settings'] = async () => { await settingsReply.promise; return unavailable(); };
  try {
    await renderGateway(peer, SettingsModelsRoute, '/settings-models');
    await tick(3500);
    expect(subscriptionReads).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('无法加载登录状态，正在重试…')).toBeOnTheScreen();
    await act(() => { subscriptionRetry.resolve(); settingsReply.resolve(); });
    await tick(100);
    expect(screen.queryByText('无法加载登录状态，正在重试…')).toBeNull();
    expect(screen.queryByText('无法加载默认模型，正在重试…')).toBeNull();
    await tick(2800);
    expect(screen.queryByText('无法加载默认模型，正在重试…')).toBeNull();
    await tick(200);
    expect(screen.getByText('无法加载默认模型，正在重试…')).toBeOnTheScreen();
    expect(screen.getByTestId('settings-model-default')).toBeDisabled();
  } finally {
    await act(() => { subscriptionRetry.resolve(); settingsReply.resolve(); });
  }
});
