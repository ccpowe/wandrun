// App 端的会话状态：列表 + 一条全局事件流 + 打开过的聊天时间线（ADR-0022 第 4、6 节）。
//
// 时间线按 seq 合并：历史分页、事件流、命令响应给的都是同一种持久事件，同一个 seq 只记一次，
// 来源先后不影响结果，所以不用协调“先拉历史还是先开流”。
// 对话的当前字段（状态、未读、最后一条）只由事件流、命令响应和列表推进，历史分页只补时间线。
// 时间线去重与当前字段的水位独立：历史先到不能挡住事件流，旧事件也不能回滚列表快照或较新的字段。

import {
  type AgentSummary,
  type BrowserTask,
  type Conversation,
  type DraftPreview,
  type Fetch,
  type FileRecord,
  type GatewayConfig,
  type GatewayEvent,
  type TransientEvent,
  type TaskConversation,
  GatewayApi,
  GatewayError,
} from "./api.ts";
import { AgentList } from "./agents.ts";
import { EventStream, type StreamOptions, type StreamState } from "./stream.ts";
import { Drafts } from "./drafts.ts";
import { uiSubmissionFromEvent, type UiDraft, type UiSubmission } from "../lib/agent-message.ts";
import { eventTimelines } from "./timelines.ts";
import { networkDiagnostic } from "./network-diagnostics.ts";


export type ConversationView = Omit<Conversation, "last_agent_seq"> & {
  /** 临时的“正在做什么”，状态离开 working 时清掉。 */
  activity: string | null;
  lastTextSeq: number;
  /** 最近一条已确认产品活动的时间；对话列表不提供它，不能拿 updated_at 代替。 */
  lastActivityAt: number | null;
  lastAgentSeq: number;
};

export type TaskView = TaskConversation & {
  lastAgentSeq: number; statusSeq: number; snapshotSeq: number;
  /** Receipt event watermark, distinct from the message position it acknowledges. */
  readEventSeq: number;
};

export type Timeline = {
  events: GatewayEvent[]; // 按 seq 升序
  /** Lowest event seq for each (Agent message seq, block), including events from older history pages. */
  submissions: Map<number, Map<number, UiSubmission & { seq: number }>>;
  /** 历史分页的游标：已拉到的最早一条。事件流塞进来的事件不算，它们不保证连续。 */
  oldest: number | null;
  loaded: boolean;
  complete: boolean;
  loading: boolean;
  /** 本时间线最近一次历史请求失败；新尝试开始时清除，不依赖 SSE 连接状态。 */
  historyError?: string;
};

export type Pending = {
  clientId: string;
  conversationId: string;
  text: string;
  attachments?: Pick<FileRecord, "id" | "name" | "media_type" | "size">[];
  status: "sending" | "failed";
  /** 失败后能否用同一个 client_id 重试（网关不会重复执行）。 */
  retryable: boolean;
  error: string | null;
};

const PAGE = 50;
const DELETED_TIMELINE: Timeline = { events: [], submissions: new Map(), oldest: null, loaded: true, complete: true, loading: false };
const EMPTY_SUBMISSIONS: ReadonlyMap<number, UiSubmission> = new Map();

export class ChatSession {
  readonly api: GatewayApi;
  conversations = new Map<string, ConversationView>();
  timelines = new Map<string, Timeline>();
  tasks = new Map<string, TaskView>();
  taskErrors = new Map<string, string>();
  private timelineRoots = new Map<string, string>();
  /** Retained even before detail arrives: deep descendants need not be loaded in the App. */
  private branchActivity = new Map<string, { seq: number; working: boolean }>();
  private collaborationScopes = new Set<string>();
  private collaborationRequests = new Map<string, Promise<void>>();
  collaborationErrors = new Map<string, string>();
  private taskGeneration = 0;
  pending = new Map<string, Pending>();
  readonly drafts = new Drafts();
  /** Unsaved card values and unknown-result attempts belong to this session, not recycled list rows. */
  private uiDrafts = new Map<string, Map<number, Map<number, UiDraft>>>();
  connection: StreamState | "listing" | "error" = "listing";
  /** 最近一次命令或连接错误，给界面提示用。 */
  notice: string | null = null;
  /** Stop failures belong to one conversation, not the global connection notice. */
  stopErrors = new Map<string, string>();
  stopping = new Set<string>();
  /** An unconfirmed failed stop retains its client identity until a receipt, terminal state or removal. */
  private stopRequests = new Map<string, { clientId: string; confirmed: boolean }>();
  version = 0;
  /** 首页 / 全部 Agent 的数据；事件流（重新）连上和相关事件到达时自动重拉。 */
  readonly agents: AgentList;
  /** Connector metadata/status and used_by invalidation; screens keep editable drafts separate from this revision. */
  connectorRevision = 0;
  /** Skill directories are not watched; only gateway deletes emit events. Screens also refresh on focus. */
  skillRevision = 0;
  /** Global schedule revision; resources have no Agent metadata in their event. */
  scheduleRevision = 0;
  /** Live lease snapshots shared by chat, profile, settings and attention dots. */
  browserTasks = new Map<string, BrowserTask>();
  browserRevision = 0;
  browserError: string | null = null;
  private browserSnapshotSeq = 0;
  private browserEventSeq = new Map<string, number>();
  private browserRefresh: Promise<void> | null = null;
  private browserRefreshAgain = false;
  private browserGeneration = 0;
  private collaborationGeneration = 0;
  private scheduleSeq = new Map<string, number>();
  readonly deletedScheduleIds = new Set<string>();
  readonly deletedConnectorIds = new Set<string>();
  /** Connector definition events, distinct from status probes and Agent usage updates (secrets cannot be compared). */
  readonly connectorDefinitionSeq = new Map<string, number>();
  memoryConnectionRevision = 0;
  private memoryResourceSeq = new Map<string, number>();
  private profileMemorySeq = 0;
  /** Profile invalidates every Agent's shared section; work only the named Agent. */
  memoryRevisionFor(scope: "profile" | "work", id?: string): number {
    return scope === "profile" ? this.profileMemorySeq : this.memoryResourceSeq.get(id ?? "") ?? 0;
  }



  private stream: EventStream | null = null;
  private streams = new Set<EventStream>();
  private listeners = new Set<() => void>();
  private draftNotification: ReturnType<typeof setTimeout> | undefined;
  private viewing = new Map<string, number>();
  /** 对话 → 已读请求进行中时是否又有新事件，需要请求结束后再标一次。 */
  private reading = new Map<string, boolean>();
  private readonly streamOptions: StreamOptions;
  private closed = false;
  private starting: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  /** Foreground and native network notifications share a five-second recovery bound. */
  private lastResumeAt = -Infinity;
  private pendingResume: ReturnType<typeof setTimeout> | undefined;
  private lastRecoveryByteAt = -Infinity;
  private readonly resetConnections: (() => void) | undefined;
  private restartList = false;
  private wakeList: (() => void) | null = null;
  private snapshotSeq = 0;
  private lastStatusSeq = new Map<string, number>();
  /** 删除事件是全局事件；保留墓碑，挡住旧 SSE、历史分页和在途命令。换库时清空。 */
  private deleted = new Map<string, number>();
  private lastTitleSeq = new Map<string, number>();
  /** 初次列表请求在途时先到的命令响应，列表返回后按 seq 重放。 */
  private beforeSnapshot = new Map<number, GatewayEvent>();
  private createdBeforeSnapshot = new Map<string, ConversationView>();

