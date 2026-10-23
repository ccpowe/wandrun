import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";
import * as React from "react";
import { act } from "react";
import { jsx } from "react/jsx-runtime";
import { createRoot, type Root, type TestInstance } from "test-renderer";
import Yoga, { type Node as YogaNode } from "yoga-layout";
import MarkdownIt from "markdown-it";
import ts from "typescript";

import type { BrowserTask, GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { buildItems } from "../src/lib/chat-timeline.ts";
import { collaborationEvents } from "./fixtures/collaboration-timeline.ts";

declare global {
  var __compactionRowReact: typeof React;
  var __compactionMarkdownIt: typeof MarkdownIt;
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.__compactionRowReact = React;
globalThis.__compactionMarkdownIt = MarkdownIt;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(globalThis, { __DEV__: false });

// This suite runs the real SessionProvider on its web branch, including persistence.
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  get length() { return stored.size; },
  key: (index: number) => [...stored.keys()][index] ?? null,
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
  clear: () => { stored.clear(); },
} satisfies Storage });
beforeEach(() => { stored.clear(); });
after(() => {
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

// Mount the real chat row and Markdown wrapper. Only native host components and
// platform packages unavailable to Node are substituted; event routing and message lookup remain real.
const platform: Record<string, string> = {
  "@/components/chat/drawer-horizontal-gesture.tsx": "export const DrawerHorizontalGesture=({children})=>children;",
  "react-native-drawer-layout": "export const DrawerGestureContext=globalThis.__compactionRowReact.createContext(undefined);",
  "react-native": `export const View='View', Text='Text', Pressable='Pressable', ScrollView='ScrollView', Image='Image', TextInput='TextInput', ActivityIndicator='ActivityIndicator';
    export const Animated={};
    export function FlatList({ref,...props}) {
      const React=globalThis.__compactionRowReact;
      React.useImperativeHandle(ref,()=>({scrollToIndex(){}}),[]);
      return React.createElement('FlatList',props);
    }
    export const Platform={OS:'web',select:({web})=>web};
    export const StyleSheet={create:(styles)=>styles,flatten:(style)=>style,absoluteFill:{}};
    export const Alert={alert:()=>{}}; export const Linking={openURL:async()=>{}};
    export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};
    export const BackHandler={addEventListener:()=>({remove(){}})};
    export const AccessibilityInfo={setAccessibilityFocus(){}},findNodeHandle=()=>null;
    export const Dimensions={get:()=>({width:390,height:800})};
    export const useWindowDimensions=()=>({width:390,height:800});`,
  "expo-router": `export const router={push(route){globalThis.__attachmentRoutes.push(route)}}; export const Stack={Screen:'StackScreen'}; export const useLocalSearchParams=()=>globalThis.__attachmentParams; export const useIsFocused=()=>true;`,
  "expo-secure-store": `export async function getItemAsync(){return null} export async function setItemAsync(){} export async function deleteItemAsync(){}`,
  "expo-network": `export const NetworkStateType={NONE:'NONE'}; export const addNetworkStateListener=()=>({remove(){}});`,
  "expo": `export const requireOptionalNativeModule=()=>null;`,
  "expo-file-system": `export class Directory {} export class File {} export const FileMode={ReadOnly:0}; export const Paths={document:'/mock-documents'};`,
  "expo-image": `export const Image=props=>globalThis.__compactionRowReact.createElement('ExpoImage',props);`,
  "expo-clipboard": `export const setStringAsync=async()=>true;`,
  "react-native-safe-area-context": `export const useSafeAreaInsets=()=>({top:0,right:0,bottom:0,left:0});`,
  "react-native-gesture-handler": `const gesture=()=>({onStart(){return this},onUpdate(){return this},onEnd(){return this},maxPointers(){return this},activeOffsetY(){return this},failOffsetX(){return this},enabled(){return this}}); export const Gesture={Pinch:gesture,Pan:gesture,Simultaneous:()=>({})}; export const GestureDetector='GestureDetector';`,
  "react-native-worklets": `export const scheduleOnRN=(fn,value)=>fn(value);`,
  "react-native-keyboard-controller": `export const useKeyboardState=(select)=>select({isVisible:false,height:0});`,
  "react-native-webview": `export default 'WebView';`,
  "react-native-svg": `export default 'Svg'; export const Circle='Circle', Line='Line', Rect='Rect';`,
  "@react-native-community/slider": `export default 'Slider';`,
  "@react-native-community/datetimepicker": `export default 'DateTimePicker'; export const DateTimePickerAndroid={open(){}};`,
  "react-native-gifted-charts": `export const BarChart='BarChart', LineChart='LineChart', PieChart='PieChart';`,
  "react-native-screens": `export const FullWindowOverlay='FullWindowOverlay';`,
  "react-native-reanimated": `const animation={duration(){return this},delay(){return this},reduceMotion(){return this}};
    export const FadeIn=animation,FadeOut=animation,FadeOutUp=animation,LinearTransition=animation;
    export const ReduceMotion={System:0},Extrapolation={CLAMP:0};
    export const Easing={linear:(value)=>value},cancelAnimation=()=>{};
    export const useSharedValue=(value)=>({value,get(){return this.value},set(next){this.value=next}}),useAnimatedReaction=()=>{},withRepeat=(value)=>value;
    export const LayoutAnimationConfig='LayoutAnimationConfig';
    export const useAnimatedStyle=(fn)=>fn(),useDerivedValue=(fn)=>({value:fn()});
    export const withTiming=(value)=>value,withSpring=(value)=>value,interpolate=()=>0;
    export default {View:'AnimatedView',createAnimatedComponent:(component)=>component};`,
  "uniwind": `export const withUniwind=(component)=>component;
    export const useCSSVariable=(names)=>names.map(()=> '#141414');
    export const useResolveClassNames=()=>({}),useUniwind=()=>({theme:'light'});`,
  "react-native-markdown-display": `export const MarkdownIt=globalThis.__compactionMarkdownIt; export const renderRules={};
    export default function Markdown({children,markdownit}) {
      const React=globalThis.__compactionRowReact;
      const sections=markdownit.parse(String(children),{}).filter((token)=>token.type==='inline');
      return React.createElement('Markdown',null,sections.map((token,index)=>
        React.createElement('Text',{key:index},token.content)));
    }`,
  "@json-render/react-native": `export const JSONUIProvider='JSONUIProvider',Renderer='Renderer';
    export const defineRegistry=(_catalog,registry)=>({registry}); export const useStateStore=()=>({});`,
  "@json-render/react-native/schema": `export const schema={createCatalog:(catalog)=>catalog};`,
};
const icons = ["Copy", "ExternalLink", "Brain", "ChevronRight", "CircleAlert", "Clock", "Hand", "RefreshCw", "Square",
  "Monitor", "Clapperboard", "File", "FileText", "Image", "CalendarDays", "Check", "X", "ChevronDown", "ChevronUp",
  "ArrowLeft", "ArrowUpRight", "Folder", "FolderOpen", "FolderTree", "FileCode2", "Minus", "Plus", "Code2", "Expand", "Play", "RotateCcw"];
const richIconNames: string[] = JSON.parse(readFileSync(new URL("../../src/wandrun/gateway/ui_icons.json", import.meta.url), "utf8"));
const iconExports = new Set([...icons, ...richIconNames.map(name => name.split("-").map(part => part[0].toUpperCase() + part.slice(1)).join(""))]);
platform["lucide-react-native"] = [...iconExports].map((name) => `export const ${name}='Icon${name}';`).join("\n");
const primitive = `export const Root='PrimitiveRoot', Trigger='PrimitiveTrigger', Content='PrimitiveContent',
  Indicator='PrimitiveIndicator', Item='PrimitiveItem', Thumb='PrimitiveThumb', Header='PrimitiveHeader',
  Title='PrimitiveTitle', Description='PrimitiveDescription', Portal='PrimitivePortal',
  Overlay='PrimitiveOverlay', Close='PrimitiveClose', Text='PrimitiveText', Image='PrimitiveImage',
  Fallback='PrimitiveFallback', List='PrimitiveList', RadioGroup='PrimitiveRadioGroup';
  export const Slot='Slot';`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/session-context.tsx" && context.parentURL?.endsWith("/app/media-viewer.tsx")) {
      return { url: "data:text/javascript,export const useSession=()=>globalThis.__attachmentSession", shortCircuit: true };
    }
    // Match Metro's Web resolution for both offline rich-content resource owners.
    if (specifier === "./math-page" || specifier === "./mermaid-page") return nextResolve(`${specifier}.web.ts`, context);
    // Preserve RNR Dialog/Portal/Slot/Hook behavior; only other unmounted primitives use host placeholders.
    if (specifier in platform || (specifier.startsWith("@rn-primitives/") &&
      !["@rn-primitives/dialog", "@rn-primitives/hooks", "@rn-primitives/portal", "@rn-primitives/slot"].includes(specifier))) {
      return { url: `data:text/javascript,${encodeURIComponent(platform[specifier] ?? primitive)}`, shortCircuit: true };
    }
    if (specifier === "./dialog" && context.parentURL?.endsWith("/@rn-primitives/dialog/dist/index.mjs")) {
      return { url: new URL("./dialog.mjs", context.parentURL).href, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const url = new URL(`../src/${specifier.slice(2)}`, import.meta.url);
      if (url.pathname.endsWith(".ts") || url.pathname.endsWith(".tsx")) return { url: url.href, shortCircuit: true };
      for (const extension of [".tsx", ".ts"]) {
        if (existsSync(fileURLToPath(url) + extension)) return { url: url.href + extension, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx") || (url.includes("/node_modules/@rn-primitives/") && url.endsWith(".mjs"))) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(
        readFileSync(fileURLToPath(url), "utf8").replace(/require\("(\.\.\/\.\.\/assets\/avatar-b\d\.png)"\)/g, '"$1"'),
        { fileName: "native-component.tsx", compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } },
      ).outputText };
    }
    return nextLoad(url, context);
  },
});

