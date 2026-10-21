// 鼠标（触控板）模式的手势识别（没有 React 依赖）。
// 画面区：单指滑动 = 相对移动指针；轻点 = 在指针处左键单击（快速两次轻点 = 双击）；双指 = 本地缩放平移。
// 左键按钮同样在指针处点击（快速点两下 = 双击；轻点与按钮的连击互通）。
// 左/右键按钮：左键按住期间画面区滑动 = 拖动（press → move(dragging) → release）；右键抬起时单击。
// 拖动抬起画面指或松开按钮时结清 move → release；按钮仍按住时，下次画面滑动重新 press，轻点不追加单击。
// 画面区与按钮的触点分开：视图层把原生各区域的触点分别交给 handle / handleButton。
// 位移单位是 dp，换算成远端 CSS 像素与 edge-follow 在 geometry.ts（需要缩放与帧尺寸）。
// 所有区域由视图层提供同一个单调时钟，轻点、按钮、双击间隔才可比。

import type { Touch, TouchEvent } from "./gestures.ts";

export type MouseAction =
  /** 指针移动 (dx, dy) dp；dragging = 左键按住中（通道发 buttons=1）。 */
  | { kind: "move"; dx: number; dy: number; dragging: boolean }
  /** 在指针处单击；count = 连击次数（1 单击，2 双击）。 */
  | { kind: "click"; button: "left" | "right"; count: number }
  | { kind: "press"; button: "left"; count: number }
  | { kind: "release"; button: "left"; count: number }
  | { kind: "pinch"; scale: number; from: { x: number; y: number }; to: { x: number; y: number } };

export type MouseOptions = {
  slop: number;
  longPressMs: number;
  /** 指针移动的合并间隔（ms）。 */
  moveIntervalMs: number;
  /** 双击：与上一次点击的间隔上限（ms）。 */
  doubleClickMs: number;
  pinchSlop: number;
};

export const MOUSE_OPTIONS: MouseOptions = { slop: 10, longPressMs: 500, moveIntervalMs: 16, doubleClickMs: 300, pinchSlop: 8 };

type Point = { x: number; y: number };
type State =
  | { kind: "idle" }
  | { kind: "pending"; id: string; x0: number; y0: number; t0: number; x: number; y: number; moved: boolean }
  | { kind: "drag"; id: string; lastX: number; lastY: number }
  | { kind: "two"; a: string; b: string; active: boolean; d0: number; m0: Point; d: number; m: Point }
  | { kind: "dead" }; // 第二指之后的收尾 / 取消：全部手指抬起前不产生动作

