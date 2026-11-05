import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { SceneProviders } from '../src/dev/scene-providers';
import { useVisitNotice } from '../src/lib/use-focused-visit';

// design.md 提醒规则 2 / 4: a one-time result belongs to the page visit that started the operation.
let pending: PromiseWithResolvers<void> | null = null;
function OperationPage() {
  const result = useVisitNotice();
  const start = () => {
    const publish = result.begin();
    pending = Promise.withResolvers<void>();
    pending.promise.catch(() => publish('操作失败'));
  };
  return <View>
    <Pressable testID="start" onPress={start}><Text>开始</Text></Pressable>
    <Pressable testID="leave" onPress={() => router.push('/settings')}><Text>离开</Text></Pressable>
    {result.notice ? <Text testID="notice">{result.notice}</Text> : null}
  </View>;
}
const tick = async () => act(async () => { await jest.advanceTimersByTimeAsync(0); });
beforeEach(() => { jest.useFakeTimers(); pending = null; });
afterEach(() => jest.useRealTimers());
const open = () => render(<SceneProviders path="/" routes={{ '/settings': () => <Text>其他页面</Text> }}><OperationPage /></SceneProviders>);

test('useVisitNotice 当前访问内的结果显示', async () => {
  await open(); await tick();
  await fireEvent.press(screen.getByTestId('start'));
  await act(async () => { pending!.reject(new Error('x')); }); await tick();
  expect(screen.getByTestId('notice')).toHaveTextContent('操作失败');
});

test('useVisitNotice 离开后才返回的结果不在下一次访问显示', async () => {
  await open(); await tick();
  await fireEvent.press(screen.getByTestId('start'));
  await fireEvent.press(screen.getByTestId('leave')); await tick();
  await act(async () => { pending!.reject(new Error('x')); }); await tick();
  await act(() => router.back()); await tick();
  expect(screen.queryByTestId('notice')).toBeNull();
});

test('useVisitNotice 已显示的结果在离开再返回后不在', async () => {
  await open(); await tick();
  await fireEvent.press(screen.getByTestId('start'));
  await act(async () => { pending!.reject(new Error('x')); }); await tick();
  expect(screen.getByTestId('notice')).toBeOnTheScreen();
  await fireEvent.press(screen.getByTestId('leave')); await tick();
  await act(() => router.back()); await tick();
  expect(screen.queryByTestId('notice')).toBeNull();
});
