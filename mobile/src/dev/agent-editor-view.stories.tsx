import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { AgentEditorView } from '../components/agent-editor-view';
import { AgentEditorLeaveSheets } from '../components/editor-leave-sheet';
import { Text } from '../components/ui/text';
import { agentEditorFeedback, blankAgentDraft, selectAgentEditor, type AgentEditorReadErrors, type AgentEditorState } from '../lib/agent-editor';
import { SceneProviders } from './scene-providers';

const identity = { sessionId: 'story', resourceId: 'planner' };
const draft = { ...blankAgentDraft({ default_model: 'offline', default_reasoning_effort: 'medium' }, []),
  name: '小万', description: '理解需求，安排任务', system_prompt: '先理解需求，给出可核对的结论。' };
const form = { ...identity, original: draft, draft: { ...draft, name: '新的名字' }, panel: 'main' as const, notice: '' as const };
const editing: AgentEditorState = { ...form, status: 'editing', error: '' };
const blocked = [{ kind: 'members' as const, title: '它是 1 个团队的成员', description: '研究员。先在它们的“团队成员”里移除它。' }];

/** Static view states use the live selector; actions are recorded, not commands. */
function ViewStory({ state, readErrors = {}, discardOpen = false, unknown = false, unknownOpen = false }: {
  state: AgentEditorState; readErrors?: AgentEditorReadErrors; discardOpen?: boolean; unknown?: boolean; unknownOpen?: boolean;
}) {
  const [lastAction, setLastAction] = useState('');
  const selection = selectAgentEditor(state, { ...identity, offline: false, deleted: false,
    outcome: unknown ? { operationId: 'save-1', resource: 'agent', id: 'planner', action: 'save', status: 'unknown', error: '', reconciled: false } : undefined });
  return <SceneProviders><View className="flex-1">
    <AgentEditorView selection={selection} id="planner" offline={false} feedback={agentEditorFeedback(selection, readErrors)}
      agents={[]} referencesLoaded referenceError={null} memberNames={{}} memberQuery=""
      catalog={{ models: [], fetched_at: 1, capabilities: { fast_mode: true } }} catalogLoading={false}
      skillCatalog={{ skills: [], loaded: true, error: null, fetchStatus: 'idle' }}
      connectorCatalog={{ connectors: [], loaded: true, error: null, fetchStatus: 'idle' }}
      capabilityCatalog={{ capabilities: [], error: '' }} environments={[{ id: 'local', name: 'Local', type: 'local', status: null }]}
      environmentsLoading={false} environmentsError="" connectionBanner={null} modelPicker={null}
      onSave={() => setLastAction('保存')}
      onBack={() => setLastAction('返回')} onChange={fields => setLastAction(`修改 ${Object.keys(fields).join(', ')}`)}
      onPanel={panel => setLastAction(`打开 ${panel}`)} onMemberQuery={query => setLastAction(`搜索 ${query}`)}
      onDeleteCheck={() => setLastAction('检查删除条件')} onDelete={() => setLastAction('删除')} onCloseDelete={() => setLastAction('关闭删除层')}
      onCapabilities={() => setLastAction('系统能力')} />
    <AgentEditorLeaveSheets ordinaryOpen={discardOpen} unknownOpen={unknownOpen} changes={['名字']} busy={selection.busy}
      onDiscard={() => setLastAction('放弃')} onContinue={() => setLastAction('继续编辑')}
      onUnknownLeave={() => setLastAction('离开')} onUnknownStay={() => setLastAction('继续停留')} />
    {lastAction ? <Text className="px-4 py-2 text-xs text-muted-foreground">Storybook：{lastAction}</Text> : null}
    <PortalHost />
  </View></SceneProviders>;
}
const meta = { title: 'agent-editor-view', component: ViewStory, args: { state: editing }, parameters: { fullScreen: true } } satisfies Meta<typeof ViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const A1: Story = { name: 'A1 视图 · 首次读取', args: { state: { ...identity, status: 'loading' } } };
export const B3: Story = { name: 'B3 视图 · 保存中', args: { state: { ...form, status: 'saving', operationId: 'save-1' } } };
export const B4: Story = { name: 'B4 视图 · 结果未确认，只读', args: { state: { ...form, status: 'saving', operationId: 'save-1' }, unknown: true } };
export const T2Leave: Story = { name: 'T2 视图 · 未确认离开前说明不保留', args: { ...B4.args, unknownOpen: true } };
export const B4Rejected: Story = { name: 'B4 视图 · 明确失败保留文字', args: { state: { ...editing, error: '当前配置不能保存，请检查后重试。' } } };
export const H1: Story = { name: 'H1 视图 · 删除条件核对中', args: { state: { ...form, status: 'checking-delete', operationId: 'check-1' } } };
export const H2: Story = { name: 'H2 视图 · 团队关系阻止删除', args: { state: { ...form, status: 'delete-blocked', reasons: blocked } } };
export const H3: Story = { name: 'H3 视图 · 删除确认', args: { state: { ...form, status: 'delete-confirm', name: draft.name, error: '' } } };
export const H4: Story = { name: 'H4 视图 · 删除中', args: { state: { ...form, status: 'deleting', name: draft.name, operationId: 'delete-1' } } };
export const H5: Story = { name: 'H5 视图 · 删除明确失败', args: { state: { ...form, status: 'delete-confirm', name: draft.name, error: '当前操作不能删除，请稍后重试。' } } };
export const A1Checking: Story = { name: 'A1 T2 视图 · 重入时上次仍在核对', args: { state: { ...identity, status: 'loading' }, unknown: true } };
export const A5Leave: Story = { name: 'A5 视图 · 放弃或继续编辑', args: { state: editing, discardOpen: true } };
export const B4Confirmed: Story = { name: 'B4 视图 · 核对已完成', args: { state: { ...editing, draft, notice: 'confirmed' } } };
export const B4NotSaved: Story = { name: 'B4 视图 · 上次未保存', args: { state: { ...editing, draft, notice: 'not-saved' } } };
export const B4Changed: Story = { name: 'B4 视图 · 外部已修改并同步', args: { state: { ...editing, draft, notice: 'changed' } } };
export const B7: Story = { name: 'B7 视图 · 名字下提示重名', args: { state: { ...editing, draft: { ...draft, name: '研究员' }, error: '已有同名 Agent', errorField: 'name' } } };
