import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { act } from "react";
import { jsx } from "react/jsx-runtime";
import { createRoot } from "test-renderer";
import ts from "typescript";
import type { ChatSession } from "../src/gateway/session.ts";
import type { ConnectionConfig } from "../src/lib/credentials.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
  var __recoveryNative: {
    app: { currentState: string; addEventListener: (name: string, callback: (state: string) => void) => { remove(): void } };
    network: (callback: (state: { type: string; isConnected: boolean; isInternetReachable: boolean }) => void) => { remove(): void };
    transport: { pingIntervalMs: number; resetConnections(): void; logDiagnostic(message: string): void };
  };
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const platform: Record<string, string> = {
  "react-native": "export const View='View'; export const AppState=globalThis.__recoveryNative.app; export const Platform={OS:'android'};",
  "expo-network": "export const NetworkStateType={NONE:'NONE'}; export const addNetworkStateListener=globalThis.__recoveryNative.network;",
  "expo": "export const requireOptionalNativeModule=()=>globalThis.__recoveryNative.transport;",
  "expo-secure-store": "export async function getItemAsync(){return null} export async function setItemAsync(){} export async function deleteItemAsync(){}",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/lib/upload-drafts.ts": "export const discardConversationDraft=()=>{},pruneConversationDrafts=()=>{},suspendComputerUploads=async()=>{};",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in platform) return { url: `data:text/javascript,${encodeURIComponent(platform[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return { url: new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(
      readFileSync(fileURLToPath(url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } },
    ).outputText };
    return nextLoad(url, context);
  },
});

