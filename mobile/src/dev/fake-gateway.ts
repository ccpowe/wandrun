import type { Fetch, GatewayEvent } from '../gateway/api.ts';
import type { Context, GatewayState } from './fake-gateway/types.ts';
import { routes, unsupportedGatewayRoutes } from './fake-gateway/routes.ts';
import { unhandled } from './fake-gateway/strict.ts';

export type { GatewayState } from './fake-gateway/types.ts';
export { jsonResponse, unavailable } from './fake-gateway/response.ts';
export { unsupportedGatewayRoutes } from './fake-gateway/routes.ts';
/** Overrides model only deliberate peer faults, delays or races; undefined continues the shared handler. */
export type GatewayOverrides = Partial<Record<GatewayRoute, (context: Context, respond: () => Promise<Response>) => Response | void | Promise<Response | void>>>;
export { assertNoUnhandledGatewayRequests } from './fake-gateway/strict.ts';

export type GatewayRoute = keyof typeof routes;
export const gatewayRoutes: readonly GatewayRoute[] = Object.keys(routes) as GatewayRoute[];

const compiled = [
  ...gatewayRoutes.map(key => ({ key, supported: true as const })),
  ...Object.keys(unsupportedGatewayRoutes).map(key => ({ key, supported: false as const })),
].map(route => {
  const [method, path] = route.key.split(' ');
  const parts = path.split('/');
  return { ...route, method, parts, specificity: parts.filter(part => !part.startsWith(':')).length };
}).sort((a, b) => b.specificity - a.specificity);

export class FakeGateway {
  readonly state: GatewayState;
  readonly overrides: GatewayOverrides;
  private streams = new Set<{ send(text: string): void; end(): void }>();
  constructor(state: Partial<GatewayState> = {}, overrides: GatewayOverrides = {}) {
    this.state = {
      seq: 1, orderRevision: 1, agents: [], agentDetails: new Map(), conversations: [], conversationCreations: new Map(),
      tasks: [], histories: new Map(), browserTasks: [], connectors: [], memories: new Map(), memoryBodies: new Map(), filePreviews: new Map(), messageMedia: new Map(),
      connectorTools: new Map(),
      schedules: [], scheduleNextRuns: {}, scheduleRuns: new Map(),
      capabilities: new Map(), skills: [], builtinSkills: [], files: new Map(), fileBytes: new Map(), uploads: new Map(),
      subscription: { auth: { status: 'login_required', reason: null, checked_at: 1, codex_home: '/fixture/codex', login_command: 'codex login' }, usage: null },
      usage: { days: 7, agents: [] },
      models: { models: [{ id: 'offline', display_name: 'Storybook model', description: '', default_reasoning_effort: null, supported_reasoning_efforts: [] }], fetched_at: 1, capabilities: { fast_mode: true } },
      settings: { default_model: 'offline', default_reasoning_effort: null },
      connection: { device_id: null, computer_name: 'fixture-host', gateway_version: 'test-version', paired_at: null, pairing_method: 'development' },
      apps: [],
      environments: [{ id: 'local', name: 'Local', type: 'local', status: null }],
      ...state,
    };
    this.overrides = overrides;
  }
  /** Resolve the most-specific complete path before its method; static resource paths win over parameters. */
  readonly fetch: Fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const parts = url.pathname.split('/');
    const matches = compiled.filter(route => route.parts.length === parts.length && route.parts.every((part, index) => part.startsWith(':') ? parts[index].length > 0 : part === parts[index]));
    const route = matches.find(candidate => candidate.specificity === matches[0]?.specificity && candidate.method === method);
    if (!route || !route.supported) return unhandled(method, url.pathname, route ? unsupportedGatewayRoutes[route.key] : undefined);
    const params = Object.fromEntries(route.parts.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1), decodeURIComponent(parts[index])]] : []));
    const context: Context = { gateway: this, url, init, params, body: init.body instanceof Uint8Array ? init.body : init.body ? JSON.parse(String(init.body)) : {} };
    const respond = async () => routes[route.key](context);
    return await this.overrides[route.key]?.(context, respond) ?? respond();
  };
  event(type: string, data: GatewayEvent['data'], conversationId?: string): GatewayEvent {
    return { seq: ++this.state.seq, type, at: Date.now() / 1000, ...(conversationId ? { conversation_id: conversationId } : {}), data };
  }
  emit(event: GatewayEvent): void {
    for (const stream of this.streams) stream.send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  disconnect(): void { for (const stream of this.streams) stream.end(); }
  /** React Native Response has no streaming body; supply only the fetch reader boundary. */
  openStream(signal?: AbortSignal | null): Response {
    const queue = [new TextEncoder().encode(': heartbeat\n\n')];
    let next: ((value: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    let ended = false;
    const stream = {
      send(text: string) {
        const value = new TextEncoder().encode(text);
        if (next) { const resolve = next; next = undefined; resolve({ done: false, value }); } else queue.push(value);
      },
      end: () => { ended = true; clearInterval(heartbeat); next?.({ done: true, value: undefined }); next = undefined; this.streams.delete(stream); signal?.removeEventListener('abort', stream.end); },
    };
    const heartbeat = setInterval(() => stream.send(': heartbeat\n\n'), 10_000);
    this.streams.add(stream);
    signal?.addEventListener('abort', stream.end, { once: true });
    if (signal?.aborted) stream.end();
    return { ok: true, status: 200, body: { getReader: () => ({
      read: () => {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift()! });
        if (ended) return Promise.resolve({ done: true, value: undefined });
        const pending = Promise.withResolvers<ReadableStreamReadResult<Uint8Array>>();
        next = pending.resolve;
        return pending.promise;
      }, cancel: async () => stream.end(),
    }), cancel: async () => stream.end() } } as Response;
  }
}
