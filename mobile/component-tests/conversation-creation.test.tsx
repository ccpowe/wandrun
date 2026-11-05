import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import ChatRoute from '../src/app/chat';
import ProfileRoute from '../src/app/agents/[id]';
import EntryRoute from '../src/app/index';
import { FakeGateway, jsonResponse } from '../src/dev/fake-gateway';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';
import { z } from 'zod';
import { useSession } from '../src/lib/session-context';
import { GatewayApi } from '../src/gateway/api';
import type { ChatSession } from '../src/gateway/session';
import { acquireUploadDraft } from '../src/lib/upload-drafts';
import { projectChatRows } from '../src/lib/chat-timeline';
import { useMountEffect } from '../src/lib/use-mount-effect';

let capturedSession: ChatSession | null = null;
function CapturedChat() {
  const session = useSession();
  useMountEffect(() => {
    capturedSession = session;
    return () => { if (capturedSession === session) capturedSession = null; };
  });
  return <ChatRoute />;
}

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
let creates: { agent_id: string; client_id: string }[];
let releaseCreation: (() => void) | undefined;
beforeEach(() => {
  jest.useFakeTimers();
  creates = []; releaseCreation = undefined;
  capturedSession = null;
  peer = new FakeGateway({}, { 'POST /conversations': ({ body }) => { creates.push(z.object({ agent_id: z.string(), client_id: z.string() }).parse(body)); } });
  seedGatewayAgent(peer);
  seedGatewayAgent(peer, { id: 'writer', name: '写作者' });
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 800, 0, 0));
});
afterEach(() => { releaseCreation?.(); peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
const routes = { '/agents/[id]': ProfileRoute };
const start = async () => {
  const view = await renderGateway(peer, ChatRoute, '/chat', routes);
  await waitFor(() => expect(screen.getByTestId('new-chat-agent-research')).toBeOnTheScreen());
  await layoutGatewayChat();
  return view;
};
const messages = () => [...peer.state.histories.values()].flat().filter(event => event.type === 'message.user');

function holdCreation(abortable = false) {
  const gate = Promise.withResolvers<void>();
  releaseCreation = gate.resolve;
  peer.overrides['POST /conversations'] = async ({ body, init }, respond) => {
    creates.push(z.object({ agent_id: z.string(), client_id: z.string() }).parse(body));
    const response = await respond();
    if (creates.length === 1) {
      if (abortable) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        void gate.promise.then(resolve);
        init.signal?.addEventListener('abort', () => reject(new TypeError('HTTP receipt timed out')), { once: true });
        await promise;
      } else await gate.promise;
    }
    return response;
  };
}

test('chat.N1 N2 N3 输入和换 Agent 都是本地，资料页往返恢复同一份文字', async () => {
  await start();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '尚未提交的文字');
  await fireEvent.press(screen.getByTestId('new-chat-agent-writer'));
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('尚未提交的文字');
  await fireEvent.press(screen.getByTestId('chat-agent-profile')); await tick();
  expect(screen.getByTestId('profile-name')).toHaveTextContent('写作者');
  await fireEvent.press(screen.getByTestId('profile-close')); await tick();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('尚未提交的文字');
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('写作者');
  expect(creates).toEqual([]);
  expect(peer.state.conversations).toEqual([]);
});

test('chat.N4 发送前已知离线留输入；重连不自动提交，用户再发送才创建并发首消息', async () => {
  let offline = false;
  peer.overrides['GET /events'] = () => { if (offline) throw new TypeError('offline'); };
  await start();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '离线保留原文');
  await act(() => { offline = true; peer.disconnect(); }); await tick(50);
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  // Known-offline send: the hint lives in the composer field, no banner (N4 / G7).
  expect(screen.getByTestId('composer-inline-error')).toBeOnTheScreen();
  expect(screen.queryByTestId('chat-local-send')).toBeNull();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('离线保留原文');
  expect(creates).toEqual([]);
  await fireEvent.changeText(screen.getByTestId('composer-input'), '离线保留原文。');
  expect(screen.queryByTestId('composer-inline-error')).toBeNull();
  offline = false; await tick(2500);
  expect(messages()).toEqual([]);
  expect(creates).toEqual([]);
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['离线保留原文。']));
  expect(peer.state.conversations).toHaveLength(1);
  expect(screen.queryByTestId('new-chat-agent-research')).toBeNull();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('');
});

