// 网关 HTTP 接口（ADR-0022 第 5 节）。fetch 由调用方注入：手机上是 Expo 装好的全局 fetch，测试里是 Node 的。

import type { LocalImageLease } from "@/lib/local-image.ts";

export type ConversationStatus = "idle" | "working" | "failed";

export type Conversation = {
  id: string;
  /** 入口 Agent，创建后不变。 */
  agent_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /**
   * Latest user send (also in a collaboration child) or schedule trigger on this root: seq orders, at displays.
   * AI replies, status, browser requests, rename and read do not advance it (conversation-drawer.P1).
   */
  last_activity_seq: number | null;
  last_activity_at: number | null;
  read_seq: number;
  /** 本根时间线最后一条 Agent 回复的位置；没有回复时为 0，不是全局快照水位。 */
  last_agent_seq: number;
  status: ConversationStatus;
  unread: boolean;
  last_text: string | null;
  source: "user" | "schedule";
  schedule_origin: ScheduleOrigin | null;
};

export type TaskStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "unavailable";
/** A collaboration has its own timeline and read position, but resources belong to root_id. */
export type TaskConversation = {
  id: string; task_id: string; kind: "task"; root_id: string; root_title: string;
  creator_task_id: string; creator_agent_id: string; agent_id: string;
  initiator: string; recipient: string; title: string; status: TaskStatus; error: string | null;
  unread: boolean; read_seq: number; created_at: number; updated_at: number;
  /** This task or any descendant is running/waiting, including through settled intermediate tasks. */
  branch_working: boolean;
};
export type ReceivedConversation = (Conversation & {
  kind: "conversation"; root_id: string; task_id: string; initiator: "human"; recipient: string;
}) | TaskConversation;
export type ScheduleOrigin = { schedule_id: string; run_id: number; name: string; scheduled_at: number };
export type ScheduleRule =
  | { kind: "once"; local_at: string }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; time: string; weekdays: number[] }
  | { kind: "cron"; expression: string };
export type ScheduleFields = { name: string; content: string; rule: ScheduleRule; timezone: string; enabled: boolean };
export type Schedule = ScheduleFields & {
  id: string; agent_id: string; next_run_at: number | null; ended: boolean; created_at: number; updated_at: number;
};
export type ScheduleRun = {
  id: number; schedule_id: string; scheduled_at: number; started_at: number | null;
  finished_at: number | null; status: "running" | "completed" | "failed" | "cancelled" | "missed";
  reason: string | null; conversation_id: string | null; name: string; content: string;
  missed_before: number | null;
};

/**
 * Agent 作为入口的最近一个对话的摘要。“最近”按排序活动（用户发送、定时触发）的 seq 算，
 * 时间只用于展示；AI 回复、状态变化和已读不算活动，status 仍是对话当前状态。
 * 没有排序活动的对话时选择最新创建的空对话（含只有 AI 回复的），此时 last_text、last_activity_seq 与 last_activity_at 为 null。
 */
export type LatestConversation = {
  id: string;
  title: string;
  /** 用户或 Agent 的最后一条消息文字；还没有消息时为 null。 */
  last_text: string | null;
  /** 最后一条排序活动的全局 seq；与本地事件比较新鲜度，不使用墙上时间。 */
  last_activity_seq: number | null;
  last_activity_at: number | null;
  status: ConversationStatus;
};

/** 列表和详情共有的定义字段；workers 是直接委派对象的 id。 */
export type AgentCore = {
  id: string;
  name: string;
  /** 头像编号，从角色集中选。 */
  avatar: number;
  description: string;
  workers: string[];
};
/** Picker choices contain public machine metadata only; credentials remain on the gateway. */
export type ExecutionEnvironment = {
  id: string;
  name: string;
  type: "local" | "instabox";
  machine_id?: string;
  status: string | null;
};

/** 手机可编辑的定义字段。 */
export type AgentEditableFields = {
  name: string;
  avatar: number;
  description: string;
  system_prompt: string;
  model: string;
  reasoning_effort: string | null;
  fast_mode: boolean;
  code_mode: boolean;
  environment: string;
  skills: string[];
  workers: string[];
  /** 省略保留原选择；两个列表互斥，按需搜索要求连接器有说明。 */
  mcp_servers?: string[];
  searchable_mcp_servers?: string[];
};

export type CreateAgentInput = Pick<AgentEditableFields, "name" | "description" | "system_prompt">
  & Partial<Omit<AgentEditableFields, "name" | "description" | "system_prompt">>;

/** 请求头和环境变量只写不读：响应中的 true 仅表示已设置。 */
export type Connector = {
  id: string;
  name: string;
  description: string;
  icon?: string | null;
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
  transport_source?: "auto" | "user";
  headers?: Record<string, true>;
  env?: Record<string, true>;
  auth_type: "none" | "key" | "oauth";
  app_id: string | null;
  auth: ConnectorAuth;
  status: "connected" | "disconnected" | "failed";
  error: string | null;
  tool_count: number;
  used_by: ConnectorAgent[];
  /** 已保存参数与当前连接不同；重启后生效，测试仍使用当前连接参数。 */
  pending_restart: boolean;
};
export type ConnectorAuth = {
  status: "not_required" | "unauthorized" | "authorized" | "reauthorization_required";
  authorizing: boolean;
  /** Opaque public identity of the current pending transaction; never a URL, code or credential. */
  transaction_id: string | null;
  scopes: string[];
  /** Classified terminal authorization failure; never includes upstream responses or secrets. */
  error?: { code: string; message: string } | null;
};
export type ConnectorAgent = { id: string; name: string; avatar?: number };
export type AppEntry = {
  id: string; name: string; description: string; url: string; transport: string;
  /** `key` locates the single Key (header or URL query); the gateway applies it, the App only writes `headers[key.name]`. */
  auth: { type: "oauth" | "device" | "none" } | { type: "key"; key_url: string; headers: Record<string, string>; key: { in: "header" | "query"; name: string } };
  connector: Connector | null;
};
export type ConnectorProbe = {
  result: "none" | "key" | "oauth" | "failed"; transport: string;
  oauth?: { dcr_supported: boolean; pkce_supported: boolean; issuer: string };
  error?: { code: string; message: string };
};
export type ConnectorTools = {
  status: Connector["status"]; tools: { name: string; title: string | null; description: string | null }[]; as_of_seq: number;
};
/** Only an observed, settled attempt can prove not_created; absence of a receipt is unknown. */
export type ConnectorCreationResult =
  | { status: "pending" | "unknown" | "not_created" }
  | { status: "created"; connector: Connector; event: GatewayEvent };
