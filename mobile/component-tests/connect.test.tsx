import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import * as stories from '../src/dev/connect.stories';
import { connectScenario } from '../src/dev/connect-scenario';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import type { SavedComputer } from '../src/lib/credentials';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
let mockWindow = { width: 393, height: 852 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => ({ ...mockWindow, scale: 2, fontScale: 1 }) }));
let mockCameraGranted = true;
jest.mock('expo-camera', () => {
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  return { CameraView: (props: object) => React.createElement(View, { ...props, testID: 'pairing-camera' }),
    useCameraPermissions: () => [{ granted: mockCameraGranted }, async () => ({ granted: mockCameraGranted })] };
});
const Stories = composeStories(stories);
const tick = (ms = 100) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
beforeEach(() => { jest.useFakeTimers(); mockCameraGranted = true; mockWindow = { width: 393, height: 852 }; });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
async function manual(code: string) {
  await fireEvent.press(screen.getByTestId('pairing-manual'));
  await fireEvent.changeText(screen.getByTestId('pairing-address'), 'https://pairing-story.invalid');
  await fireEvent.changeText(screen.getByTestId('pairing-code'), code);
}

test('settings-connect.A1/P3 手动配对重复点击只兑换一次，保存主机名后显示实际服务器卡片', async () => {
  const scenario = connectScenario('normal', 'B1TEST01');
  scenario.hold();
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await manual(scenario.code);
  const submit = screen.getByTestId('pairing-submit');
  await fireEvent.press(submit); await fireEvent.press(submit); await tick();
  expect(screen.getByTestId('pairing-submit')).toBeDisabled();
  expect(scenario.exchanges).toBe(1);
  await fireEvent.press(screen.getByTestId('pairing-cancel')); await tick();
  await tick(3000);
  expect(screen.getByTestId('pairing-progress')).toBeOnTheScreen();
  await act(() => scenario.release()); await tick();
  expect(scenario.exchanges).toBe(1);
  expect(scenario.runtime.credentials.snapshot().config?.computerName).toBe('research-host');
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('research-host');
});
test('settings-connect.A2/P2 拒绝相机权限仍能进入手动流程，不打开相机或发起兑换', async () => {
  mockCameraGranted = false;
  const scenario = connectScenario('normal', 'B1TEST02');
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await fireEvent.press(screen.getByTestId('pairing-scan')); await tick();
  expect(screen.getByTestId('pairing-address')).toBeOnTheScreen();
  expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
  expect(screen.queryByTestId('pairing-camera')).toBeNull();
  expect(screen.getByTestId('pairing-submit')).toBeDisabled();
  expect(scenario.exchanges).toBe(0);
});
test('settings-connect.A2/P3 扫描兑换后取消只是停止等待，应用继续保存首次回执且不重放', async () => {
  const scenario = connectScenario('normal', 'B1TEST03'); scenario.hold();
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await fireEvent.press(screen.getByTestId('pairing-scan')); await tick();
  const qr = `wandrun://pair?url=https%3A%2F%2Fpairing-story.invalid&code=${scenario.code}`;
  await fireEvent(screen.getByTestId('pairing-camera'), 'barcodeScanned', { data: qr }); await tick();
  expect(scenario.exchanges).toBe(1);
  await fireEvent.press(screen.getByTestId('pairing-cancel')); await tick();
  await tick(3000);
  expect(screen.getByTestId('pairing-progress')).toBeOnTheScreen();
  expect(screen.getByTestId('pairing-retry-scan')).toBeDisabled();
  await act(() => scenario.release()); await tick();
  expect(scenario.exchanges).toBe(1);
  expect(scenario.runtime.credentials.snapshot().config?.deviceId).toBe(`paired-${scenario.code}`);
});
test('settings-connect.A3/P5 安全保存失败保留可见错误；同一码再次提交不重复兑换', async () => {
  const scenario = connectScenario('save-failure', 'B1TEST04');
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await manual(scenario.code); await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
  expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
  expect(scenario.runtime.credentials.snapshot().config).toBeNull();
  await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
  expect(scenario.exchanges).toBe(1);
  expect(scenario.runtime.credentials.snapshot().config).toBeNull();
  await fireEvent.press(screen.getByTestId('pairing-back')); await tick();
  await fireEvent.press(screen.getByTestId('pairing-scan')); await tick();
  const qr = `wandrun://pair?url=https%3A%2F%2Fpairing-story.invalid&code=${scenario.code}`;
  await fireEvent(screen.getByTestId('pairing-camera'), 'barcodeScanned', { data: qr }); await tick();
  await act(() => router.replace('/settings')); await tick();
  await act(() => router.replace('/connect')); await tick();
  await fireEvent.press(screen.getByTestId('pairing-scan')); await tick();
  await fireEvent(screen.getByTestId('pairing-camera'), 'barcodeScanned', { data: qr }); await tick();
  expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
  expect(scenario.exchanges).toBe(1);
});

