import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, useState } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import type { Connector, OAuthStart } from "../src/gateway/api.ts";
import { GatewayError } from "../src/gateway/api.ts";
import type { ChatSession } from "../src/gateway/session.ts";
import { applyLanguage } from "../src/lib/locale-store.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const nativeImports: Record<string, string> = {
  "expo-clipboard": "export const setStringAsync=async(value)=>{if(globalThis.__clipboardDeferred)await globalThis.__clipboardDeferred.promise;if(globalThis.__clipboardFailure)throw new Error('clipboard unavailable');globalThis.__copied.push(value);return true};",
  "expo-router": `import {useEffect} from ${JSON.stringify(import.meta.resolve("react"))};
    export const useIsFocused=()=>globalThis.__focused ?? true;
    export const useFocusEffect=(callback)=>useEffect(callback,[callback]);
    export const useLocalSearchParams=()=>globalThis.__params??{};
    export const Redirect='Redirect';
    export const router={back:()=>globalThis.__navigation?.push('back'),push:()=>{},
      canGoBack:()=>true,dismissTo:(route)=>globalThis.__navigation?.push('dismiss:'+route)};
    export const Stack={Screen:'Screen'};`,
  "react-native": `export const View='View',Image='Image',Pressable='Pressable',ScrollView='ScrollView';
    export const AccessibilityInfo={announceForAccessibility:()=>{}};
    export const BackHandler={addEventListener:()=>({remove:()=>{}})};
    export const AppState={addEventListener:(_event,listener)=>{const listeners=globalThis.__appListeners??(globalThis.__appListeners=[]);
      listeners.push(listener);return {remove:()=>{const index=listeners.indexOf(listener);if(index>=0)listeners.splice(index,1)}}}};
    export const Linking={openURL:async(url)=>{globalThis.__opened.push(url);if(globalThis.__openURLFailure)throw new Error('private browser failure?code=secret')}};`,
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/input.tsx": "export const Input='Input';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "lucide-react-native": "export const ChevronLeft='ChevronLeft',ChevronRight='ChevronRight',Plus='Plus',Trash2='Trash2';",
  "react-native-keyboard-controller": "export const KeyboardAwareScrollView='KeyboardAwareScrollView';",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({bottom:0});",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/agent-editor-controls.tsx": "export const EditorRow='EditorRow';",
  "@/components/screen-bar.tsx": "export const ScreenBar='ScreenBar';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/textarea.tsx": "export const Textarea='Textarea';",
  "@/components/ui/alert-dialog.tsx": `export const AlertDialog='AlertDialog',AlertDialogCancel='AlertDialogCancel',
    AlertDialogContent='AlertDialogContent',AlertDialogDescription='AlertDialogDescription',
    AlertDialogFooter='AlertDialogFooter',AlertDialogHeader='AlertDialogHeader',AlertDialogTitle='AlertDialogTitle';`,
  "@/lib/connection-banner.tsx": "export const ConnectionBanner='ConnectionBanner';",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__session;",
  "@/lib/connector-catalog.ts": "export const useConnectorCatalog=()=>globalThis.__catalog;",
  "@/lib/utils.ts": "export const cn=(...values)=>values.filter(Boolean).join(' ');",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeImports) return { url: `data:text/javascript,${encodeURIComponent(nativeImports[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/require\("\.\.\/\.\.\/assets\/apps\/(?:notion|github)\.png"\)/g, '"app-brand-image"') };
    return nextLoad(url, context);
  },
});

// Load after native hooks: static imports would evaluate Expo modules before substitution.
const { ConnectorOAuth } = await import("../src/components/connector-oauth.tsx");
const { default: SettingsApps } = await import("../src/app/settings-apps.tsx");
const { default: ConnectorEditor } = await import("../src/app/connector-editor.tsx");
const { default: AppDetail } = await import("../src/app/apps/[id].tsx");
const unauthorized: Connector = {
  id: "notion-connector", name: "Notion", description: "笔记", url: "https://mcp.example/mcp", transport: "streamable-http",
  auth_type: "oauth", app_id: "notion", auth: { status: "unauthorized", authorizing: false, scopes: [] },
  status: "disconnected", error: null, tool_count: 0, used_by: [], pending_restart: false,
};

function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

test("授权链接只在显式开始的当前页面可复制；粘贴完整回调、取消与远端撤销结果可见", async () => {
  const opened: string[] = [];
  const copied: string[] = [];
  Object.assign(globalThis, { __opened: opened, __copied: copied });
  let connector = unauthorized;
  const calls: unknown[] = [];
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: async () => connector,
      startConnectorOAuth: async () => {
        calls.push("start");
        connector = { ...connector, auth: { ...connector.auth, authorizing: true } };
        return { flow: "authorization_code", authorization_url: "https://login.example/authorize?state=private", expires_at: Math.floor(Date.now() / 1000) + 600,
          redirect_uri: "http://127.0.0.1:8080/oauth/callback", manual_callback: true };
      },
      completeConnectorOAuth: async (_id: string, url: string) => {
        calls.push({ callback: url });
        connector = { ...connector, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
        return { connector };
      },
      cancelConnectorOAuth: async () => { calls.push("cancel"); connector = unauthorized; return { connector }; },
      revokeConnectorOAuth: async () => { calls.push("revoke"); connector = unauthorized; return { connector, remote_revoked: false }; },
    },
  } as unknown as ChatSession;
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  const visible = (id: string) => !!byId(id);
  function Harness() {
    const [current, setCurrent] = useState(unauthorized);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    assert.equal(visible("oauth-copy-link"), false);
    assert.deepEqual(opened, []);
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.deepEqual(calls, ["start"]);
    assert.deepEqual(opened, ["https://login.example/authorize?state=private"]);
    assert.equal(visible("oauth-copy-link"), true);
    await act(async () => { byId("oauth-copy-link").props.onPress(); await nextTick(); });
    assert.deepEqual(copied, opened);
    await act(async () => byId("oauth-callback-url").props.onChangeText("http://127.0.0.1:8080/oauth/callback?code=secret&state=private"));
    await act(async () => applyLanguage("en"));
    assert.doesNotMatch(byId("oauth-callback-url").props.accessibilityLabel, /\p{Script=Han}/u);
    assert.equal(byId("oauth-callback-url").props.value, "http://127.0.0.1:8080/oauth/callback?code=secret&state=private");
    assert.deepEqual(calls, ["start"], "changing language must not restart authorization");
    assert.deepEqual(opened, ["https://login.example/authorize?state=private"], "changing language must not reopen the browser");
    await act(async () => { byId("oauth-copy-link").props.onPress(); await nextTick(); });
    assert.deepEqual(copied, [opened[0], opened[0]], "the current transaction link survives language changes");
    await act(async () => applyLanguage("zh"));
    await act(async () => { byId("oauth-submit-callback").props.onPress(); await nextTick(); });
    assert.deepEqual(calls[1], { callback: "http://127.0.0.1:8080/oauth/callback?code=secret&state=private" });
    assert.equal(visible("oauth-copy-link"), false);
    assert.equal(visible("oauth-scopes"), true);
    assert.equal(visible("oauth-callback-url"), false);
    await act(async () => { byId("oauth-revoke").props.onPress(); await nextTick(); });
    assert.equal(visible("oauth-notice"), true);
    assert.equal(visible("oauth-revoke"), false, "local authorization is cleared even when remote revocation fails");
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    await act(async () => { byId("oauth-cancel").props.onPress(); await nextTick(); });
    assert.equal(visible("oauth-copy-link"), false);
    assert.equal(calls.at(-1), "cancel");
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.equal(visible("oauth-copy-link"), true);
    await act(async () => root.render(createElement("View")));
    await act(async () => root.render(createElement(Harness)));
    assert.equal(visible("oauth-copy-link"), false, "a new page cannot recover a prior page's authorization link");
    assert.equal(visible("oauth-callback-url"), true, "pending authorization can still be cancelled or completed manually");
  } finally {
    await act(async () => root.unmount());
    applyLanguage("zh");
  }
});

test("新连接应用自动打开浏览器一次，已授权绑定仅进入管理", async () => {
  const opened: string[] = [];
  Object.assign(globalThis, { __opened: opened, __copied: [] });
  let authoritative = unauthorized;
  let starts = 0;
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: async () => authoritative,
      startConnectorOAuth: async () => {
        starts++;
        authoritative = { ...authoritative, auth: { ...authoritative.auth, authorizing: true } };
        return { flow: "authorization_code", authorization_url: "https://login.example/authorize?state=once", expires_at: Math.floor(Date.now() / 1000) + 600,
          redirect_uri: "http://127.0.0.1:8080/oauth/callback", manual_callback: true };
      },
    },
  } as unknown as ChatSession;
  const root = createRoot({ textComponentTypes: ["Text"] });
  function Harness() {
    const [connector, setConnector] = useState(authoritative);
    return createElement(ConnectorOAuth, { session, connector, onChange: setConnector, autoStart: true });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    assert.equal(starts, 1);
    assert.deepEqual(opened, ["https://login.example/authorize?state=once"]);
    await act(async () => root.render(createElement(Harness)));
    assert.equal(starts, 1, "a rerender cannot restart authorization");
    await act(async () => root.render(createElement("View")));
    authoritative = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
    await act(async () => root.render(createElement(Harness)));
    assert.equal(starts, 1, "opening an authorized binding must not restart OAuth");
    assert.equal(root.container.queryAll((node) => node.props.testID === "oauth-revoke").length, 1);
    await act(async () => root.render(createElement("View")));
    authoritative = { ...unauthorized, auth: { ...unauthorized.auth, authorizing: true } };
    await act(async () => root.render(createElement(Harness)));
    assert.equal(starts, 1, "second device reuses pending authorization instead of invalidating its state");
    assert.equal(root.container.queryAll((node) => node.props.testID === "oauth-copy-link").length, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("应用详情单次连接依序完成绑定、授权和系统浏览器，既有授权只显示管理", async () => {
  const opened: string[] = [];
  const calls: string[] = [];
  const subscribers = new Set<() => void>();
  const listeners: ((state: string) => void)[] = [];
  let connector: Connector = unauthorized;
  let bound = false;
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    api: {
      config: { baseUrl: "https://gateway.example" },
      listApps: async () => ({ apps: [{ id: "notion", name: "Notion", description: "笔记", connector: bound ? connector : null }] }),
      connectApp: async (id: string, clientId: string) => {
        assert.equal(id, "notion");
        assert.ok(clientId);
        calls.push("connect");
        bound = true;
        return { connector };
      },
      getConnector: async () => connector,
      startConnectorOAuth: async () => {
        calls.push("start");
        connector = { ...connector, auth: { ...connector.auth, authorizing: true } };
        return { flow: "authorization_code", authorization_url: "https://login.example/authorize?state=single", expires_at: Math.floor(Date.now() / 1000) + 600,
          redirect_uri: "http://127.0.0.1:8080/oauth/callback", manual_callback: true };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __session: session, __focused: true, __params: { id: "notion" }, __opened: opened,
    __copied: [], __appListeners: listeners });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  try {
    await act(async () => { root.render(createElement(AppDetail)); await nextTick(); });
    assert.ok(byId("app-connect"));
    assert.deepEqual(opened, []);
    await act(async () => { byId("app-connect").props.onPress(); await nextTick(); });
    assert.deepEqual(calls, ["connect", "start"]);
    assert.deepEqual(opened, ["https://login.example/authorize?state=single"]);
    assert.ok(byId("oauth-copy-link"));
    assert.ok(byId("app-select-agent"), "Agent scope is a separate explicit action");
    connector = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of subscribers) notify(); // resource.changed or SSE reconnect
      for (const notify of [...listeners]) notify("active");
      await nextTick();
    });
    assert.ok(byId("oauth-scopes"));
    assert.equal(byId("oauth-copy-link"), undefined, "new authorization status clears the initiating page's link");
    Object.assign(globalThis, { __focused: false });
    await act(async () => root.render(createElement(AppDetail)));
    Object.assign(globalThis, { __focused: true });
    await act(async () => { root.render(createElement(AppDetail)); await nextTick(); });
    assert.deepEqual(calls, ["connect", "start"], "focus and resource events must not restart OAuth");
    await act(async () => root.render(createElement("View")));
    connector = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
    await act(async () => { root.render(createElement(AppDetail)); await nextTick(); });
    assert.equal(byId("app-connect"), undefined);
    assert.ok(byId("oauth-revoke"));
    assert.deepEqual(calls, ["connect", "start"], "opening an authorized binding cannot silently restart OAuth");
  } finally {
    Object.assign(globalThis, { __focused: true });
    await act(async () => root.unmount());
  }
});

test("GitHub 应用连接先展示权限和验证码，仅显式点击才打开页面；状态和语言变化不重启", async () => {
  const opened: string[] = [];
  const copied: string[] = [];
  const subscribers = new Set<() => void>();
  const github: Connector = { ...unauthorized, id: "github-connector", name: "GitHub", app_id: "github" };
  let connector = github;
  let bound = false;
  let starts = 0;
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    api: {
      config: { baseUrl: "https://gateway.example" },
      listApps: async () => ({ apps: [{ id: "github", name: "GitHub", description: "连接 GitHub 仓库、Issue 与 Pull Request", connector: bound ? connector : null }] }),
      connectApp: async () => { bound = true; return { connector }; },
      getConnector: async () => connector,
      startConnectorOAuth: async () => {
        starts++;
        connector = { ...connector, auth: { ...connector.auth, authorizing: true, error: null } };
        return { flow: "device_code", authorization_url: "https://github.com/login/device",
          user_code: "ABCD-1234", expires_at: Math.floor(Date.now() / 1000) + 600 };
      },
      cancelConnectorOAuth: async () => { connector = github; return { connector }; },
      revokeConnectorOAuth: async () => {
        connector = github;
        return { connector, remote_revoked: null };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __session: session, __focused: true, __params: { id: "github" },
    __opened: opened, __copied: copied, __appListeners: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  const refresh = async () => {
    session.connectorRevision++;
    for (const notify of subscribers) notify();
    await nextTick();
  };
  try {
    await act(async () => { root.render(createElement(AppDetail)); await nextTick(); });
    assert.deepEqual(opened, []);
    await act(async () => { byId("app-connect").props.onPress(); await nextTick(); });
    assert.equal(starts, 1);
    assert.deepEqual(opened, [], "device flow must leave the code visible before opening GitHub");
    assert.equal(byId("oauth-user-code").props.children, "ABCD-1234");
    assert.ok(byId("oauth-expiry"));
    assert.equal(byId("oauth-start"), undefined, "a valid visible code cannot be replaced by a competing restart action");
    assert.equal(byId("oauth-callback-url"), undefined);
    assert.equal(byId("oauth-submit-callback"), undefined);
    assert.equal(byId("oauth-copy-link"), undefined);
    await act(async () => { byId("oauth-copy-code").props.onPress(); await nextTick(); });
    assert.deepEqual(copied, ["ABCD-1234"]);
    assert.deepEqual(opened, []);
    await act(async () => applyLanguage("en"));
    assert.ok(byId("oauth-user-code").props.accessibilityLabel.includes("ABCD-1234"));
    assert.equal(starts, 1);
    assert.deepEqual(opened, []);
    await act(async () => byId("oauth-open-browser").props.onPress());
    assert.deepEqual(opened, ["https://github.com/login/device"]);
    await act(async () => { await refresh(); root.render(createElement(AppDetail)); });
    assert.equal(starts, 1, "resource changes and rerenders cannot restart device authorization");
    Object.assign(globalThis, { __focused: false });
    await act(async () => root.render(createElement(AppDetail)));
    Object.assign(globalThis, { __focused: true });
    await act(async () => { root.render(createElement(AppDetail)); await nextTick(); });
    assert.equal(starts, 1, "refocusing cannot start another device transaction");
    assert.deepEqual(opened, ["https://github.com/login/device"]);
    await act(async () => applyLanguage("zh"));
    connector = { ...connector, auth: { status: "unauthorized", authorizing: false, scopes: [],
      error: { code: "oauth_denied", message: "secret upstream detail?device_code=private" } } };
    await act(refresh);
    assert.ok(byId("oauth-error"));
    assert.equal(String(byId("oauth-error").props.children).includes("secret"), false);
    assert.equal(byId("oauth-user-code"), undefined);
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.equal(starts, 2);
    assert.equal(byId("oauth-error"), undefined, "a new start clears the prior denial");
    await act(async () => { byId("oauth-cancel").props.onPress(); await nextTick(); });
    assert.equal(byId("oauth-user-code"), undefined);
    assert.equal(byId("oauth-callback-url"), undefined);
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    connector = { ...connector, auth: { status: "authorized", authorizing: false, scopes: ["repo", "read:org"], error: null } };
    await act(refresh);
    assert.ok(byId("oauth-scopes"));
    assert.equal(byId("oauth-user-code"), undefined);
    await act(async () => { byId("oauth-revoke").props.onPress(); await nextTick(); });
    assert.ok(byId("oauth-notice"));
  } finally {
    applyLanguage("zh");
    await act(async () => root.unmount());
  }
});

test("其他设备的 GitHub 授权等待与安全终态可见，但不恢复验证码或回调输入", async () => {
  const github: Connector = { ...unauthorized, id: "github-connector", app_id: "github",
    auth: { status: "unauthorized", authorizing: true, scopes: [] } };
  let connector = github;
  let starts = 0;
  const listeners = new Set<() => void>();
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    api: {
      getConnector: async () => connector,
      startConnectorOAuth: async () => { starts++; throw new Error("pending flow must not restart"); },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(github);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent, autoStart: true });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    assert.equal(starts, 0);
    assert.ok(byId("oauth-cancel"));
    assert.equal(byId("oauth-user-code"), undefined);
    assert.ok(byId("oauth-start"), "a page without the private code must still offer an explicit recovery action");
    assert.equal(byId("oauth-callback-url"), undefined);
    assert.equal(byId("oauth-submit-callback"), undefined);
    connector = { ...connector, auth: { status: "unauthorized", authorizing: false, scopes: [],
      error: { code: "oauth_expired", message: "unsafe upstream body" } } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.ok(byId("oauth-error"));
    assert.equal(String(byId("oauth-error").props.children).includes("unsafe"), false);
    assert.equal(byId("oauth-cancel"), undefined);
    connector = { ...connector, auth: { ...connector.auth,
      error: { code: "oauth_unavailable", message: "upstream token response with secret" } } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.ok(byId("oauth-error"));
    assert.equal(String(byId("oauth-error").props.children).includes("secret"), false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("设备授权终态优先于本地复制失败，且不展示上游错误正文", async () => {
  let connector: Connector = { ...unauthorized, app_id: "github" };
  const listeners = new Set<() => void>();
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    api: {
      getConnector: async () => connector,
      startConnectorOAuth: async () => {
        connector = { ...connector, auth: { ...connector.auth, authorizing: true } };
        return { flow: "device_code", authorization_url: "https://github.com/login/device",
          user_code: "ABCD-1234", expires_at: Date.now() / 1000 + 600 };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [], __clipboardFailure: true });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(connector);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    await act(async () => { byId("oauth-copy-code").props.onPress(); await nextTick(); });
    const localFailure = byId("oauth-error").props.children;
    connector = { ...connector, auth: { status: "unauthorized", authorizing: false, scopes: [],
      error: { code: "oauth_denied", message: "private token endpoint response" } } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.notEqual(byId("oauth-error").props.children, localFailure);
    assert.equal(String(byId("oauth-error").props.children).includes("private"), false);
    assert.equal(byId("oauth-user-code"), undefined);
    assert.equal(byId("oauth-copy-code"), undefined);
  } finally {
    Object.assign(globalThis, { __clipboardFailure: false });
    await act(async () => root.unmount());
  }
});

test("Notion 浏览器无法打开时成功读取等待状态仍保留可复制链接及恢复提示", async () => {
  let authoritative: Connector = unauthorized;
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: async () => authoritative,
      startConnectorOAuth: async () => {
        authoritative = { ...unauthorized, auth: { ...unauthorized.auth, authorizing: true } };
        return { flow: "authorization_code", authorization_url: "https://login.example/authorize?state=private",
          expires_at: Date.now() / 1000 + 600, redirect_uri: "http://127.0.0.1:8080/oauth/callback", manual_callback: true };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [], __openURLFailure: true });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(unauthorized);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.ok(byId("oauth-copy-link"), "the link must remain available when opening the browser fails");
    assert.ok(byId("oauth-error"), "browser recovery must stay visible after a pending snapshot");
    assert.match(String(byId("oauth-error").props.children), /无法打开系统浏览器.*复制本次授权链接/);
    assert.doesNotMatch(String(byId("oauth-error").props.children), /secret|private/);
  } finally {
    Object.assign(globalThis, { __openURLFailure: false });
    await act(async () => root.unmount());
  }
});

for (const initialStatus of ["unauthorized", "authorized"] as const)
test(`Notion 手动回调拒绝后读取到无错误的非等待状态仍显示本次拒绝 (${initialStatus})`, async () => {
  const initial: Connector = { ...unauthorized, auth: { ...unauthorized.auth, status: initialStatus } };
  let authoritative: Connector = initial;
  let reads = 0;
  let starts = 0;
  const callback = "http://127.0.0.1:8080/oauth/callback?error=access_denied&state=private";
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: async () => { reads++; return authoritative; },
      startConnectorOAuth: async () => {
        starts++;
        authoritative = { ...initial, auth: { ...initial.auth, authorizing: true } };
        return { flow: "authorization_code", authorization_url: "https://login.example/authorize?state=private",
          expires_at: Date.now() / 1000 + 600, redirect_uri: "http://127.0.0.1:8080/oauth/callback", manual_callback: true };
      },
      completeConnectorOAuth: async (_id: string, url: string) => {
        assert.equal(url, callback);
        authoritative = initial;
        throw new GatewayError(400, "oauth_denied", "private upstream callback?code=secret");
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(initial);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.ok(byId("oauth-callback-url"));
    await act(async () => byId("oauth-callback-url").props.onChangeText(callback));
    const readsBeforeCallback = reads;
    await act(async () => { byId("oauth-submit-callback").props.onPress(); await nextTick(); });
    assert.ok(reads > readsBeforeCallback, "failed callback must reconcile the cleared gateway pending state");
    assert.match(String(byId("oauth-status").props.children), initialStatus === "authorized" ? /已授权/ : /未授权/);
    assert.equal(byId("oauth-callback-url"), undefined);
    assert.ok(byId("oauth-error"), "the callback denial must survive its nonpending reconciliation snapshot");
    const warning = String(byId("oauth-error").props.children);
    assert.match(warning, /未同意服务方授权/);
    assert.doesNotMatch(warning, /secret|private|access_denied/);
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.equal(starts, 2);
    assert.equal(byId("oauth-error"), undefined, "a new transaction clears the old callback denial");
  } finally {
    await act(async () => root.unmount());
  }
});

test("旧验证码复制失败迟到时不覆盖新的 GitHub 授权拒绝", async () => {
  const github: Connector = { ...unauthorized, id: "github-connector", app_id: "github" };
  let authoritative = github;
  const clipboard = Promise.withResolvers<void>();
  const listeners = new Set<() => void>();
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    api: {
      getConnector: async () => authoritative,
      startConnectorOAuth: async () => {
        authoritative = { ...github, auth: { ...github.auth, authorizing: true } };
        return { flow: "device_code", authorization_url: "https://github.com/login/device",
          user_code: "ABCD-1234", expires_at: Date.now() / 1000 + 600 };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [], __clipboardDeferred: clipboard });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(github);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    await act(async () => { byId("oauth-copy-code").props.onPress(); await nextTick(); });
    authoritative = { ...github, auth: { ...github.auth,
      error: { code: "oauth_denied", message: "private terminal response?token=secret" } } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.match(String(byId("oauth-error").props.children), /未同意服务方授权/);
    clipboard.reject(new Error("private clipboard failure?token=secret"));
    await act(async () => nextTick());
    const warning = String(byId("oauth-error").props.children);
    assert.match(warning, /未同意服务方授权/, "the new terminal outcome must survive a late clipboard rejection");
    assert.doesNotMatch(warning, /无法复制验证码|secret|private/);
    assert.equal(byId("oauth-user-code"), undefined);
  } finally {
    Object.assign(globalThis, { __clipboardDeferred: null });
    await act(async () => root.unmount());
  }
});

test("新 GitHub 事务未观察到等待态即以相同错误码终止时展示新终态", async () => {
  const github: Connector = { ...unauthorized, id: "github-connector", app_id: "github",
    auth: { ...unauthorized.auth, error: { code: "oauth_unavailable", message: "private previous failure" } } };
  const terminal = Promise.withResolvers<Connector>();
  let started = false;
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: () => started ? terminal.promise : Promise.resolve(github),
      startConnectorOAuth: async () => {
        started = true;
        return { flow: "device_code", authorization_url: "https://github.com/login/device",
          user_code: "EFGH-5678", expires_at: Date.now() / 1000 + 600 };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(github);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    assert.match(String(byId("oauth-error").props.children), /服务暂不可用/);
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.equal(started, true);
    assert.equal(byId("oauth-user-code").props.children, "EFGH-5678");
    terminal.resolve({ ...github, auth: { ...github.auth,
      error: { code: "oauth_unavailable", message: "private new transaction failure?token=secret" } } });
    await act(async () => nextTick());
    assert.equal(byId("oauth-user-code"), undefined, "a terminal outcome closes the new transaction");
    assert.ok(byId("oauth-error"), "the new terminal failure must be visible after the transaction ends");
    const warning = String(byId("oauth-error").props.children);
    assert.match(warning, /服务暂不可用/, "the new transaction's terminal failure must be shown");
    assert.doesNotMatch(warning, /secret|private/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("GitHub 授权过期后重新发起失败且状态读取失败时显示新失败", async () => {
  const github: Connector = { ...unauthorized, id: "github-connector", app_id: "github" };
  let authoritative = github;
  let failReads = false;
  let reads = 0;
  let starts = 0;
  const listeners = new Set<() => void>();
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    api: {
      getConnector: async () => {
        reads++;
        if (failReads) throw new Error("private status response?token=secret");
        return authoritative;
      },
      startConnectorOAuth: async () => {
        starts++;
        if (starts === 1) {
          failReads = true;
          throw new Error("private start response?code=secret");
        }
        failReads = false;
        authoritative = { ...github, auth: { ...github.auth, authorizing: true } };
        return { flow: "device_code", authorization_url: "https://github.com/login/device",
          user_code: "EFGH-5678", expires_at: Date.now() / 1000 + 600 };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(github);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    authoritative = { ...github, auth: { ...github.auth,
      error: { code: "oauth_expired", message: "private expired response?token=secret" } } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.match(String(byId("oauth-error").props.children), /已过期/);
    const readsBeforeCommand = reads;
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.equal(starts, 1);
    assert.ok(reads > readsBeforeCommand, "failed command must still attempt a status reconciliation");
    const warning = String(byId("oauth-error").props.children);
    assert.match(warning, /无法发起授权/, "the new command failure must replace the stale expiry");
    assert.doesNotMatch(warning, /已过期|secret|private/);
    await act(async () => { byId("oauth-start").props.onPress(); await nextTick(); });
    assert.equal(starts, 2);
    assert.equal(byId("oauth-user-code").props.children, "EFGH-5678");
    assert.equal(byId("oauth-error"), undefined, "a successful new transaction clears both prior failures");
  } finally {
    await act(async () => root.unmount());
  }
});

test("GitHub 旧凭据仍有效时重新授权被拒后撤销失败显示授权可能仍有效", async () => {
  const github: Connector = { ...unauthorized, id: "github-connector", app_id: "github",
    auth: { status: "authorized", authorizing: false, scopes: ["repo"] } };
  let authoritative = github;
  let failReads = false;
  let reads = 0;
  let revokes = 0;
  const listeners = new Set<() => void>();
  const session = {
    connectorRevision: 0,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    api: {
      getConnector: async () => {
        reads++;
        if (failReads) throw new Error("private status response?token=secret");
        return authoritative;
      },
      revokeConnectorOAuth: async () => {
        revokes++;
        failReads = true;
        throw new Error("private revoke response?token=secret");
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __focused: true, __opened: [], __copied: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  function Harness() {
    const [current, setCurrent] = useState(github);
    return createElement(ConnectorOAuth, { session, connector: current, onChange: setCurrent });
  }
  try {
    await act(async () => { root.render(createElement(Harness)); await nextTick(); });
    authoritative = { ...github, auth: { ...github.auth,
      error: { code: "oauth_denied", message: "private reauthorization response?code=secret" } } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.match(String(byId("oauth-error").props.children), /未同意服务方授权/);
    assert.ok(byId("oauth-revoke"), "denied reauthorization must not hide existing credentials");
    const readsBeforeCommand = reads;
    await act(async () => { byId("oauth-revoke").props.onPress(); await nextTick(); });
    assert.equal(revokes, 1);
    assert.ok(reads > readsBeforeCommand, "failed revoke must still attempt a status reconciliation");
    assert.ok(byId("oauth-revoke"), "failed revocation leaves the old credentials potentially valid");
    const warning = String(byId("oauth-error").props.children);
    assert.match(warning, /授权可能仍有效/, "the newer revocation warning must replace the older reauthorization denial");
    assert.doesNotMatch(warning, /未同意服务方授权|secret|private/);
    failReads = false;
    authoritative = { ...github, auth: { status: "unauthorized", authorizing: false, scopes: [] } };
    await act(async () => {
      session.connectorRevision++;
      for (const notify of listeners) notify();
      await nextTick();
    });
    assert.equal(byId("oauth-error"), undefined, "a newer successful status snapshot clears the old local warning");
    assert.equal(byId("oauth-revoke"), undefined);
  } finally {
    await act(async () => root.unmount());
  }
});

test("旧连接回执不能覆盖其他设备已授权或等待中的当前状态", async () => {
  const states: { label: string; current: Connector; status: RegExp; action: string }[] = [
    { label: "authorized", current: { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } },
      status: /已授权/, action: "oauth-revoke" },
    { label: "pending", current: { ...unauthorized, auth: { ...unauthorized.auth, authorizing: true } },
      status: /等待浏览器完成/, action: "oauth-cancel" },
  ];
  for (const { label, current, status, action } of states) {
    const opened: string[] = [];
    const calls: string[] = [];
    const session = {
      connectorRevision: 0,
      subscribe: () => () => {},
      api: {
        config: { baseUrl: "https://gateway.example" },
        listApps: async () => ({ apps: [{ id: "notion", name: "Notion", description: "笔记", connector: null }] }),
        connectApp: async () => { calls.push("connect"); return { connector: unauthorized }; },
        getConnector: async (id: string) => { assert.equal(id, current.id); calls.push("get"); return current; },
        startConnectorOAuth: async () => { calls.push("start"); throw new Error("must not restart another device's transaction"); },
      },
    } as unknown as ChatSession;
    Object.assign(globalThis, { __session: session, __focused: true, __params: { id: "notion" }, __opened: opened,
      __appListeners: [] });
    const root = createRoot({ textComponentTypes: ["Text"] });
    const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
    try {
      await act(async () => { root.render(createElement(AppDetail)); await nextTick(); });
      await act(async () => { byId("app-connect").props.onPress(); await nextTick(); });
      assert.deepEqual(calls.slice(0, 2), ["connect", "get"], `${label}: read current status before mounting controls`);
      assert.equal(calls.includes("start"), false, `${label}: stale receipt cannot restart OAuth`);
      assert.deepEqual(opened, [], `${label}: stale receipt must not open the browser`);
      assert.match(String(byId("oauth-status").props.children), status);
      assert.ok(byId(action));
      assert.equal(byId("oauth-copy-link"), undefined);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test("撤销响应之后迟到的旧授权快照不能恢复已授权显示", async () => {
  const oldRead = Promise.withResolvers<Connector>();
  const authorized: Connector = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
  let authoritative = authorized;
  let reads = 0;
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: () => ++reads === 1 ? oldRead.promise : Promise.resolve(authoritative),
      revokeConnectorOAuth: async () => {
        authoritative = unauthorized;
        return { connector: authoritative, remote_revoked: true };
      },
    },
  } as unknown as ChatSession;
  const root = createRoot({ textComponentTypes: ["Text"] });
  function Harness() {
    const [connector, setConnector] = useState(authorized);
    return createElement(ConnectorOAuth, { session, connector, onChange: setConnector });
  }
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => { byId("oauth-revoke").props.onPress(); await nextTick(); });
    assert.match(String(byId("oauth-status").props.children), /未授权/);
    oldRead.resolve(authorized);
    await act(async () => nextTick());
    assert.match(String(byId("oauth-status").props.children), /未授权/);
    assert.equal(root.container.queryAll((node) => node.props.testID === "oauth-revoke").length, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("不支持 DCR/S256 以受控错误提示，不回显上游异常或误称网络重试", async () => {
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: async () => unauthorized,
      startConnectorOAuth: async () => { throw new GatewayError(409, "unsupported_oauth", "private upstream URL?code=secret"); },
    },
  } as unknown as ChatSession;
  const root = createRoot({ textComponentTypes: ["Text"] });
  try {
    await act(async () => root.render(createElement(ConnectorOAuth, { session, connector: unauthorized, onChange: () => {} })));
    await act(async () => {
      root.container.queryAll((node) => node.props.testID === "oauth-start")[0].props.onPress();
      await nextTick();
    });
    const error = String(root.container.queryAll((node) => node.props.testID === "oauth-error")[0].props.children);
    assert.match(error, /DCR.*S256/);
    assert.equal(error.includes("private upstream"), false);
    assert.equal(error.includes("网络重试"), false);
  } finally {
    await act(async () => root.unmount());
  }
});

test("授权准备期间进入高级编辑器，失焦页面不打开迟到的浏览器链接", async () => {
  const opened: string[] = [];
  Object.assign(globalThis, { __opened: opened, __focused: true });
  const deferred = Promise.withResolvers<OAuthStart>();
  let authoritative = unauthorized;
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: {
      getConnector: async () => authoritative,
      startConnectorOAuth: () => {
        authoritative = { ...unauthorized, auth: { ...unauthorized.auth, authorizing: true } };
        return deferred.promise;
      },
    },
  } as unknown as ChatSession;
  const root = createRoot({ textComponentTypes: ["Text"] });
  function Harness() {
    const [connector, setConnector] = useState(unauthorized);
    return createElement(ConnectorOAuth, { session, connector, onChange: setConnector });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => root.container.queryAll((node) => node.props.testID === "oauth-start")[0].props.onPress());
    Object.assign(globalThis, { __focused: false });
    await act(async () => root.render(createElement(Harness)));
    deferred.resolve({ flow: "authorization_code", authorization_url: "https://login.example/authorize?state=obsolete",
      expires_at: Math.floor(Date.now() / 1000) + 600, redirect_uri: "http://127.0.0.1:8080/oauth/callback", manual_callback: true });
    await act(async () => nextTick());
    assert.deepEqual(opened, []);
    assert.equal(root.container.queryAll((node) => node.props.testID === "oauth-copy-link").length, 0);
    Object.assign(globalThis, { __focused: true });
    await act(async () => root.render(createElement(Harness)));
    assert.equal(root.container.queryAll((node) => node.props.testID === "oauth-cancel").length, 1);
    assert.equal(root.container.queryAll((node) => node.props.testID === "oauth-copy-link").length, 0);
  } finally {
    Object.assign(globalThis, { __focused: true });
    await act(async () => root.unmount());
  }
});

test("应用列表回前台独立刷新；较早的快照不能覆盖较新的授权状态", async () => {
  const listeners: ((state: string) => void)[] = [];
  const oldRead = Promise.withResolvers<{ apps: { id: string; name: string; description: string; connector: Connector }[] }>();
  const before = { apps: [{ id: "notion", name: "Notion", description: "笔记", connector: unauthorized }] };
  const authorized = { apps: [{ ...before.apps[0], connector: { ...unauthorized,
    auth: { status: "authorized" as const, authorizing: false, scopes: ["read"] } } }] };
  let nextRead: Promise<typeof before> = Promise.resolve(before);
  let reads = 0;
  const session = {
    connectorRevision: 0,
    subscribe: () => () => {},
    api: { config: { baseUrl: "https://gateway.example" }, listApps: () => { reads++; return nextRead; } },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __session: session, __appListeners: listeners, __focused: true });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const hasAuthorized = () => root.container.queryAll((node) =>
    typeof node.props.children === "string" && node.props.children.includes("已授权")).length > 0;
  try {
    await act(async () => { root.render(createElement(SettingsApps)); await nextTick(); });
    assert.equal(hasAuthorized(), false);
    const first = reads;
    nextRead = oldRead.promise;
    await act(async () => { for (const notify of [...listeners]) notify("active"); await Promise.resolve(); });
    nextRead = Promise.resolve(authorized);
    await act(async () => { for (const notify of [...listeners]) notify("active"); await nextTick(); });
    assert.ok(reads >= first + 2, "foreground itself triggers GET /apps without navigation or SSE");
    assert.equal(hasAuthorized(), true);
    oldRead.resolve(before);
    await act(async () => nextTick());
    assert.equal(hasAuthorized(), true, "obsolete foreground response is discarded");
  } finally {
    await act(async () => root.unmount());
  }
});

test("实际编辑器只有授权控件更新状态，旧 GET 不会在撤销之后复活授权", async () => {
  const authorized: Connector = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
  const oldRead = Promise.withResolvers<Connector>();
  let revoked = false;
  let reads = 0;
  const subscribers = new Set<() => void>();
  const session = {
    connectorRevision: 0,
    deletedConnectorIds: new Set<string>(),
    connectorDefinitionSeq: new Map<string, number>(),
    subscribe: (listener: () => void) => { subscribers.add(listener); return () => subscribers.delete(listener); },
    api: {
      getConnector: () => {
        reads++;
        if (reads === 1) return Promise.resolve(authorized);
        return revoked ? Promise.resolve(unauthorized) : oldRead.promise;
      },
      revokeConnectorOAuth: async () => {
        revoked = true;
        return { connector: unauthorized, remote_revoked: true };
      },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __session: session, __focused: true, __params: { id: authorized.id },
    __catalog: { loaded: true, connectors: [authorized], refresh: () => {} }, __appListeners: [], __opened: [] });
  const root = createRoot({ textComponentTypes: ["Text", "AlertDialogTitle", "AlertDialogDescription"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  try {
    await act(async () => { root.render(createElement(ConnectorEditor)); await nextTick(); });
    assert.ok(byId("oauth-revoke"));
    assert.ok(reads >= 2, "the child has begun a status refresh");
    await act(async () => {
      session.connectorRevision++;
      for (const notify of subscribers) notify(); // resource.changed while the old GET is still pending
      await Promise.resolve();
    });
    assert.ok(reads >= 3, "the editor must refresh the OAuth status on connector events");
    await act(async () => { byId("oauth-revoke").props.onPress(); await nextTick(); });
    assert.match(String(byId("oauth-status").props.children), /未授权/);
    oldRead.resolve(authorized);
    await act(async () => nextTick());
    assert.match(String(byId("oauth-status").props.children), /未授权/);
    assert.equal(byId("oauth-revoke"), undefined, "the parent must not feed its late snapshot back into OAuth");
  } finally {
    await act(async () => root.unmount());
  }
});

test("编辑器删除按稳定错误码区分远端撤销失败和 Agent 引用冲突", async () => {
  const authorized: Connector = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
  let connector = authorized;
  let deleteFailure: GatewayError = new GatewayError(409, "remote_revocation_failed", "secret upstream token");
  let refreshes = 0;
  let revisions = 0;
  const session = {
    connectorRevision: 0,
    deletedConnectorIds: new Set<string>(),
    connectorDefinitionSeq: new Map<string, number>(),
    subscribe: () => () => {},
    refreshConnectors: () => { revisions++; connector = unauthorized; },
    api: {
      getConnector: async () => connector,
      deleteConnector: async () => { throw deleteFailure; },
    },
  } as unknown as ChatSession;
  Object.assign(globalThis, { __session: session, __focused: true, __params: { id: authorized.id },
    __catalog: { loaded: true, connectors: [authorized], refresh: () => { refreshes++; } },
    __appListeners: [], __opened: [] });
  const root = createRoot({ textComponentTypes: ["Text", "AlertDialogTitle", "AlertDialogDescription"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  try {
    await act(async () => { root.render(createElement(ConnectorEditor)); await nextTick(); });
    await act(async () => { byId("connector-delete").props.onPress(); await nextTick(); });
    await act(async () => { byId("connector-delete-confirm").props.onPress(); await nextTick(); });
    assert.equal(byId("connector-delete-blocked"), undefined);
    assert.match(String(byId("connector-delete-error").props.children), /本地授权已清除.*远端撤销失败/);
    assert.equal(String(byId("connector-delete-error").props.children).includes("secret"), false);
    assert.equal(revisions, 1);
    assert.equal(refreshes, 1);
    deleteFailure = new GatewayError(409, "rejected", "仍被引用", { used_by: [{ id: "agent", name: "研究者" }] });
    await act(async () => { byId("connector-delete-confirm").props.onPress(); await nextTick(); });
    assert.ok(byId("connector-delete-blocked"));
    const message = root.container.queryAll((node) => node.type === "AlertDialogDescription")
      .map((node) => String(node.props.children)).join(" ");
    assert.match(message, /研究者/);
  } finally {
    await act(async () => root.unmount());
  }
});

test("应用来源的删除事件、成功响应与404都只返回应用详情一次", async () => {
  const navigations: string[] = [];
  const deleted = new Set<string>();
  const authorized: Connector = { ...unauthorized, auth: { status: "authorized", authorizing: false, scopes: ["read"] } };
  const event = { seq: 1, type: "resource.changed", data: { kind: "connector", id: authorized.id, op: "deleted" } };
  const response = Promise.withResolvers<{ event: typeof event }>();
  let missing = false;
  const session = {
    connectorRevision: 0,
    deletedConnectorIds: deleted,
    connectorDefinitionSeq: new Map<string, number>(),
    subscribe: () => () => {},
    api: {
      getConnector: async () => {
        if (missing) throw new GatewayError(404, "not_found", "不存在");
        return authorized;
      },
      deleteConnector: () => response.promise,
    },
    connectorChanged: () => { deleted.add(authorized.id); },
  } as unknown as ChatSession;
  Object.assign(globalThis, {
    __session: session, __focused: true, __params: { id: authorized.id, fromApp: "notion" },
    __navigation: navigations, __catalog: { loaded: true, connectors: [authorized], refresh: () => {} },
    __appListeners: [], __opened: [],
  });
  const root = createRoot({ textComponentTypes: ["Text", "AlertDialogTitle", "AlertDialogDescription"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
  try {
    await act(async () => { root.render(createElement(ConnectorEditor)); await nextTick(); });
    await act(async () => { byId("connector-delete").props.onPress(); await nextTick(); });
    await act(async () => byId("connector-delete-confirm").props.onPress());
    deleted.add(authorized.id);
    await act(async () => root.render(createElement(ConnectorEditor)));
    assert.deepEqual(navigations, ["back"]);
    response.resolve({ event });
    await act(async () => { await nextTick(); root.render(createElement(ConnectorEditor)); });
    assert.deepEqual(navigations, ["back"], "late DELETE response cannot navigate a second time");

    await act(async () => root.render(createElement("View")));
    deleted.clear();
    missing = true;
    await act(async () => { root.render(createElement(ConnectorEditor)); await nextTick(); });
    assert.deepEqual(navigations, ["back", "back"], "404 before loading the definition still respects the app source");
  } finally {
    await act(async () => root.unmount());
  }
});
