// 聊天页的纯逻辑：时间线条目的筛选与排序、状态派生、输入区按钮的选择。不依赖 React，Node 里可测。

import type { BrowserTask, DraftPreview, GatewayEvent, TaskStatus } from "../gateway/api.ts";
import type { DraftAnchor } from "../gateway/drafts.ts";
import type { ConversationView, Pending } from "../gateway/session.ts";
import { draftTimeline, eventTimelines } from "../gateway/timelines.ts";

export type Item = {
  key: string; event?: GatewayEvent; pending?: Pending; browser?: BrowserTask; draft?: DraftPreview;
  delegation?: { taskId: string; agentId: string; status: TaskStatus };
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: "进行中", waiting: "等待成员结果", completed: "已完成",
  failed: "失败", cancelled: "已停止", unavailable: "无法继续",
};

/** 无条件展示的事件；收件与状态同步事件不能直接变成列表行。 */
const VISIBLE: Record<string, true> = {
  "message.user": true, "message.agent": true, "schedule.triggered": true,
  "turn.failed": true, "takeover.ended": true,
  "context.compacted": true, "context.compaction_failed": true,
  "message.task_preview": true,
};

function isVisibleEvent(event: GatewayEvent, timelineId: string | undefined): boolean {
  switch (event.type) {
    case "message.task":
      // timeline_ids routes durable events to both endpoints, including the root.
      // Only member endpoints show these bodies; filtering here also removes their separators.
      return timelineId !== undefined && timelineId !== event.conversation_id &&
        (timelineId === event.data.sender_task_id || timelineId === event.data.recipient_task_id);
    case "memory.updated":
      return typeof event.data.agent_id === "string";
    case "turn.stopped":
      return !!event.data.was_working;
    default:
      return VISIBLE[event.type] === true;
  }
}

/**
 * 持久事件（按 seq）+ 还没确认的本地消息，按时间正序返回（最旧的在前）。
 * 不显示的事件在此排除，不留空行给列表渲染 separator；成员会话仍展示双方通信正文。
 */
