import type { AgentSummary, Conversation } from '../gateway/api.ts';
import { recentAgentOrder } from './new-chat-agents.ts';

export type AgentListExternal = {
  agents: AgentSummary[];
  conversations: Iterable<Pick<Conversation, 'agent_id' | 'last_activity_seq'>>;
  offline: boolean; focused: boolean; loaded: boolean; readError: string | null;
};
export type AgentListSelection = {
  rows: AgentSummary[]; loaded: boolean; loading: boolean; empty: boolean;
  blocked: boolean; rowDisabled: boolean; readError: boolean;
};

/** Read-only projection: ordering is shared with the new-chat picker, never persisted by this page. */
export function selectAgentList(external: AgentListExternal): AgentListSelection {
  const rows = recentAgentOrder(external.agents, external.conversations);
  return {
    rows, loaded: external.loaded, loading: !external.loaded && external.readError === null,
    empty: external.loaded && rows.length === 0,
    blocked: external.offline || !external.focused, rowDisabled: !external.focused,
    readError: !!external.readError,
  };
}
