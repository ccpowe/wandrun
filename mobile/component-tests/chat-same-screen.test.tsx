import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { z } from 'zod';
import ChatRoute from '../src/app/chat';
import EntryRoute from '../src/app/index';
import ProfileRoute from '../src/app/agents/[id]';
import type { TaskConversation } from '../src/gateway/api';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
let creates: { agent_id: string; client_id: string }[];
let release: (() => void) | undefined;
const routes = { '/agents/[id]': ProfileRoute };
const creation = z.object({ agent_id: z.string(), client_id: z.string() });
const messages = () => [...peer.state.histories.values()].flat().filter(event => event.type === 'message.user');
beforeEach(() => {
  jest.useFakeTimers(); creates = []; release = undefined;
  peer = new FakeGateway({ seq: 100 }, { 'POST /conversations': ({ body }) => { creates.push(creation.parse(body)); } });
  seedGatewayAgent(peer, { workers: ['writer'] }); seedGatewayAgent(peer, { id: 'writer', name: '写作者' });
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 800, 0, 0));
});
afterEach(() => { release?.(); peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function start(location = '/chat') {
  await renderGateway(peer, ChatRoute, '/chat', routes, location);
  await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
  await layoutGatewayChat();
}
function holdCreation() {
  const gate = Promise.withResolvers<void>(); release = gate.resolve;
  peer.overrides['POST /conversations'] = async ({ body }, respond) => {
    creates.push(creation.parse(body)); const response = await respond(); await gate.promise; return response;
  };
}

// React TextInput instance identity under the real Router; not proof of a native view tag or IME behavior.
test('chat.O3 O4 T24 首发原位绑定，输入组件实例不换、下一段不丢、首文只出现一次', async () => {
  holdCreation();
  await renderGateway(peer, EntryRoute, '/', { ...routes, '/chat': ChatRoute });
  await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
  await layoutGatewayChat();
  const input = screen.getByTestId('composer-input');
  await fireEvent(input, 'focus');
  expect(screen.queryByTestId('new-chat-agent-display')).toBeNull();
  await fireEvent.changeText(input, '不可丢失的第一条');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue(''); expect(input.props.editable).toBe(true);
  expect(screen.getByText('不可丢失的第一条')).toBeOnTheScreen();
  expect(screen.getByTestId('new-chat-agent-writer')).toBeDisabled();
  await fireEvent.changeText(input, '正在写的下一段');
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  release!(); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['不可丢失的第一条']));
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('正在写的下一段'); expect(input.props.editable).toBe(true);
  expect(screen.getByText('不可丢失的第一条')).toBeOnTheScreen();
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  expect(screen.queryByTestId('new-chat-agent-display')).toBeNull();
  expect(peer.state.conversations).toHaveLength(1);
});

test('chat.O4 接管下一段写盘失败不发布绑定或释放源正文，同键重试仍带回原首文与下一段', async () => {
  holdCreation(); await start();
  const input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '接管中的首文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  const nextText = '不能因接管写盘失败而消失的下一段';
  await fireEvent.changeText(input, nextText);
  const targetSnapshot = z.object({ draft: z.object({ text: z.literal(nextText) }) });
  const write = File.prototype.write;
  let refused = false;
  jest.spyOn(File.prototype, 'write').mockImplementation(function(this: File, ...args: Parameters<File['write']>) {
    if (!refused && this.uri.includes('/upload-drafts/') && typeof args[0] === 'string' && targetSnapshot.safeParse(JSON.parse(args[0])).success) {
      refused = true;
      throw new Error('ENOSPC');
    }
    return write.apply(this, args);
  });
  release!(); await tick(); await layoutGatewayChat();
  expect(input).toHaveDisplayValue(nextText);
  expect(screen.getByTestId('new-chat-agent-chips')).toBeOnTheScreen();
  expect(screen.getByText('接管中的首文')).toBeOnTheScreen();
  expect(messages()).toEqual([]);
  await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['接管中的首文']));
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue(nextText);
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  expect(peer.state.conversations).toHaveLength(1);
  expect(creates).toHaveLength(1);
});

