import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { act } from "react";
import { jsx } from "react/jsx-runtime";
import { createRoot, type Root } from "test-renderer";
import ts from "typescript";

import type { GatewayEvent } from "../src/gateway/api.ts";
import type { Item } from "../src/lib/chat-timeline.ts";

declare global {
  var __messageActionClipboard: (text: string) => Promise<boolean>;
  var __messageActionAlerts: string[];
  var __messageActionAnnouncements: string[];
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__messageActionAlerts = [];
globalThis.__messageActionAnnouncements = [];
const platform: Record<string, string> = {
  "react-native": `export const View='View', Text='Text', Pressable='Pressable';
    export const Platform={OS:'web',select:({web})=>web};
    export const AccessibilityInfo={announceForAccessibility:(message)=>globalThis.__messageActionAnnouncements.push(message)};
    export const Alert={alert:(title,message)=>globalThis.__messageActionAlerts.push(title+': '+message)};`,
  "expo-clipboard": `export const setStringAsync=(text)=>globalThis.__messageActionClipboard(text);`,
  "lucide-react-native": `export const Copy='IconCopy', Quote='IconQuote';`,
  "uniwind": `export const withUniwind=(component)=>component;`,
  "@rn-primitives/slot": `export const Slot='Slot';`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in platform) return { url: `data:text/javascript,${encodeURIComponent(platform[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      for (const extension of [".tsx", ".ts"]) {
        if (existsSync(fileURLToPath(url) + extension)) return { url: url.href + extension, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(
      readFileSync(fileURLToPath(url), "utf8"),
      { fileName: "action-row.tsx", compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } },
    ).outputText };
    return nextLoad(url, context);
  },
});
const { MessageActions } = await import("../src/components/chat/message-actions.tsx");
const event = (type: string, text: string): GatewayEvent =>
  ({ seq: 1, type, conversation_id: "c", at: 1, data: { text } });
const item = (type: string, text: string): Item => ({ key: type, event: event(type, text) });
const buttons = (root: Root) => root.container.queryAll((node) => node.type === "Pressable");
const action = (root: Root, kind: "copy" | "quote") =>
  buttons(root).find((node) => String(node.props.testID).startsWith(`message-${kind}-`));
async function render(root: Root, message: Item, onQuote: (text: string) => void = () => {}) {
  await act(async () => root.render(jsx(MessageActions, { item: message, onQuote,
    children: React.createElement("Text", { testID: "message-content", onLongPress: () => {} }, "可选择内容") })));
}

test("completed Agent and persisted user get direct muted 44px actions; no wrapper press/menu/dialog", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  try {
    for (const message of [item("message.agent", "答复"), item("message.user", "原话")]) {
      await render(root, message);
      const [copy, quote] = buttons(root);
      assert.equal(buttons(root).length, 2);
      assert.equal(copy.props.accessibilityLabel, "复制");
      assert.equal(quote.props.accessibilityLabel, "引用");
      assert.equal(copy.props.accessibilityRole, "button");
      assert.equal(copy.props.testID, `message-copy-${message.key}`);
      assert.equal(quote.props.testID, `message-quote-${message.key}`);
      assert.match(copy.props.className, /size-11/);
      assert.match(copy.props.className, /bg-transparent/);
      assert.deepEqual(root.container.queryAll((node) => node.type === "IconCopy" || node.type === "IconQuote")
        .map((node) => [node.type, node.props.className.includes("size-[18px]"), node.props.className.includes("text-muted-foreground")]),
        [["IconCopy", true, true], ["IconQuote", true, true]]);
      const row = copy.parent;
      assert.equal(row, quote.parent);
      assert.equal(row?.props.className.includes("justify-end"), message.event?.type === "message.user");
      const content = root.container.queryAll((node) => node.props.testID === "message-content")[0];
      assert.equal(typeof content.props.onLongPress, "function");
      assert.equal(content.parent?.type, "View");
      assert.equal(buttons(root).some((node) => node.props.onLongPress), false);
      assert.equal(root.container.queryAll((node) => String(node.props.testID).includes("message-menu") ||
        String(node.props.testID).includes("message-selection") || node.type === "Dialog").length, 0);
    }
  } finally { await act(async () => root.unmount()); }
});

test("generation and system rows omit actions, while persisted interrupted and pending/failed content remain actionable", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  try {
    for (const message of [
      { key: "generating", draft: { draft_id: "d", conversation_id: "c", sender: "agent", agent: "a", text: "正在写入", phase: "writing" } },
      item("turn.stopped", "中断"), item("message.agent", "  "),
    ]) {
      await render(root, message);
      assert.equal(buttons(root).length, 0);
      assert.equal(root.container.queryAll((node) => node.props.testID === "message-content").length, 1);
    }
    const interrupted = item("message.agent", "中断前已保存");
    interrupted.event!.data.status = "interrupted";
    for (const message of [interrupted, ...(["sending", "failed"] as const).map((status) => ({
      key: status, pending: { clientId: status, conversationId: "c", text: "未发送", status, error: "离线", retryable: false },
    }))]) {
      await render(root, message);
      assert.equal(buttons(root).length, 2);
      assert.equal(action(root, "quote")?.props.disabled, false);
    }
    await render(root, item("message.agent", "[站点]: https://example.com"));
    assert.equal(action(root, "copy")?.props.disabled, undefined);
    assert.equal(action(root, "quote")?.props.disabled, true);
  } finally { await act(async () => root.unmount()); }
});

test("copy retains exact Markdown, announces and expires feedback after 2200ms; failure never claims success", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  const calls: string[] = [];
  const timers: { delay: number; callback: () => void }[] = [];
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return timers.length as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  globalThis.__messageActionAlerts.length = 0;
  globalThis.__messageActionAnnouncements.length = 0;
  globalThis.__messageActionClipboard = async (text) => { calls.push(text); return true; };
  try {
    await render(root, item("message.agent", "**加粗**\n\n> 归属"));
    await act(async () => action(root, "copy")?.props.onPress());
    assert.deepEqual(calls, ["**加粗**\n\n> 归属"]);
    assert.deepEqual(globalThis.__messageActionAnnouncements, ["已复制"]);
    assert.equal(root.container.queryAll((node) => node.props.accessibilityLiveRegion === "polite")[0].props.children, "已复制");
    assert.equal(timers.at(-1)?.delay, 2200);
    await act(async () => timers.at(-1)?.callback());
    assert.equal(root.container.queryAll((node) => node.props.accessibilityLiveRegion === "polite").length, 0);
    globalThis.__messageActionClipboard = async () => false;
    await act(async () => action(root, "copy")?.props.onPress());
    assert.equal(globalThis.__messageActionAlerts.length, 1);
    assert.equal(globalThis.__messageActionAnnouncements.length, 1);
    globalThis.__messageActionClipboard = async () => { throw new Error("权限被拒绝"); };
    await act(async () => action(root, "copy")?.props.onPress());
    assert.equal(globalThis.__messageActionAlerts.length, 2);
  } finally {
    await act(async () => root.unmount());
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("native clipboard failures do not expose diagnostics or claim a successful copy", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  const diagnostic = "NativeClipboardError: private-content /native/path";
  globalThis.__messageActionAlerts.length = 0;
  globalThis.__messageActionAnnouncements.length = 0;
  globalThis.__messageActionClipboard = async () => { throw new Error(diagnostic); };
  try {
    await render(root, item("message.agent", "要复制的内容"));
    await act(async () => action(root, "copy")?.props.onPress());
    assert.equal(globalThis.__messageActionAlerts.length, 1);
    assert.ok(!globalThis.__messageActionAlerts[0].includes(diagnostic));
    assert.match(globalThis.__messageActionAlerts[0], /剪贴板/);
    assert.equal(globalThis.__messageActionAnnouncements.length, 0);
    assert.equal(root.container.queryAll((node) => node.props.accessibilityLiveRegion === "polite").length, 0);
  } finally { await act(async () => root.unmount()); }
});

test("quote snapshots nested attribution and Unicode truncation at the press, without mutating content", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  const quotes: string[] = [];
  const content = `> ${"😀".repeat(2100)}\n\n解释`;
  try {
    await render(root, item("message.agent", content), (quote) => quotes.push(quote));
    await act(async () => action(root, "quote")?.props.onPress());
    assert.equal(quotes[0], `> ${"😀".repeat(1997)}…`);
    assert.equal(Array.from(quotes[0]).length, 2000);
    assert.equal(root.container.queryAll((node) => node.props.testID === "message-content")[0].props.children, "可选择内容");
  } finally { await act(async () => root.unmount()); }
});
