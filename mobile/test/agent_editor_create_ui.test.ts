import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import { GatewayApi } from "../src/gateway/api.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const react = JSON.stringify(import.meta.resolve("react"));
const nativeImports: Record<string, string> = {
  "expo-router": `import {useEffect} from ${react}; export const Redirect='Redirect'; export const Stack={Screen:'Screen'};
    export const useLocalSearchParams=()=>globalThis.__editorParams??{}; export const useIsFocused=()=>true;
    export const useFocusEffect=(callback)=>useEffect(callback,[callback]);
    export const router={back:()=>{},dismissTo:()=>{},push:()=>{}};`,
  "lucide-react-native": "export const Zap='Zap',ChevronLeft='ChevronLeft',ChevronRight='ChevronRight',Clock3='Clock3',Monitor='Monitor',Search='Search',Users='Users',X='X';",
  "react-native": "export const Pressable='Pressable',ScrollView='ScrollView',View='View'; export const BackHandler={addEventListener:()=>({remove:()=>{}})};",
  "react-native-keyboard-controller": "export const KeyboardAwareScrollView='KeyboardAwareScrollView',KeyboardAvoidingView='KeyboardAvoidingView';",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({bottom:0});",
  "@react-native-community/slider": "export default 'Slider';",
  "uniwind": "export const useCSSVariable=()=>['#141414','#dddddd'];",
  "@/components/agent-editor-controls.tsx": "export const EditorRow='EditorRow',SelectionRow='SelectionRow';",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/screen-bar.tsx": `import {createElement,Fragment} from ${react}; export const ScreenBar=({left,right})=>createElement(Fragment,null,left,right);`,
  "@/components/ui/alert-dialog.tsx": "export const AlertDialog=()=>null,AlertDialogCancel='AlertDialogCancel',AlertDialogContent='AlertDialogContent',AlertDialogDescription='AlertDialogDescription',AlertDialogFooter='AlertDialogFooter',AlertDialogHeader='AlertDialogHeader',AlertDialogTitle='AlertDialogTitle';",
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/input.tsx": "export const Input='Input';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/ui/switch.tsx": "export const Switch='Switch';",
  "@/components/ui/textarea.tsx": "export const Textarea='Textarea';",
  "@/components/wandrun-avatar.tsx": "export const AVATAR_COUNT=8,WandrunAvatar='WandrunAvatar';",
  "@/lib/agent-capabilities.ts": "export const useAgentCapabilities=()=>({capabilities:null,error:''});",
  "@/lib/connector-catalog.ts": "export const useConnectorCatalog=()=>({loaded:true,connectors:[],error:'',refresh:()=>{}});",
  "@/lib/connection-banner.tsx": "export const ConnectionBanner=()=>null;",
  "@/lib/i18n.ts": "export const t=(s)=>s; export const useTranslation=()=>({t});",
  "@/lib/model-catalog.ts": "export const useModelCatalog=()=>({catalog:globalThis.__editorCatalog??null,loading:false});",
  "@/lib/skill-catalog.ts": "export const useSkillCatalog=()=>({skills:[],error:'',refresh:()=>{}});",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__editorSession;",
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
    }).outputText };
    return nextLoad(url, context);
  },
});
const { default: AgentEditor } = await import("../src/app/agent-editor.tsx");

