import { act, fireEvent, screen } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { z } from 'zod';
import SettingsConnectors from '../src/app/settings-connectors';
import AddConnector from '../src/app/connectors/add';
import AddRemoteConnector from '../src/app/connectors/add-remote';
import ConnectorDetail from '../src/app/connectors/[id]';
import CatalogConnector from '../src/app/connectors/catalog/[id]';
import { FakeGateway, jsonResponse, unavailable } from '../src/dev/fake-gateway';
import type { Connector } from '../src/gateway/api';
import { renderGateway, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const routes = {
  '/settings-connectors': SettingsConnectors, '/connectors/add': AddConnector, '/connectors/add-remote': AddRemoteConnector,
  '/connectors/[id]': ConnectorDetail, '/connectors/catalog/[id]': CatalogConnector,
};
const createRequest = z.object({ client_id: z.string() });
const oldConnector: Connector = {
  id: 'old-created', name: '旧创建', description: '', url: 'https://old.example.invalid/mcp', auth_type: 'none', app_id: null,
  auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null,
  tool_count: 0, used_by: [], pending_restart: false,
};
let peer: FakeGateway;
beforeEach(() => {
  jest.clearAllMocks(); jest.useFakeTimers();
  peer = new FakeGateway({ apps: [{ id: 'notion', name: 'Notion', description: '工作区', url: 'https://notion.example.invalid/mcp', transport: 'streamable-http', auth: { type: 'oauth' }, connector: null }] });
  jest.spyOn(WebBrowser, 'openAuthSessionAsync').mockResolvedValue({ type: WebBrowser.WebBrowserResultType.CANCEL });
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
const enterRemote = async () => {
  await fireEvent.press(screen.getByLabelText('添加连接器')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '远程地址' })); await tick();
};
const openRemote = async () => {
  await renderGateway(peer, SettingsConnectors, '/settings-connectors', routes);
  await enterRemote();
};
const leaveUnknown = async () => {
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
  expect(screen.getByText('保存结果未确认，离开后本次草稿不会保留。')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: '离开' })); await tick();
  await fireEvent.press(screen.getByLabelText('返回')); await tick();
};

// Faults live at HTTP: neither page state nor the session's operation owner is replaced.
test('connector-create.S1 无id和created事件时只读核对未创建，原表单恢复编辑且不重放POST', async () => {
  let clientId = ''; let writes = 0; let queries = 0; let settled = false;
  peer.overrides['POST /connectors'] = ({ body }) => {
    clientId = createRequest.parse(body).client_id; writes++; return unavailable();
  };
  peer.overrides['GET /connectors/creation-result'] = ({ url }) => {
    expect(url.searchParams.get('client_id')).toBe(clientId); queries++;
    return jsonResponse({ status: settled ? 'not_created' : 'pending' });
  };
  await openRemote();
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://uncertain.example.invalid/mcp');
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  await tick(3000);
  expect(screen.getByText('保存结果未确认，恢复连接后自动核对')).toBeOnTheScreen();
  expect(screen.getByLabelText('网址')).toBeDisabled();
  expect(queries).toBeGreaterThan(0);
  settled = true; await tick(3000);
  expect(screen.queryByText('保存结果未确认，恢复连接后自动核对')).toBeNull();
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://uncertain.example.invalid/mcp');
  expect(screen.getByLabelText('网址')).toBeEnabled();
  expect(screen.getByRole('button', { name: '连接' })).toBeEnabled();
  expect(screen.getByRole('alert')).toBeOnTheScreen();
  expect(writes).toBe(1);
});

test('connector-create.S1 新空白访问可提交，旧unknown继续核对但不能覆盖较新的创建', async () => {
  const newer = Promise.withResolvers<void>();
  let oldClientId = ''; let writes = 0; let queries = 0; let oldSettled = false;
  peer.overrides['POST /connectors'] = async ({ body }, respond) => {
    writes++;
    if (writes === 1) { oldClientId = createRequest.parse(body).client_id; return unavailable(); }
    await newer.promise; return respond();
  };
  peer.overrides['GET /connectors/creation-result'] = ({ url }) => {
    expect(url.searchParams.get('client_id')).toBe(oldClientId); queries++;
    return oldSettled ? jsonResponse({ status: 'created', connector: oldConnector,
      event: { seq: 100, at: 1, type: 'resource.changed', data: { kind: 'connector', id: oldConnector.id, op: 'created' }, client_id: oldClientId } })
      : jsonResponse({ status: 'pending' });
  };
  await openRemote();
  await fireEvent.changeText(screen.getByLabelText('网址'), oldConnector.url!);
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(screen.queryByText('保存结果未确认，恢复连接后自动核对')).toBeNull();
  await leaveUnknown();
  await enterRemote();
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('');
  expect(screen.getByLabelText('网址')).toBeEnabled();
  await fireEvent.changeText(screen.getByLabelText('网址'), 'https://new.example.invalid/mcp');
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(writes).toBe(2);
  const before = queries;
  peer.state.connectors.push(oldConnector); oldSettled = true; await tick(3000);
  expect(queries).toBeGreaterThan(before);
  expect(screen.getByLabelText('网址')).toHaveDisplayValue('https://new.example.invalid/mcp');
  expect(screen.getByRole('button', { name: '正在连接…' })).toBeDisabled();
  expect(screen.queryByText('旧创建')).toBeNull();
  await act(() => newer.resolve()); await tick();
  expect(screen.getByText('new.example.invalid')).toBeOnTheScreen();
  expect(writes).toBe(2);
});

test('connector-create.S1 自定义创建unknown不锁住下一次目录连接，旧核对仍只使用旧client_id', async () => {
  let oldClientId = ''; let customWrites = 0; let catalogWrites = 0; let queries = 0;
  peer.overrides['POST /connectors'] = ({ body }) => {
    oldClientId = createRequest.parse(body).client_id; customWrites++; return unavailable();
  };
  peer.overrides['GET /connectors/creation-result'] = ({ url }) => {
    expect(url.searchParams.get('client_id')).toBe(oldClientId); queries++; return jsonResponse({ status: 'pending' });
  };
  peer.overrides['POST /apps/:id/connect'] = ({ body }) => {
    expect(createRequest.parse(body).client_id).not.toBe(oldClientId); catalogWrites++;
  };
  await openRemote();
  await fireEvent.changeText(screen.getByLabelText('网址'), oldConnector.url!);
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(screen.queryByText('保存结果未确认，恢复连接后自动核对')).toBeNull();
  await leaveUnknown();
  await fireEvent.press(screen.getByTestId('catalog-notion')); await tick();
  expect(screen.getByRole('button', { name: '连接' })).toBeEnabled();
  await fireEvent.press(screen.getByRole('button', { name: '连接' })); await tick();
  expect(catalogWrites).toBe(1); expect(customWrites).toBe(1);
  expect(screen.queryByText('保存结果未确认，恢复连接后自动核对')).toBeNull();
  const before = queries; await tick(3000);
  expect(queries).toBeGreaterThan(before);
  expect(screen.getByText('工作区')).toBeOnTheScreen();
  expect(catalogWrites).toBe(1); expect(customWrites).toBe(1);
});
