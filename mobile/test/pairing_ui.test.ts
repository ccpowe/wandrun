import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement, Fragment } from "react";
import { createRoot } from "test-renderer";
import ts from "typescript";

import { Credentials } from "../src/lib/credentials.ts";
import type { ConnectionConfig } from "../src/lib/credentials.ts";
import { pairingCoordinator } from "../src/lib/pairing.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const nativeImports: Record<string, string> = {
  "expo-constants": "export default {expoConfig:{version:'1.0'}};",
  "expo-camera": "export const CameraView='CameraView'; export const useCameraPermissions=()=>[{granted:true},async()=>({granted:true})];",
  "expo-router": `import {useEffect} from ${JSON.stringify(import.meta.resolve("react"))};
    export const Stack={Screen:'Screen'};
    export const useIsFocused=()=>globalThis.__pairingFocused;
    export const useLocalSearchParams=()=>globalThis.__pairingParams;
    export const useFocusEffect=(callback)=>useEffect(()=>globalThis.__pairingFocused?callback():undefined,[callback,globalThis.__pairingFocused]);
    export const router={canGoBack:()=>true,back:()=>{},replace:()=>{},push:(route)=>globalThis.__pairingNavigate(route)};`,
  "lucide-react-native": "export const ScanLine='ScanLine',ChevronLeft='ChevronLeft',Check='Check',ChevronRight='ChevronRight',Monitor='Monitor',Pencil='Pencil',Plus='Plus';",
  "react-native": "export const Image='Image',Pressable='Pressable',View='View',ScrollView='ScrollView'; export const Modal=({visible,children})=>visible?children:null; export const Alert={alert:(...args)=>globalThis.__pairingAlerts.push(args)};",
  "react-native-keyboard-controller": "export const KeyboardAwareScrollView='KeyboardAwareScrollView',KeyboardAvoidingView='KeyboardAvoidingView';",
  "react-native-safe-area-context": "export const useSafeAreaInsets=()=>({top:0,bottom:0});",
  "@/components/list-group.tsx": "export const ListGroup='ListGroup';",
  "@/components/list-row.tsx": "export const ListRow='ListRow',RowSubtitle='RowSubtitle';",
  "@/components/screen-bar.tsx": `import {createElement,Fragment} from ${JSON.stringify(import.meta.resolve("react"))};
    export const ScreenBar=({left,right})=>createElement(Fragment,null,left,right);`,
  "@/components/ui/button.tsx": "export const Button='Button';",
  "@/components/ui/icon.tsx": "export const Icon='Icon';",
  "@/components/ui/input.tsx": "export const Input='Input';",
  "@/components/ui/text.tsx": "export const Text='Text';",
  "@/lib/session-context.tsx": "export const useGateway=()=>globalThis.__pairingGateway; export const useSession=()=>null;",
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in nativeImports) return { url: `data:text/javascript,${encodeURIComponent(nativeImports[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return nextResolve(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace('require("../../assets/empty-together.png")', '"landing-image"') };
    return nextLoad(url, context);
  },
});
// Native/Expo stubs must be registered before the screen module is evaluated.
const { default: Connect } = await import("../src/app/connect.tsx");
const { default: GatewayConnection } = await import("../src/app/gateway-connection.tsx");
let fixtureNumber = 0;
let qr: string;

async function fixture(t: TestContext, invalid = false) {
  // Unique computers isolate process-lifetime consumed records without a production reset API.
  const address = `computer-${++fixtureNumber}`;
  qr = `wandrun://pair?url=http%3A%2F%2F${address}&code=AB12CD34`;
  pairingCoordinator.clearError();
  const response = Promise.withResolvers<Response>();
  const writing = Promise.withResolvers<void>();
  let requests = 0;
  let saved: string | null = null;
  let holdWrite = false;
  let failWrite = false;
  const storage = {
    async getItemAsync() { return saved; },
    async setItemAsync(_key: string, value: string) {
      if (holdWrite) await writing.promise;
      if (failWrite) throw new Error("secure storage unavailable");
      saved = value;
    },
    async deleteItemAsync() { saved = null; },
  };
  const credentials = new Credentials(storage);
  if (invalid) {
    await credentials.install({ baseUrl: `http://${address}`, token: "old", deviceId: "old-device", pairingMethod: "manual" });
    await credentials.renameComputer(credentials.snapshot().config!.computerId, "工作电脑");
    await credentials.markInvalid(credentials.snapshot().config!);
  }
  t.mock.method(globalThis, "fetch", async () => {
    if (++requests === 1) return response.promise;
    return new Response(JSON.stringify({ error: { code: "pairing_used" } }), { status: 400 });
  });
  const alerts: string[][] = [];
  Object.assign(globalThis, { __pairingFocused: true, __pairingParams: {}, __pairingAlerts: alerts, __pairingGateway: {
    get config() { return credentials.snapshot().config; },
    get computers() { return credentials.snapshot().computers; },
    revoked: false, configure: (value: ConnectionConfig, repair?: string) => credentials.install(value, repair),
  } });
  let root = createRoot({ textComponentTypes: ["Text"] });
  const byId = (id: string) => {
    const nodes = root.container.queryAll((node) => node.props.testID === id);
    assert.equal(nodes.length, 1, id);
    return nodes[0];
  };
  Object.assign(globalThis, { __pairingNavigate: (route: string | { pathname: string; params: object }) => {
    const pathname = typeof route === "string" ? route : route.pathname;
    Object.assign(globalThis, { __pairingParams: typeof route === "string" ? {} : route.params });
    root.render(createElement(pathname === "/connect" ? Connect : GatewayConnection));
  } });
  await act(async () => root.render(createElement(Connect)));
  t.after(async () => {
    await act(async () => { writing.resolve(); response.resolve(new Response("{}")); });
    await act(async () => root.unmount());
  });
  return {
    get root() { return root; }, byId, credentials, alerts, requests: () => requests,
    async scan() {
      await act(async () => byId("pairing-scan").props.onPress());
      return root.container.queryAll((node) => node.type === "CameraView")[0].props.onBarcodeScanned as (event: { data: string }) => void;
    },
    async manual(inputAddress = address) {
      await act(async () => byId("pairing-manual").props.onPress());
      await act(async () => { byId("pairing-address").props.onChangeText(inputAddress); byId("pairing-code").props.onChangeText("ab12 cd34"); });
      return byId("pairing-submit").props.onPress as () => void;
    },
    async success() {
      await act(async () => response.resolve(new Response(JSON.stringify({ token: "device-secret", device_id: "d1", computer_name: "Computer", gateway_version: "1", paired_at: "2026-10-15T00:00:00Z" }))));
    },
    async failure() {
      await act(async () => response.resolve(new Response(JSON.stringify({ error: { code: "pairing_expired" } }), { status: 400 })));
    },
    async remount() {
      await act(async () => root.unmount());
      root = createRoot({ textComponentTypes: ["Text"] });
      await act(async () => root.render(createElement(Connect)));
    },
    async focus(value: boolean) {
      Object.assign(globalThis, { __pairingFocused: value });
      await act(async () => root.render(createElement(Connect)));
    },
    holdWrite() { holdWrite = true; },
    failWrite() { failWrite = true; },
    async releaseWrite() { await act(async () => writing.resolve()); },
    async restored() { const restored = new Credentials(storage); await restored.restore(); return restored.snapshot(); },
  };
}

