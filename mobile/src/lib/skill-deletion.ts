import { createResultUnknown, GatewayError, type SkillDetail } from "../gateway/api.ts";
import type { ChatSession } from "../gateway/session.ts";
import { LoadResource } from "./load-state.ts";
import { readSkillDeletionConstraints } from "./gateway-queries.ts";
import { skillDeletionUsers } from "./skills.ts";
import { userErrorMessage } from "./user-error.ts";

export type SkillDeletionState = {
  phase: "idle" | "checking" | "confirm" | "blocked" | "deleting" | "unknown" | "deleted";
  users: SkillDetail["used_by"];
  error: string;
};

/** One session owns an uncertain DELETE across navigation. Only GET is retried; never DELETE.
 * A subsequent snapshot reports current existence, not a guarantee about external file edits.
 */
export class SkillDeletion {
  private state: SkillDeletionState = { phase: "idle", users: [], error: "" };
  private listeners = new Set<() => void>();
  private visit = 0;
  private check: LoadResource<SkillDetail | null>;
  private readonly unsubscribe: () => void;
  private readonly session: ChatSession;
  private readonly name: string;
  constructor(session: ChatSession, name: string) {
    this.session = session; this.name = name;
    this.check = this.createCheck();
    this.unsubscribe = session.subscribe(() => {
      if (session.connection === "stopped") { this.check.stop(); this.unsubscribe(); }
      else if (session.connection === "open" && this.state.phase === "unknown") this.check.start();
    });
  }
  private createCheck() {
    const { session, name } = this;
    const check = new LoadResource(async () => {
      try { return await session.api.getSkill(name); }
      catch (error) { if (error instanceof GatewayError && error.status === 404) return null; throw error; }
    });
    check.subscribe(() => {
      const snapshot = check.getSnapshot();
      if (snapshot.status !== "ready" || this.state.phase !== "unknown") return;
      check.stop();
      if (snapshot.data === null) {
        this.publish({ phase: "deleted", users: [], error: "技能已删除" });
        session.skillChanged(null);
      } else {
        this.publish({ phase: "idle", users: [], error: "已核对，技能仍存在；如需删除，请再次确认。" });
        session.skillChanged(null);
      }
    });
    return check;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: SkillDeletionState) {
    this.state = state;
    this.listeners.forEach(listener => listener());
    sessionListeners.get(this.session)?.forEach(listener => listener());
  }
  /** design.md 提醒规则：结果提示可关闭；结果未确认（unknown）核对前不可关闭。 */
  dismiss = () => { if (this.state.error && (this.state.phase === "deleted" || this.state.phase === "idle")) this.publish({ ...this.state, error: "" }); };
  cancel = () => { if (["confirm", "blocked"].includes(this.state.phase)) this.publish({ phase: "idle", users: [], error: "" }); };
  /** Leaving cancels only the read-only preflight/dialog, not a DELETE already sent. */
  leave = () => {
    this.visit++;
    if (["checking", "confirm", "blocked"].includes(this.state.phase)) this.publish({ phase: "idle", users: [], error: "" });
  };
  preflight = async () => {
    if (this.session.connection !== "open" || !["idle", "deleted"].includes(this.state.phase)) return;
    const visit = this.visit;
    this.publish({ phase: "checking", users: [], error: "" });
    try {
      const detail = await readSkillDeletionConstraints(this.session, this.name);
      if (visit !== this.visit) return;
      this.publish({ phase: detail.used_by.length ? "blocked" : "confirm", users: detail.used_by, error: "" });
    } catch (error) {
      if (visit !== this.visit) return;
      if (error instanceof GatewayError && error.status === 404) this.publish({ phase: "deleted", users: [], error: "" });
      else this.publish({ phase: "idle", users: [], error: userErrorMessage(error, "无法检查删除条件") });
    }
  };
  remove = async () => {
    if (this.state.phase !== "confirm" || this.session.connection !== "open") return;
    const visit = this.visit;
    this.publish({ ...this.state, phase: "deleting", error: "" });
    try {
      const { event } = await this.session.api.deleteSkill(this.name);
      this.publish({ phase: "deleted", users: [], error: "" });
      this.session.skillChanged(event);
    } catch (error) {
      if (error instanceof GatewayError && error.status === 409) this.publish({ phase: visit === this.visit ? "blocked" : "idle", users: skillDeletionUsers(error.details), error: visit === this.visit ? "" : "技能仍被 Agent 使用，未删除。" });
      else if (createResultUnknown(error)) {
        this.check.stop();
        this.check = this.createCheck();
        this.publish({ phase: "unknown", users: [], error: "删除结果未确认；可以离开，恢复连接后会自动核对。" });
        if (this.session.connection === "open") this.check.start();
        this.session.skillChanged(null);
      } else this.publish({ phase: visit === this.visit ? "confirm" : "idle", users: [], error: userErrorMessage(error, "无法删除技能") });
    }
  };
}
const operations = new WeakMap<ChatSession, Map<string, SkillDeletion>>();
const sessionListeners = new WeakMap<ChatSession, Set<() => void>>();
/** Any deletion of this session changed; lets the list follow results completed off-screen. */
export function subscribeSkillDeletions(session: ChatSession, listener: () => void): () => void {
  let listeners = sessionListeners.get(session);
  if (!listeners) { listeners = new Set(); sessionListeners.set(session, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function skillDeletion(session: ChatSession, name: string): SkillDeletion {
  let byName = operations.get(session);
  if (!byName) { byName = new Map(); operations.set(session, byName); }
  let operation = byName.get(name);
  if (!operation) { operation = new SkillDeletion(session, name); byName.set(name, operation); }
  return operation;
}

function noticeOperation(session: ChatSession): SkillDeletion | undefined {
  const all = [...(operations.get(session)?.values() ?? [])];
  return all.find(operation => operation.snapshot().phase === "unknown")
    ?? all.find(operation => { const state = operation.snapshot(); return !!state.error && (state.phase === "deleted" || state.phase === "idle"); });
}
/** The list's single deletion notice: an immutable state snapshot (stable for useSyncExternalStore), or null. */
export function skillDeletionNotice(session: ChatSession): SkillDeletionState | null {
  return noticeOperation(session)?.snapshot() ?? null;
}
export function dismissSkillDeletionNotice(session: ChatSession): void { noticeOperation(session)?.dismiss(); }