// Hooks must register before loading Native-compatible business components and the real RNR portal.
const attachmentRoutes: Array<{ pathname: string; params: Record<string, string> }> = [];
Object.assign(globalThis, { __attachmentRoutes: attachmentRoutes });
const { PortalHost } = await import("@rn-primitives/portal");
const { MessageRow } = await import("../src/components/chat/message-row.tsx");
const { SessionProvider } = await import("../src/lib/session-context.tsx");
const { ProgressRow } = await import("../src/components/chat/progress-row.tsx");
// The Node renderer's TSX/React Native resolution hooks must register before this component loads.
const { DraftMessageContent } = await import("../src/components/chat/draft-message-content.tsx");
const { default: MediaViewer } = await import("../src/app/media-viewer.tsx");
const session = {} as ChatSession; // These event branches never call the session.
const event = (seq: number, type: string, data: Record<string, unknown>): GatewayEvent =>
  ({ seq, type, conversation_id: "root", at: seq, data });

test("成员及深层任务附件点击按所在时间线定位完整图片组", async () => {
  const chat = new ChatSession({ baseUrl: "http://attachments", token: "test" }, async () => new Response("{}"));
  chat.agents.close();
  // Native thumbnail I/O is outside this navigation/lookup smoke path.
  chat.api.loadFileThumbnail = async (id) => ({ uri: `data:image/png,${id}`, dispose() {} });
  Object.assign(globalThis, { __attachmentSession: chat });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const pictures = ["one", "two"].map(id => ({ id, name: `${id}.png`, media_type: "image/png", size: 10 }));
  const cases = [
    { timelines: ["child"], entry: event(7, "message.agent", { agent: "worker", text: "", attachments: pictures, task_id: "child", timeline_ids: ["child"] }) },
    { timelines: ["grandchild", "child"], entry: event(8, "message.task", {
      task_id: "child", sender_task_id: "grandchild", recipient_task_id: "child",
      sender_agent_id: "worker", recipient_agent_id: "planner", text: "", attachments: pictures,
      timeline_ids: ["grandchild", "child"],
    }) },
  ];
  try {
    for (const { timelines, entry } of cases) {
      chat["apply"](entry);
      assert.equal(chat.timeline("root").events.some(candidate => candidate.seq === entry.seq), false);
      // Member-to-member delivery uses the recipient as primary, but each visible
      // timeline must open its own copy of the same message's attachment gallery.
      for (const timeline of timelines) {
        await act(async () => root.render(React.createElement(MessageRow, {
          item: { key: `e${entry.seq}`, event: entry }, session: chat, timelineId: timeline,
        })));
        const image = root.container.queryAll(node => node.props.testID === "attachment-image-two")[0];
        assert.ok(image, "real row renders its second attachment");
        await act(async () => image.queryAll(node =>
          node.type === "Pressable" && node.props.accessibilityLabel === "查看图片 two.png")[0].props.onPress());
        const route = attachmentRoutes.at(-1)!;
        assert.equal(route.pathname, "/media-viewer");
        assert.deepEqual(route.params, { id: timeline, seq: String(entry.seq), file_id: "two", index: "1" });
        Object.assign(globalThis, { __attachmentParams: route.params });
        await act(async () => root.render(React.createElement(MediaViewer)));
        const gallery = root.container.queryAll(node => node.type === "FlatList")[0];
        assert.deepEqual(gallery.props.data.map((file: { id: string }) => file.id), ["one", "two"]);
        assert.equal(gallery.props.initialScrollIndex, 1);
      }
    }
  } finally {
    await act(async () => root.unmount());
    await chat.close();
    attachmentRoutes.length = 0;
    Reflect.deleteProperty(globalThis, "__attachmentSession");
    Reflect.deleteProperty(globalThis, "__attachmentParams");
  }
});

