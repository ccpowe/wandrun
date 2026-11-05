import { Redirect } from 'expo-router';
import { ConnectorFlow } from '@/components/connector-flow';
import { useSession } from '@/lib/session-context';
export default function AddLocalConnectorRoute() {
  const session = useSession();
  return session ? <ConnectorFlow session={session} mode="local" /> : <Redirect href="/" />;
}
