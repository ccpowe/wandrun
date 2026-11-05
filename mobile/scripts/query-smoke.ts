// Run from mobile/: node scripts/query-smoke.ts (only an ephemeral loopback HTTP peer; no gateway/model credentials).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { QueryObserver, type QueryObserverOptions, type QueryKey } from '@tanstack/react-query';
import { ChatSession } from '../src/gateway/session.ts';
import type { AgentDetail, SkillDetail, BuiltinSkillDetail } from '../src/gateway/api.ts';
import { createGatewayQueryClient, attachSessionQueries, connectorListOptions, sessionQueryKey,
  agentDetailOptions, agentCapabilityOptions, scheduleListOptions, skillListOptions, skillDetailOptions, builtinSkillListOptions, builtinSkillDetailOptions, fileDetailOptions,
  connectionOptions, settingsOptions, modelCatalogOptions, subscriptionOptions, agentUsageOptions, executionEnvironmentOptions, computerStatusOptions, browserTaskOptions } from '../src/lib/gateway-queries.ts';

let reads = 0;
let supersededClosed = false;
const firstStarted = Promise.withResolvers<void>();
const server = createServer((req, res) => {
  if (req.url !== '/connectors') { res.writeHead(404).end(); return; }
  reads++;
  if (reads === 1) {
    req.on('close', () => { supersededClosed = true; });
    firstStarted.resolve();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ connectors: [{ id: 'docs', name: 'after-revision' }], as_of_seq: 2 }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No HTTP port');
const session = new ChatSession({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'loopback-smoke' });
const client = createGatewayQueryClient();
client.mount();
attachSessionQueries(session, client);
const observer = new QueryObserver(client, connectorListOptions(session));
const received = Promise.withResolvers<string>();
const stop = observer.subscribe(result => { if (result.data) received.resolve(result.data.connectors[0].name); });
try {
  await Promise.race([firstStarted.promise, sleep(2000).then(() => { throw new Error('HTTP query did not start'); })]);
  session.refreshConnectors();
  const data = await Promise.race([received.promise, sleep(2000).then(() => { throw new Error('HTTP query did not refresh'); })]);
  for (let i = 0; i < 30 && !supersededClosed; i++) await sleep(10);
  if (data !== 'after-revision' || !supersededClosed || reads !== 2) throw new Error(`Unexpected HTTP state ${JSON.stringify({ data, supersededClosed, reads })}`);
  console.log(`HTTP revision: data=${data}; superseded transport closed=${supersededClosed}; reads=${reads}`);
  await session.close();
  const remaining = client.getQueryCache().findAll({ queryKey: sessionQueryKey(session) }).length;
  if (remaining !== 0) throw new Error('Session cache survived close');
  console.log(`Session close: prefix cache entries=${remaining}`);
} finally {
  stop(); await session.close(); client.unmount(); client.clear(); server.closeAllConnections(); server.close();
}

/** Real HTTP probe for migrated resources: two readers share, revision aborts an initial body,
 * a replacement wins, and session close removes both finite and directory cache entries.
 */
async function migratedRead<T, TKey extends QueryKey>(endpoint: string, options: (session: ChatSession) => QueryObserverOptions<T, Error, T, T, TKey>,
  revision: (session: ChatSession) => void, snapshot: unknown) {
  let requests = 0;
  let cancelled = false;
  const started = Promise.withResolvers<void>();
  const peer = createServer((req, res) => {
    if (req.url !== endpoint) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/browser-tasks' ? { browser_tasks: [], as_of_seq: 1 } : { agents: [], as_of_seq: 1, order_revision: 0 }));
      return;
    }
    if (++requests === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"pending":');
      req.on('close', () => { cancelled = true; });
      started.resolve();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot));
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const port = peer.address();
  if (!port || typeof port === 'string') throw new Error('Missing peer port');
  const session = new ChatSession({ baseUrl: `http://127.0.0.1:${port.port}`, token: 'loopback-smoke' });
  const client = createGatewayQueryClient();
  client.mount(); attachSessionQueries(session, client);
  const first = new QueryObserver(client, options(session));
  const second = new QueryObserver(client, options(session));
  const received = Promise.withResolvers<T>();
  let stopFirst: (() => void) | undefined = first.subscribe(() => {});
  let stopSecond: (() => void) | undefined = second.subscribe(result => { if (result.data) received.resolve(result.data); });
  try {
    await Promise.race([started.promise, sleep(2000).then(() => { throw new Error(`${endpoint} did not start`); })]);
    stopFirst(); stopFirst = undefined;
    const initialRequests = requests;
    assert.equal(initialRequests, 1, `${endpoint}: readers did not share transport`);
    assert.equal(cancelled, false, `${endpoint}: first reader removal cancelled shared transport`);
    revision(session);
    const actual = await Promise.race([received.promise, sleep(2000).then(() => { throw new Error(`${endpoint} did not refresh`); })]);
    for (let i = 0; i < 30 && !cancelled; i++) await sleep(10);
    // The HTTP body is the wire DTO; Query may additionally attach local provenance.
    for (const [key, value] of Object.entries(snapshot as object)) assert.deepEqual(Reflect.get(actual as object, key), value);
    if (requests !== 2 || !cancelled) throw new Error(`${endpoint}: stale transport won`);
    stopSecond(); stopSecond = undefined;
    await session.close();
    if (client.getQueryCache().findAll({ queryKey: sessionQueryKey(session) }).length) throw new Error(`${endpoint}: cache survived close`);
    console.log(`${endpoint}: shared readers; initial response body aborted; revision current; close cache=0`);
  } finally {
    stopFirst?.(); stopSecond?.(); await session.close(); client.unmount(); client.clear(); peer.closeAllConnections(); peer.close();
  }
}
const agentRevision = (session: ChatSession) => session.agents.observe({
  seq: 1, type: 'resource.changed', at: 1, data: { kind: 'agent', id: 'sample', op: 'updated' },
});
const skillRevision = (session: ChatSession) => session.skillChanged(null);
await migratedRead('/agents/sample', session => agentDetailOptions(session, 'sample'), agentRevision,
  { id: 'sample', name: 'Current' } as AgentDetail);
await migratedRead('/agents/sample/capabilities', session => agentCapabilityOptions(session, 'sample'), agentRevision,
  { capabilities: [{ id: 'files', name: 'Current', summary: 'Current', description: 'Current', status: 'enabled', reason: '', tools: [], skills: [] }] });
await migratedRead('/agents/sample/schedules', session => scheduleListOptions(session, 'sample'),
  session => session.connectorChanged({ seq: 1, type: 'resource.changed', at: 1, data: { kind: 'schedule', id: 'sample', op: 'updated' } }),
  { schedules: [], default_timezone: null, as_of_seq: 1 });
await migratedRead('/skills', skillListOptions, skillRevision, { skills: [], as_of_seq: 1, default_agent_id: null });
await migratedRead('/skills/sample', session => skillDetailOptions(session, 'sample'), skillRevision,
  { name: 'sample', content: 'Current' } as SkillDetail);
await migratedRead('/builtin-skills', builtinSkillListOptions, skillRevision, { skills: [] });
await migratedRead('/builtin-skills/sample', session => builtinSkillDetailOptions(session, 'sample'), skillRevision,
  { name: 'sample', content: 'Current' } as BuiltinSkillDetail);
await migratedRead('/files/sample', session => fileDetailOptions(session, 'sample'), session => session.api.cancelReads(),
  { id: 'sample', name: 'Current.txt', size: 7, media_type: 'text/plain', available: true, error: null, error_message: null,
    conversation_id: null, agent_id: null, task_id: 'root', created_at: 1, remote_environment: null, source: 'agent' });
const browserRevision = (session: ChatSession) => { void session.refreshBrowserTasks(); };
await migratedRead('/browser-tasks/sample', session => browserTaskOptions(session, 'sample'), browserRevision,
  { id: 'sample', state: 'human', pages: [], current: null });
const transportRevision = (session: ChatSession) => session.api.cancelReads();
await migratedRead('/connection', connectionOptions, transportRevision, {
  device_id: 'phone', computer_name: 'research-host', gateway_version: 'smoke', paired_at: null, pairing_method: 'manual',
});
await migratedRead('/settings', settingsOptions, transportRevision, { default_model: 'current', default_reasoning_effort: null });
await migratedRead('/models?refresh=true', modelCatalogOptions, transportRevision, { models: [], fetched_at: 1 });
await migratedRead('/usage/subscription?refresh=true', subscriptionOptions, transportRevision, {
  auth: { status: 'ready', reason: null, checked_at: 1, codex_home: '/smoke', login_command: 'codex login' }, usage: null,
});
await migratedRead('/usage/agents?days=7', agentUsageOptions, transportRevision, { days: 7, agents: [] });
await migratedRead('/computer', computerStatusOptions, transportRevision, { name: 'research-host', online_since: 1, uptime_seconds: 60,
  cpu_percent: 12, memory: { used_bytes: 1, total_bytes: 4, percent: 25 }, environments: [] });

// The paged directory shares the same infinite cache across editor consumers. Exercise real
// sequential HTTP pages and session shutdown separately from the finite observer probe above.
const environmentRequests: string[] = [];
const environmentPeer = createServer((req, res) => {
  environmentRequests.push(req.url!);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url?.includes('cursor=') ? {
    environments: [{ id: 'remote', label: 'Remote' }], next_cursor: null,
  } : { environments: [{ id: 'local', label: 'Local' }], next_cursor: 'page-2' }));
});
environmentPeer.listen(0, '127.0.0.1');
await once(environmentPeer, 'listening');
const environmentAddress = environmentPeer.address();
if (!environmentAddress || typeof environmentAddress === 'string') throw new Error('Missing environment port');
const environmentSession = new ChatSession({ baseUrl: `http://127.0.0.1:${environmentAddress.port}`, token: 'loopback-smoke' });
const environmentClient = createGatewayQueryClient();
environmentClient.mount(); attachSessionQueries(environmentSession, environmentClient);
try {
  const options = executionEnvironmentOptions(environmentSession);
  await environmentClient.fetchInfiniteQuery(options);
  const pages = await environmentClient.fetchInfiniteQuery({ ...options, pages: 2 });
  assert.deepEqual(pages.pages.flatMap(page => page.environments.map(environment => environment.id)), ['local', 'remote']);
  assert.deepEqual(environmentRequests, ['/execution-environments', '/execution-environments', '/execution-environments?cursor=page-2']);
  await environmentSession.close();
  assert.equal(environmentClient.getQueryCache().findAll({ queryKey: sessionQueryKey(environmentSession) }).length, 0);
  console.log('/execution-environments: sequential HTTP pages current; close cache=0');
} finally {
  await environmentSession.close(); environmentClient.unmount(); environmentClient.clear();
  environmentPeer.closeAllConnections(); environmentPeer.close();
}