const midpoint = (a: Touch, b: Touch): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class MouseModeRecognizer {
  private readonly options: MouseOptions;
  private state: State = { kind: "idle" };
  // 还没发出去的指针位移，按 moveIntervalMs 合并。
  private pendDx = 0;
  private pendDy = 0;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private leftId: string | null = null;
  // 按钮仍可按住，但画面指抬起已结束一次拖动；下一次滑动才重新 press。
  private leftPressed = false;
  private leftCount = 1;
  private leftMoved = false;
  private rightId: string | null = null;
  private rightStart = 0;
  private lastClick: { button: string; t: number; count: number } | null = null;
  private movedSinceClick = false;

  constructor(options: MouseOptions = MOUSE_OPTIONS) {
    this.options = options;
  }

  get leftHeld(): boolean {
    return this.leftId !== null;
  }

  handle(event: TouchEvent): MouseAction[] {
    const state = this.state;
    switch (event.type) {
      case "start":
        if (state.kind === "two" || state.kind === "dead") return [];
        if (event.touches.length >= 2) {
          const out = this.flush(event.t, true); // 已经滑出去的距离照常生效；待定的轻点作废
          const [a, b] = event.touches;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const m = midpoint(a, b);
          this.state = { kind: "two", a: a.id, b: b.id, active: false, d0: d, m0: m, d, m };
          return out;
        }
        if (state.kind === "idle" && event.touches.length === 1) {
          const { id, x, y } = event.touches[0];
          // 左键按住时画面区滑动立即就是拖动，不设死区（选文字、拖滑块要精细）。
          this.state = this.leftHeld ? { kind: "drag", id, lastX: x, lastY: y } : { kind: "pending", id, x0: x, y0: y, t0: event.t, x, y, moved: false };
        }
        return [];
      case "move":
        return this.move(event);
      case "end": {
        const out: MouseAction[] = [];
        if (state.kind === "drag") out.push(...this.flush(event.t, true));
        if (state.kind === "drag" && this.leftMoved && this.leftPressed) {
          this.leftPressed = false;
          out.push({ kind: "release", button: "left", count: this.leftCount });
        }
        if (state.kind === "pending" && event.touches.length === 0 && !state.moved && event.t - state.t0 < this.options.longPressMs && !this.leftHeld) {
          out.push({ kind: "click", button: "left", count: this.commit("left", state.t0, event.t) });
        }
        if (event.touches.length === 0) this.state = { kind: "idle" };
        else if (state.kind !== "idle") this.state = { kind: "dead" };
        return out;
      }
      case "cancel":
        this.pendDx = this.pendDy = 0;
        this.state = event.touches.length === 0 ? { kind: "idle" } : { kind: "dead" };
        if (this.leftPressed) {
          this.leftPressed = false;
          return [{ kind: "release", button: "left", count: this.leftCount }];
        }
        return [];
    }
  }

  /** 按钮只认领首个触点；其他手指抬起不能释放它，取消不产生右击。 */
  handleButton(button: "left" | "right", event: TouchEvent): MouseAction[] {
    const id = button === "left" ? this.leftId : this.rightId;
    if (event.type === "start" && id === null && event.touches.length) {
      return this.buttonDown(button, event.touches[0].id, event.t);
    }
    if (id !== null && (event.type === "cancel" || event.type === "end" && !event.touches.some((touch) => touch.id === id))) {
      return this.buttonUp(button, id, event.t, event.type === "cancel");
    }
    return [];
  }

  /** 左/右键按钮的触点按下。 */
  buttonDown(button: "left" | "right", id: string, t: number): MouseAction[] {
    if (button === "left") {
      if (this.leftId !== null) return [];
      this.leftId = id;
      this.leftPressed = true;
      this.leftMoved = false;
      this.leftCount = this.countFor("left", t);
      return [{ kind: "press", button: "left", count: this.leftCount }];
    }
    if (this.rightId === null) {
      this.rightId = id;
      this.rightStart = t;
    }
    return [];
  }

  /** 按钮抬起（cancelled = 系统取消）：结清尚未释放的左键；右键只有正常抬起才单击。 */
  buttonUp(button: "left" | "right", id: string, t: number, cancelled = false): MouseAction[] {
    if (button === "left") {
      if (id !== this.leftId) return [];
      const out = this.flush(t, true); // 最后一小段位移先落到指针上，再松开
      this.leftId = null;
      // 拖过的不算一次点击，下一次快速按下不是双击。
      this.lastClick = this.leftMoved ? null : { button: "left", t, count: this.leftCount };
      this.movedSinceClick = false;
      const release = this.leftPressed;
      this.leftPressed = false;
      return release ? [...out, { kind: "release", button: "left", count: this.leftCount }] : out;
    }
    if (id !== this.rightId) return [];
    this.rightId = null;
    return cancelled ? [] : [{ kind: "click", button: "right", count: this.commit("right", this.rightStart, t) }];
  }

  /** 切换模式、页面离开：松开左键，丢弃一切状态。 */
  reset(): MouseAction[] {
    const out: MouseAction[] = this.leftPressed ? [{ kind: "release", button: "left", count: this.leftCount }] : [];
    this.state = { kind: "idle" };
    this.pendDx = this.pendDy = 0;
    this.leftId = this.rightId = null;
    this.leftPressed = false;
    this.lastClick = null;
    return out;
  }

  private countFor(button: string, start: number): number {
    const last = this.lastClick;
    const again = last !== null && last.button === button && !this.movedSinceClick && start - last.t <= this.options.doubleClickMs;
    return again ? Math.min(last.count + 1, 3) : 1;
  }

  /** 一次点击完成：算连击次数并记下它（供下一次判定双击）。 */
  private commit(button: string, start: number, end: number): number {
    const count = this.countFor(button, start);
    this.lastClick = { button, t: end, count };
    this.movedSinceClick = false;
    return count;
  }

  private move(event: TouchEvent): MouseAction[] {
    const state = this.state;
    if (state.kind === "pending" || state.kind === "drag") {
      const touch = event.touches.find((candidate) => candidate.id === state.id);
      if (!touch) {
        this.state = { kind: "dead" };
        return [];
      }
      if (state.kind === "pending") {
        state.x = touch.x;
        state.y = touch.y;
        if (Math.hypot(touch.x - state.x0, touch.y - state.y0) <= this.options.slop && !state.moved) return [];
        state.moved = true;
        // 超过 slop 起算拖动：起点到当前的位移一并计入，指针才与手指同步。
        this.pendDx += touch.x - state.x0;
        this.pendDy += touch.y - state.y0;
        this.state = { kind: "drag", id: state.id, lastX: touch.x, lastY: touch.y };
        return this.flush(event.t, false);
      }
      this.pendDx += touch.x - state.lastX;
      this.pendDy += touch.y - state.lastY;
      state.lastX = touch.x;
      state.lastY = touch.y;
      return this.flush(event.t, false);
    }
    if (state.kind === "two") {
      const a = event.touches.find((touch) => touch.id === state.a);
      const b = event.touches.find((touch) => touch.id === state.b);
      if (!a || !b) return [];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = midpoint(a, b);
      if (!state.active) {
        if (Math.abs(d - state.d0) < this.options.pinchSlop && Math.hypot(m.x - state.m0.x, m.y - state.m0.y) < this.options.pinchSlop) return [];
        state.active = true; // 以当前为基线，不补发落指抖动
        state.d = d;
        state.m = m;
        return [];
      }
      const action: MouseAction = { kind: "pinch", scale: state.d > 0 ? d / state.d : 1, from: state.m, to: m };
      state.d = d;
      state.m = m;
      return [action];
    }
    return [];
  }

  private flush(t: number, force: boolean): MouseAction[] {
    if (this.pendDx === 0 && this.pendDy === 0) return [];
    if (!force && t - this.lastEmit < this.options.moveIntervalMs) return [];
    const action: MouseAction = { kind: "move", dx: this.pendDx, dy: this.pendDy, dragging: this.leftHeld };
    this.pendDx = this.pendDy = 0;
    this.lastEmit = t;
    this.movedSinceClick = true;
    if (this.leftHeld) this.leftMoved = true;
    if (this.leftHeld && !this.leftPressed) {
      this.leftPressed = true;
      this.leftCount = 1;
      return [{ kind: "press", button: "left", count: this.leftCount }, action];
    }
    return [action];
  }
}

