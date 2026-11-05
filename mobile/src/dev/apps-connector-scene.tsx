import { PortalHost } from '@rn-primitives/portal';
import { useMemo } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Uniwind } from 'uniwind';
import Settings from '../app/settings';
import SettingsConnectors from '../app/settings-connectors';
import AddConnector from '../app/connectors/add';
import AddRemoteConnector from '../app/connectors/add-remote';
import AddLocalConnector from '../app/connectors/add-local';
import ConnectorDetail from '../app/connectors/[id]';
import CatalogConnector from '../app/connectors/catalog/[id]';
import AgentEditorScreen from '../app/agent-editor';
import { SessionProvider, useSession } from '../lib/session-context';
import { useMountEffect } from '../lib/use-mount-effect';
import { SceneProviders } from './scene-providers';
import { appsConnectorScenario, type AppsConnectorScenario, type AppsConnectorScene } from './apps-connector-scenario';
const routes = { '/settings': Settings, '/connectors/add': AddConnector, '/connectors/add-remote': AddRemoteConnector,
  '/connectors/add-local': AddLocalConnector, '/connectors/[id]': ConnectorDetail, '/connectors/catalog/[id]': CatalogConnector, '/agent-editor': AgentEditorScreen };
const locations = { home: '/settings-connectors', remote: '/connectors/add-remote', local: '/connectors/add-local', detail: '/connectors/docs', catalog: '/connectors/catalog/notion', 'catalog-github': '/connectors/catalog/github', settings: '/settings' };
function ConnectedScene({ entry }: { entry: keyof typeof locations }) {
  return useSession() ? <SceneProviders path="/settings-connectors" location={locations[entry]} routes={routes}><SettingsConnectors /></SceneProviders> : null;
}
function Runtime({ peer, theme, entry }: { peer: AppsConnectorScenario; theme: 'light' | 'dark'; entry: keyof typeof locations }) {
  useMountEffect(() => { peer.start(); return peer.stop; });
  useMountEffect(() => { const previous = Uniwind.currentTheme; Uniwind.setTheme(theme); return () => Uniwind.setTheme(previous); });
  return <GestureHandlerRootView style={{ flex: 1 }}><SessionProvider runtime={peer.runtime}><ConnectedScene entry={entry} /></SessionProvider><PortalHost /></GestureHandlerRootView>;
}
export function AppsConnectorScenePage({ state = 'normal', entry = 'detail', theme = 'light', scenario }: {
  state?: AppsConnectorScene; entry?: keyof typeof locations; theme?: 'light' | 'dark'; scenario?: AppsConnectorScenario;
}) {
  const peer = useMemo(() => scenario ?? appsConnectorScenario(state), [state, scenario]);
  return <Runtime key={theme} peer={peer} theme={theme} entry={entry} />;
}
