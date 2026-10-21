// 鼠标模式：手势状态机（mouse-gestures.ts）与指针换算（geometry.ts）。node --test test/

import assert from "node:assert/strict";
import { test } from "node:test";

import { clampView, IDENTITY_VIEW, movePointer, toRemote, toRemoteClamped, toScreen, wheelAnchor, zoomPan } from "../src/takeover-lab/geometry.ts";
import type { TouchEvent } from "../src/takeover-lab/gestures.ts";
import { type MouseAction, MouseModeRecognizer, WheelControl, wheelRate } from "../src/takeover-lab/mouse-gestures.ts";

type P = [number, number];
const finger = (id: number | string, [x, y]: P) => ({ id: String(id), x, y });
const start = (t: number, ...fs: Array<[number, P]>): TouchEvent => ({ type: "start", touches: fs.map(([id, p]) => finger(id, p)), t });
const move = (t: number, ...fs: Array<[number, P]>): TouchEvent => ({ type: "move", touches: fs.map(([id, p]) => finger(id, p)), t });
const end = (t: number, ...fs: Array<[number, P]>): TouchEvent => ({ type: "end", touches: fs.map(([id, p]) => finger(id, p)), t });

function run(events: TouchEvent[]): MouseAction[] {
  const recognizer = new MouseModeRecognizer();
  return events.flatMap((event) => recognizer.handle(event));
}
const sumMove = (actions: MouseAction[]) =>
  actions.reduce((sum, a) => (a.kind === "move" ? { dx: sum.dx + a.dx, dy: sum.dy + a.dy } : sum), { dx: 0, dy: 0 });

// ---- 指针换算 ----

const css = { w: 1280, h: 800 };
const box = { w: 400, h: 800 }; // s0 = 400/1280 = 0.3125

test("指针移动：屏幕上的移动量与手指一致，与缩放无关（dp → CSS 用 1/(z·s0)）", () => {
  const s0 = 400 / 1280;
  for (const z of [1, 2, 4]) {
    const view = { z, tx: 0, ty: 0 };
    const from = { x: 640, y: 400 };
    const to = movePointer(from, 30, -20, box, css, view);
    assert.ok(Math.abs(to.x - from.x - 30 / (z * s0)) < 1e-9);
    assert.ok(Math.abs(to.y - from.y + 20 / (z * s0)) < 1e-9);
    // 屏幕上指针位置的变化 = 手指位移
    const a = toScreen(from, box, css, view)!;
    const b = toScreen(to, box, css, view)!;
    assert.ok(Math.abs(b.x - a.x - 30) < 1e-9 && Math.abs(b.y - a.y + 20) < 1e-9);
  }
});

test("指针移动：增益参与，结果夹在视口内", () => {
  const half = movePointer({ x: 100, y: 100 }, 10, 0, box, css, IDENTITY_VIEW, 0.5);
  assert.ok(Math.abs(half.x - (100 + 5 / (400 / 1280))) < 1e-9);
  assert.deepEqual(movePointer({ x: 10, y: 790 }, -1000, 1000, box, css, IDENTITY_VIEW), { x: 0, y: 800 });
  assert.deepEqual(movePointer({ x: 1, y: 1 }, 5, 5, { w: 0, h: 0 }, css, IDENTITY_VIEW), { x: 1, y: 1 });
});

test("落点换算（触控模式记录最后触点用）：落点换算到远端 CSS（含缩放平移），黑边钳到边缘", () => {
  const view = { z: 2, tx: -100, ty: -300 };
  assert.ok(toRemote({ x: 200, y: 400 }, box, css, view));
  assert.deepEqual(toRemoteClamped({ x: 200, y: 400 }, box, css, view), toRemote({ x: 200, y: 400 }, box, css, view));
  assert.deepEqual(toRemoteClamped({ x: -50, y: 9999 }, box, css, IDENTITY_VIEW), { x: 0, y: 800 });
  assert.equal(toRemoteClamped({ x: 1, y: 1 }, { w: 0, h: 0 }, css), null);
});

// ---- 画面区手势 ----

