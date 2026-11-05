import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentProfileReducer, selectAgentProfile, type AgentProfileExternal, type AgentProfileState } from '../src/lib/agent-profile.ts';

const idle: AgentProfileState = { status: 'viewing', tab: 'schedules' };
const updating = agentProfileReducer(idle, { type: 'toggle-started', scheduleId: 'daily', operationId: 'one' });
const external: AgentProfileExternal = { id: 'planner', detailFailed: false, gone: false, agents: [], listLoaded: true, listFailed: false, offline: false,
  scheduleFailed: false, schedulePaused: false, scheduleReceiptRevision: 0, scheduleReadRevision: 0, memoryFailed: false, browserFailed: false, operations: [] };
test('agent-profile.T20 changing tabs retains an in-flight operation identity', () => {
  assert.deepEqual(agentProfileReducer(updating, { type: 'tab', tab: 'memory' }), { status: 'updating-schedule', tab: 'memory', operationId: 'one', scheduleId: 'daily' });
  const waiting = agentProfileReducer(updating, { type: 'toggle-succeeded', operationId: 'one' });
  assert.deepEqual(agentProfileReducer(waiting, { type: 'tab', tab: 'members' }), { status: 'awaiting-schedules', tab: 'members', operationId: 'one', scheduleId: 'daily' });
  assert.deepEqual(agentProfileReducer(idle, { type: 'tab', tab: 'members' }), { status: 'viewing', tab: 'members' });
});
test('agent-profile.T21 schedule toggle locks other toggles without creating an optimistic snapshot', () => {
  assert.equal(selectAgentProfile(updating, external).scheduleLocked, true);
  assert.equal(agentProfileReducer(updating, { type: 'toggle-started', scheduleId: 'weekly', operationId: 'two' }), updating);
});
test('agent-profile.T22 a matching receipt waits for an authoritative list instead of releasing the controls', () => {
  assert.equal(agentProfileReducer(updating, { type: 'toggle-succeeded', operationId: 'old' }), updating);
  const completed = agentProfileReducer(updating, { type: 'toggle-succeeded', operationId: 'one' });
  assert.equal(completed.status, 'awaiting-schedules');
  assert.equal(selectAgentProfile(completed, external).scheduleLocked, true);
});
test('agent-profile.T23 failed toggle retains an actionable error and rejects obsolete failures', () => {
  assert.equal(agentProfileReducer(updating, { type: 'toggle-failed', operationId: 'old' }), updating);
  // The failure text is the page visit's one-time result (useVisitNotice); the reducer only ends the flow.
  const failed = agentProfileReducer(updating, { type: 'toggle-failed', operationId: 'one' });
  assert.deepEqual(failed, { status: 'viewing', tab: 'schedules' });
  assert.equal(selectAgentProfile(failed, external).scheduleLocked, false);
});
test('agent-profile.T24 unknown owner blocks writes before catch; read-back alone cannot unlock cached controls', () => {
  const operation = { resource: 'schedule', id: 'daily', operationId: 'one', action: 'save', status: 'unknown', error: '', reconciled: false } as const;
  const local = agentProfileReducer(updating, { type: 'toggle-succeeded', operationId: 'one' });
  for (const state of [updating, local]) {
    const selection = selectAgentProfile(state, { ...external, operations: [operation] });
    assert.equal(selection.scheduleUnknown, true); assert.equal(selection.scheduleLocked, true);
    assert.equal(selection.adoption, null);
  }
  assert.equal(selectAgentProfile(local, { ...external, scheduleReceiptRevision: 1, operations: [{ ...operation, status: 'confirmed', reconciled: true }] }).scheduleLocked, true);
});
test('agent-profile.A1/A4/A5 external deletion and offline always revoke edit/toggle capabilities; paused list is not empty', () => {
  assert.equal(selectAgentProfile(idle, { ...external, gone: true }).scheduleLocked, true);
  assert.equal(selectAgentProfile(idle, { ...external, offline: true }).scheduleLocked, true);
  assert.equal(selectAgentProfile(idle, { ...external, schedules: [], schedulePaused: true }).schedulesEmpty, false);
  assert.equal(selectAgentProfile(idle, { ...external, schedules: [], scheduleFailed: true }).schedulesEmpty, false);
});

test('agent-profile.D1/D4 member references are missing only after the directory has actually loaded', () => {
  const detail: NonNullable<AgentProfileExternal['detail']> = { id: 'planner', name: '小万', avatar: 0, description: '', workers: ['member'], system_prompt: '', model: 'offline', reasoning_effort: null, fast_mode: false, mcp_servers: [], searchable_mcp_servers: [], skills: [], code_mode: false, environment: 'local', member_of: [] };
  const state: AgentProfileState = { status: 'viewing', tab: 'members' };
  const loading = selectAgentProfile(state, { ...external, detail, listLoaded: false });
  assert.equal(loading.membersLoading, true);
  assert.equal(loading.missingMembers, false);
  assert.equal(loading.feedback, null);
  const loaded = selectAgentProfile(state, { ...external, detail, listLoaded: true });
  assert.equal(loaded.membersLoading, false);
  assert.equal(loaded.missingMembers, true);
  assert.equal(loaded.membersEmpty, false);
});

test('R2 T22/T24：核对终态只在同操作的新完整列表到达后采纳一次', () => {
  const waiting = agentProfileReducer(updating, { type: 'toggle-succeeded', operationId: 'one' });
  const receipt = { resource: 'schedule', id: 'daily', operationId: 'one', action: 'save', status: 'confirmed', error: '', reconciled: true } as const;
  const stale = { ...external, operations: [receipt], scheduleReceiptRevision: 2, scheduleReadRevision: 1 };
  assert.equal(selectAgentProfile(waiting, stale).scheduleLocked, true);
  assert.equal(selectAgentProfile(waiting, stale).adoption, null);
  const current = { ...stale, scheduleReadRevision: 2 };
  const adoption = selectAgentProfile(waiting, current).adoption;
  assert.deepEqual(adoption, { type: 'toggle-adopted', operationId: 'one' });
  const adopted = agentProfileReducer(waiting, adoption!);
  assert.equal(selectAgentProfile(adopted, current).adoption, null);
  assert.equal(selectAgentProfile(adopted, current).scheduleLocked, false);
  assert.equal(agentProfileReducer(adopted, adoption!), adopted);
  const next = agentProfileReducer(agentProfileReducer(adopted, { type: 'toggle-started', operationId: 'two', scheduleId: 'daily' }), { type: 'toggle-succeeded', operationId: 'two' });
  assert.equal(agentProfileReducer(next, adoption!), next, 'the old receipt cannot release a new operation');
});

test('R2：旧采纳不能结束新操作；owner 被替换只撤销旧交互，不解锁新写入', () => {
  const waiting = agentProfileReducer(updating, { type: 'toggle-succeeded', operationId: 'one' });
  assert.equal(agentProfileReducer(waiting, { type: 'toggle-adopted', operationId: 'old' }), waiting);
  const nextOwner = { resource: 'schedule', id: 'daily', operationId: 'two', action: 'save', status: 'pending', error: '', reconciled: false } as const;
  const current = { ...external, operations: [nextOwner], scheduleReceiptRevision: 2, scheduleReadRevision: 2 };
  const adoption = selectAgentProfile(waiting, current).adoption;
  assert.deepEqual(adoption, { type: 'toggle-superseded', operationId: 'one' });
  const abandoned = agentProfileReducer(waiting, adoption!);
  assert.equal(selectAgentProfile(abandoned, current).scheduleLocked, true);
  assert.equal(selectAgentProfile(abandoned, current).adoption, null);
});
