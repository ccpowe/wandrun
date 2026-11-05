import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import * as React from 'react';
import { jsx } from 'react/jsx-runtime';
import { createRoot } from 'test-renderer';
import { QueryObserver, focusManager, onlineManager, skipToken } from '@tanstack/react-query';
import ts from 'typescript';
import { ChatSession } from '../src/gateway/session.ts';
import { attachSessionQueries, connectorListOptions, gatewayQueryClient } from '../src/lib/gateway-queries.ts';

type NetworkState = { type: string; isConnected: boolean; isInternetReachable?: boolean };
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
  var __queryReact: typeof React;
  var __queryNative: {
    app: { currentState: string; addEventListener: (_name: string, listener: (state: string) => void) => { remove(): void } };
    addNetwork: (listener: (state: NetworkState) => void) => { remove(): void };
    getNetwork: () => Promise<NetworkState>;
  };
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__queryReact = React;
const hosts: Record<string, string> = {
  'react-native': 'export const AppState=globalThis.__queryNative.app; export const Platform={OS:"android"};',
  'expo-network': 'export const NetworkStateType={NONE:"NONE"};export const addNetworkStateListener=globalThis.__queryNative.addNetwork;export const getNetworkStateAsync=globalThis.__queryNative.getNetwork;',
  'expo': 'export const requireOptionalNativeModule=()=>null;',
  'expo-router': 'export const useIsFocused=()=>true;export const useFocusEffect=callback=>globalThis.__queryReact.useEffect(callback,[callback]);',
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in hosts) return { url: `data:text/javascript,${encodeURIComponent(hosts[specifier])}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.tsx')) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText };
    return nextLoad(url, context);
  },
});

test('nested and independent hosts share native events; newest offline event beats initial snapshot and LAN recovery resumes mounted Query', async () => {
  const initial = Promise.withResolvers<NetworkState>();
  const appListeners = new Set<(state: string) => void>();
  const networkListeners = new Set<(state: NetworkState) => void>();
  globalThis.__queryNative = {
    app: { currentState: 'active', addEventListener(_name, listener) { appListeners.add(listener); return { remove() { appListeners.delete(listener); } }; } },
    addNetwork(listener) { networkListeners.add(listener); return { remove() { networkListeners.delete(listener); } }; },
    getNetwork() { return initial.promise; },
  };
  // Native modules do not exist in Node; import only after hooks and the native boundary are installed.
  const { GatewayQueryProvider } = await import('../src/lib/gateway-query-provider.tsx');
  const { useGatewayQuery } = await import('../src/lib/use-gateway-query.ts');
  function EmptyConsumer() { useGatewayQuery(skipToken); return null; }
  const first = createRoot();
  const second = createRoot();
  let reads = 0;
  const session = new ChatSession({ baseUrl: 'http://lan.test', token: 'test' }, async () => {
    reads++;
    return Response.json({ connectors: [{ id: 'docs', name: 'LAN recovered' }], as_of_seq: 0 });
  });
  attachSessionQueries(session);
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await setImmediate(); }); };
  const network = (state: NetworkState) => { for (const listener of networkListeners) listener(state); };
  const app = (state: string) => { globalThis.__queryNative.app.currentState = state; for (const listener of appListeners) listener(state); };
  let stop: (() => void) | undefined;
  try {
    await act(async () => first.render(jsx(GatewayQueryProvider, { children: jsx(GatewayQueryProvider, { children: jsx(EmptyConsumer, {}) }) })));
    await act(async () => second.render(jsx(GatewayQueryProvider, { children: null })));
    assert.equal(appListeners.size, 1); assert.equal(networkListeners.size, 1);
    assert.deepEqual(gatewayQueryClient.getQueryCache().getAll(), [], 'no session / skipToken must create no fake-key cache entry');
    await act(async () => network({ type: 'NONE', isConnected: false }));
    initial.resolve({ type: 'WIFI', isConnected: true }); await flush();
    assert.equal(onlineManager.isOnline(), false, 'late initial snapshot must not reopen an offline route');
    const observer = new QueryObserver(gatewayQueryClient, connectorListOptions(session));
    stop = observer.subscribe(() => {});
    assert.equal(observer.getCurrentResult().fetchStatus, 'paused'); assert.equal(reads, 0);
    await act(async () => first.unmount());
    await act(async () => network({ type: 'WIFI', isConnected: true, isInternetReachable: false })); await flush();
    assert.equal(observer.getCurrentResult().data?.connectors[0].name, 'LAN recovered');
    await act(async () => app('background')); assert.equal(focusManager.isFocused(), false);
    await act(async () => app('active')); await flush(); assert.equal(focusManager.isFocused(), true);
    stop(); stop = undefined;
    await session.close();
    await act(async () => second.unmount());
    assert.equal(appListeners.size, 0); assert.equal(networkListeners.size, 0);
    const calls = reads;
    network({ type: 'NONE', isConnected: false }); app('background'); await flush();
    assert.equal(reads, calls); assert.equal(onlineManager.isOnline(), true);
  } finally {
    stop?.(); await session.close();
    await act(async () => { first.unmount(); second.unmount(); });
    gatewayQueryClient.clear();
  }
});
