import type { BrowserTask } from "../gateway/api.ts";
import { t } from "../lib/i18n.ts";

/** The lease socket sends a BE header length, UTF-8 JSON metadata, then raw JPEG bytes. */
export type Frame = {
  t: "frame"; seq: number; page: string; epoch: number; vp: number;
  /** Gateway identity shared by hello, frame and server logs; old fixtures may omit it. */
  connection_id?: string;
  css: [number, number]; dpr: number; scroll: [number, number]; pageScale: number; offsetTop: number;
  /** Window and flights when this frame is sent, including this frame. */
  max_in_flight: number; in_flight: number; in_flight_bytes: number; byte_budget: number;
  /** Most recent reason the gateway paused sending before this frame. */
  stop_reason: "none" | "frame-credit" | "byte-credit" | "pacing" | "oldest-frame";
  /** Gateway path segments in milliseconds; unavailable estimates remain null. */
  frame_age_ms: number | null; credit_wait_ms: number; send_lock_ms: number | null;
  ack_baseline_ms: number | null; ack_smoothed_ms: number | null; queue_delay_ms: number | null;
  /** Estimated delivered bytes per second, not bits/s; null before a busy-path sample. */
  delivery_rate_bps: number | null;
  /** Cumulative overwrites of this socket's latest-frame slot when the header is encoded. */
  dropped_frames?: number;
  /** Last received valid ACK wait observed by the gateway (shown or skipped); null until one exists. */
  ack_wait_ms?: number | null;
  /** Highest input id dispatched to CDP before this frame was produced; 0 before input. */
  applied_input_id?: number;
  /** Encoder tier belongs to this connection; CSS coordinates do not scale with JPEG pixels. */
  quality_tier?: "high" | "medium" | "low";
  quality_reason?: "initial" | "queue-delay" | "bandwidth" | "recovered" | "steady" | "idle-refresh";
};
/** The JPEG copy is independent of the WebSocket envelope (native Skia copies its entire backing buffer). */
export type FramePacket = { frame: Frame; jpeg: Uint8Array };
/** Validated envelope retained in a single latest slot until the image candidate can advance. */
export type FrameEnvelope = { frame: Frame; data: ArrayBuffer; jpegOffset: number };
export type Pages = { t: "pages"; current: string | null; pages: BrowserTask["pages"]; state: BrowserTask["state"]; max_pages: number; epoch: number; vp: number; css: [number, number]; dpr: number };
export type Hello = { t: "hello"; protocol: number; ping_supported: boolean; window_mode: "adaptive" | "fixed"; max_in_flight: number; max_in_flight_limit: 32; connection_id?: string };
export type Reply = { t: "input_done"; id: number; epoch?: number; vp?: number; input_lock_wait_ms: number; input_dispatch_ms: number; input_cdp_ms: number }
  | { t: "input_pending" | "page_done"; id: number; epoch?: number; vp?: number; target?: string }
  | { t: "reject"; id: number | null; why: string } | { t: "pong"; id: number };
export type Input =
  | { t: "click" | "down" | "up"; x: number; y: number; button: "left" | "right"; count?: number }
  | { t: "move"; x: number; y: number; buttons?: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "text"; text: string }
  | { t: "key"; key: string; code: string; vk: number; text?: string }
  | { t: "navigate"; url: string }
  | { t: "back" | "reload" | "forward" };

const decoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true });
const duration = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const optionalDuration = (n: unknown): n is number | null => n === null || duration(n);

/** Reject malformed diagnostic envelopes rather than laundering invalid timings into stats. */
export function decodeHello(message: unknown): Hello {
  const hello = message as Hello;
  if (!hello || hello.t !== "hello" || hello.protocol !== 1 || typeof hello.ping_supported !== "boolean"
    || !["adaptive", "fixed"].includes(hello.window_mode)
    || !Number.isSafeInteger(hello.max_in_flight) || hello.max_in_flight < 1 || hello.max_in_flight > 32
    || hello.max_in_flight_limit !== 32
    || (hello.connection_id !== undefined && (typeof hello.connection_id !== "string" || !hello.connection_id.length))
    || (hello.window_mode === "adaptive" && hello.max_in_flight !== 2)) throw new Error("invalid-hello");
  return hello;
}

export function decodeInputDone(message: unknown): Extract<Reply, { t: "input_done" }> {
  const reply = message as Extract<Reply, { t: "input_done" }>;
  if (!reply || reply.t !== "input_done" || !Number.isSafeInteger(reply.id) || reply.id < 0
    || !duration(reply.input_lock_wait_ms) || !duration(reply.input_dispatch_ms) || !duration(reply.input_cdp_ms))
    throw new Error("invalid-input-done");
  return reply;
}

function headerText(bytes: Uint8Array): string {
  if (decoder) return decoder.decode(bytes);
  // Hermes runtimes without TextDecoder can still decode the small JSON header as UTF-8.
  let escaped = "";
  for (let i = 0; i < bytes.length; i++) escaped += `%${bytes[i].toString(16).padStart(2, "0")}`;
  return decodeURIComponent(escaped);
}

