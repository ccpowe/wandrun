import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";
import { GatewayError, type AgentMemory, type MemoryDetail } from "../src/gateway/api.ts";
import type { ChatSession } from "../src/gateway/session.ts";

declare global {
  var __memoryNav: unknown[];
  var __memoryParams: { id: string; scope: "profile" | "work"; slug?: string; create?: string };
  var __memoryFocused: boolean;
  var __memoryAlert: [string, string, { text: string; onPress?: () => void }[]];
}

// Render the actual tab and full-screen routes with inert native hosts; exercise their
// fetch, focus, draft and navigation effects instead of treating helpers as page tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const hosts: Record<string, string> = {
  "expo-router": `export const router={push:(route)=>globalThis.__memoryNav.push(route),back:()=>globalThis.__memoryNav.push('back'),dismissTo:(route)=>globalThis.__memoryNav.push({dismissTo:route})};
    export const Stack={Screen:'Screen'}, Redirect='Redirect';
    export const useIsFocused=()=>globalThis.__memoryFocused;
    export const useLocalSearchParams=()=>globalThis.__memoryParams;`,
  "react-native": `export const View='View', ScrollView='ScrollView', Text='NativeText', Pressable='Pressable';
    export const Alert={alert:(...args)=>globalThis.__memoryAlert=args};
    export const BackHandler={addEventListener:()=>({remove(){}})};`,
  "react-native-keyboard-controller": `export const KeyboardAvoidingView='KeyboardAvoidingView';
    export const useReanimatedKeyboardAnimation=()=>({progress:{value:0}});`,
  "react-native-reanimated": "export default {View:'AnimatedView'}; export const useAnimatedStyle=(fn)=>fn();",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({bottom:0});",
  "lucide-react-native": "export const ChevronLeft='ChevronLeft', ChevronRight='ChevronRight', UserRound='UserRound';",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__memorySession;",
  "@/components/agent-memory-markdown.tsx": "export const AgentMemoryMarkdown='AgentMemoryMarkdown';",
  "@/components/empty-state.tsx": "export const EmptyState='EmptyState';",
  "@/components/screen-bar.tsx": `import {createElement} from ${JSON.stringify(import.meta.resolve("react"))};
    export const ScreenBar=({left,right,title,subtitle})=>createElement('ScreenBar',{title,subtitle},left,right);`,
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/ui/textarea.tsx": "export const Textarea='Textarea';",
  "@/lib/connection-banner.tsx": "export const ConnectionBanner='ConnectionBanner';",
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
// Dynamic imports must follow registerHooks: static imports load native modules before these test hosts exist.
const { AgentMemoryTab } = await import("../src/components/agent-memory-tab.tsx");
const { default: MemoryEditor } = await import("../src/app/memory-editor.tsx");
const { default: MemoryDetail } = await import("../src/app/memory-detail.tsx");
const { default: AboutYou } = await import("../src/app/settings-about-you.tsx");
const { memoryEntryCount, memoryIndexEntries } = await import("../src/lib/memory-index.ts");

function snapshot(scope: "profile" | "work", content = "", version = "v1"): AgentMemory {
  return { scope, ...(scope === "work" ? { agent_id: "helper" } : {}), content, version,
    details: {}, limit: 1000, updated_at: null, updated_by: null };
}
function fixture() {
  const records = { profile: snapshot("profile"), work: snapshot("work") };
  const revisions = { profile: 0, work: 0 };
  const calls: unknown[][] = [];
  const session = {
    api: {
      getMemory: async (scope: "profile" | "work") => records[scope],
      updateMemory: async (...args: unknown[]) => { calls.push(args); return records[args[0] as "profile" | "work"]; },
      getMemoryDetail: async (): Promise<MemoryDetail> => ({ scope: "work", agent_id: "helper", slug: "topic", content: "First", version: records.work.version,
        path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64), limit: 65536 }),
      updateMemoryDetail: async (...args: unknown[]) => { calls.push(args); return records.work; },
      deleteMemoryDetail: async (...args: unknown[]) => { calls.push(args); return records.work; },
    },
    agents: { agents: [{ id: "helper", name: "Planner" }], deletedIds: new Set<string>(), loaded: true, error: null },
    memoryRevisionFor: (scope: "profile" | "work") => revisions[scope],
    memoryConnectionRevision: 0,
  };
  globalThis.__memoryAlert = ["", "", []];
  Object.assign(globalThis, { __memorySession: session, __memoryParams: { id: "helper", scope: "work" },
    __memoryNav: [], __memoryFocused: true });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const node = (id: string) => root.container.queryAll((item) => item.props.testID === id)[0];
  const press = async (id: string) => act(async () => node(id).props.onPress());
  const close = async () => act(async () => root.unmount());
  return { session, records, revisions, calls, root, node, press, close };
}

