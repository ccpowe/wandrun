import { act, render, screen } from '@testing-library/react-native';
import { router, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import MediaViewer from '../src/app/media-viewer';
import VideoPlayer from '../src/app/video-player';
import { SceneProviders } from '../src/dev/scene-providers';
import { SessionProvider } from '../src/lib/session-context';
import { StatusBarTheme } from '../src/lib/use-status-bar-appearance';

let mockTheme: 'light' | 'dark' = 'light';
const mockPlayer = { pause: jest.fn(), addListener: () => ({ remove() {} }) };
jest.mock('uniwind', () => ({ ...jest.requireActual('uniwind'), useUniwind: () => ({ theme: mockTheme }) }));
jest.mock('expo-video', () => ({ VideoView: jest.requireActual('react-native').View, useVideoPlayer: () => mockPlayer }));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
// Jest's CJS runtime cannot import the deferred player; load the real screen eagerly, not a fake view.
jest.mock('../src/components/chat/attachment-media', () => ({
  ...jest.requireActual('../src/components/chat/attachment-media'),
  VideoPlayerScreen: (props: unknown) => jest.requireActual('react').createElement(
    jest.requireActual('../src/components/chat/video-native').VideoPlayerScreen, props),
}));

function ThemedPage() { return <Text>主题页面</Text>; }
const routes = { '/': ThemedPage, '/normal': ThemedPage, '/media-viewer': MediaViewer, '/video-player': VideoPlayer };
function Fixture() {
  return <><StatusBarTheme /><SessionProvider><SceneProviders routes={routes}>{null}</SceneProviders></SessionProvider></>;
}
const tick = () => act(async () => { await jest.advanceTimersByTimeAsync(150); });
const push = async (path: string) => { await act(() => router.push(path as Href)); await tick(); };
const back = async () => { await act(() => router.back()); await tick(); };
let style: jest.SpyInstance;
beforeEach(() => { jest.useFakeTimers(); mockTheme = 'light'; style = jest.spyOn(StatusBar, 'setStyle').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
const expectStyle = (expected: 'light' | 'dark') => expect(style).toHaveBeenLastCalledWith(expected);

test('media.B1 retained gallery loses focus to a themed page and regains its light icons on back', async () => {
  await render(<Fixture />); await tick();
  expectStyle('dark');
  await push('/media-viewer?file_id=photo');
  expect(screen.getByTestId('media-attachment-gallery')).toBeOnTheScreen();
  expectStyle('light');
  await push('/normal');
  expect(screen.getByText('主题页面')).toBeOnTheScreen();
  expectStyle('dark');
  await back();
  expect(screen.getByTestId('media-attachment-gallery')).toBeOnTheScreen();
  expectStyle('light');
  await back();
  expectStyle('dark');
});

test('media.B1 switching themes while in the gallery preserves contrast and restores the current theme', async () => {
  const view = await render(<Fixture />); await tick();
  await push('/media-viewer?file_id=photo');
  mockTheme = 'dark'; await view.rerender(<Fixture />); await tick();
  expectStyle('light');
  mockTheme = 'light'; await view.rerender(<Fixture />); await tick();
  expectStyle('light');
  await back();
  expectStyle('dark');
  await push('/media-viewer?file_id=photo');
  mockTheme = 'dark'; await view.rerender(<Fixture />); await tick();
  await back();
  expectStyle('light');
});

test('video.A1 unavailable video remains immersive across nested navigation, then restores the themed destination', async () => {
  await render(<Fixture />); await tick();
  await push('/media-viewer?file_id=photo');
  await push('/video-player');
  expect(screen.getByText('视频暂不可用')).toBeOnTheScreen();
  expectStyle('light');
  await push('/normal'); expectStyle('dark');
  await back(); expectStyle('light');
  await back();
  expect(screen.getByTestId('media-attachment-gallery')).toBeOnTheScreen();
  expectStyle('light');
  await back(); expectStyle('dark');
});

test('media.A1 a themed media route does not inherit the gallery override after its attachment disappears', async () => {
  await render(<Fixture />); await tick();
  await push('/media-viewer?file_id=photo'); expectStyle('light');
  await act(() => router.setParams({ file_id: '' })); await tick();
  expect(screen.getByText('媒体位置无效或图片已不可用')).toBeOnTheScreen();
  expectStyle('dark');
});
