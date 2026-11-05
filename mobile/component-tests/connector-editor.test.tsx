import { act, fireEvent, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { AppState, Linking, type AppStateStatus } from 'react-native';
import SettingsConnectors from '../src/app/settings-connectors';
import AddConnector from '../src/app/connectors/add';
import AddRemoteConnector from '../src/app/connectors/add-remote';
import AddLocalConnector from '../src/app/connectors/add-local';
import ConnectorDetail from '../src/app/connectors/[id]';
import CatalogConnector from '../src/app/connectors/catalog/[id]';
import AgentEditor from '../src/app/agent-editor';
import { FakeGateway, jsonResponse, unavailable } from '../src/dev/fake-gateway';
import type { Connector } from '../src/gateway/api';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';
jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const routes = { '/settings-connectors': SettingsConnectors, '/connectors/add': AddConnector, '/connectors/add-remote': AddRemoteConnector,
  '/connectors/add-local': AddLocalConnector, '/connectors/[id]': ConnectorDetail, '/connectors/catalog/[id]': CatalogConnector, '/agent-editor': AgentEditor };
const row = (changes: Partial<Connector> = {}): Connector => ({ id: 'docs', name: '资料检索', description: '检索项目资料', url: 'https://docs.example.invalid/mcp', transport: 'streamable-http',
  auth_type: 'none', app_id: null, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null, tool_count: 2, used_by: [], pending_restart: false, ...changes });
let peer: FakeGateway;
beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); peer = new FakeGateway({ connectors: [row()], connectorTools: new Map([['docs', [{ name: 'search', title: '搜索资料', description: '检索来源' }]]]) });
  jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true); jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  jest.spyOn(WebBrowser, 'openAuthSessionAsync').mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL });
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
const openRemote = () => renderGateway(peer, AddRemoteConnector, '/connectors/add-remote', routes);
const openDetail = () => renderGateway(peer, ConnectorDetail, '/connectors/[id]', routes, '/connectors/docs');

