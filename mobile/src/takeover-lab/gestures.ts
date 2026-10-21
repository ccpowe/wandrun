// 触控模式的手势识别（没有 React 依赖）：onTouch* 事件 → 要发给远端或作用于本地画面的动作。
// 单指：点击 = 左键，长按 = 右键，拖动 = 平移本地视角（pan，不发远端、不滚网页）；双指：本地缩放与平移（pinch），不发远端。
// 滚网页由右侧滚轮条负责（mouse-gestures.ts 的 WheelControl），不在这里。
// 状态按触点 id 跟踪，不依赖 touches 数组下标（多指顺序在个别机型上不可靠）。
// 长按没有“事件”可等：视图层在单指按下后用定时器（longPressMs）调用 tick()，抬起/取消时清掉定时器。

export type Touch = { id: string; x: number; y: number };
/** touches 是事件之后仍按在屏幕上的全部触点（end 事件里不含刚抬起的那个）。 */
export type TouchEvent = { type: "start" | "move" | "end" | "cancel"; touches: Touch[]; t: number };
export type Action =
  | { kind: "click"; button: "left" | "right"; x: number; y: number }
  /** 单指拖动：本地视角跟手移动 (dx, dy) dp（1:1，不合并；受平移限制，1.0x 时无效果）。 */
  | { kind: "pan"; dx: number; dy: number }
  /** 双指：scale 是两指距离相对上一次的比值；上一次的中点 from 下的画面点要跟到新中点 to。 */
  | { kind: "pinch"; scale: number; from: { x: number; y: number }; to: { x: number; y: number } };

export type GestureOptions = {
  /** 位移超过它就不是点击/长按，变成平移（dp）。 */
  slop: number;
  /** 按住不到这么久才算点击；更久且没动是长按（ms）。 */
  longPressMs: number;
  /** 双指：距离或中点变化达到它才开始缩放/平移（dp），防止落指抖动。 */
  pinchSlop: number;
};

export const DEFAULT_OPTIONS: GestureOptions = { slop: 10, longPressMs: 500, pinchSlop: 8 };

type Point = { x: number; y: number };

type State =
  | { kind: "idle" }
  | { kind: "pending"; id: string; x0: number; y0: number; t0: number; x: number; y: number; moved: boolean }
  | { kind: "drag"; id: string; lastX: number; lastY: number }
  | { kind: "two"; a: string; b: string; active: boolean; d0: number; m0: Point; d: number; m: Point }
  // 长按已触发、第二指落下之后的收尾、系统取消：到全部手指抬起前，不产生任何动作（避免收尾时的误点）。
  | { kind: "dead" };

const midpoint = (a: Touch, b: Touch): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class TouchModeRecognizer {
  private readonly options: GestureOptions;
  private state: State = { kind: "idle" };

  constructor(options: GestureOptions = DEFAULT_OPTIONS) {
    this.options = options;
  }

  /** 视图层的长按定时器到点：仍是“没动过的单指按住”才触发右键。 */
  tick(): Action[] {
    const state = this.state;
    if (state.kind !== "pending" || state.moved) return [];
    this.state = { kind: "dead" };
    return [{ kind: "click", button: "right", x: state.x, y: state.y }];
  }

  handle(event: TouchEvent): Action[] {
    const state = this.state;
    switch (event.type) {
      case "start":
        if (state.kind === "two" || state.kind === "dead") return []; // 第三指等：不改变状态
        if (event.touches.length >= 2) {
          // 第二指落下：取消单指的一切（长按、点击、已进行的拖动），进入双指。
          const [a, b] = event.touches;
          const m = midpoint(a, b);
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          this.state = { kind: "two", a: a.id, b: b.id, active: false, d0: d, m0: m, d, m };
        } else if (state.kind === "idle" && event.touches.length === 1) {
          const { id, x, y } = event.touches[0];
          this.state = { kind: "pending", id, x0: x, y0: y, t0: event.t, x, y, moved: false };
        }
        return [];
      case "move":
        return this.move(event);
      case "end": {
        const actions: Action[] = [];
        if (state.kind === "pending") {
          const lifted = !event.touches.some((touch) => touch.id === state.id);
          if (lifted && event.touches.length === 0 && !state.moved && event.t - state.t0 < this.options.longPressMs) {
            actions.push({ kind: "click", button: "left", x: state.x, y: state.y });
          }
        }
        if (event.touches.length === 0) this.state = { kind: "idle" };
        else if (state.kind !== "idle") this.state = { kind: "dead" };
        return actions;
      }
      case "cancel":
        this.state = event.touches.length === 0 ? { kind: "idle" } : { kind: "dead" };
        return [];
    }
  }

  private move(event: TouchEvent): Action[] {
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
        // 超过 slop 就一直算“动过”：拖出去再拖回来也不是点击；也不再是长按。
        if (Math.hypot(touch.x - state.x0, touch.y - state.y0) <= this.options.slop && !state.moved) return [];
        state.moved = true;
        // 开始平移：从起点到当前的位移一并算上，视角才跟手。
        this.state = { kind: "drag", id: state.id, lastX: touch.x, lastY: touch.y };
        return [{ kind: "pan", dx: touch.x - state.x0, dy: touch.y - state.y0 }];
      }
      const action: Action = { kind: "pan", dx: touch.x - state.lastX, dy: touch.y - state.lastY };
      state.lastX = touch.x;
      state.lastY = touch.y;
      return [action];
    }
    if (state.kind === "two") {
      const a = event.touches.find((touch) => touch.id === state.a);
      const b = event.touches.find((touch) => touch.id === state.b);
      if (!a || !b) return [];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = midpoint(a, b);
      if (!state.active) {
        if (Math.abs(d - state.d0) < this.options.pinchSlop && Math.hypot(m.x - state.m0.x, m.y - state.m0.y) < this.options.pinchSlop) return [];
        // 激活时以当前为基线，不补发落指抖动阶段的变化，避免起手跳一下。
        state.active = true;
        state.d = d;
        state.m = m;
        return [];
      }
      const action: Action = { kind: "pinch", scale: state.d > 0 ? d / state.d : 1, from: state.m, to: m };
      state.d = d;
      state.m = m;
      return [action];
    }
    return [];
  }
}
