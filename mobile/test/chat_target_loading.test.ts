import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";
import type { GatewayEvent } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";
import { collaborationEvents } from "./fixtures/collaboration-timeline.ts";

// Real Chat, MessageRow, AgentMessageContent, useUiDraft, session and timeline.
// Native hosts, rich visual rendering and unrelated resources are substituted; no native scroll claims.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const react = JSON.stringify(import.meta.resolve("react"));
const hosts: Record<string, string> = {
  "expo-router": `export const Stack={Screen:'Screen'}, router={dismissTo:(path)=>globalThis.__targetRoutes.push(path),setParams:()=>{}};
    export const useIsFocused=()=>true, useLocalSearchParams=()=>globalThis.__targetParams;`,
  "react-native": "export const View='View', Pressable='Pressable', ScrollView='ScrollView', useWindowDimensions=()=>({width:400,height:800}), Alert={alert:(...args)=>globalThis.__targetAlerts.push(args)};",
  "react-native-keyboard-controller": "export const KeyboardStickyView='KeyboardStickyView';",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({top:0,bottom:0});",
  "lucide-react-native": "export const ArrowDown='ArrowDown', WifiOff='WifiOff', Brain='Brain', Check='Check', ChevronRight='ChevronRight', CircleAlert='CircleAlert', Clock='Clock', Hand='Hand', RefreshCw='RefreshCw', Square='Square';",
  "@legendapp/list/keyboard": `import {createElement, useRef, useImperativeHandle, useLayoutEffect} from ${react};
    export const useKeyboardChatComposerInset=()=>({contentInsetEndAdjustment:70,onComposerLayout:()=>{}});
    export function KeyboardAwareLegendList(props) {
      const initial = useRef(props.initialScrollIndex);
      const listeners = useRef(new Set());
      const state = useRef({isAtEnd:globalThis.__targetInitiallyAtEnd ?? false, listen:(_key,notify)=>{
        listeners.current.add(notify); return ()=>listeners.current.delete(notify);
      }});
      useImperativeHandle(props.ref, ()=>({getState:()=>state.current,scrollToEnd:()=>{}}), []);
      useLayoutEffect(()=>{
        globalThis.__targetSignals.push({setAtEnd(value){
          state.current.isAtEnd=value; for(const notify of listeners.current) notify();
        }});
        props.onReady();
      }, []);
      return createElement('Timeline', {...props, initialPlacement:initial.current, ref:undefined});
    }`,
  "@/lib/session-context.tsx": `import {useSyncExternalStore} from ${react};
    export function useSession(){const s=globalThis.__targetSession; useSyncExternalStore(s.subscribe,s.getVersion,s.getVersion); return s;}`,
  "@/lib/upload-drafts.ts": `export const acquireUploadDraft=(_api,_id,ready)=>{
    ready({draft:{text:''},items:[],ready:true,consume:()=>({text:'Continue',files:[]})});
    return {release:()=>{}};
  };`,
  "@/lib/pick-upload.ts": "export const pickUploads=()=>[];",
  "@/lib/use-conversation-drawer.ts": "export const useConversationDrawer=()=>({drawerProps:{}});",
  "@/components/chat/chat-header.tsx": "export const ChatHeader='ChatHeader';",
  "@/components/chat/conversation-drawer.tsx": "export const ConversationDrawer='ConversationDrawer';",
  "@/components/chat/composer.tsx": "export const Composer='Composer';",
  "@/components/chat/browser-card.tsx": "export const BrowserCard='BrowserCard';",
  "@/components/chat/draft-message-content.tsx": "export const DraftMessageContent='DraftMessageContent';",
  "@/components/agent-memory-markdown.tsx": "export const AgentMemoryMarkdown='AgentMemoryMarkdown';",
  "@/components/ui/dialog.tsx": "export const Dialog='Dialog', DialogContent='DialogContent', DialogTitle='DialogTitle', DialogTrigger='DialogTrigger';",
  "@/components/file-type-icon.tsx": "export const FileTypeIcon='FileTypeIcon';",
  "@/components/wandrun-avatar.tsx": "export const WandrunAvatar='WandrunAvatar';",
  "@/components/rich-message/block.tsx": `import {createElement, useMemo} from ${react};
    import {parseRichSpec} from '@/components/rich-message/spec.ts';
    import {useUiDraft} from '@/components/rich-message/use-ui-draft.ts';
    export function RichBlock(props) {
      const spec=useMemo(()=>parseRichSpec(props.source),[props.source]);
      const form=useUiDraft(spec,props.submission,props.draft,props.onSubmit);
      return createElement('Form',form);
    }`,
  "@/components/chat/message-actions.tsx": "export const MessageActions='MessageActions';",
  "@/components/chat/typing-dots.tsx": "export const TypingDots='TypingDots';",
  "./typing-dots.tsx": "export const TypingDots='TypingDots';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
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
const { default: Chat } = await import("../src/app/c/[id].tsx");
const message = (seq: number): GatewayEvent => ({ seq, type: "message.user", conversation_id: "c", at: seq, data: { text: `Message ${seq}` } });
const page = (first: number) => Array.from({ length: 50 }, (_, index) => message(first + index));

function fixture(preloaded: boolean, messageSeq: string | null = "42", initiallyAtEnd = false) {
  const requests: { before: string | null; resolve: (response: Response) => void }[] = [];
  const submissions: { body: Record<string, unknown>; resolve: (response: Response) => void }[] = [];
  const stops: { path: string; clientId: string; resolve: (response: Response) => void }[] = [];
  const alerts: unknown[][] = [];
  const signals: { setAtEnd(value: boolean): void }[] = [];
  const routes: string[] = [];
  const session = new ChatSession({ baseUrl: "http://target-test", token: "dev" }, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/events")) return new Promise<Response>((resolve) => requests.push({ before: url.searchParams.get("before"), resolve }));
    if (url.pathname.endsWith("/ui-submissions")) return new Promise<Response>((resolve) =>
      submissions.push({ body: JSON.parse(String(init?.body)), resolve }));
    if (url.pathname.endsWith("/stop")) return new Promise<Response>((resolve) => stops.push({
      path: url.pathname, clientId: JSON.parse(String(init?.body)).client_id, resolve,
    }));
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  session.agents.close();
  session["reset"]([{
    id: "c", agent_id: "agent", title: "Chat", created_at: 1, updated_at: 200,
    status: "idle", read_seq: 200, unread: false, last_text: "Latest", source: "user", schedule_origin: null,
  }], 200);
  session.connection = "open";
  if (preloaded) Object.assign(session.timeline("c"), { events: page(100), oldest: 100, loaded: true });
  Object.assign(globalThis, { __targetInitiallyAtEnd: initiallyAtEnd,
    __targetSession: session, __targetAlerts: alerts, __targetSignals: signals, __targetRoutes: routes,
    __targetParams: { id: "c", message_seq: messageSeq ?? undefined } });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const lists = () => root.container.queryAll((node) => node.type === "Timeline");
  const retry = () => root.container.queryAll((node) => node.props.accessibilityLabel === "重试加载目标消息");
  const respond = async (index: number, events: GatewayEvent[] | null) => act(async () => {
    requests[index].resolve(new Response(JSON.stringify(events ? { events, as_of_seq: 200 } : { error: { message: "history unavailable" } }), {
      status: events ? 200 : 503, headers: { "content-type": "application/json" },
    }));
  });
  return { session, root, requests, submissions, stops, alerts, signals, routes, lists, retry, respond,
    async mount() {
      await act(async () => root.render(createElement(Chat)));
      await act(async () => root.container.queryAll((node) => typeof node.props.onLayout === "function")[0].props.onLayout({ nativeEvent: { layout: { height: 70 } } }));
    },
    async close() { await act(async () => root.unmount()); await session.close(); },
  };
}

test("ordinary first-page failure stays actionable while connected and recovers without losing messages", async () => {
  const f = fixture(false, null);
  const byId = (id: string) => f.root.container.queryAll((node) => node.props.testID === id);
  try {
    await f.mount();
    await f.respond(0, null);
    assert.equal(f.session.connection, "open");
    assert.equal(byId("chat-history-error").length, 1);
    assert.equal(byId("chat-history-retry").length, 1);
    assert.equal(f.lists()[0].props.data.length, 0);
    await act(async () => byId("chat-history-retry")[0].props.onPress());
    assert.equal(byId("chat-history-error").length, 0);
    await f.respond(1, [message(42)]);
    assert.equal(f.session.timeline("c").historyError, undefined);
    assert.deepEqual(f.requests.map((request) => request.before), [null, null]);
    assert.deepEqual(f.lists()[0].props.data.map((item: { key: string }) => item.key), ["e42"]);
  } finally { await f.close(); }
});

test("ordinary older-page failure preserves existing rows and retries the same cursor", async () => {
  const f = fixture(true, null);
  const byId = (id: string) => f.root.container.queryAll((node) => node.props.testID === id);
  try {
    await f.mount();
    await act(async () => { void f.session.loadOlder("c"); });
    await f.respond(0, null);
    assert.equal(byId("chat-history-error").length, 1);
    assert.deepEqual(f.lists()[0].props.data.map((item: { key: string }) => item.key), page(100).map((event) => `e${event.seq}`));
    await act(async () => byId("chat-history-retry")[0].props.onPress());
    await f.respond(1, page(50));
    assert.equal(byId("chat-history-error").length, 0);
    assert.deepEqual(f.requests.map((request) => request.before), ["100", "100"]);
    assert.deepEqual(f.lists()[0].props.data.map((item: { key: string }) => item.key),
      [...page(50), ...page(100)].map((event) => `e${event.seq}`));
  } finally { await f.close(); }
});

test("stop failure remains visible while connected, belongs only to its conversation, and clears on retry", async () => {
  const f = fixture(true, null);
  const byId = (id: string) => f.root.container.queryAll((node) => node.props.testID === id);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => f.stops[0].resolve(new Response(JSON.stringify({ error: { message: "stop unavailable" } }), {
      status: 503, headers: { "content-type": "application/json" },
    })));
    assert.equal(f.session.connection, "open");
    assert.equal(byId("chat-stop-error").length, 1);
    assert.equal(byId("chat-stop-retry").length, 1);
    assert.deepEqual(f.lists()[0].props.data.map((item: { key: string }) => item.key), page(100).map((event) => `e${event.seq}`));
    f.session.conversations.set("other", { ...f.session.conversations.get("c")!, id: "other" });
    f.session.timeline("other").loaded = true;
    Object.assign(globalThis, { __targetParams: { id: "other" } });
    await act(async () => f.root.render(createElement(Chat)));
    assert.equal(byId("chat-stop-error").length, 0, "another conversation must not display a global notice");
    Object.assign(globalThis, { __targetParams: { id: "c" } });
    await act(async () => f.root.render(createElement(Chat)));
    await act(async () => f.root.container.queryAll((node) => typeof node.props.onLayout === "function")[0].props.onLayout({ nativeEvent: { layout: { height: 70 } } }));
    assert.equal(byId("chat-stop-error").length, 1);
    await act(async () => byId("chat-stop-retry")[0].props.onPress());
    assert.equal(byId("chat-stop-error").length, 0);
    await act(async () => f.stops[1].resolve(new Response(JSON.stringify({
      event: { seq: 201, type: "turn.stopped", conversation_id: "c", at: 201, data: { was_working: true } },
    }), { headers: { "content-type": "application/json" } })));
    assert.equal(byId("chat-stop-error").length, 0);
    assert.equal(f.session.stopping.has("c"), false);
    assert.equal(f.lists()[0].props.data.some((item: { key: string }) => item.key === "e100"), true);
  } finally { await f.close(); }
});

