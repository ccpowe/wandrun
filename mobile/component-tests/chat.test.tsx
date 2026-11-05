import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as stories from '../src/dev/chat.stories';
import * as Clipboard from 'expo-clipboard';
import * as drawerStories from '../src/dev/conversation-drawer.stories';
import { chatScenario, type ChatScenario } from '../src/dev/chat-scenario';
import { MessageRow } from '../src/components/chat/message-row';
import { projectChatRows } from '../src/lib/chat-timeline';
import { Composer } from '../src/components/chat/composer';
import { Alert } from 'react-native';
import { useSyncExternalStore } from 'react';
import { MessageActions } from '../src/components/chat/message-actions';
import { SceneProviders } from '../src/dev/scene-providers';
import { PortalHost } from '@rn-primitives/portal';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
jest.mock('@gorhom/bottom-sheet', () => {
  const official = jest.requireActual('@gorhom/bottom-sheet/mock');
  // The official mock renders content but has no native closing animation.
  // Supply only the public close() completion; real animation/IME are verified on Android.
  class Sheet extends official.default {
    close() { this.props.onClose?.(); }
  }
  return { __esModule: true, ...official, default: Sheet };
});
const Chat = composeStories(stories);
const Drawer = composeStories(drawerStories);
beforeEach(() => {
  jest.useFakeTimers();
  // Jest's native view host has no layout engine; only the native measurement boundary is supplied.
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
});
afterEach(() => jest.useRealTimers());
const tick = async (ms = 0) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

async function layoutChat() {
  // Supply native layout events, not list/page state, to the real composer and LegendList.
  let composer = screen.getByTestId('composer-input').parent;
  while (composer && typeof composer.props.onLayout !== 'function') composer = composer.parent;
  if (!composer) throw new Error('Composer measurement boundary missing');
  await fireEvent(composer, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 70 } } });
  for (const scroll of screen.container.queryAll((node) => node.type === 'RCTScrollView' && typeof node.props.onLayout === 'function')) {
    await fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 650 } } });
  }
  await tick(200);
}

function LocalMessages({ peer }: { peer: ChatScenario }) {
  useSyncExternalStore(peer.session.subscribe, peer.session.getVersion);
  return <>{projectChatRows({ events: peer.session.timeline(peer.id).events, pending: peer.session.pendingFor(peer.id) }).rows.map((item) =>
    <MessageActions key={item.key} item={item} onQuote={() => {}}
      onDiscard={item.pending?.status === 'failed' ? () => peer.session.discard(item.pending!.clientId) : undefined}>
      <MessageRow item={item} session={peer.session} />
    </MessageActions>)}<PortalHost /></>;
}

