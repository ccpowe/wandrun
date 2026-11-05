import { screen } from '@testing-library/react-native';
import FileRoute from '../src/app/files/[id]';
import { MessageRow } from '../src/components/chat/message-row';
import type { FileDetail, FileRecord, GatewayEvent } from '../src/gateway/api';
import { FakeGateway } from '../src/dev/fake-gateway';
import { useSession } from '../src/lib/session-context';
import { renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const record: FileRecord = { id: 'remote', name: 'remote.txt', size: 20, media_type: 'text/plain', conversation_id: null,
  agent_id: 'member', task_id: 'child', created_at: 1, remote_environment: 'ssh-lab' };
const remote: FileDetail = { ...record, available: false, error: 'remote_file_unsupported', error_message: '文件在远端环境 ssh-lab，暂不支持下载' };
const message: GatewayEvent = { seq: 3, type: 'message.task', conversation_id: 'root', at: 1,
  data: { task_id: 'child', sender_agent_id: 'member', recipient_agent_id: 'research', sender_task_id: 'child',
    recipient_task_id: 'root', text: 'Result', attachments: [record] } };
function MemberMessageRoute() {
  const session = useSession()!;
  return <MessageRow item={{ kind: 'event', key: 'e3', event: message,
    counterpart: { incoming: true, name: '成员', avatar: 0 } }} session={session} timelineId="root" />;
}
let peer: FakeGateway;
let contentRequests: number;
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); contentRequests = 0;
  seedGatewayAgent(peer); seedGatewayAgent(peer, { id: 'member', name: '成员' }); seedGatewayConversation(peer);
  peer.state.files.set('remote', remote);
  peer.overrides['GET /files/:id/content'] = () => {
    contentRequests++;
    peer.state.files.set('remote', remote);
    return Response.json({ error: { code: 'remote_file_unsupported', message: remote.error_message } }, { status: 409 });
  };
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('远端元数据显示服务端原因并禁用保存分享，不读取原文件字节', async () => {
  await renderGateway(peer, FileRoute, '/files/[id]', {}, '/files/remote');
  expect(screen.getByTestId('file-unavailable')).toHaveTextContent(remote.error_message!);
  expect(screen.getByTestId('file-download')).toBeDisabled();
  expect(screen.getByTestId('file-share')).toBeDisabled();
  expect(contentRequests).toBe(0);
});

test('原文件内容返回 409 后重读权威元数据，呈现远端拒绝而非移动或删除诊断', async () => {
  peer.state.files.set('remote', { ...record, remote_environment: null, available: true, error: null, error_message: null });
  await renderGateway(peer, FileRoute, '/files/[id]', {}, '/files/remote');
  expect(contentRequests).toBe(1);
  expect(await screen.findByTestId('file-unavailable')).toHaveTextContent(remote.error_message!);
  expect(screen.getByTestId('file-download')).toBeDisabled();
  expect(screen.getByTestId('file-share')).toBeDisabled();
});

test('成员消息的远端附件卡共享详情读取，显示服务端拒绝且不读取原文件字节', async () => {
  await renderGateway(peer, MemberMessageRoute, '/');
  expect(screen.getByTestId('attachment-remote')).toBeOnTheScreen();
  expect(screen.getByTestId('attachment-unavailable-remote')).toHaveTextContent(remote.error_message!);
  expect(contentRequests).toBe(0);
});

test('断线恢复中的旧元数据不能覆盖原文件拒绝后的重新核对', async () => {
  const available = { ...record, remote_environment: null, available: true, error: null, error_message: null };
  peer.state.files.set('remote', available);
  const oldMetadata = Promise.withResolvers<Response>();
  const content = Promise.withResolvers<Response>();
  let holdMetadata = false;
  let heldSignal: AbortSignal | undefined;
  peer.overrides['GET /files/:id'] = (context, respond) => {
    if (!holdMetadata) return respond();
    heldSignal = context.init.signal ?? undefined;
    return oldMetadata.promise.then(response => response.clone());
  };
  peer.overrides['GET /files/:id/content'] = () => { contentRequests++; return content.promise; };
  try {
    await renderGateway(peer, FileRoute, '/files/[id]', {}, '/files/remote');
    expect(contentRequests).toBe(1);
    holdMetadata = true;
    peer.disconnect(); await tick(1000);
    expect(heldSignal?.aborted).toBe(false);
    peer.state.files.set('remote', remote);
    holdMetadata = false;
    content.resolve(Response.json({ error: { code: 'remote_file_unsupported', message: remote.error_message } }, { status: 409 }));
    await tick();
    oldMetadata.resolve(Response.json(available));
    await tick();
    expect(await screen.findByTestId('file-unavailable')).toHaveTextContent(remote.error_message!);
    expect(screen.getByTestId('file-download')).toBeDisabled();
  } finally {
    oldMetadata.resolve(Response.json(available));
    content.resolve(Response.json({ error: { code: 'remote_file_unsupported', message: remote.error_message } }, { status: 409 }));
  }
});