test("authoritative idle status clears an unconfirmed stop without another command", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => f.stops[0].resolve(new Response(JSON.stringify({ error: { message: "stop unavailable" } }), {
      status: 503, headers: { "content-type": "application/json" },
    })));
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 1);
    await act(async () => f.session["apply"]({
      seq: 202, type: "conversation.status", conversation_id: "c", at: 202, data: { status: "idle" },
    }));
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 0);
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.session["stopRequests"].has("c"), false, "the terminal event releases unresolved receipt identity");
    assert.equal(f.stops.length, 1);
    assert.equal(f.lists()[0].props.data.some((item: { key: string }) => item.key === "e100"), true);
  } finally { await f.close(); }
});

const stopFailure = () => new Response(JSON.stringify({ error: { message: "stop unavailable" } }), {
  status: 503, headers: { "content-type": "application/json" },
});

test("idle arriving before a failed stop response prevents a stale stop error", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => f.session["apply"]({
      seq: 201, type: "conversation.status", conversation_id: "c", at: 201, data: { status: "idle" },
    }));
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 0);
  } finally { await f.close(); }
});

test("the matching turn.stopped confirms a stop even without an idle event", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => f.session["apply"]({
      seq: 201, type: "turn.stopped", conversation_id: "c", client_id: f.stops[0].clientId,
      at: 201, data: { was_working: true },
    }));
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 0);
  } finally { await f.close(); }
});