test('chat.I2 抽屉进入 Agent 列表，返回后保持当前聊天', async () => {
  const peer = chatScenario('I2');
  await render(<Chat.I2 scenario={peer} />);
  await waitFor(() => expect(screen.getByTestId('chat-open-drawer')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('chat-open-drawer'));
  await waitFor(() => expect(screen.getByTestId('drawer-agents')).toBeOnTheScreen());
  await fireEvent.press(screen.getByTestId('drawer-agents'));
  await waitFor(() => expect(screen.getByTestId('agent-row-travel')).toBeOnTheScreen());
  await fireEvent.press(screen.getByTestId('agents-back'));
  await waitFor(() => expect(screen.getByTestId('chat-agent-profile')).toBeOnTheScreen());
  expect(screen.getByTestId('chat-agent-name')).toHaveTextContent('小万');
}, 15_000);

test('chat.J4 零 Agent 保留插画和聊天骨架，抽屉为空且设置从抽屉可达', async () => {
  await render(<Chat.J4 />);
  await tick(200);
  expect(screen.getByText('还没有 Agent')).toBeOnTheScreen();
  expect(screen.getByText('新建一个 Agent，就可以和它聊天')).toBeOnTheScreen();
  expect(screen.getByTestId('chat-entry-create-agent')).toBeEnabled();
  expect(screen.getByTestId('chat-new-conversation')).toBeDisabled();
  expect(screen.queryByTestId('chat-agent-profile')).toBeNull();
  expect(screen.queryByTestId('composer-input')).toBeNull();
  await fireEvent.press(screen.getByTestId('chat-open-drawer'));
  await tick(300);
  expect(screen.getByText('还没有对话')).toBeOnTheScreen();
  expect(screen.getByTestId('new-conversation')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('drawer-settings'));
  await tick(300);
  expect(screen.getByTestId('settings-connection')).toBeOnTheScreen();
});

test('chat.J5 列表失败只留顶部横幅，后台重试成功自动进入', async () => {
  const peer = chatScenario('J5');
  await render(<Chat.J5 scenario={peer} />);
  await tick(200);
  await tick(3000);
  expect(screen.getByText('无法加载 Agent，正在重试…')).toBeOnTheScreen();
  expect(screen.queryByTestId('chat-entry-retry')).toBeNull();
  expect(screen.queryByText('还没有 Agent')).toBeNull();
  expect(screen.getByTestId('chat-open-drawer')).toBeEnabled();
  expect(screen.queryByTestId('chat-agent-profile')).toBeNull();
  expect(screen.queryByTestId('composer-input')).toBeNull();
  peer.recoverReads();
  await waitFor(() => expect(screen.getByTestId('new-chat-agent-planner')).toBeOnTheScreen(), { timeout: 6000 });
  expect(screen.queryByText('无法加载 Agent，正在重试…')).toBeNull();
});

test('chat.J5 已缓存主对话在目录刷新失败时保留正文与胶囊，恢复后移除横幅', async () => {
  const peer = chatScenario('J1');
  await render(<Chat.J1 scenario={peer} />);
  await tick(200);
  peer.failAgentReads();
  await act(async () => { await peer.session.agents.refresh(); });
  await tick(200);
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('近一周 AI 浏览器 Agent 动态');
  // The native host does not lay out the virtual list; inspect its real session history.
  expect(peer.session.timeline(peer.id).events).toContainEqual(expect.objectContaining({
    type: 'message.user', data: { text: '帮我梳理近一周 AI 浏览器 Agent 的动态，重点看定价和开源项目。' },
  }));
  await tick(3000);
  expect(screen.getByText('无法加载 Agent，正在重试…')).toBeOnTheScreen();
  peer.recoverReads();
  await waitFor(() => expect(screen.queryByText('无法加载 Agent，正在重试…')).toBeNull(), { timeout: 6000 });
});

test('chat.J6 首次读取先出聊天骨架，0.5 秒后转圈且不闪空状态', async () => {
  await render(<Chat.J6 />);
  await tick(499);
  expect(screen.getByTestId('chat-open-drawer')).toBeEnabled();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByText('还没有 Agent')).toBeNull();
  await tick(1);
  expect(screen.getByRole('progressbar')).toBeOnTheScreen();
});


test('conversation-drawer.E7 首条失败仍列入抽屉，不编造活动时间', async () => {
  await render(<Drawer.E7 />);
  await tick(1000);
  const row = screen.getByTestId('conversation-recent');
  expect(within(row).getByText('小万')).toBeOnTheScreen();
  expect(within(row).queryByText(/刚刚|分钟前|昨天/)).toBeNull();
  expect(screen.getByTestId('conversation-recent')).toBeEnabled();
});

test.each(['J1', 'J2'] as const)('chat.%s 恢复或删除兜底进入主对话而非子对话', async (state) => {
  const Scene = Chat[state];
  await render(<Scene />);
  await tick(200);
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('近一周 AI 浏览器 Agent 动态');
  expect(screen.getByLabelText('对话列表')).toBeEnabled();
  expect(screen.queryByLabelText('返回主对话')).toBeNull();
});

test.each(['J3', 'J9'] as const)('chat.%s 无历史或首次连接进入第一 Agent 空白聊天', async (state) => {
  const Scene = Chat[state];
  await render(<Scene />);
  await tick(200);
  expect(screen.getByTestId('new-chat-agent-planner')).toBeOnTheScreen();
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('新对话');
});

test('conversation-drawer.E6 P6 AI 未读回复的非当前行亮红点（与需要处理同一种样式）；空白与子对话不单列', async () => {
  await render(<Drawer.E6 />);
  await tick(200);
  expect(screen.queryByTestId('conversation-recent')).toBeNull();
  expect(screen.getByTestId('conversation-root-2')).toBeOnTheScreen();
  expect(within(screen.getByTestId('conversation-root-2')).getByLabelText('需要处理')).toBeOnTheScreen();
  expect(screen.queryByTestId('conversation-child-0')).toBeNull();
});

