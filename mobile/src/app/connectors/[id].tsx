import { Redirect, useLocalSearchParams } from 'expo-router';
import { ConnectorFlow } from '@/components/connector-flow';
import { useSession } from '@/lib/session-context';
export default function ConnectorDetailRoute() {
  const session = useSession(); const { id } = useLocalSearchParams<{ id: string }>();
  return session && id ? <ConnectorFlow session={session} id={id} /> : <Redirect href="/" />;
}
