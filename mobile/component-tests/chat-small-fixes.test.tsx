import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import ChatRoute from '../src/app/chat';
import type { TaskConversation } from '../src/gateway/api';
import { FakeGateway } from '../src/dev/fake-gateway';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
beforeEach(() => {
  jest.useFakeTimers();
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('chat.H1 I3 I8 冷启动直接进根页，孙失败点亮顶栏与子行，未读不亮', async () => {
  const peer = new FakeGateway({ seq: 100 });
  seedGatewayAgent(peer, { workers: ['writer'] });
  seedGatewayAgent(peer, { id: 'writer', name: '写作者' });
  seedGatewayConversation(peer, 'research', 'root', [{ seq: 1, at: 1, type: 'message.user', conversation_id: 'root', data: { text: 'root message' } }]).last_text = 'root message';
  const child: TaskConversation = { id: 'child', task_id: 'child', kind: 'task', root_id: 'root', root_title: 'Root', creator_task_id: 'root',
    creator_agent_id: 'research', agent_id: 'writer', initiator: 'research', recipient: 'writer', title: 'Child', status: 'completed', error: null,
    unread: true, read_seq: 0, branch_working: false, created_at: 1, updated_at: 1 };
  const grandchild: TaskConversation = { ...child, id: 'grandchild', task_id: 'grandchild', creator_task_id: 'child', status: 'failed', title: 'Grandchild' };
  peer.state.tasks.push(child, grandchild);
  const view = await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=root');
  try {
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
    await layoutGatewayChat();
    // No task.created event in root history and no drawer open: this must come from collaboration snapshots.
    expect(screen.getByTestId('chat-child-attention')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('chat-child-count'));
    await tick(300);
    expect(screen.getByTestId('chat-child-child').props.accessibilityLabel).toContain('需要处理');
    await act(() => peer.emit(peer.event('task.status', { task_id: 'grandchild', status: 'completed', error: null, timeline_ids: ['child', 'grandchild'] }, 'root')));
    await tick();
    expect(screen.queryByTestId('chat-child-attention')).toBeNull();
    expect(screen.getByTestId('chat-child-child').props.accessibilityLabel).not.toContain('需要处理');
  } finally { await view.unmount(); peer.disconnect(); }
});
