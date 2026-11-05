import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { ExpoRoot, Stack, router, usePathname } from 'expo-router';
import { StackActions } from 'expo-router/react-navigation';
import { StrictMode, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { RequireContext } from 'expo-router/build/types';
import { useEditorLeave } from '../src/components/editor-leave-sheet';

jest.mock('react-native-keyboard-controller', () => jest.requireActual('react-native-keyboard-controller/jest'));
let scenario: 'autosave' | 'confirm' | 'unknown' | 'pristine';
let saveCount = 0;
let resolveSave: (value: boolean) => void;
let localCount = 0;
function Layout() { return <Stack />; }
function Page() { return <Text testID="path">{usePathname()}</Text>; }
function Editor() {
  const [saving, setSaving] = useState(false);
  const [unknownOpen, setUnknownOpen] = useState(false);
  const [local, setLocal] = useState(false);
  async function save() {
    setSaving(true); saveCount++;
    const gate = Promise.withResolvers<boolean>(); resolveSave = gate.resolve;
    const success = await gate.promise;
    setSaving(false);
    return success;
  }
  const leave = useEditorLeave(scenario !== 'pristine', saving, () => {
    if (router.canGoBack()) router.back(); else router.replace('/');
  }, scenario === 'unknown', save,
    scenario === 'autosave', scenario === 'unknown' ? () => setUnknownOpen(true) : undefined);
  return <><Text testID="path">{usePathname()}</Text><Text>{local ? 'local-completed' : 'local-pending'}</Text>
    <Pressable testID="back" onPress={leave.request}><Text>back</Text></Pressable>
    <Pressable testID="save" onPress={() => void leave.submit()}><Text>save</Text></Pressable>
    <Pressable testID="push" onPress={() => leave.requestAction(StackActions.push('other'))}><Text>push</Text></Pressable>
    <Pressable testID="local" onPress={() => leave.requestLocal(() => { localCount++; setLocal(true); })}><Text>local</Text></Pressable>
    {leave.open || unknownOpen ? <><Pressable testID="discard" onPress={leave.finish}><Text>discard</Text></Pressable>
      <Pressable testID="stay" onPress={() => { leave.cancel(); setUnknownOpen(false); }}><Text>stay</Text></Pressable></> : null}
  </>;
}
function Detail() {
  const leave = useEditorLeave(false, false, () => router.dismissTo('/'), true);
  return <><Text testID="path">{usePathname()}</Text>
    <Pressable testID="gone" onPress={leave.complete}><Text>gone</Text></Pressable></>;
}
const routes = Object.assign((key: string) => ({ default: key === './_layout.tsx' ? Layout : key === './editor.tsx' ? Editor : key === './detail.tsx' ? Detail : Page }), {
  keys: () => ['./_layout.tsx', './index.tsx', './other.tsx', './editor.tsx', './detail.tsx'],
  resolve: (key: string) => key, id: 'navigation-continuation',
}) as RequireContext;
const tick = () => act(async () => { await jest.advanceTimersByTimeAsync(50); });
async function openEditor() {
  await render(<StrictMode><SafeAreaProvider><ExpoRoot context={routes} location="/" /></SafeAreaProvider></StrictMode>);
  await tick(); await act(() => router.push('/editor' as never)); await tick();
}
beforeEach(() => { jest.useFakeTimers(); scenario = 'autosave'; saveCount = 0; localCount = 0; });
afterEach(() => { cleanup(); jest.useRealTimers(); });

test.each(['toolbar', 'native', 'save'])('G1 %s 自动保存只消费真实原 action 一次，重复返回不多退', async mode => {
  await openEditor();
  if (mode === 'native') await act(() => router.back());
  else await fireEvent.press(screen.getByTestId(mode === 'save' ? 'save' : 'back'));
  await tick();
  await act(() => router.back()); await tick();
  expect(saveCount).toBe(1);
  expect(screen.getByTestId('path').props.children).toBe('/editor');
  await act(async () => resolveSave(true)); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false);
});

test.each(['confirm', 'unknown'])('G1 %s 确认保留最新原 action，旧 action 作废且重复放弃不多退', async mode => {
  scenario = mode as 'confirm' | 'unknown'; await openEditor();
  await act(() => router.back()); await tick();
  await act(() => router.replace('/other' as never)); await tick();
  const discard = screen.getByTestId('discard');
  await fireEvent.press(discard); await fireEvent.press(discard); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/other');
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(saveCount).toBe(0);
});