test.each(['none', 'key'] as const)('connector-add.N2 N9 %s 一次提交认证，名称说明不在添加页', async auth => {
  let body: Record<string, unknown> = {};
  peer.overrides['POST /connectors'] = ({ body: value }) => { body = value as Record<string, unknown>; };
  await openRemote();
  expect(screen.queryByLabelText('连接器名称')).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://notes.example.invalid/mcp');
  if (auth === 'key') { await fireEvent.press(screen.getByRole('radio', { name: '密钥' })); await fireEvent.changeText(screen.getByLabelText('请求头 1 值'), 'Bearer secret'); }
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(body.auth_type).toBe(auth); expect(body.name).toBeUndefined(); expect(body.description).toBeUndefined();
  if (auth === 'key') expect(body.headers).toEqual({ Authorization: 'Bearer secret' });
  expect(screen.getByText('notes.example.invalid')).toBeOnTheScreen();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
});
test('connector-add.N3 本地命令拆分引号空参数，环境变量一次提交且无认证选择', async () => {
  let submitted: unknown;
  peer.overrides['POST /connectors'] = ({ body }) => { submitted = body; };
  await renderGateway(peer, AddLocalConnector, '/connectors/add-local', routes);
  expect(screen.queryByText('认证方式')).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('命令（含参数）'), `npx -y 'with space' ""`);
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(submitted).toMatchObject({ command: 'npx', args: ['-y', 'with space', ''] });
});
test.each([
  ['authentication_mismatch', 409],
  ['oauth_dcr_unsupported', 409],
  ['unsupported_oauth', 409],
  ['connection_failed', 502],
] as const)('connector-add.N5 N6 N8 %s 留页修改与重试，不误判未知', async (code, status) => {
  let writes = 0;
  peer.overrides['POST /connectors'] = () => { writes++; return jsonResponse({ error: { code, message: 'private raw response', details: { probe: { result: 'oauth', transport: 'streamable-http' } } } }, status); };
  await openRemote(); await fireEvent.changeText(screen.getByLabelText('网址'), 'https://notes.example.invalid/mcp');
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(screen.getByRole('alert')).toBeOnTheScreen(); expect(screen.queryByText(/保存结果未确认/)).toBeNull();
  expect(screen.getByLabelText('网址')).toBeEnabled();
  if (code === 'authentication_mismatch') { await fireEvent.press(screen.getByRole('button', { name: '切换为OAuth' })); expect(screen.getByRole('radio', { name: 'OAuth', selected: true })).toBeOnTheScreen(); }
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://fixed.example.invalid/mcp');
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick(); expect(writes).toBe(2);
});
test('connector-add.N4 NT2 预探测建议不能覆盖用户手选，旧网址探测无效', async () => {
  const gate = Promise.withResolvers<Response>();
  peer.overrides['POST /connectors/probe'] = () => gate.promise;
  await openRemote(); await fireEvent.changeText(screen.getByLabelText('网址'), 'https://first.example.invalid');
  await fireEvent(screen.getByLabelText('网址'), 'blur');
  await fireEvent.press(screen.getByRole('radio', { name: '密钥' }));
  await act(() => gate.resolve(jsonResponse({ result: 'oauth', transport: 'streamable-http', oauth: { dcr_supported: true, pkce_supported: true, issuer: 'https://auth.invalid' } }))); await tick();
  expect(screen.getByRole('radio', { name: '密钥', selected: true })).toBeOnTheScreen();
});
test('connector-detail.D2 D4 D5 DT2 工具与 Agent 只读，资料仅 PATCH 改动字段', async () => {
  const agent = seedGatewayAgent(peer, { mcp_servers: ['docs'] }); let patch: unknown;
  peer.overrides['PATCH /connectors/:id'] = ({ body }) => { patch = body; };
  await openDetail(); expect(screen.getByText('搜索资料')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '已连接的 Agent' })); await tick();
  expect(screen.getByText(agent.name)).toBeOnTheScreen(); expect(screen.queryByRole('checkbox')).toBeNull();
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '编辑' })); await tick();
  await fireEvent.changeText(screen.getByLabelText('连接器名称'), '重命名资料');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(patch).toEqual({ name: '重命名资料' }); expect(screen.getByText('重命名资料')).toBeOnTheScreen();
});
test('connector-detail.D7 D8 D9 级联删除确认列头像名称数量，删除后 Agent 引用移除', async () => {
  seedGatewayAgent(peer, { mcp_servers: ['docs'] }); let deletes = 0;
  peer.overrides['DELETE /connectors/:id'] = () => { deletes++; };
  await openDetail(); await fireEvent.press(screen.getByRole('button', { name: '删除连接器' })); await tick();
  expect(screen.getByText('将同时从这 1 个 Agent 中移除')).toBeOnTheScreen(); expect(screen.getByText('研究员')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '删除' })); await tick();
  expect(deletes).toBe(1); expect(peer.state.agentDetails.get('research')?.mcp_servers).toEqual([]);
  await act(() => router.push({ pathname: '/agent-editor', params: { id: 'research' } })); await tick();
  expect(screen.getByLabelText('名字')).toHaveDisplayValue('研究员');
});
test('connector-detail.D7 影响读取失败不会打开误导性的零引用确认', async () => {
  peer.overrides['GET /connectors/:id/agents'] = () => unavailable();
  await openDetail(); await fireEvent.press(screen.getByRole('button', { name: '删除连接器' })); await tick();
  expect(screen.queryByText('删除 资料检索？')).toBeNull();
  expect(screen.getByText('无法检查删除条件，请检查网关连接后重试。')).toBeOnTheScreen();
});
test('connector-auth.AU3 AU4 OAuth 使用系统授权会话，返回后只相信 GET 结果', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  const gate = Promise.withResolvers<WebBrowser.WebBrowserAuthSessionResult>(); let startBody: unknown;
  jest.mocked(WebBrowser.openAuthSessionAsync).mockReturnValue(gate.promise);
  peer.overrides['POST /connectors/:id/oauth/start'] = ({ body }) => { startBody = body; };
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  expect(startBody).toEqual({ return_url: 'wandrun://oauth/done' });
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(expect.stringContaining('authorize'), 'wandrun://oauth/done');
  expect(screen.getByLabelText('完整回调网址')).toBeOnTheScreen();
  peer.state.connectors[0].auth = { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['read'] }; peer.state.connectors[0].status = 'connected';
  await act(() => gate.resolve({ type: 'success', url: 'wandrun://oauth/done?result=ok' })); await tick();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen(); expect(screen.queryByText('正在浏览器中授权…')).toBeNull();
});
test.each(['成功回跳', '取消', '未回跳并回前台'] as const)('connector-auth.AT3 AT4 AT5 %s 后可在同一访问再次授权，新事务不被旧会话吞掉', async previous => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener); } }; });
  peer.state.connectors = [row({ auth_type: 'oauth', auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['read'] } })];
  const first = Promise.withResolvers<WebBrowser.WebBrowserAuthSessionResult>();
  const second = Promise.withResolvers<WebBrowser.WebBrowserAuthSessionResult>();
  jest.mocked(WebBrowser.openAuthSessionAsync).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  let starts = 0;
  const authorizationUrl = (attempt: number) => `https://authorize.example.invalid/authorize?attempt=${attempt}`;
  peer.overrides['POST /connectors/:id/oauth/start'] = async (_context, respond) => {
    const response = await respond();
    return jsonResponse({ ...await response.json(), authorization_url: authorizationUrl(++starts) });
  };
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '重新授权' })); await tick();
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenNthCalledWith(1, authorizationUrl(1), 'wandrun://oauth/done');
  if (previous === '未回跳并回前台') {
    peer.state.connectors[0].auth = { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['read'] };
    await act(() => { for (const listener of listeners) listener('background'); });
    await act(() => { for (const listener of listeners) listener('active'); }); await tick();
  } else {
    if (previous === '成功回跳') peer.state.connectors[0].auth = { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['read'] };
    await act(() => first.resolve(previous === '成功回跳'
      ? { type: 'success', url: 'wandrun://oauth/done?result=ok' } : { type: WebBrowser.WebBrowserResultType.CANCEL })); await tick();
  }
  expect(screen.getByRole('button', { name: '重新授权' })).toBeEnabled();
  if (previous === '取消') {
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除连接器' })).toBeDisabled();
  }
  await fireEvent.press(screen.getByRole('button', { name: '重新授权' })); await tick();
  expect(starts).toBe(2);
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenNthCalledWith(2, authorizationUrl(2), 'wandrun://oauth/done');
  expect(screen.getByText('正在浏览器中授权…')).toBeOnTheScreen();
  if (previous === '未回跳并回前台') { await act(() => first.resolve({ type: WebBrowser.WebBrowserResultType.CANCEL })); await tick(); }
  await act(() => second.resolve({ type: WebBrowser.WebBrowserResultType.CANCEL })); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '重新打开授权链接' })); await tick();
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenLastCalledWith(authorizationUrl(2), 'wandrun://oauth/done');
  expect(screen.queryByText('无法打开系统浏览器，请重新打开授权链接')).toBeNull();
});
test('connector-auth.AU7 正式部署不显示粘贴回调；会话关闭不冒充授权成功', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  peer.overrides['POST /connectors/:id/oauth/start'] = (_context, respond) => respond().then(async response => jsonResponse({ ...await response.json(), manual_callback: false }));
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  expect(screen.queryByLabelText('完整回调网址')).toBeNull(); expect(screen.getByText('正在浏览器中授权…')).toBeOnTheScreen();
  expect(screen.queryByText('已连接 · 2 个工具')).toBeNull();
});
test('connector-auth.AU5 GitHub 复制短码并打开为一次动作，网关终态自动展示', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'github', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('ABCD-EFGH'); expect(Linking.openURL).toHaveBeenCalledTimes(1);
  expect(screen.getByText('ABCD-EFGH')).toBeOnTheScreen();
  await act(() => { peer.state.connectors[0].auth = { status: 'authorized', authorizing: false, transaction_id: null, scopes: ['repo'] }; peer.state.connectors[0].status = 'connected'; peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs', op: 'status' })); }); await tick();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen(); expect(screen.queryByText('ABCD-EFGH')).toBeNull();
});
test('connector-auth.AU4 未返回会话时前台恢复刷新，不重放 start', async () => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener); } }; });
  peer.state.connectors = [row({ auth_type: 'oauth', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  const gate = Promise.withResolvers<WebBrowser.WebBrowserAuthSessionResult>(); jest.mocked(WebBrowser.openAuthSessionAsync).mockReturnValue(gate.promise);
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  peer.state.connectors[0].auth = { status: 'authorized', authorizing: false, transaction_id: null, scopes: [] }; peer.state.connectors[0].status = 'connected';
  await act(() => { for (const listener of listeners) listener('background'); });
  await act(() => { for (const listener of listeners) listener('active'); }); await tick();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen(); expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  await act(() => gate.resolve({ type: WebBrowser.WebBrowserResultType.CANCEL })); await tick();
});
test('connector-add.N10 N11 创建未知离开确认不保留草稿，恢复不重放', async () => {
  let writes = 0; let recover = false;
  peer.overrides['POST /connectors'] = async (_context, respond) => { writes++; await respond(); return unavailable(); };
  peer.overrides['GET /connectors/:id'] = () => recover ? undefined : unavailable();
  await openRemote(); await fireEvent.changeText(screen.getByLabelText('网址'), 'https://uncertain.example.invalid');
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  await tick(3000);
  expect(screen.getByText('保存结果未确认，恢复连接后自动核对')).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
  expect(screen.getByText('保存结果未确认，离开后本次草稿不会保留。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '继续编辑' })); await tick();
  recover = true; await tick(1000); expect(writes).toBe(1);
});
test('connector-detail.D11 密钥断开保留引用，重新填入后可连接', async () => {
  peer.state.connectors = [row({ auth_type: 'key', headers: { Authorization: true } })];
  const agent = seedGatewayAgent(peer, { mcp_servers: ['docs'] });
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '断开连接' })); await tick();
  expect(screen.getByText('需要授权')).toBeOnTheScreen();
  expect(peer.state.agentDetails.get(agent.id)?.mcp_servers).toEqual(['docs']);
  await fireEvent.press(screen.getByRole('button', { name: '填写密钥' })); await tick();
  await fireEvent.changeText(screen.getByLabelText('请求头 1 值'), 'Bearer replacement');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  expect(peer.state.connectors[0].headers).toEqual({ Authorization: true });
});
test('connector-auth.AT5 复制尚未返回时取消授权，不再打开旧短码页', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'github', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  const copy = Promise.withResolvers<boolean>(); jest.mocked(Clipboard.setStringAsync).mockReturnValue(copy.promise);
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '取消授权' })); await tick();
  await act(() => copy.resolve(true)); await tick();
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(screen.queryByText('ABCD-EFGH')).toBeNull();
  expect(screen.getByTestId('oauth-start')).toBeEnabled();
});
test('connector-auth.AT7 GitHub 短码到期后移除重开动作，可重新发起', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'github', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  peer.overrides['POST /connectors/:id/oauth/start'] = async (_context, respond) => {
    const response = await respond(); return jsonResponse({ ...await response.json(), expires_at: Date.now() / 1000 + 5 });
  };
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  expect(screen.getByTestId('oauth-user-code')).toBeOnTheScreen();
  await tick(5000);
  expect(screen.queryByTestId('oauth-user-code')).toBeNull();
  expect(screen.queryByRole('button', { name: '复制短码并打开 GitHub' })).toBeNull();
  expect(screen.getByTestId('oauth-start')).toBeEnabled();
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
});
test('connector-auth.AT9 授权未知不报确定失败，不打开或恢复短码，读回不重发', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'github', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  let blocked = false; let writes = 0;
  peer.overrides['POST /connectors/:id/oauth/start'] = async (_context, respond) => { writes++; blocked = true; await respond(); return unavailable(); };
  peer.overrides['GET /connectors/:id'] = () => blocked ? unavailable() : undefined;
  await openDetail(); await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  await tick(3000);
  expect(screen.getByText('保存结果未确认，恢复连接后自动核对')).toBeOnTheScreen();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByTestId('oauth-start')).toBeDisabled();
  blocked = false; await tick(1000);
  expect(screen.queryByTestId('oauth-user-code')).toBeNull();
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  expect(Linking.openURL).not.toHaveBeenCalled();
  expect(writes).toBe(1);
});
test('connector-detail.DT7 其他设备删除时关闭未保存弹层，不阻塞退出或恢复旧草稿', async () => {
  await openDetail(); await fireEvent.press(screen.getByRole('button', { name: '编辑' }));
  await fireEvent.changeText(screen.getByLabelText('连接器名称'), '未保存名称');
  await act(() => { peer.state.connectors = []; peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs', op: 'deleted' })); }); await tick();
  expect(screen.getByTestId('connectors-add')).toBeOnTheScreen();
  expect(screen.queryByLabelText('连接器名称')).toBeNull();
  expect(screen.queryByText('放弃本次修改？')).toBeNull();
});
test('connector-detail.D1 首载失败展示自动重试而非无限首载，恢复后才允许初始化编辑', async () => {
  let fail = true;
  peer.overrides['GET /connectors/:id'] = () => fail ? unavailable() : undefined;
  await openDetail(); await tick(300);
  await tick(3000);
  expect(screen.getByText('无法加载连接器，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  fail = false; await tick(1000);
  expect(screen.getByRole('button', { name: '编辑' })).toBeEnabled();
  expect(screen.queryByText('无法加载连接器，正在重试…')).toBeNull();
});
test('connector-detail.D12 参数子页放弃返回详情，不退出连接器且不自动保存', async () => {
  let writes = 0; peer.overrides['PATCH /connectors/:id'] = () => { writes++; };
  await openDetail(); await fireEvent.press(screen.getByRole('button', { name: '连接参数' }));
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://unsaved.example.invalid/mcp');
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '放弃' })); await tick();
  expect(screen.getByRole('button', { name: '编辑' })).toBeOnTheScreen();
  expect(screen.queryByLabelText('网址')).toBeNull(); expect(writes).toBe(0);
});
test('connector-detail.D6 资料保存未知仍可离开确认，核对后不恢复旧弹层或重写', async () => {
  let blocked = false; let writes = 0;
  peer.overrides['PATCH /connectors/:id'] = async (_context, respond) => { writes++; blocked = true; await respond(); return unavailable(); };
  peer.overrides['GET /connectors/:id'] = () => blocked ? unavailable() : undefined;
  await openDetail(); await fireEvent.press(screen.getByRole('button', { name: '编辑' }));
  await fireEvent.changeText(screen.getByLabelText('连接器名称'), '未确认写入');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(screen.getByLabelText('连接器名称')).toHaveProp('editable', false);
  await fireEvent.press(screen.getByRole('button', { name: '离开' })); await tick();
  expect(screen.getByText('保存结果未确认，离开后本次草稿不会保留。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '继续编辑' }));
  blocked = false; await tick(1000);
  expect(screen.queryByLabelText('连接器名称')).toBeNull();
  expect(screen.getByText('未确认写入')).toBeOnTheScreen(); expect(writes).toBe(1);
});
test('connector-detail.D10 OAuth 已授权但连接失败时仅重连，不重新申请授权', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'notion', auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'failed', tool_count: 0 })];
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
});
test('connector-detail.D10 需要重新授权时不把旧连接工具或 Agent 标为可用', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'notion', auth: { status: 'reauthorization_required', authorizing: false, transaction_id: null, scopes: [] } })];
  seedGatewayAgent(peer, { mcp_servers: ['docs'] });
  await openDetail();
  expect(screen.getByText('需要授权')).toBeOnTheScreen();
  expect(screen.queryByText('搜索资料')).toBeNull();
  expect(screen.queryByRole('button', { name: '已连接的 Agent' })).toBeNull();
  expect(screen.getByTestId('oauth-start')).toBeEnabled();
});
test('connector-auth.AT1 健康详情的重新授权入口保留在详情分组，发起后仍展示等待状态', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'notion', auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: [] } })];
  await openDetail();
  expect(screen.queryByTestId('oauth-start')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '重新授权' })); await tick();
  expect(screen.getByText('正在浏览器中授权…')).toBeOnTheScreen();
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
});
test('connector-detail.D9 远端撤销失败保留连接器与引用，明确告知本地授权已清除', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'notion', auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: [] } })];
  seedGatewayAgent(peer, { mcp_servers: ['docs'] }); let deletes = 0;
  peer.overrides['DELETE /connectors/:id'] = () => {
    deletes++;
    for (const connector of peer.state.connectors) {
      connector.auth = { ...connector.auth, status: 'unauthorized' }; connector.status = 'disconnected'; connector.tool_count = 0;
    }
    peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs', op: 'updated' }));
    return jsonResponse({ error: { code: 'remote_revocation_failed', message: '本地授权已删除，但远端撤销失败；请到服务方设置断开' } }, 409);
  };
  await openDetail(); await fireEvent.press(screen.getByRole('button', { name: '删除连接器' })); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '删除' })); await tick(1000);
  expect(screen.getByText('本地授权已清除，但远端撤销失败，连接器仍保留。请到服务方设置里断开后重试删除。')).toBeOnTheScreen();
  expect(screen.queryByText(/保存结果未确认/)).toBeNull(); expect(deletes).toBe(1);
  await fireEvent.press(screen.getByRole('button', { name: '取消' })); await tick();
  expect(screen.getByText('需要授权')).toBeOnTheScreen();
  expect(peer.state.agentDetails.get('research')?.mcp_servers).toEqual(['docs']);
});
test('connector-auth.AU8 新事务到期不能被仍有效的旧授权掩盖', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', app_id: 'notion', auth: { status: 'authorized', authorizing: false, transaction_id: null, scopes: [], error: { code: 'oauth_expired', message: 'safe terminal error' } } })];
  await openDetail();
  expect(screen.getByText('本次授权已过期，请重新发起授权。')).toBeOnTheScreen();
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  expect(screen.getByTestId('oauth-start')).toBeEnabled();
});

