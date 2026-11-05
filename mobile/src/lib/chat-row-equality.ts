import type { ChatRow } from "./chat-timeline.ts";

/**
 * LegendList's `itemsAreEqual`: two projections of the same row render the same pixels. Every field a row
 * component reads must be listed here (or be in the list's `extraData`); otherwise the row keeps its old
 * look. The projection builds fresh objects on every page render, so equality is by content, and the list
 * is not told about a change when nothing visible changed (a send window has many session events).
 *
 * Pending rows are never equal: their retry / discard handlers are captured with the row.
 */
export function chatRowsEqual(previous: ChatRow, item: ChatRow): boolean {
  if (previous.pending || item.pending) return false;
  return previous.key === item.key && previous.kind === item.kind &&
    previous.event === item.event && previous.draft === item.draft && previous.browser === item.browser &&
    previous.delegation?.status === item.delegation?.status && previous.delegation?.taskId === item.delegation?.taskId &&
    previous.label === item.label && idleOf(previous) === idleOf(item) &&
    previous.agentName === item.agentName && previous.senderName === item.senderName && previous.creatorName === item.creatorName &&
    previous.counterpart?.incoming === item.counterpart?.incoming && previous.counterpart?.name === item.counterpart?.name &&
    previous.counterpart?.avatar === item.counterpart?.avatar &&
    phaseOf(previous) === phaseOf(item) && sameSubmissions(previous.submissions, item.submissions);
}

function idleOf(row: ChatRow): boolean {
  return row.kind === "working" && row.idle === true;
}

function phaseOf(row: ChatRow): string | undefined {
  return row.kind === "agent" ? row.phase : row.kind === "user" ? `${row.delivery}:${row.retryable}` : undefined;
}

// The row owns a Map snapshot (a new Map per projection), so compare entries, not the Map.
function sameSubmissions(a: ChatRow["submissions"], b: ChatRow["submissions"]): boolean {
  if (a === b) return true;
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
  if (!a || !b) return true;
  for (const [block, submission] of a) if (b.get(block) !== submission) return false;
  return true;
}

/**
 * Inputs of a row's leading space (`messageSpacing` in chat-history): its index is 0 or not, and whether its neighbors are
 * delegation rows. The list re-runs `renderItem` only for rows whose data or `extraData` changed, never for a changed index,
 * so a prepend (the old first row gets a gap) or an inserted neighbor must change `extraData`: the first row's key plus, for each
 * delegation row, its own key and its two neighbors' keys.
 */
export function rowLayout(items: readonly ChatRow[]): string {
  let layout = `${items[0]?.key ?? ""};`;
  items.forEach((item, index) => {
    if (item.delegation) layout += `${items[index - 1]?.key ?? ""}|${item.key}|${items[index + 1]?.key ?? ""},`;
  });
  return layout;
}