test('chat.N5 N6 T14 T17 创建已提交但回执超时，同键重试只产生一个对话，重复点击和换 Agent 不改变已冻结意图', async () => {
  const emit = peer.emit.bind(peer);
  jest.spyOn(peer, 'emit').mockImplementation(event => { if (event.type !== 'conversation.created') emit(event); });
  holdCreation(true);
  await start();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '超时后的原文');
  await fireEvent.press(screen.getByTestId('new-chat-agent-writer'));
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.press(screen.getByTestId('composer-send'));
  expect(creates).toHaveLength(1);
  await tick(15_100);
  await layoutGatewayChat();
  expect(screen.getByText('超时后的原文')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('');
  expect(messages()).toEqual([]);
  await fireEvent.press(screen.getByTestId('new-chat-agent-research'));
  await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick();
  await waitFor(() => expect(messages()).toHaveLength(1));
  expect(creates.map(request => request.client_id)).toEqual([creates[0].client_id, creates[0].client_id]);
  expect(peer.state.conversations).toHaveLength(1);
  expect(peer.state.conversations[0].agent_id).toBe('writer');
  expect(messages()[0].data.text).toBe('超时后的原文');
  expect(messages()[0].client_id).not.toBe(creates[0].client_id);
});

test('chat.T19 首次发送中离开，当前 session 完成用户已发起的动作，但迟到结果不拉回聊天页', async () => {
  holdCreation();
  await start();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '离开也不重放');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.press(screen.getByTestId('chat-agent-profile')); await tick();
  expect(screen.getByTestId('profile-name')).toBeOnTheScreen();
  await act(() => releaseCreation!()); await tick();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['离开也不重放']));
  expect(screen.getByTestId('profile-name')).toBeOnTheScreen();
  expect(screen.queryByTestId('composer-input')).toBeNull();
  await fireEvent.press(screen.getByTestId('profile-close')); await tick();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('');
  expect(creates).toHaveLength(1);
});

test('chat.N8 N9 首附件先建对话再上传；上传失败仍在该真实对话，删光附件不删除空壳也不列入抽屉', async () => {
  const order: string[] = [];
  peer.overrides['POST /conversations'] = ({ body }) => { order.push('create'); creates.push(z.object({ agent_id: z.string(), client_id: z.string() }).parse(body)); };
  peer.overrides['POST /uploads'] = () => { order.push('upload'); return jsonResponse({ error: { code: 'invalid_request', message: '本次上传失败' } }, 400); };
  const source = new File(Paths.document, 'lazy-attachment.txt'); source.write('需要保留的原文件');
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValue({ canceled: false, assets: [{ uri: source.uri, name: 'notes.txt', size: source.size, mimeType: 'text/plain', lastModified: 1 }] });
  await start();
  await fireEvent.press(screen.getByTestId('composer-add')); await tick();
  await fireEvent(screen.getByTestId('attachment-picker-dismiss'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
  await fireEvent(screen.getByTestId('attachment-picker-menu'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 220 } } });
  await fireEvent.press(screen.getByTestId('attachment-picker-file')); await tick();
  await waitFor(() => expect(order).toEqual(['create', 'upload']));
  await layoutGatewayChat();
  expect(peer.state.conversations).toHaveLength(1);
  expect(messages()).toEqual([]);
  expect(screen.queryByTestId('new-chat-agent-research')).toBeNull();
  await fireEvent.press(screen.getByLabelText('移除附件 notes.txt')); await tick();
  await fireEvent.press(screen.getByTestId('chat-open-drawer')); await tick(400);
  expect(screen.queryByTestId(`conversation-${peer.state.conversations[0].id}`)).toBeNull();
  expect(peer.state.conversations).toHaveLength(1);
  expect(creates).toHaveLength(1);
  source.delete();
});