test('自定义 OAuth 创建后先读取再显式 start，不能在创建请求中夹带授权', async () => {
  const calls: string[] = [];
  peer.overrides['POST /connectors'] = ({ body }) => { calls.push('create'); expect(body).toMatchObject({ auth_type: 'oauth' }); expect(body).not.toHaveProperty('return_url'); };
  peer.overrides['GET /connectors/:id'] = () => { calls.push('read'); };
  peer.overrides['POST /connectors/:id/oauth/start'] = ({ body }) => { calls.push('start'); expect(body).toEqual({ return_url: 'wandrun://oauth/done' }); };
  await openRemote(); await fireEvent.changeText(screen.getByLabelText('网址'), 'https://oauth.example.invalid/mcp');
  await fireEvent.press(screen.getByRole('radio', { name: 'OAuth' }));
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(calls.indexOf('create')).toBeLessThan(calls.indexOf('read'));
  expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('start'));
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(expect.stringContaining('authorize'), 'wandrun://oauth/done');
});

test.each(['notion', 'github'])('目录 %s 首次连接创建绑定后按声明一步发起对应授权', async appId => {
  peer.state.apps = [{ id: appId, name: appId === 'notion' ? 'Notion' : 'GitHub', description: '目录连接器', url: `https://${appId}.example.invalid/mcp`,
    transport: 'streamable-http', auth: { type: appId === 'github' ? 'device' : 'oauth' }, connector: null }];
  let bindings = 0; let starts = 0;
  peer.overrides['POST /apps/:id/connect'] = () => { bindings++; };
  peer.overrides['POST /connectors/:id/oauth/start'] = ({ body }) => { starts++; expect(body).toEqual({ return_url: 'wandrun://oauth/done' }); };
  await renderGateway(peer, CatalogConnector, '/connectors/catalog/[id]', routes, `/connectors/catalog/${appId}`);
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(bindings).toBe(1); expect(starts).toBe(1);
  if (appId === 'github') {
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('ABCD-EFGH');
    expect(Linking.openURL).toHaveBeenCalledTimes(1);
    expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  } else {
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  }
});

