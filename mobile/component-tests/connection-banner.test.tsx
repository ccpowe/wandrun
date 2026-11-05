import { composeStories } from '@storybook/react';
import { act, render, screen } from '@testing-library/react-native';
import * as stories from '../src/lib/connection-banner.stories';
const { hidden: Hidden, reconnecting: Reconnecting, error: ErrorStory } = composeStories(stories);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
test('ConnectionBanner.hidden 在线不显示', async () => {
  await render(<Hidden />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
});
test('ConnectionBanner.reconnecting 三秒后显示', async () => {
  await render(<Reconnecting />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  await act(() => jest.advanceTimersByTime(3000));
  expect(screen.getByText('连接断开，正在重连…')).toBeOnTheScreen();
});
test('ConnectionBanner.error 可重试错误持续三秒后显示一次原因', async () => {
  await render(<ErrorStory />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  await act(() => jest.advanceTimersByTime(3000));
  expect(screen.getByText('连不上网关')).toBeOnTheScreen();
  expect(screen.getByText('内容可能不是最新的')).toBeOnTheScreen();
});

test('ConnectionBanner.error 原因更新与恢复在线', async () => {
  const session = stories.bannerSession('error', '连不上网关');
  const view = await render(<ErrorStory session={session} />);
  await act(() => jest.advanceTimersByTime(3000));
  session.notice = '令牌不对';
  await view.rerender(<ErrorStory session={session} />);
  expect(screen.getByText('令牌不对')).toBeOnTheScreen();
  expect(screen.queryByText('连不上网关')).toBeNull();
  session.connection = 'open';
  await view.rerender(<ErrorStory session={session} />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
});

test('ConnectionBanner.hidden 短断线取消旧计时并重新计时', async () => {
  const session = stories.bannerSession('open');
  const view = await render(<Hidden session={session} />);
  session.connection = 'reconnecting';
  await view.rerender(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(2999));
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  session.connection = 'open';
  await view.rerender(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(3000));
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  session.connection = 'reconnecting';
  await view.rerender(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(2999));
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  await act(() => jest.advanceTimersByTime(1));
  expect(screen.getByText('连接断开，正在重连…')).toBeOnTheScreen();
  session.connection = 'open';
  await view.rerender(<Hidden session={session} />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
});

test('ConnectionBanner.reconnecting 连续离线共用期限，可重试错误不提前显示', async () => {
  const session = stories.bannerSession('listing');
  const view = await render(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(600));
  session.connection = 'connecting';
  await view.rerender(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(2399));
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  session.connection = 'reconnecting';
  await view.rerender(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(1));
  expect(screen.getByText('连接断开，正在重连…')).toBeOnTheScreen();
  session.connection = 'open';
  await view.rerender(<Hidden session={session} />);
  session.connection = 'connecting';
  await view.rerender(<Hidden session={session} />);
  await act(() => jest.advanceTimersByTime(10));
  session.connection = 'error';
  session.notice = '令牌不对';
  await view.rerender(<Hidden session={session} />);
  expect(screen.queryByText('令牌不对')).toBeNull();
  await act(() => jest.advanceTimersByTime(2990));
  expect(screen.getByText('令牌不对')).toBeOnTheScreen();
  session.connection = 'open';
  session.notice = null;
  await view.rerender(<Hidden session={session} />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
});

test('ConnectionBanner.hidden 换会话不继承显示期限', async () => {
  const view = await render(<Reconnecting />);
  await act(() => jest.advanceTimersByTime(3000));
  expect(screen.getByText('内容可能不是最新的')).toBeOnTheScreen();
  const session = stories.bannerSession('connecting');
  await view.rerender(<Reconnecting session={session} />);
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
  await act(() => jest.advanceTimersByTime(2999));
  expect(screen.queryByText('内容可能不是最新的')).toBeNull();
});
