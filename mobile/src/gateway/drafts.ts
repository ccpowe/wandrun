import type { DraftDelta, DraftPreview, DraftSnapshot, GatewayEvent } from './api.ts';
import { draftTimeline } from './timelines.ts';

/** A row anchor belongs to one live cohort, not the permanent conversation history. */
export type DraftAnchor = { conversationId: string; rootId?: string; cohort: number; position: number; afterSeq: number | null; asOfSeq: number };

/** Replaceable active set; a terminal identity is retained only until a covering authoritative omission. */
export class Drafts {
  private active = new Map<string, DraftPreview>();
  private terminal = new Map<string, { conversationId: string; rootId: string; seq: number }>();
  readonly order = new Map<string, DraftAnchor>();
  private nextCohort = 0;
  private epoch: string | null = null;
  private revision = -1;
  private asOfSeq = 0;
  private awaitingSnapshot = false;

  /** Keep visible previews until the replacement stream supplies an authoritative snapshot. */
  reconnect(): void {
    this.awaitingSnapshot = true;
  }

  reset(): void {
    this.reconnect();
    this.active.clear();
    this.terminal.clear();
    this.order.clear();
    this.epoch = null;
    this.revision = -1;
    this.asOfSeq = 0;
    this.nextCohort = 0;
  }

  /** A snapshot can precede replay/history. Questions refine, never advance beyond, its watermark. */
  questionEvent(event: GatewayEvent): void {
    if (event.type !== 'message.user' || typeof event.conversation_id !== 'string') return;
    const timelineId = event.data.task_id ?? event.conversation_id;
    let cohort: number | undefined;
    for (const anchor of this.order.values()) {
      if (anchor.conversationId === timelineId && anchor.afterSeq === event.seq) cohort = anchor.cohort;
    }
    for (const anchor of this.order.values()) {
      if (anchor.conversationId !== timelineId || event.seq > anchor.asOfSeq ||
        event.seq <= (anchor.afterSeq ?? 0)) continue;
      // Split a provisionally shared cohort when replay reveals a newer question.
      cohort ??= this.nextCohort++;
      anchor.afterSeq = event.seq;
      anchor.cohort = cohort;
    }
    if (cohort !== undefined) {
      let position = 0;
      for (const anchor of this.order.values()) {
        if (anchor.cohort === cohort) anchor.position = position++;
      }
      // Reconnect awaits an authoritative active set; it is not proof that these cohorts settled.
      if (!this.awaitingSnapshot) this.releaseSettled(timelineId);
    }
  }

  terminalEvent(event: GatewayEvent): boolean {
    if (event.type !== 'message.agent' || typeof event.data.draft_id !== 'string' || !event.data.draft_id ||
      typeof event.conversation_id !== 'string') return false;
    const id = event.data.draft_id;
    const timelineId = event.data.task_id ?? event.conversation_id;
    if (event.seq <= this.asOfSeq && !this.active.has(id) && !this.order.has(id)) return false;
    const previous = this.terminal.get(id);
    if (!previous || event.seq > previous.seq) this.terminal.set(id, { conversationId: timelineId, rootId: event.conversation_id, seq: event.seq });
    const changed = this.active.delete(id);
    this.releaseSettled(timelineId);
    return changed;
  }

  /** Apply one coalesced append batch atomically; a gap requires a fresh connection snapshot.
   * Terminal events may precede this batch, so their identities never need a text baseline. */
  delta(raw: unknown, latestUserSeq: (conversationId: string) => number | null = () => null,
    deleted: (conversationId: string) => boolean = () => false): 'changed' | 'ignored' | 'gap' {
    if (!raw || typeof raw !== 'object') return 'gap';
    const data = raw as DraftDelta;
    if (data.epoch === this.epoch && Number.isSafeInteger(data.revision) && data.revision <= this.revision) return 'ignored';
    if (this.awaitingSnapshot || data.epoch !== this.epoch || data.base_revision !== this.revision ||
      !Number.isSafeInteger(data.revision) || data.revision <= data.base_revision ||
      !Number.isSafeInteger(data.as_of_seq) || data.as_of_seq < this.asOfSeq ||
      !Array.isArray(data.active_ids) || !Array.isArray(data.updates)) return 'gap';
    const ids = new Set(data.active_ids);
    if (ids.size !== data.active_ids.length || data.active_ids.some((id) => typeof id !== 'string' || !id)) return 'gap';
    const next = new Map(this.active);
    const updated = new Set<string>();
    const excluded = new Set<string>();
    for (const update of data.updates) {
      if (!update || !ids.has(update.draft_id) || updated.has(update.draft_id) ||
        typeof update.text !== 'string' || !Number.isSafeInteger(update.offset) || update.offset < 0) return 'gap';
      updated.add(update.draft_id);
      if (deleted(update.conversation_id)) {
        excluded.add(update.draft_id);
        continue;
      }
      if (this.terminal.has(update.draft_id)) continue;
      const prior = next.get(update.draft_id);
      if (update.offset !== (prior?.text.length ?? 0) ||
        (prior && (prior.conversation_id !== update.conversation_id || prior.sender !== update.sender ||
          draftTimeline(prior) !== draftTimeline(update)))) return 'gap';
      const { offset: _, ...draft } = update;
      next.set(draft.draft_id, { ...draft, text: (prior?.text ?? '') + draft.text });
    }
    const drafts: DraftPreview[] = [];
    for (const id of ids) {
      if (this.terminal.has(id) || excluded.has(id)) continue;
      const draft = next.get(id);
      if (!draft) return 'gap';
      if (!deleted(draft.conversation_id)) drafts.push(draft);
    }
    // The active set includes terminal identities even though their text is gone.
    return this.replace({ ...data, drafts }, latestUserSeq, ids) ? 'changed' : 'gap';
  }

