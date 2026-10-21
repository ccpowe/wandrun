import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, useEffect, useImperativeHandle } from "react";
import { createRoot, type Root } from "test-renderer";
import ts from "typescript";
import type { Input, Reply } from "../src/browser/protocol.ts";

type Listener = (event: { height: number } | string) => void;
const listeners = new Map<string, Set<Listener>>();
const appState = {
  currentState: "active",
  addEventListener: (name: string, listener: Listener) => subscribe(name, listener),
};
function subscribe(name: string, listener: Listener) {
  const entries = listeners.get(name) ?? new Set<Listener>();
  listeners.set(name, entries); entries.add(listener);
  return { remove: () => entries.delete(listener) };
}
function emit(name: string, event: { height: number } | string) {
  if (name === "change") appState.currentState = event as string;
  for (const listener of listeners.get(name) ?? []) listener(event);
}
const lease = { id: "lease", root_id: "root", state: "human", pages: [], max_pages: 8 };
type StreamEvents = { state(value: string): void; pages(value: object): void; frame(value: object): void; ended(reason: string): void; reply(value: Reply): void };
const clients: { events: StreamEvents; accepted: boolean; sent: Input[]; closed: boolean }[] = [];
const session = { api: { config: {}, browserTask: async () => lease }, browserTasks: new Map([["lease", lease]]) };
const nativeText = new Map<string, string>();
const native = { appState, subscribe, session, useEffect, createElement, useImperativeHandle, clients, nativeText };
(globalThis as typeof globalThis & { __browserKeyboardTest: typeof native }).__browserKeyboardTest = native;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Run the actual screen and React effects. Only native hosts, transport and drawing are
// substituted; deliberately omit keyboardDidHide after Home/lock to model the lost event.
const modules: Record<string, string> = {
  "@shopify/react-native-skia": "export const Skia = { Image: { MakeImageFromEncoded: () => ({}) }, Data: { fromBytes: value => value } };",
  "expo-screen-orientation": "export const unlockAsync = async () => {}; export const lockAsync = async () => {}; export const OrientationLock = { PORTRAIT_UP: 1 };",
  "expo-router": "export const router = {}; export function useFocusEffect(callback) { globalThis.__browserKeyboardTest.useEffect(callback, [callback]); }",
  "lucide-react-native": "export const ChevronLeft='Icon', Hand='Icon', Keyboard='Icon', LockKeyhole='Icon', MoreHorizontal='Icon', Mouse='Icon', MouseLeft='Icon', MousePointer2='Icon', MouseRight='Icon', RotateCw='Icon', Smartphone='Icon', X='Icon';",
  "react-native": `const { createElement, useImperativeHandle } = globalThis.__browserKeyboardTest;
    export const Alert = {}, Vibration = {}, Keyboard = { dismiss() {} };
    export const AppState = globalThis.__browserKeyboardTest.appState;
    export const View='View', Text='Text', Pressable='Pressable', ScrollView='ScrollView', Switch='Switch';
    export function TextInput({ ref, ...props }) {
      const values = globalThis.__browserKeyboardTest.nativeText;
      useImperativeHandle(ref, () => ({ blur() { props.onBlur?.(); }, clear() { values.set(props.testID, ''); }, focus() { props.onFocus?.(); } }));
      return createElement('TextInput', {...props, onChangeText(value) { values.set(props.testID, value); props.onChangeText(value); }});
    }
    export const useWindowDimensions = () => ({ width: 720, height: 1152 });`,
  "react-native-gesture-handler": "export const GestureDetector = 'GestureDetector';",
  "react-native-keyboard-controller": "export const KeyboardEvents = { addListener: globalThis.__browserKeyboardTest.subscribe };",
  "react-native-safe-area-context": "export const useSafeAreaInsets = () => ({ top: 24, bottom: 16, left: 0, right: 0 });",
  "react-native-worklets": "export const scheduleOnRN = () => {}; export const scheduleOnUI = () => {};",
  "uniwind": "export const useCSSVariable = () => [];",
  "../components/ui/icon.tsx": "export const Icon = 'Icon';",
  "../lib/session-context.tsx": "export const useSession = () => globalThis.__browserKeyboardTest.session;",
  "./frame-canvas.tsx": `export const FrameCanvas='FrameCanvas', CursorCanvas='CursorCanvas';
    export function FrameViewport({frame,children,...props}) { return globalThis.__browserKeyboardTest.createElement('FrameViewport',props,frame,children); }`,
  "./use-region-gesture.ts": "export const useRegionGesture = () => ({ simultaneousWithExternalGesture() {} });",
  "./stream.ts": `export class BrowserStream {
    measurements = { connectionId: 'test' }; accepted = true; sent = []; closed = false;
    constructor(api, id, control, events) { this.events = events; globalThis.__browserKeyboardTest.clients.push(this); events.state('connecting'); }
    get isOpen() { return !this.closed; }
    input(value) { if (!this.accepted || this.closed) return null; this.sent.push(value); return this.sent.length; }
    displayedFrame() { return true; }
    close() { this.closed = true; }
  }`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in modules) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
