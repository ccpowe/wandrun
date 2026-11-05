// Session-owned Agent directory in gateway order; UI ranking is a pure consumer projection.
// Reads are coalesced, generation-guarded and retried.

import { type AgentListSnapshot, type AgentSummary, type GatewayApi, type GatewayEvent } from "./api.ts";

/** Events that invalidate definitions, order, or retained conversation summaries. */
export function affectsAgentList(event: Pick<GatewayEvent, "type" | "conversation_id" | "data">): boolean {
  if (event.type === "resource.changed") return event.data.kind === "agent" || event.data.kind === "agent_order";
  // 用户在协作子对话里的插话也推进根的排序活动（conversation-drawer.P10）；成员的 Agent 回复不影响根摘要。
  if (event.type === "message.agent" && event.data.timeline_ids) return false;
  switch (event.type) {
    case "conversation.created":
    case "conversation.updated":
    case "conversation.deleted":
    case "conversation.status":
    case "conversation.read":
    case "message.user":
    case "message.agent":
    case "schedule.triggered":
      return true;
    default:
      // turn.failed / turn.stopped 总伴随 conversation.status，不单独触发。
      return false;
  }
}

type ListApi = Pick<GatewayApi, "listAgents">;

export type AgentListOptions = {
  /** 触发后等多久才发请求，合并这段时间内的多次触发。 */
  debounceMs?: number;
  /** 连续失败时第 n 次重试前的等待；用完最后一项后一直沿用它。 */
  retryDelays?: number[];
};

export class AgentList {
  agents: AgentSummary[] = [];
  /** 第一次拉取成功之前为 false：界面不能把“还没拉到”当成“没有 Agent”。 */
  loaded = false;
  /** 最近一次拉取失败的原因；成功后清除。失败时保留旧列表，并按 retryDelays 自动重试。 */
  error: string | null = null;
  /** Agent 定义失效代际；资料页据此重拉详情，不被对话消息引起的列表刷新牵动。 */
  definitionVersion = 0;
  /** 已确认删除的不可变 id；让打开的页面退出，而不把“尚未加载”误当删除。 */
  readonly deletedIds = new Set<string>();
  orderRevision = 0;
  /** Accept only monotonic order snapshots; summary freshness still uses the existing request generation. */
  private accept({ agents, as_of_seq, order_revision }: AgentListSnapshot): void {
    const previousOrder = this.agents.map((agent) => agent.id);
    const present = new Set(agents.map(agent => agent.id));
    for (const id of previousOrder) {
      if (!present.has(id)) this.deletedIds.add(id);
    }
    this.agents = agents;
    this.asOfSeq = as_of_seq;
    this.orderRevision = order_revision;
    this.loaded = true;
    this.error = null;
    this.failures = 0;
  }

