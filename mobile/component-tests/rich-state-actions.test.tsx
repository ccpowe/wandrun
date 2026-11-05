import { composeStories } from '@storybook/react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { act, within } from '@testing-library/react-native';
import * as stories from '../src/dev/rich/state-actions.stories';
import { RichBlock } from '../src/components/rich-message/block';
import { ChatSession } from '../src/gateway/session';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const { BoundValue, BoundSubmitted, FieldSubmittedValues, BoundVisible, CopyIdle, CopyBound, FollowUpsIdle, FollowUpsSending,
  FollowUpsError, FollowUpsUnknown, FollowUpsChecking, StatCardTappable, SendButton } = composeStories(stories);

test('Bound.value Field 的 Slider 实时值可见，选项绑定显示 label', async () => {
  await render(<BoundValue />);
  expect(screen.getAllByText('1500')).toHaveLength(2);
  expect(screen.queryByText('week')).toBeNull();
  await fireEvent(screen.getByLabelText('预算滑块'), 'valueChange', 2100);
  expect(screen.getAllByText('2100')).toHaveLength(2);
  expect(screen.queryByText('1500')).toBeNull();
  await fireEvent.press(screen.getByText('每月'));
  expect(screen.queryByText('month')).toBeNull();
  expect(screen.getAllByText('每月')).toHaveLength(3);
});

test('同服务器切换会话实例时，块读取新会话草稿，不沿用旧访问闭包', async () => {
  const spec = stories.BoundValue.args!.fixture.spec;
  const config = { baseUrl: 'https://rich-state.invalid', token: 'story', computerId: 'same-computer' };
  const first = new ChatSession(config);
  const second = new ChatSession(config);
  first.saveUiDraft('chat', 1, 0, { values: { ...spec.state, budget: 2100 }, flow: { status: 'editing' } });
  second.saveUiDraft('chat', 1, 0, { values: { ...spec.state, budget: 900 }, flow: { status: 'editing' } });
  const source = JSON.stringify(spec);
  const onSubmit = jest.fn(async () => undefined);
  const view = await render(<RichBlock source={source} onSubmit={onSubmit} draft={{ session: first, conversationId: 'chat', messageSeq: 1, block: 0 }} />);
  expect(screen.getAllByText('2100')).toHaveLength(2);
  await view.rerender(<RichBlock source={source} onSubmit={onSubmit} draft={{ session: second, conversationId: 'chat', messageSeq: 1, block: 0 }} />);
  expect(screen.queryByText('2100')).toBeNull();
  expect(screen.getAllByText('900')).toHaveLength(2);
  await view.unmount();
  await first.close();
  await second.close();
});

test('Bound.submitted 已提交绑定按持久值只读显示', async () => {
  await render(<BoundSubmitted />);
  expect(screen.queryByTestId('rich-slider-budget')).toBeNull();
  expect(within(screen.getByText('预算').parent!).getByText('1500')).toBeVisible();
  expect(screen.queryByText('week')).toBeNull();
  expect(screen.getByText(/已提交/)).toBeVisible();
});

test('Bound.submitted Field 只去除同 key 的重复值，固定说明与其他绑定不隐藏真实输入', async () => {
  await render(<FieldSubmittedValues />);
  expect(within(screen.getByText('预算').parent!.parent!).getAllByText('1500')).toHaveLength(1);
  expect(screen.getByText('固定说明')).toBeVisible();
  expect(screen.getByText('保留备注')).toBeVisible();
  expect(screen.getByText('另一个值')).toBeVisible();
});

test('Bound.visible / rich.T8 状态变化立即隐藏并按持久值只读保留', async () => {
  await render(<BoundVisible />);
  expect(screen.queryByText('详细说明已展开')).toBeNull();
  expect(screen.getByText('当前只显示摘要')).toBeVisible();
  await fireEvent(screen.getByLabelText('显示详细说明'), 'checkedChange', true);
  expect(screen.queryByText('当前只显示摘要')).toBeNull();
  expect(screen.getByText('详细说明已展开')).toBeVisible();
  await fireEvent.press(screen.getByLabelText('提交设置'));
  expect(screen.queryByTestId('rich-switch-details')).toBeNull();
  expect(screen.getByText('详细说明已展开')).toBeVisible();
});

test('FollowUps.idle / rich.T1–T2 真实 peer 接受后只保留选中追问及发送回执', async () => {
  await render(<FollowUpsIdle />);
  await fireEvent.press(screen.getByLabelText('继续展开'));
  expect(screen.getByText('继续展开')).toBeVisible();
  expect(screen.queryByLabelText('继续展开')).toBeNull();
  expect(screen.queryByText('给一个例子')).toBeNull();
  expect(screen.queryByText('改成表格')).toBeNull();
  expect(screen.getByText(/已发送 ·/)).toBeVisible();
});

