import type { AgentMemory, AgentSummary, BrowserTask, ComputerStatus, Conversation, GatewayEvent, TaskConversation } from '../gateway/api';
import type { ChatSession } from '../gateway/session';
import type { SessionRuntime } from '../lib/session-context';
import { FakeGateway, unavailable, type GatewayOverrides } from './fake-gateway';
import { createSceneRuntime } from './scene-session';

export type ChatScene = 'C3' | 'I1' | 'I2' | 'I3' | 'I4' | 'I8' | 'I9' | 'I11' | 'D8' | 'D10' | 'F2' | 'G3' | 'G4' | 'G5';
export type DrawerScene = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7';
export type EntryScene = 'J1' | 'J2' | 'J3' | 'J4' | 'J5' | 'J6' | 'J9';
export type ChatStoryState = ChatScene | DrawerScene | EntryScene;
export type ChatScenario = {
  readonly session: ChatSession; runtime: SessionRuntime; id: string; start(session?: ChatSession): Promise<void>; stop(): void;
  failNextWrite(): void;
  pauseWrites(): () => void;
  deleteFromPeer(id: string): void;
  reconnect(): void;
  recoverReads(): void;
  failAgentReads(): void;
};
const identities = [
  ['planner', '小万', 0], ['browser', '浏览器研究员', 3], ['executor', '代码搭档', 2],
  ['search', '论文与开源研究员', 1], ['writer', '写作与灵感编辑', 4], ['travel', '旅行规划', 5],
  ['learn', '语言学习教练', 6], ['data', '帮我把复杂事情想清楚的伙伴', 7],
] as const;