test('connector-auth.AU1 目录未绑定直接用详情布局：只展示目录字段，底部提示与连接按钮；none 目录未启用', async () => {
  peer.state.apps = [
    { id: 'github', name: 'GitHub', description: '连接 GitHub 仓库、Issue 与 Pull Request', url: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http', auth: { type: 'device' }, connector: null },
    { id: 'plain', name: 'Plain', description: '无需认证目录', url: 'https://plain.example.invalid/mcp', transport: 'streamable-http', auth: { type: 'none' }, connector: null },
  ];
  let bindings = 0;
  peer.overrides['POST /apps/:id/connect'] = () => { bindings++; };
  await renderGateway(peer, CatalogConnector, '/connectors/catalog/[id]', routes, '/connectors/catalog/github');
  expect(screen.getByText('连接器')).toBeOnTheScreen();
  expect(screen.getByText('GitHub')).toBeOnTheScreen();
  expect(screen.getByText('未连接')).toBeOnTheScreen();
  expect(screen.getByText('短码授权')).toBeOnTheScreen();
  expect(screen.getByText('连接器目录')).toBeOnTheScreen();
  expect(screen.getByText('api.githubcopilot.com')).toBeOnTheScreen();
  expect(screen.getByText('将显示一个短码，在 GitHub 网页上输入后完成授权。')).toBeOnTheScreen();
  expect(screen.queryByText('工具')).toBeNull();
  expect(screen.getByRole('button', { name: '连接' })).toBeEnabled();
  expect(bindings).toBe(0);
  await renderGateway(peer, CatalogConnector, '/connectors/catalog/[id]', routes, '/connectors/catalog/plain');
  expect(screen.getByText('目录暂未启用这种连接方式')).toBeOnTheScreen();
  expect(screen.getByText('无需认证')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled();
  expect(screen.queryByLabelText('Authorization')).toBeNull();
  expect(bindings).toBe(0);
});

const amapEntry = { id: 'amap', name: '高德地图', description: '地点搜索、路线规划、天气与地理编码', url: 'https://mcp.amap.com/mcp', transport: 'streamable-http',
  auth: { type: 'key' as const, key_url: 'https://lbs.amap.com/api/mcp-server/create-project-and-key', headers: {}, key: { in: 'query' as const, name: 'key' } }, connector: null };

test('connector-auth.AU10 key 目录：连接只建绑定，同一访问打开只有 Key 的参数页，保存即写 Key 并测试连接', async () => {
  peer.state.apps = [amapEntry];
  let bindings = 0; let starts = 0; let tests = 0; const patches: unknown[] = [];
  peer.overrides['POST /apps/:id/connect'] = () => { bindings++; };
  peer.overrides['POST /connectors/:id/oauth/start'] = () => { starts++; };
  peer.overrides['PATCH /connectors/:id'] = ({ body }) => { patches.push(body); };
  peer.overrides['POST /connectors/:id/test'] = () => { tests++; };
  await renderGateway(peer, CatalogConnector, '/connectors/catalog/[id]', routes, '/connectors/catalog/amap');
  expect(screen.getByText('密钥')).toBeOnTheScreen();
  expect(screen.getByText('连接后填写 高德地图 的 Key。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(bindings).toBe(1); expect(starts).toBe(0);
  expect(screen.getByTestId('connector-key')).toBeOnTheScreen();
  expect(screen.queryByLabelText('网址')).toBeNull();
  expect(screen.queryByText('认证方式')).toBeNull();
  expect(screen.queryByText('连接参数由目录管理')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '获取 Key' }));
  expect(Linking.openURL).toHaveBeenCalledWith('https://lbs.amap.com/api/mcp-server/create-project-and-key');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(screen.getByText('请填写密钥值')).toBeOnTheScreen();
  expect(patches).toEqual([]);
  await fireEvent.changeText(screen.getByTestId('connector-key'), 'amap-secret');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(patches).toEqual([{ headers: { key: 'amap-secret' } }]);
  expect(tests).toBe(1);
  expect(screen.getByText('已连接 · 2 个工具')).toBeOnTheScreen();
  expect(screen.queryByText('amap-secret')).toBeNull();
});

test.each([
  'Key 无效或已失效，请检查后重新填写',
  '无法连接服务，请稍后重试',
  null,
])('connector-detail.D13 测试结果 %s 保留明确原因与获取 Key 入口', async error => {
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ app_id: 'amap', auth_type: 'key', headers: { key: true } })];
  peer.overrides['POST /connectors/:id/test'] = () => jsonResponse({
    success: error === null, error, tool_count: error ? 0 : 2, pending_restart: false,
  });
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '测试连接' })); await tick();
  expect(screen.getByText(error ?? '连接成功')).toBeOnTheScreen();
  if (error) {
    await fireEvent.press(screen.getByTestId('connector-error-dismiss')); await tick();
    expect(screen.queryByText(error)).toBeNull();
  }
  await fireEvent.press(screen.getByRole('button', { name: '连接参数' })); await tick();
  expect(screen.getByRole('button', { name: '获取 Key' })).toBeOnTheScreen();
  expect(screen.getByTestId('connector-key')).toBeOnTheScreen();
});

