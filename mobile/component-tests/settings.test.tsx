import { onlineManager } from '@tanstack/react-query';
import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { appearance } from '../src/lib/appearance-context';
import * as stories from '../src/dev/settings.stories';
import { router } from 'expo-router';
import { unavailable } from '../src/dev/fake-gateway';
import { settingsScenario } from '../src/dev/settings-scenario';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const Stories = composeStories(stories);
const tick = async (ms = 200) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('settings.A1 C1 D1 名片进入连接，无箭头的电脑行仍可点名切换并同步设置', async () => {
  await render(<Stories.A1 />); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('MacBook Pro');
  expect(screen.queryByText('全部 Agent')).toBeNull();
  expect(screen.queryByText('通知')).toBeNull();
  await fireEvent.press(screen.getByTestId('settings-connection')); await tick();
  expect(screen.getByTestId('connection-address')).toHaveTextContent(/192\.168\.1\.20/);
  await fireEvent.press(screen.getByRole('button', { name: /Mac mini · 书房/ })); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.getByTestId('connection-address')).toHaveTextContent(/192\.168\.1\.31/);
  await fireEvent.press(screen.getByTestId('gateway-back')); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('Mac mini · 书房');
});

test('settings.A3 重连时禁用 Agent 资源入口，但外观和连接管理仍可进入', async () => {
  await render(<Stories.A3 />); await tick(1200);
  for (const id of ['models', 'skills', 'connectors', 'about-you']) expect(screen.getByTestId(`settings-${id}`)).toBeDisabled();
  expect(screen.getByTestId('settings-appearance')).toBeEnabled();
  expect(screen.getByTestId('settings-connection')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('settings-connection')); await tick();
  expect(screen.getByTestId('connection-rename')).toBeEnabled();
  expect(screen.getByTestId('connection-disconnect')).toBeEnabled();
});

test('settings.C1 D4 D5 点信息卡备注名编辑，存储失败保留弹层草稿，重试后两处名称同步', async () => {
  const peer = settingsScenario('C1');
  await render(<Stories.C1 scenario={peer} />); await tick();
  expect(screen.getByTestId('connection-rename')).toHaveTextContent(/MacBook Pro/);
  expect(screen.queryByText('修改备注名')).toBeNull();
  expect(screen.queryByText('切换')).toBeNull();
  await fireEvent.press(screen.getByTestId('connection-rename')); await tick();
  await fireEvent.changeText(screen.getByTestId('connection-local-name'), '工作电脑');
  peer.failStorage();
  await fireEvent.press(screen.getByTestId('connection-rename-confirm')); await tick();
  expect(screen.getByTestId('connection-action-error')).toBeOnTheScreen();
  expect(screen.getByTestId('connection-local-name')).toHaveDisplayValue('工作电脑');
  peer.failStorage(false);
  await fireEvent.press(screen.getByTestId('connection-rename-confirm')); await tick();
  expect(screen.queryByTestId('connection-local-name')).toBeNull();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('工作电脑');
  expect(screen.getByTestId('connection-rename')).toHaveTextContent(/工作电脑/);
});

test('settings.D7 T6 远端不可达只在服务器与连接页横幅说明，可关闭，离开页面不再显示，不恢复已移除服务器', async () => {
  const peer = settingsScenario('D7');
  await render(<Stories.D7 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  // Removing the current server remounts the page container; the page still owns the notice.
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.getByTestId('disconnect-notice')).toHaveTextContent('服务器上的配对记录未能同步移除，不影响使用。');
  expect(JSON.parse(peer.stored!).computers.map((row: { computerId: string }) => row.computerId)).toEqual(['settings-mini']);
  expect(screen.queryByTestId('connection-computer-settings-laptop')).toBeNull();
  await fireEvent.press(screen.getByTestId('disconnect-notice-dismiss')); await tick();
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
});