test('Send.sending 同组禁用；Send.error 明确失败只能通过同项重试', async () => {
  const view = await render(<FollowUpsSending />);
  expect(screen.getByLabelText('给一个例子')).toBeDisabled();
  expect(screen.getByLabelText('继续展开')).toBeDisabled();
  expect(screen.getByText('正在发送…')).toBeVisible();
  await view.unmount();
  await render(<FollowUpsError />);
  await fireEvent.press(screen.getByLabelText('给一个例子'));
  expect(screen.getByLabelText('继续展开')).toBeDisabled();
  expect(screen.getByLabelText('给一个例子')).toBeDisabled();
  expect(screen.getByLabelText('重试')).toBeEnabled();
  await fireEvent.press(screen.getByLabelText('重试'));
  expect(screen.getByText('发送失败，请重试。')).toBeVisible();
  expect(screen.queryByText(/已发送 ·/)).toBeNull();
});

test('Send.error / rich.T4、T10 不能改选，核对失败可再查，确认null后仅重试同项', async () => {
  await render(<FollowUpsUnknown />);
  await fireEvent.press(screen.getByLabelText('改成表格'));
  expect(screen.getByText('发送结果尚未确认，恢复连接后会核对。')).toBeVisible();
  expect(screen.queryByLabelText('重试')).toBeNull();
  expect(screen.getByLabelText('继续展开')).toBeDisabled();
  expect(screen.getByLabelText('核对结果')).toBeEnabled();
  await fireEvent.press(screen.getByLabelText('核对结果'));
  expect(screen.getByLabelText('核对结果')).toBeEnabled();
  expect(screen.queryByLabelText('重试')).toBeNull();
  await fireEvent.press(screen.getByLabelText('核对结果'));
  expect(screen.getByText('尚未发送，可以重试。')).toBeVisible();
  expect(screen.getByLabelText('继续展开')).toBeDisabled();
  await fireEvent.press(screen.getByLabelText('重试'));
  expect(screen.getByText('给一个例子')).toBeVisible();
  expect(screen.queryByText('继续展开')).toBeNull();
  expect(screen.getByText(/已发送 ·/)).toBeVisible();
});

test('Send.checking 只读核对进行中禁用入口，不出现发送重试', async () => {
  await render(<FollowUpsChecking />);
  expect(screen.getByLabelText('核对中…')).toBeDisabled();
  expect(screen.getByLabelText('继续展开')).toBeDisabled();
  expect(screen.queryByLabelText('重试')).toBeNull();
});

test('StatCard.sent 同组卡全部保留且只读，仅选中项有已选标记', async () => {
  await render(<StatCardTappable />);
  await fireEvent(screen.getByTestId('rich-grid'), 'layout', { nativeEvent: { layout: { width: 320, height: 180 } } });
  await fireEvent.press(screen.getByLabelText('专业方案'));
  await fireEvent(screen.getByTestId('rich-grid'), 'layout', { nativeEvent: { layout: { width: 320, height: 180 } } });
  expect(screen.getByText('基础方案')).toBeVisible();
  expect(screen.getByText('专业方案')).toBeVisible();
  expect(screen.queryByLabelText('基础方案')).toBeNull();
  expect(screen.queryByLabelText('专业方案')).toBeNull();
  expect(within(screen.getByText('已选').parent!).getByText('专业方案')).toBeVisible();
  expect(screen.getByText(/已发送 ·/)).toBeVisible();
});

test('Send.sent Submit 的 send 走受控动作并变只读，本地复制仍可用', async () => {
  await render(<SendButton />);
  await fireEvent.press(screen.getByLabelText('继续分析'));
  expect(screen.getByText('继续分析')).toBeVisible();
  expect(screen.queryByLabelText('继续分析')).toBeNull();
  expect(screen.getByLabelText('复制')).toBeEnabled();
  expect(screen.getByText(/已发送 ·/)).toBeVisible();
});

test('Copy.done / rich.T6 复制选项显示文本并在两秒后恢复', async () => {
  const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  await render(<CopyBound />);
  await fireEvent.press(screen.getByText('每月'));
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'setImmediate', 'nextTick'] });
  try {
    await fireEvent.press(screen.getByLabelText('复制频率'));
    expect(copy).toHaveBeenLastCalledWith('每月');
    expect(screen.getByText('已复制')).toBeVisible();
    await act(() => jest.advanceTimersByTime(2000));
    expect(screen.queryByText('已复制')).toBeNull();
    expect(screen.getByText('复制频率')).toBeVisible();
  } finally { jest.useRealTimers(); copy.mockRestore(); }
});

test('Copy.failed 复制失败就地提示，不改动原文本', async () => {
  const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(false);
  try {
    await render(<CopyIdle />);
    await fireEvent.press(screen.getByLabelText('复制命令'));
    expect(screen.getByText('无法复制')).toBeVisible();
    expect(screen.getByText('pnpm run storybook')).toBeVisible();
  } finally { copy.mockRestore(); }
});
