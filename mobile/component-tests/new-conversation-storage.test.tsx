import { File, Paths } from 'expo-file-system';
import { GatewayError } from '../src/gateway/api';
import { nativeNewConversation, stageNewAttachments } from '../src/lib/new-conversation-storage';
import type { NewChatHost } from '../src/lib/new-conversation';

test('chat.O5 首附件创建被拒后重启保留文字与owned字节，逐个移除不删源文件或另一附件', async () => {
  const a = new File(Paths.document, 'storage-source-a.txt'); a.write('first source bytes');
  const b = new File(Paths.document, 'storage-source-b.txt'); b.write('second source bytes');
  const store = nativeNewConversation();
  store.select('storage-test', 'agent'); store.setText('最初未发送正文');
  const host: NewChatHost = {
    computerId: 'storage-test', online: () => true, current: () => true, storeVersion: () => 0,
    create: async () => { throw new GatewayError(404, 'not_found', 'Agent不存在'); },
    bind: () => { throw new Error('A rejected creation has no real target to bind'); },
  };
  await store.submit(host, { create: 'storage-create', message: 'storage-message' }, () => stageNewAttachments([
    { uri: a.uri, name: 'a.txt', size: a.size, mimeType: 'text/plain' },
    { uri: b.uri, name: 'b.txt', size: b.size, mimeType: 'text/plain' },
  ], 'storage-create'));
  store.setText('失败后继续编辑的正文');
  const restarted = nativeNewConversation(); restarted.restore();
  const before = restarted.getSnapshot();
  expect(before.status).toBe('editing');
  if (before.status !== 'editing' || !before.saved.failure) throw new Error('failed first attachment was not restored');
  expect(before.saved.text).toBe('失败后继续编辑的正文');
  expect(before.saved.failure.attempt.text).toBe('最初未发送正文');
  const [first, second] = before.saved.failure.attempt.files;
  expect(new File(first.uri).textSync()).toBe('first source bytes');
  expect(new File(second.uri).textSync()).toBe('second source bytes');
  restarted.removeFailedAttachment(first.id);
  expect(new File(first.uri).exists).toBe(false);
  expect(new File(second.uri).textSync()).toBe('second source bytes');
  const reopened = nativeNewConversation(); reopened.restore();
  const after = reopened.getSnapshot();
  if (after.status !== 'editing') throw new Error('remaining attachment is not editable');
  expect(after.saved.failure?.attempt.files.map(item => item.name)).toEqual(['b.txt']);
  reopened.removeFailedAttachment(second.id);
  expect(new File(second.uri).exists).toBe(false);
  const finished = reopened.getSnapshot();
  if (finished.status !== 'editing') throw new Error('discarding the failed attachment changed the draft phase');
  expect(finished.saved.failure).toBeUndefined();
  expect(finished.saved.text).toBe('失败后继续编辑的正文');
  expect(a.textSync()).toBe('first source bytes'); expect(b.textSync()).toBe('second source bytes');
});
