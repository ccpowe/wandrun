import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import ChatRoute from '../src/app/chat';
import type { GatewayEvent } from '../src/gateway/api';
import { FakeGateway } from '../src/dev/fake-gateway';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));

// chat.B12 / C7 / G7: this screen's own action results are shown in place under the banner,
// never as system dialogs. Real route, upload controller and session; only the native file
// write / picker boundary fails on purpose.
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers();
  peer = new FakeGateway();
  seedGatewayAgent(peer);
  seedGatewayConversation(peer, 'research', 'root', [{ seq: 1, at: 1, type: 'message.user', conversation_id: 'root', data: { text: '第一条' } } as GatewayEvent]);
  Object.assign(peer.state.conversations[0], { last_text: '第一条', last_activity_seq: 1 });
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 800, 0, 0));
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

async function pickFile() {
  await fireEvent.press(screen.getByTestId('composer-add')); await tick();
  await fireEvent(screen.getByTestId('attachment-picker-dismiss'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
  await fireEvent(screen.getByTestId('attachment-picker-menu'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 220 } } });
  await fireEvent.press(screen.getByTestId('attachment-picker-file')); await tick();
}
/** The draft snapshot cannot be written (e.g. storage full): the commit fails, the draft stays. */
const failDraftWrites = () => jest.spyOn(File.prototype, 'write').mockImplementation(() => { throw new Error('ENOSPC'); });

test('chat.B12 发送时草稿写盘失败：就地提示草稿仍在，可关闭；发送成功清掉旧提示', async () => {
  await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=root');
  await layoutGatewayChat();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '这条要发出去');
  await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
  const writes = failDraftWrites();
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  const notice = screen.getByTestId('chat-local-send');
  expect(within(notice).getByText('无法发送')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-input').props.value).toBe('这条要发出去');
  writes.mockRestore();
  // A later successful send clears the old failure.
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  expect(screen.queryByTestId('chat-local-send')).toBeNull();
  expect(screen.getAllByText('这条要发出去').length).toBeGreaterThan(0);
});

test('chat.B12 选附件失败与移除附件失败：就地提示，点“关闭提示”收起', async () => {
  await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=root');
  await layoutGatewayChat();
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockRejectedValueOnce(new Error('permission denied'));
  await pickFile();
  expect(within(screen.getByTestId('chat-local-pick')).getByText('添加附件失败')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('chat-local-dismiss')); await tick();
  expect(screen.queryByTestId('chat-local-pick')).toBeNull();

  const source = new File(Paths.document, 'notice-attachment.txt');
  source.write('附件');
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValue({ canceled: false, assets: [{ uri: source.uri, name: 'notice.txt', size: source.size, mimeType: 'text/plain', lastModified: 1 }] });
  await pickFile();
  const remove = await screen.findByLabelText('移除附件 notice.txt');
  const writes = failDraftWrites();
  await fireEvent.press(remove); await tick();
  expect(within(screen.getByTestId('chat-local-remove')).getByText('无法移除附件')).toBeOnTheScreen();
  writes.mockRestore();
  source.delete();
});

test('chat.G7 C7 本次操作失败优先于“消息不存在”；逐条关闭，最后一条结束定位', async () => {
  await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=root&message_seq=99');
  await layoutGatewayChat();
  expect(screen.getByTestId('chat-local-missing')).toBeOnTheScreen();
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockRejectedValueOnce(new Error('permission denied'));
  await pickFile();
  expect(screen.getByTestId('chat-local-pick')).toBeOnTheScreen();
  expect(screen.queryByTestId('chat-local-missing')).toBeNull(); // one hint at a time
  await fireEvent.press(screen.getByTestId('chat-local-dismiss')); await tick();
  expect(screen.getByTestId('chat-local-missing')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('chat-local-dismiss')); await tick();
  expect(screen.queryByTestId('chat-local-missing')).toBeNull();
  expect(screen.queryByTestId('chat-return-to-bottom')).toBeNull();
});