test("index save blocks both detail entries before and after the busy render", async () => {
  const f = fixture();
  const ref = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  f.records.work = { ...snapshot("work", "Original index"), details: { topic: ref } };
  const pending = Promise.withResolvers<AgentMemory>();
  f.session.api.updateMemory = async (...args: unknown[]) => { f.calls.push(args); return pending.promise; };
  try {
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await act(async () => f.node("memory-editor-input").props.onChangeText("Saved index"));
    const save = f.node("memory-editor-save").props.onPress;
    const openNew = f.node("memory-editor-new-detail").props.onPress;
    const openExisting = f.node("memory-editor-detail-topic").props.onPress;
    await act(async () => {
      save();
      openNew();
      openExisting();
    });
    assert.deepEqual(globalThis.__memoryNav, [], "old callbacks cannot open a detail while the PUT owns navigation");
    assert.equal(f.node("memory-editor-new-detail").props.disabled, true);
    assert.equal(f.node("memory-editor-detail-topic").props.disabled, true);
    await f.press("memory-editor-new-detail");
    await f.press("memory-editor-detail-topic");
    assert.deepEqual(globalThis.__memoryNav, [], "current callbacks also honor the synchronous barrier");
    f.records.work = { ...f.records.work, content: "Saved index", version: "v2" };
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await act(async () => pending.resolve(f.records.work));
    assert.deepEqual(f.calls, [["work", "helper", "Saved index", "v1"]]);
    assert.deepEqual(globalThis.__memoryNav, ["back"], "the successful PUT closes only its own editor, even after its SSE update");
  } finally { await f.close(); }
});

test("index reload blocks detail entries and preview links without losing the draft", async () => {
  const f = fixture();
  const ref = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  f.records.work = { ...snapshot("work", "Original index"), details: { topic: ref } };
  const pending = Promise.withResolvers<AgentMemory>();
  try {
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await act(async () => f.node("memory-editor-input").props.onChangeText("Local draft"));
    f.records.work = { ...f.records.work, content: `[Topic](${ref.path})`, version: "v2" };
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await f.press("memory-editor-view-current");
    const preview = f.root.container.queryAll((node) => node.type === "AgentMemoryMarkdown")[0].props.managedMemory.onOpen;
    const openNew = f.node("memory-editor-new-detail").props.onPress;
    const openExisting = f.node("memory-editor-detail-topic").props.onPress;
    const reload = f.node("memory-editor-reload").props.onPress;
    f.session.api.getMemory = async () => pending.promise;
    await act(async () => {
      reload();
      openNew();
      openExisting();
      preview("topic");
    });
    assert.deepEqual(globalThis.__memoryNav, [], "every pre-render detail entry respects the reload barrier");
    assert.equal(f.node("memory-editor-new-detail").props.disabled, true);
    assert.equal(f.node("memory-editor-detail-topic").props.disabled, true);
    await f.press("memory-editor-new-detail");
    await f.press("memory-editor-detail-topic");
    await act(async () => f.root.container.queryAll((node) => node.type === "AgentMemoryMarkdown")[0].props.managedMemory.onOpen("topic"));
    assert.deepEqual(globalThis.__memoryNav, []);
    await act(async () => pending.resolve(f.records.work));
    assert.equal(f.node("memory-editor-input").props.value, "Local draft");
    assert.equal(f.node("memory-editor-new-detail").props.disabled, false);
    assert.equal(f.node("memory-editor-detail-topic").props.disabled, false);
    await f.press("memory-editor-detail-topic");
    assert.deepEqual(globalThis.__memoryNav, [{ pathname: "/memory-detail", params: { scope: "work", id: "helper", slug: "topic" } }]);
  } finally { await f.close(); }
});