test("deletion before a failed stop response cannot restore its error", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => f.session["apply"]({
      seq: 201, type: "conversation.deleted", conversation_id: "c", at: 201, data: { id: "c" },
    }));
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session.isDeleted("c"), true);
    assert.equal(f.session.stopErrors.has("c"), false);
  } finally { await f.close(); }
});

test("a new working turn cannot undo confirmation of the earlier stop", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => {
      f.session["apply"]({ seq: 201, type: "conversation.status", conversation_id: "c", at: 201, data: { status: "idle" } });
      f.session["apply"]({ seq: 202, type: "conversation.status", conversation_id: "c", at: 202, data: { status: "working" } });
    });
    assert.equal(f.session.conversations.get("c")!.status, "working");
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 0);
  } finally { await f.close(); }
});

test("unrelated stop receipts do not confirm an unacknowledged request", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => {
      f.session["apply"]({ seq: 201, type: "turn.stopped", conversation_id: "c",
        client_id: "another-command", at: 201, data: { was_working: true } });
      f.session["apply"]({ seq: 202, type: "turn.stopped", conversation_id: "other",
        client_id: f.stops[0].clientId, at: 202, data: { was_working: true } });
    });
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session.stopErrors.get("c"), "stop unavailable");
    await act(async () => f.session["apply"]({ seq: 203, type: "turn.stopped", conversation_id: "c",
      client_id: "another-command", at: 203, data: { was_working: true } }));
    assert.equal(f.session.stopErrors.get("c"), "stop unavailable", "an unrelated later receipt cannot clear this failure");
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 1);
  } finally { await f.close(); }
});