test.each([
  'Key 无效或已失效，请检查后重新填写',
  '无法连接服务，请稍后重试',
  '连接未完成，请检查连接参数后重试',
])('connector-detail.D13 直接打开失败详情显示持续原因 %s', async error => {
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ app_id: 'amap', auth_type: 'key', headers: { key: true }, status: 'failed', error })];
  await openDetail();
  expect(screen.getByText(error)).toBeOnTheScreen();
  expect(screen.queryByTestId('connector-error-dismiss')).toBeNull();
  await act(() => {
    peer.state.connectors[0] = { ...peer.state.connectors[0], status: 'connected', error: null };
    peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs', op: 'status' }));
  }); await tick();
  expect(screen.queryByText(error)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '连接参数' })); await tick();
  expect(screen.getByRole('button', { name: '获取 Key' })).toBeOnTheScreen();
});

test.each([
  'Key 无效或已失效，请检查后重新填写',
  '无法连接服务，请稍后重试',
  '连接未完成，请检查连接参数后重试',
])('connector-detail.D13 首次保存 Key 后自动测试失败显示访问结果 %s', async error => {
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ app_id: 'amap', auth_type: 'key', headers: {}, status: 'disconnected' })];
  peer.overrides['POST /connectors/:id/test'] = () => jsonResponse({ success: false, error, tool_count: 0, pending_restart: false });
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '填写密钥' })); await tick();
  await fireEvent.changeText(screen.getByTestId('connector-key'), 'private-key');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(screen.queryByTestId('connector-key')).toBeNull();
  expect(screen.getByText(error)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connector-error-dismiss')); await tick();
  expect(screen.queryByText(error)).toBeNull();
});