test('chat.O4 T32 创建确认时保留已打开抽屉，选晋升后的当前项仅关闭且不重建输入', async () => {
  holdCreation(); await start();
  const input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '抽屉打开期间完成首发');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.changeText(input, '抽屉下的下一段');
  await fireEvent.press(screen.getByTestId('chat-open-drawer')); await tick(400);
  expect(screen.getByTestId('conversation-drawer-shell')).toBeOnTheScreen();
  release!(); await tick(400);
  const id = peer.state.conversations[0].id;
  const current = screen.getByTestId(`conversation-${id}`);
  expect(current).toBeOnTheScreen();
  await fireEvent.press(current); await tick(500); await layoutGatewayChat();
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('抽屉下的下一段');
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  expect(messages().map(event => event.data.text)).toEqual(['抽屉打开期间完成首发']);
});

test('chat.O15 资料页覆盖期间当场绑定，不改资料参数，返回仍是原输入节点和下一段', async () => {
  holdCreation(); await start();
  const input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '后台确认的首文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.changeText(input, '资料页之前写的下一段');
  await fireEvent.press(screen.getByTestId('chat-agent-profile')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('研究员');
  release!(); await tick();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['后台确认的首文']));
  expect(screen.getByTestId('profile-name')).toHaveTextContent('研究员');
  await fireEvent.press(screen.getByTestId('profile-close')); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('资料页之前写的下一段');
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  expect(screen.getByText('后台确认的首文')).toBeOnTheScreen();
});

test('chat.O14 T31 同一聚焦路由切去其他对话再开草稿，旧确认不夺目标或清后来输入', async () => {
  const other = seedGatewayConversation(peer, 'writer', 'other', [
    { seq: 10, at: 1, type: 'message.user', conversation_id: 'other', data: { text: '其他对话原有正文' } },
  ]);
  other.last_text = '其他对话原有正文';
  holdCreation(); await start();
  await fireEvent.press(screen.getByTestId('new-chat-agent-research'));
  await fireEvent.changeText(screen.getByTestId('composer-input'), '原访问的首文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await act(() => router.setParams({ id: 'other' })); await tick(); await layoutGatewayChat();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '其他对话未发草稿');
  await act(() => router.setParams({ id: undefined })); await tick(); await layoutGatewayChat();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '后来新访问的输入');
  release!(); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('后来新访问的输入');
  expect(screen.getByTestId('new-chat-agent-chips')).toBeOnTheScreen();
  expect(messages().find(event => event.data.text === '原访问的首文')?.conversation_id).not.toBe('other');
  await act(() => router.setParams({ id: 'other' })); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('写作者');
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('其他对话未发草稿');
  expect(peer.state.histories.get('other')?.filter(event => event.type === 'message.user').map(event => event.data.text)).toEqual(['其他对话原有正文']);
});

test('chat.O6 未确认首发留同一气泡，能写下一段、同键继续只建一个真实对话', async () => {
  peer.overrides['POST /conversations'] = ({ body }, respond) => {
    creates.push(creation.parse(body));
    return creates.length === 1 ? jsonResponse({ error: { code: 'unavailable', message: '暂时无法确认' } }, 503) : respond();
  };
  await start(); let input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '待确认的原文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
  expect(screen.getByText('结果未确认，点按重试')).toBeOnTheScreen();
  expect(screen.getByText('待确认的原文')).toBeOnTheScreen();
  await fireEvent.changeText(input, '未知期间的新输入');
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  const original = input;
  await act(() => router.push('/chat')); await tick(); await layoutGatewayChat();
  input = screen.getByTestId('composer-input');
  expect(input).not.toBe(original);
  expect(input).toHaveDisplayValue('未知期间的新输入');
  expect(screen.queryByTestId('new-chat-agent-display')).toBeNull();
  expect(creates).toHaveLength(1);
  await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['待确认的原文']));
  expect(creates).toHaveLength(2); expect(creates[1].client_id).toBe(creates[0].client_id);
  expect(peer.state.conversations).toHaveLength(1);
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('未知期间的新输入');
});

