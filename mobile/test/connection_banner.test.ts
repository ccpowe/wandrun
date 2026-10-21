import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import type { ChatSession } from "../src/gateway/session.ts";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Static import would resolve native packages before the test's synchronous loader hooks.
const nativeImports: Record<string, string> = {
  "lucide-react-native": "export const WifiOff = 'WifiOff';",
  "react-native": "export const View = 'View';",
  "@/components/ui/icon.tsx": "export const Icon = 'Icon';",
  "@/components/ui/text.tsx": "export const Text = 'Text';",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeImports) return { url: `data:text/javascript,${encodeURIComponent(nativeImports[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/connection-banner.tsx")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});

const { ConnectionBanner, connectionLabel } = await import("../src/lib/connection-banner.tsx");
const label = (connection: ChatSession["connection"], notice: string | null = null) =>
  connectionLabel({ connection, notice } as ChatSession);

test("连接错误只显示一次完整提示，保留独立原因和认证失败语义", () => {
  assert.equal(label("error", "连不上网关"), "连不上网关");
  assert.equal(label("error", "网关拒绝连接：服务不可用"), "网关拒绝连接：服务不可用");
  assert.equal(label("error", "令牌不对"), "令牌不对");
  assert.equal(label("error"), "连不上网关");
});

test("等待、重连及在线状态不混入旧连接错误", () => {
  assert.equal(label("listing", "连不上网关"), "正在连接…");
  assert.equal(label("connecting", "令牌不对"), "正在连接…");
  assert.equal(label("reconnecting", "连不上网关"), "连接断开，正在重连…");
  assert.equal(label("open", "连不上网关"), null);
});

test("横幅只渲染一次错误标题，并保留断线说明", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  const session = { connection: "error", notice: "连不上网关" } as ChatSession;
  const texts = () => root.container.queryAll((node) => node.type === "Text").map((node) => node.props.children);
  try {
    await act(async () => root.render(createElement(ConnectionBanner, { session })));
    assert.deepEqual(texts(), ["连不上网关", "显示的是断开前的内容，暂时不能发消息"]);
    session.notice = "令牌不对";
    await act(async () => root.render(createElement(ConnectionBanner, { session })));
    assert.deepEqual(texts(), ["令牌不对", "显示的是断开前的内容，暂时不能发消息"]);
    session.connection = "open";
    await act(async () => root.render(createElement(ConnectionBanner, { session })));
    assert.deepEqual(texts(), []);
  } finally {
    await act(async () => root.unmount());
  }
});

test("短于一秒的断线从未显示横幅，下一次断线重新计时", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const session = { connection: "open", notice: null } as ChatSession;
  const render = () => root.render(createElement(ConnectionBanner, { session }));
  const visible = () => root.container.queryAll((node) => node.type === "Text").length > 0;
  try {
    await act(async () => render());
    session.connection = "reconnecting";
    await act(async () => render());
    assert.equal(visible(), false);
    await act(async () => t.mock.timers.tick(999));
    assert.equal(visible(), false);
    session.connection = "open";
    await act(async () => render());
    assert.equal(visible(), false);
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(visible(), false, "旧计时器不得在恢复后补显示");
    session.connection = "reconnecting";
    await act(async () => render());
    assert.equal(visible(), false);
    await act(async () => t.mock.timers.tick(999));
    assert.equal(visible(), false);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(visible(), true);
    session.connection = "open";
    await act(async () => render());
    assert.equal(visible(), false, "恢复时不等下一个计时器");
  } finally {
    await act(async () => root.unmount());
  }
});

test("连续非在线状态共用一秒期限，错误绕过等待且恢复立即隐藏", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const session = { connection: "listing", notice: null } as ChatSession;
  const render = () => root.render(createElement(ConnectionBanner, { session }));
  const texts = () => root.container.queryAll((node) => node.type === "Text").map((node) => node.props.children);
  try {
    await act(async () => render());
    assert.deepEqual(texts(), []);
    await act(async () => t.mock.timers.tick(600));
    session.connection = "connecting";
    await act(async () => render());
    await act(async () => t.mock.timers.tick(399));
    assert.deepEqual(texts(), []);
    session.connection = "reconnecting";
    await act(async () => render());
    await act(async () => t.mock.timers.tick(1));
    assert.equal(texts()[0], label("reconnecting"));
    session.connection = "open";
    await act(async () => render());
    assert.deepEqual(texts(), []);
    session.connection = "connecting";
    await act(async () => render());
    await act(async () => t.mock.timers.tick(10));
    session.connection = "error";
    session.notice = "令牌不对";
    await act(async () => render());
    assert.equal(texts()[0], session.notice);
    session.connection = "open";
    await act(async () => render());
    assert.deepEqual(texts(), []);
  } finally {
    await act(async () => root.unmount());
  }
});

test("换会话不继承离线显示期限", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const first = { connection: "reconnecting", notice: null } as ChatSession;
  const second = { connection: "connecting", notice: null } as ChatSession;
  try {
    await act(async () => root.render(createElement(ConnectionBanner, { session: first })));
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(root.container.queryAll((node) => node.type === "Text").length, 2);
    await act(async () => root.render(createElement(ConnectionBanner, { session: second })));
    assert.deepEqual(root.container.queryAll((node) => node.type === "Text"), []);
    await act(async () => t.mock.timers.tick(999));
    assert.deepEqual(root.container.queryAll((node) => node.type === "Text"), []);
  } finally {
    await act(async () => root.unmount());
  }
});
