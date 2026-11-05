import { infiniteQueryOptions, isCancelledError, QueryClient, queryOptions } from '@tanstack/react-query';
import { GatewayError, type GatewayApi, type MemoryScope, type SubscriptionStatus } from '../gateway/api.ts';
import type { ChatSession } from '../gateway/session.ts';
import { retryDelay } from './load-state.ts';
import { mergeSubscriptionStatus } from './model-usage.ts';
import { assertNotAborted } from './abort.ts';

/** Finite GET policy only. Session projections, commands and unknown-write reconciliation stay outside Query. */
export function createGatewayQueryClient() {
  return new QueryClient({ defaultOptions: { queries: {
    retry: (_count, error) => !(error instanceof GatewayError && [400, 401, 403, 404, 405, 410, 422].includes(error.status)),
    retryDelay,
    staleTime: 0,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    networkMode: 'online',
  } } });
}
export const gatewayQueryClient = createGatewayQueryClient();
export const sessionQueryKey = (session: ChatSession) => {
  if (!bridges.has(session)) throw new Error('Session holder must attachSessionQueries before publishing a query consumer');
  return [session.queryIdentity] as const;
};
export function connectionOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...sessionQueryKey(session), 'connection'],
    queryFn: ({ signal }) => session.api.connection(signal), staleTime: 0, gcTime: Infinity });
}
const connectorPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'connectors'] as const;
const agentPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'agent-details'] as const;
const capabilityPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'agent-capabilities'] as const;
const skillPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'skills'] as const;
const settingsPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'settings'] as const;
const computerPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'computer'] as const;
export function computerStatusOptions(session: ChatSession) {
  return queryOptions({ queryKey: computerPrefix(session),
    queryFn: ({ signal }) => session.api.computer(signal), refetchInterval: 30_000, staleTime: 0, gcTime: Infinity });
}

export function settingsOptions(session: ChatSession) {
  return queryOptions({ queryKey: settingsPrefix(session),
    queryFn: ({ signal }) => session.api.getSettings(signal), staleTime: 0, gcTime: Infinity });
}
export function modelCatalogOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...sessionQueryKey(session), 'models'],
    queryFn: ({ signal }) => session.api.listModels(true, signal), staleTime: 0, gcTime: Infinity });
}
export function subscriptionOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...sessionQueryKey(session), 'subscription'],
    queryFn: ({ signal }) => session.api.getSubscriptionUsage(true, signal), staleTime: 0, gcTime: Infinity,
    structuralSharing: (previous, next) => mergeSubscriptionStatus(previous as SubscriptionStatus | undefined, next as SubscriptionStatus) });
}
export function agentUsageOptions(session: ChatSession, days = 7) {
  return queryOptions({ queryKey: [...sessionQueryKey(session), 'agent-usage', days],
    queryFn: ({ signal }) => session.api.getAgentUsage(days, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
export function executionEnvironmentOptions(session: ChatSession) {
  return { ...infiniteQueryOptions({ queryKey: [...sessionQueryKey(session), 'execution-environments'],
    queryFn: ({ signal, pageParam }) => session.api.listExecutionEnvironments(pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last, _pages, _lastParam, params) => last.next_cursor && !params.includes(last.next_cursor) ? last.next_cursor : undefined,
    staleTime: 0, gcTime: Infinity }), fetchAllPages: true };
}

/** Search retains pages for the mounted route, including detail visits; unmount reclaims its high-cardinality key. */
export function searchOptions(session: ChatSession, search: string, agentId?: string) {
  return infiniteQueryOptions({
    queryKey: [...sessionQueryKey(session), 'search', agentId ?? null, search],
    initialPageParam: 0,
    queryFn: async ({ signal, pageParam }) => {
      if (pageParam === 0) {
        assertNotAborted(signal);
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const abort = () => {
          clearTimeout(timer);
          try { assertNotAborted(signal); } catch (error) { reject(error); }
        };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 250);
        signal.addEventListener('abort', abort, { once: true });
        await promise;
      }
      return session.api.search(search, agentId, 30, pageParam, signal);
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((count, page) => count + page.results.length, 0);
      return last.results.length && loaded < last.total ? loaded : undefined;
    },
    retry: false, staleTime: 0, gcTime: 0,
    subscribed: true, refetchOnWindowFocus: false, networkMode: 'always',
  });
}
const schedulePrefix = (session: ChatSession) => [...sessionQueryKey(session), 'schedules'] as const;
const memoryPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'memory'] as const;
const filePrefix = (session: ChatSession) => [...sessionQueryKey(session), 'files'] as const;
const fileSessions = new WeakMap<GatewayApi, ChatSession>();

/** High-cardinality file identities are retained for at most five minutes without observers. */
export function fileDetailOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...filePrefix(session), id],
    queryFn: ({ signal }) => session.api.getFile(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}

/** Native delivery requires a fresh availability check; it shares the detail key without automatic command retries. */
export async function readFileForDelivery(api: GatewayApi, id: string) {
  const session = fileSessions.get(api);
  if (!session || api.signal.aborted) throw new Error('Native file delivery requires an active session query owner');
  const options = fileDetailOptions(session, id);
  const client = bridges.get(session)!;
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery({ ...options, staleTime: 0, retry: false, networkMode: 'always' });
}

const browserPrefix = (session: ChatSession) => [...sessionQueryKey(session), 'browser-details'] as const;

/** Watermarked browser list remains session-owned; bounded detail fallback is a finite GET. */
export function browserTaskOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...browserPrefix(session), id],
    queryFn: ({ signal }) => session.api.browserTask(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}

