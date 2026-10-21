import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import type { SavedComputer } from "../src/lib/credentials.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const nativeImports: Record<string, string> = {
  "expo-constants": "export default {expoConfig:{version:'1.0'}};",
  "expo-router": `import {useEffect} from ${JSON.stringify(import.meta.resolve("react"))};
    export const Stack={Screen:'Screen'};
    export const useFocusEffect=(callback)=>useEffect(callback,[callback]);
    export const router={push:(path)=>globalThis.__navigation.push(path), replace:(path)=>globalThis.__navigation.replace(path), canGoBack:()=>true, back:()=>globalThis.__navigation.back()};`,
  "lucide-react-native": "export const Check='Check',ChevronLeft='ChevronLeft',ChevronRight='ChevronRight',Monitor='Monitor',Pencil='Pencil',Plus='Plus';",
  "react-native": "export const View='View',ScrollView='ScrollView'; export const Modal=({visible,children})=>visible?children:null;",
  "react-native-keyboard-controller": "export const KeyboardAvoidingView='KeyboardAvoidingView';",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({top:0,bottom:0});",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/list-row.tsx": "export const ListRow='ListRow',RowSubtitle='RowSubtitle';",
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/input.tsx": "export const Input='Input';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/lib/session-context.tsx": "export const useGateway=()=>globalThis.__gateway, useSession=()=>globalThis.__session;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeImports) return { url: `data:text/javascript,${encodeURIComponent(nativeImports[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      }).outputText };
    }
    return nextLoad(url, context);
  },
});

// The component must load after native/Expo stubs are registered; static import resolves too early.
const { default: GatewayConnection } = await import("../src/app/gateway-connection.tsx");

test("computer selection edits the chosen entry, switches only on request, and removes only the chosen entry", async () => {
  const local = { computerId: "local", connectionId: "local-1", baseUrl: "http://local", token: "dev", computerName: "Local", pairingMethod: "development" } as SavedComputer;
  const remote = { computerId: "remote", connectionId: "remote-1", baseUrl: "https://remote", token: "paired", computerName: "Remote", pairingMethod: "manual" } as SavedComputer;
  const navigation: string[] = [];
  const operations: string[] = [];
  const fixture = {
    computers: [local, remote] as SavedComputer[], config: local as SavedComputer | null,
    async switchComputer(id: string) { operations.push(`switch:${id}`); fixture.config = fixture.computers.find((item) => item.computerId === id)!; },
    async renameComputer(id: string, name: string) { operations.push(`rename:${id}:${name}`); fixture.computers = fixture.computers.map((item) => item.computerId === id ? { ...item, localName: name } : item); },
    async disconnect(id: string) { operations.push(`disconnect:${id}`); fixture.computers = fixture.computers.filter((item) => item.computerId !== id); fixture.config = fixture.computers[0] ?? null; },
  };
  Object.assign(globalThis, {
    __gateway: fixture, __session: null,
    __navigation: { push: (path: string) => navigation.push(`push:${path}`), replace: (path: string) => navigation.push(`replace:${path}`), back: () => navigation.push("back") },
  });
  const root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => {
    const found = root.container.queryAll((node) => node.props.testID === id);
    assert.equal(found.length, 1, `${id} should be visible once`);
    return found[0];
  };
  try {
    await act(async () => root.render(createElement(GatewayConnection)));
    assert.equal(byId("connection-computer-local").props.meta, "当前");
    assert.equal(byId("connection-computer-remote").props.meta, undefined);
    await act(async () => byId("connection-computer-remote").props.onPress());
    assert.equal(byId("connection-address").props.children, "https://remote");
    assert.deepEqual(operations, [], "selection does not open an inactive connection");

    await act(async () => byId("connection-rename").props.onPress());
    await act(async () => byId("connection-local-name").props.onChangeText("Remote lab"));
    await act(async () => { byId("connection-rename-confirm").props.onPress(); await Promise.resolve(); });
    await act(async () => root.render(createElement(GatewayConnection)));
    assert.deepEqual(operations, ["rename:remote:Remote lab"]);
    assert.equal(byId("connection-computer-remote").props.title, "Remote lab");
    assert.deepEqual(navigation, [], "metadata edit must not navigate/reconnect");

    await act(async () => { byId("connection-switch").props.onPress(); await Promise.resolve(); });
    assert.deepEqual(operations, ["rename:remote:Remote lab", "switch:remote"]);
    await act(async () => root.render(createElement(GatewayConnection)));
    assert.equal(byId("connection-computer-remote").props.meta, "当前");
    assert.equal(byId("connection-computer-local").props.meta, undefined);

    await act(async () => byId("connection-disconnect").props.onPress());
    await act(async () => { byId("connection-disconnect-confirm").props.onPress(); await Promise.resolve(); });
    await act(async () => root.render(createElement(GatewayConnection)));
    assert.deepEqual(operations, ["rename:remote:Remote lab", "switch:remote", "disconnect:remote"]);
    assert.equal(root.container.queryAll((node) => node.props.testID === "connection-computer-remote").length, 0);
    assert.equal(byId("connection-computer-local").props.meta, "当前");
  } finally {
    await act(async () => root.unmount());
  }
});

test("an invalid saved computer remains selectable and exposes re-pair at its trusted address", async () => {
  const computer = { computerId: "remote", connectionId: "remote-1", baseUrl: "https://remote", token: "old",
    computerName: "Remote", pairingMethod: "manual", authStatus: "invalid" } as SavedComputer;
  const navigation: unknown[] = [];
  Object.assign(globalThis, {
    __gateway: { computers: [computer], config: computer, switchComputer: async () => {}, renameComputer: async () => {}, disconnect: async () => {} },
    __session: null,
    __navigation: { push: (path: unknown) => navigation.push(path), replace: () => {}, back: () => {} },
  });
  const root = createRoot({ textComponentTypes: ["Text"] });
  try {
    await act(async () => root.render(createElement(GatewayConnection)));
    const byId = (id: string) => root.container.queryAll((node) => node.props.testID === id)[0];
    assert.equal(byId("connection-computer-remote").props.meta, "需要重新配对");
    assert.equal(byId("connection-auth-status").props.children, "需要重新配对");
    await act(async () => byId("connection-repair").props.onPress());
    assert.deepEqual(navigation, [{ pathname: "/connect", params: { address: "https://remote", repair: "remote-1" } }]);
    assert.equal(byId("connection-computer-remote").props.title, "Remote");
  } finally {
    await act(async () => root.unmount());
  }
});
