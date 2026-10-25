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
import { applyLanguage } from "../src/lib/locale-store.ts";
import type { ModelInfo } from "../src/gateway/api.ts";

// Run the real profile and React state queue; substitute native hosts and tabs.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const hosts: Record<string, string> = {
  "expo-router": "export const Stack={Screen:'Screen'}, Redirect='Redirect', router={}; export const useLocalSearchParams=()=>({id:'planner'});",
  "react-native": `import {createElement, useImperativeHandle} from ${JSON.stringify(import.meta.resolve("react"))};
    export const View='View', Pressable='Pressable';
    export function ScrollView({ref,...props}) {
      useImperativeHandle(ref,()=>({scrollTo(){}}),[]);
      return createElement('ScrollView',props);
    }`,
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({top:0,bottom:0});",
  "@react-native-community/slider": "export default 'Slider';",
  "uniwind": "export const useCSSVariable=()=>['#141414','#dddddd'];",
  "lucide-react-native": "export const Zap='Zap',Brain='Brain', ChevronRight='ChevronRight', Clock='Clock', Monitor='Monitor', Pencil='Pencil', Users='Users', X='X', WifiOff='WifiOff';",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__profileLayoutSession;",
  "@/lib/use-open-agent-chat.ts": "export const useOpenAgentChat=()=>()=>{};",
  "@/components/agent-memory-tab.tsx": "export const AgentMemoryTab='AgentMemoryTab';",
  "@/components/agent-computer-tab.tsx": "export const AgentComputerTab='AgentComputerTab';",
  "@/components/agent-schedules-tab.tsx": "export const AgentSchedulesTab='AgentSchedulesTab';",
  "@/components/empty-state.tsx": "export const EmptyState='EmptyState';",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/list-load-error.tsx": "export const ListLoadError='ListLoadError';",
  "@/components/list-row.tsx": "export const ListRow='ListRow', RowSubtitle='RowSubtitle';",
  "@/components/screen-bar.tsx": `import {createElement} from ${JSON.stringify(import.meta.resolve("react"))};
    export const ScreenBar=({left,right})=>createElement('ScreenBar',null,left,right);`,
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/wandrun-avatar.tsx": "export const WandrunAvatar='WandrunAvatar';",
  "@/components/agent-editor-controls.tsx": "export const SelectionRow='SelectionRow';",
  "@/lib/model-catalog.ts": "export const useModelCatalog=()=>({});",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(
      readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: {
        module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
      } },
    ).outputText };
    return nextLoad(url, context);
  },
});
// Static import would load native modules before the host hooks are registered.
const { default: AgentProfile } = await import("../src/app/agents/[id].tsx");
const { ReasoningPicker } = await import("../src/components/model-picker.tsx");

async function fixture() {
  const session = {
    api: { getAgent: async () => ({ id: "planner", name: "Planner", avatar: 0, workers: [] }) },
    agents: { agents: [], loaded: true, deletedIds: new Set(), definitionVersion: 0 },
    conversations: new Map(), connection: "open",
  };
  Object.assign(globalThis, { __profileLayoutSession: session });
  const root = createRoot({ textComponentTypes: ["Text"] });
  await act(async () => root.render(createElement(AgentProfile)));
  await act(async () => {
    root.container.queryAll((node) => node.props.testID === "profile-tab-computer")[0].props.onPress();
  });
  return {
    root,
    session,
    scroll: () => root.container.queryAll((node) => node.type === "ScrollView")[0],
    viewport: () => root.container.queryAll((node) => node.type === "AgentComputerTab")[0].props.viewport,
    close: async () => { await act(async () => root.unmount()); },
  };
}

for (const field of ["height", "offset"] as const) {
  test(`profile retains ${field} after native events are recycled before queued updates run`, async () => {
    const f = await fixture();
    try {
      const dispatch = (field: "height" | "offset", value: number) => {
        const event = { nativeEvent: (field === "height" ? { layout: { height: value } } : { contentOffset: { y: value } }) as object | null };
        f.scroll().props[field === "height" ? "onLayout" : "onScroll"](event);
        event.nativeEvent = null;
      };
      // Preserve the other field. Multiple events in one batch force queued (not
      // just React's eager) updater execution after the event pool releases them.
      await act(async () => {
        f.scroll().props[field === "height" ? "onScroll" : "onLayout"]({
          nativeEvent: field === "height" ? { contentOffset: { y: 80 } } : { layout: { height: 80 } },
        });
      });
      await act(async () => { dispatch(field, 120); dispatch(field, 240); });
      assert.deepEqual(f.viewport(), field === "height" ? { offset: 80, height: 240 } : { offset: 240, height: 80 });
    } finally { await f.close(); }
  });
}