/** Only the initiating page receives this transaction's URL/code; expiry is Unix seconds. */
export type OAuthStart =
  | { flow: "authorization_code"; transaction_id: string; authorization_url: string; expires_at: number; redirect_uri: string; manual_callback: boolean }
  | { flow: "device_code"; transaction_id: string; authorization_url: string; user_code: string; expires_at: number };

type ConnectorSecrets = Record<string, string | null>;
export type CreateConnectorInput = {
  name?: string;
  description?: string;
} & (
  { url: string; transport?: string; headers?: ConnectorSecrets; auth_type?: "none" | "key" | "oauth"; command?: never; args?: never; env?: never }
  | { command: string; args?: string[]; env?: ConnectorSecrets; auth_type?: "none"; url?: never; transport?: never; headers?: never }
);
/** Omitted fields keep their values; transport=null restores auto; null/empty secrets delete that key. */
export type PatchConnectorInput = {
  name?: string;
  description?: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: string | null;
  headers?: ConnectorSecrets;
  auth_type?: "none" | "key" | "oauth";
  env?: ConnectorSecrets;
};
export type ConnectorTestResult = {
  /** 本次已实际探测当前连接；不保证之后仍健康，也不验证待重启的新参数。 */
  success: boolean;
  tool_count: number;
  error: string | null;
  /** 为 true 时，即使 success=true，也仅说明旧参数的当前连接通过探测。 */
  pending_restart: boolean;
};

/** Workspace skill, including entries that cannot currently be loaded by an Agent. */
export type Skill = {
  name: string; description: string;
  used_by: { id: string; name: string }[];
  status: "ok" | "error"; error: string | null;
};
export type SkillDetail = Skill & { path: string; mtime: number | null; content: string | null };

/** Committed graph installation for one Agent; text is already user-facing. */
export type AgentCapability = {
  id: string; name: string; summary: string; description: string;
  status: "enabled" | "disabled" | "not_applicable"; reason: string;
  tools: string[]; skills: string[];
};
/** Builtins are separate from workspace skills, even when their names collide. */
export type BuiltinSkill = {
  name: string; description: string;
  capability: { id: string; name: string };
  used_by: { id: string; name: string }[];
};
export type BuiltinSkillDetail = BuiltinSkill & { content: string };

/** Only fields exposed by the gateway, never upstream account or authentication data. */
export type ModelInfo = {
  id: string;
  display_name: string;
  description: string;
  default_reasoning_effort: string | null;
  supported_reasoning_efforts: { effort: string; description: string }[];
};
export type ModelCatalog = { models: ModelInfo[]; fetched_at: number; capabilities?: { fast_mode?: boolean } };
export type ModelSettings = { default_model: string | null; default_reasoning_effort: string | null };
export type SubscriptionUsage = {
  plan_type: string | null;
  allowed: boolean | null;
  limit_reached: boolean | null;
  windows: { name: string; used_percent: number; window_seconds: number; reset_at: number }[];
  fetched_at: number;
};
/** Current gateway-owned authentication is independent of the last successful quota sample. */
export type SubscriptionAuth = {
  status: "ready" | "refresh_due" | "refreshing" | "reauth_required" | "relogin_required" | "temporarily_unavailable" | "login_required";
  reason: string | null;
  checked_at: number;
  codex_home: string;
  login_command: string;
};
export type SubscriptionStatus = { auth: SubscriptionAuth; usage: SubscriptionUsage | null };

function subscriptionStatus(payload: unknown): SubscriptionStatus {
  const invalid = () => new GatewayError(0, "invalid_response", "网关返回的订阅状态不完整");
  if (!payload || typeof payload !== "object") throw invalid();
  const { auth, usage } = payload as Record<string, unknown>;
  if (!auth || typeof auth !== "object") throw invalid();
  const state = auth as Record<string, unknown>;
  if (!["ready", "refresh_due", "refreshing", "reauth_required", "relogin_required", "temporarily_unavailable", "login_required"].includes(String(state.status)) ||
    !(state.reason === null || typeof state.reason === "string") ||
    typeof state.checked_at !== "number" || !Number.isFinite(state.checked_at) ||
    typeof state.codex_home !== "string" || !state.codex_home.startsWith("/") ||
    typeof state.login_command !== "string" || !state.login_command) throw invalid();
  if (usage !== null) {
    if (!usage || typeof usage !== "object") throw invalid();
    const quota = usage as Record<string, unknown>;
    if (!(quota.plan_type === null || typeof quota.plan_type === "string") ||
      !(quota.allowed === null || typeof quota.allowed === "boolean") ||
      !(quota.limit_reached === null || typeof quota.limit_reached === "boolean") ||
      typeof quota.fetched_at !== "number" || !Number.isFinite(quota.fetched_at) ||
      !Array.isArray(quota.windows) || !quota.windows.every((entry: unknown) => {
        if (!entry || typeof entry !== "object") return false;
        const window = entry as Record<string, unknown>;
        return typeof window.name === "string" && ["used_percent", "window_seconds", "reset_at"].every(
          (key) => typeof window[key] === "number" && Number.isFinite(window[key]),
        );
      })) throw invalid();
  }
  return payload as SubscriptionStatus;
}
export type AgentDailyUsage = {
  date: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};
export type AgentUsage = Omit<AgentDailyUsage, "date"> & { agent_id: string; daily: AgentDailyUsage[] };
export type AgentUsageReport = { days: number; agents: AgentUsage[] };

export type AgentDeleteConflictDetails = {
  member_of: { id: string; name: string }[];
};


/** All Agents, in the gateway's confirmed manual order. Conversation summaries remain for existing consumers. */
export type AgentSummary = AgentCore & {
  /** Configured execution environment id (same value as the detail's `environment`). */
  environment: string;
  latest_conversation: LatestConversation | null;
  unread: boolean;
};
export type AgentListSnapshot = { agents: AgentSummary[]; as_of_seq: number; order_revision: number };