  /** latestUserSeq is provisional; later inserted questions refine anchors within as_of_seq. */
  snapshot(raw: unknown, latestUserSeq: (conversationId: string) => number | null = () => null): boolean {
    return this.replace(raw, latestUserSeq);
  }

  private replace(raw: unknown, latestUserSeq: (conversationId: string) => number | null,
    observed = new Set<string>()): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const data = raw as Partial<DraftSnapshot>;
    if (typeof data.epoch !== 'string' || typeof data.revision !== 'number' ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !Number.isSafeInteger(data.as_of_seq) || data.as_of_seq! < 0 || !Array.isArray(data.drafts)) return false;
    if (data.as_of_seq! < this.asOfSeq) return false;
    if (this.epoch === data.epoch) {
      if (data.revision! < this.revision || (data.revision === this.revision && !this.awaitingSnapshot)) return false;
    } else if (this.epoch !== null && !this.awaitingSnapshot) return false;

    const next = new Map<string, DraftPreview>();
    for (const draft of data.drafts) {
      if (!draft || typeof draft.draft_id !== 'string' || !draft.draft_id ||
        typeof draft.conversation_id !== 'string' || typeof draft.sender !== 'string' ||
        typeof draft.agent !== 'string' || typeof draft.text !== 'string' ||
        !(draft.phase === null || typeof draft.phase === 'string')) return false;
      observed.add(draft.draft_id);
      if (!this.terminal.has(draft.draft_id)) next.set(draft.draft_id, draft);
    }
    const latest = new Map<string, DraftAnchor>();
    const starts = new Map<number, DraftAnchor>();
    for (const anchor of this.order.values()) {
      latest.set(anchor.conversationId, anchor);
      const start = starts.get(anchor.cohort);
      if (!start || anchor.asOfSeq < start.asOfSeq) starts.set(anchor.cohort, anchor);
    }
    for (const [id, draft] of next) {
      if (this.order.has(id)) continue;
      const timelineId = draftTimeline(draft);
      const afterSeq = latestUserSeq(timelineId);
      const prior = latest.get(timelineId);
      // A question loaded after the initial snapshot still identifies that
      // cohort if it predates the first draft, not a newly arrived question.
      const sameCohort = prior && (prior.afterSeq === afterSeq ||
        (prior.afterSeq === null && afterSeq !== null && afterSeq <= starts.get(prior.cohort)!.asOfSeq));
      const anchor: DraftAnchor = {
        conversationId: timelineId, rootId: draft.conversation_id,
        cohort: sameCohort ? prior.cohort : this.nextCohort++,
        position: sameCohort ? prior.position + 1 : 0,
        afterSeq: sameCohort ? prior.afterSeq : afterSeq, asOfSeq: data.as_of_seq!,
      };
      this.order.set(id, anchor);
      latest.set(timelineId, anchor);
      if (!sameCohort) starts.set(anchor.cohort, anchor);
    }
    this.epoch = data.epoch;
    this.revision = data.revision!;
    this.asOfSeq = data.as_of_seq!;
    this.awaitingSnapshot = false;
    this.active = next;
    for (const [id, terminal] of this.terminal) {
      if (!observed.has(id) && terminal.seq <= this.asOfSeq) this.terminal.delete(id);
    }
    for (const conversationId of latest.keys()) this.releaseSettled(conversationId);
    return true;
  }

  private releaseSettled(conversationId: string): void {
    const liveCohorts = new Set<number>();
    for (const id of this.active.keys()) {
      const anchor = this.order.get(id);
      if (anchor?.conversationId === conversationId) liveCohorts.add(anchor.cohort);
    }
    for (const [id, anchor] of this.order) {
      if (anchor.conversationId === conversationId && !liveCohorts.has(anchor.cohort)) this.order.delete(id);
    }
  }

  removeConversation(id: string): boolean {
    let changed = false;
    for (const [key, draft] of this.active) if (draft.conversation_id === id || draftTimeline(draft) === id) {
      this.order.delete(key);
      this.terminal.delete(key);
      this.active.delete(key);
      changed = true;
    }
    for (const [key, anchor] of this.order) if (anchor.conversationId === id || anchor.rootId === id) this.order.delete(key);
    for (const [key, terminal] of this.terminal) if (terminal.conversationId === id || terminal.rootId === id) this.terminal.delete(key);
    return changed;
  }

  forConversation(id: string): DraftPreview[] {
    return [...this.active.values()].filter((draft) => draftTimeline(draft) === id);
  }
}
