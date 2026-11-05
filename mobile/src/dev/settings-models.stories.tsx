import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { router } from 'expo-router';
import { useMemo, useRef } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import ChatEntry from '../app/index';
import Settings from '../app/settings';
import Chat from '../app/chat';
import SettingsModels from '../app/settings-models';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { SessionProvider, useSession } from '../lib/session-context';
import { SceneProviders } from './scene-providers';
import { modelsScenario, type ModelsScenario, type ModelsScene } from './settings-models-scenario';
import { useMountEffect } from '../lib/use-mount-effect';

function OpenModels() {
  const opened = useRef(false);
  useMountEffect(() => {
    if (!opened.current) { opened.current = true; router.push('/settings-models'); }
    return () => {};
  });
  return null;
}
function ModelEntry() {
  const session = useSession();
  return <>{session ? <OpenModels key={session.queryIdentity} /> : null}<Settings /></>;
}
const routes = { '/chat': Chat, '/settings': ModelEntry, '/settings-models': SettingsModels };
const journeyRoutes = { '/chat': Chat, '/settings': Settings, '/settings-models': SettingsModels };
function ModelsScenePage({ state = 'normal', theme = 'light', journey = false, scenario }: {
  state?: ModelsScene; theme?: 'light' | 'dark'; journey?: boolean; scenario?: ModelsScenario;
}) {
  return <ModelsSceneContent key={`${state}:${theme}:${journey}`} state={state} theme={theme} journey={journey} scenario={scenario} />;
}
function ModelsSceneContent({ state, theme, journey, scenario }: { state: ModelsScene; theme: 'light' | 'dark'; journey: boolean; scenario?: ModelsScenario }) {
  const peer = useMemo(() => scenario ?? modelsScenario(state), [scenario, state]);
  return <ModelsSceneRuntime key={peer.identity} state={state} theme={theme} journey={journey} peer={peer} />;
}
function ModelsSceneRuntime({ state, theme, journey, peer }: { state: ModelsScene; theme: 'light' | 'dark'; journey: boolean; peer: ModelsScenario }) {
  useMountEffect(() => { peer.start(); return peer.stop; });
  useMountEffect(() => { const previous = Uniwind.currentTheme; Uniwind.setTheme(theme); return () => Uniwind.setTheme(previous); });
  return <GestureHandlerRootView style={{ flex: 1 }}>
    <SessionProvider runtime={peer.runtime}>
      <SceneProviders path="/" location={journey ? '/' : '/settings'} routes={journey ? journeyRoutes : routes}><ChatEntry /></SceneProviders>
    </SessionProvider>
    {['save-failure', 'unknown', 'unknown-applied', 'read-failure', 'read-stale', 'offline', 'catalog-failure'].includes(state) ? <Button  intent="soft" onPress={peer.recover}><Text>Storybook：模拟网关恢复</Text></Button> : null}
    {state === 'loading' || state === 'saving' ? <Button  intent="soft" onPress={peer.release}><Text>Storybook：完成请求</Text></Button> : null}
    <PortalHost />
  </GestureHandlerRootView>;
}
const meta = { title: 'settings-models', component: ModelsScenePage, parameters: { fullScreen: true } } satisfies Meta<typeof ModelsScenePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const C3: Story = { name: 'C3 S1 滚动 7 天用量 · 三位 Agent', args: {} };
export const C3Dark: Story = { name: 'C3 深色 · 7 天用量', args: { theme: 'dark' } };
export const B5: Story = { name: 'B5 S2 选择模型 → 返回自动保存 · 无弹层', args: {} };
export const B4: Story = { name: 'B4 S3 保存失败 · 顶部横幅并恢复原选择', args: { state: 'save-failure' } };
export const B4Unknown: Story = { name: 'B4 S4 保存结果未确认 · 可离开后只读核对', args: { state: 'unknown' } };
export const B4Applied: Story = { name: 'B4 S5 写入后应答丢失 · 不猜原请求成功', args: { state: 'unknown-applied' } };
export const A1Journey: Story = { name: 'A1 实际入口 · 抽屉 → 设置 → 模型', args: { journey: true } };
export const A1: Story = { name: 'A1 各区首次读取中 · 0.3 秒后加载指示', args: { state: 'loading' } };
export const A2: Story = { name: 'A2 多区读取失败 · 单横幅自动重读', args: { state: 'read-failure' } };
export const T2: Story = { name: 'T2 三秒后刷新失败 · 旧额度与用量仍在', args: { state: 'read-stale' } };
export const A3Due: Story = { name: 'A3 即将续期', args: { state: 'auth-due' } };
export const A3Refreshing: Story = { name: 'A3 正在续期', args: { state: 'auth-refreshing' } };
export const A3Unavailable: Story = { name: 'A3 登录暂不可用 · 历史额度', args: { state: 'auth-unavailable' } };
export const A4Login: Story = { name: 'A4 尚未登录 · 电脑登录命令', args: { state: 'login-required' } };
export const A4Expired: Story = { name: 'A4 登录失效 · 历史额度', args: { state: 'reauth' } };
export const A4Rotation: Story = { name: 'A4 凭据轮换未确认 · 重新登录说明', args: { state: 'rotation-unknown' } };
export const A5NoQuota: Story = { name: 'A5 没有额度观测', args: { state: 'no-quota' } };
export const A5Empty: Story = { name: 'A5 成功空额度窗口', args: { state: 'empty-windows' } };
export const A6Limited: Story = { name: 'A6 上游明确限制 · 最晚恢复时间', args: { state: 'quota-limited' } };
export const A6Percent: Story = { name: 'A6 看似 100% · 未明确拒绝不阻断', args: { state: 'percent-only' } };
export const B2Catalog: Story = { name: 'B2 目录失败 · 保留当前模型与档位', args: { state: 'catalog-failure' } };
export const B2Empty: Story = { name: 'B2 目录成功为空 · 不静默改值', args: { state: 'catalog-empty' } };
export const B2Unlisted: Story = { name: 'B2 旧模型与旧强度不在候选', args: { state: 'model-unlisted' } };
export const B3: Story = { name: 'B3 返回自动保存中 · 防重复', args: { state: 'saving' } };
export const B6: Story = { name: 'B6 离线可选 · 返回未保存后可退出', args: { state: 'offline' } };
export const C1: Story = { name: 'C1 当前没有 Agent', args: { state: 'no-agents' } };
export const C2: Story = { name: 'C2 最近 7 天没有用量', args: { state: 'no-usage' } };
export const C3One: Story = { name: 'C3 一位 Agent · 最大条', args: { state: 'one-agent' } };
export const C3Many: Story = { name: 'C3 二十四位 Agent · 长名与滚动', args: { state: 'many-agents' } };