test("profile ignores non-computer scrolling and resets offset on tab changes without losing height", async () => {
  const f = await fixture();
  try {
    await act(async () => {
      f.scroll().props.onLayout({ nativeEvent: { layout: { height: 640 } } });
      f.scroll().props.onScroll({ nativeEvent: { contentOffset: { y: 200 } } });
    });
    const select = async (tab: string) => act(async () => {
      f.root.container.queryAll((node) => node.props.testID === `profile-tab-${tab}`)[0].props.onPress();
    });
    await select("schedules");
    await act(async () => f.scroll().props.onScroll({ nativeEvent: null }));
    await select("computer");
    assert.deepEqual(f.viewport(), { offset: 0, height: 640 });
  } finally { await f.close(); }
});

test("profile disables edits immediately but delays its offline status and banner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture();
  const edit = () => f.root.container.queryAll((node) => node.props.testID === "profile-edit")[0];
  const offlineStatus = () => f.root.container.queryAll((node) => node.type === "Text" && node.props.children === "状态暂不可用");
  try {
    assert.equal(edit().props.disabled, false);
    f.session.connection = "reconnecting";
    await act(async () => f.root.render(createElement(AgentProfile)));
    assert.equal(edit().props.disabled, true);
    assert.equal(offlineStatus().length, 0);
    await act(async () => t.mock.timers.tick(999));
    assert.equal(offlineStatus().length, 0);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(offlineStatus().length, 1);
    f.session.connection = "open";
    await act(async () => f.root.render(createElement(AgentProfile)));
    assert.equal(edit().props.disabled, false);
    assert.equal(offlineStatus().length, 0);
  } finally { await f.close(); }
});

// Conservative single-line 14dp text budgets, rather than character counts.
// Model the native layout utilities, including Uniwind's flex-1 => { flex: 1 }.
// This is not the Metro/Uniwind renderer: font metrics and full style resolution
// still need device verification. Never discard flex when merging longhands:
// native Yoga resolves positive flex + basis:auto to a zero basis.
const labelWidths: Record<string, number> = {
  Computer: 70, Schedules: 70, Members: 68, Memory: 56,
  Low: 28, Medium: 54, High: 32, "Very high": 64, Maximum: 70,
  电脑: 28, 定时: 28, 成员: 28, 记忆: 28, 低: 14, 中: 14, 高: 14, 极高: 28, 最高: 28,
};

function checkSingleLineLayout(cells: TestInstance[], width: number, tabs: boolean) {
  const layout = Yoga.Node.create();
  layout.setWidth(width);
  layout.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
  layout.setFlexWrap(tabs ? Yoga.WRAP_NO_WRAP : Yoga.WRAP_WRAP);
  const required: number[] = [];
  try {
    cells.forEach((cell, index) => {
      const text = cell.queryAll((node) => node.type === "Text")[0];
      const textWidth = labelWidths[text.props.children];
      assert.ok(textWidth > 0, `missing text budget: ${text.props.children}`);
      const icons = cell.queryAll((node) => node.type === "Icon").length;
      const classes = new Set<string>(cell.props.className.split(" "));
      const style = {
        ...(classes.has("flex-1") ? { flex: 1 } : {}),
        ...(classes.has("grow") ? { flexGrow: 1 } : {}),
        ...(classes.has("shrink-0") ? { flexShrink: 0 } : {}),
        ...(classes.has("basis-auto") ? { flexBasis: "auto" as const } : {}),
        paddingHorizontal: classes.has("px-2") ? 8 : classes.has("px-1") ? 4 : 0,
        ...cell.props.style,
      };
      const padding = style.paddingHorizontal;
      const border = classes.has("border") ? 2 : 0;
      required.push(textWidth + icons * 24 + padding * 2 + border);
      const node = Yoga.Node.create();
      if (style.flex !== undefined) node.setFlex(style.flex);
      if (style.flexGrow !== undefined) node.setFlexGrow(style.flexGrow);
      if (style.flexShrink !== undefined) node.setFlexShrink(style.flexShrink);
      if (style.flexBasis !== undefined) node.setFlexBasis(style.flexBasis);
      node.setMinWidth(tabs ? 0 : 52);
      node.setPadding(Yoga.EDGE_HORIZONTAL, padding);
      node.setBorder(Yoga.EDGE_ALL, border / 2);
      node.setHeight(38);
      const label = Yoga.Node.create();
      label.setMeasureFunc(() => ({ width: textWidth + icons * 24, height: 20 }));
      node.insertChild(label, 0);
      layout.insertChild(node, index);
    });
    layout.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
    const bounds = cells.map((_, index) => layout.getChild(index).getComputedLayout());
    bounds.forEach((box, index) => {
      assert.ok(box.width + 0.01 >= required[index], `label ${index} squeezed: ${box.width} < ${required[index]}`);
      assert.ok(box.left >= 0 && box.left + box.width <= width + 0.01, "cell escapes container");
      for (const previous of bounds.slice(0, index)) {
        assert.ok(box.top >= previous.top + previous.height || box.left >= previous.left + previous.width - 0.01, "cells overlap");
      }
    });
    if (tabs) assert.ok(bounds.every((box) => box.top === 0), "tabs must stay in one row");
    return bounds;
  } finally { layout.freeRecursive(); }
}