// ---- 右侧竖向滚轮控件 ----

export type WheelOptions = {
  /** 滑块偏离中心的最大距离（dp）。 */
  travel: number;
  /** 中心附近的死区（dp）：手指略有抖动不滚。 */
  deadzone: number;
  /** 满偏时的滚动速度（远端 CSS 像素/秒）。 */
  maxRate: number;
};
export const WHEEL_OPTIONS: WheelOptions = { travel: 68, deadzone: 6, maxRate: 2000 };

/** 偏移 offset（dp，向下为正）→ 滚动速度（CSS 像素/秒，正 = 页面向下滚）。死区外线性增长到满偏的 maxRate。 */
export function wheelRate(offset: number, options: WheelOptions = WHEEL_OPTIONS): number {
  const magnitude = Math.abs(offset);
  if (magnitude <= options.deadzone) return 0;
  const t = Math.min(1, (magnitude - options.deadzone) / (options.travel - options.deadzone));
  return Math.sign(offset) * t * options.maxRate;
}

/**
 * 滚轮控件：拖动滑块 = 设定速度，松手回中；按住期间由视图层的定时器反复 tick，每次给出 rate·dt 的滚动量。
 * 滑块往下拖 = 页面向下滚（像滚动条的滑块），往上拖 = 向上。
 */
export class WheelControl {
  private readonly options: WheelOptions;
  private id: string | null = null;
  private y0 = 0;
  private lastTick: number | null = null;
  /** 滑块当前偏移（dp，已夹在 ±travel），视图层据此摆放滑块。 */
  offset = 0;

  constructor(options: WheelOptions = WHEEL_OPTIONS) {
    this.options = options;
  }

  get active(): boolean {
    return this.id !== null;
  }

  /** 只跟踪第一个触点；touches 是这个控件自己的触点。 */
  handle(event: TouchEvent): void {
    if (event.type === "start") {
      if (this.id === null && event.touches.length > 0) {
        this.id = event.touches[0].id;
        this.y0 = event.touches[0].y;
        this.lastTick = null;
      }
      return;
    }
    const touch = event.touches.find((candidate) => candidate.id === this.id);
    if (event.type === "move" && touch) {
      this.offset = Math.max(-this.options.travel, Math.min(this.options.travel, touch.y - this.y0));
    } else if (event.type !== "move" && !touch) {
      this.id = null;
      this.offset = 0;
    }
  }

  /** 定时器到点：返回这一段时间应滚动的 CSS 像素（正 = 向下）；0 表示不发。dt 上限 50ms，防止卡顿后一次滚一大截。 */
  tick(now: number): number {
    const previous = this.lastTick;
    this.lastTick = now;
    if (previous === null) return 0;
    return (wheelRate(this.offset, this.options) * Math.min(50, now - previous)) / 1000;
  }
}
