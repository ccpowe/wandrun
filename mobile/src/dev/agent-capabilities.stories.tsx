import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { CapabilitiesScreen } from '../app/agent-capabilities';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';
import { useMountEffect } from '../lib/use-mount-effect';
import { editorScenario, type EditorScene } from './editor-scenario';
import { FoundationFrame } from './foundation-frame';
import { SceneProviders } from './scene-providers';

function CapabilityScene({ state = 'capabilities', theme = 'light' }: { state?: EditorScene; theme?: 'light' | 'dark' }) {
  return <Scene key={`${state}:${theme}`} state={state} theme={theme} />;
}
function Scene({ state, theme }: { state: EditorScene; theme: 'light' | 'dark' }) {
  const peer = useMemo(() => editorScenario(state), [state]);
  useMountEffect(() => { void peer.start(); return peer.stop; });
  return <FoundationFrame theme={theme} scrollable={false}><GestureHandlerRootView style={{ flex: 1 }}>
    <SceneProviders path="/agent-capabilities"><CapabilitiesScreen session={peer.session} id="planner" /></SceneProviders>
    {state === 'capabilities-loading' ? <Button intent="soft" onPress={peer.release}><Text>Storybook：完成读取</Text></Button> : null}
    {state === 'capabilities-failure' ? <Button intent="soft" onPress={peer.recover}><Text>Storybook：恢复网关</Text></Button> : null}
    {state === 'capabilities' ? <Button intent="soft" onPress={peer.revokeCapability}><Text>Storybook：撤销能力</Text></Button> : null}
    <PortalHost />
  </GestureHandlerRootView></FoundationFrame>;
}
const meta = { title: 'agent-capabilities', component: CapabilityScene, parameters: { fullScreen: true } } satisfies Meta<typeof CapabilityScene>;
export default meta;
type Story = StoryObj<typeof meta>;
export const G1: Story = { name: 'G1 首次读取', args: { state: 'capabilities-loading' } };
export const G2: Story = { name: 'G2 已启用与未启用', args: {} };
export const G2Dark: Story = { name: 'G2 已启用与未启用（深色）', args: { theme: 'dark' } };
export const G2Empty: Story = { name: 'G2 成功空目录', args: { state: 'capabilities-empty' } };
export const G4: Story = { name: 'G4 读取失败自动重试', args: { state: 'capabilities-failure' } };
