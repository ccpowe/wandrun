import assert from 'node:assert/strict';
import { test } from 'node:test';
import { userErrorMessage } from '../src/lib/user-error.ts';

// The inputs are gateway display contracts, not raw runtime exceptions.
test('chat.D10 known gateway failures retain their reason without suggesting a missing retry action', () => {
  const cases = [
    ['模型尚未登录，请先在电脑上登录模型。', /未登录/],
    ['模型登录已失效，请先在电脑上重新登录模型。', /已失效/],
    ['模型登录暂不可用，请在电脑上检查登录状态。', /暂不可用/],
    ['模型登录状态未确认，请先在电脑上停止网关并重新登录模型。', /未确认/],
    ['模型服务暂不可用，请稍后重试。', /模型服务暂不可用/],
    ['模型服务认证或访问权限不足，请检查登录状态和凭据后重试。', /登录.*权限/],
    ['模型服务额度或速率已达限制，请检查额度或稍后重试。', /额度.*频率/],
    ['请求超时，请稍后重试。', /超时/],
    ['网络连接失败，请检查网络后重试。', /连接/],
    ['模型响应中断，请检查网络后重试。', /中断/],
    ['上下文长度超过模型限制，请缩短输入或拆分任务后重试。', /超出模型限制/],
  ] as const;
  for (const [input, reason] of cases) {
    const message = userErrorMessage(input, '未完成');
    assert.match(message, reason);
    assert.doesNotMatch(message, /重试|日志/);
  }
});

test('chat.D10 generic and unclassified failures use the safe caller fallback, never raw diagnostics', () => {
  const fallback = '原因未知';
  for (const input of [
    '任务执行失败，请重试；若持续失败，请查看网关日志。',
    'CredentialError: private-token /home/private/auth.json',
    'RuntimeError: private upstream endpoint', '__proto__', 'constructor', '',
  ]) assert.equal(userErrorMessage(input, fallback), fallback);
});