// Native-module substitutions must be registered before loading the screen.
const { BrowserScreen } = await import("../src/browser/screen.tsx");

for (const { target, transition } of [
  { target: "remote", transition: ["background", "active"] },
  { target: "url", transition: ["inactive", "background", "active"] },
]) {
  test(`${target} keyboard releases space without a hide event across ${transition.join(" → ")}`, async () => {
    appState.currentState = "active";
    const root = createRoot();
    const padding = () => root.container.queryAll((node) => node.type === "View")[0].props.style as { paddingBottom: number };
    const has = (id: string) => root.container.queryAll((node) => node.props.testID === id).length > 0;
    try {
      await act(async () => { root.render(createElement(BrowserScreen, { id: "lease", control: true })); });
      assert.equal(padding().paddingBottom, 16);
      await act(async () => { emit("change", "background"); });
      await act(async () => { emit("change", "active"); });
      assert.equal(padding().paddingBottom, 16, "returning without an IME must retain the safe area");
      await showPage(root);
      const inputId = target === "remote" ? "takeover-keyboard" : "takeover-url";
      await act(async () => {
        const button = root.container.queryAll((node) => node.type === "Pressable" && node.props.testID === inputId)[0];
        (button.props.onPress as () => void)();
      });
      await act(async () => { emit("keyboardWillShow", { height: 296 }); });
      assert.equal(padding().paddingBottom, 296);
      assert.equal(has("takeover-keyboard"), false);
      assert.equal(has(target === "remote" ? "takeover-keyboard-hide" : "takeover-url-cancel"), true);
      for (const state of transition) {
        await act(async () => { emit("change", state); });
        if (state !== "active") {
          // A queued show from the interrupted animation must not restore the gap.
          await act(async () => { emit("keyboardWillShow", { height: 296 }); });
        }
      }
      assert.equal(padding().paddingBottom, 16, "the hidden IME must not reserve its former height");
      assert.equal(has("takeover-keyboard"), true, "keyboard and mode controls must return");
      assert.equal(has("takeover-url-cancel"), false, "backgrounding must also end URL editing");
      assert.equal(has("takeover-keyboard-hide"), false, "remote keyboard helper keys must not linger");
      // The reset must not disable subsequent real keyboard transitions.
      await act(async () => { emit("keyboardWillShow", { height: 320 }); });
      assert.equal(padding().paddingBottom, 320);
      await act(async () => { emit("keyboardDidHide", { height: 0 }); });
      assert.equal(padding().paddingBottom, 16);
    } finally {
      await act(async () => { root.unmount(); });
    }
    assert.equal([...listeners.values()].reduce((sum, entries) => sum + entries.size, 0), 0);
  });
}