  /** The native layer owns staged bytes; this callback disposes them on local or remote deletion. */
  onConversationDeleted?: (id: string) => void;
  constructor(config: GatewayConfig, fetchImpl?: Fetch, streamOptions: StreamOptions = {}, onUnauthorized?: (reason: "invalid" | "revoked") => void, resetConnections?: () => void) {
    this.api = new GatewayApi(config, fetchImpl, onUnauthorized, resetConnections);
    this.streamOptions = streamOptions;
    this.resetConnections = resetConnections;
    this.agents = new AgentList(this.api, () => this.changed());
  }

  // ---- 订阅（给 useSyncExternalStore） ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    if (this.closed) return;
    // Durable messages, interruption and local actions bypass pending preview work.
    clearTimeout(this.draftNotification);
    this.draftNotification = undefined;
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private draftChanged(): void {
    if (this.draftNotification !== undefined) return;
    // State advances on arrival; React sees only the newest preview at most 4Hz.
    this.draftNotification = setTimeout(() => this.changed(), 250);
  }

  // ---- 连接 ----

  /** 拉列表，再用列表的 as_of_seq 开流：两者之间不漏不重。网关不通时退避重试，直到成功或 close。 */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.starting ??= this.list().finally(() => (this.starting = null));
    return this.starting;
  }

  private async list(): Promise<void> {
    const delays = [500, 1000, 2000, 5000, 10_000];
    for (let attempt = 0; !this.closed; attempt++) {
      this.connection = "listing";
      this.changed();
      try {
        const { conversations, as_of_seq } = await this.api.listConversations();
        if (this.closed) return;
        this.reset(conversations, as_of_seq);
        this.openStream(as_of_seq);
        return;
      } catch (error) {
        if (this.closed) return;
        if (this.restartList) {
          this.restartList = false;
          attempt = -1;
          continue;
        }
        this.connection = "error";
        this.notice = describe(error);
        this.changed();
        if (error instanceof GatewayError && error.status === 401) return; // 令牌错了，重试没有意义
        await new Promise<void>((resolve) => {
          const signal = this.api.signal;
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            if (this.wakeList === done) this.wakeList = null;
            resolve();
          };
          const timer = setTimeout(done, delays[Math.min(attempt, delays.length - 1)]);
          this.wakeList = done;
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted || this.restartList) done();
        });
        if (this.restartList) { this.restartList = false; attempt = -1; }
      }
    }
  }

  private openStream(after: number): void {
    if (this.closed) return;
    this.stream = new EventStream(
      this.api,
      after,
      {
        event: (event) => this.apply(event),
        transient: (event) => this.applyTransient(event),
        resync: () => void this.resync(),
        activity: () => {
          if (this.lastResumeAt === -Infinity) return;
          this.lastRecoveryByteAt = Date.now();
          clearTimeout(this.pendingResume);
          this.pendingResume = undefined;
        },
        state: (state) => {
          if (this.stream === null || this.connection === state) return;
          this.connection = state;
          if (state === "open") {
            this.drafts.reconnect();
            this.abandonSnapshotReads();
            this.notice = null;
            this.agents.refresh();
            this.refreshConnectors();
            this.skillRevision++;
            this.memoryConnectionRevision++;
            this.scheduleRevision++;
            void this.refreshBrowserTasks();
            for (const id of this.collaborationScopes) void this.refreshCollaborations(id);
          }
          this.changed();
        },
      },
      this.streamOptions,
    );
    const stream = this.stream;
    this.streams.add(stream);
    void stream.done.finally(() => this.streams.delete(stream));
  }

  /** 游标来自别的存储：本地的事件编号全部作废，重新拉列表、重新开流。 */
  private async resync(): Promise<void> {
    if (this.closed) return;
    const stream = this.stream;
    this.stream = null;
    this.connection = "listing"; // 清空旧库状态前先标记，界面不能把临时空列表当成已删除
    this.deleted.clear();
    this.lastTitleSeq.clear();
    this.beforeSnapshot.clear();
    this.createdBeforeSnapshot.clear();
    this.timelines.clear();
    this.stopErrors.clear();
    this.stopRequests.clear();
    this.stopping.clear();
    this.resetTasks();
    this.uiDrafts.clear();
    this.drafts.reset();
    this.pending.clear();
    this.reset([], 0);
    this.agents.invalidate();
    this.deletedConnectorIds.clear();
    this.connectorDefinitionSeq.clear();
    this.refreshConnectors();
    this.skillRevision++;
    this.memoryResourceSeq.clear();
    this.profileMemorySeq = 0;
    this.scheduleSeq.clear();
    this.deletedScheduleIds.clear();
    this.scheduleRevision++;
    this.browserGeneration++;
    this.browserTasks.clear();
    this.browserEventSeq.clear();
    this.browserSnapshotSeq = 0;
    this.browserRefresh = null;
    this.browserRefreshAgain = false;
    this.browserError = null;
    this.browserRevision++;
    await stream?.close();
    await this.start();
  }

  /** Force the stream now; explicit callers retain the existing low-level bypass. */
  reconnectNow(): void {
    this.stream?.reconnectNow();
  }

  /** One recovery entry for active/network signals: first immediate, then at most one every five seconds.
   * A hint during cooldown is delivered at the bound, even if the earlier attempt was offline. */
  resume(source: "foreground" | "network" = "network", backgroundMs = 0): void {
    if (this.closed) return;
    const now = Date.now();
    const remaining = this.lastResumeAt + 5000 - now;
    if (remaining > 0 && now - this.lastRecoveryByteAt < 250) return; // One native notification burst after proven bytes.
    if (remaining > 0) {
      this.pendingResume ??= setTimeout(() => {
        this.pendingResume = undefined;
        if (this.closed) return;
        this.lastRecoveryByteAt = -Infinity;
        this.lastResumeAt = Date.now();
        this.resetAndRecover(source, backgroundMs);
      }, remaining);
      return;
    }
    clearTimeout(this.pendingResume);
    this.pendingResume = undefined;
    this.lastResumeAt = now;
    this.lastRecoveryByteAt = -Infinity;
    this.resetAndRecover(source, backgroundMs);
  }

  private resetAndRecover(source: "foreground" | "network", backgroundMs: number): void {
    networkDiagnostic("recovery_start", { source, backgroundMs, nativeReset: !!this.resetConnections });
    try {
      // Synchronous native boundary: no replacement read/stream starts on the old pool.
      // Coalescing happens above this point, so duplicate hints cannot reset fresh TCPs.
      if (this.resetConnections) this.api.resetConnections();
    } catch {
      networkDiagnostic("recovery_reset_failed");
      // Keep the existing JS recovery/idle fallback usable if the native reset fails.
    }
    this.recover();
  }

  /** Replace even a fresh SSE without discarding timelines, pending sends or visible snapshots. */
  private recover(): void {
    this.abandonSnapshotReads();
    if (this.stream) this.stream.reconnectNow();
    else if (this.starting) {
      this.restartList = true;
      this.wakeList?.();
    } else void this.start();
  }

  /** A superseded native read may never settle; detach its single-flight owner before the new SSE refresh. */
  private abandonSnapshotReads(): void {
    this.api.cancelReads();
    this.agents.abandonRead();
    this.browserGeneration++;
    this.browserRefresh = null;
    this.browserRefreshAgain = false;
    this.collaborationGeneration++;
    this.collaborationRequests.clear();
  }

  get lastSeq(): number {
    return this.stream?.lastSeq ?? 0;
  }

  /** Closing the API first interrupts requests and socket streams before a replacement can start. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.pendingResume);
    this.pendingResume = undefined;
    clearTimeout(this.draftNotification);
    this.wakeList?.();
    this.draftNotification = undefined;
    this.api.close();
    this.agents.close();
    this.stream = null;
    this.closing = Promise.all([...this.streams].map((stream) => stream.close()).concat(this.starting ? [this.starting] : [])).then(() => {
      this.streams.clear();
      this.conversations.clear();
      this.timelines.clear();
      this.stopErrors.clear();
      this.stopRequests.clear();
      this.resetTasks();
      this.pending.clear();
      this.uiDrafts.clear();
      this.drafts.reset();
      this.stopping.clear();
      this.viewing.clear();
      this.reading.clear();
      this.listeners.clear();
      this.creating.clear();
      this.beforeSnapshot.clear();
      this.createdBeforeSnapshot.clear();
      this.deleted.clear();
      this.lastStatusSeq.clear();
      this.lastTitleSeq.clear();
      this.browserTasks.clear();
      this.browserEventSeq.clear();
      this.browserRefresh = null;
      this.browserRefreshAgain = false;
      this.scheduleSeq.clear();
      this.deletedScheduleIds.clear();
      this.deletedConnectorIds.clear();
      this.connectorDefinitionSeq.clear();
      this.memoryResourceSeq.clear();
      this.profileMemorySeq = 0;
      this.connection = "stopped";
      this.notice = null;
      this.snapshotSeq = 0;
      this.browserSnapshotSeq = 0;
      this.browserGeneration = 0;
      this.browserError = null;
      this.connectorRevision = 0;
      this.skillRevision = 0;
      this.scheduleRevision = 0;
      this.browserRevision = 0;
      this.memoryConnectionRevision = 0;
      this.onConversationDeleted = undefined;
    });
    return this.closing;
  }

  private reset(conversations: Conversation[], asOf: number): void {
    this.snapshotSeq = asOf;
    this.lastStatusSeq.clear();
    this.lastTitleSeq.clear();
    this.conversations = new Map(
      conversations.filter((c) => !this.deleted.has(c.id)).map(({ last_agent_seq, ...c }) => [
        c.id,
        { ...c, activity: null, lastTextSeq: 0, lastActivityAt: null, lastAgentSeq: last_agent_seq },
      ]),
    );
    for (const [id, conversation] of this.createdBeforeSnapshot) {
      if (!this.deleted.has(id) && !this.conversations.has(id)) this.conversations.set(id, conversation);
    }
    this.createdBeforeSnapshot.clear();
    const ahead = [...this.beforeSnapshot.values()].filter((event) => event.seq > asOf).sort((a, b) => a.seq - b.seq);
    this.beforeSnapshot.clear();
    for (const event of ahead) this.apply(event);
    this.beforeSnapshot.clear();
    this.changed();
  }

  /** Snapshot watermarks prevent an HTTP response from overwriting a newer SSE update. */
  refreshBrowserTasks(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.browserRefresh) {
      this.browserRefreshAgain = true;
      return this.browserRefresh;
    }
    const generation = this.browserGeneration;
    const request = this.api.listBrowserTasks().then(({ browser_tasks, as_of_seq }) => {
      if (this.closed || generation !== this.browserGeneration || as_of_seq < this.browserSnapshotSeq) return;
      const next = new Map(browser_tasks.filter((task) => !this.deleted.has(task.root_id)).map((task) => [task.id, task]));
      for (const [id, seq] of this.browserEventSeq) {
        if (seq > as_of_seq) {
          const current = this.browserTasks.get(id);
          if (current && !this.deleted.has(current.root_id)) next.set(id, current);
        }
      }
      for (const [id, task] of next) {
        const conversation = this.conversations.get(task.root_id);
        if (conversation && (this.lastTitleSeq.get(task.root_id) ?? 0) > as_of_seq) {
          next.set(id, { ...task, conversation_title: conversation.title });
        }
      }
      this.browserTasks = next;
      this.browserSnapshotSeq = as_of_seq;
      for (const [id, seq] of this.browserEventSeq) if (seq <= as_of_seq) this.browserEventSeq.delete(id);
      this.browserError = null;
      this.browserRevision++;
      this.changed();
    }, (error: unknown) => {
      if (this.closed || generation !== this.browserGeneration) return;
      this.browserError = describe(error);
      this.changed();
    }).finally(() => {
      if (this.browserRefresh === request) {
        this.browserRefresh = null;
        if (this.browserRefreshAgain) {
          this.browserRefreshAgain = false;
          void this.refreshBrowserTasks();
        }
      }
    });
    this.browserRefresh = request;
    return request;
  }

  /** Read receipts never clear a still-requested lease's attention. */
  requestedBrowser(entryAgentId: string): BrowserTask | undefined {
    return [...this.browserTasks.values()].find((task) => task.entry_agent_id === entryAgentId && task.state === "requested");
  }


  private resetTasks(): void {
    this.taskGeneration++;
    this.collaborationGeneration++;
    this.tasks.clear();
    this.taskErrors.clear();
    this.timelineRoots.clear();
    this.branchActivity.clear();
    this.collaborationScopes.clear();
    this.collaborationRequests.clear();
    this.collaborationErrors.clear();
  }

  /** Roots stay separate so collaboration activity never changes homepage selection. */
  chat(id: string): ConversationView | TaskView | undefined {
    return this.tasks.get(id) ?? this.conversations.get(id);
  }

  /** Resource coordinates remain root + seq even when the visible row lives in a member timeline. */
  messageAt(rootId: string, seq: number): GatewayEvent | undefined {
    for (const [id, timeline] of this.timelines) {
      if (this.rootId(id) !== rootId) continue;
      const event = timeline.events.find((item) => item.seq === seq && item.type === "message.agent");
      if (event) return event;
    }
    return undefined;
  }

  /** Branch activity is authoritative server state, never inferred from a partially loaded tree. */
  isWorking(id: string): boolean {
    return this.tasks.get(id)?.branch_working ?? (this.conversations.get(id)?.status === "working");
  }

  rootId(id: string): string {
    return this.tasks.get(id)?.root_id ?? this.timelineRoots.get(id) ?? id;
  }

  /** Deletion can precede first detail: late ownership must invalidate drafts and navigation too. */
  private forgetTask(id: string, seq: number): void {
    if (this.deleted.has(id)) return;
    this.deleted.set(id, seq);
    this.tasks.delete(id);
    this.taskErrors.delete(id);
    this.stopErrors.delete(id);
    this.stopRequests.delete(id);
    this.timelines.delete(id);
    this.uiDrafts.delete(id);
    this.drafts.removeConversation(id);
    this.viewing.delete(id);
    this.reading.delete(id);
    this.stopping.delete(id);
    this.timelineRoots.delete(id);
    this.branchActivity.delete(id);
    for (const [clientId, pending] of this.pending) {
      if (pending.conversationId === id) this.pending.delete(clientId);
    }
    this.onConversationDeleted?.(id);
  }

  private acceptTask(task: TaskConversation, asOf: number): void {
    const deletion = this.deleted.get(task.root_id);
    if (deletion !== undefined) {
      this.forgetTask(task.id, deletion);
      return;
    }
    if (this.deleted.has(task.id)) return;
    const previous = this.tasks.get(task.id);
    if (previous && previous.snapshotSeq > asOf) return;
    const readSeq = Math.max(task.read_seq, previous?.read_seq ?? 0);
    const lastAgentSeq = previous && previous.readEventSeq > asOf ? previous.lastAgentSeq
      : Math.max(task.unread ? asOf : 0, (previous?.lastAgentSeq ?? 0) > asOf ? previous!.lastAgentSeq : 0);
    const activity = this.branchActivity.get(task.id);
    if (!activity || activity.seq <= asOf) this.branchActivity.set(task.id, { seq: asOf, working: task.branch_working });
    this.tasks.set(task.id, {
      ...task, read_seq: readSeq, lastAgentSeq, unread: lastAgentSeq > readSeq,
      updated_at: Math.max(task.updated_at, previous?.updated_at ?? 0),
      status: previous && previous.statusSeq > asOf ? previous.status : task.status,
      error: previous && previous.statusSeq > asOf ? previous.error : task.error,
      statusSeq: Math.max(asOf, previous?.statusSeq ?? 0), snapshotSeq: asOf,
      readEventSeq: previous?.readEventSeq ?? 0,
      branch_working: this.branchActivity.get(task.id)!.working,
    });
    this.timelineRoots.set(task.id, task.root_id);
    for (const event of this.timelines.get(task.id)?.events ?? []) {
      if (event.seq > asOf) this.observeTask(event);
    }
  }

  /** Both drawer queries share task identities; their watermarks must not roll back live events. */
  refreshCollaborations(agentId: string): Promise<void> {
    this.collaborationScopes.add(agentId);
    const pending = this.collaborationRequests.get(agentId);
    if (pending) return pending;
    const generation = this.collaborationGeneration;
    const request = Promise.all([this.api.receivedConversations(agentId), this.api.collaborations(agentId)]).then((responses) => {
      if (this.closed || generation !== this.collaborationGeneration) return;
      for (const { conversations, as_of_seq } of responses) {
        for (const item of conversations) {
          if (item.kind === "task") this.acceptTask(item, as_of_seq);
        }
      }
      this.collaborationErrors.delete(agentId);
    }).catch((error: unknown) => {
      if (!this.closed && generation === this.collaborationGeneration) this.collaborationErrors.set(agentId, describe(error));
    }).finally(() => {
      if (this.collaborationRequests.get(agentId) !== request) return;
      this.collaborationRequests.delete(agentId);
      this.changed();
    });
    this.collaborationRequests.set(agentId, request);
    return request;
  }

  /** Detail has no watermark: only fill a missing identity; events arriving meanwhile win. */
  private async ensureTask(id: string): Promise<void> {
    if (this.chat(id)) return;
    const generation = this.taskGeneration;
    const floor = Math.max(this.lastSeq, this.timelines.get(id)?.events.at(-1)?.seq ?? 0);
    const task = await this.api.task(id);
    if (this.closed || generation !== this.taskGeneration) return;
    if (!this.tasks.has(id)) {
      this.acceptTask(task, floor);
      // A newer live receipt wins over the detail's unversioned unread bit.
      const current = this.tasks.get(id);
      if (current) current.unread ||= task.unread && current.read_seq <= task.read_seq;
      else this.changed(); // Late root ownership may have removed the pending timeline.
    }
  }

  private observeTask(event: GatewayEvent): void {
    const data = event.data;
    if (event.type === "task.created" && !this.tasks.has(data.task_id)) {
      this.acceptTask({
        id: data.task_id, task_id: data.task_id, kind: "task", root_id: event.conversation_id!,
        root_title: this.conversations.get(event.conversation_id!)?.title ?? "",
        creator_task_id: data.creator_task_id, creator_agent_id: data.creator_agent_id,
        agent_id: data.agent_id, initiator: data.creator_agent_id, recipient: data.agent_id,
        title: data.title, status: data.status, error: null, unread: false, read_seq: 0,
        branch_working: true,
        created_at: event.at, updated_at: event.at,
      }, 0);
    }
    if (event.type === "task.created" || event.type === "task.status") {
      for (const [id, working] of Object.entries(data.branch_activity ?? {})) {
        if (this.deleted.has(id) || event.seq <= (this.branchActivity.get(id)?.seq ?? -1)) continue;
        this.branchActivity.set(id, { seq: event.seq, working: working as boolean });
        this.timelineRoots.set(id, event.conversation_id!);
        const task = this.tasks.get(id);
        if (task) task.branch_working = working as boolean;
        if (!working) this.confirmStop(id);
      }
    }
    for (const id of eventTimelines(event)) {
      const task = this.tasks.get(id);
      if (!task || event.seq <= task.snapshotSeq) continue;
      if (event.type === "task.status" && data.task_id === id && event.seq > task.statusSeq) {
        task.status = data.status;
        task.error = data.error;
        task.statusSeq = event.seq;
        if (data.status === "running") this.taskErrors.delete(id);
      }
      if (event.type === "task.read" && data.task_id === id) {
        task.read_seq = Math.max(task.read_seq, data.seq);
        task.readEventSeq = Math.max(task.readEventSeq, event.seq);
      }
      const attention = event.type === "message.agent" || event.type === "message.task" ||
        (event.type === "task.status" && (data.status === "failed" || data.status === "unavailable"));
      if (attention) task.lastAgentSeq = Math.max(task.lastAgentSeq, event.seq);
      task.unread = task.lastAgentSeq > task.read_seq;
      if (event.type !== "task.read") task.updated_at = Math.max(task.updated_at, event.at);
      if (attention && this.viewing.has(id)) void this.markRead(id);
    }
  }

  /** A terminal result clears only this target's stop; later working cannot undo confirmation. */
  private confirmStop(id: string): void {
    this.stopErrors.delete(id);
    const request = this.stopRequests.get(id);
    if (!request) return;
    request.confirmed = true;
    if (!this.stopping.has(id)) this.stopRequests.delete(id);
  }
  // ---- 事件 ----

  /** 事件流或命令响应里的持久事件；各字段按自己的 seq 水位应用，与时间线是否已有该事件无关。 */
  private apply(event: GatewayEvent): void {
    if (this.closed) return;
    if (this.connection === "listing" && event.seq > this.snapshotSeq) this.beforeSnapshot.set(event.seq, event);
    if (event.type === "conversation.deleted") {
      const id = event.data.id;
      if (typeof id === "string" && event.seq > (this.deleted.get(id) ?? 0)) {
        this.deleted.set(id, event.seq);
        const children = new Set([...this.timelineRoots].filter(([, root]) => root === id).map(([child]) => child));
        for (const [child, task] of this.tasks) if (task.root_id === id) children.add(child);
        for (const child of children) this.forgetTask(child, event.seq);
        this.conversations.delete(id);
        this.timelines.delete(id);
        this.stopErrors.delete(id);
        this.stopRequests.delete(id);
        this.uiDrafts.delete(id);
        this.drafts.removeConversation(id);
        this.viewing.delete(id);
        this.reading.delete(id);
        this.stopping.delete(id);
        this.lastStatusSeq.delete(id);
        this.lastTitleSeq.delete(id);
        this.createdBeforeSnapshot.delete(id);
        for (const [leaseId, task] of this.browserTasks) {
          if (task.root_id === id) this.browserTasks.delete(leaseId);
        }
        this.browserRevision++;
        for (const [clientId, pending] of this.pending) {
          if (pending.conversationId === id || children.has(pending.conversationId)) this.pending.delete(clientId);
        }
        this.onConversationDeleted?.(id);
        this.agents.conversationChanged(event);
        this.changed();
      }
      return;
    }
    if (event.type === "resource.changed" && (event.data.kind === "connector" || event.data.kind === "agent")) {
      if (event.data.kind === "connector" && typeof event.data.id === "string") {
        if (event.data.op !== "status") {
          this.connectorDefinitionSeq.set(event.data.id, Math.max(event.seq, this.connectorDefinitionSeq.get(event.data.id) ?? 0));
        }
        if (event.data.op === "deleted") this.deletedConnectorIds.add(event.data.id);
      }
      this.refreshConnectors();
      if (event.data.kind === "agent") void this.refreshBrowserTasks();
    }
    if (event.type === "resource.changed" &&
      (event.data.kind === "skill" || event.data.kind === "agent")) {
      this.skillRevision++;
    }
    if (event.type === "browser_task.updated" && typeof event.data.id === "string" &&
      event.seq > Math.max(this.browserSnapshotSeq, this.browserEventSeq.get(event.data.id) ?? 0) &&
      !this.deleted.has(event.data.root_id)) {
      this.browserEventSeq.set(event.data.id, event.seq);
      this.browserTasks.set(event.data.id, event.data as BrowserTask);
      this.browserRevision++;
    }
    if (event.type === "takeover.ended") void this.refreshBrowserTasks();
    if (event.type === "resource.changed" && event.data.kind === "memory") {
      if (event.data.scope === "profile") {
        this.profileMemorySeq = Math.max(this.profileMemorySeq, event.seq);
      } else if (event.data.scope === "work" && typeof event.data.id === "string") {
        const previous = this.memoryResourceSeq.get(event.data.id) ?? 0;
        if (event.seq > previous) this.memoryResourceSeq.set(event.data.id, event.seq);
      }
    }
    if (event.type === "resource.changed" && event.data.kind === "schedule" && typeof event.data.id === "string") {
      const id = event.data.id;
      if (event.seq > (this.scheduleSeq.get(id) ?? 0)) {
        this.scheduleSeq.set(id, event.seq);
        if (event.data.op === "deleted") this.deletedScheduleIds.add(id);
        else this.deletedScheduleIds.delete(id);
        this.scheduleRevision++;
      }
    }
    this.agents.observe(event);
    if (event.conversation_id === undefined) {
      // 全局资源事件使相关列表失效，但不进入对话时间线。
      this.changed();
      return;
    }
    if (this.deleted.has(event.conversation_id)) return;
    if (event.type === "turn.stopped" && event.client_id) {
      const id = typeof event.data.task_id === "string" ? event.data.task_id : event.conversation_id;
      const request = this.stopRequests.get(id);
      if (request?.clientId === event.client_id) this.confirmStop(id);
    }
    this.insert(event);
    this.observeTask(event);
    if (event.client_id && (event.type === "message.user" || event.type === "message.agent")) {
      this.pending.delete(event.client_id);
    }
    if (event.seq <= this.snapshotSeq) {
      this.changed();
      return;
    }
    const conversation = eventTimelines(event).includes(event.conversation_id)
      ? this.conversations.get(event.conversation_id) : undefined;
    // context.* 压缩通知只留在时间线，不更新未读、last_text 或会话列表顺序。
    switch (event.type) {
      case "conversation.created":
        if (!conversation) {
          this.conversations.set(event.conversation_id, {
            id: event.conversation_id,
            agent_id: event.data.agent_id,
            title: event.data.title,
            source: event.data.source ?? "user",
            schedule_origin: event.data.schedule_origin ?? null,
            created_at: event.at,
            updated_at: event.at,
            read_seq: 0,
            status: "idle",
            unread: false,
            last_text: null,
            activity: null,
            lastTextSeq: 0,
            lastActivityAt: null,
            lastAgentSeq: 0,
          });
        }
        break;
      case "conversation.updated":
        if (conversation && event.seq > (this.lastTitleSeq.get(conversation.id) ?? this.snapshotSeq)) {
          this.lastTitleSeq.set(conversation.id, event.seq);
          conversation.title = event.data.title;
          conversation.updated_at = Math.max(conversation.updated_at, event.at);
          for (const task of this.tasks.values()) if (task.root_id === conversation.id) task.root_title = conversation.title;
          this.agents.conversationChanged(event);
          for (const [leaseId, task] of this.browserTasks) {
            if (task.root_id === conversation.id) this.browserTasks.set(leaseId, { ...task, conversation_title: event.data.title });
          }
          this.browserRevision++;
        }
        break;
      case "conversation.status":
        if (conversation && event.seq > (this.lastStatusSeq.get(conversation.id) ?? 0)) {
          this.lastStatusSeq.set(conversation.id, event.seq);
          conversation.status = event.data.status;
          if (event.data.status !== "working") {
            conversation.activity = null;
            this.confirmStop(conversation.id);
          }
        }
        break;
      case "message.user":
      case "message.agent":
        if (conversation && event.seq > conversation.lastTextSeq && typeof event.data.text === "string") {
          conversation.last_text = event.data.text;
          conversation.lastTextSeq = event.seq;
          conversation.lastActivityAt = event.at;
          conversation.updated_at = Math.max(conversation.updated_at, event.at);
        }
        if (conversation && event.type === "message.agent" && event.seq > conversation.lastAgentSeq) {
          conversation.lastAgentSeq = event.seq;
          conversation.unread = conversation.lastAgentSeq > conversation.read_seq;
          if (this.viewing.has(conversation.id)) void this.markRead(conversation.id);
        }
        break;
      case "conversation.read":
        if (conversation) {
          conversation.read_seq = Math.max(conversation.read_seq, event.data.seq);
          conversation.unread = conversation.lastAgentSeq > conversation.read_seq;
        }
        break;
    }
    this.changed();
  }

  private applyTransient(event: TransientEvent): void {
    if (this.closed) return;
    if (event.type === "draft.delta") {
      const result = this.drafts.delta(event.data, (id) => this.latestQuestion(id, event.data.as_of_seq),
        (id) => this.deleted.has(id));
      if (result === "gap") this.stream?.reconnectNow();
      else if (result === "changed") this.draftChanged();
      return;
    }
    if (event.type === "draft.snapshot") {
      const raw = event.data;
      const snapshot = Array.isArray(raw.drafts)
        ? { ...raw, drafts: raw.drafts.filter((draft: DraftPreview) => !this.deleted.has(draft?.conversation_id)) }
        : raw;
      if (this.drafts.snapshot(snapshot, (id) => this.latestQuestion(id, raw.as_of_seq))) this.changed();
      return;
    }
    const conversation = event.conversation_id && this.conversations.get(event.conversation_id);
    if (event.type !== "activity" || !conversation || conversation.status !== "working") return;
    conversation.activity = event.data.label;
    this.changed();
  }

  private latestQuestion(id: string, asOfSeq: number): number | null {
    const events = this.timelines.get(id)?.events;
    if (events) for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].type === "message.user" && events[index].seq <= asOfSeq) return events[index].seq;
    }
    return null;
  }

  /** 时间线按 seq 去重；不表示该事件已经应用到当前字段。 */
  private insert(event: GatewayEvent): void {
    if (!event.conversation_id || this.deleted.has(event.conversation_id)) return;
    this.drafts.questionEvent(event);
    this.drafts.terminalEvent(event);
    for (const id of eventTimelines(event)) {
      if (this.deleted.has(id)) continue;
      if (id !== event.conversation_id) this.timelineRoots.set(id, event.conversation_id);
      this.insertInto(id, event);
    }
  }

  private insertInto(id: string, event: GatewayEvent): void {
    const timeline = this.timeline(id);
    const events = timeline.events;
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (events[middle].seq < event.seq) low = middle + 1;
      else high = middle;
    }
    if (events[low]?.seq === event.seq) return;
    events.splice(low, 0, event);
    const submitted = uiSubmissionFromEvent(event);
    if (submitted) {
      let blocks = timeline.submissions.get(submitted.messageSeq);
      if (!blocks) {
        blocks = new Map();
        timeline.submissions.set(submitted.messageSeq, blocks);
      }
      const previous = blocks.get(submitted.block);
      const drafts = this.uiDrafts.get(id);
      const messageDrafts = drafts?.get(submitted.messageSeq);
      messageDrafts?.delete(submitted.block);
      if (messageDrafts?.size === 0) drafts?.delete(submitted.messageSeq);
      if (drafts?.size === 0) this.uiDrafts.delete(id);
      if (!previous || event.seq < previous.seq) blocks.set(submitted.block, { ...submitted.submission, seq: event.seq });
    }
  }

  /** 收到已确认的删除事件；换库后墓碑会失效，新列表权威决定对话是否仍存在。 */
  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  timeline(id: string): Timeline {
    if (this.closed || this.deleted.has(id)) return DELETED_TIMELINE;
    let timeline = this.timelines.get(id);
    if (!timeline) {
      timeline = { events: [], submissions: new Map(), oldest: null, loaded: false, complete: false, loading: false };
      this.timelines.set(id, timeline);
    }
    return timeline;
  }

  /** The first persisted user submission per block, whether discovered through history, SSE or command response. */
  submissionsFor(conversationId: string, messageSeq: number): ReadonlyMap<number, UiSubmission> {
    return this.timeline(conversationId).submissions.get(messageSeq) ?? EMPTY_SUBMISSIONS;
  }

  uiDraftFor(conversationId: string, messageSeq: number, block: number): UiDraft | undefined {
    return this.uiDrafts.get(conversationId)?.get(messageSeq)?.get(block);
  }

  /** Persist only while the card has no authoritative winner; notify remounted rows of request outcomes. */
  saveUiDraft(conversationId: string, messageSeq: number, block: number, draft: UiDraft): void {
    if (this.closed || this.deleted.has(conversationId) || this.submissionsFor(conversationId, messageSeq).has(block)) return;
    let messages = this.uiDrafts.get(conversationId);
    if (!messages) this.uiDrafts.set(conversationId, messages = new Map());
    let blocks = messages.get(messageSeq);
    if (!blocks) messages.set(messageSeq, blocks = new Map());
    const previous = blocks.get(block);
    blocks.set(block, draft);
    // The json-render store already updates the mounted field; don't rerender the entire chat per keystroke.
    if (previous?.pending !== draft.pending || previous?.completed !== draft.completed ||
      previous?.error !== draft.error || previous?.attempt !== draft.attempt) this.changed();
  }

  // ---- 聊天页 ----

  /** 打开聊天页：没拉过历史就拉第一页；在看的对话收到 Agent 消息时自动标记已读。返回离开时的清理。 */
  view(id: string): () => void {
    if (this.closed || this.deleted.has(id) || this.connection === "listing") return () => {};
    this.viewing.set(id, (this.viewing.get(id) ?? 0) + 1);
    if (!this.timeline(id).loaded) void this.loadOlder(id);
    void this.markRead(id);
    return () => {
      const count = (this.viewing.get(id) ?? 1) - 1;
      if (count > 0) this.viewing.set(id, count);
      else this.viewing.delete(id);
    };
  }

  async loadOlder(id: string): Promise<void> {
    if (this.closed || this.deleted.has(id)) return;
    const timeline = this.timeline(id);
    if (timeline.loading || timeline.complete) return;
    timeline.loading = true;
    timeline.historyError = undefined;
    this.taskErrors.delete(id);
    this.changed();
    try {
      if (!this.chat(id)) await this.ensureTask(id);
      if (this.closed || this.deleted.has(id) || this.timelines.get(id) !== timeline) return;
      const { events } = await (this.tasks.has(id)
        ? this.api.taskHistory(id, timeline.oldest ?? undefined, PAGE)
        : this.api.history(id, timeline.oldest ?? undefined, PAGE));
      if (this.closed || this.deleted.has(id) || this.timelines.get(id) !== timeline) return;
      for (const event of events) this.insert(event);
      if (events.length > 0) timeline.oldest = events[0].seq;
      timeline.complete = events.length < PAGE;
      timeline.loaded = true;
      if (this.viewing.has(id)) void this.markRead(id);
    } catch (error) {
      if (!this.closed && !this.deleted.has(id) && this.timelines.get(id) === timeline) {
        timeline.historyError = describe(error);
        if (!this.chat(id)) this.taskErrors.set(id, timeline.historyError);
      }
    } finally {
      if (!this.closed && this.timelines.get(id) === timeline) {
        timeline.loading = false;
        this.changed();
      }
    }
  }

  /** 已读位置取这个对话时间线里最新的一条：一定不超过网关的最新事件。
   *  同一对话同时只发一个请求；进行中又到了新消息就记下来，结束后再标一次，否则最后那条会一直算未读。 */
  private async markRead(id: string): Promise<void> {
    if (this.closed || this.deleted.has(id)) return;
    if (this.reading.has(id)) {
      this.reading.set(id, true);
      return;
    }
    this.reading.set(id, false);
    try {
      do {
        this.reading.set(id, false);
        const conversation = this.chat(id);
        const latest = Math.max(this.timelines.get(id)?.events.at(-1)?.seq ?? 0, this.tasks.get(id)?.snapshotSeq ?? 0);
        if (!conversation || latest <= conversation.read_seq) continue;
        await (this.tasks.has(id) ? this.api.markTaskRead(id, latest) : this.api.markRead(id, latest));
        if (this.closed || this.deleted.has(id) || this.chat(id) !== conversation) return;
        // conversation.read 事件会经事件流回来；这里先本地更新，红点立即消失。
        conversation.read_seq = Math.max(conversation.read_seq, latest);
        conversation.unread = conversation.lastAgentSeq > conversation.read_seq;
        this.changed();
      } while (!this.closed && !this.deleted.has(id) && this.reading.get(id));
    } catch {
      // 已读失败不打扰用户，下次收到消息或重新打开时再标
    } finally {
      this.reading.delete(id);
    }
  }

  // ---- 命令 ----

  async createConversation(agentId: string, title?: string): Promise<string> {
    const conversation = await this.api.createConversation(agentId, title);
    if (this.closed) throw new GatewayError(0, "cancelled", "连接已关闭");
    if (this.deleted.has(conversation.id)) throw new GatewayError(404, "not_found", "对话已删除");
    if (!this.conversations.has(conversation.id)) {
      this.conversations.set(conversation.id, { ...conversation, activity: null, lastTextSeq: 0, lastActivityAt: null, lastAgentSeq: 0 });
      if (this.connection === "listing") this.createdBeforeSnapshot.set(conversation.id, this.conversations.get(conversation.id)!);
      this.changed();
    }
    return conversation.id;
  }

  /**
   * 进入最近有产品活动的对话：比较摘要和本地已确认的用户 / Agent 消息，不受状态、已读或空对话影响。
   * 统一按活动 seq 比较，时间只用于展示；没有活动时复用最新创建的对话，都没有才新建。
   */
  conversationFor(agent: Pick<AgentSummary, "id" | "latest_conversation">): Promise<string> {
    // 换库后调用方可能还握着旧 Agent 行：优先用当前列表；尚未加载列表时，只信本地确实存在的摘要。
    const listed = this.agents.agents.find((item) => item.id === agent.id);
    const candidate = listed ? listed.latest_conversation : agent.latest_conversation;
    const summary = candidate && !this.deleted.has(candidate.id) && (listed || this.conversations.has(candidate.id))
      ? candidate
      : null;
    let active: ConversationView | undefined;
    let newest: ConversationView | undefined;
    for (const conversation of this.conversations.values()) {
      if (conversation.agent_id !== agent.id) continue;
      if (!newest || conversation.created_at > newest.created_at) newest = conversation;
      if (conversation.lastTextSeq > 0 && (!active || conversation.lastTextSeq > active.lastTextSeq)) {
        active = conversation;
      }
    }
    if (active && (summary?.last_activity_seq == null || active.lastTextSeq > summary.last_activity_seq)) {
      return Promise.resolve(active.id);
    }
    if (summary?.last_activity_seq != null) return Promise.resolve(summary.id);
    // 空摘要缺少创建时间；只有本地同时知道两者的创建时间时，才用较新的空对话覆盖它。
    const summaryCreatedAt = summary ? this.conversations.get(summary.id)?.created_at : undefined;
    const known = summary && (!newest || summaryCreatedAt === undefined || newest.created_at <= summaryCreatedAt)
      ? summary.id
      : newest?.id;
    return known !== undefined ? Promise.resolve(known) : this.createOnce(agent.id);
  }

  /**
   * “新对话”：已有一个空对话就直接用它，避免堆出一串空对话；否则新建。
   * 空 = 当前字段和已加载历史都没有消息，且本地没有待发送 / 发送失败的消息。
   */
  blankConversation(agentId: string): Promise<string> {
    const blank = this.conversationsOf(agentId).find((c) =>
      c.last_text === null &&
      this.pendingFor(c.id).length === 0 &&
      !this.timelines.get(c.id)?.events.some((event) => event.type === "message.user" || event.type === "message.agent")
    );
    return blank ? Promise.resolve(blank.id) : this.createOnce(agentId);
  }

  /** 某个入口 Agent 的对话，最近更新的在前。 */
  conversationsOf(agentId: string): ConversationView[] {
    return this.sortedConversations().filter((c) => c.agent_id === agentId);
  }

  /** 同一 Agent 的新建请求进行中时共用它：重复点击不会建出两个对话。 */
  private creating = new Map<string, Promise<string>>();

  private createOnce(agentId: string): Promise<string> {
    let creating = this.creating.get(agentId);
    if (!creating) {
      creating = this.createConversation(agentId).finally(() => this.creating.delete(agentId));
      this.creating.set(agentId, creating);
    }
    return creating;
  }

  /** 先在本地显示，再提交。client_id 在第一次提交前生成，重试沿用：网关保证同一个只执行一次。 */
  send(conversationId: string, text: string, attachments: Pick<FileRecord, "id" | "name" | "media_type" | "size">[] = []): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.deleted.has(conversationId)) {
      this.notice = "对话已删除";
      this.changed();
      return Promise.resolve();
    }
    const clientId = newClientId();
    this.pending.set(clientId, {
      clientId,
      conversationId,
      text,
      attachments,
      status: "sending",
      retryable: true,
      error: null,
    });
    this.changed();
    return this.submit(clientId);
  }

  retry(clientId: string): Promise<void> {
    const pending = this.pending.get(clientId);
    if (this.closed || !pending || pending.status === "sending" || !pending.retryable) return Promise.resolve();
    pending.status = "sending";
    pending.error = null;
    this.changed();
    return this.submit(clientId);
  }

  discard(clientId: string): void {
    if (this.pending.get(clientId)?.status === "failed") {
      this.pending.delete(clientId);
      this.changed();
    }
  }

  private async submit(clientId: string): Promise<void> {
    const pending = this.pending.get(clientId)!;
    try {
      const { event } = await (this.tasks.has(pending.conversationId)
        ? this.api.sendTaskMessage(pending.conversationId, clientId, pending.text)
        : this.api.sendMessage(pending.conversationId, clientId, pending.text, pending.attachments?.map((file) => file.id) ?? []));
      if (this.closed || this.pending.get(clientId) !== pending) return; // 流已确认、删除或换库时，不重放旧请求
      this.pending.delete(clientId);
      if (!this.deleted.has(pending.conversationId)) this.apply(event);
    } catch (error) {
      if (this.closed || this.pending.get(clientId) !== pending) return; // 流已确认，或对话已被删除
      pending.status = "failed";
      pending.retryable = !(error instanceof GatewayError) || error.retryable;
      pending.error = describe(error);
      this.collaborationRefusal(pending.conversationId, error);
      this.changed();
    }
  }

  /** A UI submission is a normal user event; conflicts include the winning user event, even outside history pages. */
  async submitUi(conversationId: string, messageSeq: number, block: number, values: Record<string, unknown>, clientId: string): Promise<void> {
    if (this.closed) throw new GatewayError(0, "cancelled", "连接已关闭");
    if (this.deleted.has(conversationId)) throw new GatewayError(404, "ui_block_not_found", "对话已删除");
    const timeline = this.timeline(conversationId);
    const rootId = this.rootId(conversationId);
    try {
      const { event } = await this.api.submitUi(rootId, clientId, messageSeq, block, values);
      if (this.closed || this.deleted.has(conversationId) || this.timelines.get(conversationId) !== timeline) return;
      this.apply(event);
    } catch (error) {
      this.collaborationRefusal(conversationId, error);
      if (!this.closed && error instanceof GatewayError && error.code === "ui_already_submitted" &&
        this.timelines.get(conversationId) === timeline && !this.deleted.has(conversationId) &&
        typeof error.details === "object" && error.details !== null && "event" in error.details) {
        const winner = error.details.event as GatewayEvent | null;
        const submitted = winner && uiSubmissionFromEvent(winner);
        if (winner?.conversation_id === rootId && submitted?.messageSeq === messageSeq && submitted.block === block) {
          this.apply(winner);
        }
      }
      throw error;
    }
  }

  /** 返回是否成功；标题不变也是成功，不造事件。响应落后于流时不回滚标题。 */
  async renameConversation(id: string, title: string): Promise<boolean> {
    const atStart = this.lastTitleSeq.get(id) ?? 0;
    const snapshotAtStart = this.snapshotSeq;
    try {
      const { conversation, event } = await this.api.renameConversation(id, title);
      if (this.closed || this.deleted.has(id)) return false;
      if (event) this.apply(event);
      else if (this.snapshotSeq === snapshotAtStart && (this.lastTitleSeq.get(id) ?? 0) === atStart) {
        const current = this.conversations.get(id);
        if (current) {
          current.title = conversation.title;
          current.updated_at = Math.max(current.updated_at, conversation.updated_at);
        }
        this.agents.conversationTitle(id, conversation.title);
      }
      return true;
    } catch (error) {
      if (this.closed) return false;
      this.notice = describe(error);
      this.changed();
      return false;
    }
  }

  /** DELETE 无请求体；响应和另一台设备的事件经同一条删除路径，重复返回原事件。 */
  async deleteConversation(id: string): Promise<boolean> {
    try {
      const { event } = await this.api.deleteConversation(id);
      if (this.closed) return false;
      this.apply(event);
      return true;
    } catch (error) {
      if (this.closed) return false;
      this.notice = describe(error);
      this.changed();
      return false;
    }
  }

  async stop(conversationId: string): Promise<void> {
    if (this.closed || this.deleted.has(conversationId) || this.stopping.has(conversationId)) return;
    const request = { clientId: newClientId(), confirmed: false };
    this.stopRequests.set(conversationId, request);
    this.stopErrors.delete(conversationId);
    this.stopping.add(conversationId);
    this.changed();
    const stop = () => this.tasks.has(conversationId)
      ? this.api.stopTask(conversationId, request.clientId) : this.api.stop(conversationId, request.clientId);
    try {
      // A lost response retries the same command, including its cascading scope.
      const { event } = await stop().catch((error) => {
        if (!this.closed && error instanceof GatewayError && error.status === 0 && error.code !== "cancelled") return stop();
        throw error;
      });
      if (!this.closed && !this.deleted.has(conversationId) && this.stopRequests.get(conversationId) === request) {
        this.stopErrors.delete(conversationId);
        this.apply(event);
      }
    } catch (error) {
      if (!this.closed && !this.deleted.has(conversationId) &&
        this.stopRequests.get(conversationId) === request && !request.confirmed) {
        this.stopErrors.set(conversationId, describe(error));
        this.collaborationRefusal(conversationId, error);
      }
    } finally {
      if (this.stopRequests.get(conversationId) === request) {
        this.stopping.delete(conversationId);
        if (!this.stopErrors.has(conversationId)) this.stopRequests.delete(conversationId);
      }
      this.changed();
    }
  }

  private collaborationRefusal(id: string, error: unknown): void {
    if (!(error instanceof GatewayError) || error.status !== 409 || !this.tasks.has(id)) return;
    if (error.code === "collaboration_unavailable") {
      this.tasks.get(id)!.status = "unavailable";
      this.taskErrors.set(id, "这个协作已无法继续");
    } else if (error.code === "collaboration_stopped") {
      this.taskErrors.set(id, error.message);
    }
    this.changed();
  }

  // ---- 查询 ----

  sortedConversations(): ConversationView[] {
    return [...this.conversations.values()].sort((a, b) => b.updated_at - a.updated_at);
  }

  pendingFor(conversationId: string): Pending[] {
    return [...this.pending.values()].filter((p) => p.conversationId === conversationId);
  }

  draftsFor(conversationId: string): DraftPreview[] {
    return this.drafts.forConversation(conversationId).filter((draft) => !this.deleted.has(draft.conversation_id));
  }
  /** Also accepts command responses, which can arrive before the same SSE event. */
  connectorChanged(event: GatewayEvent | null): void {
    if (this.closed) return;
    if (event) this.apply(event);
    else this.refreshConnectors();
  }

  /** Apply a local skill deletion immediately; remote clients receive the same event via SSE. */
  skillChanged(event: GatewayEvent | null): void {
    if (this.closed) return;
    if (event) this.apply(event);
    else { this.skillRevision++; this.changed(); }
  }

  refreshConnectors(): void {
    if (this.closed) return;
    this.connectorRevision++;
    this.changed();
  }
}


function describe(error: unknown): string {
  if (error instanceof GatewayError) {
    if (error.status === 0) return error.code === "timeout" || error.code === "invalid_response" ? error.message : "连不上网关";
    if (error.status === 401) return "令牌不对";
    return error.message;
  }
  return String(error);
}

function newClientId(): string {
  // 只需在本机唯一；不依赖 crypto.randomUUID（Hermes 不一定有）。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

