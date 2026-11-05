import type { AgentDetail, AgentSummary } from '../gateway/api';
import type { ChatSession } from '../gateway/session';
import type { SessionRuntime } from '../lib/session-context';
import { FakeGateway, jsonResponse, unavailable } from './fake-gateway';
import { createSceneRuntime } from './scene-session';

export type AgentListScene = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A6Empty' | 'D1' | 'D2' | 'D3' | 'D4';
export type AgentListScenario = {
  readonly session: ChatSession; runtime: SessionRuntime;
  readonly opens: number;
  recover(): void;
  disconnect(): void;
  reconnect(): void;
  start(session?: ChatSession): Promise<void>;
  stop(): void;
};
const samples = [
  ['planner', 'planner', '理解需求，简单任务直接完成；复杂任务交给伙伴'],
  ['search_agent', 'search_agent', '检索网页与公开仓库资料、技术来源'],
  ['executor', 'executor', '执行明确的子任务，验证结果并报告'],
  ['browser_agent', 'browser_agent', '用浏览器打开网页、填写表单与验证'],
  ['research_assistant', 'research_assistant', '整理论文与长文资料'],
  ['device_agent', 'device_agent', '操作和验证移动设备'],
] as const;

/** HTTP/SSE peer only: page, session, API parsing and retry are production code. */
export function agentListScenario(scene: AgentListScene = 'A1'): AgentListScenario {
  let rows: AgentSummary[] = Array.from({ length: scene === 'A3' || scene === 'A6Empty' ? 0 : scene === 'D4' ? 1 : scene === 'D3' ? 100 : 6 }, (_, index) => {
    const sample = samples[index % samples.length];
    return { id: index < 6 ? sample[0] : `agent-${index + 1}`, name: index < 6 ? sample[1] : `Agent ${index + 1}`,
      avatar: index % 8, description: sample[2], workers: [], environment: 'local', latest_conversation: null, unread: false };
  });
  if (scene === 'D1') rows[0] = { ...rows[0], name: '帮你理解系统设计并把复杂问题讲清楚的长期研究伙伴'.repeat(2), description: '特别长的说明文字，用于检查头像与左滑编辑是否保持可点击，名字和说明应分别单行省略。'.repeat(3) };
  if (scene === 'D2') rows = rows.map(row => ({ ...row, name: '研究助手', avatar: 1 }));
  const details = new Map<string, AgentDetail>(rows.map(row => [row.id, {
    ...row, system_prompt: '完成任务。', model: 'offline', reasoning_effort: null, fast_mode: false,
    mcp_servers: [], searchable_mcp_servers: [], skills: [], code_mode: true, environment: 'local', member_of: [],
  }]));
  let reads = 0;
  let opens = 0;
  let readFailure = scene === 'A4';
  let holdRead = scene === 'A2' || scene === 'A6Empty';
  let offline = scene === 'A6Empty';
  let transition: ReturnType<typeof setTimeout> | undefined;
  const held = new Set<(response: Response) => void>();
  const snapshot = () => ({ agents: gateway.state.agents, as_of_seq: gateway.state.seq, order_revision: gateway.state.orderRevision });
  const emit = () => gateway.emit(gateway.event('resource.changed', { kind: 'agent', id: gateway.state.agents[0]?.id, op: 'updated' }));
  const gateway = new FakeGateway({ agents: rows, agentDetails: details }, {
    'GET /agents': ({ init }) => {
      reads++;
      if (holdRead) {
        const { promise, resolve, reject } = Promise.withResolvers<Response>();
        held.add(resolve);
        init.signal?.addEventListener('abort', () => { held.delete(resolve); reject(new Error('closed')); }, { once: true });
        return promise;
      }
      if (readFailure) return unavailable('目录不可用');
      if (reads === 1 && (scene === 'A5' || scene === 'A6')) transition = setTimeout(() => {
        if (scene === 'A5') { readFailure = true; emit(); }
        else { offline = true; gateway.disconnect(); }
      }, 350);
    },
    'POST /conversations': () => { opens++; },
    'GET /events': () => { if (offline) throw new TypeError('offline'); },
  });
  const owner = createSceneRuntime({
    baseUrl: 'https://agent-list-story.invalid', token: 'story', computerId: `agent-list-story-${scene}`,
    connectionId: `agent-list-story-${scene}`, pairingMethod: 'development',
  }, gateway.fetch);
  return {
    get session() { return owner.session; }, runtime: owner.runtime,
    get opens() { return opens; },
    recover() { readFailure = holdRead = offline = false; for (const resolve of held) resolve(jsonResponse(snapshot())); held.clear(); owner.session.agents.refresh(); owner.session.reconnectNow(); },
    disconnect() { offline = true; gateway.disconnect(); },
    reconnect() { offline = false; owner.session.reconnectNow(); },
    start(session) { return owner.start(session); },
    stop() { clearTimeout(transition); gateway.disconnect(); owner.stop(); held.clear(); },
  };
}
