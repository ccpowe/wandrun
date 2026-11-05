import { resolve } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as ExpoLinking from 'expo-linking';
import { ExpoRoot, Stack, router, usePathname } from 'expo-router';
import requireContext from 'expo-router/build/testing-library/require-context-ponyfill';
import type { RequireContext } from 'expo-router/build/types';
import { useState } from 'react';
import { Linking, Text, TextInput } from 'react-native';
import EventEmitter from 'react-native/Libraries/vendor/emitter/EventEmitter';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// Discover production native-intent exactly as Router does; ordinary route content is
// a tiny fixture so this exercises link admission/navigation, not gateway/model setup.
function context(): RequireContext {
  const intents = requireContext(resolve(__dirname, '../src/app'), false, /\/\+native-intent\.[tj]sx?$/);
  function Detail() {
    const [draft, change] = useState('');
    return <><Text>{usePathname()}</Text><TextInput accessibilityLabel="临时输入" value={draft} onChangeText={change} /></>;
  }
  const modules: Record<string, unknown> = {
    './_layout.tsx': { default: () => <Stack screenOptions={{ headerShown: false }} /> },
    './+not-found.tsx': { default: () => <Text>未匹配路由</Text> },
    './index.tsx': { default: () => <Text>入口</Text> },
    './settings-connectors.tsx': { default: () => <Text>连接器主页</Text> },
    './connectors/[id].tsx': { default: Detail },
  };
  return Object.assign((key: string) => intents.keys().includes(key) ? intents(key) : modules[key], {
    keys: () => [...Object.keys(modules), ...intents.keys()], resolve: (key: string) => key, id: 'oauth-native-intent',
  }) as RequireContext;
}
const tick = () => act(async () => { await jest.advanceTimersByTimeAsync(100); });
const nativeEvents = new EventEmitter();
beforeEach(() => {
  jest.useFakeTimers(); nativeEvents.removeAllListeners();
  jest.spyOn(Linking, 'addEventListener').mockImplementation((type, listener) => nativeEvents.addListener(type, listener));
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('运行中 OAuth 返回只供系统授权会话消费，保留当前详情、草稿与返回栈', async () => {
  await render(<SafeAreaProvider><ExpoRoot context={context()} location="/" /></SafeAreaProvider>); await tick();
  await act(() => router.push('/connectors/docs')); await tick();
  await fireEvent.changeText(screen.getByLabelText('临时输入'), '保留此页');
  await act(async () => { nativeEvents.emit('url', { url: 'wandrun://oauth/done?connector=docs&result=ok' }); }); await tick();
  expect(screen.getByText('/connectors/docs')).toBeOnTheScreen();
  expect(screen.getByLabelText('临时输入')).toHaveDisplayValue('保留此页');
  await act(() => router.back()); await tick();
  expect(screen.getByText('入口')).toBeOnTheScreen();
});

test.each([
  ['wandrun://oauth/done?connector=docs&result=error', '/connectors/docs'],
  ['wandrun://oauth/done?result=ok', '连接器主页'],
])('冷启动授权返回 %s 落到真实只读入口，不把 URI 结果当成功', async (url, expected) => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValue(url);
  jest.spyOn(ExpoLinking, 'getLinkingURL').mockReturnValue(url);
  await render(<SafeAreaProvider><ExpoRoot context={context()} /></SafeAreaProvider>); await tick();
  expect(screen.getByText(expected)).toBeOnTheScreen();
});