test("Agent memory shows only work while its About You summary follows the shared resource", async () => {
  const f = fixture();
  f.records.profile = snapshot("profile", "## Identity\n- Shared profile\n- Preference");
  f.records.work = snapshot("work", "Local work");
  try {
    await act(async () => f.root.render(createElement(AgentMemoryTab, { id: "helper", session: f.session as unknown as ChatSession })));
    assert.deepEqual(f.root.container.queryAll((item) => item.type === "AgentMemoryMarkdown").map((item) => item.props.content), ["Local work"]);
    assert.equal(f.node("profile-about-you-summary").props.children, "2 条");
    await f.press("profile-about-you");
    assert.equal(globalThis.__memoryNav.at(-1), "/settings-about-you");
    await f.press("profile-memory-edit");
    assert.deepEqual(globalThis.__memoryNav.at(-1), { pathname: "/memory-editor", params: { scope: "work", id: "helper" } });
    f.records.profile = snapshot("profile", "- Updated shared profile", "v2");
    f.revisions.profile++;
    await act(async () => f.root.render(createElement(AgentMemoryTab, { id: "helper", session: f.session as unknown as ChatSession })));
    assert.equal(f.node("profile-about-you-summary").props.children, "1 条");
    assert.deepEqual(f.root.container.queryAll((item) => item.type === "AgentMemoryMarkdown").map((item) => item.props.content), ["Local work"]);
  } finally { await f.close(); }
});

test("About You edits the same shared resource without depending on an Agent", async () => {
  const f = fixture();
  f.records.profile = snapshot("profile", "Shared facts");
  f.session.agents.deletedIds.add("profile");
  f.session.agents.deletedIds.add("helper");
  try {
    await act(async () => f.root.render(createElement(AboutYou)));
    assert.equal(f.node("profile-shared-memory-content").props.children.props.content, "Shared facts");
    await f.press("profile-shared-memory-edit");
    assert.deepEqual(globalThis.__memoryNav.at(-1), { pathname: "/memory-editor", params: { id: "profile", scope: "profile" } });
    f.records.profile = snapshot("profile", "Changed elsewhere", "v2");
    f.revisions.profile++;
    await act(async () => f.root.render(createElement(AboutYou)));
    assert.equal(f.node("profile-shared-memory-content").props.children.props.content, "Changed elsewhere");
  } finally { await f.close(); }
});

test("About You ignores an older fetch after reconnect and retries a failed read", async () => {
  const f = fixture();
  const old = Promise.withResolvers<AgentMemory>();
  f.session.api.getMemory = async () => old.promise;
  try {
    await act(async () => f.root.render(createElement(AboutYou)));
    f.session.memoryConnectionRevision++;
    f.session.api.getMemory = async () => { throw new Error("offline"); };
    await act(async () => f.root.render(createElement(AboutYou)));
    assert.ok(f.node("profile-shared-memory-error"));
    f.session.api.getMemory = async () => snapshot("profile", "Current");
    await f.press("profile-shared-memory-retry");
    await act(async () => old.resolve(snapshot("profile", "Stale")));
    assert.equal(f.node("profile-shared-memory-content").props.children.props.content, "Current");
  } finally { await f.close(); }
});

test("missing Agent work memory dismisses its profile while shared read failures stay retryable", async () => {
  const f = fixture();
  f.session.api.getMemory = async () => { throw new GatewayError(404, "not_found", "Missing memory"); };
  try {
    await act(async () => f.root.render(createElement(AgentMemoryTab, { id: "helper", session: f.session as unknown as ChatSession })));
    assert.deepEqual(globalThis.__memoryNav, [{ dismissTo: "/" }]);
    globalThis.__memoryNav = [];
    await act(async () => f.root.render(createElement(AboutYou)));
    assert.deepEqual(globalThis.__memoryNav, []);
    assert.ok(f.node("profile-shared-memory-retry"));
  } finally { await f.close(); }
});

