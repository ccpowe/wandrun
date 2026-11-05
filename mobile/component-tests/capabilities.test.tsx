import { act, fireEvent, screen } from '@testing-library/react-native';
import AgentEditorRoute from '../src/app/agent-editor';
import AgentCapabilitiesRoute from '../src/app/agent-capabilities';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer);
  peer.state.capabilities.set('research', [
    { id: 'files', name: '文件', summary: '读取原文件', description: '仅使用此 Agent 的工作目录', status: 'enabled', reason: '本机目录可用', tools: ['read_file', 'write_file'], skills: [] },
    { id: 'code_mode', name: '代码模式', summary: '批量调用工具', description: '脚本批量处理', status: 'enabled', reason: '', tools: ['code_mode'], skills: [] },
  ]);
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('capabilities.T1/T2/T3 已提交快照不取编辑草稿；关闭与撤销详情，重新启用不自动重开', async () => {
  await renderGateway(peer, AgentEditorRoute, '/agent-editor', { '/agent-capabilities': AgentCapabilitiesRoute }, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId('editor-code-mode'));
  await fireEvent.press(screen.getByTestId('editor-system-capabilities')); await tick();
  expect(screen.getByTestId('capability-code_mode')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('capability-files')); await tick();
  expect(screen.getByText('read_file')).toBeOnTheScreen();
  expect(screen.getByText('本机目录可用')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('capability-backdrop')); await tick();
  expect(screen.queryByTestId('capability-sheet')).toBeNull();
  await fireEvent.press(screen.getByTestId('capability-code_mode')); await tick();
  await act(async () => {
    peer.state.capabilities.set('research', peer.state.capabilities.get('research')!.map(item => item.id === 'code_mode' ? { ...item, status: 'disabled', reason: '此 Agent 已关闭' } : item));
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.queryByTestId('capability-sheet')).toBeNull();
  expect(screen.getByTestId('capability-unavailable-code_mode')).toHaveTextContent(/此 Agent 已关闭/);
  await act(async () => {
    peer.state.capabilities.set('research', peer.state.capabilities.get('research')!.map(item => ({ ...item, status: 'enabled' })));
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.getByTestId('capability-code_mode')).toBeOnTheScreen();
  expect(screen.queryByTestId('capability-sheet')).toBeNull();
  await fireEvent.press(screen.getByTestId('capabilities-back')); await tick();
  expect(screen.getByTestId('editor-code-mode')).toHaveProp('accessibilityState', expect.objectContaining({ checked: false }));
  expect(peer.state.agentDetails.get('research')!.code_mode).toBe(true);
});

test('capabilities.T4 刷新失败保留详情，恢复后采用实际快照而非丢失本地选择', async () => {
  await renderGateway(peer, AgentCapabilitiesRoute, '/agent-capabilities', {}, '/agent-capabilities?id=research');
  await fireEvent.press(screen.getByTestId('capability-files')); await tick();
  let fail = true;
  peer.overrides['GET /agents/:id/capabilities'] = () => fail ? new Response('{}', { status: 500 }) : undefined;
  await act(async () => { peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' })); }); await tick();
  expect(screen.getByText('read_file')).toBeOnTheScreen();
  await tick(3000);
  expect(screen.getByText('无法加载系统能力，正在重试…')).toBeOnTheScreen();
  fail = false;
  await tick(600);
  expect(screen.getByText('read_file')).toBeOnTheScreen();
  expect(screen.queryByText('无法加载系统能力，正在重试…')).toBeNull();
});
