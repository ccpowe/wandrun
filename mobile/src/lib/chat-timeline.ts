// 聊天页的纯逻辑：时间线条目的筛选与排序、状态派生、输入区按钮的选择。不依赖 React，Node 里可测。

import type { BrowserTask, DraftPreview, GatewayEvent, TaskStatus } from "../gateway/api.ts";
import type { DraftAnchor } from "../gateway/drafts.ts";
import type { ConversationView, Pending } from "../gateway/session.ts";
import { draftTimeline, eventTimelines } from "../gateway/timelines.ts";
import type { UiSubmission } from "./agent-message.ts";
import type { NewChatAttempt, NewChatState } from "./new-conversation.ts";

type RowBase = {
  key: string;
  event?: GatewayEvent;
  pending?: Omit<Pending, "conversationId">;
  draft?: DraftPreview;
  browser?: BrowserTask;
  delegation?: { taskId: string; agentId: string; status: TaskStatus };
  label?: string;
  agentName?: string;
  senderName?: string;
  creatorName?: string;
  counterpart?: { incoming: boolean; name: string; avatar: number };
  submissions?: ReadonlyMap<number, UiSubmission>;
};

/** Display facts only. Commands and viewport state remain outside the projection. */
export type ChatRow = RowBase & (
  | { kind: "user"; delivery: "sending" | "unconfirmed" | "failed" | "sent"; retryable: boolean }
  | { kind: "agent"; phase: "streaming" | "final" | "interrupted" }
  | { kind: "browser"; browser: BrowserTask }
  | { kind: "delegation"; delegation: NonNullable<RowBase["delegation"]> }
  | { kind: "event"; event: GatewayEvent }
  /** `idle`: the blank placeholder that keeps the working row's place and height after the turn ended (chat.C9b). */
  | { kind: "working"; label: string; idle?: true }
);
export type TurnState = { working: boolean; stopping: boolean; label: string };
export type ChatProjectionInput = {
  timelineId?: string;
  events: readonly GatewayEvent[];
  pending: readonly Pending[];
  /** Kept as facts, not a gate: recovered receipts display before history succeeds (Q4). */
  timelineLoaded?: boolean;
  historyError?: string;
  drafts?: readonly DraftPreview[];
  draftOrder?: ReadonlyMap<string, DraftAnchor>;
  browserTasks?: ReadonlyMap<string, BrowserTask>;
  tasks?: ReadonlyMap<string, { status: TaskStatus; creator_agent_id?: string }>;
  turnFacts?: { working: boolean; stopping: boolean; activity: string | null; waitingForMembers: boolean };
  display?: {
    currentAgentId?: string;
    agentName(agentId: string, snapshotName?: string): string;
    agentAvatar(agentId: string): number;
    creatorName(task: { creator_agent_id?: string }): string;
    submissionsFor(timelineId: string, seq: number): ReadonlyMap<number, UiSubmission>;
  };
  firstIntent?: { attempt: NewChatAttempt; status: NewChatState["status"]; error: string | null; belongsToServer: boolean };
};