test('conversation-drawer.E2 E3 空列表保留功能入口，单行不混入子任务', async () => {
  const view = await render(<Drawer.E2 />);
  await tick(200);
  expect(screen.getByText('还没有对话')).toBeOnTheScreen();
  expect(screen.getByTestId('drawer-agents')).toBeEnabled();
  await view.unmount();
  await render(<Drawer.E3 />);
  await tick(200);
  const current = screen.getByTestId('conversation-recent');
  expect(screen.getByRole('button', { selected: true })).toBeOnTheScreen();
  expect(within(current).queryByLabelText('需要处理')).toBeNull();
  expect(screen.queryByTestId('conversation-child-0')).toBeNull();
});

test('conversation-drawer.E1 Agent 入口点行进入资料，关闭后返回列表', async () => {
  await render(<Drawer.E1 />);
  await tick(200);
  await fireEvent.press(screen.getByTestId('drawer-agents'));
  await tick(200);
  await fireEvent.press(screen.getByTestId('agent-row-planner'));
  await tick(200);
  expect(screen.getByTestId('profile-name')).toHaveTextContent('小万');
  expect(screen.queryByTestId('composer-input')).toBeNull();
  await fireEvent.press(screen.getByTestId('profile-close'));
  await tick(200);
  expect(screen.getByTestId('agent-list-screen')).toBeOnTheScreen();
});

test('conversation-drawer.E5 E8 离线小字与缓存导航，重连后恢复联网操作', async () => {
  const peer = chatScenario('E5');
  await render(<Drawer.E5 scenario={peer} />);
  await tick(1000);
  expect(screen.getByTestId('drawer-offline')).toHaveTextContent('连接已断开，正在重连…');
  expect(screen.getByTestId('conversation-root-0')).toBeEnabled();
  await fireEvent(screen.getByTestId('conversation-root-0'), 'longPress', { nativeEvent: { pageY: 300 } });
  expect(screen.queryByTestId('conversation-menu-rename')).toBeNull();
  expect(screen.getByTestId('new-conversation')).toBeEnabled();
  // DrawerFlow navigates only after the real drawer close callback, covered separately in L1.
  await fireEvent.press(screen.getByTestId('conversation-root-0'));
  await tick();
  await act(() => peer.reconnect());
  await tick(100);
  expect(screen.queryByTestId('drawer-offline')).toBeNull();
  expect(screen.getByTestId('new-conversation')).toBeEnabled();
});

test('conversation-drawer.C3 C4 C5 重命名校验、在途防重、失败保留输入后可恢复', async () => {
  const peer = chatScenario('E1');
  await render(<Drawer.E1 scenario={peer} />);
  await tick(200);
  const originalTitle = screen.getByTestId('chat-conversation-title').props.children;
  await fireEvent(screen.getByTestId('conversation-root-0'), 'longPress', { nativeEvent: { pageY: 300 } });
  await fireEvent.press(screen.getByTestId('conversation-root-0'));
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent(originalTitle);
  await fireEvent.press(screen.getByTestId('conversation-menu-rename'));
  const input = screen.getByTestId('conversation-rename-input');
  expect(input).toHaveDisplayValue('浏览器截图接口的鉴权方案');
  await fireEvent.changeText(input, ' ');
  expect(screen.getByTestId('conversation-rename-confirm')).toBeDisabled();
  await fireEvent.changeText(input, '😀'.repeat(201));
  expect(screen.getByTestId('conversation-rename-confirm')).toBeDisabled();
  await fireEvent.changeText(input, 'Updated title');
  const release = peer.pauseWrites();
  peer.failNextWrite();
  await fireEvent.press(screen.getByTestId('conversation-rename-confirm'));
  expect(screen.getByTestId('conversation-rename-confirm')).toBeDisabled();
  expect(screen.getByTestId('conversation-rename-cancel')).toBeDisabled();
  await act(() => release());
  await tick();
  expect(screen.getByText('网关暂不可用，请稍后重试')).toBeOnTheScreen();
  expect(input).toHaveDisplayValue('Updated title');
  await fireEvent.press(screen.getByTestId('conversation-rename-confirm'));
  await tick();
  expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
  expect(within(screen.getByTestId('conversation-root-0')).getByText('Updated title')).toBeOnTheScreen();
});

