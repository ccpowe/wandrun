import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError, type FileDetail } from '../src/gateway/api.ts';
import { selectFileRead } from '../src/lib/file-viewer.ts';

const file: FileDetail = { id: 'file', name: 'current.txt', size: 7, media_type: 'text/plain', available: true,
  error: null, error_message: null, conversation_id: null, agent_id: null, task_id: 'root', created_at: 1, remote_environment: null };
test('files.A1 未完成读取不等于空结果或文件不可用', () => {
  const selected = selectFileRead(undefined, null, false);
  assert.equal(selected.loading, true); assert.equal(selected.feedback, null); assert.equal(selected.file, undefined);
});
test('files.A2 临时刷新失败保留旧文件；paused 不冒称读取失败', () => {
  const error = new GatewayError(503, 'unavailable', 'temporary');
  const failed = selectFileRead(file, error, false);
  assert.equal(failed.file, file); assert.equal(failed.stale, true); assert.equal(failed.loading, false);
  assert.equal(failed.feedback, '无法读取文件信息，正在重试…');
  assert.equal(selectFileRead(file, error, true).feedback, null);
});
test('files.A7 明确不存在优先于缓存可用性，不能显示旧原文件并允许继续交付', () => {
  for (const status of [404, 410]) {
    const selected = selectFileRead(file, new GatewayError(status, 'missing', 'gone'), false);
    assert.equal(selected.file, undefined); assert.equal(selected.loading, false); assert.equal(selected.stale, false);
    assert.equal(selected.feedback, '文件暂不可用');
  }
});