test("profile labels fit one row at 360dp in both languages through every selection", async () => {
  const f = await fixture();
  try {
    for (const language of ["en", "zh"] as const) {
      await act(async () => applyLanguage(language));
      for (const selected of ["computer", "schedules", "members", "memory"]) {
        await act(async () => f.root.container.queryAll((node) => node.props.testID === `profile-tab-${selected}`)[0].props.onPress());
        const cells = f.root.container.queryAll((node) => node.props.accessibilityRole === "tab");
        for (const screenWidth of [360, 390, 430]) {
          const bounds = checkSingleLineLayout(cells, screenWidth - 32 - 6, true);
          if (language === "zh") assert.ok(bounds.every((box) => Math.abs(box.width - bounds[0].width) <= 1));
        }
      }
    }
  } finally { await f.close(); applyLanguage("zh"); }
});

test("reasoning slider uses catalog ordinals and full labels without endpoint text or render-driven draft changes", async () => {
  const root = createRoot({ textComponentTypes: ["Text"] });
  let choices: string[] = [];
  const render = async (efforts: string[], effort: string | null, disabled = false, available = true) => {
    const model = { default_reasoning_effort: "high",
      supported_reasoning_efforts: efforts.map((effort) => ({ effort, description: "" })) } as ModelInfo;
    await act(async () => root.render(createElement(ReasoningPicker, {
      model: available ? model : undefined, effort, disabled, onChange: (value) => choices.push(value), testIDPrefix: "effort",
    })));
    return root.container.queryAll((node) => node.type === "Slider")[0];
  };
  try {
    for (const language of ["en", "zh"] as const) {
      await act(async () => applyLanguage(language));
      for (const efforts of [["medium", "max"], ["low", "medium", "high", "xhigh", "max"], ["minimal", "high", "max"]]) {
        choices = [];
        const slider = await render(efforts, "max");
        assert.equal(slider.props.maximumValue, efforts.length - 1);
        assert.equal(slider.props.step, 1);
        assert.equal(slider.props.value, efforts.length - 1);
        assert.equal(slider.props.accessibilityValue.text, language === "en" ? "Maximum" : "最高");
        assert.deepEqual(choices, []);
        await act(async () => slider.props.onValueChange(0));
        assert.deepEqual(choices, [efforts[0]]);
        assert.equal(root.container.queryAll((node) => node.props.accessibilityRole === "radio").length, 0);
      }
    }
    choices = [];
    const unknown = await render(["medium", "high"], "retired-effort");
    assert.equal(unknown.props.accessibilityValue.text, "retired-effort");
    assert.deepEqual(choices, []);
    const refreshed = await render(["low", "max"], "retired-effort");
    assert.deepEqual(choices, []);
    // A touch can explicitly choose the first stop even when the native thumb was already there.
    await act(async () => refreshed.props.onSlidingComplete(0));
    assert.deepEqual(choices, ["low"]);
    choices = [];
    const locked = await render(["medium", "high"], "medium", true);
    await act(async () => locked.props.onValueChange(1));
    assert.deepEqual(choices, []);
    assert.equal(locked.props.accessibilityState.disabled, true);
    const implicit = await render(["medium", "high", "max"], null);
    assert.equal(implicit.props.value, 1);
    assert.deepEqual(choices, []);
    await act(async () => implicit.props.onValueChange(0.5));
    await act(async () => implicit.props.onValueChange(99));
    assert.deepEqual(choices, []);
    assert.equal(await render([], "saved"), undefined);
    assert.equal(await render(["medium"], "saved"), undefined);
    assert.equal(await render(["medium", "high"], "saved", false, false), undefined);
    assert.deepEqual(choices, []);
  } finally { await act(async () => root.unmount()); applyLanguage("zh"); }
});