function summary(seq: number, text: string): GatewayEvent {
  return event(seq, "context.compacted", {
    status: "completed", task_id: `child-${seq}`, agent_id: "helper", agent_name: "研究员",
    event_id: `summary-${seq}`, generation: seq, reason: "threshold", created_at: "2026-10-12T10:00:00Z",
    cutoff_index: seq, summary_text: text, archive_path: "/archive/index.md", keep_tokens: 100,
    retained_tokens: 108, retention_reason: "target", summary_model: "offline", summary_usage: null,
  });
}

function visibleText(root: Root): string {
  return root.container.queryAll((node) => node.type === "Markdown")
    .flatMap((markdown) => markdown.queryAll((node) => node.type === "Text")
      .map((node) => String(node.props.children))).join("\n");
}

function draftText(root: Root): string {
  return root.container.queryAll((node) => node.type === "Text" && typeof node.props.children === "string")
    .map((node) => node.props.children).join("");
}

test("压缩系统行点击展开当次完整摘要，关闭后旧事件不被新摘要覆盖；失败只显示原因", async () => {
  const root = createRoot({ textComponentTypes: ["Text", "DialogTitle", "Markdown"] });
  const older = summary(11, "## 目标\n旧摘要第一节\n\n## 关键标识\n旧摘要尾部精确信息 731");
  const newer = summary(12, "## 目标\n新摘要\n\n## 关键标识\n新摘要尾部 992");
  const failure = event(13, "context.compaction_failed", {
    status: "failed", task_id: "child-13", agent_id: "helper", agent_name: "研究员",
    created_at: "2026-10-12T10:01:00Z", error: "ArchiveError", message: "留档无法写入",
  });
  try {
    await act(async () => root.render(React.createElement("Timeline", null,
      ...[older, newer, failure].map((entry) => React.createElement(MessageRow, {
        key: entry.seq, item: { key: `e${entry.seq}`, event: entry }, session,
      })),
      React.createElement(PortalHost))));
    assert.equal(visibleText(root), "");
    assert.equal(root.container.queryAll((node) => node.props.testID === "context-compaction-failed-13").length, 1);
    assert.ok(root.container.queryAll((node) => node.type === "Text")
      .some((node) => String(node.props.children).includes(failure.data.message)));
    await act(async () => root.container.queryAll((node) => node.props.testID === "context-compacted-11")[0].props.onPress());
    const summaryDialog = root.container.queryAll((node) => node.props.testID === "context-summary-11")[0];
    assert.equal(summaryDialog.props.onStartShouldSetResponder(), true, "dialog content consumes taps instead of dismissing through the backdrop");
    const summaryBody = root.container.queryAll((node) => node.props.testID === "context-summary-body-11")[0];
    assert.equal(summaryBody.queryAll((node) => node.type === "View" && node.props.onStartShouldSetResponder?.() === true).length, 1,
      "scroll body claims taps while its ScrollView ancestor remains available for drags");
    assert.ok(visibleText(root).includes("旧摘要尾部精确信息 731"));
    assert.ok(!visibleText(root).includes("新摘要尾部 992"));
    await act(async () => root.container.queryAll((node) => node.props.testID === "context-summary-11")[0]
      .queryAll((node) => node.props.className?.includes("right-4"))[0].props.onPress());
    assert.equal(visibleText(root), "");
    await act(async () => root.container.queryAll((node) => node.props.testID === "context-compacted-12")[0].props.onPress());
    assert.ok(visibleText(root).includes("新摘要尾部 992"));
    assert.ok(!visibleText(root).includes("旧摘要尾部精确信息 731"));
    await act(async () => root.container.queryAll((node) => node.props.testID === "context-summary-12")[0]
      .queryAll((node) => node.props.className?.includes("right-4"))[0].props.onPress());
    await act(async () => root.container.queryAll((node) => node.props.testID === "context-compacted-11")[0].props.onPress());
    assert.ok(visibleText(root).includes("旧摘要尾部精确信息 731"));
    assert.ok(!visibleText(root).includes("新摘要尾部 992"));
    assert.equal(root.container.queryAll((node) => node.props.testID === "context-summary-13").length, 0);
  } finally {
    await act(async () => root.unmount());
  }
});