test("full-screen profile editor retains local text across focus/resource changes until explicit baseline reload", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "profile", scope: "profile" };
  try {
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await act(async () => f.node("memory-editor-input").props.onChangeText("My local draft"));
    f.records.profile = snapshot("profile", "Remote change", "v2");
    f.revisions.profile++;
    await act(async () => f.root.render(createElement(MemoryEditor)));
    assert.equal(f.node("memory-editor-input").props.value, "My local draft");
    assert.ok(f.node("memory-editor-conflict"));
    assert.equal(f.node("memory-editor-save").props.disabled, true);
    await f.press("memory-editor-reload");
    assert.equal(f.node("memory-editor-input").props.value, "My local draft");
    await f.press("memory-editor-save");
    assert.deepEqual(f.calls.at(-1), ["profile", "profile", "My local draft", "v2"]);
  } finally { await f.close(); }
});
test("editor lists only active unreferenced details using parsed links and preserves its draft after detail navigation", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "profile", scope: "profile" };
  const path = (slug: string) => `/.wandrun/memory/profile/details/${slug}/${"a".repeat(64)}.md`;
  const details = Object.fromEntries(["inline", "reference", "plain", "code"].map((slug) =>
    [slug, { path: path(slug), sha256: "a".repeat(64) }]));
  f.records.profile = { ...snapshot("profile",
    `- [Visible](${path("inline")} "title")\n- [Referenced][ref]\n\n[ref]: ${path("reference")} "title"\n\n${path("plain")}\n\n\`[Code](${path("code")})\`\n`),
    details };
  try {
    await act(async () => f.root.render(createElement(MemoryEditor)));
    assert.equal(f.root.container.queryAll((item) => item.type === "ScreenBar")[0].props.title, "编辑关于你");
    assert.deepEqual(memoryIndexEntries(f.records.profile.content, f.records.profile).map((entry) => entry.title), ["Visible", "Referenced"]);
    assert.equal(f.node("memory-editor-detail-inline"), undefined);
    assert.equal(f.node("memory-editor-detail-reference"), undefined);
    assert.ok(f.node("memory-editor-detail-plain"));
    assert.ok(f.node("memory-editor-detail-code"));
    await act(async () => f.node("memory-editor-input").props.onChangeText(`Draft\n- [Plain](${path("plain")})\n`));
    assert.equal(f.node("memory-editor-detail-plain"), undefined);
    assert.ok(f.node("memory-editor-detail-inline"));
    await f.press("memory-editor-detail-inline");
    assert.deepEqual(globalThis.__memoryNav.at(-1), { pathname: "/memory-detail", params: { scope: "profile", id: "profile", slug: "inline" } });
    globalThis.__memoryFocused = false;
    await act(async () => f.root.render(createElement(MemoryEditor)));
    f.records.profile = { ...f.records.profile, content: "Remote change", version: "v2",
      details: { ...f.records.profile.details, fresh: { path: path("fresh"), sha256: "a".repeat(64) } } };
    f.revisions.profile++;
    globalThis.__memoryFocused = true;
    await act(async () => f.root.render(createElement(MemoryEditor)));
    assert.equal(f.node("memory-editor-input").props.value, `Draft\n- [Plain](${path("plain")})\n`);
    assert.ok(f.node("memory-editor-conflict"));
    assert.ok(f.node("memory-editor-detail-fresh"), "new active detail is available without replacing local text");
    await f.press("memory-editor-new-detail");
    assert.deepEqual(globalThis.__memoryNav.at(-1), { pathname: "/memory-detail", params: { scope: "profile", id: "profile", create: "1" } });
  } finally { await f.close(); globalThis.__memoryFocused = true; }
});

test("profile memory routes are independent of an Agent named profile", async () => {
  const f = fixture();
  f.session.agents.deletedIds.add("profile");
  globalThis.__memoryParams = { id: "profile", scope: "profile" };
  const path = `/.wandrun/memory/profile/details/topic/${"a".repeat(64)}.md`;
  f.records.profile = { ...snapshot("profile", `- [Readable title](${path})`), details: { topic: { path, sha256: "a".repeat(64) } } };
  try {
    await act(async () => f.root.render(createElement(MemoryEditor)));
    assert.ok(f.node("memory-editor-input"));
    globalThis.__memoryParams = { id: "profile", scope: "profile", slug: "topic" };
    await act(async () => f.root.render(createElement(MemoryDetail)));
    const bar = f.root.container.queryAll((item) => item.type === "ScreenBar")[0];
    assert.equal(bar.props.title, "Readable title");
    assert.equal(bar.props.subtitle, "关于你");
    assert.equal(f.node("memory-detail-count"), undefined, "read-only detail has no byte counter");
    assert.ok(f.node("memory-detail-content"));
  } finally { await f.close(); }
});

