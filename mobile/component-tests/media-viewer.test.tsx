import { composeStories } from '@storybook/react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as stories from '../src/dev/media-viewer.stories';

jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
const { B1, A1 } = composeStories(stories);

test('media.B1 从选定附件进入，横向滚动立即更新页码，结束后仍可操作', async () => {
  await render(<B1 />);
  expect(screen.getByText('2 / 3')).toBeOnTheScreen();
  await fireEvent.scroll(screen.getByTestId('media-gallery-list'), { nativeEvent: {
    contentOffset: { x: 720, y: 0 }, layoutMeasurement: { width: 360, height: 640 }, contentSize: { width: 1080, height: 640 },
  } });
  expect(screen.getByText('3 / 3')).toBeOnTheScreen();
  await fireEvent(screen.getByTestId('media-gallery-list'), 'momentumScrollEnd', { nativeEvent: {
    contentOffset: { x: 0, y: 0 }, layoutMeasurement: { width: 360, height: 640 },
  } });
  expect(screen.getByText('1 / 3')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
});

test('media.A1 无效坐标不展示相册，仍有返回入口', async () => {
  await render(<A1 />);
  expect(screen.getByText('媒体位置无效或图片已不可用')).toBeOnTheScreen();
  expect(screen.queryByTestId('media-attachment-gallery')).toBeNull();
  expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
});
