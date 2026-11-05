import type { ChatSession } from '../../src/gateway/session.ts';
import type { ChatProjectionInput } from '../../src/lib/chat-timeline.ts';
import { agentDisplayName } from '../../src/lib/agent-display-name.ts';

/** Same readonly display inputs used by ChatScreen; row tests do not read session in the renderer. */
export function chatDisplay(session: ChatSession, timelineId?: string): NonNullable<ChatProjectionInput['display']> {
  return { currentAgentId: timelineId ? session.chat(timelineId)?.agent_id : undefined,
    agentName: (id, snapshot) => agentDisplayName(session.agents, id, snapshot),
    agentAvatar: id => session.agents.agents.find(agent => agent.id === id)?.avatar ?? 0,
    creatorName: task => agentDisplayName(session.agents, task.creator_agent_id!),
    submissionsFor: (id, seq) => session.submissionsFor(id, seq) };
}
