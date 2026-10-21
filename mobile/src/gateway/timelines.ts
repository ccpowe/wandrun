import type { DraftPreview, GatewayEvent } from "./api.ts";

/** The envelope owns resources; timeline_ids alone controls where durable events appear. */
export function eventTimelines(event: GatewayEvent): string[] {
  return Array.isArray(event.data.timeline_ids)
    ? event.data.timeline_ids.filter((id): id is string => typeof id === "string")
    : event.conversation_id ? [event.conversation_id] : [];
}

/** A human-facing preview belongs to its executing task, never automatically to the root. */
export function draftTimeline(draft: DraftPreview): string {
  return draft.task_id ?? draft.conversation_id;
}
