import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentCapability } from '../src/gateway/api.ts';
import { capabilityReducer, selectCapabilities } from '../src/lib/agent-capabilities-state.ts';

const item: AgentCapability = { id: 'files', name: '文件', summary: '', description: '', status: 'enabled', reason: '', tools: [], skills: [] };
test('capabilities.T1 closed opens a requested enabled row', () => {
  const open = capabilityReducer({ status: 'closed' }, { type: 'open', id: 'files' });
  assert.equal(selectCapabilities(open, [item], '', 'idle').selected?.id, 'files');
});
test('capabilities.T2 details closes on user dismissal', () => {
  const open = { status: 'details', id: 'files' } as const;
  assert.deepEqual(capabilityReducer(open, { type: 'close' }), { status: 'closed' });
});
test('capabilities.T3 revoked details closes once; re-enabling does not restore the old selection', () => {
  const open = capabilityReducer({ status: 'closed' }, { type: 'open', id: 'files' });
  const projection = selectCapabilities(open, [{ ...item, status: 'disabled' }], '', 'idle');
  assert.equal(projection.selected, null);
  assert.ok(projection.revoke);
  const closed = capabilityReducer(open, projection.revoke);
  assert.equal(selectCapabilities(closed, [item], '', 'idle').selected, null);
  assert.equal(selectCapabilities(closed, [item], '', 'idle').revoke, null);
});
test('capabilities.T4 refresh failure retains readable details', () => {
  const open = { status: 'details', id: 'files' } as const;
  assert.equal(selectCapabilities(open, [item], 'failed', 'fetching').selected?.id, 'files');
});
test('capabilities.T5 stale revocation does not close another selection', () => {
  const open = { status: 'details', id: 'files' } as const;
  assert.equal(capabilityReducer(open, { type: 'revoke', id: 'memory' }), open);
  assert.equal(capabilityReducer(open, { type: 'open', id: 'memory' }), open);
});
test('capabilities.G1/G2/G4 pending, paused and failed reads never claim a confirmed empty snapshot', () => {
  for (const [data, error, fetchStatus] of [[null, '', 'fetching'], [[], '', 'paused'], [[], 'failed', 'idle']] as const) {
    assert.equal(selectCapabilities({ status: 'closed' }, data === null ? null : [...data], error, fetchStatus).empty, false);
  }
  assert.equal(selectCapabilities({ status: 'closed' }, [], '', 'idle').empty, true);
});
