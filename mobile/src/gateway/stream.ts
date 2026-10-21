// 全局事件流：一条连接覆盖所有对话（ADR-0022 第 6 节）。
// 游标只由这里推进，且只跟持久事件走：断线、网关重启后带 Last-Event-ID 重连，从下一条接着收。

import type { GatewayApi, GatewayEvent, TransientEvent } from "./api.ts";
import { SseParser } from "./sse.ts";
import { networkDiagnostic } from "./network-diagnostics.ts";

let nextGeneration = 0;

export type StreamState = "connecting" | "open" | "reconnecting" | "stopped";

type StreamEndReason = "recover" | "idle_timeout" | "stream_closed" | "request_error" | "stopped"
  | "http_error" | "missing_body" | "invalid_event";


export type StreamHandlers = {
  event(event: GatewayEvent): void;
  transient(event: TransientEvent): void;
  /** 游标来自别的存储（例如网关状态被清空）：调用方要重新拉列表，再用新的 as_of_seq 开流。 */
  resync(): void;
  state(state: StreamState): void;
  /** Actual bytes, not response headers, confirm the replacement connection can deliver events. */
  activity?(): void;
};

export type StreamOptions = {
  /** 多久没有任何字节（网关每 15 秒发心跳）就当连接已死；手机切网络时 TCP 往往不会报错。 */
  idleTimeout?: number;
  retryDelays?: number[];
};

export class EventStream {
  private readonly api: GatewayApi;
  private readonly handlers: StreamHandlers;
  private cursor: number;
  private running = true;
  private cancelConnection: ((reason: "recover" | "idle_timeout" | "stopped") => void) | null = null;
  private readonly idleTimeout: number;
  private readonly retryDelays: number[];
  private immediateRetry = false;
  private wakeRetry: (() => void) | null = null;
  readonly done: Promise<void>;

  constructor(api: GatewayApi, after: number, handlers: StreamHandlers, options: StreamOptions = {}) {
    this.api = api;
    this.handlers = handlers;
    this.cursor = after;
    this.idleTimeout = options.idleTimeout ?? 45_000;
    this.retryDelays = options.retryDelays ?? [500, 1000, 2000, 5000, 10_000];
    if (api.signal.aborted) this.running = false;
    else api.signal.addEventListener("abort", this.stop, { once: true });
    this.done = this.run();
  }

  /** 已收到的最后一条持久事件。 */
  get lastSeq(): number {
    return this.cursor;
  }

  /** 强制打断当前连接并立即重连，跳过退避等待。 */
  reconnectNow(): void {
    if (!this.running) return;
    this.immediateRetry = true;
    this.cancelConnection?.("recover");
    this.wakeRetry?.();
  }


  private readonly stop = () => {
    this.running = false;
    this.cancelConnection?.("stopped");
    this.wakeRetry?.();
  };

  close(): Promise<void> {
    this.stop();
    return this.done;
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      this.immediateRetry = false;
      this.handlers.state(failures === 0 ? "connecting" : "reconnecting");
      const received = await this.connectOnce().catch(() => false);
      if (!this.running) break;
      failures = received ? 0 : failures + 1;
      this.handlers.state("reconnecting");
      // 收到过数据说明网关正常（多半是它重启或主动结束了流），马上重连；连不上才退避。
      const delay = this.immediateRetry || failures === 0 ? 0 : this.retryDelays[Math.min(failures - 1, this.retryDelays.length - 1)];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wakeRetry = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeRetry = null;
    }
    this.api.signal.removeEventListener("abort", this.stop);
    this.handlers.state("stopped");
  }

  /** 读一次连接直到结束；返回是否收到过任何字节。 */
  private async connectOnce(): Promise<boolean> {
    const abort = new AbortController();
    const generation = ++nextGeneration;
    let endReason: StreamEndReason = "stream_closed";
    // RN's AbortController can discard abort(reason); own the reason before aborting.
    // Preserve the first cancellation if close follows recovery before this generation settles.
    const cancelConnection = (reason: "recover" | "idle_timeout" | "stopped") => {
      if (abort.signal.aborted) return;
      endReason = reason;
      abort.abort();
    };
    this.cancelConnection = cancelConnection;
    networkDiagnostic("sse_start", { generation });
    let received = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let wakeRead!: () => void;
    const stopped = new Promise<{ done: true; value?: undefined }>((resolve) => {
      wakeRead = () => resolve({ done: true });
    });
    const cancel = () => {
      wakeRead();
      void reader?.cancel().catch(() => {});
    };
    abort.signal.addEventListener("abort", cancel, { once: true });
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => cancelConnection("idle_timeout"), this.idleTimeout);
    };
    try {
      armIdle();
      // 游标放在请求头：与浏览器 EventSource 重连一致，网关优先看它（见 http.stream_cursor）。
      return await this.api.consumeResponse("/events", {
        headers: this.api.headers({ Accept: "text/event-stream", "Accept-Encoding": "identity", "Last-Event-ID": String(this.cursor) }),
        signal: abort.signal,
      }, async (response) => {
        networkDiagnostic("sse_headers", { generation, status: response.status });
        if (abort.signal.aborted || !this.running || !response.ok || !response.body) {
          if (!abort.signal.aborted) endReason = !response.ok ? "http_error" : "missing_body";
          void response.body?.cancel().catch(() => {});
          return false;
        }
        this.handlers.state("open");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        while (this.running && !abort.signal.aborted) {
          const { done, value } = await Promise.race([reader.read(), stopped]);
          if (done || abort.signal.aborted || !this.running) break;
          if (value.byteLength === 0) continue;
          if (!received) networkDiagnostic("sse_first_byte", { generation });
          received = true;
          armIdle();
          this.handlers.activity?.();
          for (const message of parser.feed(decoder.decode(value, { stream: true }))) {
            if (!this.running || abort.signal.aborted) break;
            this.dispatch(message.event, message.data);
          }
        }
        return received;
      });
    } catch (error) {
      // Error messages can contain URLs/credentials. Only controlled categories leave JS.
      if (!abort.signal.aborted) endReason = error instanceof SyntaxError ? "invalid_event" : "request_error";
      return received;
    } finally {
      networkDiagnostic("sse_end", { generation, reason: endReason, received });
      clearTimeout(idle);
      abort.signal.removeEventListener("abort", cancel);
      if (reader) void reader.cancel().catch(() => {});
      if (this.cancelConnection === cancelConnection) this.cancelConnection = null;
    }
  }

  private dispatch(type: string, data: string): void {
    if (type === ":") return; // 心跳，只用来证明连接还活着
    if (type === "resync_required") {
      this.handlers.resync();
      return;
    }
    const payload = JSON.parse(data);
    if (typeof payload.seq === "number") {
      // 网关按 seq 顺序发，不会重复；这里再挡一次，防止重连边界上的重复。
      if (payload.seq <= this.cursor) return;
      this.cursor = payload.seq;
      this.handlers.event(payload);
    } else {
      this.handlers.transient(payload);
    }
  }
}