test('chat.O8 后台创建已确认但首文未发就断线：原地接管，重连不自动发，主动重试首文不覆盖下一段', async () => {
  let offline = false;
  const gate = Promise.withResolvers<void>();
  releaseCreation = gate.resolve;
  peer.overrides['GET /events'] = () => { if (offline) throw new TypeError('offline'); };
  peer.overrides['POST /conversations'] = async ({ body }, respond) => {
    creates.push(z.object({ agent_id: z.string(), client_id: z.string() }).parse(body));
    const response = await respond();
    await gate.promise;
    return response;
  };
  await start();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '创建成功后掉线');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.press(screen.getByTestId('chat-agent-profile')); await tick(300);
  await act(() => { offline = true; peer.disconnect(); gate.resolve(); }); await tick(100);
  expect(screen.getByTestId('profile-name')).toBeOnTheScreen();
  expect(messages()).toEqual([]);
  await fireEvent.press(screen.getByTestId('profile-close')); await tick(300); await layoutGatewayChat();
  expect(screen.queryByTestId('new-chat-agent-research')).toBeNull();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('');
  expect(screen.getByText('创建成功后掉线')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input')).toBeEnabled();
  expect(messages()).toEqual([]);
  await fireEvent.changeText(screen.getByTestId('composer-input'), '下一段正文');
  offline = false; await tick(2500);
  expect(messages()).toEqual([]);
  await fireEvent.press(screen.getByLabelText('消息发送失败')); await tick();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['创建成功后掉线']));
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('下一段正文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['创建成功后掉线', '下一段正文']));
  expect(creates).toHaveLength(1);
  expect(peer.state.conversations).toHaveLength(1);
});

test('chat.O5 目标 Agent 删除后同键取得明确拒绝，保留失败首文并允许换 Agent 再发', async () => {
  peer.overrides['POST /conversations'] = ({ body }, respond) => {
    creates.push(z.object({ agent_id: z.string(), client_id: z.string() }).parse(body));
    return creates.length === 1 ? jsonResponse({ error: { code: 'unavailable', message: '回执未确认' } }, 503) : respond();
  };
  await start();
  await fireEvent.press(screen.getByTestId('new-chat-agent-writer'));
  await fireEvent.changeText(screen.getByTestId('composer-input'), '目标删除也保留这条');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await act(async () => { await peer.fetch('https://gateway-l2.invalid/agents/writer', { method: 'DELETE' }); }); await tick(500);
  await layoutGatewayChat();
  await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick(); await layoutGatewayChat();
  await waitFor(() => expect(screen.getByTestId('new-chat-agent-research')).toBeEnabled());
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('');
  expect(screen.getByText('目标删除也保留这条')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input')).toBeEnabled();
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
  await fireEvent.press(screen.getByText('点按重试')); await tick();
  await waitFor(() => expect(messages().map(event => event.data.text)).toEqual(['目标删除也保留这条']));
  expect(peer.state.conversations[0].agent_id).toBe('research');
  expect(creates[2].client_id).not.toBe(creates[0].client_id);
});

test('chat.J4 新页目录确认已无 Agent 时回到已有零 Agent 入口，仍不创建对话', async () => {
  await renderGateway(peer, ChatRoute, '/chat', { ...routes, '/': EntryRoute });
  await waitFor(() => expect(screen.getByTestId('new-chat-agent-research')).toBeOnTheScreen());
  for (const id of ['writer', 'research']) {
    await act(async () => { await peer.fetch(`https://gateway-l2.invalid/agents/${id}`, { method: 'DELETE' }); }); await tick(500);
  }
  await waitFor(() => expect(screen.getByTestId('chat-entry-create-agent')).toBeEnabled());
  expect(creates).toEqual([]);
});

test('ADR-0079 F1 后台首发失败后重建 session，正常抽屉仍能找回并手动重试', async () => {
  seedGatewayConversation(peer, 'research', 'old-root').last_text = '旧对话';
  holdCreation();
  let sends = 0;
  peer.overrides['POST /conversations/:id/messages'] = () => {
    if (++sends === 1) return jsonResponse({ error: { code: 'unavailable', message: '未接受首发' } }, 503);
  };
  const first = await start();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '后台失败的首条原文');
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await fireEvent.press(screen.getByTestId('chat-agent-profile')); await tick(300);
  await act(() => releaseCreation?.()); await tick();
  expect(screen.getByTestId('profile-name')).toBeOnTheScreen();
  expect(sends).toBe(1);
  expect(messages()).toEqual([]);
  const id = peer.state.conversations.find(root => root.id !== 'old-root')!.id;
  await first.unmount(); await tick();
  await renderGateway(peer, CapturedChat, '/chat', routes, '/chat?id=old-root');
  await fireEvent.press(screen.getByTestId('chat-open-drawer')); await tick(300);
  expect(capturedSession?.pendingFor(id).map(item => [item.text, item.status])).toEqual([['后台失败的首条原文', 'failed']]);
  expect(screen.getByTestId(`conversation-${id}`)).toBeEnabled();
  expect(sends).toBe(1);
  const recovered = capturedSession!.pendingFor(id)[0];
  const emit = peer.emit.bind(peer);
  jest.spyOn(peer, 'emit').mockImplementation(event => { if (event.type !== 'message.user') emit(event); });
  await act(() => capturedSession!.retry(recovered.clientId)); await tick();
  expect(messages().map(event => event.data.text)).toEqual(['后台失败的首条原文']);
  expect(creates).toHaveLength(1);
  const receipt = acquireUploadDraft(capturedSession!.api, id, () => {});
  try { expect(receipt.controller.draft.firstSend).toBeUndefined(); }
  finally { receipt.release(); }
});

