import { z } from 'zod';
import type { AgentDetail, AgentSummary, Connector, Conversation, Schedule, ScheduleRun } from '../gateway/api';
import type { ChatSession } from '../gateway/session';
import type { SessionRuntime } from '../lib/session-context';
import { FakeGateway, jsonResponse, unavailable, type GatewayOverrides } from './fake-gateway';
import { createSceneRuntime } from './scene-session';

export type EditorScene = 'cleanup-residual' | 'normal' | 'loading' | 'read-failure' | 'read-stale' | 'offline' | 'save-failure' | 'name-conflict' | 'unknown' | 'unknown-applied' | 'catalog-failure' | 'catalog-loading' | 'empty-catalogs' | 'many-members' | 'member-empty' | 'member-failure' | 'member-loading' | 'missing-selections' | 'environment-partial' | 'environment-unknown' | 'model-unlisted' | 'fast-unsupported' | 'delete-blocked' | 'delete-conflict' | 'delete-failure' | 'delete-unknown' | 'capabilities' | 'capabilities-empty' | 'capabilities-failure' | 'capabilities-loading' | 'ended' | 'weekly' | 'cron' | 'runs' | 'runs-many' | 'runs-failure' | 'runs-loading' | 'external-update' | 'external-agent';
export type EditorScenario = {
  readonly session: ChatSession; runtime: SessionRuntime; gateway: FakeGateway; start: (session?: ChatSession) => Promise<void>; stop: () => void; recover: () => void;
  release: () => void; updateSchedule: (name: string) => void; updateAgent: (fields: Partial<AgentDetail>) => void;
  removeAgent: () => void; revokeCapability: () => void;
};
/** Failure states come from HTTP, not page props. Every scene remains an interactive real editor. */
export function editorScenario(scene: EditorScene = 'normal'): EditorScenario {
  const agent: AgentSummary = { id: 'planner', name: '小万', avatar: 0, description: '理解需求，安排任务', workers: [], environment: 'local', latest_conversation: null, unread: false };
  const detail: AgentDetail = { ...agent, system_prompt: '先理解需求，给出可核对的结论。', model: 'offline', reasoning_effort: 'medium', fast_mode: false, code_mode: true, environment: 'local', skills: [], mcp_servers: [], searchable_mcp_servers: [], member_of: [] };
  const member = { ...agent, id: 'researcher', name: '研究员', description: '查阅资料，核对原始来源' };
  const agents = scene === 'member-empty' ? [agent] : [agent, member];
  if (scene === 'many-members') for (let index = 0; index < 22; index++) agents.push({ ...member, id: `member-${index}`, name: `研究伙伴 ${index + 1}` });
  if (scene === 'missing-selections') { detail.workers = ['researcher', 'missing-agent']; detail.skills = ['broken-skill', 'missing-skill']; detail.mcp_servers = ['missing-connector']; }
  if (scene === 'environment-partial' || scene === 'environment-unknown') detail.environment = 'cloud-a';
  if (scene === 'model-unlisted') { detail.model = 'retired-model'; detail.reasoning_effort = 'retired-effort'; }
  if (scene === 'delete-blocked') detail.member_of = ['researcher'];
  const now = Math.floor(Date.now() / 1000);
  const schedule: Schedule = { id: 'morning', agent_id: agent.id, name: '每日新闻简报', content: '整理今天值得关注的技术新闻，并给出原始来源。', rule: { kind: 'daily', time: '08:00' }, timezone: 'Asia/Shanghai', enabled: true, ended: false, next_run_at: now + 86400, created_at: now - 86400, updated_at: now - 86400 };
  if (scene === 'ended') Object.assign(schedule, { rule: { kind: 'once', local_at: '2026-10-01T08:00' }, enabled: false, ended: true, next_run_at: null });
  if (scene === 'weekly') schedule.rule = { kind: 'weekly', time: '20:00', weekdays: [1, 5] };
  if (scene === 'cron') schedule.rule = { kind: 'cron', expression: '0 8 * * *' };
  const conversation: Conversation = { id: 'run-chat', agent_id: agent.id, title: '新闻简报运行', created_at: now, updated_at: now, last_activity_seq: 1, last_activity_at: now, read_seq: 1, last_agent_seq: 1, status: 'idle', unread: false, last_text: '已整理今日简报。', source: 'schedule', schedule_origin: { schedule_id: schedule.id, run_id: 1, name: schedule.name, scheduled_at: now } };
  const run = (id: number): ScheduleRun => ({ id, schedule_id: schedule.id, scheduled_at: now - id * 3600, started_at: now - id * 3600, finished_at: now - id * 3600 + 10, status: (['completed', 'failed', 'running', 'cancelled', 'missed'] as const)[(id - 1) % 5], reason: id % 5 === 0 ? '网关停机期间未运行' : null, conversation_id: id === 1 ? conversation.id : null, name: schedule.name, content: schedule.content, missed_before: id % 5 === 0 ? now : null });
  const runs = scene === 'runs-many' ? Array.from({ length: 25 }, (_, index) => run(25 - index)) : scene === 'runs' ? [1, 2, 3, 4, 5].map(run) : [];
  const connector = (id: string, description: string): Connector => ({ id, name: id === 'docs' ? '资料检索' : '无说明连接器', description, url: 'https://example.invalid/mcp', auth_type: 'none', app_id: null, auth: { status: 'not_required', authorizing: false, transaction_id: null, scopes: [] }, status: 'connected', error: null, tool_count: 3, used_by: [], pending_restart: false });
  let recovered = false;
  let wrote = false;
  let stale = false;
  let transition: ReturnType<typeof setTimeout> | undefined;
  const gate = Promise.withResolvers<void>();
  const read: NonNullable<GatewayOverrides['GET /agents/:id']> = async () => {
    if (scene === 'loading') await gate.promise;
    if (!recovered && (scene === 'read-failure' || stale || ((scene === 'unknown' || scene === 'unknown-applied' || scene === 'delete-unknown') && wrote))) return unavailable();
    if (scene === 'read-stale' && !transition) transition = setTimeout(() => { stale = true; gateway.disconnect(); }, 200);
  };
  const catalogRead = async () => {
    if (scene === 'catalog-loading') await gate.promise;
    if (scene === 'catalog-failure' && !recovered) return unavailable();
  };
  const write: NonNullable<GatewayOverrides['PATCH /agents/:id']> = async ({ body }, respond) => {
    wrote = true;
    if (scene === 'name-conflict' && z.object({ name: z.string().optional() }).parse(body).name?.trim() === '研究员')
      return jsonResponse({ error: { code: 'agent_name_conflict', message: '已有同名 Agent' } }, 409);
    if (scene === 'save-failure' && !recovered) return jsonResponse({ error: { code: 'invalid_request', message: '当前配置不能保存，请检查后重试。' } }, 400);
    if (scene === 'unknown-applied' && !recovered) { await respond(); return unavailable(); }
    if (scene === 'unknown' && !recovered) return unavailable();
    if (scene === 'cleanup-residual') {
      const response = await respond();
      const payload = await response.json();
      payload.event.data.cleanup_unconfirmed = [{ resource: 'directory', error: 'OldDirectoriesNotCleaned' }];
      return jsonResponse(payload);
    }
  };
  const remove: NonNullable<GatewayOverrides['DELETE /agents/:id']> = () => {
    wrote = true;
    if (scene === 'delete-failure' && !recovered) return jsonResponse({ error: { code: 'invalid_request', message: '当前操作不能删除，请稍后重试。' } }, 400);
    if (scene === 'delete-conflict' && !recovered) return jsonResponse({ error: { code: 'conflict', message: '当前操作不能删除，请稍后重试。' } }, 409);
    if (scene === 'delete-unknown' && !recovered) return unavailable();
  };
  const gateway: FakeGateway = new FakeGateway({
    agents, agentDetails: new Map([[agent.id, detail]]), schedules: [schedule], scheduleRuns: new Map([[schedule.id, runs]]),
    conversations: [conversation], histories: new Map([[conversation.id, [{ seq: 1, type: 'message.agent', conversation_id: conversation.id, at: now, data: { agent_id: agent.id, text: '已整理今日简报。' } }]]]),
    connectors: scene === 'empty-catalogs' ? [] : [connector('docs', '查询原始资料并返回来源'), connector('no-description', '')],
    skills: scene === 'empty-catalogs' ? [] : [{ name: 'research', description: '查阅并核对资料', used_by: [], status: 'ok', error: null, path: '/skills/research/SKILL.md', mtime: now, content: '# Research\n查阅并核对资料。' }, { name: 'broken-skill', description: '', used_by: [], status: 'error', error: '技能内容暂不可用', path: '/skills/broken-skill/SKILL.md', mtime: null, content: null }],
    environments: scene === 'environment-unknown' ? [] : [{ id: 'local', name: 'Local', type: 'local', status: null }, { id: 'cloud-a', name: '资料工作机', type: 'instabox', status: 'suspended' }, { id: 'cloud-b', name: '研究工作机', type: 'instabox', status: 'running' }],
    models: { models: scene === 'empty-catalogs' ? [] : [{ id: 'offline', display_name: 'Storybook model', description: '本地交互验证使用的模型目录', default_reasoning_effort: 'medium', supported_reasoning_efforts: [{ effort: 'medium', description: '常规' }, { effort: 'max', description: '深入' }] }], fetched_at: 1, capabilities: { fast_mode: scene !== 'fast-unsupported' } },
    capabilities: new Map([[agent.id, [{ id: 'files', name: '文件', summary: '读写工作目录', description: '读写这个 Agent 所在电脑上的文件，相对路径落在当前对话的目录里。', status: 'enabled', reason: '所有 Agent 均可使用', tools: ['read_file', 'write_file'], skills: [] }, { id: 'browser', name: '浏览器', summary: '操作电脑浏览器', description: '使用已配置的浏览器', status: 'not_applicable', reason: '电脑未配置浏览器', tools: [], skills: [] }]]]),
  }, {
    'GET /agents/:id': read, 'GET /schedules/:id': read,
    'GET /agents': async () => {
      if (owner.current?.connection !== 'open') return;
      if (scene === 'member-loading') await gate.promise;
      if (scene === 'member-failure' && !recovered) return unavailable();
    },
    'GET /models': catalogRead, 'GET /skills': catalogRead, 'GET /connectors': catalogRead,
    'GET /execution-environments': async ({ url }) => {
      if (scene !== 'environment-partial') return catalogRead();
      if (url.searchParams.has('cursor')) { if (!recovered) return unavailable(); return jsonResponse({ environments: [], next_cursor: null }); }
      return jsonResponse({ environments: gateway.state.environments, next_cursor: 'next-page' });
    },
    'GET /agents/:id/capabilities': async () => { if (scene === 'capabilities-loading') await gate.promise; if (scene === 'capabilities-failure' && !recovered) return unavailable(); if (scene === 'capabilities-empty') return jsonResponse({ capabilities: [] }); },
    'GET /schedules/:id/runs': async () => { if (scene === 'runs-loading') await gate.promise; if (scene === 'runs-failure' && !recovered) return unavailable(); },
    'PATCH /agents/:id': write, 'POST /agents': write, 'PATCH /schedules/:id': write,
    'DELETE /agents/:id': remove, 'DELETE /schedules/:id': remove,
    'GET /events': () => { if (scene === 'offline' && !recovered) return unavailable(); },
  });
  const owner = createSceneRuntime({
    baseUrl: 'https://editor-story.invalid', token: 'story', computerId: `editor-${scene}`,
    connectionId: `editor-${scene}`, pairingMethod: 'development',
  }, gateway.fetch);
  return {
    get session() { return owner.session; }, runtime: owner.runtime, gateway,
    start: (session) => owner.start(session),
    stop: () => { clearTimeout(transition); gate.resolve(); gateway.disconnect(); owner.stop(); },
    recover: () => { recovered = true; gateway.disconnect(); owner.session.editorOperations.recover(); }, release: () => gate.resolve(),
    updateSchedule: (name) => { gateway.state.schedules = gateway.state.schedules.map(row => ({ ...row, name, updated_at: row.updated_at + 1 })); gateway.emit(gateway.event('resource.changed', { kind: 'schedule', id: schedule.id, agent_id: agent.id, op: 'updated' })); },
    updateAgent: (fields) => { gateway.state.agentDetails.set(agent.id, { ...gateway.state.agentDetails.get(agent.id)!, ...fields }); gateway.state.agents = gateway.state.agents.map(row => row.id === agent.id ? { ...row, ...fields } : row); gateway.emit(gateway.event('resource.changed', { kind: 'agent', id: agent.id, op: 'updated' })); },
    removeAgent: () => { gateway.state.agents = gateway.state.agents.filter(row => row.id !== agent.id); gateway.state.agentDetails.delete(agent.id); gateway.emit(gateway.event('resource.changed', { kind: 'agent', id: agent.id, op: 'deleted' })); },
    revokeCapability: () => { const rows = gateway.state.capabilities.get(agent.id)!; gateway.state.capabilities.set(agent.id, rows.map(row => ({ ...row, status: 'disabled', reason: '已在别处停用' }))); gateway.emit(gateway.event('resource.changed', { kind: 'agent', id: agent.id, op: 'updated' })); },
  };
}
