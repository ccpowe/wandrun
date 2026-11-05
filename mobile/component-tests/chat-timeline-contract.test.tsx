import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Text } from 'react-native';
import ChatRoute from '../src/app/chat';
import type { GatewayEvent, TaskConversation } from '../src/gateway/api';
import { FakeGateway, jsonResponse, unavailable } from '../src/dev/fake-gateway';
import { listSignals } from './list-signals';
import { layoutGatewayChat, renderGateway, seedGatewayAgent, seedGatewayConversation, tickGateway as tick } from './gateway-harness';
import { useSession } from '../src/lib/session-context';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
// The one third-party substitute: LegendList's native placement never completes in Jest (onReady waits
// for native scroll settlement), so this boundary mounts like the real list — initial position frozen
// at mount, onReady once, an isAtEnd store with listen(), scrollToEnd — and renders every row through
// the page's own renderItem. Its host element exposes what the page handed to the list.
jest.mock('@legendapp/list/keyboard', () => {
  const actual = jest.requireActual('@legendapp/list/keyboard');
  const React = jest.requireActual('react');
  const { View } = jest.requireActual('react-native');
  const signals = jest.requireActual('./list-signals').listSignals;
  /** The list's own isAtEnd store; tests drive it through the registered signal. */
  class EndState {
    isAtEnd = false;
    private listeners = new Set<() => void>();
    listen = (_key: string, notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
    set = (value: boolean) => { this.isAtEnd = value; for (const notify of this.listeners) notify(); };
  }
  function KeyboardAwareLegendList({ ref, ...props }: any) {
    const [initialPlacement] = React.useState(() => props.initialScrollAtEnd ? 'end' : props.initialScrollIndex);
    const [end] = React.useState(() => new EndState());
    React.useImperativeHandle(ref, () => ({ getState: () => end, scrollToEnd: () => end.set(true) }), [end]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only, like the real readiness
    React.useEffect(() => { signals.push({ setAtEnd: end.set }); props.onReady?.(); }, []);
    return React.createElement(View, { testID: 'chat-list', initialPlacement, maintainScrollAtEnd: props.maintainScrollAtEnd,
      onScrollBeginDrag: props.onScrollBeginDrag, onStartReached: props.onStartReached, keys: props.data.map(props.keyExtractor) },
    props.data.map((item: any, index: number) => React.createElement(View, { key: props.keyExtractor(item) }, props.renderItem({ item, index }))),
    props.ListFooterComponent ?? null);
  }
  return { ...actual, KeyboardAwareLegendList };
});

// Migrated from the hand-written Node host (test/chat_target_loading.test.ts, removed). The real
// route, session, notices, MessageRow / rich form, LegendList and Composer run; history, stop and
// UI-submission responses are only gated at the HTTP boundary and native layout / scroll events are
// supplied. The LegendList boundary below is a library double: it renders every row through the page's
// renderItem and exposes, on its host element, the initial placement and follow setting the page
// handed to the list; READ is also observed from the return button.
// Receipt rules that need no page moved to test/chat_stop_receipts.test.ts.
const message = (seq: number, conversationId = 'c'): GatewayEvent => ({ seq, type: 'message.user', conversation_id: conversationId, at: seq, data: { text: `Message ${seq}` } });
const page = (first: number, count = 50, conversationId = 'c') => Array.from({ length: count }, (_, index) => message(first + index, conversationId));
function Entry() { return <Text testID="entry-route">entry</Text>; }

type Read = { url: URL; resolve(events: GatewayEvent[] | null): void };
type Stop = { clientId: string; resolve(outcome: 'fail' | 'stopped'): void };
type Submission = { values: unknown; resolve(response: Response): void };
let peer: FakeGateway;
let reads: Read[];
let stops: Stop[];
let submissions: Submission[];
let offline: boolean;
beforeEach(() => {
  jest.useFakeTimers();
  listSignals.length = 0;
  reads = []; stops = []; submissions = []; offline = false;
  peer = new FakeGateway({}, {
    'GET /conversations/:id/events': ({ url }) => new Promise<Response>((resolve) => reads.push({ url, resolve: (events) =>
      resolve(events ? jsonResponse({ events, as_of_seq: 300 }) : unavailable('history unavailable')) })),
    'POST /conversations/:id/stop': ({ body }) => new Promise<Response>((resolve) => {
      const clientId = (body as { client_id: string }).client_id;
      stops.push({ clientId, resolve: (outcome) => resolve(outcome === 'fail' ? unavailable('stop unavailable')
        : jsonResponse({ event: { seq: 290, type: 'turn.stopped', conversation_id: 'c', at: 290, client_id: clientId, data: { was_working: true } } })) });
    }),
    'POST /conversations/:id/ui-submissions': ({ body }) => new Promise<Response>((resolve) =>
      submissions.push({ values: (body as { values: unknown }).values, resolve })),
    'POST /conversations/:id/messages': () => { if (offline) return unavailable('网关暂不可用'); },
    'GET /events': () => { if (offline) throw new TypeError('Network request failed'); },
  });
  seedGatewayAgent(peer, { id: 'agent', name: '研究员' });
  seedGatewayConversation(peer, 'agent', 'c');
  Object.assign(peer.state.conversations[0], { last_text: 'Latest', last_activity_seq: 200, last_agent_seq: 199, read_seq: 200, updated_at: 200 });
  peer.state.seq = 250;
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
});
afterEach(() => { peer.disconnect(); jest.restoreAllMocks(); jest.useRealTimers(); });

async function open(location: string) {
  await renderGateway(peer, ChatRoute, '/chat', { '/': Entry }, location);
  await layoutGatewayChat();
}
async function respond(index: number, events: GatewayEvent[] | null) {
  await act(async () => reads[index].resolve(events));
  await tick(); await layoutGatewayChat();
}
const before = () => reads.map((read) => read.url.searchParams.get('before'));
const byId = (id: string) => screen.queryByTestId(id);
const list = () => screen.getByTestId('chat-list');
/** Where the mounted list instance was initially placed: 'end' or the target row's key. */
const placement = () => {
  const initial = list().props.initialPlacement;
  return initial === 'end' ? 'end' : `e${(initial ? list().props.keys[initial.index] : '').slice(1)}`;
};
const placedAt = (seq: number) => {
  const initial = list().props.initialPlacement;
  return initial !== 'end' && initial !== undefined && list().props.keys[initial.index] === `e${seq}`;
};
const rendered = (seq: number) => list().props.keys.includes(`e${seq}`);
const following = () => list().props.maintainScrollAtEnd !== false;
const setAtEnd = async (value: boolean) => { await act(async () => listSignals.at(-1)!.setAtEnd(value)); await tick(); };
const returnButton = () => byId('chat-return-to-bottom');
const missing = () => byId('chat-local-missing');
const highlighted = (seq: number) => /bg-muted/.test(String(screen.getByTestId(`message-target-${seq}`).props.className ?? ''));
async function emit(type: string, data: GatewayEvent['data'], conversationId: string | undefined = 'c', clientId?: string) {
  const event = peer.event(type, data, conversationId);
  if (clientId) event.client_id = clientId;
  await act(async () => peer.emit(event));
  await tick();
}
/** A user drag and reaching the top, as the list reports them. */
const drag = async () => { await act(async () => list().props.onScrollBeginDrag()); await tick(); };
const scrollToTop = async () => { await act(async () => list().props.onStartReached({ distanceFromStart: 0 })); await tick(); };
/** Opening a target: first page 100..149, then the seek asks for older pages. */
async function openTarget(seq: number) {
  await open(`/chat?id=c&message_seq=${seq}`);
  await respond(0, page(100));
}

describe('working state items (chat.O10)', () => {
  test('定位最后消息时，工作状态项不阻止到达末端后恢复跟随', async () => {
    peer.state.conversations[0].status = 'working';
    await openTarget(149);
    expect(byId('chat-working-content')).toBeOnTheScreen();
    await setAtEnd(true);
    expect(returnButton()).toBeNull();
    expect(following()).toBe(true);
    expect(screen.getByTestId('message-target-149')).toBeOnTheScreen();
  });

  test('工作与停止状态不夺取旧消息阅读位置，只有用户返回才恢复跟随', async () => {
    await openTarget(120);
    await emit('conversation.status', { status: 'working' });
    const status = screen.getByTestId('chat-working-content');
    expect(returnButton()).toBeOnTheScreen();
    expect(following()).toBe(false);
    await fireEvent.press(screen.getByLabelText('停止这一轮')); await tick();
    expect(screen.getByTestId('chat-working-content')).toBe(status);
    expect(status).toHaveTextContent(/正在停止/);
    await act(async () => stops[0].resolve('stopped')); await tick();
    await emit('conversation.status', { status: 'idle' });
    expect(byId('chat-working-content')).toBeNull();
    expect(returnButton()).toBeOnTheScreen();
    expect(following()).toBe(false);
    await fireEvent.press(screen.getByTestId('chat-return-to-bottom')); await tick();
    expect(returnButton()).toBeNull();
    expect(following()).toBe(true);
  });

  test('工作状态项不推进已读序号，只有真实 Agent 消息才推进', async () => {
    function ObservedChat() {
      const conversation = useSession()?.chat('c');
      return <><ChatRoute /><Text testID="observed-read-state">
        {JSON.stringify({ seq: conversation?.read_seq, unread: conversation?.unread })}
      </Text></>;
    }
    const readState = () => JSON.parse(screen.getByTestId('observed-read-state').props.children) as { seq: number; unread: boolean };
    await renderGateway(peer, ObservedChat, '/chat', { '/': Entry }, '/chat?id=c');
    await layoutGatewayChat(); await respond(0, page(100));
    const readBefore = readState().seq;
    await emit('conversation.status', { status: 'working' });
    expect(byId('chat-working-content')).toBeOnTheScreen();
    expect(readState().seq).toBe(readBefore);
    const reply = peer.event('message.agent', { agent_id: 'agent', text: '真实回复' }, 'c');
    await act(async () => peer.emit(reply)); await tick();
    await waitFor(() => expect(readState().seq).toBe(reply.seq));
    await emit('conversation.status', { status: 'idle' });
    expect(byId('chat-working-content')).toBeNull();
    expect(readState().seq).toBe(reply.seq);
    expect(readState().unread).toBe(false);
  });
});

describe('history recovery (chat.G4 T3)', () => {
  test('ordinary first-page failure automatically recovers without losing messages', async () => {
    await open('/chat?id=c');
    await respond(0, null);
    expect(byId('chat-history-error')).toBeNull();
    expect(byId('chat-history-retry')).toBeNull();
    await tick(600);
    expect(reads).toHaveLength(2);
    expect(byId('chat-history-error')).toBeNull();
    await respond(1, [message(42)]);
    expect(before()).toEqual([null, null]);
    expect(byId('chat-history-error')).toBeNull();
    expect(rendered(42)).toBe(true);
  });

  test('ordinary older-page failure preserves existing rows and retries the same cursor', async () => {
    await open('/chat?id=c');
    await respond(0, page(100));
    await scrollToTop();
    await respond(1, null);
    expect(byId('chat-history-error')).toBeNull();
    expect(rendered(149)).toBe(true);
    await tick(600);
    await respond(2, page(50));
    expect(byId('chat-history-error')).toBeNull();
    expect(before()).toEqual([null, '100', '100']);
    await scrollToTop();
    await respond(3, null);
    await tick(600);
    expect(before()).toEqual([null, '100', '100', '50', '50']); // a later failure re-arms recovery
    await respond(4, []);
    expect(byId('chat-history-error')).toBeNull();
  });
});

describe('stop result (chat.T7 G4)', () => {
  async function workingChat() {
    peer.state.conversations[0].status = 'working';
    peer.state.conversations.push({ ...peer.state.conversations[0], id: 'other', status: 'idle' });
    peer.state.histories.set('other', []);
    await open('/chat?id=c');
    await respond(0, page(100));
    await fireEvent.press(screen.getByLabelText('停止这一轮'));
    await tick();
  }
  const stopError = () => byId('chat-stop-error');

  test('failure stays visible while connected, belongs only to its conversation, clears on retry', async () => {
    await workingChat();
    await act(async () => stops[0].resolve('fail')); await tick();
    await tick(3000);
    expect(stopError()).toBeOnTheScreen();
    expect(byId('chat-stop-retry')).toBeOnTheScreen();
    expect(rendered(149)).toBe(true);
    await act(async () => router.setParams({ id: 'other' })); await tick();
    await respond(1, []);
    expect(stopError()).toBeNull(); // another conversation must not display it
    await act(async () => router.setParams({ id: 'c' })); await tick(); await layoutGatewayChat();
    await tick(3000);
    expect(stopError()).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('chat-stop-retry')); await tick();
    expect(stopError()).toBeNull();
    await act(async () => stops[1].resolve('stopped')); await tick();
    expect(stopError()).toBeNull();
    expect(rendered(149)).toBe(true);
  });

  test('authoritative idle clears an unconfirmed stop without another command', async () => {
    await workingChat();
    await act(async () => stops[0].resolve('fail')); await tick();
    expect(stopError()).toBeNull();
    await emit('conversation.status', { status: 'idle' });
    await tick(3000);
    expect(stopError()).toBeNull();
    expect(stops).toHaveLength(1);
  });

  test('idle arriving before a failed stop response prevents a stale error', async () => {
    await workingChat();
    await emit('conversation.status', { status: 'idle' });
    await act(async () => stops[0].resolve('fail')); await tick();
    expect(stopError()).toBeNull();
  });

  test('the matching turn.stopped confirms a stop even without idle', async () => {
    await workingChat();
    await emit('turn.stopped', { was_working: true }, 'c', stops[0].clientId);
    await act(async () => stops[0].resolve('fail')); await tick();
    expect(stopError()).toBeNull();
  });

  test('a new working turn cannot undo confirmation of the earlier stop', async () => {
    await workingChat();
    await emit('conversation.status', { status: 'idle' });
    await emit('conversation.status', { status: 'working' });
    await act(async () => stops[0].resolve('fail')); await tick();
    expect(stopError()).toBeNull();
  });

  test('unrelated receipts do not confirm; only the matching receipt clears its own error', async () => {
    await workingChat();
    const { clientId } = stops[0];
    await emit('turn.stopped', { was_working: true }, 'c', 'another-command');
    await emit('turn.stopped', { was_working: true }, 'other', clientId);
    await act(async () => stops[0].resolve('fail')); await tick();
    await tick(3000);
    expect(stopError()).toBeOnTheScreen();
    await emit('turn.stopped', { was_working: true }, 'c', 'another-command');
    expect(stopError()).toBeOnTheScreen();
    await emit('turn.stopped', { was_working: true }, 'c', clientId);
    expect(stopError()).toBeNull();
  });
});

test('chat.G1 G2 offline hint waits three seconds and disappears on recovery', async () => {
  await open('/chat?id=c');
  await respond(0, page(100));
  const hint = () => screen.queryByText('连接断开，正在重连…');
  offline = true;
  await act(async () => peer.disconnect());
  await tick(2999);
  expect(hint()).toBeNull();
  await tick(1);
  expect(hint()).toBeOnTheScreen();
  offline = false;
  await tick(12_000);
  expect(hint()).toBeNull();
});

describe('target search (chat.C6 C7 T3)', () => {
  test('failed target reads retain history until automatic recovery locates the target', async () => {
    await openTarget(42);
    expect(before()).toEqual([null, '100']);
    await respond(1, null);
    expect(byId('chat-target-error')).toBeNull();
    expect(rendered(149)).toBe(true); // existing history is shown meanwhile
    await tick(600);
    expect(before()).toEqual([null, '100', '100']);
    await emit('conversation.read', { read_seq: 200 });
    expect(reads).toHaveLength(3); // unrelated updates do not duplicate the automatic read
    await respond(2, page(40));
    expect(byId('chat-target-error')).toBeNull();
    expect(screen.getByTestId('message-target-42')).toBeOnTheScreen();
    expect(placedAt(42)).toBe(true); // the recovered list is placed at the target, not at the latest
    expect(missing()).toBeNull();
  });

  test('recovery continues older pages and reports missing only after successful exhaustion', async () => {
    await openTarget(42);
    await respond(1, null);
    await tick(600);
    await respond(2, page(50));
    expect(before()).toEqual([null, '100', '100', '50']);
    expect(missing()).toBeNull();
    await respond(3, []);
    expect(byId('chat-target-error')).toBeNull();
    expect(missing()).toBeOnTheScreen();
    expect(placement()).toBe('end'); // not found: the list shows the latest
    // Dismissing ends the target; the hint does not come back.
    await fireEvent.press(screen.getByTestId('chat-local-dismiss')); await tick();
    expect(missing()).toBeNull();
  });

  test('first history request failure recovers without a loaded timeline', async () => {
    await open('/chat?id=c&message_seq=42');
    await respond(0, null);
    expect(byId('chat-target-error')).toBeNull();
    await tick(600);
    await respond(1, [message(42)]);
    expect(before()).toEqual([null, null]);
    expect(placedAt(42)).toBe(true);
  });

  test('return to latest exits target mode without cancelling background history recovery', async () => {
    await openTarget(42);
    await respond(1, null);
    await fireEvent.press(screen.getByTestId('chat-return-to-bottom')); await tick();
    expect(byId('chat-target-error')).toBeNull();
    await tick(600);
    await respond(2, page(40));
    expect(byId('chat-target-error')).toBeNull();
    expect(placement()).toBe('end');
    expect(highlighted(42)).toBe(false);
    expect(reads).toHaveLength(3);
  });

  test('after automatic target recovery the return button observes the replacement list', async () => {
    await openTarget(42);
    await respond(1, null); // the failed target shows existing history in a "target-error" list
    const failedList = listSignals.length;
    await tick(600);
    await respond(2, page(40)); // recovery remounts the list ("timeline") placed at the target
    expect(listSignals.length).toBeGreaterThan(failedList);
    expect(placedAt(42)).toBe(true);
    await drag();
    expect(returnButton()).toBeOnTheScreen();
    await act(async () => listSignals[failedList - 1].setAtEnd(true)); await tick();
    expect(returnButton()).toBeOnTheScreen(); // the replaced instance no longer drives the page
    await setAtEnd(true);
    expect(returnButton()).toBeNull();
    await setAtEnd(false);
    expect(returnButton()).toBeOnTheScreen();
  });

  test('deleting the conversation is navigation, not a false missing-message report', async () => {
    await open('/chat?id=c&message_seq=42');
    await respond(0, [message(42)]);
    await act(async () => { peer.state.conversations.splice(0, 1); });
    await emit('conversation.deleted', { id: 'c' }, undefined);
    await tick(300);
    expect(screen.getByTestId('entry-route')).toBeOnTheScreen();
    expect(missing()).toBeNull();
  });
});

describe('placement and reading (chat.T2 T4)', () => {
  test('highlight expires 2.5 s after placement (not during slow loading), keeps READ, is not re-armed by SSE', async () => {
    await open('/chat?id=c&message_seq=42');
    await tick(10_000);
    await respond(0, [message(42)]);
    expect(highlighted(42)).toBe(true);
    await tick(3_000);
    expect(highlighted(42)).toBe(false);
    expect(screen.getByTestId('message-target-42')).toBeOnTheScreen();
    expect(following()).toBe(false); // expiry does not resume following
    await emit('message.user', { text: 'Message 260' });
    expect(highlighted(42)).toBe(false);
    expect(following()).toBe(false);
  });

  test.each(['touch', 'expiry', 'drag', 'send', 'return'] as const)('%s clears the highlight; only send / return jump to latest', async (action) => {
    await openTarget(120);
    expect(placedAt(120)).toBe(true);
    expect(highlighted(120)).toBe(true);
    if (action === 'touch') await fireEvent(screen.getByTestId('message-target-120'), 'touchStart');
    if (action === 'expiry') await tick(2_500);
    if (action === 'drag') await drag();
    if (action === 'send') {
      await fireEvent.changeText(screen.getByTestId('composer-input'), 'Continue');
      await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
      await fireEvent.press(screen.getByTestId('composer-send'));
    }
    if (action === 'return') await fireEvent.press(screen.getByTestId('chat-return-to-bottom'));
    await tick();
    expect(highlighted(120)).toBe(false);
    expect(placedAt(120)).toBe(true); // the mounted list's initial placement is never rewritten
    // Touch and expiry keep target READ; drag, send and return end it. A send ends target READ too, but its
    // pinned view (chat.C9) holds end-follow until the user takes over: the pin tests are in chat-send-pin.
    expect(following()).toBe(action === 'drag' || action === 'return');
    if (action === 'send' || action === 'return') expect(returnButton()).toBeNull();
  });

  test('draft touch keeps the highlight and READ', async () => {
    await openTarget(120);
    await act(async () => peer.emit({ type: 'draft.snapshot', data: { epoch: 'e', revision: 1, as_of_seq: 149,
      drafts: [{ draft_id: 'preview', conversation_id: 'c', sender: 'task', agent: 'agent', text: 'Still writing', phase: 'final' }] } } as unknown as GatewayEvent));
    await tick(300); await layoutGatewayChat();
    const draft = screen.queryByTestId('draft-preview');
    expect(draft).toBeOnTheScreen();
    await fireEvent(draft!, 'touchStart');
    expect(highlighted(120)).toBe(true);
    expect(following()).toBe(false);
    expect(placedAt(120)).toBe(true);
  });

  test.each(['accepted', 'invalid', 'failed', 'conflict'] as const)('form submission %s: only local acceptance releases READ', async (outcome) => {
    const source = JSON.stringify({ root: 'card', elements: {
      card: { type: 'Card', props: {}, children: ['choice', 'submit'] },
      choice: { type: 'ChoiceGroup', props: { stateKey: 'choice', options: [{ value: 'A', label: '甲' }, { value: 'B', label: '乙' }] }, children: [] },
      submit: { type: 'Submit', props: { label: '确定' }, children: [] },
    }, state: { choice: 'A' } });
    await open('/chat?id=c&message_seq=120');
    const events = page(100);
    events[20] = { ...message(120), type: 'message.agent', data: { agent_id: 'agent', text: '```wandrun-ui\n' + source + '\n```' } };
    await respond(0, events);
    const target = screen.getByTestId('message-target-120');
    await fireEvent(target, 'touchStart'); // a form touch removes only the flash
    await fireEvent.press(within(target).getByText('确定')); await tick();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].values).toEqual({ choice: 'A' });
    expect(following()).toBe(false); // in flight is not accepted
    const event = { ...message(260), data: { text: 'Submitted A', ui_submission: { message_seq: 120, block: 0, values: { choice: 'A' } } } };
    const status = { accepted: 200, invalid: 400, failed: 503, conflict: 409 }[outcome];
    await act(async () => submissions[0].resolve(Response.json(outcome === 'accepted' ? { event } : {
      error: { code: outcome === 'invalid' ? 'ui_invalid_values' : outcome === 'conflict' ? 'ui_already_submitted' : 'unavailable',
        message: outcome, ...(outcome === 'conflict' ? { details: { event } } : {}) },
    }, { status })));
    await tick();
    expect(rendered(260)).toBe(outcome === 'accepted' || outcome === 'conflict');
    await setAtEnd(true);
    expect(following()).toBe(outcome === 'accepted');
    expect(returnButton() === null).toBe(outcome === 'accepted');
    expect(placedAt(120)).toBe(true);
  });

  test('chat.C9 T38 an accepted form submission ends the sent-message pin: end-follow is restored', async () => {
    const source = JSON.stringify({ root: 'card', elements: {
      card: { type: 'Card', props: {}, children: ['choice', 'submit'] },
      choice: { type: 'ChoiceGroup', props: { stateKey: 'choice', options: [{ value: 'A', label: '甲' }, { value: 'B', label: '乙' }] }, children: [] },
      submit: { type: 'Submit', props: { label: '确定' }, children: [] },
    }, state: { choice: 'A' } });
    await open('/chat?id=c');
    const events = page(100);
    events[49] = { ...message(149), type: 'message.agent', data: { agent_id: 'agent', text: '```wandrun-ui\n' + source + '\n```' } };
    await respond(0, events);
    await fireEvent.changeText(screen.getByTestId('composer-input'), '先发一条');
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
    await fireEvent.press(screen.getByTestId('composer-send')); await tick();
    expect(following()).toBe(false); // the pinned view holds end-follow
    await fireEvent.press(screen.getByText('确定')); await tick();
    expect(submissions).toHaveLength(1);
    expect(following()).toBe(false); // in flight is not accepted
    const event = { ...message(260), data: { text: 'Submitted A', ui_submission: { message_seq: 149, block: 0, values: { choice: 'A' } } } };
    await act(async () => submissions[0].resolve(Response.json({ event })));
    await tick();
    expect(following()).toBe(true);
  });

  test('prepend while placed keeps the target placement', async () => {
    await openTarget(120);
    await scrollToTop();
    await respond(1, page(50));
    expect(list().props.keys.indexOf('e120')).toBe(70); // the current index moved…
    expect(placedAt(120)).toBe(false); // …but the mount snapshot still holds index 20,
    expect(list().props.initialPlacement).toEqual({ index: 20, viewPosition: 0 }); // never rewritten
  });

  test('a last-message target releases READ once it is at the bottom; later growth does not reclaim it', async () => {
    await openTarget(149);
    expect(placedAt(149)).toBe(true);
    expect(following()).toBe(false); // placed but not yet at the bottom
    await setAtEnd(true); // end geometry settles after readiness
    expect(following()).toBe(true);
    await emit('message.user', { text: 'Message 260' });
    await setAtEnd(false);
    expect(following()).toBe(true); // growth cannot reclaim target priority
    expect(placedAt(149)).toBe(true);
  });

  test('route target changes remount placement: latest → index → latest', async () => {
    await open('/chat?id=c');
    await respond(0, page(100));
    expect(placement()).toBe('end');
    await act(async () => router.setParams({ message_seq: '120' })); await tick(); await layoutGatewayChat();
    expect(placedAt(120)).toBe(true);
    await act(async () => router.setParams({ message_seq: undefined })); await tick(); await layoutGatewayChat();
    expect(placement()).toBe('end');
    expect(byId('message-target-120')).toBeNull();
  });

  test('latest placement stays at the latest through touch, drag, prepend, send and return', async () => {
    await open('/chat?id=c');
    await respond(0, page(100));
    await fireEvent(screen.getByText('Message 149'), 'touchStart');
    await drag();
    await scrollToTop();
    await respond(1, page(50));
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Continue');
    await waitFor(() => expect(screen.getByTestId('composer-send')).toBeEnabled());
    await fireEvent.press(screen.getByTestId('composer-send')); await tick();
    const jump = returnButton();
    if (jump) await fireEvent.press(jump);
    expect(placement()).toBe('end');
  });

  test('changing conversation discards the previous placement even with the same sequence', async () => {
    peer.state.conversations.push({ ...peer.state.conversations[0], id: 'other' });
    await openTarget(120);
    expect(screen.getByTestId('message-target-120')).toBeOnTheScreen();
    await act(async () => router.setParams({ id: 'other', message_seq: '110' })); await tick(300);
    const otherRead = reads.findIndex((read) => read.url.pathname.includes('/other/'));
    expect(otherRead).toBeGreaterThan(0);
    await respond(otherRead, page(100, 20, 'other'));
    expect(placedAt(110)).toBe(true);
    expect(list().props.initialPlacement).toEqual({ index: 10, viewPosition: 0 });
  });
});

test('chat.H4 member execution failure exposes its reason and clears it when a new execution starts', async () => {
  const task: TaskConversation = {
    id: 'child', task_id: 'child', kind: 'task', root_id: 'c', root_title: 'Chat', creator_task_id: 'c', creator_agent_id: 'agent',
    agent_id: 'agent', initiator: 'agent', recipient: 'agent', title: 'Child', status: 'failed', error: 'MODEL_BACKEND_UNAVAILABLE',
    unread: false, read_seq: 0, created_at: 1, updated_at: 1, branch_working: false,
  };
  peer.state.tasks.push(task);
  peer.state.histories.set('child', []);
  await open('/chat?id=child');
  await tick(300);
  expect(screen.getByText(/MODEL_BACKEND_UNAVAILABLE/)).toBeOnTheScreen();
  await emit('task.status', { task_id: 'child', status: 'running', error: null, timeline_ids: ['c', 'child'] });
  expect(screen.queryByText(/MODEL_BACKEND_UNAVAILABLE/)).toBeNull();
});