const snapshot = { t: "pages", current: "page", epoch: 1, vp: 1, state: "human", pages: [{ id: "page", url: "https://example.com", title: "Example" }], max_pages: 8 };
async function showPage(root: Root, next = snapshot) {
  const client = clients.at(-1)!;
  const viewport = root.container.queryAll(node => node.type === "FrameViewport")[0];
  await act(async () => viewport.props.onLayout({ nativeEvent: { layout: { width: 720, height: 900 } } }));
  await act(async () => { client.events.state("open"); client.events.pages(next); });
  await act(async () => client.events.frame({ frame: { seq: 1, page: next.current, epoch: next.epoch, vp: next.vp, css: [800, 600], jpeg: [800, 600] }, jpeg: new Uint8Array() }));
  const canvas = root.container.queryAll(node => node.type === "FrameCanvas")[0];
  await act(async () => canvas.props.onDisplayed(canvas.props.candidate));
  return client;
}

test("rejected keyboard text remains pending until an explicit successful submit", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(BrowserScreen, { id: "lease", control: true })));
    const client = await showPage(root);
    await act(async () => root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0].props.onFocus());
    const input = () => root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0];
    client.accepted = false;
    await act(async () => { input().props.onChangeText("未发送"); input().props.onSubmitEditing(); });
    assert.deepEqual(client.sent, []);
    client.accepted = true;
    await act(async () => input().props.onSubmitEditing());
    assert.deepEqual(client.sent, [{ t: "text", text: "未发送" }, { t: "key", key: "Enter", code: "Enter", vk: 13, text: "\r" }]);
  } finally { await act(async () => root.unmount()); }
});

test("closed browser reconnects in place and waits for a fresh frame before enabling keyboard", async () => {
  const root = createRoot();
  const button = (id: string) => root.container.queryAll(node => node.type === "Pressable" && node.props.testID === id)[0];
  try {
    await act(async () => root.render(createElement(BrowserScreen, { id: "lease", control: true })));
    const first = await showPage(root);
    await act(async () => { first.closed = true; first.events.state("closed"); });
    assert.equal(button("takeover-keyboard").props.disabled, true);
    assert.ok(button("browser-reconnect"), "a disconnected visible screen must offer recovery");
    const count = clients.length;
    await act(async () => button("browser-reconnect").props.onPress());
    assert.equal(clients.length, count + 1);
    assert.equal(button("browser-reconnect"), undefined);
    assert.equal(button("takeover-keyboard").props.disabled, true);
    await showPage(root);
    assert.equal(button("takeover-keyboard").props.disabled, false);
    await act(async () => clients.at(-1)!.events.ended("task_cancelled"));
    assert.equal(button("browser-reconnect"), undefined, "ended leases cannot reconnect");
  } finally { await act(async () => root.unmount()); }
});

test("reconnect reports a pending settle buffer and never replays it on the fresh connection", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(BrowserScreen, { id: "lease", control: true })));
    const first = await showPage(root);
    await act(async () => root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0].props.onFocus());
    await act(async () => root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0].props.onChangeText("pending"));
    await act(async () => { first.closed = true; first.events.state("closed"); });
    await act(async () => root.container.queryAll(node => node.type === "Pressable" && node.props.testID === "browser-reconnect")[0].props.onPress());
    assert.ok(root.container.queryAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "关闭错误提示")[0]);
    const fresh = await showPage(root);
    assert.deepEqual(fresh.sent, []);
    await act(async () => root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0].props.onSubmitEditing());
    assert.deepEqual(fresh.sent, [], "late submit belongs to the ended keyboard session");
  } finally { await act(async () => root.unmount()); }
});

