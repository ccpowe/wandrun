import { fireEvent, screen, within } from '@testing-library/react-native';
import { Linking } from 'react-native';
import ChatRoute from '../src/app/chat';
import type { Conversation } from '../src/gateway/api';
import type { RichSpec } from '../src/components/rich-message/spec';
import { FakeGateway, unavailable } from '../src/dev/fake-gateway';
import { renderGateway, seedGatewayAgent, tickGateway as tick } from './gateway-harness';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));

// All scenarios enter through the same persisted Agent message, not a RichBlock host.
const spec: RichSpec = {
  root: 'root', state: { plan: 'review', note: '' },
  elements: {
    root: { type: 'Stack', props: { gap: 'lg' }, children: ['status', 'table', 'tabs', 'sources', 'scroll', 'planField', 'noteField', 'actions'] },
    status: { type: 'Status', props: { title: '发布检查状态', badge: { text: '可交付', tone: 'success' }, progress: 72, caption: '已核对 18 项' }, children: [] },
    table: { type: 'Table', props: { columns: ['检查项', '结果'], rows: [['消息入口', { badge: { text: '通过', tone: 'success' } }], ['表单持久化', { badge: { text: '待确认', tone: 'warning' } }]] }, children: [] },
    tabs: { type: 'Tabs', props: { tabs: [{ label: '概览' }, { label: '细节' }] }, children: ['overview', 'accordion'] },
    overview: { type: 'Text', props: { text: '发布概览正文' }, children: [] },
    accordion: { type: 'Accordion', props: { title: '查看核对记录' }, children: ['details'] },
    details: { type: 'Text', props: { text: '核对记录正文' }, children: [] },
    sources: { type: 'Source', props: { items: [{ title: '发布依据', url: 'https://example.com/release' }, { title: '接口依据', url: 'https://example.org/api' }] }, children: [] },
    scroll: { type: 'ScrollRow', props: {}, children: ['statA', 'statB', 'statC'] },
    statA: { type: 'StatCard', props: { icon: 'activity', label: '本周完成', value: '28', badge: { text: '稳定', tone: 'success' } }, children: [] },
    statB: { type: 'StatCard', props: { label: '待处理', value: '3' }, children: [], width: '1/2' },
    statC: { type: 'StatCard', props: { label: '进行中', value: '7' }, children: [] },
    planField: { type: 'Field', props: { label: '发布方式', value: '可选' }, children: ['plan'] },
    noteField: { type: 'Field', props: { label: '发布备注' }, children: ['note'] },
    actions: { type: 'ButtonRow', props: {}, children: ['submit'] },
    plan: { type: 'ChoiceGroup', props: { stateKey: 'plan', label: '发布方式', options: [{ value: 'review', label: '先复核' }, { value: 'ship', label: '直接发布' }] }, children: [] },
    note: { type: 'TextInput', props: { stateKey: 'note', label: '发布备注', placeholder: '填写核对说明' }, children: [] },
    submit: { type: 'Submit', props: { label: '确认发布' }, children: [] },
  },
};
const text = `以下是同一份发布检查。\n\n\`\`\`wandrun-ui\n${JSON.stringify(spec)}\n\`\`\``;
let peer: FakeGateway;
beforeEach(() => {
  jest.useFakeTimers();
  // LegendList keeps a row non-interactive until the native ref.measure callback.
  // The official RN mock leaves that callback pending; supply only that boundary.
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 400, 600, 0, 0));
  peer = new FakeGateway({ seq: 100 });
  seedGatewayAgent(peer);
  const conversation: Conversation = {
    id: 'rich', agent_id: 'research', title: '发布检查', created_at: 1, updated_at: 2,
    last_activity_seq: 20, last_activity_at: 2, read_seq: 100, last_agent_seq: 20,
    status: 'idle', unread: false, last_text: text, source: 'user', schedule_origin: null,
  };
  peer.state.conversations.push(conversation);
  peer.state.histories.set('rich', [{ seq: 20, type: 'message.agent', at: 2, conversation_id: 'rich', data: { agent_id: 'research', text, ui: [{ block: 0, valid: true }] } }]);
});
afterEach(() => {
  peer.disconnect();
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measure.mockReset();
  jest.restoreAllMocks(); jest.useRealTimers();
});