test('conversation-drawer.C6 C7 删除确认说明范围，失败可重试，成功移除目标行', async () => {
  const peer = chatScenario('E1');
  await render(<Drawer.E1 scenario={peer} />);
  await tick(200);
  await fireEvent(screen.getByTestId('conversation-root-0'), 'longPress', { nativeEvent: { pageY: 300 } });
  await fireEvent.press(screen.getByTestId('conversation-menu-delete'));
  const release = peer.pauseWrites();
  peer.failNextWrite();
  await fireEvent.press(screen.getByTestId('conversation-delete-confirm'));
  expect(screen.getByTestId('conversation-delete-confirm')).toBeDisabled();
  expect(screen.getByTestId('conversation-delete-cancel')).toBeDisabled();
  await act(() => release());
  await tick();
  expect(screen.getByText('网关暂不可用，请稍后重试')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('conversation-delete-confirm'));
  await tick();
  expect(screen.queryByTestId('conversation-root-0')).toBeNull();
  expect(screen.queryByTestId('conversation-delete-confirm')).toBeNull();
});

test('conversation-drawer.C8 T4 外部删除先到时关闭失效编辑，迟到失败不复活弹层', async () => {
  const peer = chatScenario('E1');
  await render(<Drawer.E1 scenario={peer} />);
  await tick(200);
  await fireEvent(screen.getByTestId('conversation-root-0'), 'longPress', { nativeEvent: { pageY: 300 } });
  await fireEvent.press(screen.getByTestId('conversation-menu-rename'));
  const release = peer.pauseWrites();
  peer.failNextWrite();
  await fireEvent.changeText(screen.getByTestId('conversation-rename-input'), 'Do not restore');
  await fireEvent.press(screen.getByTestId('conversation-rename-confirm'));
  await act(() => peer.deleteFromPeer('root-0'));
  await tick();
  expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
  await act(() => release());
  await tick();
  expect(screen.queryByTestId('conversation-rename-input')).toBeNull();
  expect(screen.queryByText('网关暂不可用，请稍后重试')).toBeNull();
});

test('chat.I1 I8 顶栏任务树进入子对话，子页提供返回而非新对话', async () => {
  await render(<Chat.I1 />);
  await tick(200);
  await fireEvent.press(screen.getByTestId('chat-child-child-1'));
  await tick(200);
  expect(screen.getByLabelText('返回主对话')).toBeOnTheScreen();
  expect(screen.queryByTestId('chat-new-conversation')).toBeNull();
  expect(screen.getByTestId('chat-conversation-title')).toHaveTextContent('小万 发起 · 近一周 AI 浏览器 Agent 动态');
});

test('chat.I2 名称点击进入当前 Agent 资料', async () => {
  await render(<Chat.I2 />);
  await tick(200);
  await fireEvent.press(screen.getByTestId('chat-agent-profile'));
  await tick(300);
  expect(screen.getByTestId('profile-name')).toHaveTextContent('小万');
});

test('chat.I8 只有数量圆标展开下级卡片，再点收回', async () => {
  await render(<Chat.I8 />);
  await tick(200);
  await fireEvent.press(screen.getByTestId('chat-child-count'));
  await tick(300);
  expect(screen.getByTestId('chat-child-grandchild')).toBeOnTheScreen();
  expect(screen.queryByTestId('profile-name')).toBeNull();
  await fireEvent.press(screen.getByTestId('chat-child-count'));
  await tick(500);
  expect(screen.queryByTestId('chat-child-grandchild')).toBeNull();
  expect(screen.getByLabelText('返回主对话')).toBeOnTheScreen();
});

test('chat.G1 G2 短断线不显示，持续满三秒显示，恢复立即消失', async () => {
  const peer = chatScenario('G5');
  await render(<Chat.G5 scenario={peer} />);
  await tick(2999);
  expect(screen.queryByTestId('chat-offline-error')).toBeNull();
  await tick(1);
  expect(screen.getByTestId('chat-offline-error')).toBeOnTheScreen();
  await act(() => peer.reconnect());
  await tick();
  expect(screen.queryByTestId('chat-offline-error')).toBeNull();
});

