import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import type { TestInstance } from "test-renderer";
import ts from "typescript";
import Yoga from "yoga-layout";
import type { Node as YogaNode } from "yoga-layout";
import { applyLanguage } from "../src/lib/locale-store.ts";
import type { BrowserTask } from "../src/gateway/api.ts";
import type { ChatSession } from "../src/gateway/session.ts";

// Render the real editor and controls; replace native hosts and external catalogs.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const react = JSON.stringify(import.meta.resolve("react"));
const hosts: Record<string, string> = {
  "expo-router": `import {useEffect} from ${react}; export const Stack={Screen:'Screen'},Redirect='Redirect',router={back(){},push(){},dismissTo(){}}; export const useLocalSearchParams=()=>({id:'planner'}),useIsFocused=()=>true,useFocusEffect=cb=>useEffect(cb,[cb]);`,
  "react-native": "export const View='View',Pressable='Pressable',ScrollView='ScrollView',BackHandler={addEventListener:()=>({remove(){}})};",
  "react-native-keyboard-controller": "export const KeyboardAwareScrollView='ScrollView',KeyboardAvoidingView='View';",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({bottom:0});",
  "react-native-gesture-handler/ReanimatedSwipeable": `import {createElement} from ${react}; export default function Swipeable({children,renderRightActions}) {return createElement('Swipeable',null,children,renderRightActions());}`,
  "@/components/browser-task-close-dialog.tsx": "export const BrowserTaskCloseDialog='CloseDialog';",
  "@/components/browser-thumbnail.tsx": "export const BrowserThumbnail='Thumbnail';",
  "@/components/empty-state.tsx": "export const EmptyState='EmptyState';",
  "@/components/list-row.tsx": "export const ListRow='ListRow',RowSubtitle='RowSubtitle';",
  "lucide-react-native": "export const Check='Check',ChevronDown='ChevronDown',ChevronLeft='ChevronLeft',ChevronRight='ChevronRight',Clock3='Clock3',Monitor='Monitor',Search='Search',Users='Users',X='X';",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/screen-bar.tsx": `import {createElement} from ${react}; export const ScreenBar=({left,right})=>createElement('ScreenBar',null,left,right);`,
  "@/components/ui/alert-dialog.tsx": "export const AlertDialog='AlertDialog',AlertDialogCancel='Button',AlertDialogContent='View',AlertDialogDescription='Text',AlertDialogFooter='View',AlertDialogHeader='View',AlertDialogTitle='Text';",
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/ui/input.tsx": "export const Input='Input';",
  "@/components/ui/textarea.tsx": "export const Textarea='Input';",
  "@/components/ui/switch.tsx": "export const Switch='Switch';",
  "@/components/wandrun-avatar.tsx": "export const AVATAR_COUNT=8,WandrunAvatar='Avatar';",
  "@/components/model-picker.tsx": "export const ModelPicker='ModelPicker',ReasoningPicker='ReasoningPicker';",
  "@/lib/connection-banner.tsx": "export const ConnectionBanner=()=>null;",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__editorLayoutSession;",
  "@/lib/model-catalog.ts": "export const useModelCatalog=()=>({catalog:{models:[]}});",
  "@/lib/skill-catalog.ts": "const refresh=()=>{}; export const useSkillCatalog=()=>({skills:[],refresh});",
  "@/lib/agent-capabilities.ts": "export const useAgentCapabilities=()=>({capabilities:[]});",
  "@/lib/connector-catalog.ts": "const refresh=()=>{}; export const useConnectorCatalog=()=>({loaded:true,refresh,connectors:[{id:'docs',name:'Docs',description:'Documentation',tool_count:3,status:'connected',auth:{mode:'none'}}]});",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
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
// Native modules must load after the host resolution hooks.
const { default: AgentEditor } = await import("../src/app/agent-editor.tsx");
const { AgentComputerTab } = await import("../src/components/agent-computer-tab.tsx");

// Conservative text budgets, not Android font measurements. Only layout utilities
// used by these rows are modeled; include native flex shorthand, never drop it.
const widths: Record<string, number> = { Name: 38, Description: 82, 名字: 28, 说明: 28,
  "System capabilities": 146, 系统能力: 60, "Include directly": 108, "Search on demand": 132, 直接携带: 56, 按需搜索: 56 };
function layoutRow(host: TestInstance, available: number) {
  const nodes = new Map<TestInstance, YogaNode>();
  function build(cell: TestInstance): YogaNode {
    const node = Yoga.Node.create();
    nodes.set(cell, node);
    const classes: string[] = (cell.props.className ?? "").split(" ");
    if (classes.includes("flex-row") || cell.type === "Button") node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    if (classes.includes("flex-wrap")) node.setFlexWrap(Yoga.WRAP_WRAP);
    if (classes.includes("flex-1")) node.setFlex(1);
    if (classes.includes("grow")) node.setFlexGrow(1);
    if (classes.includes("shrink-0")) node.setFlexShrink(0);
    if (classes.includes("basis-auto")) node.setFlexBasis("auto");
    if (cell.type === "Button") { node.setPadding(Yoga.EDGE_HORIZONTAL, 14); node.setBorder(Yoga.EDGE_ALL, 1); }
    for (const token of classes) {
      const match = /^(w|min-w|px|gap)-(\d+)$/.exec(token);
      if (match) {
        const value = Number(match[2]) * 4;
        if (match[1] === "w") node.setWidth(value);
        if (match[1] === "min-w") node.setMinWidth(value);
        if (match[1] === "px") node.setPadding(Yoga.EDGE_HORIZONTAL, value);
        if (match[1] === "gap") node.setGap(Yoga.GUTTER_ALL, value);
      }
    }
    if (classes.includes("max-w-[45%]")) node.setMaxWidth("45%");
    if (cell.type === "Icon") { node.setWidth(18); node.setHeight(18); }
    else if (cell.type === "Text" || cell.type === "Input") {
      const text = String(cell.props.children ?? "");
      const width = cell.type === "Input" ? 80 : widths[text] ?? text.length * 8;
      node.setMeasureFunc(() => ({ width, height: 20 }));
    } else for (const child of cell.children) if (typeof child !== "string") node.insertChild(build(child), node.getChildCount());
    return node;
  }
  const root = build(host);
  root.setWidth(available);
  root.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
  return { nodes, close: () => root.freeRecursive() };
}

test("Agent form labels, capability values and connector choices fit at 360dp in both languages", async () => {
  const detail = { id: "planner", name: "Planner", avatar: 0, description: "Plan work", system_prompt: "Plan", model: "model", reasoning_effort: null,
    code_mode: true, skills: [], workers: [], mcp_servers: ["docs"], searchable_mcp_servers: [] };
  Object.assign(globalThis, { __editorLayoutSession: { agents: { deletedIds: new Set(), agents: [] },
    api: { getAgent: async () => detail, listAgents: async () => ({ agents: [] }) } } });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => root.container.queryAll(node => node.props.testID === id)[0];
  try {
    await act(async () => root.render(createElement(AgentEditor)));
    for (const language of ["en", "zh"] as const) {
      await act(async () => applyLanguage(language));
      for (const id of ["editor-name", "editor-description"]) {
        const input = byId(id);
        const row = input.parent!;
        const label = row.queryAll(node => node.type === "Text")[0];
        for (const screen of [360, 390, 430]) {
          const layout = layoutRow(row, screen - 34);
          try {
            const labelBox = layout.nodes.get(label)!.getComputedLayout();
            const inputBox = layout.nodes.get(input)!.getComputedLayout();
            assert.ok(labelBox.width >= widths[label.props.children], `${label.props.children}: label squeezed`);
            assert.ok(inputBox.width >= 150 && inputBox.left >= labelBox.left + labelBox.width, "input remains usable without overlap");
            if (language === "zh") assert.equal(labelBox.width, 44);
          } finally { layout.close(); }
        }
      }
      const capability = byId("editor-system-capabilities");
      const title = capability.queryAll(node => node.type === "Text")[0];
      const layout = layoutRow(capability, 326);
      try { assert.ok(layout.nodes.get(title)!.getComputedWidth() >= widths[title.props.children], "capability title squeezed by its value"); }
      finally { layout.close(); }
      await act(async () => byId("editor-connectors").props.onPress());
      const direct = byId("editor-connector-direct-docs");
      const search = byId("editor-connector-search-docs");
      for (const available of [294, 324, 364]) {
        const choices = layoutRow(direct.parent!, available);
        try {
          for (const button of [direct, search]) {
            const text = button.queryAll(node => node.type === "Text")[0];
            const box = choices.nodes.get(button)!.getComputedLayout();
            assert.ok(box.width >= widths[text.props.children] + 30, `${text.props.children}: button squeezed`);
            assert.ok(box.left + box.width <= available, "button escapes card");
          }
        } finally { choices.close(); }
      }
      await act(async () => search.props.onPress());
      assert.equal(byId("editor-connector-search-docs").props.accessibilityState.selected, true);
      await act(async () => byId("editor-back").props.onPress());
    }
  } finally { await act(async () => root.unmount()); applyLanguage("zh"); }
});

test("browser-page swipe actions fit their 88dp slot while retaining close-all semantics", async () => {
  const task: BrowserTask = {
    id: "browser", task_id: "task", root_id: "root", agent_id: "planner", entry_agent_id: "planner",
    conversation_title: "Research", entry_agent_name: "Planner", state: "agent", epoch: 1,
    pages: [{ id: "one", title: "First", url: "https://example.com" }, { id: "two", title: "Second", url: "https://example.com/two" }],
    current: "one", max_pages: 4, reason: null, requested_reason: null,
  };
  // Only the session fields consumed by this mounted tab are needed.
  const session = { agents: { agents: [], deletedIds: new Set() }, browserTasks: new Map([[task.id, task]]), refreshBrowserTasks: async () => {} } as unknown as ChatSession;
  const root = createRoot({ textComponentTypes: ["Text"] });
  try {
    await act(async () => {
      applyLanguage("en");
      root.render(createElement(AgentComputerTab, { id: "planner", session, viewport: { offset: 0, height: 640 } }));
    });
    await act(async () => root.container.queryAll(node => node.props.testID === "profile-computer-other-pages")[0].props.onPress());
    const actions = root.container.queryAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "Close all browser pages for this task");
    assert.equal(actions.length, 2);
    for (const action of actions) {
      const text = action.queryAll(node => node.type === "Text")[0];
      // 12dp conservative budget, including the space; no line clamp or ellipsis.
      assert.ok(String(text.props.children).length * 7 <= action.props.style.width, "visible action would wrap in its fixed swipe slot");
      assert.equal(text.props.numberOfLines, undefined);
      await act(async () => action.props.onPress());
      assert.equal(root.container.queryAll(node => node.type === "CloseDialog")[0].props.task.id, task.id);
    }
    await act(async () => applyLanguage("zh"));
    const chinese = root.container.queryAll(node => node.type === "Pressable" && node.props.accessibilityLabel === "关闭此任务的全部浏览器页面");
    assert.ok(chinese.every(action => action.queryAll(node => node.type === "Text")[0].props.children === action.props.accessibilityLabel));
  } finally { await act(async () => root.unmount()); applyLanguage("zh"); }
});