test("流式段落更新不重挂已完成块，挂起的增量不覆盖之后提交的正文", async () => {
  const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
  const blocked = new Promise<void>(() => {});
  function Gate({ suspend }: { suspend: boolean }) {
    if (suspend) throw blocked;
    return null;
  }
  const view = (text: string, suspend = false) => React.createElement(React.Suspense, {
    fallback: React.createElement("Fallback"),
  }, React.createElement(DraftMessageContent, { text }), React.createElement(Gate, { suspend }));
  try {
    await act(async () => root.render(view("已完成段落\n\n正在")));
    const first = root.container.queryAll((node) => node.type === "Text" && node.props.children === "已完成段落")[0];
    await act(async () => React.startTransition(() => {
      root.render(view("已完成段落\n\n正在丢弃的段落\n\n```wandrun-ui\n{\"secret\":1}", true));
    }));
    await act(async () => root.render(view("已完成段落\n\n正在接受的段落\n\n")));
    assert.equal(root.container.queryAll((node) => node.type === "Text" && node.props.children === "已完成段落")[0], first);
    assert.equal(draftText(root), "已完成段落\n\n正在接受的段落");
    assert.equal(root.container.queryAll((node) => node.type === "JSONUIProvider").length, 0);
  } finally {
    await act(async () => root.unmount());
  }
});

test("长草稿追加保留稳定正文节点，中断保留文字且不暴露 UI 源码", async () => {
  const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
  const stable = Array.from({ length: 200 }, (_, index) => `第 ${index} 段 **正文**\n\n`).join("");
  const view = (text: string, interrupted = false) =>
    React.createElement(DraftMessageContent, { text, interrupted });
  try {
    await act(async () => root.render(view(stable + "未完成 ![私人图片](https://example.org/secret.png)")));
    const first = root.container.queryAll((node) => node.type === "Text" && node.props.children === "第 0 段 ")[0];
    assert.ok(first);
    for (let index = 0; index < 20; index++) {
      await act(async () => root.render(view(stable + `未完成 ![私人图片](https://example.org/secret.png) ${index}`)));
      assert.equal(root.container.queryAll((node) => node.type === "Text" && node.props.children === "第 0 段 ")[0], first);
    }
    assert.match(draftText(root), /第 199 段 正文/);
    assert.match(draftText(root), /\[图片生成中\]/);
    await act(async () => root.render(view(stable + "新完成段落\n\n```mermaid\ngraph LR\n")));
    assert.match(draftText(root), /新完成段落/);
    assert.match(draftText(root), /流程图生成中/);
    await act(async () => root.render(view(stable + "新完成段落\n\n```mermaid\ngraph LR\n```", true)));
    assert.match(draftText(root), /第 0 段 正文/);
    assert.match(draftText(root), /新完成段落/);
    await act(async () => root.render(view(stable + "```wandrun-ui\n{\"secret\":1}", true)));
    assert.ok(root.container.queryAll((node) => node.type === "Text")
      .some((node) => String(node.props.children).includes("界面未完成")));
    assert.equal(root.container.queryAll((node) => node.type === "JSONUIProvider").length, 0);
    assert.ok(!root.container.queryAll((node) => node.type === "Text")
      .some((node) => String(node.props.children).includes("secret")));
  } finally {
    await act(async () => root.unmount());
  }
});