test("two camera callbacks before busy renders exchange once and persist the first token", async (t) => {
  const f = await fixture(t);
  const scan = await f.scan();
  await act(async () => { scan({ data: qr }); scan({ data: qr }); });
  assert.equal(f.requests(), 1);
  await f.success();
  await act(async () => scan({ data: qr }));
  assert.equal(f.requests(), 1);
  assert.equal((await f.restored()).config?.token, "device-secret");
});

test("manual double-click exchanges once, including while the secure write is pending", async (t) => {
  const f = await fixture(t);
  f.holdWrite();
  const submit = await f.manual();
  await act(async () => { submit(); submit(); });
  await f.success();
  await act(async () => submit());
  assert.equal(f.requests(), 1);
  await f.releaseWrite();
  await act(async () => submit());
  assert.equal(f.requests(), 1, "a successfully consumed manual code cannot be exchanged again");
  assert.equal((await f.restored()).config?.token, "device-secret");
});

test("cancel and explicit rescan cannot start a second exchange while the first success is pending", async (t) => {
  const f = await fixture(t);
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await act(async () => f.byId("pairing-cancel").props.onPress());
  await act(async () => f.byId("pairing-retry-scan").props.onPress());
  await act(async () => scan({ data: qr }));
  await f.success();
  assert.equal(f.requests(), 1, "the alternative second response is pairing_used");
  assert.equal((await f.restored()).config?.token, "device-secret");
});