test('connector-detail.D13 测试失败与持续原因相同时只显示一次，关闭横幅不清除持续失败', async () => {
  const error = 'Key 无效或已失效，请检查后重新填写';
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ app_id: 'amap', auth_type: 'key', headers: { key: true }, status: 'failed', error })];
  peer.overrides['POST /connectors/:id/test'] = () => jsonResponse({ success: false, error, tool_count: 0, pending_restart: false });
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(screen.getAllByText(error)).toHaveLength(1);
  await fireEvent.press(screen.getByTestId('connector-error-dismiss')); await tick();
  expect(screen.getByText(error)).toBeOnTheScreen();
  expect(screen.queryByTestId('connector-error-dismiss')).toBeNull();
});

test('connector-auth.AU10 已有 Key 的目录连接器从详情进入同一 Key 页：留空不写，打不开浏览器就地提示', async () => {
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ id: 'app-amap', name: '高德地图', app_id: 'amap', auth_type: 'key', headers: { key: true }, url: 'https://mcp.amap.com/mcp' })];
  const patches: unknown[] = [];
  peer.overrides['PATCH /connectors/:id'] = ({ body }) => { patches.push(body); };
  jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('no browser'));
  await renderGateway(peer, ConnectorDetail, '/connectors/[id]', routes, '/connectors/app-amap');
  await fireEvent.press(screen.getByRole('button', { name: '连接参数' })); await tick();
  expect(screen.getByTestId('connector-key').props.placeholder).toBe('留空保持已有密钥');
  await fireEvent.press(screen.getByRole('button', { name: '获取 Key' })); await tick();
  expect(screen.getByText('无法打开链接')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(patches).toEqual([]);
});

