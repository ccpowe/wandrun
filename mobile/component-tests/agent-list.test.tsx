import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import * as stories from '../src/dev/agent-list.stories';
import { agentListScenario } from '../src/dev/agent-list-scenario';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
jest.mock('@gorhom/bottom-sheet', () => {
  const official = jest.requireActual('@gorhom/bottom-sheet/mock');
  class Sheet extends official.default { close() { this.props.onClose?.(); } }
  return { __esModule: true, ...official, default: Sheet };
});
const Stories = composeStories(stories);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const tick = async (ms = 0) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const rowIds = () => screen.getAllByTestId(/^agent-row-container-/).map(row => row.props.testID.replace('agent-row-container-', ''));

test('agent-list.A3 A4 读取失败不冒充空列表，后台恢复后显示目录', async () => {
  const peer = agentListScenario('A4');
  await render(<Stories.A4 scenario={peer} />);
  await tick(200);
  await tick(3000);
  expect(screen.getByText('无法加载 Agent，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByText('还没有 Agent')).toBeNull();
  peer.recover(); await tick(200);
  expect(screen.queryByText('无法加载 Agent，正在重试…')).toBeNull();
  expect(rowIds()).toEqual(['planner', 'search_agent', 'executor', 'browser_agent', 'research_assistant', 'device_agent']);
});

test('agent-list.B5 编辑笔进入对应表单而不打开资料或创建对话，离线后禁用编辑', async () => {
  const peer = agentListScenario();
  await render(<Stories.A1 scenario={peer} />);
  await tick(200);
  // L2 exercises the revealed action; native swipe recognition belongs to SwipeRow.
  await fireEvent.press(screen.getByLabelText('编辑 planner'));
  await tick(200);
  expect(screen.getByTestId('editor-name')).toHaveDisplayValue('planner');
  expect(screen.queryByTestId('profile-name')).toBeNull();
  expect(peer.opens).toBe(0);
  await fireEvent.press(screen.getByTestId('editor-back'));
  await tick(200);
  peer.disconnect(); await tick(400);
  expect(screen.getByLabelText('编辑 planner')).toBeDisabled();
});

test('agent-list.A2 A3 首次读取不冒充空态，成功零项才能从空态进入创建', async () => {
  const peer = agentListScenario('A2');
  const mounted = await render(<Stories.A2 scenario={peer} />);
  await tick(200);
  expect(screen.getByTestId('agents-add')).toBeEnabled();
  expect(screen.getByTestId('agents-back')).toBeEnabled();
  expect(screen.queryByText('还没有 Agent')).toBeNull();
  await mounted.unmount();
  await render(<Stories.A3 />);
  await tick(200);
  expect(screen.getByText('还没有 Agent')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('agents-create-empty'));
  await tick(200);
  expect(screen.getByTestId('editor-name')).toHaveDisplayValue('');
});

test('agent-list.A5 刷新失败保留旧行、资料与在线管理入口，恢复后清除反馈', async () => {
  const peer = agentListScenario('A5');
  await render(<Stories.A5 scenario={peer} />);
  await tick(800);
  await tick(3000);
  expect(screen.getByText('无法加载 Agent，正在重试…')).toBeOnTheScreen();
  expect(screen.getByText('内容可能不是最新的')).toBeOnTheScreen();
  expect(screen.getByTestId('agent-row-planner')).toBeEnabled();
  expect(screen.getByLabelText('编辑 planner')).toBeEnabled();
  expect(screen.getByTestId('agents-add')).toBeEnabled();
  await act(async () => peer.recover());
  await tick(200);
  expect(screen.queryByText('无法加载 Agent，正在重试…')).toBeNull();
});

test('agent-list.A6 短暂断线立即禁写，不等横幅出现且不叠读取错误', async () => {
  const peer = agentListScenario();
  await render(<Stories.A1 scenario={peer} />);
  await tick(200);
  await act(async () => peer.disconnect());
  await tick(50);
  expect(screen.getByTestId('agents-add')).toBeDisabled();
  expect(screen.getByLabelText('编辑 planner')).toBeDisabled();
  expect(screen.getByTestId('agents-back')).toBeEnabled();
  expect(screen.queryByText('无法加载 Agent，正在重试…')).toBeNull();
  await tick(1100);
  expect(screen.getByTestId('agent-row-planner')).toBeOnTheScreen();
  await act(async () => peer.reconnect());
  await tick(400);
  expect(screen.getByTestId('agents-add')).toBeEnabled();
});

test.each([false, true])('agent-list.B1 A6 点行进对应资料并返回列表，离线=%s', async offline => {
  const peer = agentListScenario();
  await render(<Stories.A1 scenario={peer} />);
  await tick(200);
  if (offline) { peer.disconnect(); await tick(400); }
  await fireEvent.press(screen.getByTestId('agent-row-executor'));
  await tick(200);
  expect(screen.getByTestId('profile-name')).toHaveTextContent('executor');
  expect(screen.queryByTestId('composer-input')).toBeNull();
  expect(peer.opens).toBe(0);
  expect(peer.session.conversations.size).toBe(0);
  if (offline) expect(screen.getByTestId('profile-edit')).toBeDisabled();
  else {
    await fireEvent.press(screen.getByTestId('profile-edit'));
    await tick(200);
    expect(screen.getByTestId('editor-name')).toHaveDisplayValue('executor');
    await fireEvent.press(screen.getByTestId('editor-back'));
    await tick(200);
    expect(screen.getByTestId('profile-name')).toHaveTextContent('executor');
  }
  await fireEvent.press(screen.getByTestId('profile-close'));
  await tick(200);
  expect(screen.getByTestId('agent-list-screen')).toBeOnTheScreen();
});

test('agent-list.A1 A7 与新对话胶囊和全部网格共用顺序，删除与新建后重新计算', async () => {
  const peer = agentListScenario();
  await render(<Stories.A1 scenario={peer} />);
  await tick(200);
  await act(async () => { await peer.session.createConversation('executor', '只有根对话', 'used-executor'); });
  await tick(200);
  const initial = ['executor', 'planner', 'search_agent', 'browser_agent', 'research_assistant', 'device_agent'];
  expect(rowIds()).toEqual(initial);
  await act(() => router.push('/chat'));
  await tick(200);
  expect(screen.getByTestId('new-chat-agent-executor')).toBeSelected();
  expect(screen.getAllByTestId(/^new-chat-agent-(?!grid-|display$|chips$|all$)/).map(row => row.props.testID))
    .toEqual(initial.slice(0, 5).map(id => `new-chat-agent-${id}`));
  await fireEvent.press(screen.getByTestId('new-chat-agent-all'));
  await tick(200);
  expect(screen.getAllByTestId(/^new-chat-agent-grid-/).map(row => row.props.testID))
    .toEqual(initial.map(id => `new-chat-agent-grid-${id}`));
  await fireEvent.press(screen.getByTestId('new-chat-agent-grid-executor'));
  await tick(200);
  await act(() => router.back());
  await tick(200);
  await act(async () => {
    await peer.session.api.deleteAgent('executor');
    await peer.session.api.createAgent('created-agent', { name: '新 Agent', description: '', system_prompt: '' });
  });
  await tick(400);
  expect(rowIds()).toEqual(['planner', 'search_agent', 'browser_agent', 'research_assistant', 'device_agent', 'created-2']);
});
