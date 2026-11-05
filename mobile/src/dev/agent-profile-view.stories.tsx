import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { AgentProfileView } from '../components/agent-profile-view';
import { Text } from '../components/ui/text';
import type { AgentDetail, AgentSummary, Schedule } from '../gateway/api';
import { selectAgentProfile, type AgentProfileState } from '../lib/agent-profile';
import { FoundationFrame } from './foundation-frame';
import { SceneProviders } from './scene-providers';

const agent: AgentSummary = { id: 'planner', name: '小万', avatar: 0, description: '理解需求，安排任务', workers: [], environment: 'local', latest_conversation: null, unread: false };
const detail: AgentDetail = { ...agent, system_prompt: '', model: 'offline', reasoning_effort: null, fast_mode: false, mcp_servers: [], searchable_mcp_servers: [], skills: [], code_mode: false, environment: 'local', member_of: [] };
const schedule: Schedule = { id: 'morning', agent_id: agent.id, name: '每日英语微课程', content: '晨间阅读', rule: { kind: 'daily', time: '08:00' }, timezone: 'Asia/Shanghai', enabled: true, ended: false, next_run_at: null, created_at: 0, updated_at: 0 };

/** Explicit view facts: held writes need no timers, network, or special routes. Callbacks are recorded, not simulated HTTP. */
function ProfileViewStory({ phase = 'pending', theme = 'light' }: { phase?: 'pending' | 'unknown' | 'failed'; theme?: 'light' | 'dark' }) {
  const [action, record] = useState('');
  const state: AgentProfileState = phase === 'pending'
    ? { status: 'updating-schedule', tab: 'schedules', operationId: 'write', scheduleId: schedule.id }
    : { status: 'viewing', tab: 'schedules' };
  const selection = selectAgentProfile(state, { id: agent.id, detail, detailFailed: false, gone: false, agents: [agent], listLoaded: true, listFailed: false, offline: false, schedules: [schedule], scheduleFailed: false, schedulePaused: false, memoryFailed: false, browserFailed: false,
    scheduleReceiptRevision: 0, scheduleReadRevision: 0,
    operations: phase === 'unknown' ? [{ operationId: 'write', resource: 'schedule', id: schedule.id, action: 'save', status: 'unknown', error: '响应中断', reconciled: false }] : [] });
  return <FoundationFrame theme={theme} scrollable={false}><SceneProviders>
    <AgentProfileView selection={selection} name={agent.name} status="无进行中对话" detailFailed={false}
      feedback={selection.scheduleUnknown ? '保存结果未确认，正在核对…' : phase === 'failed' ? '无法更新定时：定时暂时不能修改' : null} scheduleUpdateFailed={phase === 'failed'} connectionBanner={null}
      workMemory={{ memory: null, error: '' }} sharedMemory={{ memory: null, error: '' }} browserContent={() => null}
      onClose={() => record('关闭')} onEdit={() => record('编辑 Agent')} onTab={tab => record(`标签：${tab}`)} onMember={member => record(`成员：${member.id}`)}
      onToggle={(row, enabled) => record(`开关：${row.id}=${enabled}`)} onSchedule={id => record(`定时：${id}`)} onWorkMemory={() => record('工作记忆')} onSharedMemory={() => record('共享记忆')} />
    {action ? <Text variant="caption" className="px-4 py-2 text-muted-foreground">最近操作：{action}</Text> : null}
  </SceneProviders></FoundationFrame>;
}
const meta = { title: 'agent-profile-view', component: ProfileViewStory, parameters: { fullScreen: true } } satisfies Meta<typeof ProfileViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const C5Pending: Story = { name: 'C5 开关写入中', args: {} };
export const C5PendingDark: Story = { name: 'C5 开关写入中（深色）', args: { theme: 'dark' } };
export const C8Unknown: Story = { name: 'C8 写入结果未确认，只读核对', args: { phase: 'unknown' } };
export const C8UnknownDark: Story = { name: 'C8 写入结果未确认（深色）', args: { phase: 'unknown', theme: 'dark' } };
export const C5Failed: Story = { name: 'C5 明确拒绝，可再次操作', args: { phase: 'failed' } };