test("a matching stop receipt after HTTP failure clears only its own error without idle", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    const clientId = f.stops[0].clientId;
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session.stopErrors.get("c"), "stop unavailable");
    await act(async () => f.session["apply"]({
      seq: 201, type: "turn.stopped", conversation_id: "c",
      client_id: "unrelated-command", at: 201, data: { was_working: true },
    }));
    assert.equal(f.session.stopErrors.get("c"), "stop unavailable");
    await act(async () => f.session["apply"]({
      seq: 202, type: "turn.stopped", conversation_id: "c",
      client_id: clientId, at: 202, data: { was_working: true },
    }));
    assert.equal(f.session.conversations.get("c")!.status, "working", "a stop receipt need not include idle yet");
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.session["stopRequests"].has("c"), false);
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-stop-error").length, 0);
  } finally { await f.close(); }
});

test("deletion after an unresolved stop error removes its receipt identity", async () => {
  const f = fixture(true, null);
  try {
    f.session.conversations.get("c")!.status = "working";
    await f.mount();
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onStop());
    await act(async () => f.stops[0].resolve(stopFailure()));
    assert.equal(f.session["stopRequests"].has("c"), true);
    await act(async () => f.session["apply"]({
      seq: 201, type: "conversation.deleted", conversation_id: "c", at: 201, data: { id: "c" },
    }));
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.session["stopRequests"].has("c"), false);
  } finally { await f.close(); }
});

test("resync discards an unresolved failed stop identity from the replaced event store", async () => {
  const f = fixture(true, null);
  let resync: Promise<void> | undefined;
  try {
    f.session.conversations.get("c")!.status = "working";
    const stopping = f.session.stop("c");
    f.stops[0].resolve(stopFailure());
    await stopping;
    assert.equal(f.session["stopRequests"].has("c"), true);
    resync = f.session["resync"]();
    assert.equal(f.session.stopErrors.has("c"), false);
    assert.equal(f.session["stopRequests"].has("c"), false);
  } finally {
    await f.close();
    await resync;
  }
});

test("chat offline hint waits one second without delaying the session's real connection state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(true, null);
  const hints = () => f.root.container.queryAll((node) => node.type === "Text" && node.props.children === "连接断开，正在重连…");
  const change = async (state: ChatSession["connection"]) => act(async () => {
    f.session.connection = state;
    f.session["changed"]();
  });
  try {
    await f.mount();
    await change("reconnecting");
    assert.equal(f.session.connection, "reconnecting");
    await act(async () => t.mock.timers.tick(999));
    assert.equal(hints().length, 0);
    await change("open");
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(hints().length, 0);
    await change("reconnecting");
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(hints().length, 1);
    await change("open");
    assert.equal(hints().length, 0);
    f.session.notice = "令牌不对";
    await change("error");
    assert.equal(f.root.container.queryAll((node) => node.type === "Text" && node.props.children === "令牌不对").length, 1);
  } finally { await f.close(); }
});

test("failed target pagination exposes loaded history while online and retries the same cursor to the target", async () => {
  const f = fixture(true);
  try {
    await f.mount();
    assert.equal(f.lists().length, 0, "initial target waits for the missing page");
    await f.respond(0, null);
    assert.equal(f.session.connection, "open");
    assert.equal(f.retry().length, 1, "history errors must remain actionable even with healthy SSE");
    assert.equal(f.root.container.queryAll((node) => node.props.accessibilityRole === "alert").length, 1);
    assert.deepEqual(f.lists()[0].props.data.map((item: { key: string }) => item.key), page(100).map((event) => `e${event.seq}`));
    await act(async () => f.session["changed"]());
    assert.equal(f.requests.length, 1, "no unbounded automatic retry on unrelated notifications");
    await act(async () => f.retry()[0].props.onPress());
    assert.deepEqual(f.requests.map((request) => request.before), ["100", "100"]);
    assert.equal(f.retry().length, 0);
    assert.equal(f.lists().length, 0, "retry restores the placement barrier while waiting");
    await f.respond(1, page(40));
    assert.equal(f.session.timeline("c").historyError, undefined);
    assert.equal(f.lists()[0].props.data[f.lists()[0].props.initialPlacement.index].event.seq, 42);
    assert.deepEqual(f.alerts, [], "a failed request is not a missing message");
  } finally { await f.close(); }
});

