import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";
import { ChatSession } from "../src/gateway/session.ts";
import type { FileDetail, GatewayEvent } from "../src/gateway/api.ts";

const react = JSON.stringify(import.meta.resolve("react"));
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
  var __fileSession: ChatSession;
  var __fileDownload: (url: string) => Promise<void>;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Real file screen, message row and API; replace only native hosts and unrelated content renderers.
const hosts: Record<string, string> = {
  "expo-router": `import {useEffect} from ${react}; export const Stack={Screen:'Screen'},router={push(){},back(){}};
    export const useLocalSearchParams=()=>({id:'remote'}),useIsFocused=()=>true,useFocusEffect=(callback)=>useEffect(callback,[callback]);`,
  "react-native": `export const View='View',Text='Text',Pressable='Pressable',ScrollView='ScrollView',Image='Image',ActivityIndicator='ActivityIndicator';
    export const Platform={OS:'android'},Alert={alert(){}},useWindowDimensions=()=>({width:400,height:800});`,
  "expo-file-system": `export class Directory { constructor(...parts){this.uri=parts.join('/')} create(){} list(){return []} }
    export class File { constructor(...parts){this.uri=parts.map(p=>p.uri??p).join('/');this.exists=false;} delete(){} text(){return Promise.resolve('')} 
      static createDownloadTask(url){return {async downloadAsync(){await globalThis.__fileDownload(url);return true}}} }
    export const Paths={cache:'cache'};`,
  "expo-sharing": "export const isAvailableAsync=async()=>true,shareAsync=async()=>{};",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({top:0,bottom:0});",
  "lucide-react-native": "export const ArrowLeft='Icon',Download='Icon',Share2='Icon',Brain='Icon',Check='Icon',ChevronRight='Icon',CircleAlert='Icon',Clock='Icon',Hand='Icon',RefreshCw='Icon',Square='Icon';",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__fileSession;",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/dialog.tsx": "export const Dialog='Dialog',DialogContent='DialogContent',DialogTitle='DialogTitle',DialogTrigger='DialogTrigger';",
  "@/components/file-type-icon.tsx": "export const FileTypeIcon='FileTypeIcon';",
  "@/components/agent-memory-markdown.tsx": "export const AgentMemoryMarkdown='Markdown';",
  "@/components/chat/agent-message-content.tsx": "export const AgentMessageContent='AgentContent';",
  "@/components/chat/draft-message-content.tsx": "export const DraftMessageContent='DraftContent';",
  "@/components/chat/browser-card.tsx": "export const BrowserCard='BrowserCard';",
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
// Static imports would load native modules before registerHooks installs their hosts.
const { default: FileScreen } = await import("../src/app/files/[id].tsx");
const { MessageRow } = await import("../src/components/chat/message-row.tsx");
const remote: FileDetail = { id: "remote", name: "remote.txt", size: 20, media_type: "text/plain", conversation_id: null,
  agent_id: null, task_id: "child", created_at: 1, remote_environment: "ssh-lab", available: false,
  error: "remote_file_unsupported", error_message: "文件在远端环境 ssh-lab，暂不支持下载" };
function fixture(initial: FileDetail) {
  let detail = initial;
  let contentRequests = 0;
  const session = new ChatSession({ baseUrl: "http://remote-file-test", token: "test", computerId: "remote-test" }, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/files/remote") return new Response(JSON.stringify(detail));
    return new Response("{}");
  });
  session.agents.close();
  globalThis.__fileSession = session;
  globalThis.__fileDownload = async () => {
    contentRequests++;
    detail = remote;
    throw new Error("Native download failed: HTTP 409 remote_file_unsupported");
  };
  const root = createRoot({ textComponentTypes: ["Text"] });
  const node = (id: string) => root.container.queryAll((entry) => entry.props.testID === id)[0];
  const texts = () => root.container.queryAll((entry) => entry.type === "Text").map((entry) => entry.props.children);
  return { session, root, node, texts, contentRequests: () => contentRequests,
    async close() { await act(async () => root.unmount()); await session.close(); } };
}

test("remote metadata shows the server reason and disables file operations without requesting content", async () => {
  const f = fixture(remote);
  try {
    await act(async () => f.root.render(createElement(FileScreen)));
    assert.ok(f.node("file-unavailable"));
    assert.ok(f.texts().includes(remote.error_message));
    assert.equal(f.node("file-download").props.disabled, true);
    assert.equal(f.node("file-share").props.disabled, true);
    assert.equal(f.contentRequests(), 0);
  } finally { await f.close(); }
});

test("native content 409 refreshes authoritative metadata instead of diagnosing a moved or deleted file", async () => {
  const f = fixture({ ...remote, available: true, error: null, error_message: null });
  try {
    await act(async () => f.root.render(createElement(FileScreen)));
    assert.equal(f.contentRequests(), 1);
    assert.ok(f.node("file-unavailable"));
    assert.ok(f.texts().includes(remote.error_message));
    assert.equal(f.node("file-download").props.disabled, true);
    assert.ok(!f.texts().some((text) => typeof text === "string" && text.includes("Native download")));
  } finally { await f.close(); }
});

test("member attachment cards show server-provided remote refusal without requesting content", async () => {
  const f = fixture(remote);
  try {
    const event: GatewayEvent = { seq: 3, type: "message.task", conversation_id: "root", at: 1,
      data: { task_id: "child", sender_agent_id: "member", recipient_agent_id: "parent", sender_task_id: "child",
        recipient_task_id: "root", text: "Result", attachments: [remote] } };
    await act(async () => f.root.render(createElement(MessageRow, { item: { key: "e3", event }, session: f.session, timelineId: "root" })));
    assert.ok(f.node("attachment-remote"));
    assert.equal(f.node("attachment-unavailable-remote").props.children, remote.error_message);
    assert.equal(f.contentRequests(), 0);
  } finally { await f.close(); }
});
