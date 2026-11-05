import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { View } from 'react-native';
import MemoryReaderRoute from '../src/app/memory-reader';
import { router } from 'expo-router';
import MemoryEditorRoute from '../src/app/memory-editor';
import MemoryDetailRoute from '../src/app/memory-detail';
import AboutYouRoute from '../src/app/settings-about-you';
import { FakeGateway, jsonResponse, unavailable } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const path = '/agents/research/memory';
const ref = { path: `/.wandrun/memory/work/details/topic/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
const next = { path: `/.wandrun/memory/work/details/next/${'b'.repeat(64)}.md`, sha256: 'b'.repeat(64) };
const routes = { '/memory-reader': MemoryReaderRoute, '/memory-editor': MemoryEditorRoute, '/memory-detail': MemoryDetailRoute, '/': () => <View testID="home" /> };
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer);
  peer.state.memories.set(path, { scope: 'work', agent_id: 'research', content: '索引正文', version: 'v1', details: { topic: ref }, limit: 1000, updated_at: null, updated_by: null });
  peer.state.memoryBodies.set(`${path}/details/topic`, '原详情');
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function openIndex() {
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
}
async function openDetail() {
  peer.state.memories.set(path, { ...peer.state.memories.get(path)!, content: `- [主题](${ref.path})` });
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
  await fireEvent.press(screen.getByTestId('memory-index-detail-topic')); await tick();
}
async function revision(content: string, version = 'v2', body = '远端详情') {
  await act(() => {
    peer.state.memories.set(path, { ...peer.state.memories.get(path)!, content, version });
    peer.state.memoryBodies.set(`${path}/details/topic`, body);
    peer.emit(peer.event('resource.changed', { kind: 'memory', scope: 'work', id: 'research', op: 'updated' }));
  }); await tick();
}
function submittedVersion(body: unknown): string {
  if (!body || typeof body !== 'object' || !('version' in body) || typeof body.version !== 'string') throw new Error('Memory write requires a CAS version');
  return body.version;
}

test('索引保存同一事件批次与在途期间都不能经新建或未引用详情离开，回执仅返回所属编辑器', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  peer.overrides['PUT /agents/:id/memory'] = async () => { writes++; await gate.promise; };
  await openIndex();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '本地稿');
  const save = screen.getByTestId('memory-editor-save');
  const create = screen.getByTestId('memory-editor-new-detail');
  const existing = screen.getByTestId('memory-editor-detail-topic');
  try {
    await act(async () => { await Promise.all([fireEvent.press(save), fireEvent.press(create), fireEvent.press(existing)]); }); await tick();
    expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('本地稿');
    expect(screen.getByTestId('memory-editor-new-detail')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('memory-editor-detail-topic')); await tick();
    expect(screen.queryByTestId('memory-detail-content')).toBeNull();
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId('profile-memory-content')).toHaveTextContent('本地稿');
    expect(writes).toBe(1);
  } finally { gate.resolve(); }
});

test('显式重载同一事件批次阻止新建、未引用详情与最新预览链接，完成后保留稿并恢复入口', async () => {
  const gate = Promise.withResolvers<void>();
  await openIndex();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '本地稿');
  await revision(`[预览](${ref.path})`);
  await fireEvent.press(screen.getByTestId('memory-editor-view-current'));
  const preview = within(screen.getByTestId('memory-editor-current')).getByText('预览');
  const create = screen.getByTestId('memory-editor-new-detail');
  const existing = screen.getByTestId('memory-editor-detail-topic');
  const reload = screen.getByTestId('memory-editor-reload');
  peer.overrides['GET /agents/:id/memory'] = async () => { await gate.promise; };
  try {
    await act(async () => { await Promise.all([fireEvent.press(reload), fireEvent.press(create), fireEvent.press(existing), fireEvent.press(preview)]); }); await tick();
    expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('本地稿');
    expect(screen.getByTestId('memory-editor-new-detail')).toBeDisabled();
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('本地稿');
    await fireEvent.press(screen.getByTestId('memory-editor-detail-topic')); await tick();
    expect(screen.getByTestId('memory-detail-content')).toHaveTextContent('远端详情');
  } finally { gate.resolve(); }
});

test('删除命令同一事件批次拒绝正文的旧链接回调，真实删除完成才返回阅读页', async () => {
  const gate = Promise.withResolvers<void>();
  peer.state.memories.set(path, { ...peer.state.memories.get(path)!, details: { topic: ref, next } });
  peer.state.memoryBodies.set(`${path}/details/topic`, `[下一条](${next.path})`);
  peer.state.memoryBodies.set(`${path}/details/next`, '下一条正文');
  await openDetail();
  const open = within(screen.getByTestId('memory-detail-content')).getByText('下一条');
  await fireEvent.press(screen.getByTestId('memory-detail-delete'));
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  const submit = screen.getByTestId('memory-detail-delete-submit');
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = async () => { await gate.promise; };
  try {
    await act(async () => { await Promise.all([fireEvent.press(submit), fireEvent.press(open)]); }); await tick();
    expect(screen.getByTestId('memory-detail-delete-index')).toBeOnTheScreen();
    expect(screen.queryByText('下一条正文')).toBeNull();
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId('profile-memory-edit')).toBeOnTheScreen();
    expect(peer.state.memories.get(path)?.details.topic).toBeUndefined();
    expect(peer.state.memories.get(path)?.details.next).toEqual(next);
  } finally { gate.resolve(); }
});

test('只读详情显示新同版正文，进入编辑才采用当前 CAS，而不是初次阅读基线', async () => {
  const versions: string[] = [];
  peer.overrides['PUT /agents/:id/memory/details/:slug'] = ({ body }) => { versions.push(submittedVersion(body)); };
  await openDetail();
  await revision(`[主题](${ref.path})`, 'v2', '刷新后的详情');
  await tick(1000);
  expect(screen.getByTestId('memory-detail-content')).toHaveTextContent('刷新后的详情');
  expect(screen.queryByTestId('memory-detail-conflict')).toBeNull();
  await fireEvent.press(screen.getByTestId('memory-detail-edit'));
  expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue('刷新后的详情');
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '在新版上编辑');
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  expect(versions).toEqual(['v2']);
  expect(peer.state.memoryBodies.get(`${path}/details/topic`)).toBe('在新版上编辑');
});

test('删除核对稿遇远端修订不丢；显式重载只换 CAS 基线，确认后保存用户核对稿', async () => {
  const versions: string[] = [];
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = ({ body }) => { versions.push(submittedVersion(body)); };
  await openDetail();
  await fireEvent.press(screen.getByTestId('memory-detail-delete'));
  await fireEvent.changeText(screen.getByTestId('memory-detail-delete-index'), '用户核对的索引');
  await revision(`远端索引\n[主题](${ref.path})`);
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveDisplayValue('用户核对的索引');
  expect(screen.getByTestId('memory-detail-current-index')).toHaveTextContent(/远端索引/);
  await fireEvent.press(screen.getByTestId('memory-detail-reload')); await tick();
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveDisplayValue('用户核对的索引');
  expect(screen.getByTestId('memory-detail-base-index')).toHaveTextContent(/远端索引/);
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(versions).toEqual(['v2']);
  expect(peer.state.memories.get(path)?.content).toBe('用户核对的索引');
  expect(peer.state.memories.get(path)?.details.topic).toBeUndefined();
});

test('共享记忆不受名为 profile 的 Agent 删除影响，索引和详情仍可阅读与编辑', async () => {
  seedGatewayAgent(peer, { id: 'profile', name: '同名 Agent' });
  const shared = { path: ref.path.replace('/work/', '/profile/'), sha256: ref.sha256 };
  peer.state.memories.set('/memory/profile', { scope: 'profile', content: '共享偏好', version: 'v1', details: { topic: shared }, limit: 1000, updated_at: null, updated_by: null });
  peer.state.memoryBodies.set('/memory/profile/details/topic', '共享详情');
  await renderGateway(peer, AboutYouRoute, '/settings-about-you', routes);
  await act(() => {
    peer.state.agents = peer.state.agents.filter(agent => agent.id !== 'profile');
    peer.emit(peer.event('resource.changed', { kind: 'agent', id: 'profile', op: 'deleted' }));
  }); await tick();
  expect(screen.getByTestId('profile-shared-memory-content')).toHaveTextContent('共享偏好');
  await fireEvent.press(screen.getByTestId('profile-shared-memory-edit')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('共享偏好');
  await fireEvent.press(screen.getByTestId('memory-editor-detail-topic')); await tick();
  expect(screen.getByTestId('memory-detail-content')).toHaveTextContent('共享详情');
  await fireEvent.press(screen.getByTestId('memory-detail-edit'));
  expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue('共享详情');
});

for (const shared of [false, true]) test(`${shared ? '共享' : '工作'}记忆 404：只撤销已不存在的 Agent 阅读面，共享失败仍留原页`, async () => {
  peer.overrides[shared ? 'GET /memory/profile' : 'GET /agents/:id/memory'] = () => unavailable('不存在', 404);
  if (shared) {
    await renderGateway(peer, AboutYouRoute, '/settings-about-you', routes);
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.queryByTestId('profile-shared-memory-content')).toBeNull();
    await tick(3000);
    expect(screen.getByRole('alert')).toBeOnTheScreen();
  } else {
    await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
    expect(screen.getByTestId('home')).toBeOnTheScreen();
    expect(screen.queryByTestId('profile-memory-edit')).toBeNull();
  }
});

test('删除核对中保留的带标题和引用式链接必须先人工移除，不能把仍引用详情的索引交给 DELETE', async () => {
  let writes = 0;
  peer.overrides['DELETE /agents/:id/memory/details/:slug'] = () => { writes++; };
  peer.state.memories.set(path, { ...peer.state.memories.get(path)!, content: `Before [主题](${ref.path} "title") after\n[引用][ref]\n\n[ref]: ${ref.path} "title"\n` });
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
  await fireEvent.press(screen.getByText('主题')); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-delete'));
  expect(screen.getByTestId('memory-detail-delete-index').props.value).toContain(ref.path);
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  expect(screen.queryByTestId('memory-detail-delete-dialog')).toBeNull();
  expect(writes).toBe(0);
  expect(peer.state.memories.get(path)?.details.topic).toEqual(ref);
  await fireEvent.changeText(screen.getByTestId('memory-detail-delete-index'), 'Before 主题 after');
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(writes).toBe(1);
  expect(peer.state.memories.get(path)?.content).toBe('Before 主题 after');
  expect(peer.state.memories.get(path)?.details.topic).toBeUndefined();
});

test('409 后补读的旧详情晚于新修订返回时不能回填对比正文；显式重载后仅以最新 CAS 保存本地稿', async () => {
  const gate = Promise.withResolvers<void>();
  const versions: string[] = [];
  let lateReads = 0, reject = true;
  peer.overrides['PUT /agents/:id/memory/details/:slug'] = ({ body }) => {
    versions.push(submittedVersion(body));
    if (reject) {
      reject = false;
      peer.state.memories.set(path, { ...peer.state.memories.get(path)!, version: 'v2' });
      peer.state.memoryBodies.set(`${path}/details/topic`, '旧详情');
      return jsonResponse({ error: { message: 'conflict', current: peer.state.memories.get(path)! } }, 409);
    }
  };
  peer.overrides['GET /agents/:id/memory/details/:slug'] = async (_context, respond) => {
    if (peer.state.memories.get(path)?.version === 'v2') {
      lateReads++;
      const old = await respond();
      await gate.promise;
      return old;
    }
  };
  await openDetail();
  await fireEvent.press(screen.getByTestId('memory-detail-edit'));
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '本地正文');
  try {
    await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
    expect(screen.getByTestId('memory-detail-conflict')).toBeOnTheScreen();
    expect(lateReads).toBe(1);
    await revision(`- [主题](${ref.path})`, 'v3', '最新正文'); await tick(1000);
    expect(screen.getByTestId('memory-detail-current')).toHaveTextContent('最新正文');
    await act(() => gate.resolve()); await tick();
    expect(screen.getByTestId('memory-detail-current')).toHaveTextContent('最新正文');
    expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue('本地正文');
    expect(screen.getByTestId('memory-detail-save')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('memory-detail-reload')); await tick();
    await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
    expect(versions).toEqual(['v1', 'v3']);
    expect(peer.state.memoryBodies.get(`${path}/details/topic`)).toBe('本地正文');
  } finally { gate.resolve(); }
});

test('保留 F3 原契约：SSE 断开不预先禁 CAS 保存，HTTP 仍可达时按原版本保存并返回实际正文', async () => {
  const versions: string[] = [];
  peer.overrides['PUT /agents/:id/memory'] = ({ body }) => { versions.push(submittedVersion(body)); };
  await openIndex();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '连接中断期间主动保存');
  await act(() => {
    peer.overrides['GET /events'] = () => unavailable();
    peer.disconnect();
  }); await tick(5000);
  expect(screen.getByTestId('memory-editor-save')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('memory-editor-save')); await tick();
  expect(versions).toEqual(['v1']);
  expect(peer.state.memories.get(path)?.content).toBe('连接中断期间主动保存');
  expect(screen.getByTestId('profile-memory-content')).toHaveTextContent('连接中断期间主动保存');
  expect(screen.queryByTestId('memory-save-unconfirmed')).toBeNull();
});

for (const detail of [false, true]) test(`工作记忆${detail ? '详情' : '索引'} PUT 404 结束忙态并直接回首页，只提交一次`, async () => {
  let writes = 0;
  peer.overrides[detail ? 'PUT /agents/:id/memory/details/:slug' : 'PUT /agents/:id/memory'] = () => {
    writes++;
    return unavailable('Agent 已不存在', 404);
  };
  if (detail) {
    await openDetail();
    await fireEvent.press(screen.getByTestId('memory-detail-edit'));
  } else await openIndex();
  const prefix = detail ? 'memory-detail' : 'memory-editor';
  await fireEvent.changeText(screen.getByTestId(`${prefix}-input`), '删除前的本地稿');
  await fireEvent.press(screen.getByTestId(`${prefix}-save`)); await tick();
  expect(screen.getByTestId('home')).toBeOnTheScreen();
  expect(screen.queryByTestId(`${prefix}-input`)).toBeNull();
  expect(writes).toBe(1);
});

test('索引脏稿打开详情再返回仍保留，不因聚焦 GET 自动重建', async () => {
  await openIndex();
  await fireEvent.changeText(screen.getByTestId('memory-editor-input'), '打开详情前的索引草稿');
  await fireEvent.press(screen.getByTestId('memory-editor-detail-topic')); await tick();
  expect(screen.getByTestId('memory-detail-content')).toHaveTextContent('原详情');
  await fireEvent.press(screen.getByTestId('memory-detail-back')); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue('打开详情前的索引草稿');
  expect(peer.state.memories.get(path)?.content).toBe('索引正文');
});

test('详情编辑失焦后断线，旧 GET 迟到不回填；回到详情仍保留本地稿与原 CAS', async () => {
  const gate = Promise.withResolvers<void>();
  await openDetail();
  await fireEvent.press(screen.getByTestId('memory-detail-edit'));
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '详情本地稿');
  peer.overrides['GET /agents/:id/memory/details/:slug'] = async (_, respond) => { const response = await respond(); await gate.promise; return response; };
  try {
    await revision(`[主题](${ref.path})`, 'v2', '迟到的远端正文');
    await act(() => router.push('/memory-reader?scope=work&id=research')); await tick();
    await act(() => { peer.overrides['GET /events'] = () => unavailable(); peer.disconnect(); }); await tick(2000);
    await act(() => gate.resolve()); await tick();
    await act(() => router.back()); await tick();
    expect(screen.getByTestId('memory-detail-input')).toHaveDisplayValue('详情本地稿');
    expect(screen.getByTestId('memory-detail-save')).toBeDisabled();
    expect(peer.state.memoryBodies.get(`${path}/details/topic`)).toBe('迟到的远端正文');
  } finally { gate.resolve(); }
});
