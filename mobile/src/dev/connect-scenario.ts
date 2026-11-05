import { Credentials, type SavedComputer } from '../lib/credentials';
import type { SessionRuntime } from '../lib/session-context';
import { pairingCoordinator } from '../lib/pairing';
import { FakeGateway, unavailable } from './fake-gateway';
import { installFakeGatewayHost } from './fake-gateway-host';

export type ConnectScenarioKind = 'normal' | 'exchange-failure' | 'save-failure';
export type ConnectScenario = {
  runtime: SessionRuntime; gateway: FakeGateway; code: string; readonly stored: string | null; readonly exchanges: number;
  hold(): void; release(): void; holdSaving(): void; releaseSaving(): void; allowSave(): void; start(): void; stop(): void;
};
export function connectScenario(kind: ConnectScenarioKind = 'normal', code = 'B1PAIR01', initial?: SavedComputer): ConnectScenario {
  let stored: string | null = initial ? JSON.stringify({ currentId: initial.computerId, computers: [initial] }) : null;
  let saveFailure = kind === 'save-failure';
  let gate: PromiseWithResolvers<void> | undefined;
  let saving: PromiseWithResolvers<void> | undefined;
  let exchanges = 0;
  let stopHost: (() => void) | undefined;
  const credentials = new Credentials({ getItemAsync: async () => stored,
    setItemAsync: async (_key, value) => { await saving?.promise; if (saveFailure) throw new Error('device storage unavailable'); stored = value; }, deleteItemAsync: async () => { stored = null; } });
  const gateway = new FakeGateway({
    pairing: { code, token: 'storybook-device', deviceId: `paired-${code}`, consumed: false },
    connection: { computer_name: 'research-host', device_id: `paired-${code}`, gateway_version: '0.2.0', paired_at: '2026-10-30T00:00:00Z', pairing_method: 'manual' },
    memories: new Map([['/memory/profile', { scope: 'profile', content: '', version: 'v1', limit: 1000, updated_at: 1, updated_by: 'user', details: {} }]]),
  }, { 'POST /pairing/exchange': async () => { exchanges++; await gate?.promise; if (kind === 'exchange-failure') return unavailable(); } });
  return { runtime: { credentials, fetch: gateway.fetch }, gateway, code,
    get stored() { return stored; }, get exchanges() { return exchanges; },
    hold() { gate ??= Promise.withResolvers<void>(); }, release() { gate?.resolve(); gate = undefined; },
    holdSaving() { saving ??= Promise.withResolvers<void>(); }, releaseSaving() { saving?.resolve(); saving = undefined; },
    allowSave() { saveFailure = false; },
    start() { pairingCoordinator.clearError(); stopHost ??= installFakeGatewayHost({ baseUrls: ['https://pairing-story.invalid'], fetch: gateway.fetch }); },
    stop() { gate?.resolve(); saving?.resolve(); gateway.disconnect(); stopHost?.(); stopHost = undefined; },
  };
}
