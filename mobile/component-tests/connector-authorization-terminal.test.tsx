import { act, fireEvent, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';
import ConnectorDetail from '../src/app/connectors/[id]';
import { FakeGateway } from '../src/dev/fake-gateway';
import type { Connector } from '../src/gateway/api';
import { renderGateway, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));

const missingMaterials = '授权链接或短码仅在发起设备显示，请重新发起授权';
const oldCode = 'ABCD-EFGH';
const copyAction = '复制短码并打开 GitHub';
const reopenAction = '重新打开授权链接';
const browserError = '无法打开系统浏览器，请重新打开授权链接';
const clipboardError = '无法复制短码或打开授权页，请重试此步骤';
const row = (appId: string | null = 'github'): Connector => ({
  id: 'docs', name: '资料检索', description: '', url: 'https://docs.example.invalid/mcp',
  transport: 'streamable-http', auth_type: 'oauth', app_id: appId,
  auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected',
  error: null, tool_count: 2, used_by: [], pending_restart: false,
});
const authorized: Connector['auth'] = { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['read'] };
const unauthorized: Connector['auth'] = { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] };
const terminalCases: { name: string; appId: string | null; auth: Connector['auth']; message?: string; priorGrant?: boolean }[] = [
  { name: 'GitHub 成功', appId: 'github', auth: authorized },
  { name: 'GitHub 取消且尚无凭据', appId: 'github', auth: unauthorized },
  { name: 'GitHub 取消且保留已有凭据', appId: 'github', auth: authorized, priorGrant: true },
  { name: 'GitHub 过期', appId: 'github', auth: { ...unauthorized, error: { code: 'oauth_expired', message: 'GitHub 授权码已过期' } }, message: '本次授权已过期，请重新发起授权。' },
  { name: 'GitHub 拒绝', appId: 'github', auth: { ...unauthorized, error: { code: 'oauth_denied', message: '未同意授权' } }, message: '未同意服务方授权，请重新发起。' },
  { name: 'GitHub 服务失败', appId: 'github', auth: { ...unauthorized, error: { code: 'oauth_unavailable', message: 'GitHub 授权服务暂时不可用' } }, message: 'OAuth 服务暂不可用，请稍后重试。' },
  { name: 'OAuth 成功', appId: null, auth: authorized },
  // Generic OAuth removes its pending transaction without publishing a device-flow error.
  { name: 'OAuth 取消、到期或兑换失败的无材料终态', appId: null, auth: unauthorized },
];

let peer: FakeGateway;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  peer = new FakeGateway({ connectors: [row()] });
  jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  jest.spyOn(WebBrowser, 'openAuthSessionAsync').mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL });
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

const openDetail = () => renderGateway(peer, ConnectorDetail, '/connectors/[id]', { '/connectors/[id]': ConnectorDetail }, '/connectors/docs');
async function publishAuth(auth: Connector['auth']) {
  await act(() => {
    peer.state.connectors[0].auth = { ...auth };
    peer.state.connectors[0].status = auth.status === 'authorized' ? 'connected' : 'disconnected';
    peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs', op: 'status' }));
  });
  await tick();
}
async function externalStart(previous: Connector['auth']) {
  // A different device changes gateway facts, but cannot replace this device's local command owner.
  await publishAuth({ ...previous, authorizing: true, transaction_id: 'other-device-transaction', error: null });
}
function expectNoOldMaterials() {
  expect(screen.queryByText(oldCode)).toBeNull();
  expect(screen.queryByRole('button', { name: copyAction })).toBeNull();
  expect(screen.queryByRole('button', { name: reopenAction })).toBeNull();
  expect(screen.queryByLabelText('完整回调网址')).toBeNull();
  expect(screen.getByText(missingMaterials)).toBeOnTheScreen();
}