/** 详情：完整定义；member_of 由网关从其他 Agent 的 workers 反查，不含自动展开的下属树。不含首页派生字段。 */
export type AgentDetail = AgentCore & {
  system_prompt: string;
  model: string;
  reasoning_effort: string | null;
  fast_mode: boolean;
  mcp_servers: string[];
  searchable_mcp_servers: string[];
  skills: string[];
  code_mode: boolean;
  environment: string;
  member_of: string[];
};
/** Both index resources use the entire document version as their CAS baseline. */
export type MemoryScope = "profile" | "work";
export type AgentMemory = {
  scope: MemoryScope;
  agent_id?: string;
  content: string;
  version: string;
  details: Record<string, { path: string; sha256: string }>;
  updated_at: number | null;
  updated_by: "user" | "agent" | "external" | null;
  limit: number;
};
export type MemoryDetail = {
  scope: MemoryScope; agent_id?: string; slug: string;
  content: string; sha256: string; path: string; version: string; limit: number;
};

function memoryEndpoint(scope: MemoryScope, id?: string): string {
  if (scope === "profile") return "/memory/profile";
  if (!id) throw new Error("Work memory requires an agent id");
  return `/agents/${encodeURIComponent(id)}/memory`;
}


/** Registered original file metadata. Source links become null when the source is deleted. */
export type FileRecord = {
  id: string; name: string; size: number; media_type: string;
  conversation_id: string | null; agent_id: string | null; task_id: string; created_at: number;
  source?: "agent" | "user_upload";
  remote_environment: string | null;
};
export type FilePreview = {
  kind: "image" | "video" | "pdf" | "audio";
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  page_count: number | null;
};
export type FileThumbnailWidth = 240 | 480 | 960;

/** One task's lease; entry Agent and holder Agent are deliberately distinct. */
export type BrowserPage = { id: string; title: string; url: string };
export type BrowserCapacity = {
  pages_used: number; pages_registered: number; pages_creating: number;
  pages_pending_cleanup: number; pages_limit: number;
};
export type BrowserTask = {
  id: string; task_id: string; root_id: string; agent_id: string; entry_agent_id: string;
  conversation_title: string; entry_agent_name: string;
  agent_name?: string;
  state: "agent" | "requested" | "human" | "revoking" | "stopping" | "released";
  epoch: number; pages: BrowserPage[]; current: string | null;
  environment_id: string; environment_name: string; capacity: BrowserCapacity;
  capacity_rejection: { id: string; reason: string } | null;
  reason: string | null; requested_reason: string | null;
};
export type ComputerStatus = {
  name: string; online_since: number; uptime_seconds: number; cpu_percent: number | null;
  memory: { used_bytes: number; total_bytes: number; percent: number };
  environments: { environment_id: string; environment_name: string; capacity: BrowserCapacity }[];
};
export type FileDetail = FileRecord & { available: boolean; error: string | null; error_message: string | null };
export type SearchResult =
  | { kind: "agent"; id: string; title: string; text: string }
  | { kind: "conversation"; id: string; title: string; agent_id: string }
  | { kind: "message"; id: string; title: string; text: string; conversation_id: string; task_id?: string; agent_id: string; seq: number }
  | { kind: "file"; id: string; title: string; file: FileRecord };

/** 历史中的压缩通知属于根对话，task_id / agent_id 标识真正执行的成员。 */
export type ContextCompactedData = {
  status: "completed";
  task_id: string; agent_id: string; agent_name: string;
  event_id: string; generation: number; reason: string; cutoff_index: number;
  created_at: string; summary_text: string; archive_path: string | null; archive_index_path?: string;
  keep_tokens: number; retained_tokens: number; retention_reason: string;
  summary_model: string | null; summary_usage: Record<string, unknown> | null;
};
export type ContextCompactionFailedData = {
  status: "failed";
  task_id: string; agent_id: string; agent_name: string;
  created_at: string; error: string; message: string;
};

/** 持久事件：seq 全局递增，聊天历史与事件流用的是同一种。 */
export type GatewayEvent = {
  seq: number;
  type: string;
  /** 不属于任何对话的事件（resource.changed）没有这个字段。 */
  conversation_id?: string;
  at: number;
  data: Record<string, any>;
  client_id?: string;
};

/** 无 seq 的临时草稿；快照恢复全局活跃集，连接内后续批次只追加变化，不推进持久游标。 */
export type DraftPreview = {
  draft_id: string; conversation_id: string; sender: string; agent: string; text: string; phase: string | null;
  task_id?: string;
};
export type DraftSnapshot = { epoch: string; revision: number; as_of_seq: number; drafts: DraftPreview[] };
/** Connection-relative append batch. offset counts UTF-16 code units (JS string.length).
 * active_ids is authoritative even for drafts which ended before ever being previewed. */
export type DraftDelta = {
  epoch: string; base_revision: number; revision: number; as_of_seq: number;
  active_ids: string[]; updates: (DraftPreview & { offset: number })[];
};
export type TransientEvent = { type: string; conversation_id?: string; data: Record<string, any> };

export type Fetch = typeof fetch;

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;


  constructor(status: number, code: string, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** status 0 表示网络或成功响应体读取失败（结果未知）；5xx 也可用同一 client_id 重放。 */
  get retryable(): boolean {
    return this.status === 0 || this.status === 503 || this.status >= 500;
  }
}

function responseError(response: Response, payload: unknown): GatewayError {
  const error = payload && typeof payload === "object" && "error" in payload ? payload.error : null;
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const messages: Record<number, string> = {
    400: "提交内容有误，请检查后重试",
    401: "连接认证失败，请重新配对",
    403: "没有权限执行此操作",
    404: "内容不存在或已被删除",
    405: "此操作暂不支持，请检查 App 与网关版本",
    408: "请求超时，请重试",
    413: "提交内容超过大小限制",
    429: "请求过于频繁，请稍后重试",
    502: "暂时无法连接网关，请稍后重试",
    503: "网关暂不可用，请稍后重试",
    504: "网关响应超时，请稍后重试",
  };
  const fallback = messages[response.status] ?? (response.status >= 500
    ? "网关处理失败，请稍后重试"
    : "操作未完成，请重新加载后重试");
  return new GatewayError(response.status,
    typeof fields.code === "string" ? fields.code : "http_error",
    typeof fields.message === "string" && fields.message.trim() ? fields.message : fallback,
    fields.details);
}

