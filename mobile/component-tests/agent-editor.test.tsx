import { z } from 'zod';
import { act, fireEvent, screen } from '@testing-library/react-native';
import AgentEditorRoute from '../src/app/agent-editor';
import AgentsRoute from '../src/app/agents';
import AgentProfileRoute from '../src/app/agents/[id]';
import ChatRoute from '../src/app/chat';
import ChatEntryRoute from '../src/app/index';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';
import type { GatewayEvent } from '../src/gateway/api';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
const routes = { '/agent-editor': AgentEditorRoute, '/agents/[id]': AgentProfileRoute, '/chat': ChatRoute };
beforeEach(() => { jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer); });
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('创建保持提示词、模型、技能、成员子页草稿并返回目录，点行进入该 Agent 资料', async () => {
  peer.state.skills = [{ name: 'research-tool', description: '查资料', status: 'ok', error: null, used_by: [], path: '/skills/research-tool/SKILL.md', mtime: 1, content: '# 方法' }];
  await renderGateway(peer, AgentsRoute, '/', routes);
  await fireEvent.press(screen.getByTestId('agents-add')); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-name'), '新助手');
  await fireEvent.changeText(screen.getByTestId('editor-description'), '独立研究任务');
  await fireEvent.press(screen.getByTestId('editor-prompt'));
  await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '先核对原始来源。');
  await fireEvent.press(screen.getByTestId('editor-done'));
  await fireEvent.press(screen.getByTestId('editor-model')); await tick();
  await fireEvent.press(screen.getByTestId('editor-back'));
  await fireEvent.press(screen.getByTestId('editor-skills')); await tick();
  await fireEvent.press(screen.getByTestId('editor-skill-research-tool'));
  await fireEvent.press(screen.getByTestId('editor-done'));
  await fireEvent.press(screen.getByTestId('editor-members')); await tick();
  await fireEvent.press(screen.getByTestId('editor-member-research'));
  await fireEvent.press(screen.getByTestId('editor-done'));
  expect(screen.getByTestId('editor-name')).toHaveDisplayValue('新助手');
  await fireEvent.press(screen.getByTestId('editor-code-mode'));
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  const created = [...peer.state.agentDetails.values()].find(agent => agent.name === '新助手');
  expect(created).toMatchObject({ system_prompt: '先核对原始来源。', skills: ['research-tool'], workers: ['research'], code_mode: false, model: 'offline' });
  await fireEvent.press(await screen.findByTestId(`agent-row-${created!.id}`)); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('新助手');
  expect(peer.state.conversations).toEqual([]);
});

