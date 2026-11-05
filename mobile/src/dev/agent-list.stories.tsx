import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AllAgentsScreen } from '../app/agents';
import AgentEditorRoute from '../app/agent-editor';
import ChatRoute from '../app/chat';
import ProfileRoute from '../app/agents/[id]';
import { agentListScenario, type AgentListScene, type AgentListScenario } from './agent-list-scenario';
import { SceneProviders } from './scene-providers';
import { FoundationFrame } from './foundation-frame';
import { useMountEffect } from '../lib/use-mount-effect';
import { SessionProvider, useSession } from '../lib/session-context';

const routes = { '/chat': ChatRoute, '/agents/[id]': ProfileRoute, '/agent-editor': AgentEditorRoute };
type AgentListSceneProps = { state?: AgentListScene; theme?: 'light' | 'dark'; scenario?: AgentListScenario };
function AgentListScenePage(props: AgentListSceneProps) {
  return <AgentListSceneContent key={`${props.state ?? 'A1'}:${props.theme ?? 'light'}`} {...props} />;
}
function AgentListSceneContent({ state = 'A1', theme = 'light', scenario }: AgentListSceneProps) {
  const peer = useMemo(() => scenario ?? agentListScenario(state), [scenario, state]);
  return <FoundationFrame theme={theme} scrollable={false}><GestureHandlerRootView style={{ flex: 1 }}>
    <SessionProvider runtime={peer.runtime}><AgentListSceneRuntime peer={peer} /></SessionProvider>
  </GestureHandlerRootView></FoundationFrame>;
}
function AgentListSceneRuntime({ peer }: { peer: AgentListScenario }) {
  const session = useSession();
  return session ? <AgentListSceneRoutes key={session.queryIdentity} peer={peer} /> : null;
}
function AgentListSceneRoutes({ peer }: { peer: AgentListScenario }) {
  const session = useSession()!;
  useMountEffect(() => { void peer.start(session); return peer.stop; });
  return <>
    <SceneProviders path="/agents" routes={routes}><AllAgentsScreen session={session} /></SceneProviders>
    <PortalHost />
  </>;
}
const meta = { title: 'agent-list', component: AgentListScenePage, parameters: { fullScreen: true } } satisfies Meta<typeof AgentListScenePage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A1: Story = { name: 'A1 六个 Agent · 点行查看资料', args: { state: 'A1' } };
export const A1Dark: Story = { name: 'A1 六个 Agent（深色）', args: { state: 'A1', theme: 'dark' } };
export const A3: Story = { name: 'A3 零 Agent · 新建入口', args: { state: 'A3' } };
export const D3: Story = { name: 'D3 一百个 Agent · 纵向滚动', args: { state: 'D3' } };
export const A2: Story = { name: 'A2 首次读取中', args: { state: 'A2' } };
export const A4: Story = { name: 'A4 读取失败 · 后台重试', args: { state: 'A4' } };
export const A5: Story = { name: 'A5 刷新失败 · 保留已有列表', args: { state: 'A5' } };
export const A6: Story = { name: 'A6 离线 · 缓存列表可读', args: { state: 'A6' } };
export const A6Empty: Story = { name: 'A6 离线 · 无缓存', args: { state: 'A6Empty' } };
export const D1: Story = { name: 'D1 长名字与说明', args: { state: 'D1' } };
export const D2: Story = { name: 'D2 同名同头像 · 以 id 区分', args: { state: 'D2' } };
export const D4: Story = { name: 'D4 一个 Agent · 查看资料与编辑', args: { state: 'D4' } };
