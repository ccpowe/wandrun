import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Schedule } from '../src/gateway/api.ts';
import type { EditorOperation } from '../src/gateway/editor-operation.ts';
import { scheduleEditorReducer as reduce, selectScheduleEditor as select, type ScheduleEditorState, type ScheduleEditorExternal } from '../src/lib/schedule-editor.ts';

const identity = { sessionId: 's1', resourceId: 'timer' };
const schedule: Schedule = { id: 'timer', agent_id: 'agent', name: '日报', content: '总结新闻', rule: { kind: 'daily', time: '08:00' }, timezone: 'Asia/Shanghai', enabled: true, ended: false, next_run_at: 100, created_at: 1, updated_at: 1 };
const loading: ScheduleEditorState = { ...identity, status: 'loading' };
const external: ScheduleEditorExternal = { ...identity, agentId: 'agent', offline: false, deleted: false, fresh: true, current: schedule };
const loaded = reduce(loading, { type: 'adopt-initial', ...identity, current: schedule });
function editing() {
  assert.equal(loaded.status, 'editing');
  if (loaded.status !== 'editing') throw new Error('Missing editor');
  return loaded;
}
const dirty = reduce(editing(), { type: 'change', draft: { ...editing().draft, name: '本地稿' } });
const outcome: EditorOperation = { operationId: 'write', resource: 'schedule', id: 'timer', action: 'save', status: 'unknown', error: '', reconciled: false };

test('schedule-editor.A1 A2 初次采纳认访问身份，旧缓存不能建稿，采纳一次收敛', () => {
  assert.equal(select(loading, { ...external, fresh: false }).adoption, null);
  const adoption = select(loading, external).adoption!;
  assert.equal(reduce(loading, { ...adoption, sessionId: 'old' } as typeof adoption), loading);
  const state = reduce(loading, adoption);
  assert.equal(select(state, external).adoption, null);
  assert.equal(select(state, { ...external, fresh: false }).phase, 'editing');
});
test('schedule-editor.T1 B6 无修改采纳最新，有草稿时只提示，不覆盖', () => {
  const current = { ...schedule, name: '远端稿' };
  const input = { ...external, current };
  assert.equal(select(dirty, input).adoption, null);
  assert.equal(select(dirty, input).externalChange, true);
  const adoption = select(loaded, input).adoption!;
  const state = reduce(loaded, adoption);
  assert.equal(select(state, input).adoption, null);
  assert.equal(select(state, input).draft?.name, '远端稿');
});
test('schedule-editor.T2 B7 重载取消保留稿；失败不舍弃，成功才换基线', () => {
  const dialog = reduce(dirty, { type: 'dialog', dialog: 'reload' });
  assert.equal(select(reduce(dialog, { type: 'dialog', dialog: null }), external).draft?.name, '本地稿');
  const pending = reduce(dialog, { type: 'started', action: 'reloading', operationId: 'reload' });
  const failed = reduce(pending, { type: 'failed', operationId: 'reload', message: '读取失败' });
  assert.equal(select(failed, external).draft?.name, '本地稿');
  const success = reduce(pending, { type: 'reloaded', operationId: 'reload', current: { ...schedule, name: '新基线' } });
  assert.equal(select(success, { ...external, current: undefined }).draft?.name, '新基线');
});
test('schedule-editor.A5 A6 离线仍可编辑 / 放弃，不能自动保存；校验失败返回不重复保存', () => {
  const offline = select(dirty, { ...external, offline: true });
  assert.equal(offline.canEdit, true); assert.equal(offline.canSave, false); assert.equal(offline.canBack, true); assert.equal(offline.autoSaveOnLeave, false);
  const invalid = reduce(dirty, { type: 'validation-failed', message: '名称无效' });
  assert.equal(select(invalid, external).autoSaveOnLeave, false);
  const corrected = reduce(invalid, { type: 'change', draft: editing().draft });
  assert.equal(select(corrected, external).error, '');
});
for (const action of ['saving', 'deleting'] as const) {
  test(`schedule-editor.T4 B5 D2 D4 ${action} 拒绝重复命令与旧结果，失败保留稿，unknown 优先`, () => {
    const pending = reduce(dirty, { type: 'started', action, operationId: 'write' });
    assert.equal(reduce(pending, { type: 'started', action, operationId: 'repeat' }), pending);
    assert.equal(reduce(pending, { type: 'failed', operationId: 'old', message: '旧错误' }), pending);
    assert.equal(select(pending, { ...external, outcome }).phase, 'unknown');
    assert.equal(select(pending, { ...external, outcome }).canBack, true);
    assert.equal(select(pending, { ...external, outcome, deleted: true }).phase, 'gone');
    const failed = reduce(pending, { type: 'failed', operationId: 'write', message: '明确拒绝' });
    assert.equal(select(failed, external).draft?.name, '本地稿');
    assert.equal(select(failed, external).dialog, action === 'deleting' ? 'delete' : null);
  });
}
test('schedule-editor.B5 T4 核对仅认真实操作且一次采纳，旧 Query 不覆盖核对后的实际值', () => {
  const pending = reduce(dirty, { type: 'started', action: 'saving', operationId: 'write' });
  const recovered = { ...outcome, status: 'synced' as const, reconciled: true, value: { ...schedule, name: '实际值' } };
  const input = { ...external, outcome: recovered };
  assert.equal(select(pending, { ...input, outcome: { ...recovered, operationId: 'old' } }).adoption, null);
  const adoption = select(pending, input).adoption!;
  const state = reduce(pending, adoption);
  assert.equal(select(state, input).adoption, null);
  assert.equal(select(state, input).draft?.name, '实际值');
  const changed = reduce(state, { type: 'change', draft: { ...editing().draft, name: '后来输入' } });
  assert.equal(reduce(changed, adoption), changed);
});
test('schedule-editor.T5 保存成功更新基线但不关闭保留的路由，返回后可继续编辑', () => {
  const pending = reduce(dirty, { type: 'started', action: 'saving', operationId: 'write' });
  const saved = reduce(pending, { type: 'saved', operationId: 'write', current: { ...schedule, name: '本地稿' } });
  assert.equal(saved.status, 'editing');
  assert.equal(select(saved, external).dirty, false);
  const changed = reduce(saved, { type: 'change', draft: { ...editing().draft, name: '再次编辑' } });
  assert.equal(select(changed, external).draft?.name, '再次编辑');
  assert.equal(select(changed, external).dirty, true);
});
test('schedule-editor.D3 T5 删除成功终态与导航权限分离；已关闭不再忙且吸收旧事件', () => {
  const pending = reduce(dirty, { type: 'started', action: 'deleting', operationId: 'delete' });
  const closed = reduce(pending, { type: 'deleted', operationId: 'delete' });
  assert.equal(closed.status, 'closed');
  assert.equal(select(closed, external).busy, false);
  assert.equal(reduce(closed, { type: 'change', draft: editing().draft }), closed);
  assert.equal(reduce(closed, { type: 'adopt-initial', ...identity, current: schedule }), closed);
});