test("单指滑动：相对移动，起点到当前的位移计入（dp），不是点击", () => {
  const actions = run([start(0, [1, [100, 300]]), move(20, [1, [100, 320]]), move(40, [1, [100, 330]]), end(60, )]);
  assert.ok(actions.every((a) => a.kind === "move" && !a.dragging));
  assert.deepEqual(sumMove(actions), { dx: 0, dy: 30 });
});

test("指针移动按 16ms 合并，抬起时补发剩余", () => {
  const actions = run([
    start(0, [1, [0, 0]]),
    move(5, [1, [20, 0]]), // 越过 slop：首批立即发
    move(10, [1, [25, 0]]), // 距上次 <16ms：攒着
    move(12, [1, [30, 0]]),
    end(14),
  ]);
  assert.equal(actions.length, 2);
  assert.deepEqual(sumMove(actions), { dx: 30, dy: 0 });
});

test("轻点（≤10dp、<500ms）= 在指针处左键单击，不移动指针", () => {
  assert.deepEqual(run([start(0, [1, [100, 200]]), move(30, [1, [104, 207]]), end(90)]), [{ kind: "click", button: "left", count: 1 }]);
});

test("双击（轻点）：快速两次轻点 count=2；间隔过长或其间指针动过则重新计 1", () => {
  const r = new MouseModeRecognizer();
  const tap = (t: number): TouchEvent[] => [start(t, [1, [10, 10]]), end(t + 50)];
  const counts = (events: TouchEvent[]) => events.flatMap((e) => r.handle(e)).map((a) => (a.kind === "click" ? a.count : -1));
  assert.deepEqual(counts([...tap(0), ...tap(200)]), [1, 2]);
  assert.deepEqual(counts(tap(1000)), [1]); // 距上次 >300ms
  assert.deepEqual(counts([...tap(1100), start(1200, [1, [0, 0]]), move(1210, [1, [30, 0]]), end(1220), ...tap(1300)]), [2, -1, 1]); // 指针动过（-1 是 move）：下一次轻点不是双击
});

test("双击（按钮）：快速两次点左键钮 count=2；轻点与按钮连击互通", () => {
  const r = new MouseModeRecognizer();
  assert.deepEqual(r.buttonDown("left", "b", 0), [{ kind: "press", button: "left", count: 1 }]);
  r.buttonUp("left", "b", 60);
  assert.deepEqual([start(200, [1, [3, 3]]), end(240)].flatMap((e) => r.handle(e)), [{ kind: "click", button: "left", count: 2 }]);
  const r2 = new MouseModeRecognizer();
  [start(0, [1, [3, 3]]), end(40)].forEach((e) => r2.handle(e));
  assert.deepEqual(r2.buttonDown("left", "b", 150), [{ kind: "press", button: "left", count: 2 }]);
});

test("按住 500ms 以上不是点击；位移超过 slop 拖回原处也不是", () => {
  assert.deepEqual(run([start(0, [1, [1, 1]]), end(500)]), []);
  const dragged = run([start(0, [1, [100, 200]]), move(20, [1, [100, 215]]), move(40, [1, [100, 201]]), end(60)]);
  assert.ok(dragged.every((a) => a.kind === "move"));
});

test("第二指落下：取消待定轻点，双指只发 pinch，全部抬起前无点击", () => {
  const r = new MouseModeRecognizer();
  const out: MouseAction[] = [];
  for (const e of [
    start(0, [1, [100, 200]]),
    start(30, [1, [100, 200]], [2, [200, 200]]),
    move(60, [1, [90, 200]], [2, [210, 200]]), // 越过 pinchSlop，激活
    move(80, [1, [80, 200]], [2, [220, 200]]),
    end(100, [1, [80, 200]]),
    end(120),
  ]) out.push(...r.handle(e));
  assert.deepEqual(out.map((a) => a.kind), ["pinch"]);
  assert.deepEqual(r.handle(start(500, [3, [5, 5]])).concat(r.handle(end(540))).map((a) => a.kind), ["click"]); // 恢复后正常
});