test('chat.G4 G5 G6 连接、历史、停止逐个显露，历史后台恢复且无手动入口', async () => {
  const peer = chatScenario('G5');
  await render(<Chat.G5 scenario={peer} />);
  await tick(3000);
  expect(screen.getByTestId('chat-offline-error')).toBeOnTheScreen();
  expect(screen.queryByTestId('chat-history-error')).toBeNull();
  expect(screen.queryByTestId('chat-stop-error')).toBeNull();
  await act(() => peer.reconnect());
  await tick(3100);
  expect(screen.getByTestId('chat-history-error')).toHaveTextContent('无法加载历史消息，正在重试…');
  expect(screen.queryByTestId('chat-history-retry')).toBeNull();
  expect(screen.queryByTestId('chat-stop-error')).toBeNull();
  peer.recoverReads();
  await tick(2000);
  expect(screen.queryByTestId('chat-history-error')).toBeNull();
  expect(screen.getByTestId('chat-stop-error')).toHaveTextContent(/工作可能仍在继续/);
  expect(screen.getByLabelText('重试停止')).toBeEnabled();
});

test('chat.D2 G3 T6 消息下直接重试，失败保留正文，不可重试不提供重试入口', async () => {
  const peer = chatScenario('E7');
  await peer.start();
  const pending = peer.session.pendingFor(peer.id)[0];
  const item = projectChatRows({ events: [], pending: [pending] }).rows[0];
  const view = await render(<MessageRow item={item} session={peer.session} />);
  expect(screen.getByText('这条消息尚未送达')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId(`message-retry-${pending.clientId}`));
  expect(pending.status).toBe('failed');
  expect(screen.getByText('这条消息尚未送达')).toBeOnTheScreen();
  const refusedItem = projectChatRows({ events: [], pending: [{ ...pending, retryable: false }] }).rows[0];
  await view.rerender(<MessageRow item={refusedItem} session={peer.session} />);
  expect(screen.queryByTestId(`message-retry-${pending.clientId}`)).toBeNull();
  expect(screen.getByLabelText('消息发送失败')).toBeOnTheScreen();
  peer.stop();
});

test('chat.D5 自己的消息仅长按复制或引用，Agent 操作行保持可用', async () => {
  const clipboard = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  await render(<Chat.I2 />);
  await tick(200);
  await layoutChat();
  expect(screen.queryByTestId('message-copy-e89')).toBeNull();
  expect(screen.queryByTestId('message-quote-e89')).toBeNull();
  expect(screen.getByTestId('message-copy-e90')).toBeEnabled();
  expect(screen.getByTestId('message-quote-e90')).toBeEnabled();
  await fireEvent(screen.getByTestId('message-menu-trigger-e89'), 'longPress', { nativeEvent: { pageX: 240, pageY: 400 } });
  expect(screen.queryByTestId('message-menu-delete-e89')).toBeNull();
  await fireEvent.press(screen.getByTestId('message-menu-copy-e89'));
  expect(clipboard).toHaveBeenCalledWith('帮我梳理近一周 AI 浏览器 Agent 的动态，重点看定价和开源项目。');
  await fireEvent(screen.getByTestId('message-menu-trigger-e89'), 'longPress', { nativeEvent: { pageX: 240, pageY: 400 } });
  await fireEvent.press(screen.getByTestId('message-menu-quote-e89'));
  expect(screen.getByTestId('composer-quote')).toHaveTextContent(/帮我梳理近一周 AI 浏览器 Agent 的动态/);
  clipboard.mockRestore();
});

test('chat.D10 失败原因可读且不重复，失败后可直接发下一条', async () => {
  await render(<Chat.D10 />);
  await tick(200);
  await layoutChat();
  expect(screen.getByTestId('turn-failed-90')).toHaveTextContent(/未完成：.*模型未登录/);
  expect(screen.queryByText('上一轮失败了，可以直接再发一条继续。')).toBeNull();
  expect(screen.queryByText(/查看网关日志|请重试|已完成的内容会保留/)).toBeNull();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '继续整理工作安排');
  expect(screen.getByTestId('composer-send')).toBeEnabled();
  await fireEvent.press(screen.getByTestId('composer-send'));
  await tick();
  expect(screen.getByText('继续整理工作安排')).toBeOnTheScreen();
  expect(screen.getAllByTestId('turn-failed-90')).toHaveLength(1);
  expect(screen.queryByText('上一轮失败了，可以直接再发一条继续。')).toBeNull();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('');
});

