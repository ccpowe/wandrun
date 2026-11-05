import { skipToken } from '@tanstack/react-query';
import type { ChatSession } from '../gateway/session.ts';
import { connectorListOptions } from './gateway-queries.ts';
import { useGatewayQuery } from './use-gateway-query.ts';

/** Every connector directory consumer shares the same options and finite-read consumer policy. */
export function useConnectorListCatalog(session: ChatSession | null) {
  return useGatewayQuery(session ? connectorListOptions(session) : skipToken);
}