  private readonly api: ListApi;
  private readonly onChange: () => void;
  private readonly debounceMs: number;
  private readonly retryDelays: number[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private loading = false;
  private dirty = false;
  private closed = false;
  private readGeneration = 0;
  /**
   * 请求代际：每个列表请求开始时、资源事件或摘要更新到达时以及 resync 时各取一个递增编号。
   * 列表响应只有在最近一次确认或失效之后开始时才写入，避免旧快照覆盖命令结果、带回已删除 Agent 或旧库摘要。
   * 被丢弃的响应会安排一次补拉。
   */
  private clock = 0;
  private confirmedAt = 0;
  private asOfSeq = 0;
  /** 详情与列表分别加载：列表水位不能代替每个 Agent 的详情失效水位。 */
  private resourceSeq = new Map<string, number>();

  constructor(api: ListApi, onChange: () => void, options: AgentListOptions = {}) {
    this.api = api;
    this.onChange = onChange;
    this.debounceMs = options.debounceMs ?? 150;
    this.retryDelays = options.retryDelays ?? [1000, 2000, 5000, 10_000];
  }

  /** 资源事件分别推进列表副本和详情失效；列表快照已包含事件也不能证明资料页已重拉。 */
  observe(event: GatewayEvent): void {
    if (this.closed) return;
    if (event.type === "resource.changed" && event.data.kind === "agent_order") {
      if (event.seq > this.asOfSeq) {
        this.confirmedAt = ++this.clock;
        this.refresh();
        this.onChange();
      }
      return;
    }
    if (event.type === "resource.changed" && event.data.kind === "agent") {
      const id = event.data.id as string;
      if (event.seq <= (this.resourceSeq.get(id) ?? 0)) return;
      this.resourceSeq.set(id, event.seq);
      this.definitionVersion++;
      if (event.data.op === "deleted") this.deletedIds.add(id);
      if (event.seq > this.asOfSeq) {
        this.confirmedAt = ++this.clock;
        if (event.data.op === "deleted") {
          this.agents = this.agents.filter((agent) => agent.id !== id);
        }
        this.refresh();
      }
      this.onChange();
      return;
    }
    if (affectsAgentList(event)) this.refresh();
  }

  /** 命令响应或事件流确认标题 / 删除后，立即修正可确定的摘要，挡住在途的旧列表并补拉其余派生字段。 */
  conversationChanged(event: GatewayEvent): void {
    if (this.closed || event.seq <= this.asOfSeq) return; // 旧事件不能回滚比它新的 GET /agents
    this.confirmedAt = ++this.clock;
    this.agents = this.agents.map((agent) => {
      const latest = agent.latest_conversation;
      if (!latest) return agent;
      if (event.type === "conversation.updated" && latest.id === event.conversation_id) {
        return { ...agent, latest_conversation: { ...latest, title: event.data.title } };
      }
      if (event.type === "conversation.deleted" && latest.id === event.data.id) {
        return { ...agent, latest_conversation: null };
      }
      return agent;
    });
    this.onChange();
    this.refresh();
  }

  /** 同标题 PATCH 不产生事件；命令响应仍可能纠正过期的本地摘要。 */
  conversationTitle(id: string, title: string): void {
    if (this.closed) return;
    this.confirmedAt = ++this.clock;
    this.agents = this.agents.map((agent) => {
      const latest = agent.latest_conversation;
      return latest?.id === id ? { ...agent, latest_conversation: { ...latest, title } } : agent;
    });
    this.onChange();
    this.refresh();
  }

  /**
   * 请求重拉（合并短时间内的多次请求）。重连 / 聚焦也调用它。
   * 正在等待退避重试时，它让重试提前到现在。
   */
  refresh(): void {
    if (this.closed) return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.loading) {
      this.dirty = true;
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, this.debounceMs);
  }

  /** A new SSE generation may read immediately even if the old native GET never finishes. */
  abandonRead(): void {
    if (this.closed) return;
    this.readGeneration++;
    this.confirmedAt = ++this.clock;
    this.loading = false;
    this.dirty = false;
  }

  /** 换库后摘要的事件编号不可再比较；同时挡住换库前已经发出的列表响应。 */
  invalidate(): void {
    if (this.closed) return;
    this.abandonRead();
    this.definitionVersion++;
    this.asOfSeq = 0;
    this.resourceSeq.clear();
    this.orderRevision = 0;
    this.deletedIds.clear();
    this.confirmedAt = ++this.clock;
    this.agents = this.agents.map((agent) => ({ ...agent, latest_conversation: null, unread: false }));
    this.refresh();
    this.onChange();
  }


  /**
   * Drop this computer's cached list and timers. The API owner aborts in-flight requests;
   * any responses that still arrive cannot update or notify after close.
   */
  close(): void {
    this.readGeneration++;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    this.agents = [];
    this.loaded = false;
    this.error = null;
    this.definitionVersion = 0;
    this.deletedIds.clear();
    this.resourceSeq.clear();
    this.asOfSeq = 0;
    this.confirmedAt = 0;
    this.clock = 0;
    this.failures = 0;
    this.dirty = false;
  }


  private async load(): Promise<void> {
    this.loading = true;
    const startedAt = ++this.clock;
    const generation = this.readGeneration;
    let failed = false;
    try {
      const snapshot = await this.api.listAgents();
      if (this.closed || generation !== this.readGeneration) return;
      if (startedAt > this.confirmedAt && snapshot.order_revision >= this.orderRevision) {
        this.accept(snapshot);
      } else {
        this.dirty = true; // Old snapshot: discard and read again.
      }
    } catch (error) {
      if (this.closed || generation !== this.readGeneration) return;
      this.error = String(error);
      failed = true;
    } finally {
      if (generation === this.readGeneration) this.loading = false;
    }
    if (generation !== this.readGeneration) return;
    this.onChange();
    if (failed) {
      const delay = this.retryDelays[Math.min(this.failures++, this.retryDelays.length - 1)];
      this.dirty = false;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.load();
      }, delay);
    } else if (this.dirty) {
      this.dirty = false;
      this.refresh();
    }
  }
}