test('OAuth 已创建但读取失败时明确提示，可重试发起而不重复创建', async () => {
  let created = false; let blocked = true; let creations = 0; let starts = 0;
  peer.overrides['POST /connectors'] = () => { created = true; creations++; };
  peer.overrides['GET /connectors/:id'] = () => created && blocked ? unavailable() : undefined;
  peer.overrides['POST /connectors/:id/oauth/start'] = () => { starts++; };
  await openRemote(); await fireEvent.changeText(screen.getByLabelText('网址'), 'https://oauth.example.invalid/mcp');
  await fireEvent.press(screen.getByRole('radio', { name: 'OAuth' }));
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(screen.getByText('连接器已添加，但无法读取最新授权状态，请重试发起授权。')).toBeOnTheScreen();
  expect(starts).toBe(0);
  blocked = false;
  await fireEvent.press(screen.getByRole('button', { name: '重试发起授权' })); await tick();
  expect(creations).toBe(1); expect(starts).toBe(1);
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('连接器已添加，但无法读取最新授权状态，请重试发起授权。')).toBeNull();
});

test('参数草稿只采纳本次成功读取，后续刷新失败不覆盖已打开输入', async () => {
  let blocked = false;
  peer.overrides['GET /connectors/:id'] = () => blocked ? unavailable() : undefined;
  await renderGateway(peer, SettingsConnectors, '/settings-connectors', routes);
  await fireEvent.press(screen.getByRole('tab', { name: '已添加' })); await tick();
  await fireEvent.press(screen.getByTestId('connector-docs')); await tick();
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
  blocked = true;
  await fireEvent.press(screen.getByTestId('connector-docs')); await tick();
  expect(screen.getByRole('button', { name: '连接参数' })).toBeDisabled();
  blocked = false; await tick(3000);
  await fireEvent.press(screen.getByRole('button', { name: '连接参数' })); await tick();
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://draft.example.invalid/mcp');
  blocked = true;
  await act(() => peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs', op: 'status' }))); await tick();
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://draft.example.invalid/mcp');
  expect(screen.getByLabelText('网址')).toBeEnabled();
});

test('start 已确认但权威读取失败时不打开材料，提示后可显式重新授权', async () => {
  peer.state.connectors = [row({ auth_type: 'oauth', auth: { status: 'unauthorized', authorizing: false, transaction_id: null, scopes: [] }, status: 'disconnected' })];
  let starts = 0; let blocked = true;
  peer.overrides['POST /connectors/:id/oauth/start'] = () => { starts++; };
  peer.overrides['GET /connectors/:id'] = () => starts && blocked ? unavailable() : undefined;
  await openDetail();
  await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  expect(screen.getByText('授权已发起，但无法读取最新状态，请恢复连接后重新发起授权。')).toBeOnTheScreen();
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled();
  expect(screen.queryByText(/保存结果未确认/)).toBeNull();
  blocked = false;
  await fireEvent.press(screen.getByTestId('oauth-start')); await tick();
  expect(starts).toBe(2);
  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledTimes(1);
});

test('connector-auth.AU10 目录晚于详情到达：目录就绪前不能进入 Key 页，就绪后只写目录声明的 Key', async () => {
  const gate = Promise.withResolvers<Response>();
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ id: 'app-amap', name: '高德地图', app_id: 'amap', auth_type: 'key', headers: {}, url: 'https://mcp.amap.com/mcp', status: 'disconnected', tool_count: 0 })];
  peer.overrides['GET /apps'] = () => gate.promise;
  const patches: unknown[] = [];
  peer.overrides['PATCH /connectors/:id'] = ({ body }) => { patches.push(body); };
  await renderGateway(peer, ConnectorDetail, '/connectors/[id]', routes, '/connectors/app-amap');
  expect(screen.getByRole('button', { name: '填写密钥' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '连接参数' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: '填写密钥' })); await tick();
  expect(screen.queryByTestId('connector-key')).toBeNull();
  await act(async () => { gate.resolve(jsonResponse({ apps: [amapEntry] })); }); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '填写密钥' })); await tick();
  await fireEvent.changeText(screen.getByTestId('connector-key'), 'late-catalog-key');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(patches).toEqual([{ headers: { key: 'late-catalog-key' } }]);
});