test("unknown create followed by explicit refusal keeps the original command and locked draft; initial refusal unlocks", async (t) => {
  const requests: Record<string, unknown>[] = [];
  let responses: number[] = [503, 400, 201];
  const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "dev" }, async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const status = responses.shift()!;
    return status === 201 ? Response.json({ agent: { id: "created" }, event: null }, { status })
      : Response.json({ error: { code: "rejected", message: "拒绝" } }, { status });
  });
  const session = {
    api: { getSettings: async () => ({ default_model: null, default_reasoning_effort: null }), listAgents: async () => ({ agents: [] }), createAgent: api.createAgent.bind(api) },
    agents: { deletedIds: new Set<string>(), refresh: () => {} }, connectorChanged: () => {}, blankConversation: async () => "conversation",
  };
  Object.assign(globalThis, { __editorSession: session });
  let root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => {
    const nodes = root.container.queryAll((node) => node.props.testID === id);
    assert.equal(nodes.length, 1, id);
    return nodes[0];
  };
  const fill = async () => {
    await act(async () => { byId("editor-name").props.onChangeText("初稿"); byId("editor-description").props.onChangeText("说明"); });
    await act(async () => byId("editor-prompt").props.onPress());
    await act(async () => byId("editor-prompt-input").props.onChangeText("提示词"));
    await act(async () => byId("editor-done").props.onPress());
  };
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(createElement(AgentEditor)));
  await fill();
  await act(async () => byId("editor-save").props.onPress());
  assert.equal(requests.length, 1);
  assert.equal(byId("editor-name").props.editable, false);
  await act(async () => byId("editor-save").props.onPress());
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(byId("editor-name").props.editable, false);
  assert.equal(byId("editor-name").props.value, "初稿");
  await act(async () => byId("editor-name").props.onChangeText("不应变更"));
  assert.equal(byId("editor-name").props.value, "初稿");
  await act(async () => byId("editor-save").props.onPress());
  assert.deepEqual(requests[2], requests[0]);

  // A first-request refusal has no uncertain predecessor: the user can revise and issue a new command.
  await act(async () => root.unmount());
  root = createRoot({ textComponentTypes: ["Text"] });
  requests.length = 0;
  responses = [400, 201];
  await act(async () => root.render(createElement(AgentEditor)));
  await fill();
  await act(async () => byId("editor-save").props.onPress());
  assert.equal(byId("editor-name").props.editable, true);
  await act(async () => byId("editor-name").props.onChangeText("修正稿"));
  assert.equal(byId("editor-name").props.value, "修正稿");
  await act(async () => byId("editor-save").props.onPress());
  assert.notEqual(requests[1].client_id, requests[0].client_id);
  assert.equal(requests[1].name, "修正稿");
});

test("Fast and reasoning stay independent drafts; creation sends Fast only after gateway capability and explicit save", async () => {
  for (const supported of [true, false, null]) {
    const requests: Record<string, unknown>[] = [];
    const model = { id: "model-a", display_name: "Model A", description: "", default_reasoning_effort: "medium",
      supported_reasoning_efforts: ["medium", "max"].map((effort) => ({ effort, description: "" })) };
    Object.assign(globalThis, { __editorParams: {}, __editorCatalog: supported === null ? null : {
      models: [model], fetched_at: 1, ...(supported ? { capabilities: { fast_mode: true } } : {}),
    } });
    const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "dev" }, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ agent: { id: "created" }, event: null }, { status: 201 });
    });
    Object.assign(globalThis, { __editorSession: {
      api: { getSettings: async () => ({ default_model: "model-a", default_reasoning_effort: "medium" }),
        listAgents: async () => ({ agents: [] }), createAgent: api.createAgent.bind(api) },
      agents: { deletedIds: new Set<string>(), refresh() {} }, connectorChanged() {}, blankConversation: async () => "conversation",
    } });
    const root = createRoot({ textComponentTypes: ["Text"] });
    const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
    try {
      await act(async () => root.render(createElement(AgentEditor)));
      const fast = byId("editor-fast-mode");
      assert.equal(fast.props.disabled, supported !== true);
      assert.equal(fast.props.accessibilityRole, "togglebutton");
      assert.deepEqual(fast.props.accessibilityState, { selected: false, checked: false, disabled: supported !== true });
      assert.equal(fast.props["aria-pressed"], false);
      const row = byId("editor-model").parent!;
      assert.ok(row.queryAll((node) => node.props.testID === "editor-fast-mode").length === 1);
      assert.equal(byId("editor-model").queryAll((node) => node.props.testID === "editor-fast-mode").length, 0);
      await act(async () => fast.props.onPress());
      assert.equal(byId("editor-fast-mode").props["aria-pressed"], supported === true);
      assert.equal(byId("editor-fast-mode").props.accessibilityState.checked, supported === true);
      if (supported !== null) {
        assert.equal(byId("editor-reasoning-slider").props.value, 0);
        await act(async () => byId("editor-reasoning-slider").props.onValueChange(1));
        assert.equal(byId("editor-reasoning-slider").props.value, 1);
      }
      assert.equal(byId("editor-fast-mode").props["aria-pressed"], supported === true);
      assert.equal(requests.length, 0);
      assert.equal(root.container.queryAll((node) => node.props.testID === "editor-fast-note").length, supported === true ? 1 : 0);
      assert.equal(root.container.queryAll((node) => node.props.testID === "editor-fast-unavailable").length, supported === true ? 0 : 1);
      await act(async () => { byId("editor-name").props.onChangeText("测试"); byId("editor-description").props.onChangeText("说明"); });
      await act(async () => byId("editor-prompt").props.onPress());
      await act(async () => byId("editor-prompt-input").props.onChangeText("提示词"));
      await act(async () => byId("editor-done").props.onPress());
      if (supported === true) {
        // Losing capability must not silently submit an enabled flag to a different/older gateway.
        Object.assign(globalThis, { __editorCatalog: { models: [model], fetched_at: 2 } });
        await act(async () => root.render(createElement(AgentEditor)));
        await act(async () => byId("editor-save").props.onPress());
        assert.equal(requests.length, 0);
        Object.assign(globalThis, { __editorCatalog: { models: [model], fetched_at: 3, capabilities: { fast_mode: true } } });
        await act(async () => root.render(createElement(AgentEditor)));
      }
      await act(async () => byId("editor-save").props.onPress());
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reasoning_effort, supported === null ? "medium" : "max");
      assert.equal("fast_mode" in requests[0], supported === true);
      if (supported) assert.equal(requests[0].fast_mode, true);
    } finally { await act(async () => root.unmount()); }
  }
});