test("memory index count prefers list items and falls back to prose paragraphs", () => {
  assert.equal(memoryEntryCount("## Heading\n\n- One\n- Two\n\nAfter prose"), 2);
  assert.equal(memoryEntryCount("## Heading\n\nFirst paragraph\n\nSecond paragraph"), 2);
  assert.equal(memoryEntryCount("## Heading\n"), 0);
});



for (const scope of ["profile", "work"] as const) test(`${scope} editor ignores a late v2 save conflict after observing SSE v3`, async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: scope === "profile" ? "profile" : "helper", scope };
  const pending = Promise.withResolvers<AgentMemory>();
  f.records[scope] = snapshot(scope, "Initial v1", "v1");
  f.session.api.updateMemory = async (...args: unknown[]) => {
    f.calls.push(args);
    return pending.promise;
  };
  try {
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await act(async () => f.node("memory-editor-input").props.onChangeText("Local draft"));
    await f.press("memory-editor-save");
    assert.deepEqual(f.calls, [[scope, globalThis.__memoryParams.id, "Local draft", "v1"]]);

    f.records[scope] = snapshot(scope, "Newest v3", "v3");
    f.revisions[scope]++;
    await act(async () => f.root.render(createElement(MemoryEditor)));
    await f.press("memory-editor-view-current");
    assert.equal(f.node("memory-editor-current").props.children.type, "AgentMemoryMarkdown");
    assert.equal(f.node("memory-editor-current").props.children.props.content, "Newest v3");

    await act(async () => pending.reject(new GatewayError(409, "conflict", "changed", {
      current: snapshot(scope, "Stale v2", "v2"),
    })));
    assert.ok(f.node("memory-editor-conflict"));
    assert.equal(f.node("memory-editor-current").props.children.props.content, "Newest v3");
    assert.equal(f.node("memory-editor-input").props.value, "Local draft");
    assert.equal(f.node("memory-editor-save").props.disabled, true);
    await f.press("memory-editor-save");
    assert.equal(f.calls.length, 1, "409 cannot submit again with the old baseline");

    await f.press("memory-editor-reload");
    assert.equal(f.node("memory-editor-input").props.value, "Local draft");
    f.session.api.updateMemory = async (...args: unknown[]) => {
      f.calls.push(args);
      return f.records[scope];
    };
    await f.press("memory-editor-save");
    assert.deepEqual(f.calls[1], [scope, globalThis.__memoryParams.id, "Local draft", "v3"]);
  } finally { await f.close(); }
});

test("detail route creates a scoped index link and guards unsaved draft when its document changes", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", create: "1" };
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    await act(async () => {
      f.node("memory-detail-slug").props.onChangeText("topic");
      f.node("memory-detail-input").props.onChangeText("😀 detail");
    });
    assert.equal(f.node("memory-detail-count").props.children, "11 / 65536 字节");
    f.records.work = snapshot("work", "Remote work", "v2");
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.node("memory-detail-input").props.value, "😀 detail");
    assert.ok(f.node("memory-detail-conflict"));
    await f.press("memory-detail-reload");
    await f.press("memory-detail-save");
    assert.deepEqual(f.calls.at(-1), ["work", "helper", "topic", "😀 detail", "v2",
      "Remote work\n- [topic](/.wandrun/memory/work/details/topic.md)\n"]);
  } finally { await f.close(); }
});

