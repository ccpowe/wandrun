import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Connect from '../app/connect';
import Settings from '../app/settings';
import GatewayConnection from '../app/gateway-connection';
import { SessionProvider, useGateway } from '../lib/session-context';
import { useMountEffect } from '../lib/use-mount-effect';
import { connectScenario, type ConnectScenario, type ConnectScenarioKind } from './connect-scenario';
import { FoundationFrame, type FoundationTheme } from './foundation-frame';
import { SceneProviders } from './scene-providers';

function PairingEntry() {
  const { config } = useGateway();
  return config && config.authStatus !== 'invalid' ? <Settings /> : <Connect />;
}
function ConnectScene({ kind = 'normal', theme = 'light', scenario }: { kind?: ConnectScenarioKind; theme?: FoundationTheme; scenario?: ConnectScenario }) {
  const peer = useMemo(() => scenario ?? connectScenario(kind), [kind, scenario]);
  useMountEffect(() => { peer.start(); return peer.stop; });
  return <FoundationFrame theme={theme} scrollable={false}><GestureHandlerRootView style={{ flex: 1 }}><SessionProvider runtime={peer.runtime}>
    <SceneProviders path="/connect" routes={{ '/settings': Settings, '/gateway-connection': GatewayConnection }}><PairingEntry /></SceneProviders>
    <PortalHost />
  </SessionProvider></GestureHandlerRootView></FoundationFrame>;
}
const meta = { title: 'settings-connect', component: ConnectScene, parameters: { fullScreen: true } } satisfies Meta<typeof ConnectScene>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A1: Story = { name: 'A1 添加服务器 · 手动配对后进入设置', args: {} };
export const A1Dark: Story = { name: 'A1 添加服务器（深色）', args: { theme: 'dark' } };
export const A2: Story = { name: 'A2 兑换失败 · 可取消等待', args: { kind: 'exchange-failure' } };
export const A3: Story = { name: 'A3 手机保存失败 · 已兑换码不重放', args: { kind: 'save-failure' } };