test("saved Fast survives discard/reload; explicit off PATCH and old-gateway reasoning-only PATCH preserve the other control", async () => {
  for (const supported of [true, false]) {
    const requests: Record<string, unknown>[] = [];
    const detail = { id: "saved", name: "已保存", avatar: 0, description: "说明", system_prompt: "提示词", model: "model-a",
      reasoning_effort: "retired-effort", ...(supported ? { fast_mode: true } : {}), code_mode: true,
      workers: [], skills: [], mcp_servers: [], searchable_mcp_servers: [], environment: "local", member_of: [] };
    const model = { id: "model-a", default_reasoning_effort: "medium", supported_reasoning_efforts: ["medium", "max"].map((effort) => ({ effort, description: "" })) };
    Object.assign(globalThis, { __editorParams: { id: "saved" }, __editorCatalog: {
      models: [model], fetched_at: 1, ...(supported ? { capabilities: { fast_mode: true } } : {}),
    } });
    const api = new GatewayApi({ baseUrl: "https://gateway.test", token: "dev" }, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ agent: detail, event: null });
    });
    Object.assign(globalThis, { __editorSession: {
      api: { getAgent: async () => detail, listAgents: async () => ({ agents: [] }), updateAgent: api.updateAgent.bind(api) },
      agents: { deletedIds: new Set<string>(), refresh() {} }, connectorChanged() {},
    } });
    let root = createRoot({ textComponentTypes: ["Text"] });
    const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
    try {
      await act(async () => root.render(createElement(AgentEditor)));
      assert.equal(byId("editor-reasoning-slider").props.accessibilityValue.text, "retired-effort");
      if (supported) {
        await act(async () => byId("editor-fast-mode").props.onPress());
        assert.equal(byId("editor-fast-mode").props["aria-pressed"], false);
        assert.equal(requests.length, 0);
        await act(async () => root.unmount());
        root = createRoot({ textComponentTypes: ["Text"] });
        await act(async () => root.render(createElement(AgentEditor)));
        assert.equal(byId("editor-fast-mode").props["aria-pressed"], true);
        await act(async () => byId("editor-fast-mode").props.onPress());
      } else {
        await act(async () => byId("editor-reasoning-slider").props.onValueChange(1));
      }
      assert.equal(requests.length, 0);
      await act(async () => byId("editor-save").props.onPress());
      assert.deepEqual(requests, [supported ? { fast_mode: false } : { reasoning_effort: "max" }]);
    } finally { await act(async () => root.unmount()); }
  }
  Object.assign(globalThis, { __editorParams: {}, __editorCatalog: null });
});
