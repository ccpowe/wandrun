import type { GatewayEvent } from '../gateway/api.ts';

export type CleanupResultKind = 'delete-agent' | 'delete-conversation' | 'switch';
export type CleanupResult = Readonly<{ operationId: string; seq: number; kind: CleanupResultKind }>;
type NavigationSource = {
  getState(): { index: number; routes: readonly { key: string; name: string }[] } | undefined;
  addListener(type: 'state', listener: () => void): () => void;
};
type Attempt = {
  operationId: string; kind: CleanupResultKind; id: string; current(): boolean;
  source: string; destination?: { key: string; intermediate: boolean }; result?: CleanupResult;
};
const landingRoutes: Record<string, true | undefined> = { index: true, chat: true, agents: true, 'agents/[id]': true };

/** Only a current device command can hand a result to its actual navigation destination.
 * No persisted queue, event-replay subscriber, root UI, or remote cleanup state lives here. */
export class CleanupResults {
  private attempt: Attempt | null = null;
  private stopNavigation?: () => void;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  begin(operationId: string, kind: CleanupResultKind, id: string, current: () => boolean, navigation: NavigationSource, sameVisit = false): void {
    this.clear();
    const state = navigation.getState();
    const source = state?.routes[state.index]?.key;
    if (!source) return;
    const attempt: Attempt = { operationId, kind, id, current, source,
      destination: sameVisit ? { key: source, intermediate: false } : undefined };
    this.attempt = attempt;
    this.stopNavigation = navigation.addListener('state', () => {
      if (this.attempt !== attempt) return;
      const state = navigation.getState();
      const route = state?.routes[state.index];
      if (!route) { this.clear(); return; }
      if (route.key === source && !attempt.destination) return;
      // Leaving before a receipt abandons this visit's presentation, never the write.
      if (!attempt.result || !landingRoutes[route.name]
        || attempt.destination && !attempt.destination.intermediate && attempt.destination.key !== route.key) { this.clear(); return; }
      attempt.destination = { key: route.key, intermediate: route.name === 'index' };
      this.changed();
    });
  }
  confirm(operationId: string, event: GatewayEvent | null | undefined): void {
    const attempt = this.attempt;
    if (!attempt || attempt.operationId !== operationId || attempt.result) return;
    if (!attempt.current()) { this.clear(); return; }
    if (!event || !Array.isArray(event.data.cleanup_unconfirmed) || !event.data.cleanup_unconfirmed.length) { this.clear(); return; }
    attempt.result = { operationId, seq: event.seq, kind: attempt.kind };
    this.changed();
  }
  /** A canonical deletion receipt is also authoritative when its HTTP response is lost. */
  observeDeletion(event: GatewayEvent): void {
    const attempt = this.attempt;
    if (!attempt || attempt.kind === 'switch') return;
    const matches = attempt.kind === 'delete-conversation'
      ? event.type === 'conversation.deleted' && event.data.id === attempt.id
      : event.type === 'resource.changed' && event.data.kind === 'agent' && event.data.op === 'deleted' && event.data.id === attempt.id;
    if (matches) this.confirm(attempt.operationId, event);
  }
  /** A definite rejection cannot be confirmed by a later unrelated same-resource deletion. */
  reject(operationId: string): void {
    if (this.attempt?.operationId === operationId && !this.attempt.result) this.clear();
  }
  claim(routeKey: string): CleanupResult | null {
    const attempt = this.attempt;
    if (!attempt?.result || attempt.destination?.key !== routeKey) return null;
    const result = attempt.result;
    this.clear();
    return result;
  }
  clear(): void { this.stopNavigation?.(); this.stopNavigation = undefined; this.attempt = null; }
  close(): void { this.clear(); this.listeners.clear(); }
}

export function cleanupResultMessage(kind: CleanupResultKind): string {
  return kind === 'switch' ? '执行环境已切换；旧环境可能残留目录或进程。'
    : '已删除；远端未能清理，可能残留目录或进程。可让 Agent 连上后自行清理，或销毁沙箱。';
}
