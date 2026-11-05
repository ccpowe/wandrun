import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';

import ChatEntry from '../app/index';
import Chat from '../app/chat';
import Settings from '../app/settings';
import GatewayConnection from '../app/gateway-connection';
import SettingsModels from '../app/settings-models';
import SettingsSkills from '../app/settings-skills';
import SettingsAppearance from '../app/settings-appearance';
import SettingsAboutYou from '../app/settings-about-you';
import SettingsComputer from '../app/settings-computer';
import Connect from '../app/connect';
import SkillDetail from '../app/skill-detail';
import BuiltinSkillDetail from '../app/builtin-skill-detail';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { LoadingState } from '../components/loading-state';
import { Credentials } from '../lib/credentials';
import { SessionProvider, useGateway, type SessionRuntime } from '../lib/session-context';
import { useMountEffect } from '../lib/use-mount-effect';
import { SceneProviders } from './scene-providers';
import { settingsScenario, type SettingsScenario, type SettingsScene } from './settings-scenario';

// Destination markers verify only entry/return; management subpages and real pairing have their own acceptance.
function Destination() {
  return <View className="flex-1 items-center justify-center gap-4 bg-background">
    <Text>此场景只验证设置入口；子页按对应页面单独验收。</Text>
    <Button testID="settings-destination-back" intent="soft" onPress={() => router.back()}><Text>返回设置</Text></Button>
  </View>;
}
const routes = {
  '/settings': Settings, '/gateway-connection': GatewayConnection,
  '/chat': Chat,
  '/settings-models': Destination, '/settings-skills': Destination, '/settings-connectors': Destination,
  '/settings-about-you': Destination, '/settings-appearance': Destination, '/connect': Destination,
};
const journeyRoutes = { ...routes,
  '/settings-models': SettingsModels, '/settings-skills': SettingsSkills,
  '/settings-appearance': SettingsAppearance, '/settings-about-you': SettingsAboutYou,
  '/settings-computer': SettingsComputer, '/connect': Connect,
  '/skill-detail': SkillDetail, '/builtin-skill-detail': BuiltinSkillDetail,
};
// Real assigned loopback gateways, with isolated phone records. Resolve native fetch
// at request time, after the previous scene has released its fake host.
const liveCredentialsKey = 'wandrun.settings.b1.live';
function LiveSettingsContent() {
  const { ready, sessionKey } = useGateway();
  if (!ready) return <LoadingState />;
  return <SceneProviders key={sessionKey} path="/" location="/settings" routes={journeyRoutes}><ChatEntry /></SceneProviders>;
}
function LiveSettingsScene() {
  const [runtime] = useState<SessionRuntime>(() => {
    const initial = JSON.stringify({ currentId: 'settings-live-a', computers: [{
      computerId: 'settings-live-a', connectionId: 'settings-live-installation-a', baseUrl: 'http://127.0.0.1:18787',
      token: 'dev', localName: '本机服务 A', pairingMethod: 'development',
    }] });
    return { credentials: new Credentials({ getItemAsync: async () => await SecureStore.getItemAsync(liveCredentialsKey) ?? initial,
      setItemAsync: (_key, value) => SecureStore.setItemAsync(liveCredentialsKey, value),
      deleteItemAsync: () => SecureStore.deleteItemAsync(liveCredentialsKey) }), fetch: (input, init) => globalThis.fetch(input, init) };
  });
  return <GestureHandlerRootView style={{ flex: 1 }}><SessionProvider runtime={runtime}><LiveSettingsContent /><PortalHost /></SessionProvider></GestureHandlerRootView>;
}
function ClearLiveStorage() {
  const [result, setResult] = useState<{ status: 'pending' | 'cleared' } | { status: 'failed'; message: string }>({ status: 'pending' });
  useMountEffect(() => {
    let active = true;
    void SecureStore.deleteItemAsync(liveCredentialsKey).then(
      () => { if (active) setResult({ status: 'cleared' }); },
      error => { if (active) setResult({ status: 'failed', message: String(error) }); },
    );
    return () => { active = false; };
  });
  return <View className="flex-1 items-center justify-center bg-background px-4">
    <Text testID={result.status === 'cleared' ? 'settings-live-storage-cleared' : undefined}>
      {result.status === 'cleared' ? '本场景私有手机记录已清除' : result.status === 'failed' ? result.message : '正在清理本场景手机记录…'}
    </Text>
  </View>;
}
function SettingsScenePage({ state = 'A1', theme = 'light', scenario, journey = false }: { state?: SettingsScene; theme?: 'light' | 'dark'; scenario?: SettingsScenario; journey?: boolean }) {
  return <SettingsSceneContent key={`${state}:${theme}:${journey}`} state={state} theme={theme} scenario={scenario} journey={journey} />;
}
function SettingsSceneContent({ state, theme, scenario, journey }: { state: SettingsScene; theme: 'light' | 'dark'; scenario?: SettingsScenario; journey: boolean }) {
  const peer = useMemo(() => scenario ?? settingsScenario(state), [state, scenario]);
  return <SettingsSceneRuntime key={peer.identity} state={state} theme={theme} journey={journey} peer={peer} />;
}
function SettingsSceneRuntime({ state, theme, peer, journey }: { state: SettingsScene; theme: 'light' | 'dark'; peer: SettingsScenario; journey: boolean }) {
  useMountEffect(() => { peer.start(); return peer.stop; });
  useMountEffect(() => { const previous = Uniwind.currentTheme; Uniwind.setTheme(theme); return () => Uniwind.setTheme(previous); });
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <SessionProvider runtime={peer.runtime}>
      <SceneProviders path="/" location={state === 'C8' ? '/gateway-connection?computer=settings-mini' : !journey && (state.startsWith('C') || state.startsWith('D')) ? '/gateway-connection' : '/settings'} routes={journey ? journeyRoutes : routes}><ChatEntry /></SceneProviders>
    </SessionProvider>
    <PortalHost />
  </GestureHandlerRootView>;
}
const meta = { title: 'settings', component: SettingsScenePage, parameters: { fullScreen: true } } satisfies Meta<typeof SettingsScenePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A1: Story = { name: 'A1 S1 设置正常 · 从名片进入连接', args: { state: 'A1' } };
export const A2: Story = { name: 'A2 S2 设置深色', args: { state: 'A2', theme: 'dark' } };
export const A3: Story = { name: 'A3 S3 正在重连 · 外观仍可用', args: { state: 'A3' } };
export const B1: Story = { name: 'B1 S4 额度受限 · 模型红点', args: { state: 'B1' } };
export const C1: Story = { name: 'C1 S5 服务器与连接 · 服务器组无箭头 · 点备注名修改', args: { state: 'C1' } };
export const D7: Story = { name: 'D7 S6 点断开 · 远端不可达时本页横幅可关闭', args: { state: 'D7' } };
export const A4: Story = { name: 'A4 连接错误 · 名片仍可管理', args: { state: 'A4' } };
export const A5: Story = { name: 'A5 摘要首次读取中 · 不伪造零', args: { state: 'A5' } };
export const A6: Story = { name: 'A6 摘要读取失败 · 单一横幅自动重试', args: { state: 'A6' } };
export const A7: Story = { name: 'A7 三秒后刷新失败 · 保留旧摘要', args: { state: 'A7' } };
export const A8: Story = { name: 'A8 没有保存服务器 · 外观可用', args: { state: 'A8' } };
export const B2: Story = { name: 'B2 技能失败与应用需重新授权', args: { state: 'B2' } };
export const B3: Story = { name: 'B3 目录与关于你为空 · 数量为零', args: { state: 'B3' } };
export const B4: Story = { name: 'B4 长服务器名与模型摘要', args: { state: 'B4' } };
export const C2: Story = { name: 'C2 S7 服务器与连接深色', args: { state: 'C2', theme: 'dark' } };
export const C3: Story = { name: 'C3 只有一台服务器 · 仍可添加', args: { state: 'C3' } };
export const C4: Story = { name: 'C4 离线 · 备注切换断开仍可用', args: { state: 'C4' } };
export const C5: Story = { name: 'C5 详情读取失败 · 单一横幅', args: { state: 'C5' } };
export const C5Loading: Story = { name: 'C5 首次详情读取中 · 保留本机信息', args: { state: 'C5Loading' } };
export const C6: Story = { name: 'C6 三秒后详情刷新失败 · 保留旧版本', args: { state: 'C6' } };
export const C7: Story = { name: 'C7 二十六台服务器 · 失效配对与滚动', args: { state: 'C7' } };
export const A11: Story = { name: 'A11 非当前服务器需要重新配对 · 名片可进入详情', args: { state: 'A11' } };
export const C8: Story = { name: 'C8 非当前失效服务器详情 · 重新配对或断开', args: { state: 'C8' } };
export const D1: Story = { name: 'D1 点其他服务器 · 本地选择保存中', args: { state: 'D1' } };
export const D2: Story = { name: 'D2 点其他服务器 · 本地保存失败', args: { state: 'D2' } };
export const D3: Story = { name: 'D3 添加与重新配对入口（导航标记）', args: { state: 'D3' } };
export const D4: Story = { name: 'D4 点信息卡备注名 · 保存或取消', args: { state: 'D4' } };
export const D5: Story = { name: 'D5 点备注名再保存 · 失败保留草稿', args: { state: 'D5' } };
export const D6: Story = { name: 'D6 确认断开 · 本地移除进行中', args: { state: 'D6' } };
export const D6Failure: Story = { name: 'D6 确认断开 · 本地移除失败', args: { state: 'D6Failure' } };
export const Journey: Story = { name: '实际设置路径 · 本组子页与技能详情', args: { state: 'A1', journey: true } };
export const JourneyDark: Story = { name: '实际设置路径 · 深色', args: { state: 'A2', theme: 'dark', journey: true } };
export const LiveServers: Story = { name: '实际双服务器 · 18787 / 18789 · 独立手机记录', render: () => <LiveSettingsScene /> };
export const SingleServer: Story = { name: '单台服务器首页 · 实心名片', args: { state: 'C3', journey: true } };
export const ClearLiveRecords: Story = { name: '清理实际双服务器私有手机记录', render: () => <ClearLiveStorage /> };