test("short inactive period is untouched; long background resets before recovery; network hints coalesce and detach", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  let active: ((state: string) => void) | null = null;
  let network: ((state: { type: string; isConnected: boolean; isInternetReachable: boolean }) => void) | null = null;
  const transportOrder: string[] = [];
  const diagnostics: { event: string; source?: string; backgroundMs?: number }[] = [];
  globalThis.__recoveryNative = {
    app: { currentState: "active", addEventListener(_name, callback) {
      active = (state) => { globalThis.__recoveryNative.app.currentState = state; callback(state); };
      return { remove() { active = null; } };
    } },
    network(callback) { network = callback; return { remove() { network = null; } }; },
    transport: {
      pingIntervalMs: 15_000,
      resetConnections() { transportOrder.push("reset"); },
      logDiagnostic(message) { diagnostics.push(JSON.parse(message)); },
    },
  };
  const streams: { signal: AbortSignal; cursor: number }[] = [];
  let title = "initial";
  let seq = 0;
  let sendHeartbeat = true;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/conversations") return Response.json({ conversations: [{
      id: "c", agent_id: "main", title, created_at: 1, updated_at: 1, status: "idle", read_seq: 0, last_agent_seq: 0,
      unread: false, last_text: null, source: "user", schedule_origin: null,
    }], as_of_seq: seq });
    if (path === "/agents") return Response.json({ agents: [], as_of_seq: seq });
    if (path === "/browser-tasks") return Response.json({ browser_tasks: [], as_of_seq: seq });
    assert.equal(path, "/events");
    const cursor = Number(new Headers(init?.headers).get("Last-Event-ID"));
    transportOrder.push("stream");
    streams.push({ signal: init!.signal!, cursor });
    return new Response(new ReadableStream({ start(controller) {
      if (sendHeartbeat) controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      if (seq > cursor) controller.enqueue(new TextEncoder().encode(`event: conversation.updated\ndata: ${JSON.stringify({
        seq, type: "conversation.updated", conversation_id: "c", at: seq, data: { title },
      })}\n\n`));
    } }));
  });
  // Native module hooks must be installed before importing the real provider.
  const { SessionProvider, useGateway } = await import("../src/lib/session-context.tsx");
  let gateway!: { session: ChatSession | null; configure(config: ConnectionConfig): Promise<void> };
  function Probe() { gateway = useGateway(); return null; }
  const root = createRoot();
  const flush = async () => {
    for (let i = 0; i < 6; i++) await act(async () => { t.mock.timers.tick(0); await setImmediate(); });
  };
  try {
    await act(async () => root.render(jsx(SessionProvider, { children: React.createElement(Probe) })));
    await flush();
    await act(async () => gateway.configure({ baseUrl: "http://local.test", token: "test", pairingMethod: "development" }));
    await flush();
    const session = gateway.session!;
    assert.equal(session.conversations.get("c")?.title, "initial");
    network!({ type: "WIFI", isConnected: true, isInternetReachable: true });
    network!({ type: "WIFI", isConnected: true, isInternetReachable: true });
    network!({ type: "WIFI", isConnected: true, isInternetReachable: false });
    assert.deepEqual(transportOrder, ["stream"], "the first event establishes the baseline and reachability-only changes are ignored");
    await act(async () => {
      active!("inactive");
      t.mock.timers.tick(14_999);
      active!("active");
      network!({ type: "WIFI", isConnected: true, isInternetReachable: true });
      t.mock.timers.tick(5000);
    });
    await flush();
    assert.deepEqual(transportOrder, ["stream"], "short background neither resets TCP nor replaces SSE");
    await act(async () => {
      active!("background");
      network!({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
      t.mock.timers.tick(5000);
      active!("active");
      network!({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
      t.mock.timers.tick(5000);
    });
    await flush();
    assert.deepEqual(transportOrder, ["stream"], "background route changes are not replayed on a short return");
    sendHeartbeat = false; // A same-state foreground notification must not queue a reset even before bytes arrive.
    await act(async () => {
      active!("background");
      t.mock.timers.tick(10_000);
      active!("background"); // Duplicate background events must not move the start time.
      network!({ type: "WIFI", isConnected: true, isInternetReachable: true });
      assert.deepEqual(transportOrder, ["stream"], "background network changes update the baseline without recovering while inactive");
      t.mock.timers.tick(5000);
      active!("active");
      network!({ type: "WIFI", isConnected: true, isInternetReachable: true });
    });
    await flush();
    assert.deepEqual(transportOrder, ["stream", "reset", "stream"]);
    assert.ok(diagnostics.some(log => log.event === "recovery_start" && log.source === "foreground" && log.backgroundMs === 15_000));
    assert.equal(diagnostics.some(log => log.event === "recovery_hint"), false);
    await act(async () => { t.mock.timers.tick(5000); });
    await flush();
    assert.deepEqual(transportOrder, ["stream", "reset", "stream"], "same-state wake notification cannot reset again at the five-second bound");
    sendHeartbeat = true;
    seq = 1; title = "changed while route was dead";
    await act(async () => network!({ type: "WIFI", isConnected: false, isInternetReachable: false }));
    await flush();
    assert.equal(session.conversations.get("c")?.title, "initial", "disconnected notification cannot recover data");
    await act(async () => {
      network!({ type: "WIFI", isConnected: true, isInternetReachable: false });
      active!("active");
      network!({ type: "WIFI", isConnected: true, isInternetReachable: true });
    });
    await flush();
    assert.equal(gateway.session, session, "recovery must preserve session-local state");
    assert.equal(session.conversations.get("c")?.title, title);
    assert.equal(session.lastSeq, 1);
    assert.deepEqual(session.timeline("c").events.map(event => event.seq), [1]);
    assert.equal(streams.filter(stream => !stream.signal.aborted).length, 1);
    assert.equal(streams.at(-1)?.cursor, 0);
    await act(async () => { t.mock.timers.tick(5000); await setImmediate(); });
    await flush();
    assert.equal(streams.length, 3, "one active/network burst creates only one replacement");
    assert.deepEqual(transportOrder, ["stream", "reset", "stream", "reset", "stream"]);
    assert.ok(diagnostics.some(log => log.event === "recovery_start" && log.source === "network"));
    assert.equal(diagnostics.filter(log => log.event === "recovery_start").length, 2);
    assert.equal(diagnostics.some(log => log.event === "recovery_hint"), false);
    seq = 2; title = "changed after switching network type";
    await act(async () => network!({ type: "CELLULAR", isConnected: true, isInternetReachable: true }));
    await flush();
    assert.equal(session.conversations.get("c")?.title, title);
    assert.equal(session.lastSeq, 2);
    assert.deepEqual(transportOrder, ["stream", "reset", "stream", "reset", "stream", "reset", "stream"]);
    await act(async () => {
      network!({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
      t.mock.timers.tick(5000);
      network!({ type: "CELLULAR", isConnected: true, isInternetReachable: true });
      t.mock.timers.tick(5000);
    });
    await flush();
    assert.equal(streams.length, 4, "same-state events stay ignored beyond the recovery cooldown");
  } finally {
    await act(async () => root.unmount());
    await flush();
  }
  assert.equal(active, null);
  assert.equal(network, null);
  assert.ok(streams.every(stream => stream.signal.aborted));
});
