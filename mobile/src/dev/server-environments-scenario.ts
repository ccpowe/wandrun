import type { AgentDetail, BrowserTask, ExecutionEnvironment } from '../gateway/api.ts';
import type { FakeGateway } from './fake-gateway.ts';

/** HTTP-boundary facts for settings-computer C / E: provider machines, Agents' environments and live browser leases. */
export type ServerEnvironmentsScene = 'few' | 'many';

const machine = (name: string, status: string): ExecutionEnvironment => ({ id: `instabox-${name}`, machine_id: name, name, type: 'instabox', status });
const agent = (id: string, name: string, environment: string): AgentDetail => ({
  id, name, avatar: 0, description: '', workers: [], system_prompt: '', model: 'offline', reasoning_effort: null, fast_mode: false,
  code_mode: true, environment, member_of: [], skills: [], mcp_servers: [], searchable_mcp_servers: [] });
const lease = (id: string, agentId: string, agentName: string, environment: ExecutionEnvironment | null, pages: [string, string][]): BrowserTask => ({
  id, task_id: `root-${id}`, root_id: `root-${id}`, agent_id: agentId, entry_agent_id: agentId, entry_agent_name: agentName,
  conversation_title: '整理资料', state: 'agent', epoch: 1, current: pages[0]?.[0] ?? null,
  pages: pages.map(([page, url]) => ({ id: page, title: page, url })),
  environment_id: environment?.id ?? 'local', environment_name: environment?.name ?? 'Local',
  capacity: { pages_used: pages.length, pages_registered: pages.length, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 4 },
  capacity_rejection: null, reason: null, requested_reason: null });

export function seedServerEnvironments(peer: FakeGateway, scene: ServerEnvironmentsScene = 'few') {
  const wandBox = machine('wand-box', 'running');
  const buildBox = machine('build-box', 'starting');
  const machines = scene === 'few'
    ? [wandBox, buildBox, machine('research-box', 'suspended'), machine('old-box', 'error')]
    : [wandBox, machine('research-box', 'running'), machine('ci-box', 'running'), buildBox, machine('old-box', 'error'), machine('gpu-box', 'deleted'),
      ...Array.from({ length: 34 }, (_, i) => machine(`${['dev', 'eval', 'scrape', 'demo', 'data', 'test'][i % 6]}-box-${Math.floor(i / 6) + 1}`, 'suspended'))];
  peer.state.environments = [{ id: 'local', name: 'Local', type: 'local', status: null }, ...machines];
  const agents = [agent('test', 'test', 'local'), agent('wand', 'wand', wandBox.id), agent('build', 'build', buildBox.id),
    agent('research', 'research', machines.find(item => item.name === 'research-box')!.id)];
  for (const detail of agents) {
    peer.state.agents.push({ ...detail, latest_conversation: null, unread: false });
    peer.state.agentDetails.set(detail.id, detail);
  }
  peer.state.browserTasks.push(lease('local-lease', 'test', 'test', null, [['Mouse - Wikipedia', 'https://en.wikipedia.org/wiki/Mouse']]),
    lease('wand-lease', 'wand', 'wand', wandBox, [['YouTube', 'https://www.youtube.com/'], ['Release notes', 'https://docs.example.com/']]));
  peer.state.computer ??= { name: 'VM-0-3-ubuntu', online_since: 1, uptime_seconds: 7200, cpu_percent: 20,
    memory: { used_bytes: 1.9 * 1024 ** 3, total_bytes: 3.6 * 1024 ** 3, percent: 53 },
    environments: [{ environment_id: 'local', environment_name: 'Local', capacity: { pages_used: 1, pages_registered: 1, pages_creating: 0, pages_pending_cleanup: 0, pages_limit: 3 } }] };
}