test("target retry continues through older pages and reports missing only after successful exhaustion", async () => {
  const f = fixture(true);
  try {
    await f.mount();
    await f.respond(0, null);
    await act(async () => f.retry()[0].props.onPress());
    await f.respond(1, page(50));
    assert.deepEqual(f.requests.map((request) => request.before), ["100", "100", "50"]);
    assert.equal(f.alerts.length, 0, "failure or another full page is not exhaustion");
    await f.respond(2, []);
    assert.equal(f.retry().length, 0);
    assert.equal(f.lists().length, 1);
    assert.equal(f.alerts.length, 1, "only the successfully exhausted search alerts");
  } finally { await f.close(); }
});

test("first history request failure can be retried without a loaded timeline", async () => {
  const f = fixture(false);
  try {
    await f.mount();
    await f.respond(0, null);
    assert.equal(f.session.timeline("c").loaded, false);
    assert.equal(f.retry().length, 1);
    await act(async () => f.retry()[0].props.onPress());
    await f.respond(1, [message(42)]);
    assert.deepEqual(f.requests.map((request) => request.before), [null, null]);
    assert.equal(f.lists()[0].props.data[f.lists()[0].props.initialPlacement.index].event.seq, 42);
  } finally { await f.close(); }
});

test("return to latest exits failed target mode and stops target pagination", async () => {
  const f = fixture(true);
  try {
    await f.mount();
    await f.respond(0, null);
    await act(async () => f.root.container.queryAll((node) => node.props.testID === "chat-return-to-bottom")[0].props.onPress());
    await act(async () => f.session["changed"]());
    assert.equal(f.retry().length, 0);
    assert.equal(f.lists().length, 1);
    assert.equal(f.lists()[0].props.initialPlacement, undefined);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("a retry resolved in the same React batch gets a fresh target placement, not the error history's initial position", async () => {
  const f = fixture(true);
  try {
    await f.mount();
    await f.respond(0, null);
    assert.equal(f.lists()[0].props.initialPlacement, undefined);
    await act(async () => {
      f.retry()[0].props.onPress();
      f.requests[1].resolve(new Response(JSON.stringify({ events: page(40), as_of_seq: 200 }), {
        headers: { "content-type": "application/json" },
      }));
    });
    assert.equal(f.lists()[0].props.data[f.lists()[0].props.initialPlacement.index].event.seq, 42);
  } finally { await f.close(); }
});

test("after target retry the return button observes the replacement list, not the unmounted error history", async () => {
  const f = fixture(true);
  try {
    await f.mount();
    await f.respond(0, null);
    await act(async () => f.retry()[0].props.onPress());
    await f.respond(1, page(40));
    await act(async () => f.lists()[0].props.onScrollBeginDrag());
    const returnButtons = () => f.root.container.queryAll((node) => node.props.testID === "chat-return-to-bottom");
    assert.equal(returnButtons().length, 1);
    await act(async () => f.signals.at(-1)!.setAtEnd(true));
    assert.equal(returnButtons().length, 0, "reaching the end of the replacement list hides the return button");
    await act(async () => f.signals.at(-1)!.setAtEnd(false));
    assert.equal(returnButtons().length, 1, "reading upward in that same list shows it again");
  } finally { await f.close(); }
});

test("deleting the source branch leaves the target view without a false missing-message alert", async () => {
  const f = fixture(false);
  try {
    await f.mount();
    await f.respond(0, [message(42)]);
    await act(async () => {
      f.session.agents.deletedIds.add("agent");
      f.session["apply"]({ seq: 201, type: "conversation.deleted", conversation_id: "c", at: 201, data: { id: "c" } });
    });
    assert.equal(f.session.isDeleted("c"), true);
    assert.ok(f.routes.includes("/"));
    assert.deepEqual(f.alerts, [], "deletion is navigation, not a successfully exhausted message search");
  } finally { await f.close(); }
});

test("target highlight expires after placement without abandoning the reading position or re-highlighting on SSE", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(false);
  try {
    await f.mount();
    await act(async () => t.mock.timers.tick(10_000));
    await f.respond(0, [message(42)]);
    const target = () => f.lists()[0].props.renderItem({ item: f.lists()[0].props.data[0] });
    assert.match(target().props.className, /bg-muted/, "slow history loading must not consume the highlight");
    await act(async () => t.mock.timers.tick(3_000));
    assert.ok(!target().props.className?.includes("bg-muted"));
    assert.equal(target().props.testID, "message-target-42", "target identity remains available after the flash");
    assert.equal(f.lists()[0].props.maintainScrollAtEnd, false, "ending the flash must not resume following");
    await act(async () => f.session["apply"](message(43)));
    assert.ok(!target().props.className?.includes("bg-muted"));
    assert.equal(f.lists()[0].props.maintainScrollAtEnd, false);
  } finally { await f.close(); }
});

test("ordinary touch clears only the highlight; expiry, drag, send and return never rewrite initial placement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["touch", "expiry", "drag", "send", "return"] as const) {
    const f = fixture(true, "120");
    try {
      await f.mount();
      const initial = f.lists()[0].props.initialScrollIndex;
      assert.deepEqual(initial, { index: 20, viewPosition: 0 });
      assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
      const row = () => f.lists()[0].props.renderItem({ item: f.lists()[0].props.data[20], index: 20 });
      if (action === "touch") await act(async () => row().props.onTouchStart());
      if (action === "expiry") await act(async () => t.mock.timers.tick(2500));
      if (action === "drag") await act(async () => f.lists()[0].props.onScrollBeginDrag());
      if (action === "send") {
        f.session.send = async () => {};
        await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onSend());
      }
      if (action === "return") await act(async () =>
        f.root.container.queryAll((node) => node.props.testID === "chat-return-to-bottom")[0].props.onPress());
      assert.equal(f.lists()[0].props.initialScrollIndex, initial, action);
      assert.equal(f.lists()[0].props.initialScrollAtEnd, false, action);
      assert.ok(!row().props.className?.includes("bg-muted"), action);
      assert.equal(f.lists()[0].props.maintainScrollAtEnd === false, action === "touch" || action === "expiry", action);
    } finally { await f.close(); }
  }
});

