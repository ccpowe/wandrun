import { fireEvent, screen } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import ChatRoute from '../src/app/chat';
import FileRoute from '../src/app/files/[id]';
import { FakeGateway } from '../src/dev/fake-gateway';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer); seedGatewayConversation(peer);
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 800, 0, 0));
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('系统选择器边界返回文件后，真实 tus 上传让纯附件可发，发送清草稿且原字节与消息卡一致', async () => {
  const source = new File(Paths.document, 'e2e-l2-attachment.txt');
  source.write('原始附件字节，不在消息正文重复。');
  jest.spyOn(DocumentPicker, 'getDocumentAsync').mockResolvedValue({ canceled: false, assets: [{ uri: source.uri, name: 'attachment.txt', size: source.size, mimeType: 'text/plain', lastModified: 1 }] });
  await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=root');
  await layoutGatewayChat();
  await fireEvent.press(screen.getByTestId('composer-add')); await tick();
  await fireEvent(screen.getByTestId('attachment-picker-dismiss'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } } });
  await fireEvent(screen.getByTestId('attachment-picker-menu'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 180, height: 220 } } });
  for (const source of ['camera', 'photos', 'video', 'file']) expect(screen.getByTestId(`attachment-picker-${source}`)).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('attachment-picker-file')); await tick();
  expect(screen.queryByTestId('attachment-picker-menu')).toBeNull();
  expect(await screen.findByTestId('composer-send')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  await layoutGatewayChat();
  const events = peer.state.histories.get('root')!.filter(event => event.type === 'message.user');
  expect(events).toHaveLength(1);
  expect(events[0].data.text).toBe('');
  const [file] = events[0].data.attachments;
  expect(new TextDecoder().decode(peer.state.fileBytes.get(file.id))).toBe('原始附件字节，不在消息正文重复。');
  expect(screen.getByTestId(`attachment-${file.id}`)).toBeOnTheScreen();
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  source.delete();
});

test('attachment.A4 超过四个原文件折叠，展开后能打开第五份独立正文', async () => {
  const files = Array.from({ length: 5 }, (_, index) => {
    const bytes = new TextEncoder().encode(`第 ${index + 1} 份原文件正文`);
    const file = { id: `report-${index + 1}`, name: `report-${index + 1}.txt`, size: bytes.length, media_type: 'text/plain',
      conversation_id: 'root', agent_id: 'research', task_id: 'root', created_at: 1, source: 'agent' as const, remote_environment: null };
    peer.state.files.set(file.id, { ...file, available: true, error: null, error_message: null });
    peer.state.fileBytes.set(file.id, bytes);
    return file;
  });
  peer.state.seq = 20;
  Object.assign(peer.state.conversations.find(row => row.id === 'root')!, { last_activity_seq: 20, last_agent_seq: 20, last_text: '附件资料' });
  peer.state.histories.set('root', [{ seq: 20, type: 'message.agent', at: 2, conversation_id: 'root',
    data: { agent_id: 'research', text: '附件资料', attachments: files } }]);
  await renderGateway(peer, ChatRoute, '/chat', { '/files/[id]': FileRoute }, '/chat?id=root');
  await layoutGatewayChat();
  expect(screen.getByRole('button', { name: '查看文件 report-4.txt' })).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '查看文件 report-5.txt' })).toBeNull();
  await fireEvent.press(screen.getByTestId('attachment-file-more')); await tick();
  await fireEvent.press(screen.getByRole('button', { name: '查看文件 report-5.txt' })); await tick();
  expect(screen.getByTestId('file-text-preview')).toHaveTextContent('第 5 份原文件正文');
});