test('chat.O5 明确拒绝保留失败首文和下一段，换Agent后主动重试不覆盖下一段', async () => {
  const failureReason = '当前Agent无法创建';
  const gate = Promise.withResolvers<void>(); release = gate.resolve;
  peer.overrides['POST /conversations'] = async ({ body }, respond) => {
    creates.push(creation.parse(body));
    if (creates.length === 1) { await gate.promise; return jsonResponse({ error: { code: 'invalid_request', message: failureReason } }, 400); }
    return respond();
  };
  await start(); let input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '明确失败的第一条');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.changeText(input, '不能被失败原文覆盖');
  release!(); await tick(); await layoutGatewayChat();
  expect(screen.getByText('明确失败的第一条')).toBeOnTheScreen();
  expect(input).toHaveDisplayValue('不能被失败原文覆盖');
  expect(within(screen.getByTestId('chat-local-send')).getByText(failureReason)).toBeOnTheScreen();
  const original = input;
  await act(() => router.push('/chat')); await tick(); await layoutGatewayChat();
  input = screen.getByTestId('composer-input');
  expect(input).not.toBe(original);
  expect(screen.queryByTestId('new-chat-agent-display')).toBeNull();
  expect(input).toHaveDisplayValue('不能被失败原文覆盖');
  await fireEvent.press(screen.getByTestId('new-chat-agent-writer'));
  await fireEvent.press(screen.getByText('点按重试')); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['明确失败的第一条']));
  expect(peer.state.conversations[0].agent_id).toBe('writer');
  expect(creates[1].client_id).not.toBe(creates[0].client_id);
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('不能被失败原文覆盖');
});

test('chat.O7 发送前离线留原字段且不排队，重连后必须主动再发', async () => {
  let offline = false;
  peer.overrides['GET /events'] = () => { if (offline) throw new TypeError('offline'); };
  await start(); const input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '离线留在输入框');
  await act(() => { offline = true; peer.disconnect(); }); await tick(50);
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  expect(input).toHaveDisplayValue('离线留在输入框');
  expect(within(screen.getByTestId('composer-inline-error')).getByText('发送失败')).toBeOnTheScreen();
  expect(creates).toEqual([]); expect(messages()).toEqual([]);
  offline = false; await tick(2500);
  expect(creates).toEqual([]); expect(messages()).toEqual([]);
  await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['离线留在输入框']));
  expect(screen.getByTestId('composer-input')).toBe(input);
});

test('chat.O8 创建确认前断线，绑定后首文原位失败，离线重试不改提示或提交，在线同键恢复', async () => {
  let offline = false;
  let sends = 0;
  const keys: string[] = [];
  peer.overrides['GET /events'] = () => { if (offline) throw new TypeError('offline'); };
  peer.overrides['POST /conversations/:id/messages'] = ({ body }) => {
    sends++;
    keys.push(z.object({ client_id: z.string() }).parse(body).client_id);
  };
  holdCreation(); await start();
  const input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '创建已知但尚未发送的首文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
  const firstBubbleKey = screen.getByTestId(/^message-menu-trigger-p/).props.testID;
  await fireEvent.changeText(input, '必须保留的下一段');
  await act(() => { offline = true; peer.disconnect(); }); await tick(50);
  release!(); await tick(); await layoutGatewayChat();
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  expect(screen.getByText('结果未确认，点按重试')).toBeOnTheScreen();
  expect(screen.getByTestId(firstBubbleKey)).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('必须保留的下一段');
  await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick();
  expect(sends).toBe(0);
  expect(screen.getByText('结果未确认，点按重试')).toBeOnTheScreen();
  expect(screen.queryByLabelText('发送中')).toBeNull();
  offline = false; await tick(2500);
  expect(sends).toBe(0);
  await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick(); await layoutGatewayChat();
  expect(messages().map(event => event.data.text)).toEqual(['创建已知但尚未发送的首文']);
  expect(keys).toEqual([firstBubbleKey.replace('message-menu-trigger-p', '')]);
  expect(screen.getByTestId(firstBubbleKey)).toBeOnTheScreen();
  expect(input).toHaveDisplayValue('必须保留的下一段');
});