test("detail editor compares remote body, keeps draft after deletion and refuses a deleted baseline", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
  const ref = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  f.records.work = { ...snapshot("work", `- [topic](${ref.path})`, "v1"), details: { topic: ref } };
  f.session.api.getMemoryDetail = async () => ({
    scope: "work", agent_id: "helper", slug: "topic", content: f.records.work.version === "v1" ? "First" : "Remote body",
    version: f.records.work.version, path: ref.path, sha256: ref.sha256, limit: 65536,
  });
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    await f.press("memory-detail-edit");
    await act(async () => f.node("memory-detail-input").props.onChangeText("My unsaved body"));
    f.records.work = { ...f.records.work, version: "v2" };
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.node("memory-detail-input").props.value, "My unsaved body");
    assert.equal(f.node("memory-detail-current").props.children.props.children, "Remote body");
    assert.equal(f.node("memory-detail-save").props.disabled, true);
    f.records.work = { ...snapshot("work", "", "v3") };
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.node("memory-detail-current").props.children, "最新详情已删除");
    await f.press("memory-detail-reload");
    assert.equal(f.node("memory-detail-input").props.value, "My unsaved body");
    assert.equal(f.node("memory-detail-save").props.disabled, true);
  } finally { await f.close(); }
});

test("read-only detail adopts refreshed body before editing or saving against the new document", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
  const ref = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  f.records.work = { ...snapshot("work", `[topic](${ref.path})`, "v1"), details: { topic: ref } };
  f.session.api.getMemoryDetail = async () => ({
    scope: "work", agent_id: "helper", slug: "topic", content: f.records.work.version === "v1" ? "A" : "B",
    version: f.records.work.version, path: ref.path, sha256: ref.sha256, limit: 65536,
  });
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    const bar = f.root.container.queryAll((node) => node.type === "ScreenBar")[0];
    assert.equal(bar.props.title, "topic");
    assert.equal(bar.props.subtitle, "Planner 的工作记忆");
    assert.equal(f.node("memory-detail-count"), undefined);
    assert.equal(f.root.container.queryAll((node) => node.type === "AgentMemoryMarkdown")[0].props.content, "A");
    f.records.work = { ...f.records.work, version: "v2" };
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.root.container.queryAll((node) => node.type === "AgentMemoryMarkdown")[0].props.content, "B");
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "memory-detail-conflict").length, 0);
    await f.press("memory-detail-edit");
    assert.equal(f.node("memory-detail-input").props.value, "B");
    await f.press("memory-detail-save");
    assert.deepEqual(f.calls.at(-1), ["work", "helper", "topic", "B", "v2", undefined]);
  } finally { await f.close(); }
});

test("detail links cannot navigate during deletion, even from the pre-render Markdown callback", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
  const topic = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  const next = { path: "/.wandrun/memory/work/details/next/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  f.records.work = { ...snapshot("work", `[topic](${topic.path})\n[next](${next.path})\n`, "v1"), details: { topic, next } };
  f.session.api.getMemoryDetail = async () => ({
    scope: "work", agent_id: "helper", slug: "topic", content: `[next](${next.path})`, version: "v1",
    ...topic, limit: 65536,
  });
  const pending = Promise.withResolvers<AgentMemory>();
  f.session.api.deleteMemoryDetail = async (...args: unknown[]) => {
    f.calls.push(args);
    return pending.promise;
  };
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    const staleOpen = f.root.container.queryAll((node) => node.type === "AgentMemoryMarkdown")[0]
      .props.managedMemory.onOpen as (slug: string) => void;
    await f.press("memory-detail-delete");
    await f.press("memory-detail-delete-confirm");
    await act(async () => {
      globalThis.__memoryAlert[2][1].onPress?.();
      staleOpen("next"); // Before React commits the busy render.
    });
    assert.deepEqual(f.calls, [["work", "helper", "topic", `[next](${next.path})\n`, "v1"]]);
    assert.deepEqual(globalThis.__memoryNav, []);
    assert.equal(f.node("memory-detail-delete-confirm").props.disabled, true);
    await act(async () => f.root.container.queryAll((node) => node.type === "AgentMemoryMarkdown")[0]
      .props.managedMemory.onOpen("next"));
    assert.deepEqual(globalThis.__memoryNav, [], "the current callback also cannot open another detail");

    // The successful DELETE can publish its own revision before its response resolves.
    f.records.work = { ...snapshot("work", `[next](${next.path})\n`, "v2"), details: { next } };
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    await act(async () => pending.resolve(f.records.work));
    assert.deepEqual(globalThis.__memoryNav, ["back"], "successful deletion still closes its own detail");
  } finally { await f.close(); }
});