test("draft touch intentionally preserves highlight and READ without changing either initial prop", async () => {
  const f = fixture(true, "120");
  try {
    await f.mount();
    const initial = f.lists()[0].props.initialScrollIndex;
    const draftRow = f.lists()[0].props.renderItem({ item: { key: "dpreview", draft: {
      draft_id: "preview", conversation_id: "c", sender: "task", agent: "agent", text: "Still writing", phase: "final",
    } }, index: 50 });
    await act(async () => draftRow.props.onTouchStart?.());
    assert.match(f.lists()[0].props.renderItem({ item: f.lists()[0].props.data[20], index: 20 }).props.className, /bg-muted/);
    assert.equal(f.lists()[0].props.maintainScrollAtEnd, false);
    assert.equal(f.lists()[0].props.initialScrollIndex, initial);
    assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
  } finally { await f.close(); }
});

for (const outcome of ["accepted", "invalid", "failed", "conflict"] as const) {
  test(`real form submission ${outcome}: only local acceptance releases READ; initial props stay frozen`, async () => {
    const f = fixture(true, "120");
    const formRoot = createRoot();
    const source = JSON.stringify({ root: "card", elements: {
      card: { type: "Card", props: {}, children: ["choice", "submit"] },
      choice: { type: "ChoiceGroup", props: { stateKey: "choice", options: [{ value: "A", label: "甲" }, { value: "B", label: "乙" }] }, children: [] },
      submit: { type: "Submit", props: { label: "确定" }, children: [] },
    }, state: { choice: "A" } });
    f.session.timeline("c").events[20] = {
      ...message(120), type: "message.agent", data: { text: "```wandrun-ui\n" + source + "\n```" },
    };
    try {
      await f.mount();
      const initial = f.lists()[0].props.initialScrollIndex;
      assert.deepEqual(initial, { index: 20, viewPosition: 0 });
      await act(async () => formRoot.render(f.lists()[0].props.renderItem({
        item: f.lists()[0].props.data[20], index: 20,
      })));
      // A normal form touch removes only the flash, never target reading priority.
      await act(async () => formRoot.container.queryAll((node) => node.props.testID === "message-target-120")[0].props.onTouchStart());
      let pending!: Promise<void>;
      await act(async () => { pending = formRoot.container.queryAll((node) => node.type === "Form")[0].props.send(); });
      assert.equal(f.submissions.length, 1);
      assert.deepEqual(f.submissions[0].body.values, { choice: "A" });
      assert.equal(f.lists()[0].props.maintainScrollAtEnd, false, "in-flight is not accepted");
      assert.equal(f.lists()[0].props.initialScrollIndex, initial);
      assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
      const event: GatewayEvent = { ...message(201), data: {
        text: "Submitted A", ui_submission: { message_seq: 120, block: 0, values: { choice: "A" } },
      } };
      const status = { accepted: 200, invalid: 400, failed: 503, conflict: 409 }[outcome];
      await act(async () => {
        f.submissions[0].resolve(Response.json(outcome === "accepted" ? { event } : {
          error: { code: outcome === "invalid" ? "ui_invalid_values" : outcome === "conflict" ? "ui_already_submitted" : "unavailable",
            message: outcome, ...(outcome === "conflict" ? { details: { event } } : {}) },
        }, { status }));
        await pending;
      });
      assert.equal(f.lists()[0].props.data.some((item: { event?: GatewayEvent }) => item.event?.seq === 201),
        outcome === "accepted" || outcome === "conflict");
      await act(async () => f.signals.at(-1)!.setAtEnd(true));
      assert.equal(f.lists()[0].props.maintainScrollAtEnd === false, outcome !== "accepted");
      assert.equal(f.root.container.queryAll((node) => node.props.testID === "chat-return-to-bottom").length,
        outcome === "accepted" ? 0 : 1);
      assert.equal(f.lists()[0].props.initialScrollIndex, initial);
      assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
    } finally {
      await act(async () => formRoot.unmount());
      await f.close();
    }
  });
}