test("只有其他 Agent 的草稿和回复显示发送者，使用目录显示名；当前主／成员会话不重复身份", async () => {
  const chat = new ChatSession({ baseUrl: "http://sender-test", token: "test" });
  chat.agents.close();
  chat["reset"]([{ id: "root", agent_id: "parent-id", title: "Root", status: "idle", unread: false,
    read_seq: 0, last_agent_seq: 0, created_at: 1, updated_at: 1, last_text: null, source: "user", schedule_origin: null }], 1);
  chat["apply"](event(2, "task.created", { task_id: "child", creator_task_id: "root",
    creator_agent_id: "parent-id", agent_id: "member-id", title: "Child", status: "running",
    timeline_ids: ["root", "child"] }));
  chat.agents.agents = [["parent-id", "规划员"], ["member-id", "计算员"], ["unnamed-id", ""]].map(([id, name]) => ({
    id, name, avatar: 0, description: "", workers: [], home: true, latest_conversation: null, unread: false,
  }));
  const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
  try {
    for (const [timelineId, agent, expected] of [
      ["root", "parent-id", ""], ["child", "member-id", ""],
      ["root", "member-id", "计算员"], ["child", "parent-id", "规划员"],
      ["root", "unnamed-id", "Agent"], ["root", "absent-id", "Agent"],
    ]) {
      for (const phase of ["draft", "sent", "interrupted"]) {
        const item = phase === "draft"
          ? { key: "draft", draft: { draft_id: "draft", conversation_id: "root", task_id: timelineId,
            sender: timelineId, agent, text: "323", phase: null } }
          : { key: "message", event: event(3, "message.agent", { agent, text: "323", task_id: timelineId,
            status: phase === "interrupted" ? "interrupted" : "completed" }) };
        await act(async () => root.render(React.createElement(MessageRow, { item, session: chat, timelineId })));
        // Inspect all visible Text, not a new selector which the broken implementation lacks.
        const text = root.container.queryAll((node) => node.type === "Text").map((node) =>
          Array.isArray(node.props.children) ? node.props.children.join("") : String(node.props.children)).join("\n");
        assert.ok(!text.includes("Agent ·"), `${timelineId}/${agent}/${phase}: ${text}`);
        for (const name of ["规划员", "计算员", "parent-id", "member-id", "unnamed-id", "absent-id", "Agent"]) {
          assert.equal(text.includes(name), name === expected, `${timelineId}/${agent}/${phase}: ${text}`);
        }
      }
    }
    await act(async () => root.render(React.createElement(MessageRow, {
      item: { key: "incoming", event: event(4, "message.task", { sender_agent_id: "parent-id",
        recipient_agent_id: "member-id", sender_task_id: "root", recipient_task_id: "child", text: "Compute" }) },
      session: chat, timelineId: "child",
    })));
    assert.ok(root.container.queryAll((node) => node.type === "Text").some((node) => node.props.children === "规划员"));
    assert.equal(root.container.queryAll((node) => node.props.testID === "task-message-4").length, 1);
  } finally {
    await act(async () => root.unmount());
    await chat.close();
  }
});

test("协作历史的根列表没有正文占位，成员列表仍渲染上级来信与交还结果", async () => {
  const chat = new ChatSession({ baseUrl: "http://collaboration-row", token: "test" }, async () => new Response("{}"));
  chat.agents.close();
  for (const entry of collaborationEvents) chat["apply"](entry);
  const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
  try {
    for (const timelineId of ["root", "search-1"]) {
      const items = buildItems(chat.timeline(timelineId).events, [], undefined, [], undefined, timelineId, chat.tasks);
      await act(async () => root.render(React.createElement("Timeline", null,
        ...items.map((item) => React.createElement("Row", { key: item.key },
          React.createElement(MessageRow, { item, session: chat, timelineId }))))));
      const rows = root.container.queryAll((node) => node.type === "Row");
      assert.equal(rows.length, timelineId === "root" ? 2 : 7);
      for (const row of rows) {
        assert.ok(row.queryAll((node) => node.type === "Text").length > 0,
          "every list item must render visible content, not just reserve a separator");
      }
      const messages = root.container.queryAll((node) => String(node.props.testID).startsWith("task-message-"));
      if (timelineId === "root") {
        assert.deepEqual(messages, []);
      } else {
        assert.deepEqual(messages.map((node) => node.props.testID), [11, 32, 37, 38, 39, 67, 81].map((seq) => `task-message-${seq}`));
        assert.match(draftText(root), /Find the protocol details/);
        assert.match(draftText(root), /Search result 81/);
      }
    }
  } finally {
    await act(async () => root.unmount());
    await chat.close();
  }
});

