import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import ChatRoute from '../src/app/chat';
import type { GatewayEvent } from '../src/gateway/api';
import { FakeGateway } from '../src/dev/fake-gateway';
import { listCalls, listSignals } from './list-signals';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
// Verification boundary: LegendList and keyboard-controller are replaced by one double (native placement
// never completes in Jest), so these tests prove only what the page asks of them at the screen boundary: which
// row is the pin intent, the single end request made at the tap, when the keyboard is asked to hide, and when a
// user take-over releases the isolation. They prove nothing about native geometry, padding or the pinned
// position; that is established only by the development-build verification (matrix N1-N12, not yet complete).
// State transitions themselves are L1 (test/chat_pin.test.ts).
jest.mock('@legendapp/list/keyboard', () => {
  const actual = jest.requireActual('@legendapp/list/keyboard');
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const { listSignals: signals, listCalls: calls } = jest.requireActual('./list-signals');
  class EndState {
    isAtEnd = false;
    private listeners = new Set<() => void>();
    listen = (_key: string, notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
    set = (value: boolean) => { this.isAtEnd = value; for (const notify of this.listeners) notify(); };
  }
  function KeyboardAwareLegendList({ ref, ...props }: any) {
    const [end] = React.useState(() => new EndState());
    React.useImperativeHandle(ref, () => ({ getState: () => end, scrollToEnd: (options?: { animated?: boolean }) => { calls.scrollToEnd += 1; calls.animated.push(options?.animated); end.set(true); } }), [end]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, like the real readiness
    React.useEffect(() => { signals.push({ setAtEnd: end.set }); props.onReady?.(); }, []);
    return React.createElement(View, { testID: 'chat-list', maintainScrollAtEnd: props.maintainScrollAtEnd, anchoredEndSpace: props.anchoredEndSpace,
      freeze: props.freeze, extraData: props.extraData, keyboardLiftBehavior: props.keyboardLiftBehavior, onScrollBeginDrag: props.onScrollBeginDrag,
      keys: props.data.map(props.keyExtractor) },
    props.data.map((item: any, index: number) => React.createElement(View, { key: props.keyExtractor(item) }, props.renderItem({ item, index }))));
  }
  return { ...actual, KeyboardAwareLegendList };
});

const history = (): GatewayEvent[] => Array.from({ length: 6 }, (_, index) => ({
  seq: index + 1, at: index + 1, conversation_id: 'root',
  ...(index % 2 ? { type: 'message.agent', data: { agent_id: 'research', text: `第 ${index + 1} 条回复` } }
    : { type: 'message.user', data: { text: `第 ${index + 1} 条问题` } }),
}) as GatewayEvent);

let peer: FakeGateway;
let offline: boolean;
const dismiss = KeyboardController.dismiss as unknown as jest.Mock;
beforeEach(() => {
  jest.useFakeTimers();
  listSignals.length = 0; listCalls.scrollToEnd = 0; listCalls.animated = []; offline = false;
  dismiss.mockReset().mockImplementation(() => Promise.resolve());
  peer = new FakeGateway({}, { 'POST /conversations/:id/messages': () => { if (offline) throw new TypeError('Network request failed'); } });
  seedGatewayAgent(peer);
  seedGatewayConversation(peer, 'research', 'root', history());
  Object.assign(peer.state.conversations[0], { last_text: '第 6 条回复', last_activity_seq: 6, last_agent_seq: 6, read_seq: 6 });
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

const list = () => screen.getByTestId('chat-list');
const keys = (): string[] => list().props.keys;
const sentKeys = () => keys().filter(key => key.startsWith('p'));
const anchor = () => list().props.anchoredEndSpace as { anchorIndex: number; anchorOffset: number } | undefined;
const anchorKey = () => anchor() && keys()[anchor()!.anchorIndex];
const isolated = () => !!list().props.freeze?.value;
const following = () => list().props.maintainScrollAtEnd !== false;
function Entry() { return <Text testID="entry-route">entry</Text>; }
async function open() {
  await renderGateway(peer, ChatRoute, '/chat', { '/': Entry }, '/chat?id=root');
  await layoutGatewayChat();
  await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
}
async function sendText(text: string) {
  await fireEvent.changeText(screen.getByTestId('composer-input'), text);
  await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
}
const status = async (value: 'working' | 'idle') =>
  { await act(async () => peer.emit(peer.event('conversation.status', { status: value }, 'root'))); await tick(300); await layoutGatewayChat(); };
// The placeholder is hidden from screen readers on purpose, so queries must include hidden elements.
const blank = () => screen.queryByTestId('chat-working-idle-content', { includeHiddenElements: true });
const extra = () => list().props.extraData as object;
const drag = async () => act(async () => list().props.onScrollBeginDrag());

test('chat.C9 T36 发送受理：只请求一次收键盘，钉住刚发的那一行，点击时只发一次末端请求', async () => {
  await open();
  expect(anchor()).toBeUndefined(); expect(following()).toBe(true);
  await sendText('请顶置这条');
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(sentKeys()).toHaveLength(1);
  expect(anchorKey()).toBe(sentKeys()[0]);
  expect(following()).toBe(false); // the sent view is kept: no tail-chasing
  expect(listCalls.scrollToEnd).toBe(1); // the one end request, issued at the tap
  expect(listCalls.animated).toEqual([true]); // the new message slides up (animated), as in the official send helper
});

test('chat.T37 键盘：收键盘完成之前不隔离，完成后隔离内容侧键盘反应', async () => {
  await open();
  const gate = Promise.withResolvers<void>();
  dismiss.mockImplementationOnce(() => gate.promise);
  await sendText('收键盘');
  expect(isolated()).toBe(false);
  await act(async () => gate.resolve()); await tick();
  expect(isolated()).toBe(true);
});

test('chat.C9 T36 身份：待确认 → 服务器确认期间，钉住的仍是同一行，不新增任何滚动请求', async () => {
  const receipt = Promise.withResolvers<void>();
  peer.overrides['POST /conversations/:id/messages'] = async (_context, respond) => { await receipt.promise; return respond(); };
  await open();
  await sendText('网络慢的发送');
  const [pending] = sentKeys();
  const index = anchor()!.anchorIndex;
  expect(listCalls.scrollToEnd).toBe(1);
  // The gateway confirms: the same logical row, same key and position.
  receipt.resolve(); await tick(300); await layoutGatewayChat();
  expect(sentKeys()).toEqual([pending]);
  expect(anchorKey()).toBe(pending);
  expect(anchor()!.anchorIndex).toBe(index);
  expect(screen.getAllByText(/网络慢的发送/)).toHaveLength(1);
  expect(listCalls.scrollToEnd).toBe(1);
  expect(following()).toBe(false);
});

test('chat.T36 T39 回复预览、定稿与 working 增删不新建钉住行、不再滚动', async () => {
  await open();
  await sendText('先问一句');
  const [pinned] = sentKeys();
  await act(async () => peer.emit({ type: 'draft.snapshot', data: { epoch: 'e', revision: 1, as_of_seq: peer.state.seq,
    drafts: [{ draft_id: 'reply', conversation_id: 'root', sender: 'root', agent: 'research', text: '正在整理', phase: null }] } } as unknown as GatewayEvent));
  await tick(300); await layoutGatewayChat();
  await act(async () => peer.emit(peer.event('message.agent', { draft_id: 'reply', agent_id: 'research', text: '整理完成', status: 'completed' }, 'root')));
  await tick(300); await layoutGatewayChat();
  expect(screen.getByText('整理完成')).toBeOnTheScreen();
  expect(anchorKey()).toBe(pinned);
  expect(listCalls.scrollToEnd).toBe(1);
  expect(following()).toBe(false);
});

test('chat.C9 发送窗口内列表的 extraData 引用保持不变：待确认→确认、草稿快照、定稿都不换新对象（换了会让所有行重渲染并拖延末端请求）', async () => {
  const receipt = Promise.withResolvers<void>();
  peer.overrides['POST /conversations/:id/messages'] = async (_context, respond) => { await receipt.promise; return respond(); };
  await open();
  await sendText('网络慢的发送'); await tick();
  const settled = extra();
  receipt.resolve(); await tick(300); await layoutGatewayChat();
  await act(async () => peer.emit({ type: 'draft.snapshot', data: { epoch: 'e', revision: 1, as_of_seq: peer.state.seq,
    drafts: [{ draft_id: 'reply', conversation_id: 'root', sender: 'root', agent: 'research', text: '正在整理', phase: null }] } } as unknown as GatewayEvent));
  await tick(300); await layoutGatewayChat();
  await act(async () => peer.emit(peer.event('message.agent', { draft_id: 'reply', agent_id: 'research', text: '整理完成', status: 'completed' }, 'root')));
  await tick(300); await layoutGatewayChat();
  expect(screen.getByText('整理完成')).toBeOnTheScreen();
  expect(extra()).toBe(settled);
});

test('chat.C9b T41 本机发送后回合结束：工作中行同 key 原位变成无文字占位，下一次发送时消失', async () => {
  await open();
  await sendText('先问一句');
  await status('working');
  expect(screen.getByTestId('chat-working-content')).toBeOnTheScreen();
  const index = keys().indexOf('working');
  expect(index).toBe(keys().length - 1);
  await status('idle');
  // Same data item (same key and position). It renders the working row's last content so its height is the real one, but
  // invisible (opacity 0) and hidden from screen readers (default queries skip it; nothing reads "工作中").
  expect(keys().indexOf('working')).toBe(index);
  expect(screen.queryByTestId('chat-working-content')).toBeNull();
  expect(blank()).toBeOnTheScreen();
  expect(screen.queryByText(/工作中/)).toBeNull();
  expect(screen.getByText('工作中…', { includeHiddenElements: true })).toBeOnTheScreen();
  const wrapper = blank()!.parent!;
  expect(StyleSheet.flatten(wrapper.props.style).opacity).toBe(0);
  expect(wrapper.props.accessibilityElementsHidden).toBe(true);
  expect(wrapper.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(listCalls.scrollToEnd).toBe(1); // the placeholder causes no scroll request
  // It lives as long as the anchor: a drag does not remove it, the next send does.
  await drag();
  expect(blank()).toBeOnTheScreen();
  await sendText('再问一句');
  expect(blank()).toBeNull();
  expect(keys()).not.toContain('working');
  await status('working');
  expect(screen.getByTestId('chat-working-content')).toBeOnTheScreen();
});

test('chat.C9b 占位行保留回合结束前最后一份工作中内容（活动文字），所以高度是真实的而不是固定一行', async () => {
  await open();
  await sendText('问');
  await status('working');
  await act(async () => peer.emit({ type: 'activity', conversation_id: 'root', data: { label: '正在调用 一个名字很长很长很长的工具' } } as unknown as GatewayEvent)); await tick();
  expect(screen.getByText('正在调用 一个名字很长很长很长的工具')).toBeOnTheScreen();
  await status('idle');
  expect(screen.queryByText(/正在调用/)).toBeNull(); // not visible to screen readers
  expect(screen.getByText('正在调用 一个名字很长很长很长的工具', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(StyleSheet.flatten(blank()!.parent!.props.style).opacity).toBe(0);
});

test('chat.T42 发送失败后删除这条顶置中的气泡：没有锚点，hold / 冻结 / 占位都不生效，外来回合结束不留空白', async () => {
  peer.overrides['POST /conversations/:id/messages'] = () => { throw new TypeError('Network request failed'); };
  await open();
  await sendText('会失败的发送');
  const [failed] = sentKeys();
  expect(anchorKey()).toBe(failed); expect(isolated()).toBe(true); expect(following()).toBe(false);
  await fireEvent(screen.getByTestId(`message-menu-trigger-${failed}`), 'longPress', { nativeEvent: { pageX: 240, pageY: 400 } });
  await fireEvent.press(screen.getByTestId(`message-menu-delete-${failed}`)); await tick(300); await layoutGatewayChat();
  expect(sentKeys()).toHaveLength(0);
  // Ordinary policy again: end-follow and the keyboard lift at the old reply's end.
  expect(anchor()).toBeUndefined(); expect(isolated()).toBe(false); expect(following()).toBe(true);
  expect(list().props.keyboardLiftBehavior).toBe('whenAtEnd');
  // An outside turn that ends later leaves no blank (there is no anchor).
  await status('working'); await status('idle');
  expect(keys()).not.toContain('working'); expect(blank()).toBeNull();
});

test('chat.C9b 没有本机发送就没有锚点：回合结束时工作中行照旧移除，不留空白', async () => {
  await open();
  await status('working');
  expect(keys()).toContain('working');
  await status('idle');
  expect(keys()).not.toContain('working');
  expect(blank()).toBeNull();
});

test('chat.C9b 发送失败没出现过工作中行：不留空白；停止收场与完成一样保留占位', async () => {
  peer.overrides['POST /conversations/:id/messages'] = () => { throw new TypeError('Network request failed'); };
  await open();
  await sendText('会失败的发送');
  expect(keys()).not.toContain('working'); expect(blank()).toBeNull();
  peer.overrides['POST /conversations/:id/messages'] = async (_context, respond) => respond();
  await sendText('这条成功');
  await status('working');
  await act(async () => peer.emit(peer.event('turn.stopped', { was_working: true }, 'root'))); await tick();
  await status('idle');
  expect(blank()).toBeOnTheScreen();
});

test('chat.C9b 换对话（ChatHistory 换代次）不带出旧对话的占位', async () => {
  seedGatewayConversation(peer, 'research', 'second', history());
  await open();
  await sendText('旧对话里发一条');
  await status('working'); await status('idle');
  expect(blank()).toBeOnTheScreen();
  await act(async () => router.replace('/chat?id=second')); await tick(300); await layoutGatewayChat();
  await waitFor(() => expect(screen.queryByTestId('chat-working-idle-content')).toBeNull());
  expect(keys()).not.toContain('working');
});

test('chat.C9 extraData 在行真的依赖的值变化时才换：末端跟随状态（决定提交后的接管方式）变化会换', async () => {
  await open();
  await sendText('先发一条'); await tick();
  const before = extra();
  await act(async () => listSignals.at(-1)!.setAtEnd(false)); await tick();
  expect(extra()).not.toBe(before);
});

test('chat.T38 用户拖动：恢复末端跟随与键盘策略，不再发滚动', async () => {
  await open();
  await sendText('拖动前');
  await drag();
  expect(following()).toBe(true); expect(isolated()).toBe(false);
  expect(listCalls.scrollToEnd).toBe(1); // only the send's own request
});

test('chat.T38 隔离中拖动：迟到的收键盘完成不再进入隔离', async () => {
  await open();
  const gate = Promise.withResolvers<void>();
  dismiss.mockImplementationOnce(() => gate.promise);
  await sendText('拖动后才收完键盘');
  await drag();
  await act(async () => gate.resolve()); await tick();
  expect(isolated()).toBe(false); expect(following()).toBe(true);
  expect(listCalls.scrollToEnd).toBe(1); // only the send's own request; scrolling up keeps the user's view
});

test('chat.T38 隔离中点“回到最新消息”：退出隔离，只多一次用户请求的回底', async () => {
  await open();
  await sendText('隔离后回底'); await tick();
  expect(isolated()).toBe(true);
  await act(async () => listSignals.at(-1)!.setAtEnd(false)); await tick(); // the reply grew past the pinned space
  await fireEvent.press(screen.getByTestId('chat-return-to-bottom')); await tick();
  expect(isolated()).toBe(false); expect(following()).toBe(true);
  expect(listCalls.scrollToEnd).toBe(2);
  expect(listCalls.animated).toEqual([true, false]); // the send slides; the user's own return jumps
});

test('chat.T39 连续两次发送：后一次替换钉住行，前一次迟到的收键盘完成不影响后一次', async () => {
  await open();
  const first = Promise.withResolvers<void>();
  dismiss.mockImplementationOnce(() => first.promise);
  await sendText('第一次');
  const [firstKey] = sentKeys();
  await sendText('第二次');
  const secondKey = sentKeys().find(key => key !== firstKey)!;
  expect(anchorKey()).toBe(secondKey);
  expect(listCalls.scrollToEnd).toBe(2); // one request per send
  await act(async () => first.resolve()); await tick();
  expect(dismiss).toHaveBeenCalledTimes(2);
  expect(isolated()).toBe(true); // the second send's own dismiss completed
});

test('chat.G3 已知离线不受理：草稿仍在，不收键盘、不钉住、不滚动', async () => {
  peer.overrides['GET /events'] = () => { if (offline) throw new TypeError('offline'); };
  await open();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '离线时');
  await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
  await act(() => { offline = true; peer.disconnect(); }); await tick(50);
  await fireEvent.press(screen.getByTestId('composer-send')); await tick();
  expect(screen.getByTestId('composer-input')).toHaveDisplayValue('离线时');
  expect(dismiss).not.toHaveBeenCalled();
  expect(anchor()).toBeUndefined(); expect(listCalls.scrollToEnd).toBe(0);
});

test('chat.T36 对话已被删除后不能钉住：不收键盘、无锚点', async () => {
  await open();
  await fireEvent.changeText(screen.getByTestId('composer-input'), '删除后');
  await act(async () => peer.emit(peer.event('conversation.deleted', { id: 'root' }, 'root'))); await tick(300);
  // The page leaves the deleted conversation; nothing could have been pinned or dismissed on the way.
  await waitFor(() => expect(screen.getByTestId('entry-route')).toBeOnTheScreen());
  expect(dismiss).not.toHaveBeenCalled();
});

describe('first send (unbound /chat)', () => {
  async function openNew() {
    await renderGateway(peer, ChatRoute, '/chat', {}, '/chat');
    await waitFor(() => expect(screen.getByTestId('composer-input')).toBeOnTheScreen());
    await layoutGatewayChat();
  }
  test('chat.T36 首发受理后钉住本地首条消息并收键盘；创建确认后仍是同一行，末端请求只发一次', async () => {
    await openNew();
    expect(anchor()).toBeUndefined();
    await fireEvent.changeText(screen.getByTestId('composer-input'), '首发顶置');
    await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
    expect(dismiss).toHaveBeenCalledTimes(1);
    const [key] = sentKeys();
    expect(anchorKey()).toBe(key);
    expect(listCalls.scrollToEnd).toBe(1);
    await tick(600); await layoutGatewayChat();
    expect(peer.state.conversations).toHaveLength(2); // bound in place
    expect(sentKeys()).toEqual([key]);
    expect(anchorKey()).toBe(key);
    expect(dismiss).toHaveBeenCalledTimes(1); expect(listCalls.scrollToEnd).toBe(1);
  });

  test('chat.O7 首发已知离线不受理：不收键盘、无锚点', async () => {
    peer.overrides['GET /events'] = () => { if (offline) throw new TypeError('offline'); };
    await openNew();
    await fireEvent.changeText(screen.getByTestId('composer-input'), '离线首发');
    await act(() => { offline = true; peer.disconnect(); }); await tick(50);
    await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
    expect(dismiss).not.toHaveBeenCalled();
    expect(anchor()).toBeUndefined(); expect(following()).toBe(true);
  });

  test('chat.T39 首发结果未确认后点重试：同一键，不再收键盘、不抢视图', async () => {
    let refuse = true;
    peer.overrides['POST /conversations'] = (_context, respond) => { if (refuse) throw new TypeError('Network request failed'); return respond(); };
    await openNew();
    await fireEvent.changeText(screen.getByTestId('composer-input'), '首发要重试');
    await fireEvent.press(screen.getByTestId('composer-send')); await tick(); await layoutGatewayChat();
    expect(dismiss).toHaveBeenCalledTimes(1);
    await drag();
    refuse = false;
    await fireEvent.press(screen.getByText('结果未确认，点按重试')); await tick(600); await layoutGatewayChat();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(following()).toBe(true); expect(isolated()).toBe(false);
    expect(listCalls.scrollToEnd).toBe(1); // only the first send's own request; the retry adds none
  });
});
