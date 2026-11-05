import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import ChatRoute from '../src/app/chat';
import AgentProfileRoute from '../src/app/agents/[id]';
import MemoryReaderRoute from '../src/app/memory-reader';
import EntryRoute from '../src/app/index';
import type { TaskConversation } from '../src/gateway/api';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
let releaseTask: (() => void) | undefined;
const routes = { '/agents/[id]': AgentProfileRoute, '/memory-reader': MemoryReaderRoute };
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway({ seq: 100 });
  releaseTask = undefined;
  seedGatewayAgent(peer, { workers: ['writer'] }); seedGatewayAgent(peer, { id: 'writer', name: '写作者' });
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 650, 0, 0));
});
afterEach(() => { releaseTask?.(); peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function layoutChat() {
  let composer = screen.getByTestId('composer-input').parent;
  while (composer && typeof composer.props.onLayout !== 'function') composer = composer.parent;
  if (!composer) throw new Error('Composer measurement boundary missing');
  await fireEvent(composer, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 70 } } });
  for (const scroll of screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onLayout === 'function')) {
    await fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 650 } } });
  }
  await tick(200);
}

test('关闭再打开协作弹层后进入成员正文，胶囊保持准确 Agent', async () => {
  const task: TaskConversation = { id: 'child', task_id: 'child', kind: 'task', root_id: 'root', root_title: '研究任务', creator_task_id: 'root', creator_agent_id: 'research', agent_id: 'writer', initiator: '研究员', recipient: '写作者', title: '整理资料', status: 'waiting', error: null, unread: false, read_seq: 100, created_at: 1, updated_at: 2, branch_working: false };
  peer.state.tasks = [task];
  seedGatewayConversation(peer, 'research', 'root', [
    { seq: 10, at: 1, type: 'message.user', conversation_id: 'root', data: { text: '请写作者核对' } },
  ]);
  peer.state.histories.set('child', [{ seq: 20, at: 2, type: 'message.agent', conversation_id: 'root', data: { task_id: 'child', timeline_ids: ['child'], agent: 'writer', text: '成员正文目标' } }]);
  await renderGateway(peer, ChatRoute, '/chat', routes, '/chat?id=root'); await layoutChat();
  await act(async () => {
    peer.state.agentDetails.get('research')!.name = '研究员改名';
    peer.state.agents.find(agent => agent.id === 'research')!.name = '研究员改名';
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'research', op: 'updated' }));
  }); await tick(200);
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('研究员改名');
  await fireEvent.press(screen.getByTestId('chat-child-count')); await tick(300);
  expect(screen.getByTestId('chat-child-child')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('chat-child-count')); await tick(500);
  expect(screen.queryByTestId('chat-child-child')).toBeNull();
  await fireEvent.press(screen.getByTestId('chat-child-count')); await tick(300);
  await fireEvent.press(screen.getByTestId('chat-child-child')); await tick(); await layoutChat();
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('写作者');
  expect(screen.getByText('成员正文目标')).toBeOnTheScreen();
  expect(screen.getByLabelText('返回主对话')).toBeOnTheScreen();
  expect(screen.queryByTestId('chat-child-child')).toBeNull();
});

test('定时触发事件与成员记忆系统行保持来源归属', async () => {
  const root = seedGatewayConversation(peer, 'research', 'root', [
    { seq: 10, at: 1, type: 'schedule.triggered', conversation_id: 'root', data: { name: '每日资料', schedule_id: 'daily', run_id: 1 } },
    { seq: 11, at: 2, type: 'memory.updated', conversation_id: 'root', data: { scope: 'work', agent_id: 'writer', summary: '已记住成员结论' } },
  ]);
  root.source = 'schedule'; root.schedule_origin = { schedule_id: 'daily', run_id: 1, name: '每日资料', scheduled_at: 1 }; root.last_text = '定时任务结果';
  peer.state.memories.set('/agents/writer/memory', { scope: 'work', agent_id: 'writer', content: '写作者专属事实', version: 'v1', details: {}, limit: 1000, updated_at: 2, updated_by: 'agent' });
  await renderGateway(peer, ChatRoute, '/chat', routes, '/chat?id=root'); await layoutChat();
  expect(screen.getByTestId('schedule-triggered-10')).toHaveTextContent(/每日资料/);
  await fireEvent.press(screen.getByTestId('memory-updated-11')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('写作者');
  await fireEvent.press(screen.getByTestId('profile-work-memory')); await tick();
  expect(screen.getByText('写作者专属事实')).toBeOnTheScreen();
  await act(() => router.dismissTo('/chat?id=root')); await tick();
  await fireEvent.press(screen.getByTestId('chat-open-drawer')); await tick(300);
  expect(screen.getByRole('button', { name: /定时/, selected: true })).toBeOnTheScreen();
});

test('chat.O17 换库后权威目录不再包含已查看的根，结束旧目标并进入可用空草稿', async () => {
  const root = seedGatewayConversation(peer, 'research', 'removed-root', [
    { seq: 10, at: 1, type: 'message.user', conversation_id: 'removed-root', data: { text: '失效根原文' } },
  ]);
  root.last_text = '失效根原文';
  await renderGateway(peer, ChatRoute, '/chat', { ...routes, '/': EntryRoute }, '/chat?id=removed-root');
  await layoutChat();
  expect(screen.getByText('失效根原文')).toBeOnTheScreen();
  await act(() => {
    peer.state.conversations = [];
    peer.state.histories.delete('removed-root');
    peer.emit(peer.event('resync_required', {}));
  });
  await tick(500);
  await waitFor(() => expect(screen.getByTestId('new-chat-agent-chips')).toBeOnTheScreen());
  expect(screen.queryByText('失效根原文')).toBeNull();
  expect(peer.state.conversations).toEqual([]);
});

test('chat.O16 冷开未知子对话等待详情，不借其他根归属退出；无原根栈项时返回替换而不多留一层', async () => {
  seedGatewayConversation(peer, 'research', 'root', [
    { seq: 10, at: 1, type: 'message.user', conversation_id: 'root', data: { text: '真实根正文' } },
  ]);
  const child: TaskConversation = { id: 'cold-child', task_id: 'cold-child', kind: 'task', root_id: 'root', root_title: '研究任务',
    creator_task_id: 'root', creator_agent_id: 'research', agent_id: 'writer', initiator: '研究员', recipient: '写作者',
    title: '冷开协作', status: 'waiting', error: null, unread: false, read_seq: 100, created_at: 1, updated_at: 2, branch_working: false };
  const gate = Promise.withResolvers<void>(); releaseTask = gate.resolve;
  peer.overrides['GET /tasks/:id'] = async () => { await gate.promise; return jsonResponse(child); };
  peer.state.histories.set('cold-child', []);
  await renderGateway(peer, ChatRoute, '/chat', { ...routes, '/': EntryRoute }, '/chat?id=cold-child');
  const input = screen.getByTestId('composer-input');
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  peer.state.tasks.push(child); gate.resolve(); await tick(500); await layoutChat();
  await waitFor(() => expect(screen.getByTestId('chat-root-conversation')).toBeOnTheScreen());
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('写作者');
  expect(screen.getByTestId('composer-input')).toBe(input);
  await fireEvent.press(screen.getByTestId('chat-root-conversation')); await tick(400); await layoutChat();
  expect(screen.getByText('真实根正文')).toBeOnTheScreen();
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('研究员');
  expect(router.canGoBack()).toBe(false);
});