test('conversation-drawer.E4 多个主对话保持末行及底部入口可达', async () => {
  await render(<Drawer.E4 />);
  await tick(200);
  expect(screen.getByTestId('conversation-root-29')).toBeOnTheScreen();
  expect(screen.getByTestId('new-conversation')).toBeEnabled();
});

test('chat.B4 B5 B9 B11 工作中有输入优先发送，停止忙态和草稿错误不放开发送', async () => {
  const props = { draft: '追加要求', working: true, stopping: true, attachments: [], uploadError: null,
    quote: null, onCancelQuote() {}, onChangeDraft() {}, onPick() {}, onRetry() {}, onRemove() {}, onSend() {}, onStop() {} };
  const view = await render(<Composer {...props} />);
  expect(screen.getByLabelText('发送')).toBeEnabled();
  expect(screen.queryByLabelText('停止这一轮')).toBeNull();
  await view.rerender(<Composer {...props} draft="" />);
  expect(screen.getByLabelText('停止这一轮')).toBeDisabled();
  await view.rerender(<Composer {...props} uploadError="附件上传失败" />);
  expect(screen.getByTestId('composer-send')).toBeDisabled();
  expect(screen.getByText('附件上传失败')).toBeOnTheScreen();
  await view.rerender(<Composer {...props} disabledReason="这个协作已无法继续" textOnly />);
  expect(screen.getByLabelText('消息')).toBeDisabled();
  expect(screen.queryByTestId('composer-add')).toBeNull();
  expect(screen.getByTestId('composer-send')).toBeDisabled();
});

test('chat.H4 G4 子对话停止结果未确认时仍能看到原因与重试入口', async () => {
  await render(<Chat.I8 />);
  await tick(200);
  await fireEvent.press(screen.getByLabelText('停止这一轮'));
  await tick(3100);
  expect(screen.getByTestId('chat-stop-error')).toHaveTextContent(/工作可能仍在继续/);
  expect(screen.getByLabelText('重试停止')).toBeEnabled();
});

test('chat.D2 D11 G3 T6 感叹号与文字可重发、气泡仅长按菜单，失败恢复后可成功或删除', async () => {
  const peer = chatScenario('E7');
  const alert = jest.spyOn(Alert, 'alert');
  await peer.start();
  await render(<SceneProviders><LocalMessages peer={peer} /></SceneProviders>);
  await tick(1000);
  const pending = peer.session.pendingFor(peer.id)[0];
  await fireEvent.press(screen.getByTestId(`message-retry-${pending.clientId}`));
  expect(alert).not.toHaveBeenCalled();
  await act(() => peer.reconnect());
  await tick(100);
  const releaseFailure = peer.pauseWrites();
  peer.failNextWrite();
  await fireEvent.press(screen.getByText('这条消息尚未送达'));
  expect(screen.queryByLabelText('发送中')).toBeNull();
  expect(screen.getByTestId(`message-retry-${pending.clientId}`)).toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('消息发送失败'));
  expect(screen.queryByLabelText('发送中')).toBeNull();
  await tick(499);
  expect(screen.queryByLabelText('发送中')).toBeNull();
  await tick(1);
  expect(screen.getByLabelText('发送中')).toBeOnTheScreen();
  expect(screen.queryByTestId(`message-retry-icon-${pending.clientId}`)).toBeNull();
  expect(screen.queryByTestId(`message-retry-${pending.clientId}`)).toBeNull();
  expect(screen.queryByTestId(`message-menu-delete-p${pending.clientId}`)).toBeNull();
  await act(() => releaseFailure());
  await tick();
  expect(screen.getByTestId(`message-retry-${pending.clientId}`)).toBeOnTheScreen();
  const releaseSuccess = peer.pauseWrites();
  await fireEvent.press(screen.getByTestId(`message-retry-${pending.clientId}`));
  expect(screen.queryByLabelText('发送中')).toBeNull();
  await act(() => releaseSuccess());
  await tick();
  expect(screen.getByText('这条消息尚未送达')).toBeOnTheScreen();
  expect(screen.queryByTestId(`message-retry-${pending.clientId}`)).toBeNull();
  expect(screen.queryByLabelText('消息发送失败')).toBeNull();
  await act(async () => { peer.failNextWrite(); await peer.session.send(peer.id, '仅删除本地失败项'); });
  await tick();
  const failed = peer.session.pendingFor(peer.id)[0];
  await fireEvent(screen.getByTestId(`message-menu-trigger-p${failed.clientId}`), 'longPress', { nativeEvent: { pageX: 240, pageY: 400 } });
  expect(screen.getByTestId(`message-menu-copy-p${failed.clientId}`)).toBeOnTheScreen();
  expect(screen.queryByTestId(`message-menu-quote-p${failed.clientId}`)).toBeNull();
  await fireEvent.press(screen.getByTestId(`message-menu-delete-p${failed.clientId}`));
  await tick();
  expect(screen.queryByText('仅删除本地失败项')).toBeNull();
  expect(screen.getByText('这条消息尚未送达')).toBeOnTheScreen();
  expect(alert).not.toHaveBeenCalled();
  alert.mockRestore();
  peer.stop();
});