test("第二指落下时已滑出的位移先生效", () => {
  const out = run([start(0, [1, [0, 0]]), move(5, [1, [20, 0]]), move(8, [1, [30, 0]]), start(10, [1, [30, 0]], [2, [90, 0]])]);
  assert.deepEqual(sumMove(out), { dx: 30, dy: 0 });
});

test("画面区单指拖动只移动指针，不再有 pan 动作", () => {
  const out = run([start(0, [1, [100, 300]]), move(2, [1, [100, 320]]), move(40, [1, [90, 330]]), end(60)]);
  assert.ok(out.length > 0 && out.every((a) => a.kind === "move"));
});

test("pan 动作（触控模式）按 zoomPan(k=1) 应用：跟手、受限，z=1 无效果", () => {
  const view = clampView({ z: 3, tx: -200, ty: -200 }, box, css); // 高度方向画面小于容器：居中不动
  const next = zoomPan(view, { x: 0, y: 0 }, { x: 15, y: -10 }, 1, box, css);
  assert.deepEqual({ tx: next.tx, ty: next.ty }, { tx: -185, ty: view.ty });
  assert.deepEqual(zoomPan(IDENTITY_VIEW, { x: 0, y: 0 }, { x: 50, y: 50 }, 1, box, css), IDENTITY_VIEW);
});

// ---- 跨模式：指针位置与滚轮落点（视图层用到的纯函数）----

test("模式切换保留指针：指针存远端 CSS 坐标，缩放平移后仍在页面同一处；触控模式滚轮不看指针", () => {
  const pointer = { x: 300, y: 200 };
  const view = { z: 2, tx: -50, ty: 0 };
  const screen = toScreen(pointer, box, css, view)!;
  assert.deepEqual(toRemote(screen, box, css, view), pointer); // 往返不变
  // 鼠标模式落点 = 指针；触控模式 = 最后触点，指针不参与
  assert.deepEqual(wheelAnchor("mouse", pointer, { x: 9, y: 9 }, css), pointer);
  assert.deepEqual(wheelAnchor("touch", pointer, { x: 9, y: 9 }, css), { x: 9, y: 9 });
});

test("触控模式滚轮落点：尚无触点用画面中心；触控点击不改指针（落点只读，不写）", () => {
  assert.deepEqual(wheelAnchor("touch", { x: 1, y: 1 }, null, css), { x: 640, y: 400 });
  assert.deepEqual(wheelAnchor("mouse", null, { x: 1, y: 1 }, css), { x: 640, y: 400 });
  // 触控识别器只产生 click/pan/pinch，没有改指针的动作；指针只来自鼠标识别器的 move。
});

// ---- 按钮与拖动 ----

test("左键按钮：按下 press、抬起 release，两次快速点按 count=2", () => {
  const r = new MouseModeRecognizer();
  assert.deepEqual(r.buttonDown("left", "b", 0), [{ kind: "press", button: "left", count: 1 }]);
  assert.deepEqual(r.buttonUp("left", "b", 60), [{ kind: "release", button: "left", count: 1 }]);
  assert.deepEqual(r.buttonDown("left", "b", 200), [{ kind: "press", button: "left", count: 2 }]);
  assert.deepEqual(r.buttonUp("left", "b", 250), [{ kind: "release", button: "left", count: 2 }]);
});

test("右键按钮：抬起时单击；取消不点击", () => {
  const r = new MouseModeRecognizer();
  assert.deepEqual(r.buttonDown("right", "b", 0), []);
  assert.deepEqual(r.buttonUp("right", "b", 70), [{ kind: "click", button: "right", count: 1 }]);
  r.buttonDown("right", "b", 1000);
  assert.deepEqual(r.buttonUp("right", "b", 1100, true), []);
});