/** Profile has one identity regardless of the Agent route from which it is reached. */
export function memoryIndexOptions(session: ChatSession, scope: MemoryScope, id: string) {
  const resourceId = scope === 'profile' ? 'profile' : id;
  return queryOptions({
    queryKey: [...memoryPrefix(session), scope, resourceId, 'index'],
    queryFn: ({ signal }) => session.api.getMemory(scope, resourceId, signal), staleTime: 0, gcTime: 5 * 60_000,
    meta: { memoryRevision: session.memoryRevisionFor(scope, resourceId), memoryConnection: session.memoryConnectionRevision },
  });
}

/** The index remains in its own key. A detail never publishes a mismatched document version. */
export function memoryDetailOptions(session: ChatSession, scope: MemoryScope, id: string, slug: string) {
  const indexOptions = memoryIndexOptions(session, scope, id);
  return queryOptions({
    queryKey: [...memoryPrefix(session), scope, scope === 'profile' ? 'profile' : id, 'detail', slug],
    queryFn: async ({ signal }) => {
      const client = bridges.get(session)!;
      const index = client.getQueryData(indexOptions.queryKey);
      if (index && !index.details[slug]) return null;
      const detail = await session.api.getMemoryDetail(scope, id, slug, signal);
      if (index && detail.version !== index.version) {
        // A concurrent edit is not a valid pair. Refresh the existing index owner,
        // then let the ordinary Query retry read the current detail.
        await client.fetchQuery({ ...memoryIndexOptions(session, scope, id), retry: false });
        assertNotAborted(signal);
        throw new Error('详情已变化，请重试');
      }
      return detail;
    }, staleTime: 0, gcTime: 5 * 60_000,
    meta: indexOptions.meta,
  });
}

/** Explicit CAS rebase reads the same cached resources but reports the first failure. */
export async function readMemoryForReload(session: ChatSession, scope: MemoryScope, id: string, slug?: string) {
  const client = bridges.get(session)!;
  const indexOptions = memoryIndexOptions(session, scope, id);
  await client.cancelQueries({ queryKey: indexOptions.queryKey, exact: true });
  const index = await client.fetchQuery({ ...indexOptions, retry: false, networkMode: 'always' });
  if (slug === undefined) return { index, detail: null };
  const options = memoryDetailOptions(session, scope, id, slug);
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  const detail = await client.fetchQuery({ ...options, retry: false, networkMode: 'always' });
  return { index, detail };
}

