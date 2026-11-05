import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMemory, MemoryDetail } from '../src/gateway/api.ts';
import { memoryCheckResult } from '../src/lib/memory-save-check.ts';

const index: AgentMemory = { scope: 'profile', content: 'line\r\nnext', version: 'v2', details: {}, limit: 1000, updated_at: null, updated_by: null };

test('index reconciliation compares normalized text, including an already equal baseline', () => {
  assert.equal(memoryCheckResult({ version: 'v1', content: 'line\nnext' }, index, null).outcome, 'saved');
  assert.equal(memoryCheckResult({ version: 'v2', content: 'line\nnext' }, index, null).outcome, 'saved');
});

test('only a nonmatching current value at the original CAS version permits editing again', () => {
  const submission = { version: 'v1', content: 'not present' };
  assert.equal(memoryCheckResult(submission, { ...index, version: 'v1' }, null).outcome, 'not-saved');
  assert.equal(memoryCheckResult(submission, index, null).outcome, 'conflict');
});

test('a matching detail remains saved when unrelated index text changed; a missing active reference cannot confirm it', () => {
  const ref = { path: `/.wandrun/memory/profile/details/topic/${'a'.repeat(64)}.md`, sha256: 'a'.repeat(64) };
  const detail: MemoryDetail = { scope: 'profile', slug: 'topic', content: 'line\r\nnext', version: 'v2', ...ref, limit: 65536 };
  const submission = { version: 'v1', content: 'line\nnext', slug: 'topic' };
  assert.equal(memoryCheckResult(submission, { ...index, content: 'unrelated index edit', details: { topic: ref } }, detail).outcome, 'saved');
  assert.equal(memoryCheckResult(submission, index, detail).outcome, 'conflict');
});