for (const action of ['save', 'delete'] as const) test(`schedule-editor.T4 ${action} 未知期间重入按本次 GET 建只读表单，核对后一次收敛`, () => {
  const unknown = { ...external, outcome: { ...outcome, action } };
  const adoption = select(loading, unknown).adoption;
  assert.equal(adoption?.type, 'adopt-initial');
  const state = reduce(loading, adoption!);
  assert.equal(select(state, unknown).draft?.name, schedule.name);
  assert.equal(select(state, unknown).canEdit, false);
  assert.equal(select(state, unknown).notice, action === 'delete' ? '上次删除结果未确认，正在核对。' : '上次保存结果未确认，正在核对。');
  assert.equal(select(state, unknown).dirty, false);
  const recovered = { ...unknown, outcome: { ...outcome, action, status: 'synced' as const, reconciled: true, value: { ...schedule, name: '核对实际内容' } } };
  const recovery = select(state, recovered).adoption!;
  const settled = reduce(state, recovery);
  assert.equal(select(settled, recovered).draft?.name, '核对实际内容');
  assert.equal(select(settled, recovered).canEdit, true);
  assert.equal(select(settled, recovered).adoption, null);
  assert.equal(select(state, { ...recovered, outcome: { ...recovered.outcome, value: null } }).phase, 'gone');
});

test('schedule-editor.B7 A6 重载读取失败不成为保存拒绝；读取恢复后原稿仍可返回自动保存', () => {
  const pending = reduce(dirty, { type: 'started', action: 'reloading', operationId: 'reload' });
  const failed = reduce(pending, { type: 'failed', operationId: 'reload', message: '读取失败' });
  const selection = select(failed, external);
  assert.equal(selection.draft?.name, '本地稿');
  assert.equal(selection.error, '');
  assert.equal(selection.autoSaveOnLeave, true);
});