test('chat.D1 快速确认取消发送指示，超时提示可同键重试', async () => {
  const peer = chatScenario('I2');
  await peer.start();
  await render(<SceneProviders><LocalMessages peer={peer} /></SceneProviders>);
  try {
    const release = peer.pauseWrites();
    let sending!: Promise<void>;
    await act(() => { sending = peer.session.send(peer.id, 'fast confirmation', [], 'fast'); });
    await tick(499);
    expect(screen.queryByLabelText('发送中')).toBeNull();
    await act(async () => { release(); await sending; });
    await tick(1000);
    expect(screen.getByText('fast confirmation')).toBeOnTheScreen();
    expect(screen.queryByLabelText('发送中')).toBeNull();

    const releaseLate = peer.pauseWrites();
    await act(() => { void peer.session.send(peer.id, 'unconfirmed', [], 'slow'); });
    await tick(500);
    expect(screen.getByTestId('message-sending-slow')).toBeOnTheScreen();
    await tick(14_500);
    expect(screen.getByText('结果未确认，点按重试')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('message-retry-slow'));
    expect(screen.queryByLabelText('发送中')).toBeNull();
    await act(() => releaseLate());
    await tick();
    expect(screen.getAllByText('unconfirmed')).toHaveLength(1);
    expect(screen.queryByTestId('message-retry-slow')).toBeNull();
  } finally { peer.stop(); }
});

test('chat.D2 T6 首消息超时后重建会话，恢复仍告知未确认并沿原身份重试', async () => {
  const original = chatScenario('I2');
  await original.start();
  const release = original.pauseWrites();
  const mounted = await render(<SceneProviders><LocalMessages peer={original} /></SceneProviders>);
  await act(() => { void original.session.send(original.id, 'durable unconfirmed send', [], 'durable-client'); });
  await tick(15_000);
  expect(screen.getByText('结果未确认，点按重试')).toBeOnTheScreen();
  const saved = { ...original.session.pending.get('durable-client')! };
  await mounted.unmount();
  original.stop();

  const restored = chatScenario('I2');
  await restored.start();
  restored.session.restoreFirstSend(restored.id, saved.clientId, saved.text, saved.attachments);
  const restoredMounted = await render(<SceneProviders><LocalMessages peer={restored} /></SceneProviders>);
  try {
    expect(screen.getByText('结果未确认，点按重试')).toBeOnTheScreen();
    expect(restored.session.timeline(restored.id).events.some(event => event.client_id === saved.clientId)).toBe(false);
    await fireEvent.press(screen.getByTestId('message-retry-durable-client'));
    await tick();
    expect(screen.queryByTestId('message-retry-durable-client')).toBeNull();
    expect(restored.session.timeline(restored.id).events.filter(event => event.client_id === saved.clientId).map(event => event.data.text)).toEqual([saved.text]);
  } finally { await restoredMounted.unmount(); release(); restored.stop(); }
});