async function openMessage() {
  await renderGateway(peer, ChatRoute, '/chat', {}, '/chat?id=rich');
  // Jest has no Yoga/scroll viewport: supply only native measurements to the real list.
  let composer = screen.getByTestId('composer-input').parent;
  while (composer && typeof composer.props.onLayout !== 'function') composer = composer.parent;
  if (!composer) throw new Error('Composer measurement boundary missing');
  await fireEvent(composer, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 70 } } });
  for (const scroll of screen.container.queryAll(node => node.type === 'RCTScrollView' && typeof node.props.onLayout === 'function')) {
    await fireEvent(scroll, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 650 } } });
  }
  await tick(200);
  for (const node of screen.getByTestId('rich-block').queryAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
    await fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 100 } } });
  }
  await tick();
  expect(screen.getByTestId('rich-submit')).toBeVisible();
  // A+ boundary: the block has inputs, so the renderer frames it; the read-only Status sits inside the frame.
  expect(within(screen.getByTestId('rich-framed')).getByTestId('rich-submit')).toBeVisible();
  expect(within(screen.getByTestId('rich-framed')).getByText('发布检查状态')).toBeVisible();
}

const submissions = () => peer.state.histories.get('rich')!.filter(event => event.type === 'message.user' && event.data.ui_submission);
async function fillForm() {
  expect(screen.getByRole('radio', { name: '发布方式：直接发布' })).toBeVisible();
  await fireEvent.press(screen.getByRole('radio', { name: '发布方式：直接发布' }));
  expect(screen.getByRole('radio', { name: '发布方式：直接发布' })).toBeChecked();
  await fireEvent.changeText(screen.getByLabelText('发布备注'), '保留这份发布说明');
  expect(screen.getByLabelText('发布备注')).toHaveDisplayValue('保留这份发布说明');
}

test('真实消息呈现 Status、进度及表格行对应的状态语义', async () => {
  await openMessage();
  expect(screen.queryByTestId('rich-invalid')).toBeNull();
  expect(screen.getByText('以下是同一份发布检查。')).toBeOnTheScreen();
  expect(screen.getByText('发布检查状态')).toBeOnTheScreen();
  expect(screen.getByText('可交付')).toBeOnTheScreen();
  expect(screen.getByText('已核对 18 项')).toBeOnTheScreen();
  expect(screen.getByRole('progressbar')).toHaveAccessibilityValue({ min: 0, max: 100, now: 72 });
  expect(screen.getByText('检查项')).toBeOnTheScreen();
  expect(screen.getByText('结果')).toBeOnTheScreen();
  const messageRow = screen.getByText('消息入口').parent!.parent!;
  const formRow = screen.getByText('表单持久化').parent!.parent!;
  expect(within(messageRow).getByText('通过')).toBeOnTheScreen();
  expect(within(messageRow).queryByText('待确认')).toBeNull();
  expect(within(formRow).getByText('待确认')).toBeOnTheScreen();
});

test('Field.default / ButtonRow.default / ScrollRow.overflow 经真实聊天呈现并保留输入无障碍标签', async () => {
  await openMessage();
  expect(screen.getAllByText('发布方式')).toHaveLength(1);
  expect(screen.getAllByText('发布备注')).toHaveLength(1);
  expect(screen.getByText('本周完成')).toBeVisible();
  expect(screen.getByText('稳定')).toBeVisible();
  expect(screen.getByTestId('rich-scroll-row')).toHaveProp('scrollEnabled', true);
  expect(screen.getByTestId('rich-scroll-row')).toHaveProp('showsHorizontalScrollIndicator', false);
  expect(within(screen.getByTestId('rich-button-row')).getByRole('button', { name: '确认发布' })).toBeEnabled();
  await fillForm();
  await fireEvent(screen.getByTestId('rich-stack'), 'layout', { nativeEvent: { layout: { width: 280, height: 400 } } });
  expect(screen.getByLabelText('发布备注')).toHaveDisplayValue('保留这份发布说明');
  expect(screen.getByRole('radio', { name: '发布方式：直接发布' })).toBeChecked();
});

