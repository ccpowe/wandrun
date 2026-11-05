import { composeStories } from '@storybook/react';
import { act, render, screen } from '@testing-library/react-native';
import * as stories from '../src/dev/browser-view.stories';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
// Same official Skia mock as browser.test.tsx; these views assert notice controls, not drawing.
jest.mock('@shopify/react-native-skia/lib/commonjs/Platform', () => {
  const noop = () => undefined;
  return { OS: 'web', PixelRatio: 1, requireNativeComponent: noop, resolveAsset: noop, findNodeHandle: noop, NativeModules: noop, View: noop };
});
jest.mock('@shopify/react-native-skia/lib/commonjs/skia/core/Font', () => ({ useFont: () => null, matchFont: () => null, listFontFamilies: () => [], useFonts: () => null }));
jest.mock('@shopify/react-native-skia', () => jest.requireActual('@shopify/react-native-skia/lib/commonjs/mock').Mock({}));
const Stories = composeStories(stories);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// browser.A6 closing is proven on the real viewer page in browser.test.tsx.

test('browser.A7 结果未确认横幅没有 ×，核对前不可关闭', async () => {
  await render(<Stories.A7 />);
  expect(screen.queryByTestId('browser-error')).toBeNull();
  await act(() => jest.advanceTimersByTime(3000));
  expect(screen.getByTestId('browser-error')).toHaveTextContent(/^操作结果未确认/);
  expect(screen.queryByTestId('browser-error-dismiss')).toBeNull();
});

// The dismiss transition itself (BrowserRuntime.dismissTypingNotice) is L1 in browser_keyboard_lifecycle;
// these view tests prove presentation by state: a persistent state has no ×, a one-time result does.
test('browser.B7 部分文字未发送是持续状态：无 ×，保留重试发送入口（发送成功清除见 L1）', async () => {
  await render(<Stories.B7 />);
  expect(screen.getByTestId('browser-input-notice')).toHaveTextContent(/部分文字尚未发送，已保留；画面恢复后可重试发送/);
  expect(screen.queryByTestId('browser-input-dismiss')).toBeNull();
  expect(screen.getByRole('button', { name: '重试发送' })).toBeOnTheScreen();
});

test('browser.B7 部分输入已丢弃是一次性结果：横幅内有 ×，无重试', async () => {
  await render(<Stories.B7Discarded />);
  expect(screen.getByTestId('browser-input-notice')).toHaveTextContent(/部分输入未发送且已丢弃/);
  expect(screen.getByTestId('browser-input-dismiss')).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: '重试发送' })).toBeNull();
});

test('browser.A4 运行时持续状态（任务结束等）的横幅无 ×', async () => {
  await render(<Stories.A4Ended />);
  expect(screen.getByTestId('browser-error')).toHaveTextContent('浏览器任务已结束');
  expect(screen.queryByTestId('browser-error-dismiss')).toBeNull();
});