/** A later refusal cannot disprove an earlier create whose result is still unknown. */
export function createResultUnknown(error: unknown, previouslyUnknown = false): boolean {
  return previouslyUnknown || !(error && typeof error === "object" && "status" in error &&
    typeof error.status === "number" && error.status >= 400 && error.status < 500);
}

export type GatewayConfig = { baseUrl: string; token: string; computerId?: string };
export type ConnectionInfo = {
  device_id: string | null;
  computer_name: string;
  gateway_version: string;
  paired_at: string | null;
  pairing_method: "manual" | "qr" | "development";
  capabilities?: { fast_mode?: boolean };
};
export type PairingExchange = ConnectionInfo & { token: string; device_id: string };

/** Pairing and connection probes cannot pin the entry screen indefinitely, including while
 * reading a response body; abort settles even if the native transport ignores the signal. */
async function pairingDeadline<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new GatewayError(0, "cancelled", "配对已取消");
  const controller = new AbortController();
  let timedOut = false;
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => {
      controller.abort();
      reject(new GatewayError(0, timedOut ? "timeout" : "cancelled", timedOut ? "连接超时" : "配对已取消"));
    };
  });
  signal?.addEventListener("abort", interrupt, { once: true });
  const timeout = setTimeout(() => { timedOut = true; interrupt(); }, 15_000);
  try {
    return await Promise.race([run(controller.signal), interrupted]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", interrupt);
  }
}

/** Public one-use challenge exchange; never attach the current device's bearer token. */
export function exchangePairingCode(
  baseUrl: string, code: string, method: "manual" | "qr", signal?: AbortSignal, fetchImpl: Fetch = fetch,
): Promise<PairingExchange> {
  return pairingDeadline(signal, async (requestSignal) => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/pairing/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, method }),
        signal: requestSignal,
      });
    } catch {
      throw new GatewayError(0, "network", "连不上服务器");
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new GatewayError(response.status, payload?.error?.code ?? "http_error", "配对失败");
    if (!payload?.token || !payload?.device_id) throw new GatewayError(0, "invalid_response", "网关返回的配对信息不完整");
    return payload;
  });
}


type ThumbnailCacheEntry = {
  promise: Promise<LocalImageLease>;
  lease?: LocalImageLease;
  refs: number;
};

const EMPTY_FILE_PREVIEW: { preview: FilePreview | null; failed: boolean } = { preview: null, failed: false };

export class GatewayApi {
  readonly config: Readonly<GatewayConfig>;
  private readonly fetch: Fetch;
  private readonly onUnauthorized?: (reason: "invalid" | "revoked") => void;
  private readonly resetTransport?: () => void;
  private readonly lifetime = new AbortController();
  private confirmation: Promise<void> | null = null;
  /** Session-bound work must stop; accepted native downloads instead discard late cache results. */
  readonly signal: AbortSignal = this.lifetime.signal;
  /** Reconnect abandons only reads. Commands remain owned by the session lifetime. */
  private reads = new AbortController();
  private readonly readCancellationListeners = new Set<() => void>();
  private static readonly readDeadlineMs = 15_000;
  private resetGeneration = 0;
  private readonly filePreviewCache = new Map<string, {
    promise: Promise<FilePreview>; snapshot: { preview: FilePreview | null; failed: boolean }; listeners: Set<() => void>;
  }>();
  private readonly thumbnailCache = new Map<string, ThumbnailCacheEntry>();
  private static nextResourceIdentity = 0;
  /** Native/metadata access boundaries distinguish new APIs even when connection config is identical. */
  readonly resourceIdentity = ++GatewayApi.nextResourceIdentity;

