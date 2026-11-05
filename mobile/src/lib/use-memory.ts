import { skipToken } from '@tanstack/react-query';
import { GatewayError, type MemoryScope } from '@/gateway/api.ts';
import type { ChatSession } from '@/gateway/session.ts';
import { memoryError } from '@/lib/agent-memory.ts';
import { memoryIndexOptions } from '@/lib/gateway-queries.ts';
import { useGatewayQuery } from '@/lib/use-gateway-query.ts';

/** Summaries and readers share the exact same finite index resource as the editors. */
export function useMemory(session: ChatSession | null, scope: MemoryScope, id: string, focused: boolean) {
  const read = useGatewayQuery(session ? memoryIndexOptions(session, scope, id) : skipToken, focused);
  return { memory: read.data ?? null, error: read.error ? memoryError(read.error) : '',
    notFound: read.error instanceof GatewayError && read.error.status === 404 };
}
