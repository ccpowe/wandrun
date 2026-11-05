import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMemory, MemoryDetail } from '../src/gateway/api.ts';
import { memoryEditorReducer as reduce, selectMemoryEditor as select, type MemoryEditorKind, type MemoryEditorState, type MemoryEditorExternal } from '../src/lib/memory-editor.ts';
import { memoryCheckResult } from '../src/lib/memory-save-check.ts';

const identity = { sessionId: 's1', resourceId: 'work:agent:topic' };
const ref = { path: `/.wandrun/memory/work/details/topic/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
const index: AgentMemory = { scope: 'work', agent_id: 'agent', content: `摘要\n- [主题](${ref.path})`, version: 'v1', details: { topic: ref }, limit: 1000, updated_at: null, updated_by: null };
const detail: MemoryDetail = { scope: 'work', agent_id: 'agent', slug: 'topic', content: '原详情', version: 'v1', ...ref, limit: 65536 };
const external: MemoryEditorExternal = { ...identity, index, detail, indexFresh: true, detailFresh: true, deleted: false, checkStatus: 'idle', offline: false };
function start(kind: MemoryEditorKind = 'index'): MemoryEditorState { return { ...identity, status: 'loading', kind, slug: kind === 'create' ? '' : 'topic' }; }
function ready(kind: MemoryEditorKind = 'index') {
  const state = reduce(start(kind), { type: 'adopt-initial', ...identity, index, detail: kind === 'detail' ? detail : null });
  if (state.status !== 'ready') throw new Error('Editor not ready');
  return state;
}
function dirty(kind: MemoryEditorKind = 'index') {
  const state = kind === 'detail' ? reduce(ready(kind), { type: 'edit', index, detail }) : ready(kind);
  return reduce(state, { type: 'change', content: '本地稿' });
}
function working(action: 'save' | 'delete' | 'reload' = 'save', kind: MemoryEditorKind = 'index') {
  return reduce(dirty(kind), { type: 'started', action, operationId: 'operation' });
}

test('agent-profile.F1 G1 初次采纳闭环、来源身份与同版详情；后续读取失败不撤销草稿', () => {
  for (const kind of ['index', 'detail', 'create'] as const) {
    const loading = start(kind);
    assert.equal(select(loading, { ...external, indexFresh: false }).adoption, null);
    if (kind === 'detail') assert.equal(select(loading, { ...external, detail: { ...detail, version: 'other' } }).adoption, null);
    const event = select(loading, external).adoption!;
    assert.equal(reduce(loading, { ...event, sessionId: 'old' } as typeof event), loading);
    const state = reduce(loading, event);
    assert.equal(select(state, external).adoption, null);
    assert.equal(select(state, { ...external, index: undefined, indexFresh: false, detailFresh: false }).phase, 'ready');
  }
});
test('agent-profile.T5 E1 E5 切资源不复用旧草稿；缺失详情只读且无编辑入口', () => {
  assert.equal(select(ready(), { ...external, resourceId: 'other' }).phase, 'gone');
  const missing = select(start('detail'), { ...external, detail: null });
  assert.equal(missing.phase, 'missing'); assert.equal(missing.canStartEdit, false); assert.equal(missing.adoption, null);
});
test('agent-profile.T6 F4 外部版本只投影冲突，不改变本地 CAS 基线或正文', () => {
  const state = dirty();
  const selected = select(state, { ...external, index: { ...index, version: 'v2', content: '远端' } });
  assert.equal(selected.form?.base.version, 'v1'); assert.equal(selected.form?.content, '本地稿');
  assert.equal(selected.remoteIndex?.version, 'v2'); assert.equal(selected.canSave, false); assert.equal(selected.canEdit, true);
});
test('agent-profile.F4 G5 T6 T7 迟到 409 不能用旧快照替代更新的 Query 版本；保存与删除均保留原 CAS 草稿', () => {
  for (const [kind, action] of [['index', 'save'], ['detail', 'save'], ['detail', 'delete']] as const) {
    const draft = action === 'delete' ? reduce(ready('detail'), { type: 'review-delete', index, detail }) : dirty(kind);
    const pending = reduce(draft, { type: 'started', action, operationId: 'operation' });
    const rejected = reduce(pending, { type: 'conflict', operationId: 'operation', index: { ...index, version: 'v2', content: '旧冲突' } });
    const selected = select(rejected, { ...external, index: { ...index, version: 'v3', content: '最新索引' }, detail: { ...detail, version: 'v3', content: '最新详情' } });
    assert.equal(selected.remoteIndex?.content, '最新索引');
    if (kind === 'detail') assert.equal(selected.remoteDetail?.content, '最新详情');
    assert.equal(selected.form?.base.version, 'v1');
    assert.equal(action === 'delete' ? selected.form?.deleteIndex : selected.form?.content, action === 'delete' ? '摘要' : '本地稿');
    assert.equal(selected.canSave, false);
  }
});
test('agent-profile.T7 G2 G3 阅读直接显示新同版数据；显式编辑才采纳为 CAS 基线', () => {
  const nextIndex = { ...index, version: 'v2' }, nextDetail = { ...detail, version: 'v2', content: '新详情' };
  const state = ready('detail');
  const selected = select(state, { ...external, index: nextIndex, detail: nextDetail });
  assert.equal(selected.detail?.content, '新详情'); assert.equal(selected.form?.base.version, 'v1');
  const edited = reduce(state, { type: 'edit', index: nextIndex, detail: nextDetail });
  assert.equal(select(edited, external).form?.base.version, 'v2');
});
test('agent-profile.F5 G5 T6 重载只换基线，不丢稿；失败保留错误与原版本', () => {
  const state = working('reload');
  const nextIndex = { ...index, version: 'v2', content: '远端' };
  const reloaded = reduce(state, { type: 'reloaded', operationId: 'operation', index: nextIndex, detail: null });
  assert.equal(select(reloaded, { ...external, index: nextIndex }).form?.content, '本地稿');
  assert.equal(select(reloaded, { ...external, index: nextIndex }).form?.base.version, 'v2');
  assert.equal(select(reloaded, { ...external, index: nextIndex }).canSave, true);
  const failed = reduce(state, { type: 'failed', operationId: 'operation', message: '无法重载' });
  assert.equal(select(failed, external).form?.base.version, 'v1'); assert.equal(select(failed, external).form?.content, '本地稿');
});
test('agent-profile.T8 F3 G4 在途不接受重复提交/编辑/旧结果；明确失败保留草稿，可修改清错', () => {
  const state = working();
  assert.equal(reduce(state, { type: 'change', content: '不应出现' }), state);
  assert.equal(reduce(state, { type: 'started', action: 'save', operationId: 'repeat' }), state);
  assert.equal(reduce(state, { type: 'failed', operationId: 'old', message: '迟到' }), state);
  const selected = select(state, external);
  assert.equal(selected.busy, true); assert.equal(selected.canBack, false); assert.equal(selected.canSave, false);
  const failed = reduce(state, { type: 'failed', operationId: 'operation', message: '明确拒绝' });
  assert.equal(select(failed, external).form?.content, '本地稿');
  assert.equal(select(reduce(failed, { type: 'change', content: '修正' }), external).error, '');
});
test('agent-profile.T9 F8 G9 unknown 优先本地 busy；可返回但不能写，删除墓碑优先', () => {
  const state = working();
  const unknown = { ...external, checkStatus: 'unknown' as const };
  const selected = select(state, unknown);
  assert.equal(selected.phase, 'unknown'); assert.equal(selected.canBack, true); assert.equal(selected.canSave, false); assert.equal(selected.canEdit, false); assert.equal(selected.canOpen, false);
  assert.equal(select(state, { ...unknown, deleted: true }).phase, 'gone');
});
test('agent-profile.T10 核对一致采纳成功；closed 吸收迟到结果，不恢复已离开草稿', () => {
  const result = { outcome: 'saved' as const, index: { ...index, content: '本地稿', version: 'v2' }, detail: null };
  const state = reduce(working(), { type: 'checked', operationId: 'operation', result, close: true });
  assert.equal(state.status, 'closed');
  assert.equal(reduce(state, { type: 'adopt-initial', ...identity, index, detail }), state);
});
test('agent-profile.T11 核对原版本保留草稿，只允许用户再次写入；提示不被普通读取抹去', () => {
  const state = reduce(working(), { type: 'checked', operationId: 'operation', result: { outcome: 'not-saved', index, detail: null }, close: false });
  const selected = select(state, external);
  assert.equal(selected.form?.base.version, 'v1'); assert.equal(selected.form?.content, '本地稿'); assert.equal(selected.canSave, true);
  assert.equal(select(state, { ...external, index: { ...index } }).form?.result, '内容尚未保存，草稿仍在。');
});
test('agent-profile.T12 核对其他版本不认作写入失败，不自动采用 CAS；重载后才覆盖', () => {
  const nextIndex = { ...index, version: 'v2', content: '其他内容' };
  const state = reduce(working(), { type: 'checked', operationId: 'operation', result: { outcome: 'conflict', index: nextIndex, detail: null }, close: false });
  assert.equal(select(state, external).form?.base.version, 'v1'); assert.equal(select(state, external).canSave, false);
  const next = reduce(reduce(state, { type: 'started', action: 'reload', operationId: 'reload' }), { type: 'reloaded', operationId: 'reload', index: nextIndex, detail: null });
  assert.equal(select(next, { ...external, index: nextIndex }).form?.base.version, 'v2'); assert.equal(select(next, { ...external, index: nextIndex }).form?.content, '本地稿');
});
test('agent-profile.T13 T14 核对失败保持 unknown；重新进入只接受本次读取，不接续旧操作事件', () => {
  assert.equal(select(working(), { ...external, checkStatus: 'unknown' }).phase, 'unknown');
  const freshVisit = start();
  assert.equal(reduce(freshVisit, { type: 'checked', operationId: 'operation', result: { outcome: 'saved', index, detail: null }, close: true }), freshVisit);
});
test('agent-profile.G6 G7 T15 删除核对含完整索引稿；取消不写，未知确认删除需同时匹配无详情与索引', () => {
  const reviewing = reduce(ready('detail'), { type: 'review-delete', index, detail });
  assert.equal(select(reviewing, external).form?.deleteIndex, '摘要'); assert.equal(select(reviewing, external).dirty, true);
  const edited = reduce(reviewing, { type: 'delete-index', content: '用户核对稿' });
  const cancelled = reduce(edited, { type: 'cancel-delete' });
  assert.equal(select(cancelled, external).form?.mode, 'reading');
  const submission = { action: 'delete' as const, version: 'v1', content: '用户核对稿', slug: 'topic' };
  assert.equal(memoryCheckResult(submission, index, detail).outcome, 'not-saved');
  assert.equal(memoryCheckResult(submission, { ...index, version: 'v2', details: {}, content: '其他改动' }, null).outcome, 'conflict');
  const result = memoryCheckResult(submission, { ...index, version: 'v2', details: {}, content: '用户核对稿' }, null);
  assert.equal(result.outcome, 'saved');
  const pending = reduce(edited, { type: 'started', action: 'delete', operationId: 'delete' });
  assert.equal(select(pending, { ...external, checkStatus: 'unknown' }).canDelete, false);
  const finished = reduce(pending, { type: 'checked', operationId: 'delete', result, close: true });
  assert.equal(finished.status, 'closed');
});
test('agent-profile.F2 G3 Unicode 与 UTF-8 限额分别控制，超限不截断；断线不提前禁记忆领域命令', () => {
  const indexDraft = reduce(ready(), { type: 'change', content: '字'.repeat(1001) });
  assert.equal(select(indexDraft, external).canSave, false); assert.equal(select(indexDraft, external).form?.content.length, 1001);
  const offline = select(dirty(), { ...external, offline: true });
  assert.equal(offline.canEdit, true); assert.equal(offline.canBack, true); assert.equal(offline.canSave, true); assert.equal(offline.canReload, true);
  assert.equal(select(ready('detail'), { ...external, offline: true }).canDelete, true);
});

test('agent-profile.F3 G4 PUT 404 只接收当前操作，进入 gone 后不再忙且旧回执不能复活', () => {
  const pending = working();
  assert.equal(reduce(pending, { type: 'agent-gone', operationId: 'old' }), pending);
  const gone = reduce(pending, { type: 'agent-gone', operationId: 'operation' });
  assert.equal(select(gone, external).phase, 'gone');
  assert.equal(select(gone, external).busy, false);
  assert.equal(select(gone, external).canBack, true);
  assert.equal(reduce(gone, { type: 'failed', operationId: 'operation', message: '迟到' }), gone);
});
