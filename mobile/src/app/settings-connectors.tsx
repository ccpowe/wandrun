import { Redirect, router, Stack } from 'expo-router';
import { useReducer } from 'react';
import { ConnectorHomeView } from '@/components/connector-home-view';
import type { ChatSession } from '@/gateway/session';
import { useConnectorListCatalog } from '@/lib/connector-catalog';
import { connectorHomeReducer, initialConnectorHome, selectConnectorHome } from '@/lib/connector-list-state';
import { ConnectionBanner, useConnectionLabel } from '@/lib/connection-banner';
import { appCatalogOptions } from '@/lib/gateway-queries';
import { useSession } from '@/lib/session-context';
import { useGatewayQuery } from '@/lib/use-gateway-query';

export default function SettingsConnectorsRoute() {
  return <SettingsConnectorsScreen session={useSession()} />;
}
export function SettingsConnectorsScreen({ session, initialTab = 'available' }: { session: ChatSession | null; initialTab?: 'available' | 'added' }) {
  return session ? <ConnectorList key={session.queryIdentity} session={session} initialTab={initialTab} /> : <Redirect href="/" />;
}
export function ConnectorList({ session, initialTab = 'available' }: { session: ChatSession; initialTab?: 'available' | 'added' }) {
  const [state, dispatch] = useReducer(connectorHomeReducer, { ...initialConnectorHome, tab: initialTab });
  const apps = useGatewayQuery(appCatalogOptions(session));
  const connectors = useConnectorListCatalog(session);
  const connectionLabel = useConnectionLabel(session);
  const selection = selectConnectorHome(state, { apps, connectors, connectionBannerVisible: connectionLabel !== null });
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <ConnectorHomeView selection={selection} connectionBanner={<ConnectionBanner session={session} />}
      onBack={() => router.back()}
      onAdd={() => { session.editorOperations.beginCreationVisit('connector'); router.push('/connectors/add'); }}
      onTab={tab => dispatch({ type: 'tab', tab })} onSearch={query => dispatch({ type: 'search', query })}
      onConnector={id => router.push({ pathname: '/connectors/[id]', params: { id } })}
      onCatalog={id => router.push({ pathname: '/connectors/catalog/[id]', params: { id } })} />
  </>;
}
