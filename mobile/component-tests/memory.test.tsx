import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import AgentProfileRoute from '../src/app/agents/[id]';
import MemoryReaderRoute from '../src/app/memory-reader';
import MemoryEditorRoute from '../src/app/memory-editor';
import MemoryDetailRoute from '../src/app/memory-detail';
import AboutYouRoute from '../src/app/settings-about-you';
import ChatRoute from '../src/app/chat';
import { FakeGateway } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
let peer: FakeGateway;
const routes = { '/agents/[id]': AgentProfileRoute, '/memory-reader': MemoryReaderRoute, '/memory-editor': MemoryEditorRoute, '/memory-detail': MemoryDetailRoute, '/settings-about-you': AboutYouRoute, '/chat': ChatRoute };
beforeEach(() => {
  jest.useFakeTimers(); peer = new FakeGateway(); seedGatewayAgent(peer); seedGatewayAgent(peer, { id: 'writer', name: '写作者' });
  for (const [path, content, id] of [['/agents/research/memory', '研究员独立记忆', 'research'], ['/agents/writer/memory', '写作者独立记忆', 'writer'], ['/memory/profile', '两位 Agent 共享偏好', undefined]] as const) {
    peer.state.memories.set(path, { scope: id ? 'work' : 'profile', ...(id ? { agent_id: id } : {}), content, version: 'v1', details: {}, limit: 1000, updated_at: null, updated_by: null });
  }
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

test('详情新建自动加入索引，成功删除同时去掉链接，保留其余索引正文', async () => {
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
  await fireEvent.press(screen.getByTestId('profile-memory-edit')); await tick();
  await fireEvent.press(screen.getByTestId('memory-editor-new-detail')); await tick();
  await fireEvent.changeText(screen.getByTestId('memory-detail-slug'), 'project');
  await fireEvent.changeText(screen.getByTestId('memory-detail-input'), '只属于这个项目的详情');
  await fireEvent.press(screen.getByTestId('memory-detail-save')); await tick();
  await fireEvent.press(screen.getByTestId('memory-editor-back')); await tick();
  await fireEvent.press(screen.getByTestId('memory-index-detail-project')); await tick();
  expect(screen.getByText('只属于这个项目的详情')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('memory-detail-delete')); await tick();
  expect(screen.getByTestId('memory-detail-delete-index')).toHaveDisplayValue(/研究员独立记忆/);
  expect(screen.getByTestId('memory-detail-delete-index').props.value).not.toContain('/details/project');
  await fireEvent.press(screen.getByTestId('memory-detail-delete-confirm')); await tick();
  expect(screen.getByTestId('memory-detail-delete-dialog')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('memory-detail-delete-submit')); await tick();
  expect(screen.queryByTestId('memory-index-detail-project')).toBeNull();
  expect(screen.getByText('研究员独立记忆')).toBeOnTheScreen();
});

test('切换 Agent 读各自工作记忆，关于你保持共享资源而不是上一个 Agent 缓存', async () => {
  await renderGateway(peer, AgentProfileRoute, '/agents/[id]', routes, '/agents/research');
  await fireEvent.press(screen.getByTestId('profile-tab-memory')); await tick();
  await fireEvent.press(screen.getByTestId('profile-work-memory')); await tick();
  expect(screen.getByText('研究员独立记忆')).toBeOnTheScreen();
  await act(async () => router.push('/agents/writer')); await tick();
  await fireEvent.press(screen.getByTestId('profile-tab-memory')); await tick();
  await fireEvent.press(screen.getByTestId('profile-work-memory')); await tick();
  expect(screen.getByText('写作者独立记忆')).toBeOnTheScreen();
  expect(screen.queryByText('研究员独立记忆')).toBeNull();
  await act(async () => router.push('/settings-about-you')); await tick();
  expect(screen.getByText('两位 Agent 共享偏好')).toBeOnTheScreen();
});

test.each(['两位 Agent 共享偏好', ''])('AY1 关于你顶栏唯一编辑入口进入编辑，正文=%s', async content => {
  peer.state.memories.set('/memory/profile', { ...peer.state.memories.get('/memory/profile')!, content });
  await renderGateway(peer, AboutYouRoute, '/settings-about-you', routes);
  const edit = within(screen.getByTestId('about-you-edit-action')).getByRole('button', { name: '编辑' });
  expect(screen.getAllByRole('button', { name: '编辑' })).toHaveLength(1);
  expect(edit).toBeEnabled();
  if (!content) {
    const empty = screen.getByTestId('profile-shared-memory-empty');
    expect(within(empty).getByText('还没有内容')).toBeOnTheScreen();
    expect(within(empty).queryByRole('button')).toBeNull();
  } else {
    expect(screen.getByTestId('profile-shared-memory-content')).toHaveTextContent(content);
  }
  await fireEvent.press(edit); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue(content);
});

test.each(['研究员独立记忆', ''])('AY1 工作记忆仍保留正文编辑入口，正文=%s', async content => {
  peer.state.memories.set('/agents/research/memory', { ...peer.state.memories.get('/agents/research/memory')!, content });
  await renderGateway(peer, MemoryReaderRoute, '/memory-reader', routes, '/memory-reader?scope=work&id=research');
  expect(screen.queryByTestId('about-you-edit-action')).toBeNull();
  const edit = screen.getByTestId('profile-memory-edit');
  if (!content) expect(within(screen.getByTestId('profile-empty-memory')).getByRole('button', { name: '编辑' })).toBeOnTheScreen();
  await fireEvent.press(edit); await tick();
  expect(screen.getByTestId('memory-editor-input')).toHaveDisplayValue(content);
});