/** One pass from owner facts to complete display rows and the shared execution projection. */
export function projectChatRows(input: ChatProjectionInput): { rows: ChatRow[]; turn: TurnState } {
  const { events, pending, timelineId, drafts = [], draftOrder = new Map(), browserTasks = new Map(), tasks = new Map(), display } = input;
  const name = (id: string, snapshot?: string) => display?.agentName(id, snapshot) ?? snapshot ?? id;
  const senderName = (id?: string, snapshot?: string) => id && id !== display?.currentAgentId ? name(id, snapshot) : undefined;
  const eventRow = (key: string, event: GatewayEvent): ChatRow => {
    const ownerId = timelineId ?? event.data.task_id ?? event.conversation_id ?? "";
    if (event.type === "message.user") {
      const task = event.data.task_id ? tasks.get(ownerId) : undefined;
      return { kind: "user", key, event, delivery: "sent", retryable: false,
        creatorName: task ? display?.creatorName(task) ?? name(task.creator_agent_id ?? "") : undefined };
    }
    if (event.type === "message.agent") return { kind: "agent", key, event,
      phase: event.data.status === "interrupted" ? "interrupted" : "final",
      senderName: senderName(event.data.agent, event.data.agent_name),
      // Session mutates its submissions Map in place. The row must own a snapshot.
      submissions: new Map(display?.submissionsFor(ownerId, event.seq)) };
    const counterpartId = event.type === "message.task"
      ? event.data.recipient_task_id === ownerId ? event.data.sender_agent_id : event.data.recipient_agent_id : undefined;
    return { kind: "event", key, event,
      agentName: typeof event.data.agent_id === "string" ? name(event.data.agent_id, event.data.agent_name) : undefined,
      counterpart: counterpartId ? { incoming: event.data.recipient_task_id === ownerId,
        name: name(counterpartId), avatar: display?.agentAvatar(counterpartId) ?? 0 } : undefined };
  };
  const latest = new Map<string, BrowserTask>();
  const delegations = new Map<string, NonNullable<ChatRow["delegation"]>>();
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
  const items: ChatRow[] = [];
  const cohorts = new Map<number, { afterSeq: number; rows: { item: ChatRow; position: number }[] }>();
  const cohortStarts = new Map<number, DraftAnchor>();
  for (const anchor of draftOrder.values()) {
    const start = cohortStarts.get(anchor.cohort);
    if (!start || anchor.asOfSeq < start.asOfSeq) cohortStarts.set(anchor.cohort, anchor);
  }
  const anchorRow = (id: string, item: ChatRow, conversationId: string): boolean => {
    const anchor = draftOrder.get(id);
    if (!anchor || anchor.conversationId !== conversationId) return false;
    let cohort = cohorts.get(anchor.cohort);
    if (!cohort) {
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
        const delegation = delegations.get(event.data.task_id)!;
        items.push({ kind: "delegation", key, event, delegation, agentName: name(delegation.agentId, event.data.agent_name) });
      }
    } else if (event.type === "browser_task.updated" && typeof event.data.id === "string") {
      const id = event.data.id;
      if (!seen.has(id)) {
        seen.add(id);
        const browser = (browserTasks.get(id) ?? latest.get(id))!;
        items.push({ kind: "browser", key: `b${id}`, event, browser, agentName: name(browser.agent_id, browser.agent_name) });
      }
    } else if (isVisibleEvent(event, timelineId)) {
      const id = event.type === "message.agent" && typeof event.data.draft_id === "string" && event.data.draft_id;
      const key = event.type === "message.user" && event.client_id ? `p${event.client_id}` : id ? `d${id}` : `e${event.seq}`;
      const item = eventRow(key, event);
      if (!id || !anchorRow(id, item, event.data.task_id ?? event.conversation_id ?? "")) items.push(item);
    }
  }
  const terminalIds = new Set(events.filter((event) => event.type === "message.agent" &&
    typeof event.data.draft_id === "string").map((event) => event.data.draft_id as string));
  for (const draft of drafts) {
    if (terminalIds.has(draft.draft_id)) continue;
    const item: ChatRow = { kind: "agent", phase: "streaming", key: `d${draft.draft_id}`, draft, senderName: senderName(draft.agent) };
    if (!anchorRow(draft.draft_id, item, draftTimeline(draft))) items.push(item);
  }
  const ordered = [...cohorts].sort(([idA, a], [idB, b]) => a.afterSeq - b.afterSeq || idA - idB);
  const rows: ChatRow[] = [];
  let next = 0;
  for (const item of items) {
    if (item.event?.type === "message.user") {
      while (next < ordered.length && ordered[next][1].afterSeq < item.event.seq) {
        rows.push(...ordered[next][1].rows.sort((a, b) => a.position - b.position).map((row) => row.item));
        next++;
      }
    }
    rows.push(item);
  }
  while (next < ordered.length) {
    rows.push(...ordered[next][1].rows.sort((a, b) => a.position - b.position).map((row) => row.item));
    next++;
  }
  const acceptedClientIds = new Set(events.filter(event => event.type === "message.user" && event.client_id).map(event => event.client_id));
  for (const p of pending) {
    if (acceptedClientIds.has(p.clientId)) continue;
    const unconfirmed = p.reason === "timeout" || p.reason === "recovered" || p.reason === "deferred";
    rows.push({ kind: "user", key: `p${p.clientId}`, pending: { ...p },
      delivery: p.status === "sending" ? "sending" : unconfirmed ? "unconfirmed" : "failed", retryable: p.retryable });
  }
  const first = input.firstIntent;
  if (!timelineId && first?.attempt.kind === "send") {
    const sending = first.status === "preparing" || first.status === "creating";
    rows.push({ kind: "user", key: `p${first.attempt.messageClientId}`,
      delivery: sending ? "sending" : first.status === "unknown" ? "unconfirmed" : "failed",
      retryable: !sending && first.belongsToServer,
      pending: { clientId: first.attempt.messageClientId, text: first.attempt.text,
        status: sending ? "sending" : "failed", retryable: !sending && first.belongsToServer, error: first.error } });
  }
  const facts = input.turnFacts;
  const turn: TurnState = { working: facts?.working ?? false, stopping: facts?.stopping ?? false,
    label: facts?.stopping ? "正在停止…" : facts?.activity ?? (facts?.waitingForMembers ? "等待成员结果" : "工作中…") };
  if (turn.working) rows.push({ kind: "working", key: "working", label: turn.label });
  return { rows, turn };
}

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: "进行中", waiting: "等待成员结果", completed: "已完成",
  failed: "失败", cancelled: "已停止", unavailable: "无法继续",
};

/** 无条件展示的事件；收件与状态同步事件不能直接变成列表行。 */
const VISIBLE: Record<string, true> = {
  "message.user": true, "message.agent": true, "schedule.triggered": true,
  "turn.failed": true, "takeover.ended": true,
  "context.compacted": true, "context.compaction_failed": true,
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

/** 本地待确认消息没有 seq；缺少定位参数时不能把两个 undefined 当作命中。 */
export function isMessageTarget(item: ChatRow, messageSeq: number | undefined): boolean {
  return messageSeq !== undefined && item.event !== undefined && item.event.seq === messageSeq;
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
