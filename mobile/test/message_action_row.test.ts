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
import type { ChatRow } from "../src/lib/chat-timeline.ts";

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
  "@/components/ui/dropdown-menu.tsx": `import {createElement} from ${JSON.stringify(import.meta.resolve("react"))};
    export const DropdownMenu=({children})=>createElement('View',null,children);
    export const DropdownMenuAnchor='MenuAnchor',DropdownMenuContent='MenuContent',DropdownMenuItem='MenuItem';`,
  "react-native": `import {createElement} from ${JSON.stringify(import.meta.resolve("react"))};
    export const View='View', Text='Text';
    export function Pressable({children,...props}) {
      return createElement('Pressable',props,typeof children==='function'?children({pressed:false}):children);
    }
    export const Platform={OS:'web',select:({web})=>web};
    export const AccessibilityInfo={announceForAccessibility:(message)=>globalThis.__messageActionAnnouncements.push(message)};
    export const Alert={alert:(title,message)=>globalThis.__messageActionAlerts.push(title+': '+message)};`,
  "expo-clipboard": `export const setStringAsync=(text)=>globalThis.__messageActionClipboard(text);`,
  "lucide-react-native": `export const Copy='IconCopy', Quote='IconQuote', Trash2='IconTrash';`,
  "uniwind": `export const withUniwind=(component)=>component;`,
  "@rn-primitives/slot": `export const Slot='Slot';`,
  "react-native-reanimated": `import {useState} from ${JSON.stringify(import.meta.resolve("react"))};
    export const ReduceMotion={System:0};
    export const Easing={out:fn=>fn,in:fn=>fn,inOut:fn=>fn,quad:x=>x*x,cubic:x=>x*x*x,linear:x=>x};
    export const useSharedValue=value=>useState(()=>({value,set(next){this.value=next;}}))[0];
    export const useAnimatedStyle=read=>read(), withTiming=value=>value;
    export default {View:'View'};`,
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
const item = (type: string, text: string): ChatRow => type === "message.agent"
  ? { kind: "agent", phase: "final", key: type, event: event(type, text) }
  : { kind: "event", key: type, event: event(type, text) };
const buttons = (root: Root) => root.container.queryAll((node) => node.type === "Pressable" && node.props.accessibilityRole === "button");
const action = (root: Root, kind: "copy" | "quote") =>
  buttons(root).find((node) => String(node.props.testID).startsWith(`message-${kind}-`));
async function render(root: Root, message: ChatRow, onQuote: (text: string) => void = () => {}) {
  await act(async () => root.render(jsx(MessageActions, { item: message, onQuote,
    children: React.createElement("Text", { testID: "message-content", onLongPress: () => {} }, "可选择内容") })));
}


test("generation and system rows omit actions, while persisted interrupted and pending/failed content remain actionable", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  try {
    for (const message of [
      { kind: "agent" as const, phase: "streaming" as const, key: "generating", draft: { draft_id: "d", conversation_id: "c", sender: "agent", agent: "a", text: "正在写入", phase: "writing" } },
      item("turn.stopped", "中断"), item("message.agent", "  "),
    ]) {
      await render(root, message);
      assert.equal(buttons(root).length, 0);
      assert.equal(root.container.queryAll((node) => node.props.testID === "message-content").length, 1);
    }
    const interrupted = item("message.agent", "中断前已保存");
    interrupted.event!.data.status = "interrupted";
    await render(root, interrupted);
    assert.equal(action(root, "quote")?.props.disabled, false);
    for (const status of ["sending", "failed"] as const) {
      await render(root, {
        kind: "user", delivery: status, retryable: false,
        key: status, pending: { clientId: status, text: "未发送", status, error: "离线", retryable: false },
      });
      assert.equal(buttons(root).length, 0);
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
    // Failures are shown in place of "已复制" (no system dialog) and never announce success.
    const feedback = () => root.container.queryAll((node) => node.props.accessibilityLiveRegion === "polite").map((node) => node.props.children);
    globalThis.__messageActionClipboard = async () => false;
    await act(async () => action(root, "copy")?.props.onPress());
    assert.equal(feedback().length, 1);
    assert.match(String(feedback()[0]), /^无法复制：/);
    assert.equal(globalThis.__messageActionAnnouncements.length, 1);
    globalThis.__messageActionClipboard = async () => { throw new Error("权限被拒绝"); };
    await act(async () => action(root, "copy")?.props.onPress());
    assert.equal(feedback().length, 1);
    assert.match(String(feedback()[0]), /^无法复制：/);
    assert.equal(globalThis.__messageActionAlerts.length, 0);
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
    const [feedback] = root.container.queryAll((node) => node.props.accessibilityLiveRegion === "polite");
    assert.equal(globalThis.__messageActionAlerts.length, 0);
    assert.ok(!String(feedback.props.children).includes(diagnostic));
    assert.match(String(feedback.props.children), /剪贴板/);
    assert.equal(globalThis.__messageActionAnnouncements.length, 0);
    assert.doesNotMatch(String(feedback.props.children), /已复制/);
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
