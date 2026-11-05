import { Redirect, useLocalSearchParams } from 'expo-router';
import { ConnectorFlow } from '@/components/connector-flow';
import { useSession } from '@/lib/session-context';
export default function CatalogConnectorRoute() {
  const session = useSession(); const { id } = useLocalSearchParams<{ id: string }>();
  return session && id ? <ConnectorFlow session={session} appId={id} /> : <Redirect href="/" />;
}
