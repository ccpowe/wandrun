import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import type { AgentCapability, BuiltinSkillDetail } from "../src/gateway/api.ts";

declare global {
  var __back: (() => boolean) | null;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const react = JSON.stringify(import.meta.resolve("react"));
const nativeImports: Record<string, string> = {
  "expo-router": `import {useEffect} from ${react};
    export const Stack={Screen:'Screen'},Redirect='Redirect';
    export const useLocalSearchParams=()=>globalThis.__params;
    export const useIsFocused=()=>true;
    export const useFocusEffect=(callback)=>useEffect(callback,[callback]);
    export const router={push:(path)=>globalThis.__navigation.push(path),back:()=>globalThis.__navigation.push('back'),dismissTo:(path)=>globalThis.__navigation.push(path)};`,
  "lucide-react-native": `export const Bookmark='Bookmark',ChevronLeft='ChevronLeft',ChevronRight='ChevronRight',Clock3='Clock3',CodeXml='CodeXml',File='File',Globe2='Globe2',Image='Image',LayoutPanelTop='LayoutPanelTop',Search='Search',Terminal='Terminal',Plus='Plus',UserRound='UserRound',X='X';`,
  "react-native": `export const View='View',Text='Text',Pressable='Pressable',ScrollView='ScrollView',RefreshControl='RefreshControl';
    export const Platform={OS:'android',select:(values)=>values.android??values.native??values.default};
    export const BackHandler={addEventListener:(_event,callback)=>{globalThis.__back=callback;return {remove(){globalThis.__back=null}}}};
    export const AccessibilityInfo={setAccessibilityFocus(){}},findNodeHandle=()=>null;
    export const Dimensions={get:()=>({width:390,height:800})};
    export const Alert={alert:()=>{}};`,
  "react-native-screens": "export const FullWindowOverlay='FullWindowOverlay';",
  "react-native-reanimated": `const animation={duration(){return this},delay(){return this},reduceMotion(){return this}};
    export const FadeIn=animation,FadeOut=animation,ReduceMotion={System:0};`,
  "@/components/ui/native-only-animated-view.tsx": `export const NativeOnlyAnimatedView=({as='View',children,...props})=>globalThis.__React.createElement(as,props,children);`,
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({bottom:0});",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/screen-bar.tsx": "export const ScreenBar=({title,left,right})=>globalThis.__React.createElement('ScreenBar',{title},left,right);",
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/agent-memory-markdown.tsx": "export const AgentMemoryMarkdown=({content})=>globalThis.__React.createElement('Markdown',{content});",
  "@/components/wandrun-avatar.tsx": "export const WandrunAvatar='Avatar';",
  "@/lib/connection-banner.tsx": "export const ConnectionBanner=()=>null;",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__session;",
  "@/lib/upload-drafts.ts": "export const acquireUploadDraft=()=>({controller:{},release:()=>{}});",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeImports) return { url: `data:text/javascript,${encodeURIComponent(nativeImports[specifier])}`, shortCircuit: true };
    if (specifier === "./dialog" && context.parentURL?.endsWith("/@rn-primitives/dialog/dist/index.mjs")) {
      return { url: new URL("./dialog.mjs", context.parentURL).href, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx") || (url.includes("/node_modules/@rn-primitives/") && url.endsWith(".mjs"))) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});
Object.assign(globalThis, { __React: { createElement } });
// Install native resolution hooks before loading the real Dialog/Portal modules.
const { PortalHost } = await import("@rn-primitives/portal");
const capabilityPage = () => createElement("Page", null, createElement(AgentCapabilities), createElement(PortalHost));
const { default: AgentCapabilities } = await import("../src/app/agent-capabilities.tsx");
const { default: SettingsSkills } = await import("../src/app/settings-skills.tsx");
const { default: BuiltinDetail } = await import("../src/app/builtin-skill-detail.tsx");

const capability = (id: string, status: AgentCapability["status"], reason: string, tools: string[] = []): AgentCapability => ({
  id, name: id, summary: `摘要 ${id}`, description: `详细说明 ${id}`, status, reason, tools, skills: [],
});
const builtin: BuiltinSkillDetail = {
  name: "wandrun-ui", description: "在消息里显示表单、图表等界面", capability: { id: "ui_blocks", name: "交互界面" },
  used_by: [{ id: "assistant", name: "助手" }], content: "---\nname: wandrun-ui\n---\n# 内置用法\n",
};

test("系统能力展示已提交状态：可点击项展开工具和适用原因，未启用项不可点击；资源事件刷新", async () => {
  let version = 0;
  const listeners = new Set<() => void>();
  let rows = [capability("files", "enabled", "所有 Agent 都有", ["read_file", "write_file"]),
    capability("browser", "not_applicable", "电脑未配置浏览器")];
  const session = {
    agents: { get definitionVersion() { return version; } }, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    api: { getAgentCapabilities: async () => ({ capabilities: rows }) },
  };
  Object.assign(globalThis, { __session: session, __params: { id: "assistant" }, __navigation: [] });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id);
  try {
    await act(async () => root.render(capabilityPage()));
    assert.equal(byId("capability-files").length, 1);
    assert.equal(byId("capability-unavailable-browser").length, 1);
    assert.equal(byId("capability-unavailable-browser")[0].props.onPress, undefined);
    assert.equal(byId("capability-sheet").length, 0);
    await act(async () => byId("capability-files")[0].props.onPress());
    assert.equal(byId("capability-sheet-title")[0].props.children, "files");
    const text = root.container.queryAll((node) => node.type === "Text").map((node) => node.props.children);
    assert.ok(text.includes("read_file") && text.includes("write_file") && text.includes("所有 Agent 都有"));
    rows = [capability("files", "disabled", "未开启")];
    await act(async () => { version++; for (const listener of listeners) listener(); });
    assert.equal(byId("capability-unavailable-files").length, 1);
    assert.equal(byId("capability-sheet").length, 0, "new committed status closes stale details");
    rows = [capability("files", "enabled", "所有 Agent 都有", ["read_file"])];
    await act(async () => { version++; for (const listener of listeners) listener(); });
    assert.equal(byId("capability-files").length, 1);
    assert.equal(byId("capability-sheet").length, 0, "re-enabling must not resurrect the revoked selection");
    await act(async () => byId("capability-files")[0].props.onPress());
    assert.equal(byId("capability-sheet-title")[0].props.children, "files", "only a new user press opens details again");
  } finally { await act(async () => root.unmount()); }
});

test("能力页持续聚焦且 Agent 定义不变时，连接恢复自动加载新环境的状态和工具", async () => {
  const listeners = new Set<() => void>();
  let rows = [capability("browser", "not_applicable", "电脑未配置浏览器")];
  const session = {
    connection: "open", agents: { definitionVersion: 7 },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    api: { getAgentCapabilities: async () => ({ capabilities: rows }) },
  };
  Object.assign(globalThis, { __session: session, __params: { id: "assistant" } });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id);
  try {
    await act(async () => root.render(capabilityPage()));
    assert.equal(byId("capability-unavailable-browser").length, 1);
    await act(async () => { session.connection = "reconnecting"; for (const listener of listeners) listener(); });
    rows = [capability("browser", "enabled", "已配置浏览器", ["request_takeover"])];
    await act(async () => { session.connection = "open"; for (const listener of listeners) listener(); });
    assert.equal(byId("capability-unavailable-browser").length, 0);
    assert.equal(byId("capability-browser").length, 1);
    assert.equal(byId("capability-sheet").length, 0);
    await act(async () => byId("capability-browser")[0].props.onPress());
    assert.ok(root.container.queryAll((node) => node.type === "Text").some((node) => node.props.children === "request_takeover"));
  } finally { await act(async () => root.unmount()); }
});

test("能力详情使用真实原生 Dialog：遮罩、关闭按钮和 Android Back 都能关闭，再打开仍显示内容", async () => {
  const session = {
    agents: { definitionVersion: 0 }, subscribe: () => () => {},
    api: { getAgentCapabilities: async () => ({ capabilities: [capability("files", "enabled", "所有 Agent 都有", ["read_file"])] }) },
  };
  Object.assign(globalThis, { __session: session, __params: { id: "assistant" } });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id);
  try {
    await act(async () => root.render(capabilityPage()));
    for (const dismiss of [
      () => byId("capability-backdrop")[0].props.onPress({}),
      () => root.container.queryAll((node) => node.props.accessibilityLabel === "关闭")[0].props.onPress({}),
      () => { assert.ok(globalThis.__back); return globalThis.__back(); },
    ]) {
      await act(async () => byId("capability-files")[0].props.onPress());
      assert.equal(byId("capability-sheet-title")[0].props.children, "files");
      assert.equal(byId("capability-sheet")[0].props.onStartShouldSetResponder(), true, "content consumes touches rather than dismissing through the backdrop");
      await act(async () => dismiss());
      assert.equal(byId("capability-sheet").length, 0);
    }
  } finally { await act(async () => root.unmount()); }
});