test("按住左键钮同时画面区滑动 = 拖动：press → move(dragging) → release，无死区、不产生点击", () => {
  const r = new MouseModeRecognizer();
  const out: MouseAction[] = [];
  out.push(...r.buttonDown("left", "btn", 0));
  out.push(...r.handle(start(100, [7, [200, 300]])));
  out.push(...r.handle(move(120, [7, [203, 300]]))); // 3dp 就开始移动
  out.push(...r.handle(move(150, [7, [230, 300]])));
  out.push(...r.handle(end(170)));
  out.push(...r.buttonUp("left", "btn", 200));
  assert.deepEqual(out.map((a) => a.kind), ["press", "move", "move", "release"]);
  assert.ok(out.filter((a) => a.kind === "move").every((a) => a.kind === "move" && a.dragging));
  assert.deepEqual(sumMove(out), { dx: 30, dy: 0 });
});

test("松开左键钮时，未发出的位移先于 release 落到指针上；拖过之后的快速按下不是双击", () => {
  const r = new MouseModeRecognizer();
  r.buttonDown("left", "btn", 0);
  r.handle(start(10, [7, [0, 0]]));
  r.handle(move(20, [7, [10, 0]]));
  r.handle(move(25, [7, [20, 0]])); // 距上次 <16ms：攒着
  const up = r.buttonUp("left", "btn", 30);
  assert.deepEqual(up.map((a) => a.kind), ["move", "release"]);
  assert.deepEqual(r.buttonDown("left", "btn", 100), [{ kind: "press", button: "left", count: 1 }]);
});

test("左键按住时，画面区轻点不单击；切换模式 reset 会松开左键", () => {
  const r = new MouseModeRecognizer();
  r.buttonDown("left", "btn", 0);
  assert.deepEqual([...r.handle(start(10, [7, [5, 5]])), ...r.handle(end(40))], []);
  assert.deepEqual(r.reset(), [{ kind: "release", button: "left", count: 1 }]);
  assert.equal(r.leftHeld, false);
});

// ---- 滚轮控件 ----

test("滚轮速率：死区内为 0，线性增长到满偏，方向与偏移同号", () => {
  assert.equal(wheelRate(5), 0);
  assert.equal(wheelRate(-6), 0);
  assert.equal(wheelRate(68), 2000);
  assert.equal(wheelRate(-68), -2000);
  assert.ok(Math.abs(wheelRate(37) - 1000) < 1e-9); // (37-6)/(68-6) = 0.5
});

test("滚轮控件：偏离越远滚得越快，偏移夹在行程内，松手回中并停止", () => {
  const w = new WheelControl();
  w.handle({ type: "start", touches: [finger(1, [0, 500])], t: 0 });
  assert.equal(w.tick(1000), 0); // 第一次 tick 只建立时间基线
  w.handle({ type: "move", touches: [finger(1, [0, 537])], t: 0 });
  assert.equal(w.offset, 37);
  assert.ok(Math.abs(w.tick(1016) - 16) < 1e-9); // 1000 px/s × 16ms
  w.handle({ type: "move", touches: [finger(1, [0, 900])], t: 0 });
  assert.equal(w.offset, 68);
  assert.ok(Math.abs(w.tick(1032) - 32) < 1e-9); // 2000 px/s × 16ms
  assert.ok(Math.abs(w.tick(2000) - 100) < 1e-9); // 卡顿后 dt 封顶 50ms
  w.handle({ type: "move", touches: [finger(1, [0, 400])], t: 0 });
  assert.ok(w.tick(2016) < 0); // 往上拖 = 向上滚
  w.handle({ type: "end", touches: [], t: 0 });
  assert.equal(w.offset, 0);
  assert.equal(w.active, false);
  assert.equal(w.tick(2032), 0);
});

test("滚轮控件：只跟踪第一个触点，别的手指抬起不影响", () => {
  const w = new WheelControl();
  w.handle({ type: "start", touches: [finger(1, [0, 100])], t: 0 });
  w.handle({ type: "start", touches: [finger(1, [0, 100]), finger(2, [0, 0])], t: 0 });
  w.handle({ type: "move", touches: [finger(1, [0, 130]), finger(2, [0, -50])], t: 0 });
  assert.equal(w.offset, 30);
  w.handle({ type: "end", touches: [finger(1, [0, 130])], t: 0 });
  assert.equal(w.active, true);
});