for (const outcome of ['timeout', 'failure', 'success'] as const) {
  test(`settings-connect.P3 返回入口仍显示应用级请求，${outcome} 后才恢复操作`, async () => {
    const scenario = connectScenario(outcome === 'failure' ? 'exchange-failure' : 'normal',
      outcome === 'failure' ? 'B1FAIL01' : outcome === 'success' ? 'B1BACK01' : 'B1TIME01');
    scenario.hold();
    await render(<Stories.A1 scenario={scenario} />); await tick();
    await manual(scenario.code); await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
    await fireEvent.press(screen.getByTestId('pairing-back')); await tick();
    await tick(3000);
    expect(screen.getByTestId('pairing-progress')).toBeOnTheScreen();
    expect(screen.getByTestId('pairing-scan')).toBeDisabled();
    if (outcome === 'timeout') await tick(15_000);
    else { await act(() => scenario.release()); await tick(); }
    if (outcome === 'success') {
      expect(scenario.runtime.credentials.snapshot().config?.deviceId).toBe(`paired-${scenario.code}`);
      expect(scenario.exchanges).toBe(1);
      expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('research-host');
      return;
    }
    expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
    expect(screen.queryByTestId('pairing-progress')).toBeNull();
    expect(screen.getByTestId('pairing-scan')).toBeEnabled();
    expect(scenario.runtime.credentials.snapshot().config).toBeNull();
    expect(scenario.exchanges).toBe(1);
  });
}

test('settings-connect.P3 页面离开后重新进入共享在途兑换，首次回执仍只安装一次', async () => {
  const scenario = connectScenario('normal', 'B1LIFE01'); scenario.hold();
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await manual(scenario.code); await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
  await act(() => router.replace('/settings')); await tick();
  await act(() => router.replace('/connect')); await tick();
  await tick(3000);
  expect(screen.getByTestId('pairing-progress')).toBeOnTheScreen();
  expect(screen.getByTestId('pairing-scan')).toBeDisabled();
  await act(() => scenario.release()); await tick();
  expect(scenario.exchanges).toBe(1);
  expect(scenario.runtime.credentials.snapshot().config?.deviceId).toBe(`paired-${scenario.code}`);
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('research-host');
});

test('settings-connect.P4 原生保存中重入不能取消或换页，失败后已消费码仍不可重兑', async () => {
  const scenario = connectScenario('save-failure', 'B1SAVE01'); scenario.holdSaving();
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await manual(scenario.code); await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
  expect(screen.queryByTestId('pairing-cancel')).toBeNull();
  await act(() => router.replace('/settings')); await tick();
  await act(() => router.replace('/connect')); await tick();
  await tick(3000);
  expect(screen.getByTestId('pairing-progress')).toBeOnTheScreen();
  expect(screen.getByTestId('pairing-scan')).toBeDisabled();
  expect(screen.getByTestId('pairing-manual')).toBeDisabled();
  await act(() => scenario.releaseSaving()); await tick();
  expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
  expect(screen.getByTestId('pairing-scan')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('pairing-scan')); await tick();
  const qr = `wandrun://pair?url=https%3A%2F%2Fpairing-story.invalid&code=${scenario.code}`;
  await fireEvent(screen.getByTestId('pairing-camera'), 'barcodeScanned', { data: qr }); await tick();
  expect(scenario.exchanges).toBe(1);
  expect(scenario.runtime.credentials.snapshot().config).toBeNull();
  expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
});