test('settings.D7 断开后离开服务器与连接页，提醒不跟到设置首页或其他页面', async () => {
  const peer = settingsScenario('D7');
  await render(<Stories.Journey scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('settings-connection')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(screen.getByTestId('disconnect-notice')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('gateway-back')); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
  await fireEvent.press(screen.getByTestId('settings-connection')); await tick();
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
});

test('settings.A5 T1 首次读取不伪造零，完成前延迟反馈，返回后显示真实数量', async () => {
  const peer = settingsScenario('A5');
  await render(<Stories.A5 scenario={peer} />); await tick(0);
  expect(screen.getByTestId('settings-skills')).not.toHaveTextContent(/0/);
  expect(screen.queryByRole('progressbar')).toBeNull();
  await tick(300);
  expect(within(screen.getByTestId('settings-skills')).getByRole('progressbar')).toBeOnTheScreen();
  peer.releaseReads(); await tick();
  expect(screen.getByTestId('settings-skills')).toHaveTextContent(/12/);
  expect(screen.queryByRole('progressbar')).toBeNull();
});

test('settings.A5 技能摘要首次读取被 Query 暂停时不显示正在加载', async () => {
  const peer = settingsScenario('A5');
  try {
    await render(<Stories.A5 scenario={peer} />); await tick(400);
    expect(within(screen.getByTestId('settings-skills')).getByRole('progressbar')).toBeOnTheScreen();
    await act(async () => { onlineManager.setOnline(false); peer.changeResources(); });
    await tick(400);
    expect(within(screen.getByTestId('settings-skills')).queryByRole('progressbar')).toBeNull();
  } finally {
    onlineManager.setOnline(true); peer.releaseReads(); await tick();
  }
});

test('settings.A6 T2 读取失败只有一条横幅，后台恢复后正常显示且无手动重试', async () => {
  const peer = settingsScenario('A6');
  await render(<Stories.A6 scenario={peer} />); await tick();
  await tick(3000);
  expect(screen.getAllByText('无法加载设置，正在重试…')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  peer.recover(); await tick(1200);
  expect(screen.queryByText('无法加载设置，正在重试…')).toBeNull();
  expect(screen.getByTestId('settings-skills')).toHaveTextContent(/12/);
  expect(screen.getByTestId('settings-models')).toBeEnabled();
});

test('settings.A7 T2 T4 旧摘要失败保留，离线横幅优先，恢复读成功才清错', async () => {
  const peer = settingsScenario();
  await render(<Stories.A1 scenario={peer} />); await tick();
  peer.failReads(); await tick();
  expect(screen.getByTestId('settings-connectors')).toHaveTextContent(/5/);
  await tick(3000);
  expect(screen.getByText('无法加载设置，正在重试…')).toBeOnTheScreen();
  expect(screen.getByText('内容可能不是最新的')).toBeOnTheScreen();
  peer.disconnect(); await tick(3000);
  expect(screen.queryByText('无法加载设置，正在重试…')).toBeNull();
  expect(screen.getByTestId('settings-models')).toBeDisabled();
  peer.recover(); await tick(1200);
  expect(screen.queryByText('无法加载设置，正在重试…')).toBeNull();
  expect(screen.getByTestId('settings-connectors')).toHaveTextContent(/5/);
  expect(screen.getByTestId('settings-models')).toBeEnabled();
});

test('settings.A4 A8 连接错误与没有电脑均不伪造在线，本机外观不被锁住', async () => {
  const view = await render(<Stories.A4 />); await tick();
  expect(screen.getByTestId('settings-connection-status')).toHaveTextContent('连接失败');
  expect(screen.getByTestId('settings-models')).toBeDisabled();
  expect(screen.getByTestId('settings-connection')).toBeEnabled();
  await view.unmount();
  await render(<Stories.A8 />); await tick();
  expect(screen.getByTestId('settings-connection-status')).toHaveTextContent('未连接');
  expect(screen.getByTestId('settings-models')).toBeDisabled();
  expect(screen.getByTestId('settings-appearance')).toBeEnabled();
});

test('settings.B3 空目录为零但入口可用，关于你不伪造旧电脑内容', async () => {
  await render(<Stories.B3 />); await tick();
  for (const id of ['skills', 'connectors', 'about-you']) {
    expect(screen.getByTestId(`settings-${id}`)).toHaveTextContent(/0/);
    expect(screen.getByTestId(`settings-${id}`)).toBeEnabled();
  }
});

test('settings.B2 T8 外部资源变化更新各摘要，成功数据替换失败项', async () => {
  const peer = settingsScenario('B2');
  await render(<Stories.B2 scenario={peer} />); await tick();
  expect(screen.getByTestId('settings-skills')).toHaveTextContent(/1 个失败/);
  expect(screen.getByTestId('settings-connectors')).toHaveTextContent(/1 个失败/);
  peer.changeResources(); await tick();
  expect(within(screen.getByTestId('settings-skills')).getByText('1')).toBeOnTheScreen();
  expect(within(screen.getByTestId('settings-connectors')).getByText('0')).toBeOnTheScreen();
  expect(screen.getByTestId('settings-about-you')).toHaveTextContent(/1 条/);
});

test('settings.C5 首次版本读取保留已存地址，失败后台恢复后补齐版本', async () => {
  const peer = settingsScenario('C5');
  await render(<Stories.C5 scenario={peer} />); await tick();
  expect(screen.getByTestId('connection-address')).toHaveTextContent(/192\.168\.1\.20/);
  await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  peer.recover(); await tick(1200);
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.2\.0/);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('settings.C6 T3 切换电脑忽略旧版本迟到响应，当前详情不串身份', async () => {
  const peer = settingsScenario('C1');
  await render(<Stories.C1 scenario={peer} />); await tick();
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.2\.0/);
  peer.holdConnection(); peer.refresh(); await tick(1200);
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.3\.0/);
  peer.releaseReads(); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.3\.0/);
});

