import type { AgentMemory, Connector, Fetch } from '../gateway/api';
import { newClientId } from '../gateway/session';
import { Credentials, type SavedComputer } from '../lib/credentials';
import { FakeGateway, unavailable, type GatewayOverrides } from './fake-gateway';
import { installFakeGatewayHost } from './fake-gateway-host';

export type SettingsScene = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A11' |
  'B1' | 'B2' | 'B3' | 'B4' | 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C5Loading' | 'C6' | 'C7' | 'C8' |
  'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D6Failure' | 'D7';
export type SettingsScenario = {
  readonly identity: string;
  runtime: { credentials: Credentials; fetch: Fetch }; peers: FakeGateway[];
  readonly stored: string | null; readonly requestCount: number;
  failStorage(value?: boolean): void; holdStorage(): void; releaseStorage(): void;
  failReads(value?: boolean): void; releaseReads(): void; holdConnection(): void;
  disconnect(): void; refresh(): void; recover(): void; changeResources(): void;
  start(): void; stop(): void;
};

/** Only persistent storage, HTTP responses and SSE bytes are supplied by the scene.
 * Busy/error scenes are reached through the same local operations as the real page. */
export function settingsScenario(scene: SettingsScene = 'A1'): SettingsScenario {
  const laptop: SavedComputer = { computerId: 'settings-laptop', connectionId: 'settings-laptop-installation', deviceId: 'laptop-device', baseUrl: 'http://192.168.1.20:8765', token: 'storybook-laptop', computerName: 'MacBook Pro', gatewayVersion: '0.2.0', pairingMethod: 'qr' };
  const mini: SavedComputer = { computerId: 'settings-mini', connectionId: 'settings-mini-installation', deviceId: 'mini-device', baseUrl: 'http://192.168.1.31:8765', token: 'storybook-mini', computerName: 'Mac mini', localName: 'Mac mini · 书房', gatewayVersion: '0.2.0', pairingMethod: 'manual' };
  if (scene === 'B4') laptop.computerName = '用于研究与日常工作并拥有特别长名称的笔记本电脑'.repeat(3);
  if (scene === 'C5' || scene === 'C5Loading') delete laptop.gatewayVersion;
  let computers: SavedComputer[] = scene === 'A8' ? [] : scene === 'C3' ? [laptop] : [laptop, mini];
  if (scene === 'A11' || scene === 'C8') mini.authStatus = 'invalid';
  if (scene === 'C7') {
    mini.authStatus = 'invalid';
    computers = [...computers, ...Array.from({ length: 24 }, (_, index) => ({ ...laptop, computerId: `saved-${index}`, connectionId: `saved-installation-${index}`, baseUrl: `http://192.168.2.${index + 1}:8765`, computerName: `research-host-${index + 1} · 一个很长的备注名用于滚动与截断检查` }))];
  }
  let stored: string | null = computers.length ? JSON.stringify({ computers, currentId: laptop.computerId }) : null;
  let storageFailure = scene === 'D2' || scene === 'D5' || scene === 'D6Failure';
  let storageGate = scene === 'D1' || scene === 'D6' ? Promise.withResolvers<void>() : null;
  let readGate = scene === 'A5' || scene === 'C5Loading' ? Promise.withResolvers<void>() : null;
  let connectionGate: PromiseWithResolvers<void> | null = null;
  let offline = scene === 'A3' || scene === 'C4';
  let readFailure = scene === 'A6';
  let connectionFailure = scene === 'C5';
  let requestCount = 0;
  let transition: ReturnType<typeof setTimeout> | undefined;
  let releaseHost: (() => void) | undefined;
  const credentials = new Credentials({
    getItemAsync: async () => stored,
    setItemAsync: async (_key, value) => { await storageGate?.promise; if (storageFailure) throw new Error('storage unavailable'); stored = value; },
    deleteItemAsync: async () => { await storageGate?.promise; if (storageFailure) throw new Error('storage unavailable'); stored = null; },
  });
  const connector: Connector = { id: 'docs', name: '文档', description: '', auth_type: 'none', app_id: null, command: 'docs', args: [], env: {}, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [], error: null }, status: 'connected', error: null, tool_count: 3, used_by: [], pending_restart: false };
  const now = Date.now() / 1000;
  const profile: AgentMemory = { scope: 'profile', content: scene === 'B3' ? '' : '## 关于你\n\n- 喜欢简洁的中文。\n- 关注 Agent 运行机制。\n', version: 'v1', limit: 1000, updated_at: now, updated_by: 'user', details: {} };
  const read: NonNullable<GatewayOverrides['GET /apps']> = async () => { await readGate?.promise; if (readFailure) return unavailable(); };
  const peers = computers.map((computer) => new FakeGateway({
    connectors: scene === 'B3' ? [] : Array.from({ length: 5 }, (_, index) => ({ ...connector, id: `docs-${index}`, name: `文档 ${index + 1}`, ...(index === 0 && scene !== 'B1' ? { status: 'failed' as const } : {}) })),
    memories: new Map([['/memory/profile', profile]]),
    connection: { device_id: computer.deviceId!, computer_name: computer.computerName!, gateway_version: computer === laptop ? '0.2.0' : '0.3.0', paired_at: null, pairing_method: computer.pairingMethod! },
    computer: { name: computer.computerName!, online_since: now - 3600, uptime_seconds: 3600, cpu_percent: 12,
      memory: { used_bytes: 4 * 1024 ** 3, total_bytes: 16 * 1024 ** 3, percent: 25 },
      environments: [{ environment_id: 'local', environment_name: 'Local', capacity: { pages_used: 0, pages_limit: 6, pages_registered: 0, pages_creating: 0, pages_pending_cleanup: 0 } }] },
    skills: scene === 'B3' ? [] : Array.from({ length: 10 }, (_, index) => ({ name: `skill-${index + 1}`, description: '', used_by: [], status: scene === 'B2' && index === 0 ? 'error' as const : 'ok' as const, error: null, path: `/fixture/skills/skill-${index + 1}/SKILL.md`, mtime: now, content: scene === 'B2' && index === 0 ? null : `# Skill ${index + 1}` })),
    builtinSkills: scene === 'B3' ? [] : ['browser', 'search'].map(name => ({ name, description: '', capability: { id: name, name }, used_by: [], content: `# ${name}` })),
    subscription: { auth: { status: 'ready', reason: null, checked_at: now, codex_home: '/story/codex', login_command: 'codex login' }, usage: { plan_type: scene === 'B4' ? 'Pro · 一个特别长的套餐名称用于检查右侧摘要截断' : 'Pro', allowed: scene !== 'B1', limit_reached: scene === 'B1', windows: [{ name: 'primary', used_percent: scene === 'B1' ? 100 : 42, window_seconds: 604800, reset_at: now + 3600 }], fetched_at: now } },
  }, {
    'GET /conversations': () => scene === 'A4' ? unavailable() : undefined,
    'GET /events': ({ gateway, init }) => offline ? unavailable() : gateway.openStream(init.signal),
    'GET /connection': async (_context, respond) => {
      const response = await respond();
      await readGate?.promise;
      if (computer === laptop) await connectionGate?.promise;
      return connectionFailure ? unavailable() : response;
    },
    'GET /skills': read, 'GET /builtin-skills': read,
    'GET /connectors': read, 'GET /memory/profile': read, 'GET /usage/subscription': read,
    'DELETE /devices/current': () => scene === 'D7' ? unavailable() : undefined,
  }));
  const byHost: Record<string, FakeGateway> = Object.fromEntries(computers.map((computer, index) => [new URL(computer.baseUrl).host, peers[index]]));
  const fetch: Fetch = (input, init) => {
    requestCount++;
    const url = new URL(String(input));
    const peer = byHost[url.host];
    if (!peer) throw new Error(`Unexpected settings fixture host: ${url.host}`);
    return peer.fetch(input, init);
  };
  const refresh = () => peers.forEach(peer => peer.disconnect());
  return {
    identity: newClientId(),
    runtime: { credentials, fetch }, peers,
    get stored() { return stored; },
    get requestCount() { return requestCount; },
    failStorage(value = true) { storageFailure = value; },
    holdStorage() { storageGate ??= Promise.withResolvers<void>(); },
    releaseStorage() { storageGate?.resolve(); storageGate = null; },
    failReads(value = true) { readFailure = connectionFailure = value; peers.forEach(peer => peer.emit(peer.event('resource.changed', { kind: 'connector', id: 'docs-0', op: 'updated' }))); },
    holdConnection() { connectionGate ??= Promise.withResolvers<void>(); },
    releaseReads() { readGate?.resolve(); readGate = null; connectionGate?.resolve(); connectionGate = null; },
    disconnect() { offline = true; refresh(); },
    refresh,
    recover() { offline = readFailure = connectionFailure = false; refresh(); },
    changeResources() {
      for (const peer of peers) {
        peer.state.skills = [{ name: '新技能', description: '', used_by: [], status: 'ok', error: null, path: '/fixture/skills/new/SKILL.md', mtime: now, content: '# 新技能' }];
        peer.state.builtinSkills = [];
        peer.state.connectors = [];
        peer.state.memories.set('/memory/profile', { ...profile, content: '- 新内容\n', version: 'v2' });
        for (const kind of ['connector', 'skill', 'memory']) peer.emit(peer.event('resource.changed', { kind, scope: 'profile', id: 'docs-0', op: 'updated' }));
      }
    },
    start() {
      releaseHost ??= installFakeGatewayHost({ baseUrls: computers.map(computer => computer.baseUrl), fetch });
      // Deliberate peer transition for visual stories, not a product feedback/gesture timer.
      if (scene === 'A7' || scene === 'C6') transition = setTimeout(() => { readFailure = connectionFailure = true; refresh(); }, 3000);
    },
    stop() { clearTimeout(transition); readGate?.resolve(); connectionGate?.resolve(); storageGate?.resolve(); refresh(); releaseHost?.(); releaseHost = undefined; },
  };
}
