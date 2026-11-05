import type { Meta, StoryObj } from '@storybook/react-native';
import { PortalHost } from '@rn-primitives/portal';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import Settings from '../app/settings';
import { SettingsConnectorsScreen } from '../app/settings-connectors';
import AddConnector from '../app/connectors/add';
import AddRemoteConnector from '../app/connectors/add-remote';
import AddLocalConnector from '../app/connectors/add-local';
import ConnectorDetail from '../app/connectors/[id]';
import CatalogConnector from '../app/connectors/catalog/[id]';
import { SessionProvider, useSession } from '../lib/session-context';
import { useMountEffect } from '../lib/use-mount-effect';
import { connectorListScenario, type ConnectorListScene, type ConnectorListScenario } from './connector-list-scenario';
import { SceneProviders } from './scene-providers';

const routes = { '/': Settings, '/connectors/add': AddConnector, '/connectors/add-remote': AddRemoteConnector,
  '/connectors/add-local': AddLocalConnector, '/connectors/[id]': ConnectorDetail, '/connectors/catalog/[id]': CatalogConnector };
function ConnectedHome({ initialTab }: { initialTab: 'available' | 'added' }) {
  const session = useSession();
  return session ? <SceneProviders key={session.queryIdentity} path="/settings-connectors" routes={routes}><SettingsConnectorsScreen session={session} initialTab={initialTab} /></SceneProviders> : null;
}
function SceneRuntime({ peer, theme, initialTab }: { peer: ConnectorListScenario; theme: 'light' | 'dark'; initialTab: 'available' | 'added' }) {
  useMountEffect(() => { peer.start(); return peer.stop; });
  useMountEffect(() => { const previous = Uniwind.currentTheme; Uniwind.setTheme(theme); return () => Uniwind.setTheme(previous); });
  return <GestureHandlerRootView style={{ flex: 1 }}><SessionProvider runtime={peer.runtime}><ConnectedHome initialTab={initialTab} /></SessionProvider><PortalHost /></GestureHandlerRootView>;
}
function ConnectorScene({ state = 'ready', theme = 'light', initialTab = 'available', scenario }: {
  state?: ConnectorListScene; theme?: 'light' | 'dark'; initialTab?: 'available' | 'added'; scenario?: ConnectorListScenario;
}) {
  const peer = useMemo(() => scenario ?? connectorListScenario(state), [scenario, state]);
  return <SceneRuntime key={`${peer.identity}:${theme}`} peer={peer} theme={theme} initialTab={initialTab} />;
}
const meta = { title: 'connectors/home', component: ConnectorScene, parameters: { fullScreen: true } } satisfies Meta<typeof ConnectorScene>;
export default meta;
type Story = StoryObj<typeof meta>;
export const H1: Story = { name: 'H1 首次加载', args: { state: 'loading' } };
export const H2: Story = { name: 'H2 可用目录（浅色）', args: {} };
export const H2Dark: Story = { name: 'H2 可用目录（深色）', args: { theme: 'dark' } };
export const H3: Story = { name: 'H3 已添加（浅色）', args: { initialTab: 'added' } };
export const H3Dark: Story = { name: 'H3 已添加（深色）', args: { initialTab: 'added', theme: 'dark' } };
export const H4: Story = { name: 'H4 空目录', args: { state: 'empty' } };
export const H5: Story = { name: 'H5 首次读取失败', args: { state: 'failed' } };
export const H5Stale: Story = { name: 'H5 刷新失败保留旧内容', args: { state: 'stale', initialTab: 'added' } };
export const H7Many: Story = { name: 'H7 长列表', args: { state: 'many', initialTab: 'added' } };