test('connector-auth.AU10 目录读取失败：明确提示且不能进入 Key 页', async () => {
  peer.state.apps = [amapEntry];
  peer.state.connectors = [row({ id: 'app-amap', name: '高德地图', app_id: 'amap', auth_type: 'key', headers: {}, url: 'https://mcp.amap.com/mcp', status: 'disconnected', tool_count: 0 })];
  peer.overrides['GET /apps'] = () => unavailable();
  await renderGateway(peer, ConnectorDetail, '/connectors/[id]', routes, '/connectors/app-amap'); await tick(1000);
  await tick(3000);
  expect(screen.getByTestId('connector-catalog-error')).toHaveTextContent(/无法加载连接器目录，正在重试…/);
  expect(screen.getByRole('button', { name: '填写密钥' })).toBeDisabled();
});

test('connector-detail S2 参数保存明确失败：横幅内 × 关闭，留在参数页可再保存', async () => {
  peer.state.connectors = [row({ auth_type: 'key', headers: { Authorization: true } })];
  peer.overrides['PATCH /connectors/:id'] = () => jsonResponse({ error: { code: 'invalid_request', message: '请填写有效的连接器地址' } }, 400);
  await openDetail();
  await fireEvent.press(screen.getByRole('button', { name: '连接参数' })); await tick();
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://docs.example.invalid/other');
  await fireEvent.press(screen.getByRole('button', { name: '保存' })); await tick();
  expect(screen.getByTestId('connector-error')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('connector-error-dismiss')); await tick();
  expect(screen.queryByTestId('connector-error')).toBeNull();
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://docs.example.invalid/other');
});
