import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import ChatRoute from '../src/app/chat';
import type { GatewayEvent } from '../src/gateway/api';
import { FakeGateway } from '../src/dev/fake-gateway';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));

// Path from docs/research/app-chat-refactor-plan-2026-10-31.md §2.3, through the real route, session,
// upload controller (tus to the fake peer) and LegendList. Only native layout and the picker are supplied.
const history = (): GatewayEvent[] => Array.from({ length: 12 }, (_, index) => ({
  seq: index + 1, at: index + 1, conversation_id: 'root',
  ...(index % 2 ? { type: 'message.agent', data: { agent_id: 'research', text: `第 ${index + 1} 条回复` } }
    : { type: 'message.user', data: { text: `第 ${index + 1} 条问题` } }),
}) as GatewayEvent);

let peer: FakeGateway;
let releaseHttp: PromiseWithResolvers<void> | undefined;
beforeEach(() => {
  jest.useFakeTimers();
  releaseHttp = undefined;
  // The peer persists and emits message.user over SSE first; the HTTP receipt is then held.
  peer = new FakeGateway({}, {
    'POST /conversations/:id/messages': async (_context, respond) => {
      const receipt = await respond();
      if (releaseHttp) await releaseHttp.promise;
      return receipt;
    },
  });
  seedGatewayAgent(peer);
  seedGatewayConversation(peer, 'research', 'root', history());
  Object.assign(peer.state.conversations[0], { last_text: '第 12 条回复', last_activity_seq: 12, last_agent_seq: 12, read_seq: 12 });
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 800, 0, 0));
});
afterEach(() => { releaseHttp?.resolve(); peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

async function attachFile() {
  const source = new File(Paths.document, 'send-path.txt');
  source.write('引用后附上的原文件');
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValue({ canceled: false, assets: [{ uri: source.uri, name: 'notes.txt', size: source.size, mimeType: 'text/plain', lastModified: 1 }] });
  await fireEvent.press(screen.getByTestId('composer-add')); await tick();
  await fireEvent(screen.getByTestId('attachment-picker-dismiss'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
  await fireEvent(screen.getByTestId('attachment-picker-menu'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 220 } } });
  await fireEvent.press(screen.getByTestId('attachment-picker-file')); await tick();
  return source;
}

test('chat.C6 B6 T2 T5 T8 旧消息 READ → 引用 + 附件 → 发送 → SSE 先于 HTTP 只有一条 → 流式预览转正式无重复', async () => {
  await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=root&message_seq=4');
  await layoutGatewayChat();
  // Target placement holds READ: the jump button is shown and the old message is highlighted.
  expect(await screen.findByTestId('message-target-4')).toBeOnTheScreen();
  expect(screen.getByTestId('chat-return-to-bottom')).toBeOnTheScreen();

  // Quote the old Agent reply (its action row), then add a real uploaded attachment.
  await fireEvent.press(screen.getByTestId('message-quote-e4'));
  expect(screen.getByTestId('composer-quote')).toHaveTextContent('第 4 条回复');
  const source = await attachFile();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '按这条继续');
  await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());

  releaseHttp = Promise.withResolvers<void>();
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  // Local acceptance: quote and draft consumed. Sending ends the target's READ; the send's end request is animated,
  // and Jest's real list never completes an animated scroll, so whether the arrow hides is not asserted here
  // (request: chat-send-pin; on screen: device matrix).
  expect(screen.getByTestId('composer-input').props.value).toBe('');
  expect(screen.queryByTestId('composer-quote')).toBeNull();

  // SSE confirmed before the HTTP receipt: exactly one user row for this text.
  const sent = peer.state.histories.get('root')!.filter(event => event.type === 'message.user' && event.data.text.includes('按这条继续'));
  expect(sent).toHaveLength(1);
  expect(sent[0].data.text.startsWith('> 第 4 条回复')).toBe(true);
  expect(sent[0].data.attachments).toHaveLength(1);
  await layoutGatewayChat();
  expect(screen.getAllByText(/按这条继续/)).toHaveLength(1);
  expect(screen.queryByTestId(/^message-sending-/)).toBeNull(); // the SSE row replaced the local pending bubble
  releaseHttp.resolve(); await tick();
  await layoutGatewayChat();
  expect(screen.getAllByText(/按这条继续/)).toHaveLength(1);

  // The stream preview disappears when its durable reply arrives; only the final text remains.
  await act(async () => peer.emit({ type: 'draft.snapshot', data: { epoch: 'e', revision: 1, as_of_seq: sent[0].seq,
    drafts: [{ draft_id: 'reply', conversation_id: 'root', sender: 'root', agent: 'research', text: '正在整理', phase: null }] } } as unknown as GatewayEvent));
  await tick(300); await layoutGatewayChat();
  expect(within(screen.getByTestId('draft-reply')).getByText('正在整理', { exact: false })).toBeOnTheScreen();
  await act(async () => peer.emit(peer.event('message.agent', { draft_id: 'reply', agent_id: 'research', text: '整理完成', status: 'completed' }, 'root')));
  await tick(300); await layoutGatewayChat();
  expect(screen.getByText('整理完成')).toBeOnTheScreen();
  expect(screen.queryByTestId('draft-reply')).toBeNull();
  expect(screen.getAllByText('整理完成')).toHaveLength(1);
  source.delete();
});