test("prepend changes the target's current index but never its mount snapshot", async () => {
  const f = fixture(true, "120");
  try {
    await f.mount();
    const initial = f.lists()[0].props.initialScrollIndex;
    await act(async () => {
      f.session.timeline("c").events.unshift(...page(50));
      f.session["changed"]();
    });
    assert.equal(f.lists()[0].props.data.findIndex((item: { event: GatewayEvent }) => item.event.seq === 120), 70);
    assert.equal(f.lists()[0].props.initialScrollIndex, initial);
    assert.equal(initial.index, 20);
    assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
  } finally { await f.close(); }
});

test("a last-message target follows new content only when placement actually reaches the bottom", async () => {
  for (const atEnd of [false, true]) {
    const f = fixture(true, "149", atEnd);
    try {
      await f.mount();
      const initial = f.lists()[0].props.initialScrollIndex;
      assert.equal(f.lists()[0].props.maintainScrollAtEnd === false, !atEnd);
      await act(async () => f.session["apply"](message(201)));
      assert.equal(f.lists()[0].props.maintainScrollAtEnd === false, !atEnd);
      assert.equal(f.lists()[0].props.initialScrollIndex, initial);
    } finally { await f.close(); }
  }
});

test("last-target end geometry settling after readiness releases reading priority once", async () => {
  const f = fixture(true, "149");
  try {
    await f.mount();
    const initial = f.lists()[0].props.initialScrollIndex;
    assert.equal(f.lists()[0].props.maintainScrollAtEnd, false);
    await act(async () => f.signals.at(-1)!.setAtEnd(true));
    assert.notEqual(f.lists()[0].props.maintainScrollAtEnd, false);
    await act(async () => {
      f.signals.at(-1)!.setAtEnd(false);
      f.session["apply"](message(201));
    });
    assert.notEqual(f.lists()[0].props.maintainScrollAtEnd, false, "content growth cannot reclaim target priority");
    assert.equal(f.lists()[0].props.initialScrollIndex, initial);
    assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
  } finally { await f.close(); }
});

test("changing route target remounts both initial props, including latest-to-index-to-latest", async () => {
  const f = fixture(true, null);
  try {
    await f.mount();
    assert.equal(f.lists()[0].props.initialScrollAtEnd, true);
    for (const seq of ["120", "130", undefined]) {
      await act(async () => {
        Object.assign(globalThis, { __targetParams: { id: "c", message_seq: seq } });
        f.root.render(createElement(Chat));
      });
      await act(async () => f.root.container.queryAll((node) => typeof node.props.onLayout === "function")[0]
        .props.onLayout({ nativeEvent: { layout: { height: 70 } } }));
      assert.equal(f.lists()[0].props.initialScrollAtEnd, seq === undefined);
      assert.equal(f.lists()[0].props.initialScrollIndex?.index, seq === undefined ? undefined : Number(seq) - 100);
    }
  } finally { await f.close(); }
});

test("latest placement remains at-end through touch, drag, prepend, send and return", async () => {
  const f = fixture(true, null);
  try {
    await f.mount();
    await act(async () => f.lists()[0].props.renderItem({ item: f.lists()[0].props.data[20], index: 20 }).props.onTouchStart());
    await act(async () => f.lists()[0].props.onScrollBeginDrag());
    await act(async () => {
      f.session.timeline("c").events.unshift(...page(50));
      f.session["changed"]();
    });
    assert.equal(f.lists()[0].props.initialScrollAtEnd, true);
    assert.equal(f.lists()[0].props.initialScrollIndex, undefined);
    await act(async () => f.root.container.queryAll((node) => node.props.testID === "chat-return-to-bottom")[0].props.onPress());
    f.session.send = async () => {};
    await act(async () => f.root.container.queryAll((node) => node.type === "Composer")[0].props.onSend());
    assert.equal(f.lists()[0].props.initialScrollAtEnd, true);
    assert.equal(f.lists()[0].props.initialScrollIndex, undefined);
  } finally { await f.close(); }
});