for (const [kind, code] of [['save-failure', 'B1OFF001'], ['exchange-failure', 'B1OFF002']] as const) {
  test(`settings-connect.P5 ${kind} 离屏结算只通知一次，重入仍可见真实失败`, async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const scenario = connectScenario(kind, code); scenario.hold();
    await render(<Stories.A1 scenario={scenario} />); await tick();
    await manual(scenario.code); await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
    await act(() => router.replace('/settings')); await tick();
    await act(() => scenario.release()); await tick();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(scenario.runtime.credentials.snapshot().config).toBeNull();
    await act(() => router.replace('/connect')); await tick();
    expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
    expect(screen.getByTestId('pairing-scan')).toBeEnabled();
    expect(scenario.exchanges).toBe(1);
    expect(alert).toHaveBeenCalledTimes(1);
  });
}

const invalidServer = (baseUrl = 'https://pairing-story.invalid'): SavedComputer => ({
  computerId: 'previous-server', connectionId: 'previous-installation', baseUrl,
  token: 'previous-token', deviceId: 'previous-device', authStatus: 'invalid', localName: '研究服务器',
});
for (const [index, intent] of ['add-other-address', 'add-same-address', 'default-same-address', 'repair'].entries()) {
  test(`settings-connect.A2 明确保留失效服务器的 ${intent} 意图`, async () => {
    const previous = invalidServer(intent === 'add-other-address' ? 'https://previous-story.invalid' : undefined);
    const scenario = connectScenario('normal', `B1INT00${index}`, previous);
    await render(<Stories.A1 scenario={scenario} />); await tick();
    expect(screen.getByTestId('pairing-invalid')).toBeOnTheScreen();
    if (intent !== 'default-same-address') {
      await act(() => router.replace({ pathname: '/connect', params: intent === 'repair'
        ? { address: previous.baseUrl, repair: previous.connectionId } : { mode: 'add' } })); await tick();
    }
    await manual(scenario.code); await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
    const current = scenario.runtime.credentials.snapshot();
    expect(current.config?.baseUrl).toBe('https://pairing-story.invalid');
    expect(current.config?.deviceId).toBe(`paired-${scenario.code}`);
    expect(current.config?.authStatus).toBeUndefined();
    expect(current.config?.connectionId).not.toBe(previous.connectionId);
    if (intent === 'repair') {
      expect(current.computers).toHaveLength(1);
      expect(current.config?.computerId).toBe(previous.computerId);
      expect(current.config?.localName).toBe(previous.localName);
    } else {
      expect(current.computers).toHaveLength(2);
      expect(current.config?.computerId).not.toBe(previous.computerId);
      expect(current.computers.find(server => server.computerId === previous.computerId)).toEqual(previous);
    }
    expect(scenario.exchanges).toBe(1);
  });
}

test('settings-connect.A2 显式修复不能借另一地址覆盖原服务器且不会兑换一次性码', async () => {
  const previous = invalidServer();
  const scenario = connectScenario('normal', 'B1WRONG1', previous);
  await render(<Stories.A1 scenario={scenario} />); await tick();
  await act(() => router.replace({ pathname: '/connect', params: { address: previous.baseUrl, repair: previous.connectionId } })); await tick();
  await manual(scenario.code);
  await fireEvent.changeText(screen.getByTestId('pairing-address'), 'https://other-story.invalid');
  await fireEvent.press(screen.getByTestId('pairing-submit')); await tick();
  expect(scenario.exchanges).toBe(0);
  expect(scenario.runtime.credentials.snapshot().computers).toEqual([previous]);
  expect(screen.getByTestId('pairing-error')).toBeOnTheScreen();
});