  constructor(config: GatewayConfig, fetchImpl: Fetch = fetch, onUnauthorized?: (reason: "invalid" | "revoked") => void,
    resetConnections?: () => void) {
    this.config = Object.freeze({ ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") });
    // Browser fetch rejects a GatewayApi receiver; injected/native fetches use the same bare-call contract.
    this.fetch = (input, init) => fetchImpl(input, init);
    this.onUnauthorized = onUnauthorized;
    this.resetTransport = resetConnections;
  }

  close(): void {
    this.lifetime.abort();
    this.thumbnailCache.forEach((entry) => {
      if (entry.refs === 0) entry.lease?.dispose();
    });
    this.thumbnailCache.clear();
  }
  /** Reset the native transport and advance the session generation even when native cleanup fails. */
  resetConnections(): void {
    try {
      this.resetTransport?.();
    } finally {
      this.resetGeneration++;
    }
  }

  /** Query's session bridge cancels its retryers before snapshot transports abort, so recovery is not a read failure. */
  subscribeReadCancellation(listener: () => void): () => void {
    this.readCancellationListeners.add(listener);
    return () => this.readCancellationListeners.delete(listener);
  }

  /** Discard obsolete finite reads without interrupting commands or the SSE connection. */
  cancelReads(): void {
    const previous = this.reads;
    this.reads = new AbortController();
    for (const listener of this.readCancellationListeners) listener();
    previous.abort();
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.config.token}`, ...extra };
  }


  /** Abort and deadline settle JS even when native fetch or response.json ignores its signal. */
  private async withAbort<T>(
    caller: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>,
    deadline?: number, read?: AbortSignal, timeoutMessage = "操作结果未确认。请重新加载核对结果。",
  ): Promise<T> {
    if (this.signal.aborted || caller?.aborted || read?.aborted) throw new GatewayError(0, "cancelled", "连接已关闭");
    const controller = new AbortController();
    let rejectAbort!: (error: GatewayError) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => {
      controller.abort();
      rejectAbort(new GatewayError(0, "cancelled", "连接已关闭"));
    };
    const timeout = () => {
      controller.abort();
      rejectAbort(new GatewayError(0, "timeout", timeoutMessage));
    };
    this.signal.addEventListener("abort", abort, { once: true });
    caller?.addEventListener("abort", abort, { once: true });
    read?.addEventListener("abort", abort, { once: true });
    const timer = deadline === undefined ? undefined : setTimeout(timeout, deadline);
    try {
      return await Promise.race([run(controller.signal), interrupted]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.signal.removeEventListener("abort", abort);
      caller?.removeEventListener("abort", abort);
      read?.removeEventListener("abort", abort);
    }
  }

  private async fetchAuthorized(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetch(this.config.baseUrl + path, init);
    if (response.status === 401 && !init.signal?.aborted) this.handleUnauthorized();
    return response;
  }

  /** Keep cancellation attached through body consumption, not just response headers.
   * The callback owns reading; returning or throwing closes the underlying request. */
  consumeResponse<T>(path: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    return this.withAbort(init.signal ?? undefined, async (signal) =>
      consume(await this.fetchAuthorized(path, { ...init, signal })));
  }
  /** Authenticated binary content stays bound to this API until its body is fully consumed. */
  readBinary(path: string, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; contentType: string }> {
    return this.withAbort(signal, async (requestSignal) => {
      let response: Response;
      try {
        response = await this.fetchAuthorized(path, { headers: this.headers(), signal: requestSignal });
      } catch (error) {
        throw new GatewayError(0, "network", "连不上服务器，请检查网络和网关连接", undefined, { cause: error });
      }
      if (!response.ok) throw responseError(response, await response.json().catch(() => null));
      try {
        return { bytes: await response.arrayBuffer(), contentType: response.headers.get("Content-Type") ?? "application/octet-stream" };
      } catch (error) {
        throw new GatewayError(0, "invalid_response", "无法读取文件内容，请重试", undefined, { cause: error });
      }
    });
  }

  /** A request-level 401 is not revocation. Confirm the credential at the trusted
   * base URL without delaying the original failure or multiplying concurrent probes. */
  handleUnauthorized(): void {
    if (!this.signal.aborted) void this.checkUnauthorized();
  }

  /** Only an authenticated browser socket's 4401 explicitly proves revocation. */
  handleRevoked(): void {
    if (!this.signal.aborted) this.onUnauthorized?.("revoked");
  }

  /** Native transports may conceal their status. A bounded, non-recursive probe confirms
   * invalid credentials; timeout or unreachable gateway preserves the saved computer. */
  checkUnauthorized(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.signal.aborted) return Promise.resolve();
    if (this.confirmation) return this.confirmation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.signal.addEventListener("abort", abort, { once: true });
    const interrupted = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    const timeout = setTimeout(abort, 5000);
    const confirmation = (async () => {
      try {
        const response = await Promise.race([
          this.fetch(this.config.baseUrl + "/connection", { method: "GET", headers: this.headers(), signal: controller.signal }),
          interrupted,
        ]);
        if (response?.status === 401 && !controller.signal.aborted) this.onUnauthorized?.("invalid");
      } catch {
        // A failed verification is not evidence that the credential is invalid.
      }
    })().finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.signal.removeEventListener("abort", abort);
      controller.abort();
      if (this.confirmation === confirmation) this.confirmation = null;
    });
    // Page-scoped hidden-status probes can be cancelled on blur. A separate request-level
    // 401 must never inherit that cancellation; only lifetime probes are shared.
    if (!signal) this.confirmation = confirmation;
    return confirmation;
  }

  listAgents(): Promise<AgentListSnapshot> {
    return this.request("GET", "/agents", undefined, undefined, true);
  }

  listExecutionEnvironments(cursor?: string, signal?: AbortSignal): Promise<{ environments: ExecutionEnvironment[]; next_cursor: string | null }> {
    return this.request("GET", `/execution-environments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, undefined, signal);
  }

  /** 创建时 client_id 独立于定义字段；同一请求重试返回原结果。 */
  createAgent(clientId: string, fields: CreateAgentInput): Promise<{ agent: AgentDetail; event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", "/agents", { ...fields, client_id: clientId });
  }

  updateAgent(id: string, fields: Partial<AgentEditableFields>): Promise<{ agent: AgentDetail; event: GatewayEvent | null }> {
    return this.request("PATCH", `/agents/${encodeURIComponent(id)}`, fields);
  }

