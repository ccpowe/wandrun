import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { ScheduleEditorView } from '../components/schedule-editor-view';
import { AgentEditorLeaveSheets } from '../components/editor-leave-sheet';
import { Text } from '../components/ui/text';
import type { Schedule } from '../gateway/api';
import { selectScheduleEditor, type ScheduleEditorState } from '../lib/schedule-editor';
import { editableSchedule } from '../lib/schedules';
import { SceneProviders } from './scene-providers';

const identity = { sessionId: 'story', resourceId: 'morning' };
const current: Schedule = { id: 'morning', agent_id: 'planner', name: '每日新闻简报', content: '整理新闻，并保留原始来源。', rule: { kind: 'daily', time: '08:00' }, timezone: 'Asia/Shanghai', enabled: true, ended: false, next_run_at: 1793448000, created_at: 1, updated_at: 1 };
const original = editableSchedule(current);
const form = { ...identity, original, draft: { ...original, name: '未确认的简报名称' }, notice: '' };
const editing: ScheduleEditorState = { ...form, status: 'editing', error: '', dialog: null, deleteError: '' };
function ViewStory({ state, unknown = false, leaveOpen = false }: { state: ScheduleEditorState; unknown?: boolean; leaveOpen?: boolean }) {
  const [action, setAction] = useState('');
  const selection = selectScheduleEditor(state, { ...identity, agentId: 'planner', fresh: false, current, offline: false, deleted: false,
    outcome: unknown ? { operationId: 'save', resource: 'schedule', id: 'morning', action: 'save', status: 'unknown', error: '', reconciled: false } : undefined });
  return <SceneProviders><View className="flex-1"><ScheduleEditorView selection={selection} detail={current} offline={false}
    feedback={unknown ? '结果未确认，恢复连接后会核对' : selection.error || selection.notice} readFailure={null}
    runs={[]} runsLoading={false} runsLoaded runsError={false} hasMore={false}
    onBack={() => setAction('返回')} onSave={() => setAction('保存')} onChange={() => setAction('修改')} onDialog={() => setAction('确认层')}
    onReload={() => setAction('重载')} onDelete={() => setAction('删除')} onMore={() => setAction('分页')} onConversation={() => setAction('对话')} />
    <AgentEditorLeaveSheets ordinaryOpen={false} unknownOpen={unknown && leaveOpen} changes={['名称']} busy={selection.busy}
      onDiscard={() => setAction('放弃')} onContinue={() => setAction('继续编辑')} onUnknownStay={() => setAction('继续停留')} onUnknownLeave={() => setAction('离开')} />
    {action ? <Text variant="caption">Storybook: {action}</Text> : null}<PortalHost /></View></SceneProviders>;
}
const meta = { title: 'schedule-editor-view', component: ViewStory, args: { state: editing }, parameters: { fullScreen: true } } satisfies Meta<typeof ViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const B5Saving: Story = { name: 'B5 保存中', args: { state: { ...form, status: 'saving', operationId: 'save' } } };
export const B5Unknown: Story = { name: 'B5 未确认只读', args: { ...B5Saving.args, unknown: true } };
export const T4Leave: Story = { name: 'T4 未确认离开说明草稿不保留', args: { ...B5Unknown.args, leaveOpen: true } };
export const D2: Story = { name: 'D2 删除中', args: { state: { ...form, status: 'deleting', operationId: 'delete' } } };
export const D4: Story = { name: 'D4 明确删除失败留确认层', args: { state: { ...editing, dialog: 'delete', deleteError: '当前操作不能删除，请稍后重试。' } } };
