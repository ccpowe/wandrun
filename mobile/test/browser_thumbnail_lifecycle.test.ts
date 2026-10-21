import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";
import { GatewayApi, type BrowserTask } from "../src/gateway/api.ts";

const leases: { computerId: string; signal: AbortSignal; resolve(value: { uri: string; dispose(): void }): void }[] = [];
const fixture = { session: { api: new GatewayApi({ baseUrl: "http://same", token: "a", computerId: "a" }), connection: "open" } };
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __thumbnailFixture: fixture,
  __thumbnailLoad: (api: GatewayApi, _path: string, signal: AbortSignal) => {
    const { promise, resolve } = Promise.withResolvers<{ uri: string; dispose(): void }>();
    leases.push({ computerId: api.config.computerId!, signal, resolve });
    return promise;
  },
});
const hosts: Record<string, string> = {
  "expo-image": "export const Image='Image';",
  "expo-router": "export const useIsFocused=()=>true;",
  "lucide-react-native": "export const Monitor='Monitor';",
  "react-native": "export const View='View'; export const AppState={currentState:'active',addEventListener:()=>({remove(){}})};",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/lib/local-image.ts": "export const loadLocalImage=(...args)=>globalThis.__thumbnailLoad(...args);",
  "@/lib/session-context.tsx": "export const useSession=()=>globalThis.__thumbnailFixture.session;",
  "@/lib/utils.ts": "export const cn=(...args)=>args.filter(Boolean).join(' ');",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: {
        module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
      } }).outputText };
    return nextLoad(url, context);
  },
});
// Native host hooks must be installed before the component's module dependencies resolve.
const { BrowserThumbnail } = await import("../src/components/browser-thumbnail.tsx");

test("hidden thumbnails render a waiting state; switching computers cannot display a late old thumbnail", async () => {
  const task = { id: "same", state: "agent", current: "page", pages: [{ id: "page" }] } as BrowserTask;
  const root = createRoot({ textComponentTypes: ["Text"] });
  let oldDisposed = 0;
  let currentDisposed = 0;
  try {
    await act(async () => root.render(createElement(BrowserThumbnail, { task, active: false })));
    assert.equal(leases.length, 0);
    assert.equal(root.container.queryAll((node) => node.type === "Image").length, 0);
    assert.equal(root.container.queryAll((node) => node.type === "Text")[0].props.children, "等待浏览器画面");
    await act(async () => root.render(createElement(BrowserThumbnail, { task, active: true })));
    assert.equal(leases[0].computerId, "a");
    const oldApi = fixture.session.api;
    oldApi.close();
    fixture.session = { api: new GatewayApi({ baseUrl: "http://same", token: "b", computerId: "b" }), connection: "open" };
    await act(async () => root.render(createElement(BrowserThumbnail, { task, active: true })));
    assert.equal(leases[0].signal.aborted, true);
    assert.equal(leases[1].computerId, "b");
    await act(async () => leases[0].resolve({ uri: "file://a/private", dispose: () => { oldDisposed++; } }));
    assert.equal(oldDisposed, 1);
    assert.equal(root.container.queryAll((node) => node.type === "Image").length, 0);
    await act(async () => leases[1].resolve({ uri: "file://b/current", dispose: () => { currentDisposed++; } }));
    assert.equal(root.container.queryAll((node) => node.type === "Image")[0].props.source.uri, "file://b/current");
  } finally {
    await act(async () => root.unmount());
    fixture.session.api.close();
  }
  assert.equal(currentDisposed, 1);
});