export function buildItems(events: GatewayEvent[], pending: Pending[], browserTasks: ReadonlyMap<string, BrowserTask> = new Map(),
  drafts: readonly DraftPreview[] = [], draftOrder: ReadonlyMap<string, DraftAnchor> = new Map(),
  timelineId?: string, tasks: ReadonlyMap<string, { status: TaskStatus }> = new Map()): Item[] {
  // One card per lease, anchored at its first loaded event. Subsequent state
  // changes update that card rather than filling the conversation with copies.
  const latest = new Map<string, BrowserTask>();
  const delegations = new Map<string, Item["delegation"]>();
  for (const event of events) {
    if ((event.type === "task.created" || event.type === "task.status") &&
      event.data.creator_task_id === (timelineId ?? event.conversation_id)) {
      delegations.set(event.data.task_id, {
        taskId: event.data.task_id, agentId: event.data.agent_id,
        status: tasks.get(event.data.task_id)?.status ?? event.data.status,
      });
    }
    if (event.type === "browser_task.updated" && typeof event.data.id === "string") {
      latest.set(event.data.id, event.data as BrowserTask);
    }
  }
  const seen = new Set<string>();
  const items: Item[] = [];
  const cohorts = new Map<number, { afterSeq: number; rows: { item: Item; position: number }[] }>();
  const cohortStarts = new Map<number, DraftAnchor>();
  for (const anchor of draftOrder.values()) {
    const start = cohortStarts.get(anchor.cohort);
    if (!start || anchor.asOfSeq < start.asOfSeq) cohortStarts.set(anchor.cohort, anchor);
  }
  const anchorRow = (id: string, item: Item, conversationId: string): boolean => {
    const anchor = draftOrder.get(id);
    if (!anchor || anchor.conversationId !== conversationId) return false;
    let cohort = cohorts.get(anchor.cohort);
    if (!cohort) {
      // A sibling may first appear in a later snapshot. Bound the whole cohort
      // by its earliest observation, not whichever terminal event was loaded first.
      const start = cohortStarts.get(anchor.cohort)!;
      let afterSeq = start.afterSeq ?? 0;
      if (start.afterSeq === null) for (const event of events) {
        if (eventTimelines(event).includes(conversationId) && event.type === "message.user" &&
          event.seq <= start.asOfSeq) afterSeq = Math.max(afterSeq, event.seq);
      }
      cohort = { afterSeq, rows: [] };
      cohorts.set(anchor.cohort, cohort);
    }
    cohort.rows.push({ item, position: anchor.position });
    return true;
  };
  for (const event of events) {
    if ((event.type === "task.created" || event.type === "task.status") && delegations.has(event.data.task_id)) {
      const key = `t${event.data.task_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ key, event, delegation: delegations.get(event.data.task_id) });
      }
    } else if (event.type === "browser_task.updated" && typeof event.data.id === "string") {
      const id = event.data.id;
      if (!seen.has(id)) {
        seen.add(id);
        items.push({ key: `b${id}`, event, browser: browserTasks.get(id) ?? latest.get(id) });
      }
    } else if (isVisibleEvent(event, timelineId)) {
      const id = event.type === "message.agent" && typeof event.data.draft_id === "string" && event.data.draft_id;
      const item: Item = { key: id ? `d${id}` : `e${event.seq}`, event };
      if (!id || !anchorRow(id, item, event.data.task_id ?? event.conversation_id ?? "")) items.push(item);
    }
  }
  const terminalIds = new Set(events.filter((event) => event.type === "message.agent" &&
    typeof event.data.draft_id === "string").map((event) => event.data.draft_id as string));
  for (const draft of drafts) {
    if (terminalIds.has(draft.draft_id)) continue;
    const item: Item = { key: `d${draft.draft_id}`, draft };
    if (!anchorRow(draft.draft_id, item, draftTimeline(draft))) items.push(item);
  }
  const ordered = [...cohorts].sort(([idA, a], [idB, b]) => a.afterSeq - b.afterSeq || idA - idB);
  const placed: Item[] = [];
  let next = 0;
  for (const item of items) {
    if (item.event?.type === "message.user") {
      while (next < ordered.length && ordered[next][1].afterSeq < item.event.seq) {
        placed.push(...ordered[next][1].rows.sort((a, b) => a.position - b.position).map((row) => row.item));
        next++;
      }
    }
    placed.push(item);
  }
  while (next < ordered.length) {
    placed.push(...ordered[next][1].rows.sort((a, b) => a.position - b.position).map((row) => row.item));
    next++;
  }
  return [...placed, ...pending.map((p) => ({ key: `p${p.clientId}`, pending: p }))];
}

/** 本地待确认消息没有 seq；缺少定位参数时不能把两个 undefined 当作命中。 */
export function isMessageTarget(item: Item, messageSeq: number | undefined): boolean {
  return messageSeq !== undefined && item.event !== undefined && item.event.seq === messageSeq;
}

/** 最后一条可见事件是 turn.failed 时已经有错误卡片，不再重复显示“上一轮失败”提示。 */
export function showFailedHint(conversation: { status: string } | undefined, oldestFirst: Item[]): boolean {
  if (conversation?.status !== "failed") return false;
  for (let i = oldestFirst.length - 1; i >= 0; i--) {
    const event = oldestFirst[i]?.event;
    if (event) return event.type !== "turn.failed";
  }
  return true;
}

/** 顶栏副标题：工作中 / 失败 / 空闲时不显示。 */
export function statusLabel(status: ConversationView["status"] | undefined): string | null {
  if (status === "working") return "工作中";
  if (status === "failed") return "上一轮失败";
  return null;
}

export type ComposerAction = "send" | "stop" | "disabled";

/** 输入区右侧按钮：有输入或附件才发送；上传未确认时不能发送任何内容。 */
export function composerAction(working: boolean, draft: string, attachmentCount = 0, allReady = true): ComposerAction {
  if (attachmentCount > 0 && !allReady) return "disabled";
  if (draft.trim() || attachmentCount > 0) return "send";
  return working ? "stop" : "disabled";
}