  deleteAgent(id: string): Promise<{ event: GatewayEvent }> {
    return this.request("DELETE", `/agents/${encodeURIComponent(id)}`);
  }
  getAgentCapabilities(id: string, signal?: AbortSignal): Promise<{ capabilities: AgentCapability[] }> {
    return this.request("GET", `/agents/${encodeURIComponent(id)}/capabilities`, undefined, signal);
  }
  listSchedules(agentId: string, signal?: AbortSignal): Promise<{ schedules: Schedule[]; default_timezone: string | null; as_of_seq: number }> {
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/schedules`, undefined, signal);
  }
  createSchedule(agentId: string, clientId: string, fields: Omit<ScheduleFields, "timezone" | "enabled"> & Partial<Pick<ScheduleFields, "timezone" | "enabled">>): Promise<{ schedule: Schedule; event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", `/agents/${encodeURIComponent(agentId)}/schedules`, { ...fields, client_id: clientId });
  }
  getSchedule(id: string, signal?: AbortSignal): Promise<Schedule> {
    return this.request("GET", `/schedules/${encodeURIComponent(id)}`, undefined, signal);
  }
  updateSchedule(id: string, fields: Partial<ScheduleFields>): Promise<{ schedule: Schedule; event: GatewayEvent | null }> {
    return this.request("PATCH", `/schedules/${encodeURIComponent(id)}`, fields);
  }
  deleteSchedule(id: string): Promise<{ event: GatewayEvent }> {
    return this.request("DELETE", `/schedules/${encodeURIComponent(id)}`);
  }
  scheduleRuns(id: string, before?: number, limit = 20, signal?: AbortSignal): Promise<{ runs: ScheduleRun[]; as_of_seq: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set("before", String(before));
    return this.request("GET", `/schedules/${encodeURIComponent(id)}/runs?${query}`, undefined, signal);
  }
  listConnectors(signal?: AbortSignal): Promise<{ connectors: Connector[]; as_of_seq: number }> {
    return this.request("GET", "/connectors", undefined, signal);
  }
  getConnector(id: string, signal?: AbortSignal): Promise<Connector> {
    return this.request("GET", `/connectors/${encodeURIComponent(id)}`, undefined, signal);
  }
  getConnectorCreationResult(clientId: string, signal?: AbortSignal): Promise<ConnectorCreationResult> {
    return this.request("GET", `/connectors/creation-result?client_id=${encodeURIComponent(clientId)}`, undefined, signal);
  }
  probeConnector(url: string, transport?: string): Promise<ConnectorProbe> {
    return this.request("POST", "/connectors/probe", { url, ...(transport ? { transport } : {}) });
  }
  connectorAgents(id: string, signal?: AbortSignal): Promise<{ agents: ConnectorAgent[]; as_of_seq: number }> {
    return this.request("GET", `/connectors/${encodeURIComponent(id)}/agents`, undefined, signal);
  }
  connectorTools(id: string, signal?: AbortSignal): Promise<ConnectorTools> {
    return this.request("GET", `/connectors/${encodeURIComponent(id)}/tools`, undefined, signal);
  }
  createConnector(clientId: string, fields: CreateConnectorInput): Promise<{ connector: Connector; event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", "/connectors", { ...fields, client_id: clientId });
  }
  updateConnector(id: string, fields: PatchConnectorInput): Promise<{ connector: Connector; event: GatewayEvent | null }> {
    return this.request("PATCH", `/connectors/${encodeURIComponent(id)}`, fields);
  }
  deleteConnector(id: string): Promise<{ event: GatewayEvent }> {
    return this.request("DELETE", `/connectors/${encodeURIComponent(id)}`);
  }
  testConnector(id: string): Promise<ConnectorTestResult> {
    return this.request("POST", `/connectors/${encodeURIComponent(id)}/test`);
  }
  listApps(signal?: AbortSignal): Promise<{ apps: AppEntry[] }> {
    return this.request("GET", "/apps", undefined, signal);
  }
  connectApp(id: string, clientId: string): Promise<{ connector: Connector }> {
    return this.request("POST", `/apps/${encodeURIComponent(id)}/connect`, { client_id: clientId });
  }
  startConnectorOAuth(id: string): Promise<OAuthStart> {
    return this.request("POST", `/connectors/${encodeURIComponent(id)}/oauth/start`, { return_url: "wandrun://oauth/done" });
  }
  completeConnectorOAuth(id: string, url: string): Promise<{ connector: Connector }> {
    return this.request("POST", `/connectors/${encodeURIComponent(id)}/oauth/callback`, { url });
  }
  cancelConnectorOAuth(id: string): Promise<{ connector: Connector }> {
    return this.request("DELETE", `/connectors/${encodeURIComponent(id)}/oauth/pending`);
  }
  revokeConnectorOAuth(id: string): Promise<{ connector: Connector; remote_revoked: boolean | null }> {
    return this.request("DELETE", `/connectors/${encodeURIComponent(id)}/oauth`);
  }
  clearConnectorKey(id: string): Promise<{ connector: Connector; event: GatewayEvent | null }> {
    return this.request("DELETE", `/connectors/${encodeURIComponent(id)}/key`);
  }


  /** A refresh asks the gateway to query upstream; it may still return its last good snapshot. */
  listModels(refresh = false, signal?: AbortSignal): Promise<ModelCatalog> {
    return this.request("GET", `/models${refresh ? "?refresh=true" : ""}`, undefined, signal);
  }
  getSettings(signal?: AbortSignal): Promise<ModelSettings> {
    return this.request("GET", "/settings", undefined, signal);
  }
  updateSettings(settings: ModelSettings): Promise<ModelSettings> {
    return this.request("PUT", "/settings", settings);
  }
  getSubscriptionUsage(refresh = false, signal?: AbortSignal): Promise<SubscriptionStatus> {
    return this.request("GET", `/usage/subscription${refresh ? "?refresh=true" : ""}`, undefined, signal).then(subscriptionStatus);
  }
  getAgentUsage(days = 7, signal?: AbortSignal): Promise<AgentUsageReport> {
    return this.request("GET", `/usage/agents?${new URLSearchParams({ days: String(days) })}`, undefined, signal);
  }

  listSkills(signal?: AbortSignal): Promise<{ skills: Skill[]; as_of_seq: number; default_agent_id: string | null }> {
    return this.request("GET", "/skills", undefined, signal);
  }
  getSkill(name: string, signal?: AbortSignal): Promise<SkillDetail> {
    return this.request("GET", `/skills/${encodeURIComponent(name)}`, undefined, signal);
  }
  /** Missing skills are idempotent and return event=null. */
  deleteSkill(name: string): Promise<{ event: GatewayEvent | null }> {
    return this.request("DELETE", `/skills/${encodeURIComponent(name)}`);
  }
  listBuiltinSkills(signal?: AbortSignal): Promise<{ skills: BuiltinSkill[] }> {
    return this.request("GET", "/builtin-skills", undefined, signal);
  }
  getBuiltinSkill(name: string, signal?: AbortSignal): Promise<BuiltinSkillDetail> {
    return this.request("GET", `/builtin-skills/${encodeURIComponent(name)}`, undefined, signal);
  }


  getAgent(id: string, signal?: AbortSignal): Promise<AgentDetail> {
    return this.request("GET", `/agents/${encodeURIComponent(id)}`, undefined, signal);
  }
  getMemory(scope: MemoryScope, id?: string, signal?: AbortSignal): Promise<AgentMemory> {
    return this.request("GET", memoryEndpoint(scope, id), undefined, signal);
  }
  /** A save always uses the document version, including changes to individual details. */
  updateMemory(scope: MemoryScope, id: string | undefined, content: string, version: string): Promise<AgentMemory> {
    return this.request("PUT", memoryEndpoint(scope, id), { content, version });
  }
  getMemoryDetail(scope: MemoryScope, id: string | undefined, slug: string, signal?: AbortSignal): Promise<MemoryDetail> {
    return this.request("GET", `${memoryEndpoint(scope, id)}/details/${encodeURIComponent(slug)}`, undefined, signal);
  }
  updateMemoryDetail(scope: MemoryScope, id: string | undefined, slug: string, content: string, version: string, indexContent?: string): Promise<AgentMemory> {
    return this.request("PUT", `${memoryEndpoint(scope, id)}/details/${encodeURIComponent(slug)}`,
      { content, version, ...(indexContent === undefined ? {} : { index_content: indexContent }) });
  }
  deleteMemoryDetail(scope: MemoryScope, id: string | undefined, slug: string, content: string, version: string): Promise<AgentMemory> {
    return this.request("DELETE", `${memoryEndpoint(scope, id)}/details/${encodeURIComponent(slug)}`, { content, version });
  }


  getFile(id: string, signal?: AbortSignal): Promise<FileDetail> {
    return this.request("GET", `/files/${encodeURIComponent(id)}`, undefined, signal);
  }
  getFilePreview(id: string): Promise<FilePreview> {
    const key = encodeURIComponent(id);
    const cached = this.filePreviewCache.get(key);
    if (cached) return cached.promise;
    const promise = this.request("GET", `/files/${key}/preview`) as Promise<FilePreview>;
    const entry = { promise, snapshot: EMPTY_FILE_PREVIEW, listeners: new Set<() => void>() };
    this.filePreviewCache.set(key, entry);
    void promise.then(preview => {
      if (this.signal.aborted) return;
      entry.snapshot = { preview, failed: false };
      entry.listeners.forEach(listener => listener());
    }, () => {
      if (this.signal.aborted) return;
      entry.snapshot = { preview: null, failed: true };
      entry.listeners.forEach(listener => listener());
    });
    return promise;
  }

  filePreviewSnapshot(id: string): { preview: FilePreview | null; failed: boolean } {
    return this.filePreviewCache.get(encodeURIComponent(id))?.snapshot ?? EMPTY_FILE_PREVIEW;
  }

  subscribeFilePreview(id: string, listener: () => void): () => void {
    void this.getFilePreview(id).catch(() => {});
    const entry = this.filePreviewCache.get(encodeURIComponent(id))!;
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  fileThumbnailPath(id: string, width: FileThumbnailWidth): string {
    return `/files/${encodeURIComponent(id)}/thumbnail?w=${width}`;
  }

  /** A retry retires exactly this entry; existing viewers keep their lease until they release it. */
  invalidateFileThumbnail(id: string, width: FileThumbnailWidth): void {
    const key = `${id}:${width}`;
    const entry = this.thumbnailCache.get(key);
    if (!entry) return;
    this.thumbnailCache.delete(key);
    if (entry.refs === 0) entry.lease?.dispose();
  }

  /** Share a downloaded thumbnail within this API; callers release their own reference. */
  async loadFileThumbnail(id: string, width: FileThumbnailWidth, signal?: AbortSignal): Promise<LocalImageLease> {
    if (this.signal.aborted || signal?.aborted) throw new GatewayError(0, "cancelled", "连接已关闭");
    const key = `${id}:${width}`;
    let entry = this.thumbnailCache.get(key);
    if (!entry) {
      // Install before the lazy native import so simultaneous viewers share one download.
      const created: ThumbnailCacheEntry = {
        refs: 0,
        promise: import("../lib/local-image.ts")
          .then(({ loadLocalImage }) => loadLocalImage(this, this.fileThumbnailPath(id, width), this.signal))
          .then((lease) => {
            created.lease = lease;
            if (created.refs === 0 && this.thumbnailCache.get(key) !== created) lease.dispose();
            return lease;
          }).catch((cause) => {
            if (this.thumbnailCache.get(key) === created) this.thumbnailCache.delete(key);
            throw cause;
          }),
      };
      entry = created;
      this.thumbnailCache.set(key, entry);
    }
    const held = entry;
    held.refs++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs === 0 && this.thumbnailCache.get(key) !== held) held.lease?.dispose();
    };
    try {
      const lease = await this.withAbort(signal, () => held.promise);
      return { uri: lease.uri, dispose: release };
    } catch (cause) {
      release();
      throw cause;
    }
  }


  fileContentUrl(id: string, download = false): string {
    return `${this.config.baseUrl}/files/${encodeURIComponent(id)}/content${download ? "?download=true" : ""}`;
  }

  /** Resource identity is a persisted message position, never a client-supplied source URL. */
  mediaPath(conversationId: string, seq: number, block: number | "markdown", element: string, index: number): string {
    return `/conversations/${encodeURIComponent(conversationId)}/messages/${seq}/media/${block}/${encodeURIComponent(element)}/${index}`;
  }

  mediaContentPath(conversationId: string, seq: number, block: number | "markdown", element: string, index: number): string {
    return `${this.mediaPath(conversationId, seq, block, element, index)}/content`;
  }

  getMessageMedia(conversationId: string, seq: number, block: number | "markdown", element: string, index: number): Promise<{ mime: string; width: number; height: number }> {
    return this.request("GET", this.mediaPath(conversationId, seq, block, element, index));
  }

  search(q: string, agentId?: string, limit = 30, offset = 0, signal?: AbortSignal): Promise<{ results: SearchResult[]; total: number; as_of_seq: number }> {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    if (agentId !== undefined) params.set("agent_id", agentId);
    return this.request("GET", `/search?${params}`, undefined, signal);
  }

  computer(signal?: AbortSignal): Promise<ComputerStatus> {
    return this.request("GET", "/computer", undefined, signal);
  }
  connection(signal?: AbortSignal): Promise<ConnectionInfo> {
    return pairingDeadline(signal, (requestSignal) => this.request("GET", "/connection", undefined, requestSignal));
  }
  revokeCurrent(signal?: AbortSignal): Promise<void> {
    return pairingDeadline(signal, (requestSignal) => this.request("DELETE", "/devices/current", undefined, requestSignal));
  }
  listBrowserTasks(entryAgentId?: string): Promise<{ browser_tasks: BrowserTask[]; as_of_seq: number }> {
    const query = entryAgentId === undefined ? "" : `?${new URLSearchParams({ entry_agent_id: entryAgentId })}`;
    return this.request("GET", `/browser-tasks${query}`, undefined, undefined, true);
  }
  browserTask(id: string, signal?: AbortSignal): Promise<BrowserTask> {
    return this.request("GET", `/browser-tasks/${encodeURIComponent(id)}`, undefined, signal);
  }
  takeoverBrowser(id: string, clientId: string): Promise<{ browser_task: BrowserTask; replayed: boolean }> {
    return this.request("POST", `/browser-tasks/${encodeURIComponent(id)}/takeover`, { client_id: clientId });
  }
  handbackBrowser(id: string, clientId: string): Promise<{ browser_task: BrowserTask; replayed: boolean }> {
    return this.request("POST", `/browser-tasks/${encodeURIComponent(id)}/handback`, { client_id: clientId });
  }
  closeBrowser(id: string): Promise<{ browser_task: BrowserTask }> {
    return this.request("DELETE", `/browser-tasks/${encodeURIComponent(id)}`);
  }
  closeBrowserPage(id: string, page: string): Promise<{ browser_task: BrowserTask }> {
    return this.request("DELETE", `/browser-tasks/${encodeURIComponent(id)}/pages/${encodeURIComponent(page)}`);
  }
  browserThumbnailPath(id: string, page?: string): string {
    const query = page === undefined ? "" : `?${new URLSearchParams({ page })}`;
    return `/browser-tasks/${encodeURIComponent(id)}/thumbnail${query}`;
  }
  browserThumbnailUrl(id: string, page?: string): string {
    return `${this.config.baseUrl}${this.browserThumbnailPath(id, page)}`;
  }
  browserStreamUrl(id: string, mode: "view" | "control"): string {
    return `${this.config.baseUrl.replace(/^http/, "ws")}/browser-tasks/${encodeURIComponent(id)}/stream?mode=${mode}`;
  }

  /** agentId 为空时不过滤；不存在的 Agent 网关返回 404。 */
  listConversations(agentId?: string): Promise<{ conversations: Conversation[]; as_of_seq: number }> {
    const query = agentId === undefined ? "" : `?${new URLSearchParams({ agent_id: agentId })}`;
    return this.request("GET", `/conversations${query}`, undefined, undefined, true);
  }

  receivedConversations(agentId: string): Promise<{ conversations: ReceivedConversation[]; as_of_seq: number }> {
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/conversations`, undefined, undefined, true);
  }

  collaborations(agentId: string): Promise<{ conversations: TaskConversation[]; as_of_seq: number }> {
    return this.request("GET", `/agents/${encodeURIComponent(agentId)}/collaborations`, undefined, undefined, true);
  }

  task(id: string): Promise<TaskConversation> {
    return this.request("GET", `/tasks/${encodeURIComponent(id)}`);
  }

  taskHistory(id: string, before?: number, limit = 50): Promise<{ events: GatewayEvent[]; as_of_seq: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set("before", String(before));
    return this.request("GET", `/tasks/${encodeURIComponent(id)}/events?${query}`);
  }

  /** Task input is text-only. unavailable/stopped are explicit 409 refusals, not retryable transport errors. */
  sendTaskMessage(id: string, clientId: string, text: string): Promise<{ event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/messages`, { client_id: clientId, text }, undefined, false, 15_000);
  }

  stopTask(id: string, clientId: string): Promise<{ event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/stop`, { client_id: clientId });
  }

  markTaskRead(id: string, seq: number): Promise<void> {
    return this.request("POST", `/tasks/${encodeURIComponent(id)}/read`, { seq });
  }

  /** Same clientId + parameters safely retry one creation; the gateway retains its first receipt. */
  createConversation(agentId: string, title: string | undefined, clientId: string): Promise<Conversation> {
    return this.request("POST", "/conversations", { agent_id: agentId, client_id: clientId, ...(title ? { title } : {}) }, undefined, false, 15_000);
  }
  /** 同一标题返回 event=null；不带 client_id，重试按资源当前标题自然幂等。 */
  renameConversation(id: string, title: string): Promise<{ conversation: Conversation; event: GatewayEvent | null }> {
    return this.request("PATCH", `/conversations/${encodeURIComponent(id)}`, { title });
  }

  /** 删除按资源幂等：已删除资源重放原事件，不发送请求体。 */
  deleteConversation(id: string): Promise<{ event: GatewayEvent }> {
    return this.request("DELETE", `/conversations/${encodeURIComponent(id)}`, undefined, undefined, false, 35_000);
  }


  history(id: string, before?: number, limit = 50): Promise<{ events: GatewayEvent[]; as_of_seq: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set("before", String(before));
    return this.request("GET", `/conversations/${id}/events?${query}`);
  }

  /** 同一 client_id 的重试返回第一次的事件（replayed=true），网关不会再执行一次。 */
  sendMessage(id: string, clientId: string, text: string, attachments: string[] = []): Promise<{ event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", `/conversations/${id}/messages`, { client_id: clientId, text, attachments }, undefined, false, 15_000);
  }

  /** The gateway returns the persisted user message; callers merge it like an ordinary send response. */
  submitUi(id: string, clientId: string, messageSeq: number, block: number, values: Record<string, unknown>, actionId?: string): Promise<{ event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", `/conversations/${encodeURIComponent(id)}/ui-submissions`, {
      client_id: clientId, message_seq: messageSeq, block, values, ...(actionId ? { action_id: actionId } : {}),
    });
  }

  /** Read only: absence permits retrying the same operation, never selecting a different action. */
  uiSubmissionResult(id: string, messageSeq: number, block: number): Promise<{ event: GatewayEvent | null }> {
    return this.request("GET", `/conversations/${encodeURIComponent(id)}/ui-submissions?message_seq=${messageSeq}&block=${block}`);
  }

  stop(id: string, clientId: string): Promise<{ event: GatewayEvent; replayed: boolean }> {
    return this.request("POST", `/conversations/${id}/stop`, { client_id: clientId });
  }

  markRead(id: string, seq: number): Promise<void> {
    return this.request("POST", `/conversations/${id}/read`, { seq });
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal, snapshot = false, deadline?: number): Promise<any> {
    const read = snapshot ? this.reads.signal : undefined;
    const commandGeneration = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? this.resetGeneration : undefined;
    return this.withAbort(signal, async (requestSignal) => {
      let response: Response;
      try {
        response = await this.fetchAuthorized(path, {
          method,
          headers: this.headers(body === undefined ? {} : { "Content-Type": "application/json" }),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: requestSignal,
        });
      } catch (error) {
        if (commandGeneration !== undefined && commandGeneration !== this.resetGeneration) {
          throw new GatewayError(0, "timeout", "操作结果未确认。请重新加载核对结果。", undefined, { cause: error });
        }
        throw new GatewayError(0, "network", "连不上服务器，请检查网络和网关连接", undefined, { cause: error });
      }
      if (response.status === 204) return undefined;
      // A successful status may already have committed a command; unreadable JSON is not an HTTP rejection.
      const payload = await response.json().catch(() => {
        if (response.ok) throw new GatewayError(0, "invalid_response", "无法读取网关响应，操作结果未确认。请重试当前操作或重新加载核对结果。");
        return null;
      });
      if (!response.ok) throw responseError(response, payload);
      return payload;
    }, method === "GET" ? GatewayApi.readDeadlineMs : deadline, read, method === "GET" ? "读取超时，请重试" : undefined);
  }
}
