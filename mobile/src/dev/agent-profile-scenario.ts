import type { AgentDetail, AgentMemory, AgentSummary, BrowserTask, Conversation, MemoryScope, Schedule } from '../gateway/api';
import type { ChatSession } from '../gateway/session';
import type { SessionRuntime } from '../lib/session-context';
import { FakeGateway, jsonResponse, unavailable, type GatewayOverrides } from './fake-gateway';
import { createSceneRuntime } from './scene-session';

export type ProfileScene = `${'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'}${number}` | 'E4Recovery' | 'E4Stale' | 'C5Failure' | 'C1Stale' | 'C5Stale' | 'D2Many' | 'E2Long' | 'F1Failure' | 'F3Pending' | 'G1Failure';
export type ProfileScenario = {
  readonly session: ChatSession; runtime: SessionRuntime; id: string; start: (session?: ChatSession) => Promise<void>; stop: () => void;
  release: () => void; recover: () => void; changeMemory: (content: string) => void; changeSchedules: (name: string) => void;
  failDetailRead: (kind: 'unavailable' | 'not-found') => void;
};
const sha = 'a'.repeat(64);
const detailPath = (scope: MemoryScope, slug: string) => `/.wandrun/memory/${scope}/details/${slug}/${sha}.md`;

/** Real pages and session; only HTTP responses and event bytes are supplied by the peer. */
export function agentProfileScenario(scene: ProfileScene = 'C3'): ProfileScenario {
  const agent: AgentSummary = { id: 'planner', name: '小万', avatar: 0, description: '理解需求，安排任务', workers: [], environment: 'local', latest_conversation: null, unread: false }
  const detail: AgentDetail = { ...agent, system_prompt: '', model: '', reasoning_effort: null, fast_mode: false, mcp_servers: [], searchable_mcp_servers: [], skills: [], code_mode: false, environment: 'local', member_of: [] };
  if (scene === 'E2Long') agent.name = detail.name = '帮你理解系统设计并把复杂问题讲清楚的长期研究伙伴';
  const member: AgentSummary = { ...agent, id: 'researcher', name: '研究员', description: '查阅原始资料并核对来源', workers: [] };
  const agents = [agent];
  if (scene === 'D2' || scene === 'D2Many' || scene === 'D4' || scene === 'D5') {
    detail.workers = ['researcher'];
    if (scene !== 'D4') agents.push(member);
    if (scene === 'D2Many') for (let i = 0; i < 18; i++) {
      const id = `member-${i}`; detail.workers.push(id); agents.push({ ...member, id, name: `研究伙伴 ${i + 1}` });
    }
  }
  let recovered = false;
  let released = false;
  let detailFailure: 'unavailable' | 'not-found' | null = null;
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  const { promise: refreshGate, resolve: resumeRefresh } = Promise.withResolvers<void>();
  let schedulesChanged = false;
  let memoryChanged = false;
  const release = () => { released = true; openGate(); };
  const fail = () => unavailable();
  const now = Math.floor(Date.now() / 1000);
  const utcDay = Math.floor(now / 86400) * 86400;
  const nextMorning = utcDay + 86400; // 08:00 Asia/Shanghai.
  const nextReport = nextMorning + 3600;
  const friday = utcDay + ((5 - new Date(now * 1000).getUTCDay() + 7) % 7) * 86400 + 12 * 3600;
  const nextRuns: Record<string, number> = { morning: nextMorning, weekly: friday > now ? friday : friday + 7 * 86400, news: nextReport };
  const browserBase = {
    task_id: 'browser-task', root_id: 'root', agent_id: agent.id, agent_name: agent.name,
    entry_agent_id: agent.id, entry_agent_name: agent.name, epoch: 1,
    environment_id: 'local', environment_name: '本机',
    capacity: { pages_used: 4, pages_registered: 4, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 },
    capacity_rejection: null, reason: null, requested_reason: null,
  };
  const browserTasks: BrowserTask[] = ['A5', 'B3', 'B4', 'B6', 'B7'].includes(scene) ? [
    { ...browserBase, id: 'login', state: 'requested', conversation_title: '查看订阅额度', current: 'signin',
      requested_reason: '请完成登录后交还给小万',
      pages: [{ id: 'signin', title: '登录账户', url: 'https://platform.openai.com/login' }] },
    { ...browserBase, id: 'research', task_id: 'research-task', state: 'agent', conversation_title: '整理 Agent 开发资料', current: 'docs',
      pages: [{ id: 'docs', title: 'Agents SDK', url: 'https://openai.github.io/openai-agents-python/' },
        { id: 'github', title: 'OpenAI Agents SDK', url: 'https://github.com/openai/openai-agents-python' }] },
    { ...browserBase, id: 'review', task_id: 'review-task', state: 'human', conversation_title: '核对框架文档', current: 'reference',
      pages: [{ id: 'reference', title: 'LangGraph 概览', url: 'https://docs.langchain.com/oss/python/langgraph/overview' }] },
  ] : [];
  let schedules: Schedule[] = ['C2', 'C5', 'C5Failure', 'C1Stale', 'C5Stale', 'C6', 'C7', 'C8'].includes(scene) ? [
    { id: 'morning', agent_id: agent.id, name: '每日英语微课程', content: '给我一份适合晨间阅读的英语微课程。', rule: { kind: 'daily', time: '08:00' },
      timezone: 'Asia/Shanghai', enabled: true, ended: false, next_run_at: nextRuns.morning, created_at: now - 86400, updated_at: now - 86400 },
    { id: 'weekly', agent_id: agent.id, name: '每周项目复盘', content: '整理本周项目进展，列出需要我决定的问题。', rule: { kind: 'weekly', time: '20:00', weekdays: [5] },
      timezone: 'Asia/Shanghai', enabled: false, ended: false, next_run_at: null, created_at: now - 86400, updated_at: now - 7200 },
    { id: 'news', agent_id: agent.id, name: 'AI 浏览器周报', content: '汇总最近一周 AI 浏览器与 Agent 框架的新动态。', rule: { kind: 'weekly', time: '09:00', weekdays: [new Date(nextReport * 1000).getUTCDay() || 7] },
      timezone: 'Asia/Shanghai', enabled: true, ended: false, next_run_at: nextRuns.news, created_at: now - 86400, updated_at: now - 3600 },
  ] : [];
  if (scene === 'C6') schedules = [{ ...schedules[0], name: '已结束的单次提醒', rule: { kind: 'once', local_at: '2026-10-01T08:00' }, ended: true, enabled: false, next_run_at: null }];
  const memory = (scope: MemoryScope): AgentMemory => ({ scope, ...(scope === 'work' ? { agent_id: agent.id } : {}),
    content: scene === 'E3' ? '' : scope === 'work' ? `## 工作方式\n\n- 先说明结论，再解释取舍。\n- 涉及代码时，给出可验证的例子。\n\n## 当前项目\n\n正在梳理 Wandrun 的资料页。\n\n- [项目约定](${detailPath(scope, 'project')})\n` : '## 关于你\n\n- 喜欢简洁、直接的中文。\n- 关注 Agent 的工作机制和设计取舍。\n',
    version: 'v1', limit: 1000, updated_at: now - 7200, updated_by: 'agent',
    details: scene === 'E3' ? {} : scope === 'work' ? { project: { path: detailPath(scope, 'project'), sha256: sha }, notes: { path: detailPath(scope, 'notes'), sha256: sha } } : {},
  });
  const records = { work: memory('work'), profile: memory('profile') };
  const bodies: Record<string, string> = { project: '## 项目约定\n\n每一步都要说明问题、决定和验证结果。\n\n保留索引与详情，不自动拼接内容。', notes: '这是一条尚未被索引引用的详情。' };
  let reads = 0;
  let conflictSent = false;
  const conversation: Conversation = {
    id: 'member-chat', agent_id: member.id, title: '研究任务', created_at: now, updated_at: now,
    last_activity_seq: 1, last_activity_at: now, read_seq: 1, last_agent_seq: 0,
    status: 'idle', unread: false, last_text: null, source: 'user', schedule_origin: null,
  };
  if (scene === 'D2' || scene === 'D2Many') member.latest_conversation = conversation;
  const workPath = '/agents/planner/memory';
  const readMemory: NonNullable<GatewayOverrides['GET /memory/profile']> = async ({ params }, respond) => {
    const response = await respond();
    if (scene === 'E1' || scene === 'F1') await gate;
    if (scene === 'E4Stale' && memoryChanged && !recovered) return fail();
    reads++;
    if ((!recovered && scene === 'E4') || (scene === 'E4Recovery' && reads <= 8)) return fail();
    if ((!recovered && scene === 'F1Failure') || (!recovered && scene === 'F5' && conflictSent)) return fail();
    if (params.slug) {
      if (scene === 'G1') await gate;
      if (scene === 'G1Failure' && !recovered) return fail();
    }
    return response;
  };
  const writeMemory: NonNullable<GatewayOverrides['PUT /memory/profile']> = async ({ params, init }) => {
    if (scene === 'F3Pending') await gate;
    if ((scene === 'G4' && init.method === 'PUT') || (scene === 'G7' && init.method === 'DELETE')) return fail();
    if (scene === 'F3' && !recovered) return fail();
    if ((scene === 'F4' || scene === 'F5' || scene === 'G5') && !conflictSent) {
      conflictSent = true;
      const path = params.id ? workPath : '/memory/profile';
      const current = gateway.state.memories.get(path)!;
      gateway.state.memories.set(path, { ...current, version: 'remote-v2', content: '## 最新记忆\n\n这是在别处写入的新内容。请核对后再保存你的草稿。', updated_by: 'user' });
    }
  };
  const gateway = new FakeGateway({
    agents, agentDetails: new Map([[agent.id, detail]]),
    conversations: scene === 'D2' || scene === 'D2Many' ? [conversation] : [],
    browserTasks, schedules, scheduleNextRuns: nextRuns,
    memories: new Map([[workPath, records.work], ['/memory/profile', records.profile]]),
    memoryBodies: new Map(Object.entries(bodies).map(([slug, content]) => [`${workPath}/details/${slug}`, content])),
    computer: { name: 'Storybook 电脑', online_since: now - 3600, uptime_seconds: 3600, cpu_percent: 12,
      memory: { used_bytes: 512 * 1024 ** 2, total_bytes: 4 * 1024 ** 3, percent: 12.5 },
      environments: [{ environment_id: 'local', environment_name: '本机', capacity: browserBase.capacity }] },
  }, {
    'GET /agents/:id': async () => {
      if (scene === 'A2' || scene === 'D1') await gate;
      if (scene === 'A1' || detailFailure === 'not-found') return jsonResponse({ error: { code: 'not_found', message: 'Agent 不存在' } }, 404);
      if ((scene === 'A4' && !recovered) || detailFailure === 'unavailable') return fail();
    },
    'GET /browser-tasks': async () => {
      if (scene === 'B1') await gate;
      if (scene === 'B5' && !recovered) return fail();
    },
    'DELETE /browser-tasks/:id': async () => {
      if (scene === 'B6' && !released) await gate;
      if (scene === 'B7' && !recovered) return jsonResponse({ error: { code: 'conflict', message: '无法关闭浏览器任务' } }, 409);
    },
    'GET /agents/:id/schedules': async (_, respond) => {
      const response = await respond();
      if (scene === 'C1' || (scene === 'C1Stale' && !schedulesChanged)) await gate;
      if (scene === 'C5Stale' && released && !recovered) await refreshGate;
      if (scene === 'C4' && !recovered) return fail();
      return response;
    },
    'PATCH /schedules/:id': async (_, respond) => {
      if (scene === 'C8' && !recovered) { await respond(); return fail(); }
      if (scene === 'C5' && !released) await gate;
      if (scene === 'C5Failure' && !recovered) return jsonResponse({ error: { code: 'rejected', message: '当前定时不能更新' } }, 400);
      const response = await respond();
      if (scene === 'C5Stale') await gate;
      return response;
    },
    'GET /schedules/:id': () => { if (scene === 'C8' && !recovered) return fail(); },
    'GET /memory/profile': readMemory,
    'GET /agents/:id/memory': readMemory,
    'GET /memory/profile/details/:slug': readMemory,
    'GET /agents/:id/memory/details/:slug': readMemory,
    'PUT /memory/profile': writeMemory,
    'PUT /agents/:id/memory': writeMemory,
    'PUT /memory/profile/details/:slug': writeMemory,
    'PUT /agents/:id/memory/details/:slug': writeMemory,
    'DELETE /memory/profile/details/:slug': writeMemory,
    'DELETE /agents/:id/memory/details/:slug': writeMemory,
    'GET /events': () => { if (scene === 'A5' && !recovered) return fail(); },
  });
  const owner = createSceneRuntime({
    baseUrl: 'https://profile-story.invalid', token: 'story', computerId: `profile-story-${scene}`,
    connectionId: `profile-story-${scene}`, pairingMethod: 'development',
  }, gateway.fetch);
  return {
    get session() { return owner.session; }, runtime: owner.runtime, id: agent.id,
    start: (session) => owner.start(session),
    stop: () => { release(); resumeRefresh(); gateway.disconnect(); owner.stop(); },
    release, recover: () => { recovered = true; detailFailure = null; release(); resumeRefresh(); },
    failDetailRead: (kind) => {
      detailFailure = kind;
      gateway.emit(gateway.event('resource.changed', { kind: 'agent', id: agent.id, op: 'updated' }));
    },
    changeMemory: (content) => {
      memoryChanged = true;
      const event = gateway.event('resource.changed', { kind: 'memory', scope: 'work', id: agent.id, op: 'updated' });
      gateway.state.memories.set(workPath, { ...gateway.state.memories.get(workPath)!, content, version: `remote-${event.seq}`, updated_by: 'user' });
      gateway.emit(event);
    },
    changeSchedules: (name) => {
      schedulesChanged = true;
      gateway.state.schedules = gateway.state.schedules.map(item => ({ ...item, name: item.id === 'morning' ? name : item.name, enabled: false, next_run_at: null }));
      gateway.emit(gateway.event('resource.changed', { kind: 'schedule', id: 'morning', agent_id: agent.id, op: 'updated' }));
    },
  };
}
