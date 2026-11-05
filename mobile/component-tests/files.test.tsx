import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { onlineManager } from '@tanstack/react-query';
import SearchRoute from '../src/app/search';
import FileRoute from '../src/app/files/[id]';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
// Expo's re-export getters are non-configurable; keep the real API but make the native handoff spyable.
jest.mock('expo-sharing', () => ({ ...jest.requireActual('expo-sharing') }));
let peer: FakeGateway;
const content = '原文件通过共享假网关进入预览、保存与分享。';
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer);
  peer.state.files.set('original', { id: 'original', name: 'handoff.txt', size: new TextEncoder().encode(content).length, media_type: 'text/plain', conversation_id: null, agent_id: 'research', task_id: 'root', created_at: 1, remote_environment: null, available: true, error: null, error_message: null });
  peer.state.files.set('other', { ...peer.state.files.get('original')!, id: 'other', name: 'handoff-other.txt', agent_id: 'writer' });
  peer.state.fileBytes.set('original', new TextEncoder().encode(content));
  peer.state.fileBytes.set('other', new TextEncoder().encode(content));
});
afterEach(() => { onlineManager.setOnline(true); peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('作用域与全局搜索点原文件进入实际预览，文件丢失后提示不可用并禁下载分享', async () => {
  await renderGateway(peer, SearchRoute, '/search', { '/files/[id]': FileRoute }, '/search?agent_id=research');
  await fireEvent.changeText(screen.getByTestId('search-input'), 'handoff'); await tick(300);
  expect(screen.getByTestId('search-result-file-original')).toBeOnTheScreen();
  expect(screen.queryByTestId('search-result-file-other')).toBeNull();
  await fireEvent.press(screen.getByTestId('search-result-file-original')); await tick();
  expect(screen.getByTestId('file-text-preview')).toHaveTextContent(content);
  expect(screen.getByTestId('file-download')).toBeEnabled();
  expect(screen.getByTestId('file-share')).toBeEnabled();
  await act(async () => router.push('/search')); await tick();
  await fireEvent.changeText(screen.getByTestId('search-input'), 'handoff'); await tick(300);
  expect(screen.getByTestId('search-result-file-other')).toBeOnTheScreen();
  peer.state.files.set('original', { ...peer.state.files.get('original')!, available: false, error: 'missing', error_message: '原文件已不存在' });
  await fireEvent.press(screen.getByTestId('search-result-file-original')); await tick();
  expect(screen.getByTestId('file-unavailable')).toHaveTextContent(/原文件已不存在/);
  expect(screen.getByTestId('file-download')).toBeDisabled();
  expect(screen.getByTestId('file-share')).toBeDisabled();
});

test('search.A2 A6 A8 去抖丢弃旧词，失败的第二页重试不丢首屏', async () => {
  const offsets: number[] = [];
  let failMore = true;
  peer.overrides['GET /search'] = ({ url }) => {
    expect(url.searchParams.get('q')).toBe('handoff');
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    if (offset && failMore) return Response.json({ error: { code: 'unavailable', message: '搜索失败' } }, { status: 503 });
    return Response.json({ results: Array.from({ length: offset ? 1 : 30 }, (_, index) => ({
      kind: 'file', id: `file-${offset + index}`, title: `result-${offset + index}`,
      file: { ...peer.state.files.get('original')!, id: `file-${offset + index}` },
    })), total: 31, as_of_seq: 1 });
  };
  await renderGateway(peer, SearchRoute, '/search');
  await fireEvent.changeText(screen.getByTestId('search-input'), 'discarded'); await tick(100);
  await fireEvent.changeText(screen.getByTestId('search-input'), 'handoff'); await tick(300);
  expect(offsets).toEqual([0]);
  await fireEvent.press(screen.getByTestId('search-more')); await tick();
  expect(screen.getByTestId('search-result-file-file-0')).toBeOnTheScreen();
  expect(screen.getByText('搜索失败')).toBeOnTheScreen();
  failMore = false;
  await fireEvent.press(screen.getByText('重试')); await tick();
  expect(screen.getByTestId('search-result-file-file-30')).toBeOnTheScreen();
  expect(screen.getByTestId('search-result-file-file-0')).toBeOnTheScreen();
  expect(screen.queryByTestId('search-more')).toBeNull();
  expect(offsets).toEqual([0, 30, 30]);
});

test('search.A6 A8 返回搜索保留已加载的两页，不重新读取或清空结果', async () => {
  const offsets: number[] = [];
  const results = Array.from({ length: 31 }, (_, index) => {
    const file = { ...peer.state.files.get('original')!, id: `result-${index}`, name: `handoff-${index}.txt` };
    peer.state.files.set(file.id, file);
    peer.state.fileBytes.set(file.id, new TextEncoder().encode(content));
    return { kind: 'file', id: file.id, title: file.name, file };
  });
  peer.overrides['GET /search'] = ({ url }) => {
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return Response.json({ results: results.slice(offset, offset + 30), total: 31, as_of_seq: 1 });
  };
  await renderGateway(peer, SearchRoute, '/search', { '/files/[id]': FileRoute });
  await fireEvent.changeText(screen.getByTestId('search-input'), 'handoff'); await tick(300);
  await fireEvent.press(screen.getByTestId('search-more')); await tick();
  await fireEvent.press(screen.getByTestId('search-result-file-result-30')); await tick();
  expect(screen.getByTestId('file-text-preview')).toHaveTextContent(content);
  await tick(6 * 60_000); // A detail visit must not expire the still-mounted search.
  await act(() => router.back());
  expect(screen.getByTestId('search-result-file-result-0')).toBeOnTheScreen();
  expect(screen.getByTestId('search-result-file-result-30')).toBeOnTheScreen();
  await tick(300);
  expect(offsets).toEqual([0, 30]);
  expect(screen.queryByTestId('search-more')).toBeNull();
});

test('search.A7 离线启发式不把原有失败与重试反馈变成空白', async () => {
  let requests = 0;
  peer.overrides['GET /search'] = () => {
    requests++;
    return Response.json({ error: { code: 'unavailable', message: '搜索暂不可用' } }, { status: 503 });
  };
  await renderGateway(peer, SearchRoute, '/search');
  await act(() => onlineManager.setOnline(false));
  await fireEvent.changeText(screen.getByTestId('search-input'), 'handoff'); await tick(300);
  expect(requests).toBe(1);
  expect(screen.getByText('搜索暂不可用')).toBeOnTheScreen();
  expect(screen.getByText('重试')).toBeOnTheScreen();
});

test('文件页点保存和分享都接收同一 peer 的真实响应字节', async () => {
  const directory = new Directory(Paths.document, 'l2-saved-files');
  directory.create({ intermediates: true, idempotent: true });
  jest.spyOn(Directory, 'pickDirectoryAsync').mockResolvedValue(directory);
  jest.spyOn(Sharing, 'isAvailableAsync').mockResolvedValue(true);
  const shared: string[] = [];
  jest.spyOn(Sharing, 'shareAsync').mockImplementation(async uri => { shared.push(await new File(uri).text()); });
  try {
    await renderGateway(peer, FileRoute, '/files/[id]', {}, '/files/original');
    expect(screen.getByTestId('file-text-preview')).toHaveTextContent(content);
    await fireEvent.press(screen.getByTestId('file-download')); await tick();
    expect(screen.getByTestId('file-saved')).toBeOnTheScreen();
    expect(await new File(directory, 'handoff.txt').text()).toBe(content);
    await fireEvent.press(screen.getByTestId('file-share')); await tick();
    expect(shared).toEqual([content]);
  } finally { directory.delete(); }
});

test('files.A2 三秒内自动恢复完全不显示横幅，恢复后显示正文与交付入口', async () => {
  let calls = 0;
  peer.overrides['GET /files/:id'] = (_context, respond) => ++calls === 1
    ? Response.json({ error: { code: 'unavailable', message: 'temporary' } }, { status: 503 }) : respond();
  await renderGateway(peer, FileRoute, '/files/[id]', {}, '/files/original');
  expect(screen.queryByText('无法读取文件信息，正在重试…')).toBeNull();
  expect(screen.queryByTestId('file-text-preview')).toBeNull();
  expect(screen.getByTestId('file-download')).toBeDisabled();
  await tick(500);
  expect(screen.getByTestId('file-text-preview')).toHaveTextContent(content);
  expect(screen.queryByText('无法读取文件信息，正在重试…')).toBeNull();
});

test('files.B1 文件保存中禁止重复操作；失败保留正文并恢复再次保存', async () => {
  const picker = Promise.withResolvers<Directory>();
  jest.spyOn(Directory, 'pickDirectoryAsync').mockImplementation(() => picker.promise);
  await renderGateway(peer, FileRoute, '/files/[id]', {}, '/files/original');
  await fireEvent.press(screen.getByTestId('file-download')); await tick();
  expect(screen.getByRole('button', { name: '正在保存文件' })).toBeDisabled();
  expect(screen.getByTestId('file-share')).toBeDisabled();
  await act(async () => { picker.reject(new Error('storage unavailable')); }); await tick();
  expect(screen.getByTestId('file-action-error')).toBeOnTheScreen();
  expect(screen.getByTestId('file-text-preview')).toHaveTextContent(content);
  expect(screen.getByTestId('file-download')).toBeEnabled();
});
