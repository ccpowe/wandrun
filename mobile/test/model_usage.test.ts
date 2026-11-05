import assert from "node:assert/strict";
import { test } from "node:test";

import { GatewayApi, GatewayError, type SubscriptionAuth, type SubscriptionStatus, type SubscriptionUsage } from "../src/gateway/api.ts";
import { agentTokens, formatTokens, mergeSubscriptionStatus, subscriptionView, quotaSummary, quotaWarning, resetLabel, subscriptionSummary, usedPercent, windowTitle } from "../src/lib/model-usage.ts";

const reset = new Date(2099, 9, 13, 9, 5).getTime() / 1000;
const weekly = { name: "secondary", used_percent: 35, window_seconds: 7 * 86400, reset_at: reset };
const hourly = { name: "primary", used_percent: 72.4, window_seconds: 5 * 3600, reset_at: reset + 3600 };
const usage: SubscriptionUsage = { plan_type: "plus", allowed: true, limit_reached: false, windows: [hourly, weekly], fetched_at: 1 };
const auth: SubscriptionAuth = {
  status: "ready", reason: null, checked_at: 100,
  codex_home: "/tmp/test-gateway/codex-home",
  login_command: "CODEX_HOME=/tmp/test-gateway/codex-home codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth",
};
const envelope = (status: SubscriptionAuth["status"], checked_at: number, quota: SubscriptionUsage | null = usage): SubscriptionStatus =>
  ({ auth: { ...auth, status, checked_at }, usage: quota });

test("窗口标题使用后端时长，而非 primary/secondary 的固定名称；恢复显示本地时刻", () => {
  assert.equal(windowTitle(weekly), "额度（7 天窗口）");
  assert.equal(windowTitle(hourly), "额度（5 小时窗口）");
  assert.equal(windowTitle({ ...hourly, window_seconds: 90 * 60, name: "codex_burst.primary" }), "codex_burst · 额度（90 分钟窗口）");
  assert.equal(resetLabel(reset), "2099年10月13日 09:05 恢复");
});

test("用量进度按 used_percent，摘要取最接近上限的窗口；只有网关明确拒绝才告警", () => {
  assert.equal(usedPercent(-2), 0);
  assert.equal(usedPercent(130), 100);
  assert.equal(usedPercent(72.4), 72.4);
  assert.equal(quotaSummary(usage), "额度 72%");
  assert.equal(quotaSummary({ ...usage, windows: [] }), null);
  assert.equal(quotaSummary(null), null);
  assert.equal(quotaWarning({ ...usage, windows: [{ ...hourly, used_percent: 100 }] }, 0), null);
  const exhausted = { ...usage, limit_reached: true, windows: [{ ...hourly, used_percent: 100 }, { ...weekly, used_percent: 100 }] };
  assert.equal(quotaSummary(exhausted), "额度受限");
  assert.match(quotaWarning(exhausted, 0)!, /2099年10月13日 10:05 恢复.*恢复前模型请求会失败/);
  assert.match(quotaWarning({ ...usage, allowed: false, windows: [] }, 0)!, /额度当前不可用.*恢复前模型请求会失败/);
});

test("Agent token 总数只含 input 与 output，cached/reasoning 不重复累加", () => {
  const agentUsage = { input_tokens: 1200, output_tokens: 400, cached_input_tokens: 900, reasoning_output_tokens: 300 };
  assert.equal(agentTokens(agentUsage), 1600);
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1250), "1.3K");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(999_950), "1M");
});

test("settings-models.A2 网络失败保留历史额度但撤销登录证据，不冒充重新登录", () => {
  const current = envelope("ready", 100);
  assert.deepEqual(subscriptionView(current, false), { auth, usage, networkError: false });
  const offline = subscriptionView(current, true);
  assert.deepEqual(offline, { auth: null, usage, networkError: true });
  assert.equal(subscriptionSummary(offline), "登录状态暂不可检查");
  assert.deepEqual(subscriptionView(undefined, true), { auth: null, usage: null, networkError: true });
});

test("settings-models.A3 A5 登录与额度独立排序，临时失败和空额度不抹掉历史", () => {
  const original = envelope("reauth_required", 300, { ...usage, fetched_at: 100 });
  const incoming = envelope("ready", 200, { ...usage, fetched_at: 200, allowed: false });
  const merged = mergeSubscriptionStatus(original, incoming);
  assert.equal(merged.auth.status, "reauth_required");
  assert.equal(merged.usage?.fetched_at, 200);
  assert.equal(merged.usage?.allowed, false);
  const temporary = mergeSubscriptionStatus(merged, envelope("temporarily_unavailable", 400, { ...usage, fetched_at: 10 }));
  assert.equal(temporary.auth.status, "temporarily_unavailable");
  assert.equal(temporary.usage?.fetched_at, 200);
  assert.equal(mergeSubscriptionStatus(temporary, envelope("ready", 500, null)).usage?.fetched_at, 200);
});

test("订阅响应严格解析 auth 与可空额度，拒绝旧扁平协议", async () => {
  const replies: unknown[] = [envelope("login_required", 10, null), usage,
    { auth: { ...auth, checked_at: "yesterday" }, usage: null },
    { auth, usage: { ...usage, windows: [{ ...hourly, reset_at: "later" }] } },
    { auth: { ...auth, status: "expired", login_command: "" }, usage: null }];
  const api = new GatewayApi({ baseUrl: "http://gateway", token: "dev" }, async () => Response.json(replies.shift()));
  assert.deepEqual(await api.getSubscriptionUsage(), envelope("login_required", 10, null));
  for (let index = 0; index < 4; index++) {
    await assert.rejects(api.getSubscriptionUsage(), (error: unknown) => error instanceof GatewayError && error.code === "invalid_response");
  }
});