test('settings.D1 T7 本地切换未保存前防重且保留当前电脑，完成后才换身份', async () => {
  const peer = settingsScenario('D1');
  await render(<Stories.D1 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
  expect(screen.getByTestId('connection-computer-settings-mini')).toBeDisabled();
  expect(screen.getByTestId('connection-add')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('gateway-back')); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('MacBook Pro');
  peer.releaseStorage(); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('Mac mini · 书房');
});

test('settings.D2 本地切换失败保留原电脑，主动再试可成功', async () => {
  const peer = settingsScenario('D2');
  await render(<Stories.D2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
  expect(screen.getByText('切换服务器失败，请重试。')).toBeOnTheScreen();
  peer.failStorage(false);
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.queryByText('切换服务器失败，请重试。')).toBeNull();
});

test('settings.D2 S2 切换失败是本页操作结果：横幅内 × 关闭，不改变当前服务器', async () => {
  const peer = settingsScenario('D2');
  await render(<Stories.D2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByText('切换服务器失败，请重试。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '关闭提示' })); await tick();
  expect(screen.queryByText('切换服务器失败，请重试。')).toBeNull();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
});

test('settings.A9 S2 首页切换失败横幅内 × 关闭；连接横幅不可关闭', async () => {
  const peer = settingsScenario('A1');
  await render(<Stories.A1 scenario={peer} />); await tick();
  peer.failStorage();
  await fireEvent.press(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })); await tick();
  expect(screen.getByText('切换服务器失败，请重试。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('settings-message-dismiss')); await tick();
  expect(screen.queryByText('切换服务器失败，请重试。')).toBeNull();
  peer.disconnect(); await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  expect(screen.queryByTestId('settings-message-dismiss')).toBeNull();
});

test('settings.A9 S2 首页切换失败属于本次访问：进入子页再返回即撤销', async () => {
  const peer = settingsScenario('A1');
  await render(<Stories.Journey scenario={peer} />); await tick();
  peer.failStorage();
  await fireEvent.press(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })); await tick();
  expect(screen.getByText('切换服务器失败，请重试。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('settings-appearance')); await tick();
  await act(() => router.back()); await tick();
  expect(screen.queryByText('切换服务器失败，请重试。')).toBeNull();
});

test('settings.A9 S2 N1 切换持久化在途时进入子页，之后失败：返回首页不显示旧访问的失败，忙态已结束', async () => {
  const peer = settingsScenario('A1');
  await render(<Stories.Journey scenario={peer} />); await tick();
  peer.holdStorage(); peer.failStorage();
  await fireEvent.press(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })); await tick();
  await fireEvent.press(screen.getByTestId('settings-appearance')); await tick();
  peer.releaseStorage(); await tick();
  await act(() => router.back()); await tick();
  expect(screen.queryByText('切换服务器失败，请重试。')).toBeNull();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('MacBook Pro');
  peer.failStorage(false);
  await fireEvent.press(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('Mac mini · 书房');
});

test('settings.D2 S2 服务器与连接页切换失败属于本次访问：push 离开再返回即撤销', async () => {
  const peer = settingsScenario('D2');
  await render(<Stories.D2 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByText('切换服务器失败，请重试。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connection-add')); await tick();
  await act(() => router.back()); await tick();
  expect(screen.queryByText('切换服务器失败，请重试。')).toBeNull();
});

test('settings.D7 T7 push 离开服务器与连接页再返回，提醒不复活', async () => {
  const peer = settingsScenario('D7');
  await render(<Stories.Journey scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('settings-connection')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(screen.getByTestId('disconnect-notice')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connection-add')); await tick();
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
});

test('settings.D7 T7 离开前发起的远端撤销在离开后才失败，返回后不发布', async () => {
  const peer = settingsScenario('D7');
  const revoke = Promise.withResolvers<void>();
  peer.peers[0].overrides['DELETE /devices/current'] = async () => { await revoke.promise; return unavailable(); };
  await render(<Stories.Journey scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('settings-connection')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
  await fireEvent.press(screen.getByTestId('connection-add')); await tick();
  await act(async () => { revoke.resolve(); }); await tick();
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.queryByTestId('disconnect-notice')).toBeNull();
});

test('settings.D4 D5 T5 备注按 Unicode 字符校验，取消不改名，空白保存恢复原名', async () => {
  await render(<Stories.D4 />); await tick();
  await fireEvent.press(screen.getByTestId('connection-rename')); await tick();
  await fireEvent.changeText(screen.getByTestId('connection-local-name'), '😀'.repeat(65));
  await fireEvent.press(screen.getByTestId('connection-rename-confirm')); await tick();
  expect(screen.getByTestId('connection-local-name')).toHaveDisplayValue('😀'.repeat(65));
  expect(screen.getByTestId('connection-action-error')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connection-cancel')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
  await fireEvent.press(screen.getByTestId('connection-rename')); await tick();
  await fireEvent.changeText(screen.getByTestId('connection-local-name'), '😀'.repeat(64));
  await fireEvent.press(screen.getByTestId('connection-rename-confirm')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('😀'.repeat(64));
  await fireEvent.press(screen.getByTestId('connection-rename')); await tick();
  await fireEvent.changeText(screen.getByTestId('connection-local-name'), '   ');
  await fireEvent.press(screen.getByTestId('connection-rename-confirm')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
});

test('settings.D6 T6 取消与本地移除失败不丢电脑，失败保留弹层可重试', async () => {
  const peer = settingsScenario('C1');
  await render(<Stories.C1 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-cancel')); await tick();
  expect(peer.runtime.credentials.snapshot().computers.map(row => row.computerId)).toEqual(['settings-laptop', 'settings-mini']);
  peer.failStorage();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(screen.getByTestId('connection-action-error')).toBeOnTheScreen();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
  peer.failStorage(false);
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(screen.queryByTestId('connection-disconnect-confirm')).toBeNull();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
});

test('settings.D6 本地移除进行中禁止重复确认，完成后旧电脑从列表消失', async () => {
  const peer = settingsScenario('D6');
  await render(<Stories.D6 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(screen.getByTestId('connection-disconnect-confirm')).toBeDisabled();
  expect(screen.getByTestId('connection-cancel')).toBeDisabled();
  peer.releaseStorage(); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.queryByTestId('connection-computer-settings-laptop')).toBeNull();
});

test('settings.C7 C8 D3 其他服务器中的失效项进入它的详情，不切换当前身份，再从详情进入配对', async () => {
  const peer = settingsScenario('C7');
  await render(<Stories.C7 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-computer-settings-mini')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.getByTestId('connection-status')).toHaveTextContent('需要重新配对');
  expect(peer.runtime.credentials.snapshot().config?.computerId).toBe('settings-laptop');
  await fireEvent.press(screen.getByTestId('connection-repair')); await tick();
  expect(screen.getByTestId('settings-destination-back')).toBeOnTheScreen();
  expect(peer.runtime.credentials.snapshot().config?.computerId).toBe('settings-laptop');
  await fireEvent.press(screen.getByTestId('settings-destination-back')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  await fireEvent.press(screen.getByTestId('gateway-back')); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
});

test('settings.A11 C8 D6 首页非当前失效名片进入详情，只用已存信息，可删除这一台且不切换当前服务器', async () => {
  const peer = settingsScenario('A11');
  await render(<Stories.A11 scenario={peer} />); await tick();
  // Reanimated's Jest boundary does not move the carousel viewport; swiping is covered on device.
  await fireEvent.press(screen.getByTestId('settings-server-open-settings-mini', { includeHiddenElements: true })); await tick();
  expect(screen.getByTestId('connection-name')).toHaveTextContent('Mac mini · 书房');
  expect(screen.getByTestId('connection-status')).toHaveTextContent('需要重新配对');
  expect(screen.getByTestId('connection-address')).toHaveTextContent(/192\.168\.1\.31/);
  // Stored version, not the current server's live /connection details (laptop reports 0.2.0, mini's peer 0.3.0).
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.2\.0/);
  expect(screen.getByTestId('connection-method')).toHaveTextContent('手动输入');
  expect(screen.queryByTestId('connection-add')).toBeNull();
  expect(screen.queryByTestId('connection-computer-settings-laptop')).toBeNull();
  expect(screen.getByTestId('connection-repair')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  expect(screen.getByText('断开Mac mini · 书房？')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(JSON.parse(peer.stored!).computers.map((row: { computerId: string }) => row.computerId)).toEqual(['settings-laptop']);
  expect(peer.runtime.credentials.snapshot().config?.computerId).toBe('settings-laptop');
  // The removed server derives back to the current server's management page; no late navigation.
  expect(screen.getByTestId('connection-name')).toHaveTextContent('MacBook Pro');
  expect(screen.getByTestId('connection-add')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('gateway-back')); await tick();
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('MacBook Pro');
});

test('settings.A11 非当前的有效服务器名片仍不可点进详情，只能“使用这台”', async () => {
  await render(<Stories.A1 />); await tick();
  expect(screen.queryByTestId('settings-server-open-settings-mini', { includeHiddenElements: true })).toBeNull();
  expect(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })).toBeOnTheScreen();
});

test('settings.C6 T2 详情刷新失败保留原版本，读成功后替换而非把在线当成功', async () => {
  const peer = settingsScenario('C1');
  await render(<Stories.C1 scenario={peer} />); await tick();
  peer.failReads(); peer.refresh(); await tick(1200);
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.2\.0/);
  await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  peer.peers[0].state.connection.gateway_version = '0.4.0';
  peer.recover(); await tick(1200);
  expect(screen.getByTestId('connection-gateway-version')).toHaveTextContent(/0\.4\.0/);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('settings.T7 页面卸载停止后台重试，不继续发送读取请求', async () => {
  const peer = settingsScenario('A6');
  const view = await render(<Stories.A6 scenario={peer} />); await tick();
  await tick(3000);
  expect(screen.getByText('无法加载设置，正在重试…')).toBeOnTheScreen();
  await view.unmount(); await tick(0);
  const count = peer.requestCount;
  await tick(20_000);
  expect(peer.requestCount).toBe(count);
});

test('settings.B4 从外观返回时摘要使用已保存的语言和主题，而非进入时的旧值', async () => {
  const read = jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(null);
  await act(async () => { await appearance.restore(); });
  const previous = appearance.snapshot();
  try {
    await render(<Stories.B4 />); await tick();
    await fireEvent.press(screen.getByTestId('settings-appearance')); await tick();
    await act(async () => { await appearance.update({ theme: 'dark', language: 'en' }); });
    await fireEvent.press(screen.getByTestId('settings-destination-back')); await tick();
    expect(screen.getByTestId('settings-appearance')).toHaveTextContent(/Dark · English/);
    expect(screen.getByTestId('settings-models')).toBeEnabled();
  } finally {
    await act(async () => { await appearance.update({ theme: previous.theme, language: previous.language }); });
    read.mockRestore();
  }
});

test('settings.C3 D6 最后一台本地移除后不保留旧信息卡，添加入口仍可用', async () => {
  const peer = settingsScenario('C3');
  await render(<Stories.C3 scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect')); await tick();
  await fireEvent.press(screen.getByTestId('connection-disconnect-confirm')); await tick();
  expect(peer.runtime.credentials.snapshot().computers).toEqual([]);
  expect(screen.queryByTestId('connection-current')).toBeNull();
  expect(screen.getByTestId('connection-add')).toBeEnabled();
});

test('settings.A9 S1 S2 首页使用这台才持久切换，失败保持原服务器并可重试', async () => {
  const peer = settingsScenario('A1');
  await render(<Stories.A1 scenario={peer} />); await tick();
  expect(peer.runtime.credentials.snapshot().config?.computerId).toBe('settings-laptop');
  // Reanimated's Jest boundary does not animate the native viewport. Exercise the
  // inactive card's explicit command here; visibility/swiping is covered on device.
  peer.failStorage();
  await fireEvent.press(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })); await tick();
  expect(peer.runtime.credentials.snapshot().config?.computerId).toBe('settings-laptop');
  expect(screen.getByText('切换服务器失败，请重试。')).toBeOnTheScreen();
  peer.failStorage(false);
  await fireEvent.press(screen.getByTestId('settings-server-use-settings-mini', { includeHiddenElements: true })); await tick();
  expect(peer.runtime.credentials.snapshot().config?.computerId).toBe('settings-mini');
  expect(screen.getByTestId('settings-computer-name')).toHaveTextContent('Mac mini · 书房');
});

test('settings.B1 A7 历史受限额度不能在当前登录暂不可检查时继续制造业务红点', async () => {
  const peer = settingsScenario('B1');
  await render(<Stories.B1 scenario={peer} />); await tick();
  const attention = () => within(screen.getByTestId('settings-models')).queryByLabelText('需要处理');
  expect(attention()).toBeOnTheScreen();
  const subscription = peer.peers[0].state.subscription!;
  subscription.auth = { ...subscription.auth, status: 'temporarily_unavailable', checked_at: subscription.auth.checked_at + 1 };
  await act(() => peer.refresh()); await tick(1500);
  expect(attention()).toBeNull();
  subscription.auth = { ...subscription.auth, status: 'ready', checked_at: subscription.auth.checked_at + 1 };
  await act(() => peer.refresh()); await tick(1500);
  expect(attention()).toBeOnTheScreen();
  await act(() => { peer.failReads(); peer.refresh(); }); await tick(1500);
  expect(attention()).toBeNull();
  await tick(3000);
  expect(screen.getByRole('alert')).toBeOnTheScreen();
});

test('settings 真实抽屉服务器入口读取当前会话的资源，而不是回到设置首页', async () => {
  const peer = settingsScenario('A1');
  peer.peers[0].state.computer!.cpu_percent = 61;
  await render(<Stories.Journey scenario={peer} />); await tick();
  await fireEvent.press(screen.getByTestId('settings-back')); await tick();
  await fireEvent.press(screen.getByTestId('chat-open-drawer')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '服务器' })); await tick();
  expect(screen.getByRole('progressbar', { name: 'CPU', value: { now: 61 } })).toBeOnTheScreen();
  expect(screen.queryByTestId('settings-models')).toBeNull();
});
