import { Redirect, useLocalSearchParams } from 'expo-router';
import { MemoryEditorContainer } from '@/components/memory-editor-container.tsx';
import type { MemoryScope } from '@/gateway/api.ts';
import type { ChatSession } from '@/gateway/session.ts';
import { useSession } from '@/lib/session-context.tsx';

export default function MemoryDetailRoute() {
  const { id, scope, slug, create } = useLocalSearchParams<{ id: string; scope: MemoryScope; slug?: string; create?: string }>();
  const session = useSession();
  if (!session || !id || scope !== 'profile' && scope !== 'work' || create !== '1' && !slug) return <Redirect href="/" />;
  return <MemoryDetailScreen session={session} scope={scope} id={id} slug={slug} creating={create === '1'} />;
}
export function MemoryDetailScreen({ session, id, scope, slug, creating }: { session: ChatSession; id: string; scope: MemoryScope; slug?: string; creating: boolean }) {
  return <MemoryEditorContainer key={`${session.queryIdentity}:${scope}:${id}:${creating ? 'new' : slug}`} session={session} scope={scope} id={id} kind={creating ? 'create' : 'detail'} slug={slug} />;
}