test.each(terminalCases)('connector-auth.F1 $name 后其他设备新事务不能复活或操作旧材料，start 前旧快照不能提前清材料', async ({ appId, auth, message, priorGrant }) => {
  peer.state.connectors = [row(appId)];
  if (priorGrant) {
    peer.state.connectors[0].auth = { ...authorized };
    peer.state.connectors[0].status = 'connected';
  }
  const reads = Promise.withResolvers<void>();
  let holdReads = false;
  let startReturned = false;
  let heldReads = 0;
  peer.overrides['GET /connectors/:id'] = async (_context, respond) => {
    if (holdReads) { heldReads++; await reads.promise; }
    return respond();
  };
  peer.overrides['POST /connectors/:id/oauth/start'] = async (_context, respond) => {
    holdReads = true;
    const response = await respond();
    startReturned = true;
    return response;
  };
  await openDetail();
  await fireEvent.press(priorGrant ? screen.getByRole('button', { name: '重新授权' }) : screen.getByTestId('oauth-start'));
  await tick();
  expect(startReturned).toBe(true);
  expect(heldReads).toBeGreaterThan(0);
  // The start receipt is not yet usable: the cached pre-start false snapshot
  // cannot authorize native actions, and the post-start GET is still in flight.
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  holdReads = false;
  await act(() => reads.resolve());
  await tick();
  if (appId === 'github') expect(Clipboard.setStringAsync).toHaveBeenCalledWith(oldCode);
  else expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  if (appId === 'github') expect(screen.getByText(oldCode)).toBeOnTheScreen();
  else {
    expect(screen.getByRole('button', { name: reopenAction })).toBeEnabled();
    await fireEvent.changeText(screen.getByLabelText('完整回调网址'), 'http://127.0.0.1:18815/oauth/callback?code=old&state=old');
  }

  await publishAuth(auth);
  expect(screen.queryByText(oldCode)).toBeNull();
  expect(screen.queryByRole('button', { name: appId === 'github' ? copyAction : reopenAction })).toBeNull();
  if (message) expect(screen.getByText(message)).toBeOnTheScreen();
  else if (auth.status === 'authorized') expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  else expect(screen.getByTestId('oauth-start')).toBeEnabled();

  await externalStart(auth);
  const staleAction = screen.queryByRole('button', { name: appId === 'github' ? copyAction : reopenAction });
  if (staleAction) { await fireEvent.press(staleAction); await tick(); }
  // Exercise an accidentally exposed stale control, not just its rendered label.
  if (appId === 'github') {
    expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
  } else expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  expectNoOldMaterials();
});

test.each(['完成', '失败'] as const)('connector-auth.F1 已观察网关终态后旧剪贴板%s，不能给其他设备的新事务打开旧码或写入旧提示', async result => {
  const copy = Promise.withResolvers<boolean>();
  jest.mocked(Clipboard.setStringAsync).mockReturnValueOnce(copy.promise);
  await openDetail();
  await fireEvent.press(screen.getByTestId('oauth-start'));
  await tick();
  expect(screen.getByText(oldCode)).toBeOnTheScreen();
  expect(Linking.openURL).not.toHaveBeenCalled();
  await publishAuth(authorized);
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  expect(screen.queryByText(oldCode)).toBeNull();
  await externalStart(authorized);

  await act(() => { if (result === '完成') copy.resolve(true); else copy.reject(new Error('late clipboard result')); });
  await tick();
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(screen.queryByText('已复制验证码')).toBeNull();
  expect(screen.queryByText(clipboardError)).toBeNull();
  expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1);
  expectNoOldMaterials();
});

test.each(['成功回跳', '失败'] as const)('connector-auth.F1 已观察网关终态后旧 native 会话%s，不能污染终态或恢复其他设备的新事务链接', async result => {
  peer.state.connectors = [row(null)];
  const browser = Promise.withResolvers<WebBrowser.WebBrowserAuthSessionResult>();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(browser.promise);
  await openDetail();
  await fireEvent.press(screen.getByTestId('oauth-start'));
  await tick();
  expect(screen.getByRole('button', { name: reopenAction })).toBeEnabled();
  await publishAuth(authorized);
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: reopenAction })).toBeNull();

  await act(() => {
    if (result === '成功回跳') browser.resolve({ type: 'success', url: 'wandrun://oauth/done?result=ok' });
    else browser.reject(new Error('late native result'));
  });
  await tick();
  expect(screen.queryByText(browserError)).toBeNull();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  await externalStart(authorized);
  const staleAction = screen.queryByRole('button', { name: reopenAction });
  if (staleAction) { await fireEvent.press(staleAction); await tick(); }
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  expectNoOldMaterials();
});

test.each(['github', null])('connector-auth.F1 %s start 回执迟到于终态和另一设备新事务，不得打开旧材料', async appId => {
  peer.state.connectors = [row(appId)];
  const release = Promise.withResolvers<void>();
  peer.overrides['POST /connectors/:id/oauth/start'] = async (_context, respond) => {
    const response = await respond();
    await release.promise;
    return response;
  };
  await openDetail();
  await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  await publishAuth(authorized);
  await externalStart(authorized);
  await act(() => release.resolve()); await tick();
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  expectNoOldMaterials();
});