test('ADR-0079 F2 更早历史确认首消息后，只留正式消息、不留失败气泡和磁盘回执', async () => {
  const id = 'paginated-first-send', clientId = 'paginated-message';
  const events = Array.from({ length: 61 }, (_, index) => ({
    ...peer.event(index === 0 ? 'message.user' : 'message.agent', { text: index === 0 ? '最早已接受的首条' : `后续回复 ${index}`, agent: 'research', attachments: [] }, id),
    ...(index === 0 ? { client_id: clientId } : {}),
  }));
  const root = seedGatewayConversation(peer, 'research', id, events);
  root.last_text = '后续回复 60'; root.last_activity_seq = events.at(-1)!.seq;
  const older = Promise.withResolvers<void>();
  releaseCreation = older.resolve;
  peer.overrides['GET /conversations/:id/events'] = async ({ url, params }) => {
    if (params.id !== id) return;
    const before = url.searchParams.get('before');
    if (before !== null) await older.promise;
    return jsonResponse({ events: events.filter(event => before === null || event.seq < Number(before)).slice(-Number(url.searchParams.get('limit') ?? 50)), as_of_seq: peer.state.seq });
  };
  const api = new GatewayApi({ baseUrl: 'https://gateway-l2.invalid', token: 'test', computerId: 'l2' }, peer.fetch);
  const access = acquireUploadDraft(api, id, () => {});
  access.controller.adoptNewConversation({ computerId: 'l2', agentId: 'research', clientId: 'paginated-creation',
    messageClientId: clientId, kind: 'send', text: '最早已接受的首条', files: [] });
  access.controller.consume(); access.release(); api.close();
  await renderGateway(peer, CapturedChat, '/chat', {}, `/chat?id=${id}`);
  await layoutGatewayChat();
  const session = capturedSession!;
  expect(session.timeline(id).events.some(event => event.client_id === clientId)).toBe(false);
  expect(session.pendingFor(id).map(item => item.clientId)).toEqual([clientId]);
  await act(() => { older.resolve(); return session.loadOlder(id); }); await tick();
  const visible = projectChatRows({ events: session.timeline(id).events, pending: session.pendingFor(id) }).rows;
  expect(visible.filter(item => item.event?.client_id === clientId || item.pending?.clientId === clientId)).toHaveLength(1);
  expect(session.pendingFor(id)).toEqual([]);
  const restored = acquireUploadDraft(session.api, id, () => {});
  try { expect(restored.controller.draft.firstSend).toBeUndefined(); }
  finally { restored.release(); }
});