for (const change of [
  { label: "page", current: "second" },
  { label: "document", vp: 2 },
  { label: "control epoch", epoch: 2 },
  { label: "control state", state: "agent" },
]) {
  test(`${change.label} change ends the keyboard session before blur, settle or delayed native events`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = createRoot();
    try {
      await act(async () => root.render(createElement(BrowserScreen, { id: "lease", control: true })));
      const client = await showPage(root);
      const input = root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0];
      await act(async () => { input.props.onFocus(); input.props.onChangeText("old-page-secret"); });
      const next = { ...snapshot, ...change };
      client.accepted = false;
      await act(async () => { input.props.onSubmitEditing(); input.props.onChangeText("old-page-secret-more"); });
      assert.deepEqual(client.sent, [], "rejected text remains local before the identity change");
      await act(async () => client.events.pages(next));
      await act(async () => t.mock.timers.tick(400));
      client.accepted = true;
      await showPage(root, { ...next, state: "human" });
      await act(async () => emit("keyboardDidHide", { height: 0 }));
      assert.deepEqual(client.sent, [], "old text must never acquire the new displayed frame's credential");
      assert.equal(nativeText.get("takeover-input-text"), "", "native text must not seed the next input session");
      await act(async () => {
        input.props.onChangeText("late-old-page-secret");
        input.props.onSubmitEditing();
        input.props.onKeyPress({ nativeEvent: { key: "Backspace" } });
        t.mock.timers.tick(400);
      });
      assert.deepEqual(client.sent, [], "events from the ended input session must be ignored");
      const fresh = root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0];
      await act(async () => fresh.props.onFocus());
      assert.equal(nativeText.get("takeover-input-text"), "");
      await act(async () => { fresh.props.onChangeText("new-page-text"); fresh.props.onSubmitEditing(); });
      assert.deepEqual(client.sent, [{ t: "text", text: "new-page-text" }, { t: "key", key: "Enter", code: "Enter", vk: 13, text: "\r" }]);
    } finally { await act(async () => root.unmount()); }
  });
}

test("discarded input notice survives unrelated page and input replies until explicitly dismissed", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(BrowserScreen, { id: "lease", control: true })));
    const client = await showPage(root);
    const input = root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0];
    await act(async () => { input.props.onFocus(); input.props.onChangeText("not-sent"); });
    await act(async () => { client.closed = true; client.events.state("closed"); });
    await act(async () => root.container.queryAll(node => node.type === "Pressable" && node.props.testID === "browser-reconnect")[0].props.onPress());
    const fresh = await showPage(root);
    const before = root.container.queryAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "关闭错误提示");
    assert.equal(before.length, 1);
    await act(async () => {
      fresh.events.reply({ t: "page_done", id: 42 });
      fresh.events.reply({ t: "input_done", id: 43, input_lock_wait_ms: 0, input_dispatch_ms: 0, input_cdp_ms: 0 });
    });
    const after = root.container.queryAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "关闭错误提示");
    assert.equal(after.length, 1, "unrelated acknowledgments cannot erase lost-input recovery");
    assert.deepEqual(fresh.sent, []);
    await act(async () => after[0].props.onPress());
    assert.equal(root.container.queryAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "关闭错误提示").length, 0);
  } finally { await act(async () => root.unmount()); }
});

test("retained input offers explicit resend, survives unrelated replies, and clears only after buffer acceptance", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(BrowserScreen, { id: "lease", control: true })));
    const client = await showPage(root);
    const input = root.container.queryAll(node => node.type === "TextInput" && node.props.testID === "takeover-input-text")[0];
    client.accepted = false;
    await act(async () => { input.props.onFocus(); input.props.onChangeText("kept"); input.props.onSubmitEditing(); });
    await act(async () => client.events.reply({ t: "page_done", id: 42 }));
    const retry = root.container.queryAll(node => node.type === "Pressable" && node.props.testID === "browser-input-retry")[0];
    assert.ok(retry, "retained text needs resend, not re-entry");
    client.accepted = true;
    await act(async () => retry.props.onPress());
    assert.deepEqual(client.sent, [{ t: "text", text: "kept" }]);
    assert.equal(root.container.queryAll(node => node.props.testID === "browser-input-notice").length, 0);
  } finally { await act(async () => root.unmount()); }
});