export function decodeFrameEnvelope(data: ArrayBuffer): FrameEnvelope {
  if (data.byteLength < 6) throw new Error("short-frame");
  const length = new DataView(data).getUint32(0, false);
  if (length < 2 || length > data.byteLength - 6 || length > 32768) throw new Error("invalid-header-length");
  const bytes = new Uint8Array(data);
  const header = JSON.parse(headerText(bytes.subarray(4, 4 + length))) as Frame;
  if (!header || header.t !== "frame" || !Number.isSafeInteger(header.seq) || !Number.isSafeInteger(header.epoch) || !Number.isSafeInteger(header.vp)
    || typeof header.page !== "string" || !Array.isArray(header.css) || header.css.length !== 2
    || !header.css.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    || !Number.isSafeInteger(header.max_in_flight) || header.max_in_flight < 1 || header.max_in_flight > 32
    || !Number.isSafeInteger(header.in_flight) || header.in_flight < 1 || header.in_flight > 32
    || (header.connection_id !== undefined && (typeof header.connection_id !== "string" || !header.connection_id.length))
    || !Number.isSafeInteger(header.in_flight_bytes) || header.in_flight_bytes < 0
    || !Number.isSafeInteger(header.byte_budget) || header.byte_budget < 1
    || !optionalDuration(header.delivery_rate_bps)
    || !["none", "frame-credit", "byte-credit", "pacing", "oldest-frame"].includes(header.stop_reason)
    || !optionalDuration(header.frame_age_ms) || !duration(header.credit_wait_ms)
    || !optionalDuration(header.send_lock_ms) || !optionalDuration(header.ack_baseline_ms)
    || !optionalDuration(header.ack_smoothed_ms) || !optionalDuration(header.queue_delay_ms)
    || (header.dropped_frames !== undefined && (!Number.isSafeInteger(header.dropped_frames) || header.dropped_frames < 0))
    || (header.applied_input_id !== undefined && (!Number.isSafeInteger(header.applied_input_id) || header.applied_input_id < 0))
    || (header.quality_tier !== undefined && !["high", "medium", "low"].includes(header.quality_tier))
    || (header.quality_reason !== undefined && !["initial", "queue-delay", "bandwidth", "recovered", "steady", "idle-refresh"].includes(header.quality_reason))
    || (header.ack_wait_ms !== undefined && !optionalDuration(header.ack_wait_ms))) throw new Error("invalid-frame-header");
  if (bytes[4 + length] !== 0xff || bytes[5 + length] !== 0xd8) throw new Error("invalid-jpeg");
  return { frame: header, data, jpegOffset: 4 + length };
}

export function decodeFrame(data: ArrayBuffer): FramePacket {
  const envelope = decodeFrameEnvelope(data);
  return { frame: envelope.frame, jpeg: jpegBytes(envelope) };
}

export function jpegBytes({ data, jpegOffset }: FrameEnvelope): Uint8Array {
  // Skia 2.6.2 cpp/api/JsiSkDataFactory.h:50-58 copies the entire .buffer,
  // ignoring byteOffset/byteLength. Keep the transport header out of native decoding.
  return new Uint8Array(data).slice(jpegOffset);
}

/** A frame is a credential only for the currently selected page, epoch and viewport. */
export function inputFrame(frame: Frame | null, pages: Pages | null, control: boolean): Frame | null {
  return control && pages?.state === "human" && pages.current !== null && frame?.page === pages.current
    && frame.epoch === pages.epoch && frame.vp === pages.vp ? frame : null;
}

export function rejectReason(why: string): string {
  const reasons: Record<string, string> = {
    "read-only": "当前只能观看", "not-human": "当前未接管浏览器", "stale-epoch": "控制状态已变化，请等待新画面",
    "stale-viewport": "页面视口已变化，请等待新画面", "stale-frame": "画面已过期，请等待新画面",
    "no-page": "没有可操作的页面，请先新建页面", "no-such-page": "页面已关闭", "out-of-bounds": "点击落在页面外",
    "invalid-gesture": "手势已取消，请重试", "incomplete-gesture": "手势不完整，请重试",
    "no-history": "没有上一页", "page-limit": "已达到页面上限", "invalid-url": "网址无效，请输入 http 或 https 网址",
    "browser-unavailable": "浏览器暂不可用，请稍后重新打开",
    "task-ended": "任务已结束，无法继续操作浏览器",
    "browser-ended": "浏览器正在关闭或已结束，请重新打开",
    "invalid-input": "当前输入不受支持，请换一种操作方式",
    "browser-operation-failed": "浏览器操作失败，请重新打开后重试；如持续失败，请联系管理员",
  };
  return t(reasons[why] ?? "操作未完成，请等待新画面后重试；如持续失败，请重新打开浏览器");
}

/** Lease closure reasons are server diagnostics, not display text. */
export function endedReason(reason: string | null): string {
  const reasons: Record<string, string> = {
    "用户关闭": "浏览器已关闭", "最后一张页面已关闭": "最后一张页面已关闭，可重新打开浏览器",
    "浏览器空闲超时": "浏览器因长时间未操作而结束，请重新打开",
    "重启": "浏览器因服务重启而结束，请重新打开",
    "Chrome 重启": "浏览器因 Chrome 重启而结束，请重新打开",
    "任务结束": "任务已结束，浏览器已关闭",
    "对话删除": "对话已删除，浏览器已关闭",
    "Agent 删除": "Agent 已删除，浏览器已关闭",
    "Agent 关闭": "Agent 已关闭最后一张页面，浏览器已结束",
    "网关重启，浏览器任务已结束": "网关重启后浏览器已结束，请重新打开",
  };
  if (reason?.startsWith("浏览器分配失败：") || reason?.startsWith("浏览器页面初始化失败："))
    return t("浏览器启动失败，请稍后重新打开；如持续失败，请联系管理员");
  if (reason?.startsWith("关闭未确认：") || reason?.startsWith("页面清理未确认："))
    return t("浏览器关闭尚未确认，请稍后查看状态；如持续失败，请联系管理员");
  return t(reason ? reasons[reason] ?? "浏览器已结束，请重新打开；如持续失败，请联系管理员" : "浏览器已结束");
}