/** A deterministic gateway peer, not a page substitute: histories, reads and writes use real APIs. */
export function chatScenario(scene: ChatStoryState): ChatScenario {
  const now = Date.now() / 1000;
  let offline = false;
  let failWrite = false;
  let readsRecovered = false;
  let agentReadsFailed = scene === 'J5';
  let writeGate: PromiseWithResolvers<void> | undefined;
  let streaming: ReturnType<typeof setInterval> | undefined;
  let streamDelay: ReturnType<typeof setTimeout> | undefined;
  const blank = ['E2', 'E6', 'E7', 'G3', 'J3'].includes(scene);
  const agents: AgentSummary[] = identities.slice(0, scene === 'J4' ? 0 : 8).map(([id, name, avatar]) => ({ id, name, avatar, description: '', workers: [], environment: 'local', latest_conversation: null, unread: false }));
  const root: Conversation = { id: 'recent', agent_id: 'planner', title: blank ? '' : '近一周 AI 浏览器 Agent 动态',
    created_at: now - 7200, updated_at: now - 120, last_activity_seq: blank ? null : 90, last_activity_at: blank ? null : now - 120, read_seq: 200, last_agent_seq: 90, status: scene === 'I9' ? 'working' : scene === 'D10' ? 'failed' : 'idle', unread: false,
    last_text: blank ? null : '已经分三路查看，最后汇总成对比表。', source: 'user', schedule_origin: null };
  const roots = ['J4', 'J5', 'J6'].includes(scene) ? [] : [root];
  if ((scene.startsWith('E') && !['E2', 'E3'].includes(scene)) || scene === 'J2') {
    const titles = ['浏览器截图接口的鉴权方案', 'Agent 记忆机制的论文', '每日英语微课程', 'Playwright 等待超时原因', 'React Native 工程规范', '真机回归脚本整理', '周末城市散步路线', '把一段复杂的产品想法整理成清楚易懂、可以交给伙伴继续讨论的完整提纲'];
    for (let index = 0; index < (scene === 'E4' ? 30 : 5); index++) roots.push({
      ...root, id: `root-${index}`, agent_id: agents[(index + 1) % agents.length].id, title: titles[index % titles.length],
      updated_at: now - (index + 2) * 3600, last_activity_seq: 80 - index, last_activity_at: now - (index + 2) * 3600,
      last_text: index === 2 ? '每日微课程已准备好。' : '资料已整理。', unread: index === 2, source: index === 2 ? 'schedule' : 'user',
    });
  }
  const tasks: TaskConversation[] = Array.from({ length: ['I2', 'D10'].includes(scene) || blank ? 0 : scene === 'I3' ? 1 : scene === 'I11' ? 2 : scene === 'I4' ? 12 : 3 }, (_, index) => ({
    id: `child-${index}`, task_id: `child-${index}`, kind: 'task', root_id: root.id, root_title: root.title,
    creator_task_id: root.id, creator_agent_id: 'planner', agent_id: identities[1 + index % 3][0],
    initiator: 'planner', recipient: identities[1 + index % 3][0],
    title: ['官网定价与免费额度', '汇总成对比表', '论文与开源仓库'][index % 3] + (index >= 3 ? ` ${index + 1}` : ''),
    status: index <= 1 ? 'running' : index === 4 ? 'failed' : 'completed', error: null, unread: index === 0,
    read_seq: index === 0 ? 0 : 100, created_at: now - 3600, updated_at: now - (index + 1) * 120,
    branch_working: index <= 1,
  }));
  if (scene === 'I8') tasks.push({ ...tasks[2], id: 'grandchild', task_id: 'grandchild', creator_task_id: 'child-1', creator_agent_id: 'executor', agent_id: 'search', recipient: 'search', title: '读取研究员的结果' });
  const browserTasks: BrowserTask[] = tasks.length || scene === 'I9' ? [{
    id: 'browser-lease', task_id: scene === 'I9' ? root.id : 'child-0', root_id: root.id, agent_id: 'browser', entry_agent_id: 'planner',
    conversation_title: root.title, entry_agent_name: '小万', state: 'agent', epoch: 1, pages: [], current: null,
    environment_id: 'local', environment_name: '本机', capacity: { pages_used: 0, pages_registered: 0, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 },
    capacity_rejection: null, reason: null, requested_reason: null,
  }] : [];
  const histories = new Map<string, GatewayEvent[]>();
  histories.set(root.id, blank ? [] : [
    { seq: 89, type: 'message.user', conversation_id: root.id, at: now - 180, data: { text: '帮我梳理近一周 AI 浏览器 Agent 的动态，重点看定价和开源项目。' } },
    { seq: 90, type: 'message.agent', conversation_id: root.id, at: now - 120, data: { agent_id: 'planner', text: '好的，我分三路查看：官网定价交给浏览器研究员，论文与开源仓库交给研究员，最后由代码搭档汇总成对比表。' } },
    ...tasks.filter((task) => task.creator_task_id === root.id).map((task, index): GatewayEvent => ({ seq: 91 + index, type: 'task.created', conversation_id: root.id, at: task.created_at,
      data: { task_id: task.id, creator_task_id: root.id, creator_agent_id: 'planner', agent_id: task.agent_id, title: task.title, summary: task.title, status: task.status, timeline_ids: [root.id, task.id] } })),
  ]);
  if (scene === 'C3') histories.set(root.id, Array.from({ length: 40 }, (_, index): GatewayEvent => index % 2
    ? { seq: 51 + index, type: 'message.agent', conversation_id: root.id, at: now - 400 + index, data: { agent_id: 'planner', text: `第 ${index + 1} 条回复：${'整理资料并核对来源，'.repeat(3)}` } }
    : { seq: 51 + index, type: 'message.user', conversation_id: root.id, at: now - 400 + index, data: { text: `第 ${index + 1} 条问题` } }));
  if (scene === 'D10') histories.set(root.id, [
    { seq: 89, type: 'message.user', conversation_id: root.id, at: now - 180, data: { text: '帮我整理这周的工作安排。' } },
    { seq: 90, type: 'turn.failed', conversation_id: root.id, at: now - 120, data: { error: '模型尚未登录，请先在电脑上登录模型。' } },
  ]);
  if (scene === 'D8') histories.set(root.id, [
    { seq: 89, type: 'message.user', conversation_id: root.id, at: now - 180, data: { text: '整理今天的工作，并记住我的偏好。' } },
    { seq: 90, type: 'schedule.triggered', conversation_id: root.id, at: now - 170, data: { name: '每日工作整理' } },
    { seq: 91, type: 'memory.updated', conversation_id: root.id, at: now - 160, data: { scope: 'profile', agent_id: 'planner', summary: '已记住你的工作偏好' } },
    { seq: 92, type: 'context.compacted', conversation_id: root.id, at: now - 150, data: { agent_id: 'planner', summary_text: '保留今天的工作安排与用户偏好。' } },
    { seq: 93, type: 'context.compaction_failed', conversation_id: root.id, at: now - 140, data: { agent_id: 'planner', message: '模型响应超时' } },
    { seq: 94, type: 'takeover.ended', conversation_id: root.id, at: now - 130, data: { text: '你已交还操作，Agent 继续工作' } },
    { seq: 95, type: 'turn.stopped', conversation_id: root.id, at: now - 120, data: { was_working: true } },
  ]);
  if (scene === 'F2') histories.set(root.id, [{
    seq: 90, type: 'message.agent', conversation_id: root.id, at: now,
    data: { agent_id: 'planner', text: '图片读取失败时只保留图标占位。', attachments: [
      { id: 'unavailable-image', name: 'example.png', size: 1000, media_type: 'image/png' },
    ] },
  }]);
  for (const task of tasks) histories.set(task.id, [
    { seq: 30, type: 'message.task', conversation_id: root.id, at: now - 180, data: { text: '把下面三份资料汇总成一张对比表：定价、免费额度、是否开源、最近一次更新。', sender_task_id: task.creator_task_id, recipient_task_id: task.id, sender_agent_id: task.creator_agent_id, recipient_agent_id: task.agent_id, timeline_ids: [task.id] } },
    { seq: 31, type: 'message.agent', conversation_id: root.id, at: now - 120, data: { task_id: task.id, text: '收到。我先读研究员的结果，再等浏览器研究员的定价……', agent: task.agent_id, timeline_ids: [task.id] } },
  ]);
  if (scene === 'I9') histories.get(root.id)!.push({ seq: 120, type: 'browser_task.updated', conversation_id: root.id, at: now - 60, data: browserTasks[0] });
  for (const conversation of roots.slice(1)) histories.set(conversation.id, [{ seq: 80, type: 'message.agent', conversation_id: conversation.id, at: conversation.updated_at, data: { agent_id: conversation.agent_id, text: conversation.last_text } }]);
  const beforeWrite: NonNullable<GatewayOverrides['POST /conversations/:id/messages']> = async () => {
    if (writeGate) await writeGate.promise;
    if (failWrite) { failWrite = false; return unavailable('网关暂不可用，请稍后重试'); }
  };
  const historyFailure: NonNullable<GatewayOverrides['GET /conversations/:id/events']> = () => {
    if (!readsRecovered && (scene === 'G4' || scene === 'G5')) return unavailable('历史暂不可用');
  };
  const memories = new Map<string, AgentMemory>(['/memory/profile', ...agents.map(agent => `/agents/${agent.id}/memory`)].map(path => [path, {
    scope: path === '/memory/profile' ? 'profile' : 'work', content: '', version: 'story', details: {}, updated_at: null, updated_by: null, limit: 1000,
  }]));
  const gateway = new FakeGateway({
    seq: 200, agents, conversations: roots, conversationTemplate: root, tasks, histories, browserTasks, memories,
    filePreviews: new Map([['unavailable-image', { kind: 'image', width: 800, height: 600, duration_ms: null, page_count: null }]]),
    computer: {
      name: 'Wandrun 开发电脑', online_since: now - 7200, uptime_seconds: 7200, cpu_percent: 8,
      memory: { used_bytes: 4 * 1024 ** 3, total_bytes: 12 * 1024 ** 3, percent: 33 },
      environments: [{ environment_id: 'local', environment_name: '本机', capacity: browserTasks[0]?.capacity
        ?? { pages_used: 0, pages_registered: 0, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 8 } }],
    } satisfies ComputerStatus,
  }, {
    'GET /agents': ({ init }) => {
      if (agentReadsFailed) return unavailable('目录暂不可用');
      if (scene === 'J6') {
        const { promise, reject } = Promise.withResolvers<Response>();
        init.signal?.addEventListener('abort', () => reject(new Error('Story closed')), { once: true });
        return promise;
      }
    },
    'PATCH /conversations/:id': beforeWrite,
    'DELETE /conversations/:id': beforeWrite,
    'POST /conversations/:id/messages': beforeWrite,
    'POST /tasks/:id/messages': beforeWrite,
    'GET /conversations/:id/events': historyFailure,
    'GET /tasks/:id/events': historyFailure,
    'GET /events': () => { if (offline) throw new TypeError('Network request failed'); },
  });
  const owner = createSceneRuntime({
    baseUrl: 'https://chat-story.invalid', token: 'story', computerId: `chat-story-${scene}`,
    connectionId: `chat-story-${scene}`, pairingMethod: 'development',
  }, gateway.fetch);
  return { get session() { return owner.session; }, runtime: owner.runtime, id: scene === 'I8' ? 'child-1' : root.id,
    async start(providedSession) {
      await owner.start(providedSession);
      const active = owner.session;
      // C3: a reply keeps streaming (growing preview row) so a device can check follow / READ.
      if (scene === 'C3') {
        let tick = 0;
        // Starts after the chat has settled at the bottom (as after a send); opening a chat while a
        // row is already growing fast is a separate, pre-existing LegendList initial-scroll case.
        streamDelay = setTimeout(() => { streaming = setInterval(() => {
          tick++;
          gateway.emit({ type: 'draft.snapshot', data: { epoch: 'c3', revision: tick, as_of_seq: 90, drafts: [{ draft_id: 'stream', conversation_id: root.id,
            sender: root.id, agent: 'planner', phase: null, text: Array.from({ length: tick }, (_, line) => `流式第 ${line + 1} 行。`).join('\n') }] } } as unknown as GatewayEvent);
        }, 400); }, 5_000);
      }
      active.agents.refresh();
      await Promise.all(agents.map((agent) => active.refreshCollaborations(agent.id)));
      if (['E5', 'E7', 'G3', 'G5'].includes(scene)) {
        const disconnected = Promise.withResolvers<void>();
        const unsubscribe = active.subscribe(() => { if (active.connection !== 'open') disconnected.resolve(); });
        offline = true;
        gateway.disconnect();
        if (active.connection !== 'open') disconnected.resolve();
        await disconnected.promise;
        unsubscribe();
      }
      if (scene === 'E7') await active.send(root.id, '这条消息尚未送达');
      if (scene === 'G5') await active.stop(root.id);
    },
    failNextWrite() { failWrite = true; },
    pauseWrites() { writeGate = Promise.withResolvers<void>(); return () => { writeGate?.resolve(); writeGate = undefined; }; },
    reconnect() { offline = false; owner.session.reconnectNow(); },
    recoverReads() { readsRecovered = true; agentReadsFailed = false; },
    failAgentReads() { agentReadsFailed = true; },
    deleteFromPeer(id) {
      const index = roots.findIndex((item) => item.id === id);
      if (index < 0) return;
      roots.splice(index, 1);
      gateway.emit(gateway.event('conversation.deleted', { id }, id));
    },
    stop() { clearTimeout(streamDelay); clearInterval(streaming); writeGate?.resolve(); gateway.disconnect(); owner.stop(); },
  };
}