test("failed detail deletion preserves the reviewed draft and back confirmation", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
  const path = "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md";
  f.records.work = { ...snapshot("work", `[topic](${path})\n`), details: { topic: { path, sha256: "a".repeat(64) } } };
  const pending = Promise.withResolvers<AgentMemory>();
  f.session.api.deleteMemoryDetail = async () => pending.promise;
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    await f.press("memory-detail-delete");
    await f.press("memory-detail-delete-confirm");
    const deleteAlert = globalThis.__memoryAlert;
    await act(async () => globalThis.__memoryAlert[2][1].onPress?.());
    await act(async () => pending.reject(new GatewayError(503, "unavailable", "unavailable")));
    assert.ok(f.node("memory-detail-error"));
    assert.deepEqual(globalThis.__memoryNav, [], "failure must not close the detail");
    await f.press("memory-detail-back");
    assert.notEqual(globalThis.__memoryAlert, deleteAlert, "back opens a new draft confirmation");
    assert.deepEqual(globalThis.__memoryNav, [], "the deletion draft still needs confirmation");
    await act(async () => globalThis.__memoryAlert[2][1].onPress?.());
    assert.deepEqual(globalThis.__memoryNav, ["back"]);
  } finally { await f.close(); }
});

test("deleting titled and reference-style links edits the index in the real detail route", async () => {
  for (const index of [
    (path: string) => `Before [topic](${path} "title") after\n`,
    (path: string) => `Before [topic][id] after\n\n[id]: ${path} "title"\n`,
  ]) {
    const f = fixture();
    globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
    const ref = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
    f.records.work = { ...snapshot("work", index(ref.path)), details: { topic: ref } };
    try {
      await act(async () => f.root.render(createElement(MemoryDetail)));
      await f.press("memory-detail-delete");
      assert.ok(f.node("memory-detail-delete-index").props.value.includes(ref.path));
      await f.press("memory-detail-delete-confirm");
      assert.equal(f.calls.length, 0, "a canonical path still in the index cannot be submitted");
      await act(async () => f.node("memory-detail-delete-index").props.onChangeText("Before topic after\n"));
      await f.press("memory-detail-delete-confirm");
      await act(async () => globalThis.__memoryAlert[2][1].onPress?.());
      assert.deepEqual(f.calls.at(-1), ["work", "helper", "topic", "Before topic after\n", "v1"]);
    } finally { await f.close(); }
  }
});

test("deletion index edits survive a remote observation and explicit reload for review", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "profile", scope: "profile", slug: "topic" };
  const path = "/.wandrun/memory/profile/details/topic/" + "a".repeat(64) + ".md";
  const ref = { path, sha256: "a".repeat(64) };
  f.records.profile = { ...snapshot("profile", `[topic][id]\n\n[id]: ${path} "title"\n`), details: { topic: ref } };
  f.session.api.getMemoryDetail = async () => ({
    scope: "profile", slug: "topic", content: "Body", version: f.records.profile.version,
    path, sha256: ref.sha256, limit: 65536,
  });
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    await f.press("memory-detail-delete");
    await act(async () => f.node("memory-detail-delete-index").props.onChangeText("Local index revision\n"));
    f.records.profile = { ...f.records.profile, content: `Remote fact\n[topic][id]\n\n[id]: ${path} "title"\n`, version: "v2" };
    f.revisions.profile++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.node("memory-detail-delete-index").props.value, "Local index revision\n");
    assert.equal(f.node("memory-detail-current-index").props.children, f.records.profile.content);
    await f.press("memory-detail-reload");
    assert.equal(f.node("memory-detail-delete-index").props.value, "Local index revision\n");
    assert.equal(f.node("memory-detail-base-index").props.children, f.records.profile.content);
    await f.press("memory-detail-delete-confirm");
    await act(async () => globalThis.__memoryAlert[2][1].onPress?.());
    assert.deepEqual(f.calls.at(-1), ["profile", "profile", "topic", "Local index revision\n", "v2"]);
  } finally { await f.close(); }
});

