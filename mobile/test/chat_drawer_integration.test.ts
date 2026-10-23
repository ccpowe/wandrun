import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type TestInstance } from "test-renderer";
import ts from "typescript";

import type { AgentSummary, Conversation } from "../src/gateway/api.ts";
import { ChatSession } from "../src/gateway/session.ts";

// Real Header → hook → Flow → Drawer boundary. Only native hosts and the library's
// animation clock are substituted. The host hit gate is not a claim about native gesture arbitration.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const routes: unknown[] = [];
Object.assign(globalThis, { __chatDrawerRoutes: routes });
const react = JSON.stringify(import.meta.resolve("react"));
const hosts: Record<string, string> = {
  "expo-router": `export const router={setParams:params=>globalThis.__chatDrawerRoutes.push(params),push:route=>globalThis.__chatDrawerRoutes.push(route)};`,
  "react-native": `export const View='View',Pressable='Pressable',ScrollView='ScrollView';
    export const Alert={alert(){throw new Error('Unexpected drawer error')}},Keyboard={dismiss(){}};
    export const BackHandler={addEventListener:()=>({remove(){}})},useWindowDimensions=()=>({width:390,height:844});`,
  "react-native-drawer-layout": `import {createElement,useEffect} from ${react};
    export function Drawer(props){
      useEffect(()=>props.onTransitionStart?.(!props.open),[props.open]);
      return createElement('DrawerAnimation',props,props.renderDrawerContent(),props.children);
    }`,
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({top:0,bottom:0});",
  "react-native-keyboard-controller": "export const useReanimatedKeyboardAnimation=()=>({progress:{value:0},height:{value:0}});",
  "react-native-reanimated": "export const useAnimatedStyle=fn=>fn(); export default {View:'AnimatedView'};",
  "lucide-react-native": "export const Clock='Clock',Pencil='Pencil',Plus='Plus',Search='Search',Trash2='Trash2',SquarePen='SquarePen',TextAlignStart='TextAlignStart';",
  "@/components/ui/button.tsx": "export const Button='Pressable';",
  "@/components/ui/input.tsx": "export const Input='Input';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/ui/alert-dialog.tsx": "export const AlertDialog='AlertDialog',AlertDialogCancel='Pressable',AlertDialogContent='View',AlertDialogDescription='Text',AlertDialogFooter='View',AlertDialogHeader='View',AlertDialogTitle='Text';",
  "@/components/wandrun-avatar.tsx": "export const WandrunAvatar='Avatar';",
  "./typing-dots.tsx": "export const TypingDots='TypingDots';",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return next(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return next(url, context);
  },
});
// Static imports would load native packages before the host resolution hooks are installed.
const { ChatHeader } = await import("../src/components/chat/chat-header.tsx");
const { ConversationDrawer } = await import("../src/components/chat/conversation-drawer.tsx");
const { useConversationDrawer } = await import("../src/lib/use-conversation-drawer.ts");

/** Honor the native host pointerEvents contract before dispatching an action.
 * Device verification separately proves actual hit testing and animation timing. */
function press(node: TestInstance): boolean {
  if (node.props.disabled || !node.props.onPress) return false;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.props.pointerEvents === "none" || parent.props.pointerEvents === "box-only") return false;
  }
  node.props.onPress();
  return true;
}

const agent: AgentSummary = { id: "agent", name: "Agent", avatar: 0, description: "", workers: [], home: true, unread: false, latest_conversation: null };
function conversation(id: string): Conversation {
  return { id, agent_id: agent.id, title: id, created_at: 1, updated_at: 1, read_seq: 0, last_agent_seq: 0, unread: false,
    status: "idle", last_text: "Existing message", source: "user", schedule_origin: null };
}

test("real Header/hook/Flow block close-period taps, preserve the selected destination, then deduplicate a new conversation", async () => {
  routes.length = 0;
  let creations = 0;
  const { promise: creation, resolve: resolveCreate } = Promise.withResolvers<Response>();
  const session = new ChatSession({ baseUrl: "http://chat-drawer", token: "test" }, async (input, init) => {
    if (new URL(String(input)).pathname === "/conversations" && init?.method === "POST") {
      creations++;
      return creation;
    }
    return new Response(JSON.stringify({ conversations: [], as_of_seq: 0 }), { headers: { "Content-Type": "application/json" } });
  });
  session.agents.close();
  session.agents.agents = [agent];
  session["reset"]([conversation("a"), conversation("b")], 0);
  const root = createRoot({ textComponentTypes: ["Text"] });
  function ChatControls() {
    useSyncExternalStore(session.subscribe, session.getVersion, session.getVersion);
    const drawer = useConversationDrawer(session, "a", agent.id, true);
    return createElement(ConversationDrawer, { ...drawer.drawerProps, onOpen: drawer.show,
      children: createElement(ChatHeader, { agent, title: "a", paddingTop: 0, working: false,
        onOpenConversations: drawer.show, newConversationDisabled: false, onNewConversation: drawer.newConversation }),
    });
  }
  const byId = (id: string) => root.container.queryAll(node => node.props.testID === id)[0];
  try {
    await act(async () => root.render(createElement(ChatControls)));
    await act(async () => { press(root.container.queryAll(node => node.props.accessibilityLabel === "对话列表")[0]); });
    await act(async () => { press(byId("conversation-b")); });
    assert.deepEqual(routes, [], "selection waits for actual close completion");
    await act(async () => {
      assert.equal(press(byId("chat-agent-profile")), false, "the whole closing boundary must reject profile navigation");
      assert.equal(press(byId("chat-new-conversation")), false);
      assert.equal(press(byId("chat-new-conversation")), false);
    });
    assert.equal(creations, 0);
    assert.deepEqual(routes, []);
    await act(async () => root.container.queryAll(node => node.type === "DrawerAnimation")[0].props.onTransitionEnd(false));
    assert.equal(press(byId("chat-new-conversation")), false, "an opening completion cannot release a closing boundary");
    await act(async () => root.container.queryAll(node => node.type === "DrawerAnimation")[0].props.onTransitionEnd(true));
    assert.deepEqual(routes, [{ id: "b", message_seq: undefined }]);
    await act(async () => {
      assert.equal(press(byId("chat-new-conversation")), true);
      assert.equal(press(byId("chat-new-conversation")), true);
    });
    assert.equal(creations, 1, "both Header taps must pass through the same synchronous Flow guard");
    await act(async () => resolveCreate(new Response(JSON.stringify({ ...conversation("fresh"), last_text: null }), {
      headers: { "Content-Type": "application/json" },
    })));
    assert.deepEqual(routes, [{ id: "b", message_seq: undefined }, { id: "fresh", message_seq: undefined }]);
    await act(async () => root.container.queryAll(node => node.type === "DrawerAnimation")[0].props.onTransitionEnd(true));
    assert.deepEqual(routes, [{ id: "b", message_seq: undefined }, { id: "fresh", message_seq: undefined }], "late animation completion cannot navigate twice");
  } finally {
    await act(async () => root.unmount());
    await session.close();
  }
});
