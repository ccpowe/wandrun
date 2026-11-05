import { composeStories } from '@storybook/react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import type * as Reanimated from 'react-native-reanimated';
import * as drawerStories from '../src/dev/conversation-drawer.stories';
import { chatScenario } from '../src/dev/chat-scenario';
import { SceneProviders } from '../src/dev/scene-providers';
import { DrawerTransition } from '../src/lib/drawer-flow';
import { useConversationDrawer } from '../src/lib/use-conversation-drawer';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
jest.mock('react-native-webview', () => ({ __esModule: true, default: jest.requireActual('react-native').View }));
jest.mock('@gorhom/bottom-sheet', () => ({ __esModule: true, ...jest.requireActual('@gorhom/bottom-sheet/mock') }));
const DrawerStories = composeStories(drawerStories);
const routes = { '/settings': () => <Text>Other route</Text> };
function Wrapper({ children }: { children: ReactNode }) {
  return <SceneProviders path="/chat" location="/chat?id=recent" routes={routes}>{children}</SceneProviders>;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('conversation-drawer.D4 T14 真实 Router 失焦、重开与旧 transitionEnd 不结算新 Flow', async () => {
  const peer = chatScenario('E1');
  await peer.start();
  const transition = new DrawerTransition();
  const mounted = await renderHook(() => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const focused = useIsFocused();
    return { id, focused, drawer: useConversationDrawer(peer.session, id, 'general', focused, true) };
  }, { wrapper: Wrapper });
  try {
    await act(() => mounted.result.current.drawer.drawerProps.onSelect('root-0'));
    transition.start(true, mounted.result.current.drawer.drawerProps.closeTicket);
    await act(() => router.push('/settings'));
    await waitFor(() => expect(mounted.result.current.focused).toBe(false));
    await act(() => router.back());
    await waitFor(() => expect(mounted.result.current.focused).toBe(true));
    await act(() => mounted.result.current.drawer.drawerProps.onSelect('root-2'));
    expect(mounted.result.current.drawer.drawerProps.closing).toBe(true);
    await act(() => transition.end(true));
    expect(mounted.result.current.id).toBe('recent');
    expect(mounted.result.current.drawer.drawerProps.closing).toBe(true);
    transition.start(true, mounted.result.current.drawer.drawerProps.closeTicket);
    await act(() => transition.end(true));
    await waitFor(() => expect(mounted.result.current.id).toBe('root-2'));
  } finally { await mounted.unmount(); peer.stop(); }
});

test('conversation-drawer.T14 同访问关闭立即重开后，旧票据不能结束新关闭', async () => {
  const peer = chatScenario('E1');
  await peer.start();
  const mounted = await renderHook(() => {
    const { id } = useLocalSearchParams<{ id: string }>();
    return { id, drawer: useConversationDrawer(peer.session, id, 'general', useIsFocused(), true) };
  }, { wrapper: Wrapper });
  try {
    await act(() => mounted.result.current.drawer.drawerProps.onSelect('root-0'));
    const old = mounted.result.current.drawer.drawerProps.closeTicket!;
    await act(() => mounted.result.current.drawer.show());
    await act(() => mounted.result.current.drawer.drawerProps.onSelect('root-2'));
    const current = mounted.result.current.drawer.drawerProps.closeTicket!;
    await act(() => old.complete());
    expect(mounted.result.current.id).toBe('recent');
    expect(mounted.result.current.drawer.drawerProps.closing).toBe(true);
    await act(() => current.complete());
    await waitFor(() => expect(mounted.result.current.id).toBe('root-2'));
  } finally { await mounted.unmount(); peer.stop(); }
});

test('conversation-drawer.D2 T14 库手势不发 start 时，受控关闭仍结算票据并释放原生输入屏障', async () => {
  jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default.measureInWindow.mockImplementation(
    (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 400, 800));
  const completions: ((finished?: boolean) => void)[] = [];
  const reanimated = jest.requireMock('react-native-reanimated') as typeof Reanimated;
  const nativeJobs: (() => void)[] = [];
  const bridge = jest.spyOn(reanimated, 'runOnJS').mockImplementation(callback => (...args) => {
    nativeJobs.push(() => { (callback as (...values: unknown[]) => unknown)(...args); });
  });
  // Native-to-JS delivery runs after commit, not synchronously inside useLatestCallback's layout update.
  const flushNativeJobs = async () => {
    while (nativeJobs.length) {
      const jobs = nativeJobs.splice(0);
      await act(() => { jobs.forEach(job => job()); });
    }
  };
  const spring = jest.spyOn(reanimated, 'withSpring').mockImplementation((value, _config, onEnd) => {
    if (onEnd) completions.push(onEnd);
    return value;
  });
  // The official native mock has no animation completion; supply that boundary, not Drawer callbacks.
  const finishSpring = async () => {
    await act(() => {
      const queued = completions.splice(0);
      queued.forEach((done, index) => done(index === queued.length - 1));
    });
    await flushNativeJobs();
  };
  const peer = chatScenario('E1');
  const mounted = await render(<DrawerStories.E1 scenario={peer} />);
  await flushNativeJobs();
  try {
    await waitFor(() => expect(screen.getByTestId('conversation-root-0')).toBeOnTheScreen());
    expect(screen.getByTestId('conversation-drawer-shell')).toHaveProp('pointerEvents', 'auto');
    await finishSpring();
    await act(() => fireGestureHandler(getByGestureTestId('conversation-drawer-pan'), [
      { state: State.BEGAN, x: 320, translationX: 0 },
      { state: State.ACTIVE, x: 160, translationX: -160, velocityX: -1000 },
      { state: State.END, x: 20, translationX: -300, velocityX: -1000 },
    ]));
    await flushNativeJobs();
    expect(screen.getByTestId('conversation-drawer-shell')).toHaveProp('pointerEvents', 'box-only');
    await finishSpring();
    expect(screen.getByTestId('conversation-drawer-shell')).toHaveProp('pointerEvents', 'auto');
  } finally { await mounted.unmount(); peer.stop(); spring.mockRestore(); bridge.mockRestore(); }
});