for (const mode of ["save", "delete"] as const) test(`${mode} conflict follow-up cannot replace a newer SSE detail`, async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
  const ref = (hash: string) => ({ path: "/.wandrun/memory/work/details/topic/" + hash.repeat(64) + ".md", sha256: hash.repeat(64) });
  const version = (v: string, hash: string) => ({
    ...snapshot("work", `[topic](${ref(hash).path})`, v), details: { topic: ref(hash) },
  });
  const v1 = version("v1", "a"), v2 = version("v2", "b"), v3 = version("v3", "c");
  f.records.work = v1;
  const late = Promise.withResolvers<{
    scope: "work"; agent_id: string; slug: string; content: string; version: string; path: string; sha256: string; limit: number;
  }>();
  f.session.api.getMemoryDetail = async () => f.records.work.version === "v2" ? late.promise : ({
    scope: "work", agent_id: "helper", slug: "topic", content: f.records.work.version === "v1" ? "First" : "Third",
    version: f.records.work.version, ...ref(f.records.work.version === "v1" ? "a" : "c"), limit: 65536,
  });
  const conflict = async () => { throw new GatewayError(409, "conflict", "changed", { current: v2 }); };
  f.session.api.updateMemoryDetail = conflict;
  f.session.api.deleteMemoryDetail = conflict;
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    if (mode === "save") {
      await f.press("memory-detail-edit");
      await act(async () => f.node("memory-detail-input").props.onChangeText("Local draft"));
    } else {
      await f.press("memory-detail-delete");
    }
    f.records.work = v2;
    if (mode === "save") await f.press("memory-detail-save");
    else {
      await f.press("memory-detail-delete-confirm");
      await act(async () => globalThis.__memoryAlert[2][1].onPress?.());
    }
    assert.ok(f.node("memory-detail-conflict"), "409 produced a real conflict");
    f.records.work = v3;
    f.revisions.work++;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.node("memory-detail-current").props.children.props.children, "Third");
    await act(async () => late.resolve({
      scope: "work", agent_id: "helper", slug: "topic", content: "Second", version: "v2",
      ...ref("b"), limit: 65536,
    }));
    assert.equal(f.node("memory-detail-current").props.children.props.children, "Third");
    if (mode === "save") assert.equal(f.node("memory-detail-save").props.disabled, true);
    if (mode === "save") assert.equal(f.node("memory-detail-input").props.value, "Local draft");
    else assert.equal(f.node("memory-detail-delete-index").props.value, "");
  } finally { await f.close(); }
});

test("focus return and disconnect invalidate older detail observations without discarding edits", async () => {
  const f = fixture();
  globalThis.__memoryParams = { id: "helper", scope: "work", slug: "topic" };
  const ref = { path: "/.wandrun/memory/work/details/topic/" + "a".repeat(64) + ".md", sha256: "a".repeat(64) };
  f.records.work = { ...snapshot("work", `[topic](${ref.path})`, "v1"), details: { topic: ref } };
  const pending = Promise.withResolvers<AgentMemory>();
  let delay = false;
  f.session.api.getMemory = async () => delay ? pending.promise : f.records.work;
  f.session.api.getMemoryDetail = async () => ({
    scope: "work", agent_id: "helper", slug: "topic", content: f.records.work.version,
    version: f.records.work.version, ...ref, limit: 65536,
  });
  try {
    await act(async () => f.root.render(createElement(MemoryDetail)));
    await f.press("memory-detail-edit");
    await act(async () => f.node("memory-detail-input").props.onChangeText("Local draft"));
    globalThis.__memoryFocused = false;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    f.records.work = { ...f.records.work, version: "v2" };
    f.revisions.work++;
    delay = true;
    globalThis.__memoryFocused = true;
    await act(async () => f.root.render(createElement(MemoryDetail)));
    f.session.memoryConnectionRevision++;
    delay = false;
    f.records.work = { ...f.records.work, version: "v3" };
    await act(async () => f.root.render(createElement(MemoryDetail)));
    assert.equal(f.node("memory-detail-current").props.children.props.children, "v3");
    await act(async () => pending.resolve({ ...f.records.work, version: "v2" }));
    assert.equal(f.node("memory-detail-current").props.children.props.children, "v3");
    assert.equal(f.node("memory-detail-input").props.value, "Local draft");
    assert.equal(f.node("memory-detail-save").props.disabled, true);
  } finally { await f.close(); globalThis.__memoryFocused = true; }
});
