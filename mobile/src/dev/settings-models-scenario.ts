import type { AgentDetail, SubscriptionAuth } from '../gateway/api';
import { unavailable, type FakeGateway, type GatewayOverrides } from './fake-gateway';
import { settingsScenario, type SettingsScenario } from './settings-scenario';

export type ModelsScene = 'normal' | 'save-failure' | 'unknown' | 'unknown-applied' | 'saving' |
  'loading' | 'read-failure' | 'read-stale' | 'offline' | 'auth-due' | 'auth-refreshing' | 'auth-unavailable' |
  'login-required' | 'reauth' | 'rotation-unknown' | 'no-quota' | 'empty-windows' | 'quota-limited' | 'percent-only' |
  'no-agents' | 'no-usage' | 'one-agent' | 'many-agents' | 'catalog-failure' | 'catalog-empty' | 'model-unlisted';
export type ModelsScenario = SettingsScenario & { gateway: FakeGateway; readonly writes: number; release(): void };

/** Resources and explicit response failures only; selection, dirty state and leaving use the real page. */
export function modelsScenario(scene: ModelsScene = 'normal'): ModelsScenario {
  const base = settingsScenario('A1');
  const gateway = base.peers[0];
  const now = Math.floor(Date.now() / 1000);
  const names = scene === 'no-agents' ? [] : scene === 'one-agent' ? ['小万'] : scene === 'many-agents'
    ? Array.from({ length: 24 }, (_, index) => index === 0 ? '资料研究与长名称显示检查伙伴'.repeat(3) : `研究伙伴 ${index + 1}`)
    : ['小万', '研究员', '写作伙伴'];
  const agents: AgentDetail[] = names.map((name, index) => ({
    id: `models-agent-${index}`, name, avatar: index % 6, description: '整理资料与日常工作', workers: [],
    system_prompt: '先理解需求，再给出可核对的结论。', model: 'offline', reasoning_effort: 'medium', fast_mode: false,
    code_mode: true, environment: 'local', member_of: [], skills: [], mcp_servers: [], searchable_mcp_servers: [],
  }));
  gateway.state.agents = agents.map(agent => ({ ...agent, latest_conversation: null, unread: false }));
  gateway.state.agentDetails = new Map(agents.map(agent => [agent.id, agent]));
  gateway.state.models = { fetched_at: now, capabilities: { fast_mode: true }, models: [
    { id: 'offline', display_name: '日常模型', description: '日常整理与轻量任务', default_reasoning_effort: 'medium', supported_reasoning_efforts: [{ effort: 'medium', description: '' }, { effort: 'high', description: '' }] },
    { id: 'careful', display_name: '深入模型', description: '复杂分析与需要仔细核对的任务', default_reasoning_effort: 'medium', supported_reasoning_efforts: [{ effort: 'medium', description: '' }, { effort: 'high', description: '' }, { effort: 'xhigh', description: '' }] },
  ] };
  if (scene === 'catalog-empty') gateway.state.models.models = [];
  gateway.state.settings = scene === 'model-unlisted' ? { default_model: 'retired-model', default_reasoning_effort: 'retired-effort' } : { default_model: 'offline', default_reasoning_effort: 'medium' };
  gateway.state.usage = { days: 7, agents: scene === 'no-usage' ? [] : agents.map((agent, index) => ({ agent_id: agent.id,
    input_tokens: [82000, 13000, 2500][index] ?? 1000, cached_input_tokens: [50000, 8000, 500][index] ?? 500,
    output_tokens: [18000, 7000, 500][index] ?? 100, reasoning_output_tokens: [10000, 4000, 300][index] ?? 50, daily: [],
  })) };
  const statuses: Partial<Record<ModelsScene, SubscriptionAuth['status']>> = {
    'auth-due': 'refresh_due', 'auth-refreshing': 'refreshing', 'auth-unavailable': 'temporarily_unavailable',
    'login-required': 'login_required', reauth: 'reauth_required', 'rotation-unknown': 'relogin_required',
  };
  gateway.state.subscription = { auth: { status: statuses[scene] ?? 'ready', reason: null, checked_at: now, codex_home: '/story/codex', login_command: 'CODEX_HOME=/story/codex codex login --device-auth' }, usage: {
    plan_type: 'Pro', allowed: scene !== 'quota-limited', limit_reached: scene === 'quota-limited', fetched_at: now, windows: [
      { name: 'primary', used_percent: scene === 'quota-limited' || scene === 'percent-only' ? 100 : 32, window_seconds: 18000, reset_at: now + 7200 },
      { name: 'secondary', used_percent: scene === 'quota-limited' ? 100 : 64, window_seconds: 604800, reset_at: now + 172800 },
    ],
  } };
  if (scene === 'no-quota') gateway.state.subscription.usage = null;
  if (scene === 'empty-windows') gateway.state.subscription.usage!.windows = [];
  let wrote = false;
  let recovered = false;
  let stale = false;
  let writes = 0;
  let transition: ReturnType<typeof setTimeout> | undefined;
  const gate = Promise.withResolvers<void>();
  const read = async () => {
    if (scene === 'loading') await gate.promise;
    if (!recovered && (scene === 'read-failure' || stale)) return unavailable();
  };
  const write: NonNullable<GatewayOverrides['PUT /settings']> = async (_context, respond) => {
    writes++; wrote = true;
    if (scene === 'saving') await gate.promise;
    if (recovered) return;
    if (scene === 'save-failure') return unavailable('当前配置不能保存，请检查后重试。', 400);
    if (scene === 'unknown-applied') { await respond(); return unavailable(); }
    if (scene === 'unknown') return unavailable();
  };
  Object.assign(gateway.overrides, {
    'PUT /settings': write,
    'GET /settings': async () => !recovered && wrote && (scene === 'unknown' || scene === 'unknown-applied') ? unavailable() : read(),
    'GET /usage/subscription': read,
    'GET /usage/agents': read,
    'GET /models': async () => scene === 'catalog-failure' && !recovered ? unavailable() : read(),
    'GET /events': () => scene === 'offline' && !recovered ? unavailable() : undefined,
  } satisfies GatewayOverrides);
  return {
    ...base, gateway, get writes() { return writes; }, get stored() { return base.stored; }, get requestCount() { return base.requestCount; },
    start() { base.start(); if (scene === 'read-stale') transition = setTimeout(() => { stale = true; base.refresh(); }, 3000); },
    stop() { clearTimeout(transition); gate.resolve(); base.stop(); },
    release() { gate.resolve(); },
    recover() { recovered = true; base.recover(); },
  };
}
