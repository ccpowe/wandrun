import type { GatewayEvent } from "../../src/gateway/api.ts";

// Minimal reproduction of the reported sequence, not a copy of private message bodies.
// The root is an endpoint in timeline_ids, but Agent-to-Agent bodies belong only in member chats.
function event(seq: number, type: string, data: Record<string, unknown>): GatewayEvent {
  return { seq, type, at: seq, conversation_id: "root", data };
}

export const collaborationEvents: GatewayEvent[] = [
  event(10, "task.created", {
    task_id: "search-1", creator_task_id: "root", creator_agent_id: "planner", agent_id: "search_agent",
    title: "First search", status: "running", timeline_ids: ["root", "search-1"],
  }),
  event(11, "message.task", {
    task_id: "search-1", sender_task_id: "root", sender_agent_id: "planner",
    recipient_task_id: "search-1", recipient_agent_id: "search_agent",
    text: "Find the protocol details", attachments: [], timeline_ids: ["root", "search-1"],
  }),
  event(12, "task.created", {
    task_id: "search-2", creator_task_id: "root", creator_agent_id: "planner", agent_id: "search_agent",
    title: "Second search", status: "running", timeline_ids: ["root", "search-2"],
  }),
  event(31, "task.status", {
    task_id: "search-1", creator_task_id: "root", agent_id: "search_agent",
    status: "completed", error: null, timeline_ids: ["root", "search-1"],
  }),
  ...[32, 37, 38, 39, 67, 81].map((seq) => event(seq, "message.task", {
    task_id: "search-1", sender_task_id: "search-1", sender_agent_id: "search_agent",
    recipient_task_id: "root", recipient_agent_id: "planner",
    text: `Search result ${seq}`, attachments: [], timeline_ids: ["search-1", "root"],
  })),
  event(82, "file.produced", { id: "report", task_id: "search-1", timeline_ids: ["search-1", "root"] }),
  event(83, "task.read", { task_id: "search-1", seq: 81, timeline_ids: ["search-1"] }),
  event(84, "conversation.read", { seq: 81, timeline_ids: ["root"] }),
];