test('G1 保存期间新的移除 action 替换目的地，不重复保存；失败撤销目的地', async () => {
  await openEditor(); await act(() => router.back()); await tick();
  await act(() => router.replace('/other' as never)); await tick();
  await act(async () => resolveSave(false)); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/editor'); expect(saveCount).toBe(1);
  await fireEvent.press(screen.getByTestId('back')); await tick();
  await act(async () => resolveSave(true)); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/'); expect(saveCount).toBe(2);
});

test('G1 保存期间最新移除 action 成功后去新目的地，不消费旧返回', async () => {
  await openEditor(); await act(() => router.back()); await tick();
  await act(() => router.replace('/other' as never)); await tick();
  await act(async () => resolveSave(true)); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/other'); expect(saveCount).toBe(1);
});

test('G1 保留编辑页的 PUSH 经保存准入，返回仍保留编辑页而不重复保存', async () => {
  await openEditor(); await fireEvent.press(screen.getByTestId('push')); await fireEvent.press(screen.getByTestId('push'));
  expect(saveCount).toBe(1); await act(async () => resolveSave(true)); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/other');
  await act(() => router.back()); await tick(); expect(screen.getByTestId('path').props.children).toBe('/editor');
});

test('G1 页内 continuation 不移除编辑路由，重复确认只应用一次，之后可再次编辑', async () => {
  scenario = 'confirm'; await openEditor();
  await fireEvent.press(screen.getByTestId('local')); await fireEvent.press(screen.getByTestId('local'));
  const discard = screen.getByTestId('discard'); await fireEvent.press(discard); await fireEvent.press(discard);
  expect(localCount).toBe(1); expect(screen.getByTestId('path').props.children).toBe('/editor');
  expect(screen.getByText('local-completed')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('back')); await tick(); await fireEvent.press(screen.getByTestId('discard')); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
});

test.each(['native', 'toolbar'])('G1 S1 pristine %s 返回不保存，顶栏连按不多退', async mode => {
  scenario = 'pristine'; await openEditor();
  if (mode === 'native') await act(() => router.back());
  else {
    const back = screen.getByTestId('back');
    await fireEvent.press(back); await fireEvent.press(back);
  }
  await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false); expect(saveCount).toBe(0);
});

test('G1 R2 pristine 编辑页失焦后不阻止上层 dismissTo 根', async () => {
  scenario = 'pristine'; await openEditor();
  await act(() => router.push('/other' as never)); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/other');
  await act(() => router.dismissTo('/')); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false);
});

test('G1 R3 上层已删除编辑页 complete 可连带移除下层 pristine 编辑页', async () => {
  scenario = 'pristine'; await openEditor();
  await act(() => router.push('/detail' as never)); await tick();
  await fireEvent.press(screen.getByTestId('gone')); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false);
});

test('G1 S1 dirty 失焦页被 dismissTo 连带移除时放行，不在隐藏页保存或确认', async () => {
  scenario = 'confirm'; await openEditor();
  await act(() => router.push('/other' as never)); await tick();
  await act(() => router.dismissTo('/')); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false); expect(saveCount).toBe(0);
  expect(screen.queryByTestId('discard', { includeHiddenElements: true })).toBeNull();
});

test('G1 S1 保存后保留的编辑页不阻止运行记录 dismissTo 根', async () => {
  await openEditor(); await fireEvent.press(screen.getByTestId('push'));
  await act(async () => resolveSave(true)); await tick();
  expect(saveCount).toBe(1); expect(screen.getByTestId('path').props.children).toBe('/other');
  await act(() => router.dismissTo('/')); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(router.canGoBack()).toBe(false); expect(saveCount).toBe(1);
});

test('G1 pristine 显式保存仍先完成写入，普通返回不因此永久启用保护', async () => {
  scenario = 'pristine'; await openEditor();
  await fireEvent.press(screen.getByTestId('save')); await tick();
  expect(saveCount).toBe(1); expect(screen.getByTestId('path').props.children).toBe('/editor');
  await act(async () => resolveSave(false)); await tick();
  await act(() => router.back()); await tick();
  expect(screen.getByTestId('path').props.children).toBe('/');
  expect(saveCount).toBe(1);
});