test('资料采用外部改名，已打开编辑表单保留本地草稿', async () => {
  await renderGateway(peer, AgentProfileRoute, '/agents/[id]', { ...routes, '/': AgentsRoute }, '/agents/research');
  await act(async () => {
    peer.state.agentDetails.get('research')!.name = '远端改名';
    peer.state.agents[0].name = '远端改名';
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('远端改名');
  await fireEvent.press(screen.getByTestId('profile-edit')); await tick();
  await fireEvent.changeText(screen.getByTestId('editor-description'), '本地编辑中');
  await act(async () => {
    peer.state.agentDetails.get('research')!.name = '第二次改名';
    peer.state.agents[0].name = '第二次改名';
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' }));
  }); await tick();
  expect(screen.getByTestId('editor-description')).toHaveDisplayValue('本地编辑中');
  expect(screen.getByTestId('editor-name')).toHaveDisplayValue('远端改名');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('第二次改名');
  expect(peer.state.agentDetails.get('research')!.description).toBe('本地编辑中');
});

test('引用阻止删除显示使用者；无事件解除引用重读后，取消不删，确认离开回目录', async () => {
  seedGatewayAgent(peer, { id: 'parent', name: '主助手', workers: ['research'] });
  peer.state.agentDetails.get('research')!.member_of = ['parent'];
  await renderGateway(peer, AgentsRoute, '/', routes, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  expect(screen.getByText(/主助手/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-delete-blocked-ack'));
  peer.state.agentDetails.get('research')!.member_of = [];
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-cancel')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveDisplayValue('研究员');
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-confirm')); await tick();
  expect(screen.queryByTestId('agent-row-research')).toBeNull();
  expect(screen.getByTestId('agent-row-parent')).toBeOnTheScreen();
});

test.each([false, true])('agent-editor.B7 T4 %s 新建 / 改名重名后名字下报错，保留输入并可修正保存', async creating => {
  const rejectDuplicate = ({ body }: { body: unknown }) => z.object({ name: z.string().optional() }).parse(body).name?.trim().toLowerCase() === 'test'
    ? jsonResponse({ error: { code: 'agent_name_conflict', message: '已有同名 Agent' } }, 409) : undefined;
  peer.overrides['POST /agents'] = rejectDuplicate;
  peer.overrides['PATCH /agents/:id'] = rejectDuplicate;
  await renderGateway(peer, AgentsRoute, '/', routes, creating ? '/' : '/agent-editor?id=research');
  if (creating) { await fireEvent.press(screen.getByTestId('agents-add')); await tick(); }
  await fireEvent.changeText(screen.getByTestId('editor-name'), ' Test ');
  await fireEvent.changeText(screen.getByTestId('editor-description'), '本次说明');
  if (creating) {
    await fireEvent.press(screen.getByTestId('editor-prompt'));
    await fireEvent.changeText(screen.getByTestId('editor-prompt-input'), '本次提示词');
    await fireEvent.press(screen.getByTestId('editor-done'));
  }
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByTestId('editor-name')).toHaveDisplayValue(' Test ');
  expect(screen.getByTestId('editor-description')).toHaveDisplayValue('本次说明');
  expect(screen.getByTestId('editor-name-error')).toHaveTextContent('已有同名 Agent');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(peer.state.agentDetails.get('research')!.name).toBe('研究员');
  await fireEvent.changeText(screen.getByTestId('editor-description'), '修改其他字段');
  expect(screen.getByTestId('editor-name-error')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('editor-prompt'));
  expect(screen.getByTestId('editor-prompt-input')).toHaveDisplayValue(creating ? '本次提示词' : '核对资料');
  await fireEvent.press(screen.getByTestId('editor-done'));
  await fireEvent.changeText(screen.getByTestId('editor-name'), 'Unique');
  expect(screen.queryByTestId('editor-name-error')).toBeNull();
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect([...peer.state.agentDetails.values()].find(row => row.name === 'Unique')).toMatchObject({ description: '修改其他字段' });
  expect(screen.queryByTestId('editor-name')).toBeNull();
});

test('切换环境先确认，取消不提交；成功返回资料页只告知一次并在五秒后消失', async () => {
  peer.state.environments.push({ id: 'cloud', name: '测试工作机', type: 'instabox', status: 'running' });
  let writes = 0;
  peer.overrides['PATCH /agents/:id'] = async (_context, respond) => {
    writes++;
    const response = await respond();
    const payload = await response.json();
    payload.event.data.cleanup_unconfirmed = [{ resource: 'directories', error: 'OldDirectoriesNotCleaned' }];
    return jsonResponse(payload);
  };
  await renderGateway(peer, AgentsRoute, '/', routes);
  await tick();
  await fireEvent.press(screen.getByTestId('agent-row-research')); await tick();
  await fireEvent.press(screen.getByTestId('profile-edit')); await tick();
  await fireEvent.press(screen.getByTestId('editor-environment')); await tick();
  await fireEvent.press(screen.getByTestId('editor-environment-cloud'));
  await fireEvent.press(screen.getByTestId('editor-done'));
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  expect(screen.getByTestId('environment-switch-confirmation')).toBeOnTheScreen();
  expect(writes).toBe(0);
  await fireEvent.press(screen.getByTestId('environment-switch-cancel')); await tick();
  expect(peer.state.agentDetails.get('research')!.environment).toBe('local');
  await fireEvent.press(screen.getByTestId('editor-save')); await tick();
  await fireEvent.press(screen.getByTestId('environment-switch-confirm')); await tick();
  expect(writes).toBe(1);
  expect(peer.state.agentDetails.get('research')!.environment).toBe('cloud');
  expect(screen.getByTestId('profile-name')).toBeOnTheScreen();
  expect(screen.getAllByTestId('cleanup-result-notice')).toHaveLength(1);
  await tick(5000);
  expect(screen.queryByTestId('cleanup-result-notice')).toBeNull();
  await fireEvent.press(screen.getByTestId('profile-edit')); await tick();
  await fireEvent.press(screen.getByTestId('editor-back')); await tick();
  expect(screen.queryByTestId('cleanup-result-notice')).toBeNull();
});

test('本设备删除回执先经 SSE 到达，零 Agent 最终落点仍告知一次，重放不再弹', async () => {
  let receipt: GatewayEvent | undefined;
  peer.overrides['DELETE /agents/:id'] = ({ params }) => {
    peer.state.agents = peer.state.agents.filter(row => row.id !== params.id);
    peer.state.agentDetails.delete(params.id);
    receipt = peer.event('resource.changed', { kind: 'agent', id: params.id, op: 'deleted', cleanup_unconfirmed: [{ resource: 'branch', error: 'TimeoutError' }] });
    peer.emit(receipt);
    return jsonResponse({ event: receipt });
  };
  await renderGateway(peer, ChatEntryRoute, '/', routes, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-confirm')); await tick();
  expect(screen.getByTestId('chat-entry-create-agent')).toBeOnTheScreen();
  expect(screen.getAllByTestId('cleanup-result-notice')).toHaveLength(1);
  await tick(5000);
  await act(() => peer.emit(receipt!)); await tick();
  expect(screen.queryByTestId('cleanup-result-notice')).toBeNull();
});

test('CleanupResultNotice.once 本机删除明确 409 后，其他设备删同一 Agent 不冒认成功告知', async () => {
  peer.overrides['DELETE /agents/:id'] = () => jsonResponse({
    error: { code: 'conflict', message: 'Agent 被成员引用，不能删除', details: { member_of: [{ id: 'parent', name: '主助手' }] } },
  }, 409);
  await renderGateway(peer, ChatEntryRoute, '/', routes, '/agent-editor?id=research');
  await fireEvent.press(screen.getByTestId('editor-delete')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-confirm')); await tick();
  await fireEvent.press(screen.getByTestId('editor-delete-blocked-ack')); await tick();
  await act(() => {
    peer.state.agents = [];
    peer.state.agentDetails.delete('research');
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'deleted',
      cleanup_unconfirmed: [{ stage: 'execution', error: 'CleanupUnconfirmed' }] }));
  }); await tick();
  expect(screen.getByTestId('chat-entry-create-agent')).toBeOnTheScreen();
  expect(screen.queryByTestId('cleanup-result-notice')).toBeNull();
});