test("changing conversation discards the previous list snapshot even with the same message sequence", async () => {
  const f = fixture(true, "120");
  try {
    await f.mount();
    const initial = f.lists()[0].props.initialScrollIndex;
    f.session.conversations.set("other", { ...f.session.conversations.get("c")!, id: "other" });
    Object.assign(f.session.timeline("other"), {
      events: page(110).map((event) => ({ ...event, conversation_id: "other" })),
      oldest: 110, loaded: true, complete: true,
    });
    await act(async () => {
      Object.assign(globalThis, { __targetParams: { id: "other", message_seq: "120" } });
      f.root.render(createElement(Chat));
    });
    await act(async () => f.root.container.queryAll((node) => typeof node.props.onLayout === "function")[0]
      .props.onLayout({ nativeEvent: { layout: { height: 70 } } }));
    assert.notEqual(f.lists()[0].props.initialScrollIndex, initial);
    assert.deepEqual(f.lists()[0].props.initialScrollIndex, { index: 10, viewPosition: 0 });
    assert.equal(f.lists()[0].props.initialScrollAtEnd, false);
  } finally { await f.close(); }
});

test("member execution failure exposes its reason and clears it when a new execution starts", async () => {
  const f = fixture(false);
  f.session.conversations.delete("c");
  f.session["apply"]({ seq: 201, type: "task.created", conversation_id: "root", at: 201, data: {
    task_id: "c", creator_task_id: "root", creator_agent_id: "parent", agent_id: "agent",
    title: "Child", status: "running", timeline_ids: ["root", "c"],
  } });
  f.session["apply"]({ seq: 202, type: "task.status", conversation_id: "root", at: 202, data: {
    task_id: "c", status: "failed", error: "MODEL_BACKEND_UNAVAILABLE", timeline_ids: ["root", "c"],
  } });
  try {
    await f.mount();
    const errors = () => f.root.container.queryAll((node) => node.type === "Text" && node.props.accessibilityRole === "alert")
      .map((node) => String(node.props.children)).join("\n");
    assert.match(errors(), /MODEL_BACKEND_UNAVAILABLE/);
    await act(async () => f.session["apply"]({ seq: 203, type: "task.status", conversation_id: "root", at: 203, data: {
      task_id: "c", status: "running", error: null, timeline_ids: ["root", "c"],
    } }));
    assert.doesNotMatch(errors(), /MODEL_BACKEND_UNAVAILABLE/);
  } finally { await f.close(); }
});

test("timeline keeps ordinary message gaps, touching delegation targets and a 24dp visual footer gap", async () => {
  const f = fixture(true, null);
  const conversation = f.session.conversations.get("c")!;
  Object.assign(conversation, { status: "working", activity: "正在思考" });
  Object.assign(f.session.timeline("c"), { events: [], complete: true });
  try {
    await f.mount();
    const footerStyle = () => Object.assign({}, ...[f.lists()[0].props.ListFooterComponent.props.style].flat().filter(Boolean));
    assert.equal(footerStyle().paddingTop ?? 0, 0, "empty history has no preceding row");
    const messages = [message(1), message(2)];
    const collaboration = collaborationEvents.map((entry) => ({
      ...entry, conversation_id: "c", data: {
        ...entry.data,
        creator_task_id: entry.data.creator_task_id === "root" ? "c" : entry.data.creator_task_id,
        sender_task_id: entry.data.sender_task_id === "root" ? "c" : entry.data.sender_task_id,
        recipient_task_id: entry.data.recipient_task_id === "root" ? "c" : entry.data.recipient_task_id,
        timeline_ids: entry.data.timeline_ids.map((id: string) => id === "root" ? "c" : id),
      },
    }));
    await act(async () => {
      f.session.timeline("c").events = [...messages, ...collaboration];
      f.session["changed"]();
    });
    const props = f.lists()[0].props;
    assert.deepEqual(props.data.map((item: { key: string }) => item.key), ["e1", "e2", "tsearch-1", "tsearch-2"]);
    const rows = props.data.map((item: { key: string }, index: number) => props.renderItem({ item, index }));
    const topGaps = rows.map((row: { props: { style?: { paddingTop?: number } } }) => row.props.style?.paddingTop ?? 0);
    assert.deepEqual(topGaps, [0, 12, 0, 0], "only ordinary neighbors need an external gap");
    assert.equal(footerStyle().paddingTop + 12, 24, "delegation bottom padding plus footer gap");
    await act(async () => { conversation.status = "idle"; f.session["changed"](); });
    assert.equal(f.lists()[0].props.ListFooterComponent, null, "no blank footer after work settles");
    await act(async () => { conversation.status = "failed"; f.session["changed"](); });
    assert.equal(footerStyle().paddingTop, 12, "a visible failure hint retains the ordinary footer boundary");
  } finally { await f.close(); }
});