test("内置技能与同名用户目录分别列出；内置详情仅展示来源、能力与真实内容，不提供删除", async () => {
  const session = {
    skillRevision: 0, subscribe: () => () => {}, agents: { agents: [] },
    api: {
      listSkills: async () => ({ skills: [{ name: "wandrun-ui", description: "用户目录", used_by: [], status: "error", error: "名称被网关内置技能占用" }], default_agent_id: "assistant" }),
      listBuiltinSkills: async () => ({ skills: [builtin] }), getBuiltinSkill: async () => builtin,
    },
  };
  const navigation: unknown[] = [];
  Object.assign(globalThis, { __session: session, __params: { name: "wandrun-ui" }, __navigation: navigation });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id);
  try {
    await act(async () => root.render(createElement(SettingsSkills)));
    assert.equal(byId("builtin-skill-wandrun-ui").length, 1);
    assert.equal(byId("skill-wandrun-ui").length, 1);
    await act(async () => byId("builtin-skill-wandrun-ui")[0].props.onPress());
    assert.deepEqual(navigation, [{ pathname: "/builtin-skill-detail", params: { name: "wandrun-ui" } }]);
    await act(async () => root.render(createElement(BuiltinDetail)));
    assert.equal(byId("builtin-agent-assistant").length, 1);
    assert.match(byId("builtin-skill-content")[0].queryAll((node) => node.type === "Markdown")[0].props.content, /内置用法/);
    assert.equal(byId("skill-delete").length, 0);
  } finally { await act(async () => root.unmount()); }
});
