import { exchangePairingCode, GatewayError } from "../gateway/api.ts";
import type { ConnectionConfig } from "./credentials.ts";

export type PairingMethod = "manual" | "qr";
export type PairingTarget = { baseUrl: string; code: string };

/** Visit-local permission/probe work and camera callback suppression. One-use exchanges
 * belong to the application coordinator below, not to this cancellable screen scope. */
export class PairingScanScope {
  private focused = false;
  private pending: AbortController | null = null;
  private lastQr: string | null = null;

  focus(): void {
    this.cancel();
    this.focused = true;
    this.lastQr = null;
  }
  blur(): void {
    this.focused = false;
    this.cancel();
    this.lastQr = null;
  }
  canScan(): boolean { return this.focused && !this.pending; }
  start(qr?: string): AbortSignal | null {
    if (!this.focused || this.pending || (qr !== undefined && qr === this.lastQr)) return null;
    if (qr !== undefined) this.lastQr = qr;
    this.pending = new AbortController();
    return this.pending.signal;
  }
  current(signal: AbortSignal): boolean {
    return this.focused && !signal.aborted && this.pending?.signal === signal;
  }
  finish(signal: AbortSignal): void {
    if (this.pending?.signal === signal) this.pending = null;
  }
  cancel(): void {
    this.pending?.abort();
    this.pending = null;
  }
  retryQr(): void { this.lastQr = null; }
}

type PairingState = { phase: "idle" | "exchanging" | "saving"; error: string };

/** Application-lifetime ownership matches the non-cancellable exchange and secure write.
 * Every screen observes the same admission, progress and outcome, including after remount.
 * Consumed codes stay blocked for this app process even when saving fails. */
export class PairingCoordinator {
  private state: PairingState = { phase: "idle", error: "" };
  private consumed = new Set<string>();
  private listeners = new Set<() => void>();

  snapshot = (): PairingState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: PairingState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  clearError(): void {
    if (this.state.error) this.publish({ ...this.state, error: "" });
  }

  /** Normalizes both entry methods, admits synchronously, and owns completion through save.
   * Errors remain observable until dismissed/new work; also return them for offscreen alerts.
   * A duplicate in flight does not start work or replace the existing progress/outcome. */
  async connect(address: string, code: string, method: PairingMethod,
    save: (config: ConnectionConfig) => Promise<void>): Promise<string | null> {
    if (this.state.phase !== "idle") return null;
    let exchanged = false;
    try {
      const baseUrl = normalizeGatewayAddress(address);
      const pairingCode = normalizePairingCode(code);
      const key = JSON.stringify([baseUrl, pairingCode]);
      if (this.consumed.has(key)) {
        const message = "此配对码已兑换。请在电脑上重新生成配对码后重试。";
        this.publish({ phase: "idle", error: message });
        return message;
      }
      this.publish({ phase: "exchanging", error: "" });
      // Only the transport's existing deadline can end the request; screen disposal cannot.
      const exchange = await exchangePairingCode(baseUrl, pairingCode, method);
      this.consumed.add(key);
      exchanged = true;
      this.publish({ phase: "saving", error: "" });
      await save({ baseUrl, token: exchange.token, deviceId: exchange.device_id,
        computerName: exchange.computer_name, gatewayVersion: exchange.gateway_version,
        pairedAt: exchange.paired_at, pairingMethod: method });
      this.publish({ phase: "idle", error: "" });
      return null;
    } catch (cause) {
      const message = exchanged
        ? "无法安全保存设备令牌。请在电脑上重新生成配对码后重试。"
        : `${pairingErrorMessage(cause)} 现在可以重试；若配对码已使用，请在电脑上重新生成。`;
      this.publish({ phase: "idle", error: message });
      return message;
    }
  }
}

export const pairingCoordinator = new PairingCoordinator();

/** The QR holds only a gateway address and a one-use challenge, never a device token. */
export function parsePairingQr(value: string): PairingTarget | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "wandrun:" || url.hostname !== "pair" || url.pathname !== "" || url.username || url.password || url.port || url.hash) return null;
    if (url.searchParams.getAll("url").length !== 1 || url.searchParams.getAll("code").length !== 1) return null;
    for (const key of url.searchParams.keys()) if (key !== "url" && key !== "code") return null;
    const address = url.searchParams.get("url");
    const code = url.searchParams.get("code");
    if (!address || !code) return null;
    return { baseUrl: normalizeGatewayAddress(address), code: normalizePairingCode(code) };
  } catch {
    return null;
  }
}

export function normalizeGatewayAddress(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw new Error("invalid address");
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    throw new Error("电脑地址无效，请填写 http:// 或 https:// 地址");
  }
}

export function normalizePairingCode(value: string): string {
  const code = value.trim().replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) throw new Error("请输入电脑上显示的 8 位配对码");
  return code;
}

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof GatewayError) {
    switch (error.code) {
      case "pairing_expired": return "配对码已过期。请在电脑上重新运行 wandrun pair。";
      case "pairing_invalid": return "配对码不正确。请核对后重试，或在电脑上重新运行 wandrun pair。";
      case "pairing_used": return "配对码已使用。请在电脑上重新运行 wandrun pair。";
      case "pairing_locked": return "配对码错误次数过多。请在电脑上重新运行 wandrun pair。";
      case "network": return "连不上电脑。请检查网关地址、网络及电脑上的网关是否正在运行。";
      case "timeout": return "连接超时。请检查网络后重试。";
    }
    if (error.status >= 500) return "电脑上的网关暂不可用。请检查网关与网络后重试。";
  }
  return error instanceof Error && !(error instanceof GatewayError) ? error.message : "连接失败。请在电脑上重新生成配对码后重试。";
}