test("委派视觉行与普通进度行等高，44dp 实体点击区不越父边界、不重叠", async () => {
  const chat = new ChatSession({ baseUrl: "http://progress-layout", token: "test" }, async () => new Response("{}"));
  chat.agents.close();
  const root = createRoot({ textComponentTypes: ["Text"] });
  const layout = Yoga.Node.create();
  const nodes = new Map<TestInstance, YogaNode>();
  // Native text measurement is fixed at the default 20dp line here; Yoga handles
  // the real mounted ancestors, padding and target rectangles (not hitSlop props).
  function build(host: TestInstance): YogaNode {
    const node = Yoga.Node.create();
    nodes.set(host, node);
    const style = Object.assign({}, ...[host.props.style].flat().filter(Boolean));
    if (style.minHeight !== undefined) node.setMinHeight(style.minHeight);
    if (style.paddingVertical !== undefined) node.setPadding(Yoga.EDGE_VERTICAL, style.paddingVertical);
    if (style.paddingTop !== undefined) node.setPadding(Yoga.EDGE_TOP, style.paddingTop);
    if (style.paddingHorizontal !== undefined) node.setPadding(Yoga.EDGE_HORIZONTAL, style.paddingHorizontal);
    if (style.flexDirection === "row") node.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
    if (style.alignItems === "center") node.setAlignItems(Yoga.ALIGN_CENTER);
    if (style.gap !== undefined) node.setGap(Yoga.GUTTER_ALL, style.gap);
    if (host.type === "Text") { node.setWidth(180); node.setHeight(20); }
    else for (const child of host.children) {
      if (typeof child !== "string") node.insertChild(build(child), node.getChildCount());
    }
    return node;
  }
  type Bounds = { top: number; bottom: number; height: number; width: number };
  function bounds(host: TestInstance): Bounds {
    const node = nodes.get(host)!;
    let top = node.getComputedTop();
    for (let parent = node.getParent(); parent; parent = parent.getParent()) top += parent.getComputedTop();
    return { top, bottom: top + node.getComputedHeight(), height: node.getComputedHeight(), width: node.getComputedWidth() };
  }
  try {
    for (const status of ["running", "waiting", "completed", "failed", "cancelled", "unavailable"] as const) {
      await act(async () => root.render(React.createElement("View", null,
        ...[1, 2, 3].map((id) => React.createElement("View", { key: id },
          React.createElement(MessageRow, { item: { key: String(id), delegation: { taskId: String(id), agentId: "search", status } }, session: chat }))),
        React.createElement("View", { style: { paddingTop: 12 } },
          jsx(ProgressRow, { testID: "ordinary", children: React.createElement("Text", null, "正在调用工具") })))));
      const tree = build(root.container.children[0] as TestInstance);
      layout.insertChild(tree, 0);
      layout.calculateLayout(390, undefined, Yoga.DIRECTION_LTR);
      const ordinary = bounds(root.container.queryAll(node => node.props.testID === "ordinary-content")[0]);
      let previousContent: Bounds | undefined;
      let previousTarget: Bounds | undefined;
      for (const id of [1, 2, 3]) {
        const pressable = root.container.queryAll(node => node.type === "Pressable" && node.props.testID === `delegation-${id}`)[0];
        const target = bounds(pressable);
        const parent = bounds(pressable.parent!);
        const content = bounds(pressable.queryAll(node => node.props.testID === `delegation-${id}-content`)[0]);
        assert.equal(content.height, ordinary.height);
        assert.equal(content.height, 20);
        assert.equal(target.height, 44);
        assert.ok(target.width >= 44);
        assert.ok(target.top >= parent.top && target.bottom <= parent.bottom, "target is not clipped by its list row");
        assert.equal(content.top - target.top, 12);
        assert.equal(target.bottom - content.bottom, 12);
        if (previousTarget) assert.equal(target.top, previousTarget.bottom, "actual hit rectangles touch but never overlap");
        if (previousContent) assert.equal(content.top - previousContent.bottom, 24);
        previousTarget = target;
        previousContent = content;
      }
      assert.equal(ordinary.top - previousContent!.bottom, 24, "footer has the same visual gap");
      layout.removeChild(tree);
      tree.freeRecursive();
      nodes.clear();
    }
  } finally {
    layout.freeRecursive();
    await act(async () => root.unmount());
    await chat.close();
  }
});

