import { PortalHost } from '@rn-primitives/portal';
import type { Meta, StoryObj } from '@storybook/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { MemoryEditorView } from '../components/memory-editor-view';
import { MemoryDetailView } from '../components/memory-detail-view';
import { MemorySaveNotice } from '../components/memory-save-notice';
import { Text } from '../components/ui/text';
import type { AgentMemory, MemoryDetail } from '../gateway/api';
import { memoryEditorReducer, selectMemoryEditor, type MemoryEditorState } from '../lib/memory-editor';
import { FoundationFrame } from './foundation-frame';
import { SceneProviders } from './scene-providers';

const identity = { sessionId: 'story', resourceId: 'memory' };
const ref = { path: `/.wandrun/memory/work/details/project/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
const index: AgentMemory = { scope: 'work', agent_id: 'planner', content: `# 工作方式\n\n先理解问题，再给出结论。\n- [项目背景](${ref.path})`, version: 'v1', details: { project: ref }, limit: 1000, updated_at: null, updated_by: null };
const detail: MemoryDetail = { scope: 'work', agent_id: 'planner', slug: 'project', content: '# 项目背景\n\n保留原始来源，结论要能核对。', version: 'v1', ...ref, limit: 65536 };
const indexState = memoryEditorReducer({ ...identity, status: 'loading', kind: 'index', slug: '' }, { type: 'adopt-initial', ...identity, index, detail: null });
const detailState = memoryEditorReducer({ ...identity, status: 'loading', kind: 'detail', slug: 'project' }, { type: 'adopt-initial', ...identity, index, detail });
const edited = memoryEditorReducer(memoryEditorReducer(detailState, { type: 'edit', index, detail }), { type: 'change', content: '待保存的详情草稿' });
const saving = memoryEditorReducer(edited, { type: 'started', action: 'save', operationId: 'save' });
const deleting = memoryEditorReducer(memoryEditorReducer(detailState, { type: 'review-delete', index, detail }), { type: 'started', action: 'delete', operationId: 'delete' });
function ViewStory({ state = indexState, theme = 'light', checkStatus = 'idle', leaveOpen = false, remote = false }: {
  state?: MemoryEditorState; theme?: 'light' | 'dark'; checkStatus?: 'idle' | 'checking' | 'unknown'; leaveOpen?: boolean; remote?: boolean;
}) {
  const [action, setAction] = useState('');
  const selection = selectMemoryEditor(state, { ...identity, index: remote ? { ...index, content: '其他设备的新索引', version: 'v2', updated_by: 'user' } : index,
    detail, indexFresh: true, detailFresh: true, deleted: false, offline: false, checkStatus });
  const notice = <MemorySaveNotice status={checkStatus} online leaveOpen={leaveOpen} deleting={state.status === 'working' && state.action === 'delete'} onContinue={() => setAction('继续停留')} onLeave={() => setAction('离开')} />;
  const common = { selection, readError: null, online: true, notice,
    onBack: () => setAction('返回'), onSave: () => setAction('保存'), onContent: () => setAction('修改正文'), onReload: () => setAction('重新加载'), onOpen: () => setAction('详情') };
  return <FoundationFrame theme={theme} scrollable={false}><SceneProviders><View className="flex-1">
    {'kind' in state && state.kind === 'index' ? <MemoryEditorView {...common} scope="work" onShowCurrent={() => setAction('查看最新版本')} />
      : <MemoryDetailView {...common} title="项目背景" owner="小万的工作记忆" modified={null}
        onSlug={() => setAction('修改标识')} onEdit={() => setAction('编辑')} onReviewDelete={() => setAction('核对索引')} onDeleteIndex={() => setAction('修改索引')}
        onCancelDelete={() => setAction('取消删除')} onDeleteDialog={() => setAction('删除确认')} onDelete={() => setAction('删除')} />}
    {action ? <Text variant="caption">Storybook: {action}</Text> : null}<PortalHost />
  </View></SceneProviders></FoundationFrame>;
}
const meta = { title: 'memory-editor-view', component: ViewStory, parameters: { fullScreen: true } } satisfies Meta<typeof ViewStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const F2: Story = { name: 'F2 索引编辑 · 浅色', args: { state: indexState } };
export const F2Dark: Story = { name: 'F2 索引编辑 · 深色', args: { state: indexState, theme: 'dark' } };
export const F4: Story = { name: 'F4 别处更新保留索引草稿', args: { state: indexState, remote: true } };
export const G2: Story = { name: 'G2 详情阅读', args: { state: detailState } };
export const G3: Story = { name: 'G3 详情编辑 · 浅色', args: { state: edited } };
export const G3Dark: Story = { name: 'G3 详情编辑 · 深色', args: { state: edited, theme: 'dark' } };
export const G4: Story = { name: 'G4 详情保存中', args: { state: saving } };
export const G9: Story = { name: 'G9 保存未确认 · 只读核对中', args: { state: saving, checkStatus: 'checking' } };
export const G10: Story = { name: 'G10 核对失败仍未知 · 离开不保留草稿', args: { state: saving, checkStatus: 'unknown', leaveOpen: true } };
export const G11: Story = { name: 'G11 删除未确认 · 索引核对稿只读', args: { state: deleting, checkStatus: 'unknown' } };