for (const action of ["cancel", "back", "blur"] as const) {
  test(`${action} during exchange still saves a success returned by the gateway`, async (t) => {
    const f = await fixture(t);
    const scan = await f.scan();
    await act(async () => scan({ data: qr }));
    if (action === "blur") await f.focus(false);
    else await act(async () => f.byId(`pairing-${action}`).props.onPress());
    await f.success();
    assert.equal((await f.restored()).config?.token, "device-secret");
  });
}

test("a consumed QR stays blocked across refocus and explicit rescan even when secure saving fails", async (t) => {
  const f = await fixture(t);
  f.failWrite();
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await f.success();
  assert.match(f.byId("pairing-error").props.children, /无法安全保存/);
  await act(async () => f.byId("pairing-retry-scan").props.onPress());
  await act(async () => scan({ data: qr }));
  assert.ok(f.byId("pairing-error"), "consumed-code rejection remains visible after explicit rescan");
  await act(async () => f.byId("pairing-back").props.onPress());
  const revisitedScan = await f.scan();
  await act(async () => revisitedScan({ data: qr }));
  assert.ok(f.byId("pairing-error"), "a new scanner visit also explains the consumed code");
  await f.focus(false);
  await f.focus(true);
  const scanAgain = await f.scan();
  await act(async () => scanAgain({ data: qr }));
  assert.equal(f.requests(), 1);
});

test("a saving failure after leaving the screen is explicitly reported", async (t) => {
  const f = await fixture(t);
  f.failWrite();
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await f.focus(false);
  await f.success();
  assert.match(f.alerts.flat().join(" "), /无法安全保存/);
});

test("manual cancellation keeps the exchange slot until its successful token is saved", async (t) => {
  const f = await fixture(t);
  const submit = await f.manual();
  await act(async () => submit());
  await act(async () => f.byId("pairing-cancel").props.onPress());
  await act(async () => submit());
  await f.success();
  assert.equal(f.requests(), 1);
  assert.equal((await f.restored()).config?.token, "device-secret");
});

test("refocus and a queued cancel callback cannot interrupt an already started secure write", async (t) => {
  const f = await fixture(t);
  f.holdWrite();
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  const cancel = f.byId("pairing-cancel").props.onPress;
  await f.success();
  await f.focus(false);
  await f.focus(true);
  await act(async () => { cancel(); f.byId("pairing-manual").props.onPress(); });
  assert.equal(f.root.container.queryAll((node) => node.props.testID === "pairing-submit").length, 0);
  await f.releaseWrite();
  assert.equal((await f.restored()).config?.token, "device-secret");
});

test("a cancelled exchange releases admission at its existing deadline if no response arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await act(async () => f.byId("pairing-cancel").props.onPress());
  await act(async () => t.mock.timers.tick(15_000));
  await act(async () => scan({ data: qr.replace("AB12CD34", "ZX98CV76") }));
  assert.equal(f.requests(), 2, "timeout must release the slot for a fresh code");
  assert.equal((await f.restored()).config, null);
});

for (const outcome of ["timeout", "failure"] as const) {
  test(`returning to the entry keeps pending work visible and reports ${outcome} before enabling retry`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await fixture(t);
    const scan = await f.scan();
    await act(async () => scan({ data: qr }));
    await act(async () => f.byId("pairing-back").props.onPress());
    assert.ok(f.byId("pairing-progress"));
    assert.equal(f.byId("pairing-scan").props.disabled, true);
    const submit = await f.manual();
    assert.equal(f.byId("pairing-submit").props.disabled, true);
    await act(async () => submit()); // Even a queued native callback cannot bypass admission.
    assert.equal(f.requests(), 1);
    if (outcome === "timeout") await act(async () => t.mock.timers.tick(15_000));
    else await f.failure();
    assert.ok(f.byId("pairing-error"));
    assert.equal(f.root.container.queryAll((node) => node.props.testID === "pairing-progress").length, 0);
    assert.equal(f.byId("pairing-submit").props.disabled, false);
    await act(async () => f.byId("pairing-back").props.onPress());
    assert.ok(f.byId("pairing-error"), "settlement remains visible on the entry page");
    assert.equal(f.byId("pairing-scan").props.disabled, false);
  });
}