test('settings-connect.P4 取消开发探测中止传输，迟到应答不安装，下一次用户连接可成功', async () => {
  const scenario = connectScenario('normal', 'B1DEV001');
  scenario.gateway.state.connection!.device_id = null;
  scenario.gateway.state.connection!.paired_at = null;
  scenario.gateway.state.connection!.pairing_method = 'development';
  const held = Promise.withResolvers<void>();
  scenario.gateway.overrides['GET /connection'] = async () => { await held.promise; };
  const signals: AbortSignal[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).endsWith('/connection') && init?.signal) signals.push(init.signal);
    return scenario.gateway.fetch(input, init);
  });
  await render(<Stories.A1 scenario={scenario} />); await tick();
  for (let index = 0; index < 7; index++) await fireEvent.press(screen.getByTestId('pairing-title'));
  await fireEvent.changeText(screen.getByTestId('gateway-address'), 'https://pairing-story.invalid');
  await fireEvent.changeText(screen.getByTestId('gateway-token'), 'dev');
  await fireEvent.press(screen.getByTestId('gateway-save')); await tick();
  const firstSignal = signals[0];
  expect(firstSignal?.aborted).toBe(false);
  await fireEvent.press(screen.getByTestId('pairing-cancel')); await tick();
  expect(firstSignal.aborted).toBe(true);
  await act(() => held.resolve()); await tick();
  expect(scenario.runtime.credentials.snapshot().config).toBeNull();
  delete scenario.gateway.overrides['GET /connection'];
  await fireEvent.press(screen.getByTestId('gateway-save')); await tick();
  expect(signals).toHaveLength(2);
  expect(scenario.exchanges).toBe(0);
  expect(scenario.runtime.credentials.snapshot().config?.pairingMethod).toBe('development');
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('research-host');
});
test.each([['A1', 'light'], ['A1Dark', 'dark']] as const)('settings-connect.A1 landing：%s 按主题选插画，左对齐标题与两步说明，命令整句翻译后内联', async (story, theme) => {
  const scenario = connectScenario('normal', theme === 'dark' ? 'B1TEST18' : 'B1TEST17');
  const Story = Stories[story];
  await render(<Story scenario={scenario} />); await tick();
  const art = screen.getByLabelText('小生物从电脑屏幕后探出头');
  expect(art.props.source).toEqual(theme === 'dark' ? require('../assets/pairing-peek-dark.png') : require('../assets/pairing-peek.png'));
  expect(screen.getByText('连接你的服务器')).toBeOnTheScreen();
  expect(screen.getByText(/在服务器上运行/)).toHaveTextContent('在服务器上运行  wandrun pair ');
  expect(screen.getByText('用手机扫描屏幕上的二维码')).toBeOnTheScreen();
  expect(screen.getByTestId('pairing-scan')).toHaveTextContent('扫码连接');
  expect(screen.getByTestId('pairing-manual')).toHaveTextContent('手动输入地址和配对码');
});

test.each([
  ['正常高竖屏', { width: 393, height: 852 }, false, 210],
  ['320×568 小屏 · 认证失效', { width: 320, height: 568 }, true, 150],
  ['800×360 横屏 · 认证失效', { width: 800, height: 360 }, true, 150],
] as const)('settings-connect.A1 landing %s：正文在可滚动区内保持居中，底部动作固定在滚动区外', async (_name, size, invalid, artWidth) => {
  mockWindow = { ...size };
  const scenario = connectScenario('normal', invalid ? 'B1TEST20' : 'B1TEST19', invalid ? invalidServer() : undefined);
  await render(<Stories.A1 scenario={scenario} />); await tick();
  const scroll = screen.getByTestId('pairing-landing-scroll');
  expect(scroll.type).toBe('RCTScrollView');
  expect(scroll.props.contentContainerStyle).toMatchObject({ flexGrow: 1, justifyContent: 'center' });
  const body = within(scroll);
  expect(body.getByText('连接你的服务器')).toBeOnTheScreen();
  expect(body.getByText('用手机扫描屏幕上的二维码')).toBeOnTheScreen();
  expect(body.getByLabelText('小生物从电脑屏幕后探出头').props.style).toMatchObject({ width: artWidth });
  if (invalid) expect(body.getByTestId('pairing-invalid')).toBeOnTheScreen();
  for (const id of ['pairing-scan', 'pairing-manual', ...(invalid ? ['pairing-computers'] : [])]) {
    expect(body.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId(id)).toBeOnTheScreen();
  }
});