test("浏览器卡片不重复委派标题，独立或隔着消息仍在卡内说明持有 Agent；成员历史不增加根卡片", async () => {
  for (const scenario of ["adjacent", "separated", "direct"] as const) {
    const chat = new ChatSession({ baseUrl: "http://browser-row", token: "test" }, async () => new Response("{}"));
    chat.agents.close();
    const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
    const task: BrowserTask = {
      id: "lease", task_id: scenario === "direct" ? "root" : "child", root_id: "root",
      agent_id: scenario === "direct" ? "planner" : "browser_agent", entry_agent_id: "planner",
      agent_name: scenario === "direct" ? "规划员" : "官网核查员",
      conversation_title: "Research", entry_agent_name: "Planner", state: "released", epoch: 1,
      pages: [], current: null, max_pages: 8, reason: "Agent 关闭", requested_reason: null,
    };
    const events = [
      ...(scenario === "direct" ? [] : [event(1, "task.status", {
        task_id: "child", creator_task_id: "root", agent_id: task.agent_id, status: "completed",
        timeline_ids: ["root", "child"],
      })]),
      ...(scenario === "separated" ? [event(2, "message.user", { text: "继续核对官网" })] : []),
      event(3, "browser_task.updated", task),
    ];
    try {
      for (const entry of events) chat["apply"](entry);
      const items = buildItems(chat.timeline("root").events, [], chat.browserTasks, [], undefined, "root", chat.tasks);
      await act(async () => root.render(React.createElement(SessionProvider, null,
        React.createElement("Timeline", null,
          ...items.map((item) => React.createElement("Row", { key: item.key, rowKey: item.key },
            React.createElement(MessageRow, { item, session: chat, timelineId: "root" })))))));
      const cardRow = root.container.queryAll(node => node.props.rowKey === "blease")[0];
      const card = cardRow.queryAll(node => node.props.testID === "browser-card-lease")[0];
      const textNodes = cardRow.queryAll(node => node.type === "Text");
      assert.ok(textNodes.every(node => card.queryAll(candidate => candidate === node).length === 1),
        "all browser labels belong inside the card, not in a second progress/title row");
      const cardText = card.queryAll(node => node.type === "Text")
        .map(node => [node.props.children].flat().join("")).join("\n");
      assert.ok(cardText.includes(task.agent_name!), "a standalone card identifies the holder from its snapshot");
      assert.ok(cardText.includes("已结束"));
      assert.ok(cardText.includes("Agent 关闭"));
      assert.ok(!cardText.includes("委派"));
      assert.equal(root.container.queryAll(node => node.type === "Pressable" &&
        node.props.testID === "delegation-child").length, scenario === "direct" ? 0 : 1);
      if (scenario === "separated") {
        assert.deepEqual(items.map(item => item.key), ["tchild", "e2", "blease"]);
      }
      const memberItems = buildItems(chat.timeline("child").events, [], chat.browserTasks, [], undefined, "child", chat.tasks);
      assert.ok(memberItems.every(item => !item.browser), "browser events remain scoped to the root conversation");
    } finally {
      await act(async () => root.unmount());
      await chat.close();
    }
  }
});

test("浏览器状态切换保留卡内归属、待接管红点与卡片和观看按钮的租约入口", async (t) => {
  // Static import would load native Expo before the platform resolution hooks above.
  const { router } = await import("expo-router");
  const push = t.mock.method(router, "push", () => {});
  const root = createRoot({ textComponentTypes: ["Text"] });
  const chat = new ChatSession({ baseUrl: "http://browser-states", token: "test" }, async () => new Response("{}"));
  chat.agents.close();
  const task: BrowserTask = {
    id: "lease", task_id: "child", root_id: "root", agent_id: "browser_agent", entry_agent_id: "planner",
    agent_name: "官网核查员",
    conversation_title: "Research", entry_agent_name: "Planner", state: "agent", epoch: 1,
    pages: [{ id: "page", title: "Research", url: "https://example.org" }], current: "page", max_pages: 8,
    reason: null, requested_reason: null,
  };
  try {
    for (const state of ["agent", "requested", "human", "revoking", "stopping", "released"] as const) {
      await act(async () => root.render(React.createElement(SessionProvider, null,
        React.createElement(MessageRow, {
          item: { key: "blease", browser: { ...task, state } }, session: chat,
        }))));
      const card = root.container.queryAll(node => node.props.testID === "browser-card-lease")[0];
      const text = card.queryAll(node => node.type === "Text").map(node => [node.props.children].flat().join("")).join("\n");
      assert.ok(text.includes("官网核查员"), `holder stays identifiable in ${state}`);
      assert.ok(text.includes("https://example.org"));
      assert.equal(card.queryAll(node => node.props.className === "size-1.5 rounded-full bg-destructive").length,
        state === "requested" ? 1 : 0);
      assert.equal(card.queryAll(node => node.props.className === "size-1.5 rounded-full bg-white").length,
        state !== "requested" && state !== "released" ? 1 : 0);
      await act(async () => card.props.onPress());
      await act(async () => card.queryAll(node => node.props.testID === "browser-watch-lease")[0].props.onPress());
      assert.deepEqual(push.mock.calls.slice(-2).map(call => call.arguments),
        [[{ pathname: "/browser-viewer", params: { id: "lease" } }], [{ pathname: "/browser-viewer", params: { id: "lease" } }]]);
    }
  } finally {
    await act(async () => root.unmount());
    await chat.close();
  }
});

