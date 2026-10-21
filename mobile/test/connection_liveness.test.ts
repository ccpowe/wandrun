import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ChatSession } from "../src/gateway/session.ts";
import { setNetworkDiagnosticSink } from "../src/gateway/network-diagnostics.ts";
import type * as ConnectionLiveness from "../src/lib/connection-liveness.ts";

declare global {
  var __livenessBridge: { platform: { OS: string }; lookups: number };
}
globalThis.__livenessBridge = { platform: { OS: "android" }, lookups: 0 };
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = specifier === "react-native"
      ? "export const Platform=globalThis.__livenessBridge.platform;"
      : specifier === "expo"
        ? "export function requireOptionalNativeModule(){globalThis.__livenessBridge.lookups++;return null;}" : null;
    return source === null ? nextResolve(specifier, context)
      : { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

for (const platform of ["android", "ios", "web"]) {
  test(`${platform} without native transport still recovers durable events via JS`, async (t) => {
    globalThis.__livenessBridge.platform.OS = platform;
    globalThis.__livenessBridge.lookups = 0;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const moduleUrl = new URL(`../src/lib/connection-liveness.ts?platform=${platform}`, import.meta.url);
    // Re-evaluate the optional native lookup for each platform; a static import caches it.
    const bridge: typeof ConnectionLiveness = await import(moduleUrl.href);
    assert.equal(globalThis.__livenessBridge.lookups, platform === "android" ? 1 : 0);
    assert.equal(bridge.resetConnections, undefined);
    setNetworkDiagnosticSink(() => {});
    let attempts = 0;
    const session = new ChatSession({ baseUrl: "http://fallback.test", token: "private" }, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/conversations") return Response.json({ conversations: [], as_of_seq: 0 });
      if (path === "/agents") return Response.json({ agents: [], as_of_seq: 0 });
      if (path === "/browser-tasks") return Response.json({ browser_tasks: [], as_of_seq: 0 });
      assert.equal(path, "/events");
      attempts++;
      return new Response(new ReadableStream({ start(controller) {
        if (attempts > 1) controller.enqueue(new TextEncoder().encode(
          'event: conversation.updated\ndata: {"seq":1,"type":"conversation.updated","conversation_id":"c","data":{"title":"recovered"}}\n\n',
        ));
      } }));
    }, {}, undefined, bridge.resetConnections);
    t.after(async () => { await session.close(); setNetworkDiagnosticSink(undefined); });
    await session.start();
    await setImmediate();
    assert.equal(session.lastSeq, 0);
    session.resume("foreground", bridge.backgroundRecoveryMs);
    for (let i = 0; i < 6; i++) {
      t.mock.timers.tick(0);
      await setImmediate();
    }
    assert.equal(attempts, 2);
    assert.equal(session.lastSeq, 1);
  });
}