test('chat.O12 首附件原位接管、上传失败可移除，正文和原始文件保留且不自动发消息', async () => {
  peer.overrides['POST /uploads'] = () => jsonResponse({ error: { code: 'invalid_request', message: '本次上传失败' } }, 400);
  const source = new File(Paths.document, 'same-screen-original.txt'); source.write('owned source bytes');
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValue({ canceled: false,
    assets: [{ uri: source.uri, name: 'notes.txt', size: source.size, mimeType: 'text/plain', lastModified: 1 }] });
  await start(); const input = screen.getByTestId('composer-input');
  await fireEvent.changeText(input, '和首附件一起保留的正文');
  await fireEvent.press(screen.getByTestId('composer-add')); await tick();
  await fireEvent.press(screen.getByTestId('attachment-picker-file')); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(screen.getByTestId(/^upload-retry-/)).toBeEnabled());
  expect(screen.getByTestId('composer-input')).toBe(input);
  expect(input).toHaveDisplayValue('和首附件一起保留的正文');
  expect(source.exists).toBe(true); expect(messages()).toEqual([]); expect(peer.state.conversations).toHaveLength(1);
  expect(screen.queryByTestId('new-chat-agent-chips')).toBeNull();
  await fireEvent.press(screen.getByLabelText('移除附件 notes.txt')); await tick();
  expect(screen.queryByTestId('attachment-drafts')).toBeNull();
  expect(input).toHaveDisplayValue('和首附件一起保留的正文');
  expect(peer.state.conversations).toHaveLength(1);
});

test('chat.O16 子对话返回按真实根项pop，保留原根输入实例且不静默去重同id push', async () => {
  seedGatewayConversation(peer, 'research', 'root', [
    { seq: 10, at: 1, type: 'message.user', conversation_id: 'root', data: { text: '主对话原有正文' } },
  ]);
  const child: TaskConversation = { id: 'child', task_id: 'child', kind: 'task', root_id: 'root', root_title: '研究任务',
    creator_task_id: 'root', creator_agent_id: 'research', agent_id: 'writer', initiator: '研究员', recipient: '写作者', title: '子对话',
    status: 'waiting', error: null, unread: false, read_seq: 100, created_at: 1, updated_at: 2, branch_working: false };
  peer.state.tasks = [child];
  peer.state.histories.set('child', [{ seq: 20, at: 2, type: 'message.agent', conversation_id: 'root', data: { task_id: 'child', timeline_ids: ['child'], agent: 'writer', text: '子对话正文' } }]);
  await start('/chat?id=root'); const rootInput = screen.getByTestId('composer-input');
  await fireEvent.changeText(rootInput, '返回后仍在的根草稿');
  await act(() => router.push({ pathname: '/chat', params: { id: 'child' } })); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('写作者');
  await fireEvent.press(screen.getByLabelText('返回主对话')); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('composer-input')).toBe(rootInput);
  expect(rootInput).toHaveDisplayValue('返回后仍在的根草稿');
  expect(router.canGoBack()).toBe(false);
  await act(() => router.push({ pathname: '/chat', params: { id: 'root' } })); await tick(); await layoutGatewayChat();
  expect(screen.getByTestId('composer-input')).not.toBe(rootInput);
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('composer-input')).toBe(rootInput);
});