test("历史卡片和消息优先目录名、再取快照；加载失败与删除无快照时显示不同占位，始终不露 ID", async () => {
  const chat = new ChatSession({ baseUrl: "http://historical-agent-name", token: "test" }, async () => new Response("{}"));
  chat.agents.close();
  const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
  const holder = { id: "a_8f4e0034aa684ee0bb067dc29cfba782", name: "当前核查员", avatar: 0, description: "", workers: [],
    home: true, latest_conversation: null, unread: false };
  const entry = { ...holder, id: "a_72ac0034aa684ee0bb067dc29cfba782", name: "规划员" };
  const task: BrowserTask = {
    id: "lease", task_id: "child", root_id: "root", agent_id: holder.id, entry_agent_id: entry.id,
    conversation_title: "Research", entry_agent_name: entry.name, state: "released", epoch: 1,
    pages: [], current: null, max_pages: 8, reason: "Agent 关闭", requested_reason: null,
  };
  try {
    for (const state of ["loading", "failed", "named", "unnamed", "deleted", "absent"] as const) {
      chat.agents.agents = state === "named" || state === "unnamed"
        ? [entry, { ...holder, name: state === "named" ? holder.name : "" }] : [entry];
      chat.agents.loaded = state !== "loading" && state !== "failed";
      chat.agents.error = state === "failed" ? "目录加载失败" : null;
      chat.agents.deletedIds.clear();
      if (state === "deleted") chat.agents.deletedIds.add(holder.id);
      for (const snapshot of ["历史核查员", undefined, holder.id]) {
        const expected = state === "named" ? holder.name : snapshot === "历史核查员" ? snapshot
          : state === "deleted" || state === "absent" ? "已删除的 Agent" : "Agent";
        const events = [
          event(1, "browser_task.updated", { ...task, agent_name: snapshot }),
          event(2, "message.agent", { task_id: "root", agent: holder.id, agent_name: snapshot, text: "核查正文" }),
          event(3, "message.task_preview", { task_id: "child", agent_id: holder.id, agent_name: snapshot, text: "成员预览", message_seq: 2 }),
          event(4, "task.status", { task_id: "child", creator_task_id: "root", agent_id: holder.id, agent_name: snapshot, status: "completed" }),
          { ...summary(5, "历史摘要"), data: { ...summary(5, "历史摘要").data, agent_id: holder.id, agent_name: snapshot } },
        ];
        const items = buildItems(events, [], undefined, [], undefined, "root");
        await act(async () => root.render(React.createElement(SessionProvider, null,
          React.createElement("Timeline", null, ...items.map(item =>
            React.createElement("Row", { key: item.key }, React.createElement(MessageRow, { item, session: chat, timelineId: "root" })))))));
        for (const row of root.container.queryAll(node => node.type === "Row")) {
          const text = row.queryAll(node => node.type === "Text").map(node => [node.props.children].flat().join("")).join("\n");
          assert.ok(text.includes(expected), `${state}/${snapshot}: ${text}`);
          assert.ok(!text.includes(holder.id) && !text.includes(entry.id), "identity is not a display-name fallback");
          assert.ok(!text.includes(entry.name), "entry Agent is not the holder or sender");
          if (expected !== "历史核查员") assert.ok(!text.includes("历史核查员"), "current directory names override snapshots");
          for (const node of row.queryAll(node => typeof node.props.accessibilityLabel === "string")) {
            assert.ok(!node.props.accessibilityLabel.includes(holder.id), "accessibility labels must not leak IDs either");
          }
        }
      }
    }
  } finally {
    await act(async () => root.unmount());
    await chat.close();
  }
});

test("成员来信、交还和插话回执的对端名字缺失时不暴露身份 ID", async () => {
  const chat = new ChatSession({ baseUrl: "http://collaboration-names", token: "test" }, async () => new Response("{}"));
  chat.agents.close();
  const creator = "a_11111111111111111111111111111111";
  const member = "a_22222222222222222222222222222222";
  chat["apply"](event(1, "task.created", { task_id: "child", creator_task_id: "root",
    creator_agent_id: creator, agent_id: member, title: "核查", status: "completed", timeline_ids: ["root", "child"] }));
  const events = [
    event(2, "message.task", { sender_task_id: "root", recipient_task_id: "child", sender_agent_id: creator, recipient_agent_id: member, text: "请核查" }),
    event(3, "message.task", { sender_task_id: "child", recipient_task_id: "root", sender_agent_id: member, recipient_agent_id: creator, text: "核查完成" }),
    event(4, "message.user", { task_id: "child", text: "补充要求" }),
  ];
  const root = createRoot({ textComponentTypes: ["Text", "Markdown"] });
  try {
    for (const loaded of [false, true]) {
      chat.agents.loaded = loaded;
      for (const entry of events) {
        await act(async () => root.render(React.createElement(MessageRow, {
          item: { key: `e${entry.seq}`, event: entry }, session: chat, timelineId: "child",
        })));
        const text = root.container.queryAll(node => node.type === "Text")
          .map(node => [node.props.children].flat().join("")).join("\n");
        assert.ok(text.includes(loaded ? "已删除的 Agent" : "Agent"));
        assert.ok(!text.includes(creator) && !text.includes(member));
      }
    }
  } finally {
    await act(async () => root.unmount());
    await chat.close();
  }
});