test('同一消息的 Tabs、Accordion、Sources 开合与链接目标由真实控件驱动', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  await openMessage();
  expect(screen.getByText('发布概览正文')).toBeVisible();
  expect(screen.queryByText('核对记录正文')).toBeNull();
  await fireEvent.press(screen.getByTestId('rich-tab-1'));
  expect(screen.getByTestId('rich-tab-1')).toBeSelected();
  expect(screen.queryByText('发布概览正文')).toBeNull();
  expect(screen.queryByText('核对记录正文')).toBeNull();
  await fireEvent.press(screen.getByTestId('rich-accordion-toggle'));
  expect(screen.getByText('核对记录正文')).toBeVisible();
  await fireEvent.press(screen.getByTestId('rich-tab-0'));
  await fireEvent.press(screen.getByTestId('rich-tab-1'));
  expect(screen.getByText('核对记录正文')).toBeVisible();
  await fireEvent.press(screen.getByTestId('rich-accordion-toggle'));
  expect(screen.queryByText('核对记录正文')).toBeNull();
  const sources = screen.getByRole('button', { name: '来源，2 条' });
  expect(sources).toBeCollapsed();
  expect(screen.queryByTestId('rich-source-rail')).toBeNull();
  await fireEvent.press(sources);
  expect(sources).toBeExpanded();
  await fireEvent.press(screen.getByRole('link', { name: '来源 1，发布依据，https://example.com/release' }));
  expect(openURL).toHaveBeenCalledWith('https://example.com/release');
  expect(screen.getByRole('link', { name: '来源 2，接口依据，https://example.org/api' })).toHaveTextContent(/接口依据/);
  await fireEvent.press(sources);
  expect(screen.queryByTestId('rich-source-rail')).toBeNull();
});

test('表单经真实 GatewayApi 提交一次，持久回执把选项和输入变为只读', async () => {
  await openMessage();
  await fillForm();
  await fireEvent.press(screen.getByTestId('rich-submit'));
  await tick();
  expect(jest.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/conversations/rich/ui-submissions') && init?.method === 'POST')).toHaveLength(1);
  expect(submissions()).toHaveLength(1);
  expect(submissions()[0].data.ui_submission).toEqual({ message_seq: 20, block: 0, values: { plan: 'ship', note: '保留这份发布说明' } });
  expect(screen.getByText('直接发布')).toBeOnTheScreen();
  expect(screen.getByText('保留这份发布说明')).toBeOnTheScreen();
  expect(within(screen.getByTestId('rich-framed')).getByText(/^已提交 · /)).toBeOnTheScreen();
  expect(screen.queryByTestId('rich-input-note')).toBeNull();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.queryByTestId('rich-submit')).toBeNull();
});

test('提交失败保留输入与选择，重试复用同次值及 client_id 而不重复持久化', async () => {
  let fail = true;
  peer.overrides['POST /conversations/:id/ui-submissions'] = () => {
    if (fail) { fail = false; return unavailable('提交回执暂不可用'); }
  };
  await openMessage();
  await fillForm();
  await fireEvent.press(screen.getByTestId('rich-submit'));
  await tick();
  expect(within(screen.getByTestId('rich-framed')).getByTestId('rich-submit-error')).toHaveTextContent(/提交结果尚未确认，请保持当前选择后重试。/);
  expect(screen.getByTestId('rich-input-note')).toHaveDisplayValue('保留这份发布说明');
  expect(screen.getByRole('radio', { name: '发布方式：直接发布' })).toBeChecked();
  expect(screen.getByRole('radio', { name: '发布方式：直接发布' })).toBeDisabled();
  expect(screen.getByTestId('rich-submit')).toBeDisabled();
  expect(submissions()).toHaveLength(0);
  await fireEvent.press(screen.getByTestId('rich-submit-retry'));
  await tick();
  const calls = jest.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/conversations/rich/ui-submissions') && init?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[1][1]?.body))).toEqual(JSON.parse(String(calls[0][1]?.body)));
  expect(submissions()).toHaveLength(1);
  expect(screen.getByText('保留这份发布说明')).toBeOnTheScreen();
  expect(screen.queryByTestId('rich-input-note')).toBeNull();
  expect(screen.queryByTestId('rich-submit-error')).toBeNull();
});
