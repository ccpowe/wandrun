import { Redirect, useLocalSearchParams } from 'expo-router';
import { ChatScreen } from '@/components/chat/chat-screen.tsx';
import { useGateway } from '@/lib/session-context.tsx';

export default function ChatRoute() {
  const { id, message_seq } = useLocalSearchParams<{ id?: string; message_seq?: string }>();
  const { session } = useGateway();
  return session ? <ChatScreen session={session} id={id} messageSeq={message_seq ? Number(message_seq) : undefined} /> : <Redirect href="/" />;
}