export function scheduleDetailOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...schedulePrefix(session), id, 'detail'],
    queryFn: ({ signal }) => session.api.getSchedule(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
/** Explicit discard shares the detail resource and reports its first transport failure. */
export async function readScheduleForReload(session: ChatSession, id: string) {
  const options = scheduleDetailOptions(session, id);
  const client = bridges.get(session)!;
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  try {
    return await client.fetchQuery({ ...options, retry: false, networkMode: 'always' });
  } catch (error) {
    // Report the first failure to the discard action, but keep ordinary reads recovering.
    // This only resumes transport: it never replays the user's draft-discard intent.
    if (!isCancelledError(error) && client.getQueryCache().find({ queryKey: options.queryKey, exact: true })?.isActive()) {
      void client.fetchQuery(options).catch(() => {});
    }
    throw error;
  }
}

/** Keep the latest page reachable; the entire visit's pagination is reclaimed on unsubscribe. */
export function scheduleRunsOptions(session: ChatSession, id: string) {
  return infiniteQueryOptions({
    queryKey: [...schedulePrefix(session), id, 'runs'], initialPageParam: undefined as number | undefined,
    queryFn: ({ signal, pageParam }) => session.api.scheduleRuns(id, pageParam, 20, signal),
    getNextPageParam: (page) => page.runs.length < 20 ? undefined : page.runs.at(-1)?.id,
    gcTime: 0, staleTime: 0,
  });
}
// A user-requested one-shot check must attempt transport, never wait indefinitely for online heuristics.
const deletionReadPolicy = { staleTime: 0, retry: false, networkMode: 'always' } as const;

/** Agent list/activity stays session-owned; only finite definition details enter this cache. */
export function agentDetailOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...agentPrefix(session), id],
    queryFn: ({ signal }) => session.api.getAgent(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
/** Committed installation, shared by the editor summary and the read-only capability page. */
export function agentCapabilityOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...capabilityPrefix(session), id],
    queryFn: ({ signal }) => session.api.getAgentCapabilities(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
/** Agent-scoped list has bounded retention; details/runs share this resource prefix. */
export function scheduleListOptions(session: ChatSession, agentId: string) {
  return queryOptions({ queryKey: [...schedulePrefix(session), 'list', agentId],
    queryFn: async ({ signal }) => {
      const readRevision = session.scheduleRevision;
      return { ...await session.api.listSchedules(agentId, signal), readRevision };
    }, staleTime: 0, gcTime: 5 * 60_000 });
}
/** A deletion preflight is an explicit one-shot check, not a background read/retry loop.
 * It shares the detail key/transport but reports the first failure to the initiating dialog.
 */
export async function readAgentDeletionConstraints(session: ChatSession, id: string) {
  const options = agentDetailOptions(session, id);
  const client = bridges.get(session)!;
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery({ ...options, ...deletionReadPolicy });
}
export function skillListOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...skillPrefix(session), 'workspace', 'list'],
    queryFn: ({ signal }) => session.api.listSkills(signal), staleTime: 0, gcTime: Infinity });
}
export function skillDetailOptions(session: ChatSession, name: string) {
  return queryOptions({ queryKey: [...skillPrefix(session), 'workspace', 'detail', name],
    queryFn: ({ signal }) => session.api.getSkill(name, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
/** Command preflight shares the finite detail resource; unknown-write read-back stays domain-owned. */
export async function readSkillDeletionConstraints(session: ChatSession, name: string) {
  const options = skillDetailOptions(session, name);
  const client = bridges.get(session)!;
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery({ ...options, ...deletionReadPolicy });
}
export function builtinSkillListOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...skillPrefix(session), 'builtin', 'list'],
    queryFn: ({ signal }) => session.api.listBuiltinSkills(signal), staleTime: 0, gcTime: Infinity });
}
export function builtinSkillDetailOptions(session: ChatSession, name: string) {
  return queryOptions({ queryKey: [...skillPrefix(session), 'builtin', 'detail', name],
    queryFn: ({ signal }) => session.api.getBuiltinSkill(name, signal), staleTime: 0, gcTime: 5 * 60_000 });
}

