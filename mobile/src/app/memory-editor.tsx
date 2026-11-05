import { Redirect, useLocalSearchParams } from 'expo-router';
import { MemoryEditorContainer } from '@/components/memory-editor-container.tsx';
import type { MemoryScope } from '@/gateway/api.ts';
import type { ChatSession } from '@/gateway/session.ts';
import { useSession } from '@/lib/session-context.tsx';

export default function MemoryEditorRoute() {
  const { id, scope } = useLocalSearchParams<{ id: string; scope: MemoryScope }>();
  const session = useSession();
  if (!session || !id || scope !== 'profile' && scope !== 'work') return <Redirect href="/" />;
  return <MemoryEditor id={id} scope={scope} session={session} />;
}
export function MemoryEditor({ id, scope, session }: { id: string; scope: MemoryScope; session: ChatSession }) {
  return <MemoryEditorContainer key={`${session.queryIdentity}:${scope}:${id}:index`} session={session} scope={scope} id={id} kind="index" />;
}