test("unmount/remount shares in-flight admission and saves the original response exactly once", async (t) => {
  const f = await fixture(t);
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await f.remount();
  assert.ok(f.byId("pairing-progress"));
  assert.equal(f.byId("pairing-scan").props.disabled, true);
  const submit = await f.manual();
  await act(async () => { submit(); scan({ data: qr }); });
  assert.equal(f.requests(), 1);
  await f.success();
  assert.equal((await f.restored()).config?.token, "device-secret");
  assert.equal(f.root.container.queryAll((node) => node.props.testID === "pairing-progress").length, 0);
  await f.remount();
  const scanAgain = await f.scan();
  await act(async () => scanAgain({ data: qr }));
  assert.equal(f.requests(), 1, "consumption also survives remount");
  assert.ok(f.byId("pairing-error"));
});

test("remount during secure saving keeps admission closed and reports a failed write to the new screen", async (t) => {
  const f = await fixture(t);
  f.holdWrite();
  f.failWrite();
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await f.success();
  await f.remount();
  assert.ok(f.byId("pairing-progress"));
  assert.equal(f.byId("pairing-scan").props.disabled, true);
  await f.releaseWrite();
  assert.ok(f.byId("pairing-error"));
  assert.equal(f.byId("pairing-scan").props.disabled, false);
  const scanAgain = await f.scan();
  await act(async () => scanAgain({ data: qr }));
  assert.equal(f.requests(), 1);
  assert.ok(f.byId("pairing-error"), "failed saving does not silently swallow a consumed QR");
});

test("failure settled while unmounted is available when the entry is mounted again", async (t) => {
  const f = await fixture(t);
  const scan = await f.scan();
  await act(async () => scan({ data: qr }));
  await act(async () => f.root.render(createElement(Fragment)));
  await f.failure();
  await act(async () => f.root.render(createElement(Connect)));
  assert.ok(f.byId("pairing-error"));
  assert.equal(f.byId("pairing-scan").props.disabled, false);
  assert.equal(f.requests(), 1);
});

for (const intent of ["add-other-address", "add-same-address", "default-same-address", "repair"] as const) {
  test(`invalid computer pairing page preserves the user's ${intent} intent`, async (t) => {
    const f = await fixture(t, true);
    const previous = f.credentials.snapshot().config!;
    assert.ok(f.byId("pairing-invalid"));
    if (intent !== "default-same-address") {
      await act(async () => f.byId("pairing-computers").props.onPress());
      assert.equal(f.byId(`connection-computer-${previous.computerId}`).props.meta, "需要重新配对");
      await act(async () => f.byId(intent === "repair" ? "connection-repair" : "connection-add").props.onPress());
    }
    const address = intent === "add-other-address" ? `${previous.baseUrl}-other` : previous.baseUrl;
    const submit = await f.manual(address);
    await act(async () => submit());
    assert.equal(f.requests(), 1, "the page must allow the requested pairing exchange");
    await f.success();
    const stored = await f.restored();
    assert.equal(stored.config?.baseUrl, address);
    assert.equal(stored.config?.deviceId, "d1");
    assert.equal(stored.config?.authStatus, undefined);
    assert.notEqual(stored.config?.connectionId, previous.connectionId);
    if (intent === "repair") {
      assert.equal(stored.computers.length, 1);
      assert.equal(stored.config?.computerId, previous.computerId);
      assert.equal(stored.config?.localName, "工作电脑");
    } else {
      assert.equal(stored.computers.length, 2);
      assert.notEqual(stored.config?.computerId, previous.computerId);
      assert.equal(stored.config?.localName, undefined);
      assert.deepEqual(stored.computers.find((computer) => computer.computerId === previous.computerId), previous);
    }
  });
}

test("explicit repair refuses a different address before exchanging the code", async (t) => {
  const f = await fixture(t, true);
  const previous = f.credentials.snapshot().config!;
  await act(async () => f.byId("pairing-computers").props.onPress());
  await act(async () => f.byId("connection-repair").props.onPress());
  const submit = await f.manual(`${previous.baseUrl}-other`);
  await act(async () => submit());
  assert.equal(f.requests(), 0);
  assert.match(f.byId("pairing-error").props.children, /原电脑地址/);
  assert.deepEqual((await f.restored()).computers, [previous]);
});