/** Low-cardinality directory survives blur until session close; parameterized details have bounded retention. */
export function connectorListOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...connectorPrefix(session), 'list'],
    queryFn: ({ signal }) => session.api.listConnectors(signal), staleTime: 0, gcTime: Infinity });
}
/** Catalog declarations share connector revision invalidation, never a second page-owned reader. */
export function appCatalogOptions(session: ChatSession) {
  return queryOptions({ queryKey: [...connectorPrefix(session), 'apps'],
    queryFn: ({ signal }) => session.api.listApps(signal), staleTime: 0, gcTime: Infinity });
}
export function connectorDetailOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...connectorPrefix(session), 'detail', id],
    queryFn: ({ signal }) => session.api.getConnector(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
export function connectorAgentsOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...connectorPrefix(session), 'agents', id],
    queryFn: ({ signal }) => session.api.connectorAgents(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
export function connectorToolsOptions(session: ChatSession, id: string) {
  return queryOptions({ queryKey: [...connectorPrefix(session), 'tools', id],
    queryFn: ({ signal }) => session.api.connectorTools(id, signal), staleTime: 0, gcTime: 5 * 60_000 });
}
export async function readConnectorDeletionAgents(session: ChatSession, id: string) {
  const options = connectorAgentsOptions(session, id);
  const client = bridges.get(session)!;
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery({ ...options, ...deletionReadPolicy });
}
export async function readConnectorBeforeSave(session: ChatSession, id: string) {
  const options = connectorDetailOptions(session, id);
  const client = bridges.get(session)!;
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  return client.fetchQuery({ ...options, ...deletionReadPolicy });
}

// One migration registry: revisions target a resource; only reconnection targets all resources.
// Connection attempts/failed attempts do not repeatedly cancel otherwise usable HTTP reads.
const invalidationMap = [
  { snapshot: (session: ChatSession) => session.connectorRevision, prefix: connectorPrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.agents.definitionVersion, prefix: agentPrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.agents.definitionVersion, prefix: capabilityPrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.skillRevision, prefix: skillPrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.browserRevision, prefix: computerPrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => {
    const operation = session.editorOperations.get('settings:models');
    return operation ? `${operation.operationId}:${operation.status}` : '';
  }, prefix: settingsPrefix, changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.scheduleRevision, prefix: schedulePrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.browserRevision, prefix: browserPrefix,
    changed: (before: unknown, after: unknown) => before !== after },
  { snapshot: (session: ChatSession) => session.connection, prefix: sessionQueryKey,
    changed: (before: unknown, after: unknown) => before !== 'open' && after === 'open' },
] as const;
const bridges = new WeakMap<ChatSession, QueryClient>();

/** Installed once by the session holder, before start/publish (also by isolated scene holders).
 * Not a page lease: observer removal never removes the bridge or cache. API close detaches first,
 * synchronously cancels transport, then removes the entire session prefix; queued invalidations cannot revive it.
 */
export function attachSessionQueries(session: ChatSession, client = gatewayQueryClient): void {
  if (bridges.has(session)) {
    if (bridges.get(session) !== client) throw new Error('Session already owns another QueryClient');
    return;
  }
  if (session.api.signal.aborted) return;
  bridges.set(session, client);
  fileSessions.set(session.api, session);
  let closed = false;
  let queued = false;
  let prefixes: (readonly unknown[])[] = [];
  const invalidate = (queryKey: readonly unknown[]) => {
    // cancelQueries cancels synchronously even when the initial request has no cached data.
    const cancelled = client.cancelQueries({ queryKey });
    // Recovery emits cancelReads + revision + open in one stack. Collapse overlapping prefixes
    // before refetch, rather than letting a second invalidate cancel the first fresh transport.
    if (!prefixes.some(prefix => prefix.length <= queryKey.length && prefix.every((part, index) => part === queryKey[index]))) {
      prefixes = prefixes.filter(prefix => !queryKey.every((part, index) => part === prefix[index]));
      prefixes.push(queryKey);
    }
    if (queued) return;
    queued = true;
    void cancelled.then(() => {
      queued = false;
      const pending = prefixes;
      prefixes = [];
      if (!closed) for (const prefix of pending) void client.invalidateQueries({ queryKey: prefix });
    });
  };
  let previous = invalidationMap.map(entry => entry.snapshot(session));
  const memoryRevisions = new Map<string, string>();
  const stopMemoryCache = client.getQueryCache().subscribe(event => {
    if (event.type === 'removed') memoryRevisions.delete(event.query.queryHash);
  });
  const unsubscribe = session.subscribe(() => {
    const next = invalidationMap.map(entry => entry.snapshot(session));
    const changed = invalidationMap.filter((entry, index) => entry.changed(previous[index], next[index]));
    const wholeSession = changed.find(entry => entry.prefix === sessionQueryKey);
    for (const entry of wholeSession ? [wholeSession] : changed) invalidate(entry.prefix(session));
    for (const query of client.getQueryCache().findAll({ queryKey: memoryPrefix(session) })) {
      const scope = query.queryKey[2] as MemoryScope;
      const id = String(query.queryKey[3]);
      const revision = `${session.memoryRevisionFor(scope, id)}:${session.memoryConnectionRevision}`;
      const before = memoryRevisions.get(query.queryHash) ?? `${query.meta?.memoryRevision ?? 0}:${query.meta?.memoryConnection ?? 0}`;
      memoryRevisions.set(query.queryHash, revision);
      if (before !== revision && !wholeSession) invalidate([...memoryPrefix(session), scope, id]);
    }
    previous = next;
  });
  const stopReads = session.api.subscribeReadCancellation(() => invalidate(sessionQueryKey(session)));
  const close = () => {
    closed = true;
    unsubscribe();
    stopReads();
    stopMemoryCache();
    fileSessions.delete(session.api);
    void client.cancelQueries({ queryKey: sessionQueryKey(session) });
    client.removeQueries({ queryKey: sessionQueryKey(session) });
    session.api.signal.removeEventListener('abort', close);
  };
  session.api.signal.addEventListener('abort', close, { once: true });
}
