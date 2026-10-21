import type { GatewayConfig } from "../gateway/api.ts";
import { normalizeGatewayAddress } from "./pairing.ts";

export type ConnectionConfig = GatewayConfig & {
  deviceId?: string;
  computerName?: string;
  gatewayVersion?: string;
  pairedAt?: string | null;
  pairingMethod?: "manual" | "qr" | "development";
};
export type SavedComputer = ConnectionConfig & {
  computerId: string;
  /** Changes on pairing, not on rename or switch: late refusals cannot remove a replacement. */
  connectionId: string;
  localName?: string;
  /** Confirmed authentication failure; the pairing and local files are retained for repair. */
  authStatus?: "invalid";
};
export type CredentialState = {
  computers: readonly SavedComputer[];
  currentId: string | null;
  config: SavedComputer | null;
  ready: boolean;
  revoked: boolean;
};
type Storage = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; deleteItemAsync(key: string): Promise<void> };
const KEY = "wandrun.computers.v1";
const empty = (): CredentialState => ({ computers: [], currentId: null, config: null, ready: false, revoked: false });
const identity = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

/** One atomic secure-store document owns the list and selection. No old single-computer key
 * is read. Writes serialize; explicit revocation gates access immediately, even if a write
 * is pending. A storage error is propagated, never represented as a successful disconnect. */
export class Credentials {
  private state = empty();
  private pending: Promise<unknown> = Promise.resolve();
  private invalid = new Set<string>();
  private authInvalid = new Set<string>();
  private disconnecting = new Set<string>();
  private readonly storage: Storage;
  private listeners = new Set<() => void>();

  constructor(storage: Storage) { this.storage = storage; }
  snapshot = (): CredentialState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: CredentialState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  private selected(computers: readonly SavedComputer[], currentId: string | null, revoked: boolean): CredentialState {
    const available = computers.filter((item) => !this.invalid.has(item.connectionId)).map((item) =>
      this.authInvalid.has(item.connectionId) && item.authStatus !== "invalid" ? { ...item, authStatus: "invalid" as const } : item);
    const config = available.find((item) => item.computerId === currentId) ?? available[0] ?? null;
    return { computers: available, config, currentId: config?.computerId ?? null, ready: true, revoked };
  }
  private async persist(computers: readonly SavedComputer[], currentId: string | null, revoked: boolean): Promise<void> {
    let next = this.selected(computers, currentId, revoked);
    for (;;) {
      if (next.computers.length) await this.storage.setItemAsync(KEY, JSON.stringify({ computers: next.computers, currentId: next.currentId }));
      else await this.storage.deleteItemAsync(KEY);
      const checked = this.selected(next.computers, next.currentId, revoked);
      // A refusal during a pending secure write must not resurrect an invalid installation.
      if (checked.computers.length === next.computers.length &&
        checked.computers.every((item, index) => item === next.computers[index])) break;
      next = checked;
    }
    this.publish(next);
  }
  restore(): Promise<void> {
    return this.enqueue(async () => {
      const saved = await this.storage.getItemAsync(KEY);
      const value = saved ? JSON.parse(saved) as { computers: SavedComputer[]; currentId: string | null } : { computers: [], currentId: null };
      this.publish(this.selected(value.computers, value.currentId, false));
    });
  }
  /** Explicit repair replaces an invalid installation at the same endpoint, preserving its local namespace. */
  install(config: ConnectionConfig, repairConnectionId?: string): Promise<void> {
    return this.enqueue(async () => {
      const baseUrl = normalizeGatewayAddress(config.baseUrl);
      const repair = repairConnectionId
        ? this.state.computers.find((item) => item.connectionId === repairConnectionId) : undefined;
      if (repairConnectionId && (!repair || repair.authStatus !== "invalid" || repair.baseUrl !== baseUrl)) {
        throw new Error("原电脑连接已变化，请返回「关于与连接」重新选择");
      }
      // Without explicit repair intent, address/name cannot prove computer identity.
      // Only a repeated authenticated device identity or exact development token is merged.
      const previous = repair ?? this.state.computers.find((item) => item.baseUrl === baseUrl && (
        config.deviceId ? item.deviceId === config.deviceId :
          config.pairingMethod === "development" && item.pairingMethod === "development" && item.token === config.token
      ));
      const computer: SavedComputer = { ...config, baseUrl, computerId: previous?.computerId ?? identity(), connectionId: identity(),
        ...(previous?.localName ? { localName: previous.localName } : {}) };
      const computers = previous ? this.state.computers.map((item) => item === previous ? computer : item) : [...this.state.computers, computer];
      await this.persist(computers, computer.computerId, false);
    });
  }
  switchComputer(computerId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.computers.some((item) => item.computerId === computerId)) throw new Error("电脑已移除，请重新配对");
      if (this.state.currentId !== computerId) await this.persist(this.state.computers, computerId, false);
    });
  }
  renameComputer(computerId: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const localName = name.trim();
      if (Array.from(localName).length > 64 || /[\r\n]/.test(localName)) throw new Error("备注名须为单行，最多 64 个字符");
      if (!this.state.computers.some((item) => item.computerId === computerId)) throw new Error("电脑已移除");
      await this.persist(this.state.computers.map((item) => item.computerId === computerId ? { ...item, localName: localName || undefined } : item), this.state.currentId, this.state.revoked);
    });
  }
  beginDisconnect(expected: SavedComputer): void { this.disconnecting.add(expected.connectionId); }
  endDisconnect(expected: SavedComputer): void { this.disconnecting.delete(expected.connectionId); }
  /** A confirmed 401 suspends only this installation, retaining its pairing and local data. */
  markInvalid(expected: SavedComputer): Promise<boolean> {
    if (!this.state.computers.some((item) => item.connectionId === expected.connectionId)) return Promise.resolve(false);
    this.authInvalid.add(expected.connectionId);
    this.publish(this.selected(this.state.computers, this.state.currentId, false));
    return this.enqueue(async () => {
      await this.persist(this.state.computers, this.state.currentId, this.state.revoked);
      return true;
    });
  }
  clear(expected: SavedComputer, revoked = false): Promise<boolean> {
    if (!this.state.computers.some((item) => item.connectionId === expected.connectionId)) return Promise.resolve(false);
    this.invalid.add(expected.connectionId);
    const showRevoked = revoked && !this.disconnecting.has(expected.connectionId);
    this.publish(this.selected(this.state.computers, this.state.currentId, showRevoked));
    return this.enqueue(async () => {
      await this.persist(this.state.computers, this.state.currentId, this.state.revoked);
      return true;
    });
  }
  /** Call only after confirmed remote revocation (or for a development credential). */
  finishDisconnect(expected: SavedComputer): Promise<void> {
    return this.enqueue(async () => {
      await this.persist(this.state.computers.filter((item) => item.connectionId !== expected.connectionId), this.state.currentId, false);
    });
  }
}
