import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import { GatewayApi } from "../src/gateway/api.ts";
import type { SubscriptionAuth, SubscriptionUsage } from "../src/gateway/api.ts";
import type { SubscriptionView } from "../src/lib/model-usage.ts";
import { loadSubscriptionUsage, subscriptionSummary } from "../src/lib/model-usage.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const nativeImports: Record<string, string> = {
  "lucide-react-native": "export const Box = 'Box';",
  "react-native": "export const View = 'View';",
  "@/components/list-group.tsx": "export const ListGroup = ({children}) => children;",
  "@/components/ui/button.tsx": "export const Button = 'Button';",
  "@/components/ui/icon.tsx": "export const Icon = 'Icon';",
  "@/components/ui/text.tsx": "export const Text = 'Text';",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeImports) return { url: `data:text/javascript,${encodeURIComponent(nativeImports[specifier])}`, shortCircuit: true };
    if (specifier === "@/lib/model-usage.ts") return nextResolve(new URL("../src/lib/model-usage.ts", import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/model-subscription.tsx")) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});

// Static import would load React Native before synchronous test-only loader hooks.
const { ModelSubscription } = await import("../src/components/model-subscription.tsx");
const auth: SubscriptionAuth = {
  status: "ready", reason: null, checked_at: 500,
  codex_home: "/srv/wandrun/codex home",
  login_command: "CODEX_HOME='/srv/wandrun/codex home' codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth",
};
const usage: SubscriptionUsage = {
  plan_type: "plus", allowed: true, limit_reached: false, fetched_at: 100,
  windows: [{ name: "primary", used_percent: 40, window_seconds: 3600, reset_at: 2090000000 }],
};

async function rendered(view: SubscriptionView, onRecheck?: () => void) {
  const root = createRoot({ textComponentTypes: ["Text"] });
  let rechecks = 0;
  const render = async (next: SubscriptionView) => act(async () => root.render(createElement(ModelSubscription, { view: next, nowSeconds: 100, onRecheck: () => { rechecks++; onRecheck?.(); } })));
  await render(view);
  const texts = () => root.container.queryAll((node) => node.type === "Text")
    .map((node) => Array.isArray(node.props.children) ? node.props.children.join("") : String(node.props.children)).join(" ");
  const hasLogin = () => root.container.queryAll((node) => node.props.testID === "settings-subscription-login").length > 0;
  const pressRecheck = () => {
    const button = root.container.queryAll((node) => node.props.testID === "settings-subscription-recheck")[0];
    (button.props.onPress as () => void)();
    return rechecks;
  };
  return { root, texts, hasLogin, pressRecheck, render };
}

test("模型页渲染重新登录状态和实际网关登录命令，同时标注历史额度", async () => {
  for (const status of ["reauth_required", "relogin_required", "login_required"] as const) {
    const page = await rendered({ auth: { ...auth, status }, usage, networkError: false });
    try {
      assert.match(page.texts(), status === "reauth_required" ? /登录已失效，需要重新登录/ : status === "relogin_required" ? /凭据轮换结果不确定，需要停止网关并重新登录/ : /尚未登录/);
      assert.match(page.texts(), /先在电脑上停止网关.*重启网关/);
      assert.ok(page.texts().includes(auth.codex_home));
      assert.equal(page.hasLogin(), true);
      assert.ok(page.texts().includes(auth.login_command));
      assert.match(page.texts(), /历史额度，不代表当前登录状态/);
      assert.match(page.texts(), /40%/);
      assert.equal(page.pressRecheck(), 1);
    } finally {
      await act(async () => page.root.unmount());
    }
  }
});

test("模型页渲染暂时失败和离线而不误报重新登录", async () => {
  for (const view of [
    { auth: { ...auth, status: "temporarily_unavailable" as const }, usage, networkError: false },
    { auth: null, usage, networkError: true },
  ]) {
    const page = await rendered(view);
    try {
      assert.match(page.texts(), view.networkError ? /网关连接失败，登录状态暂时无法检查/ : /登录暂时不可用，请稍后重试/);
      assert.match(page.texts(), /历史额度，不代表当前登录状态/);
      assert.equal(page.hasLogin(), false);
      assert.doesNotMatch(page.texts(), /CODEX_HOME=|停止网关|需要重新登录/);
      assert.equal(page.pressRecheck(), 1);
    } finally {
      await act(async () => page.root.unmount());
    }
  }
});

test("App 消费网关轮换不确定状态，重新检查时不将断线或永久拒绝混淆", async () => {
  const replies = [
    { auth: { ...auth, status: "relogin_required", reason: "refresh_persistence_uncertain", checked_at: 600 }, usage },
    { auth: { ...auth, status: "temporarily_unavailable", reason: "refresh_network_error", checked_at: 650 }, usage: null },
    { auth: { ...auth, status: "reauth_required", reason: "refresh_rejected", checked_at: 700 }, usage: null },
  ];
  let offline = false;
  const api = new GatewayApi({ baseUrl: "http://gateway", token: "synthetic" }, async () => {
    if (offline) throw new Error("offline");
    return Response.json(replies.shift());
  });
  let refresh: Promise<SubscriptionView> | undefined;
  const first = await loadSubscriptionUsage(api, true);
  const page = await rendered(first, () => { refresh = loadSubscriptionUsage(api, true); });
  try {
    assert.equal(first.auth?.reason, "refresh_persistence_uncertain");
    assert.equal(subscriptionSummary(first), "凭据轮换结果不确定，需停止网关并重新登录");
    assert.equal(page.hasLogin(), true);
    assert.match(page.texts(), /凭据轮换结果不确定.*停止网关/);
    assert.ok(page.texts().includes(auth.codex_home));
    assert.ok(page.texts().includes(auth.login_command));
    assert.match(page.texts(), /历史额度，不代表当前登录状态/);

    offline = true;
    assert.equal(page.pressRecheck(), 1);
    const disconnected = await refresh!;
    await page.render(disconnected);
    assert.match(page.texts(), /网关连接失败，登录状态暂时无法检查/);
    assert.equal(subscriptionSummary(disconnected), "登录状态暂不可检查");
    assert.equal(page.hasLogin(), false);
    assert.doesNotMatch(page.texts(), /凭据轮换结果不确定|需要重新登录|CODEX_HOME=/);

    offline = false;
    assert.equal(page.pressRecheck(), 2);
    const temporary = await refresh!;
    await page.render(temporary);
    assert.match(page.texts(), /登录暂时不可用，请稍后重试/);
    assert.equal(subscriptionSummary(temporary), "登录暂时不可用");
    assert.equal(page.hasLogin(), false);

    assert.equal(page.pressRecheck(), 3);
    const rejected = await refresh!;
    await page.render(rejected);
    assert.match(page.texts(), /登录已失效，需要重新登录/);
    assert.equal(subscriptionSummary(rejected), "需要重新登录");
    assert.doesNotMatch(page.texts(), /凭据轮换结果不确定/);
    assert.equal(page.hasLogin(), true);
  } finally {
    await act(async () => page.root.unmount());
  }
});
