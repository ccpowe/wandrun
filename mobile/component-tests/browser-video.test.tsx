import { act, fireEvent, render } from '@testing-library/react-native';
import { composeStories } from '@storybook/react';
import * as stories from '../src/dev/browser-video.stories';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock({}));
const Stories = composeStories(stories);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('browser.D4 startup failure offers retry only, never manual screenshot fallback', async () => {
  const view = await render(<Stories.D4Join/>);
  expect(view.getByText('无法显示视频')).toBeVisible();
  expect(view.getByRole('button', { name: '打开键盘' })).toBeDisabled();
  await fireEvent.press(view.getByRole('button', { name: '重试视频' }));
  expect(view.getByText('Storybook：重试视频')).toBeVisible();
  expect(view.queryByRole('button', { name: '改用截图' })).toBeNull();
});
test('browser.D4 cdp-unreachable gives the existing browser-start recovery reason', async () => {
  const view = await render(<Stories.D4Cdp/>);
  expect(view.getByText('浏览器连接不可用，请确认浏览器已启动后重试')).toBeVisible();
  expect(view.getByRole('button', { name: '重试视频' })).toBeEnabled();
});
test('browser.D4 page-publish-timeout offers explicit retry', async () => {
  const view = await render(<Stories.D4PublishTimeout/>);
  expect(view.getByText('页面视频发布超时')).toBeVisible();
  expect(view.getByRole('button', { name: '重试视频' })).toBeEnabled();
});
test('browser.D2 / D6 pause keyboard and expose continuous-state notices', async () => {
  const view = await render(<Stories.D2/>);
  expect(view.getByText('正在连接视频…')).toBeVisible();
  expect(view.getByRole('button', { name: '打开键盘' })).toBeDisabled();
  await view.rerender(<Stories.D6/>);
  expect(view.queryByText('视频重连中…')).toBeNull();
  await act(() => jest.advanceTimersByTime(2999));
  expect(view.queryByText('视频重连中…')).toBeNull();
  await act(() => jest.advanceTimersByTime(1));
  expect(view.getByText('视频重连中…')).toBeVisible();
  expect(view.queryByText('无法显示视频')).toBeNull();
  expect(view.queryByRole('button', { name: '重试视频' })).toBeNull();
});
test('browser.D10 unconfirmed input has no dismiss action and does not lock subsequent control', async () => {
  const view = await render(<Stories.D10/>);
  expect(view.queryByText('部分操作结果未确认，请检查页面')).toBeNull();
  await act(() => jest.advanceTimersByTime(3000));
  expect(view.getByText('部分操作结果未确认，请检查页面')).toBeVisible();
  expect(view.queryByRole('button', { name: '关闭提示' })).toBeNull();
  expect(view.getByRole('button', { name: '打开键盘' })).toBeEnabled();
});
