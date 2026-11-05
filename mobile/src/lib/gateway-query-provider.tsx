import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import * as Network from 'expo-network';
import { createContext, useContext, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { backgroundRecoveryMs } from './connection-liveness.ts';
import { gatewayQueryClient } from './gateway-queries.ts';
import { useMountEffect } from './use-mount-effect.ts';

type Recovery = (source: 'foreground' | 'network', backgroundMs: number) => void;
const recoveryListeners = new Set<Recovery>();
/** SessionProvider owns recovery, while all hosts share exactly one native subscription pair. */
export function subscribeQueryRecovery(listener: Recovery): () => void {
  recoveryListeners.add(listener);
  return () => recoveryListeners.delete(listener);
}
let hosts = 0;
let detach: (() => void) | undefined;
function mountNativeQueryEvents(): () => void {
  if (hosts++ === 0) {
    let active = true;
    let receivedNetworkEvent = false;
    let previousNetwork: Network.NetworkState | undefined;
    let backgroundAt: number | null = AppState.currentState === 'background' ? Date.now() : null;
    // RN may report null until its first native event; unknown is not evidence of backgrounding.
    focusManager.setFocused(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
    onlineManager.setOnline(true); // A prior independent host cannot pin the next host offline.
    const app = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        backgroundAt ??= Date.now();
        focusManager.setFocused(false);
        return;
      }
      const elapsed = backgroundAt === null ? 0 : Math.max(0, Date.now() - backgroundAt);
      backgroundAt = null;
      if (elapsed >= backgroundRecoveryMs) for (const listener of recoveryListeners) listener('foreground', elapsed);
      focusManager.setFocused(true);
    });
    const updateNetwork = (state: Network.NetworkState, event: boolean) => {
      // A LAN route is enough; Android public Internet validation does not prove gateway reachability.
      const online = state.isConnected !== false && state.type !== Network.NetworkStateType.NONE;
      if (event) {
        const changed = previousNetwork !== undefined &&
          (previousNetwork.type !== state.type || previousNetwork.isConnected !== state.isConnected);
        previousNetwork = state;
        // Preserve SessionProvider's former contract: the first listener event is only a baseline,
        // even when Query already received its independent initial online snapshot.
        if (changed && online && AppState.currentState === 'active') {
          for (const listener of recoveryListeners) listener('network', 0);
        }
      }
      onlineManager.setOnline(online);
    };
    const network = Network.addNetworkStateListener(state => {
      receivedNetworkEvent = true;
      updateNetwork(state, true);
    });
    void Network.getNetworkStateAsync().then(state => {
      if (active && !receivedNetworkEvent) updateNetwork(state, false);
    }).catch(() => { /* Unknown route leaves reads enabled; real transport errors remain visible. */ });
    detach = () => {
      active = false;
      app.remove();
      network.remove();
      focusManager.setFocused(undefined);
      onlineManager.setOnline(true);
    };
  }
  return () => { if (--hosts === 0) { detach?.(); detach = undefined; } };
}
const QueryHost = createContext(false);
function QueryRuntime({ children }: { children: ReactNode }) {
  useMountEffect(mountNativeQueryEvents);
  return <QueryHost.Provider value><QueryClientProvider client={gatewayQueryClient}>{children}</QueryClientProvider></QueryHost.Provider>;
}
/** Safe to compose at App, session, Storybook and standalone scene boundaries; nested hosts reuse the outer runtime. */
export function GatewayQueryProvider({ children }: { children: ReactNode }) {
  return useContext(QueryHost) ? children : <QueryRuntime>{children}</QueryRuntime>;
}
