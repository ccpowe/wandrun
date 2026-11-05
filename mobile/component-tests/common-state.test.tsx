import { composeStories } from '@storybook/react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as loading from '../src/components/loading-state.stories';
import * as empty from '../src/components/empty-state.stories';
import { Button } from '../src/components/ui/button';
import { Text } from '../src/components/ui/text';
import { LoadingState } from '../src/components/loading-state';

const Loading = composeStories(loading);
const Empty = composeStories(empty);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('LoadingState.pending 300ms 前无指示，之后居中加载，完成后不闪回', async () => {
  const view = await render(<Loading.pending />);
  await act(() => jest.advanceTimersByTime(299));
  expect(screen.queryByRole('progressbar')).toBeNull();
  await act(() => jest.advanceTimersByTime(1));
  expect(screen.getByRole('progressbar', { name: '加载中…' })).toBeOnTheScreen();
  await view.unmount();
  await render(<Loading.pending />);
  await act(() => jest.advanceTimersByTime(100));
  await screen.unmount();
  await act(() => jest.advanceTimersByTime(300));
});

test('LoadingState.delay 改期限会取消旧计时，已经显示的指示不因期限改变而消失', async () => {
  const view = await render(<LoadingState delayMs={300} />);
  await act(() => jest.advanceTimersByTime(200));
  await view.rerender(<LoadingState delayMs={500} />);
  await act(() => jest.advanceTimersByTime(100));
  expect(screen.queryByRole('progressbar')).toBeNull();
  await act(() => jest.advanceTimersByTime(400));
  expect(screen.getByRole('progressbar', { name: '加载中…' })).toBeOnTheScreen();
  await view.rerender(<LoadingState delayMs={1000} />);
  expect(screen.getByRole('progressbar', { name: '加载中…' })).toBeOnTheScreen();
  await view.unmount();
  await act(() => jest.advanceTimersByTime(1000));
});

test('EmptyState.default 插画和标题，不显示创建入口', async () => {
  await render(<Empty.Default />);
  expect(screen.getByText('还没有 Agent')).toBeOnTheScreen();
  expect(screen.getByLabelText('两只小生物举着一张白纸')).toBeOnTheScreen();
  expect(screen.queryByRole('button')).toBeNull();
});
test('EmptyState.action 调用方提供的操作入口可用', async () => {
  const onPress = jest.fn();
  await render(<Empty.action><Button onPress={onPress}><Text>创建</Text></Button></Empty.action>);
  await fireEvent.press(screen.getByRole('button', { name: '创建' }));
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(screen.getByText('到点后会开启新对话。')).toBeOnTheScreen();
});

