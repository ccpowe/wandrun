// 浏览器接管的 CSS 像素与本地容器坐标换算。

import assert from "node:assert/strict";
import { test } from "node:test";

import { clampView, fit, IDENTITY_VIEW, pointerForViewport, toRemote, toScreen, wheelAnchor, zoomPan } from "../src/takeover-lab/geometry.ts";

const container = { w: 360, h: 640 };
const css = { w: 1280, h: 700 };

function near(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !~ ${expected}`);
}

test("宽页面放进竖屏容器：等比、居中、上下黑边", () => {
  const f = fit(container, css)!;
  near(f.s0, 360 / 1280);
  near(f.ox, 0);
  near(f.oy, (640 - 700 * f.s0) / 2);
});

test("容器或视口尺寸还没量出来时没有换算结果", () => {
  assert.equal(fit({ w: 0, h: 640 }, css), null);
  assert.equal(toRemote({ x: 1, y: 1 }, container, { w: 0, h: 0 }), null);
});

test("new viewport clamps the existing cursor even after its previous frame is discarded", () => {
  const large = { w: 1200, h: 900 };
  const small = { w: 400, h: 300 };
  const first = pointerForViewport(null, large.w, large.h);
  assert.deepEqual(first, { x: 600, y: 450 });
  const moved = { x: 1000, y: 700 };
  const bounded = pointerForViewport(moved, small.w, small.h);
  assert.deepEqual(bounded, { x: 400, y: 300 });
  assert.deepEqual(wheelAnchor("mouse", bounded, null, small), { x: 400, y: 300 });
  assert.equal(pointerForViewport(bounded, small.w, small.h), bounded, "unchanged frames need no cursor update");
  assert.deepEqual(pointerForViewport(null, small.w, small.h), { x: 200, y: 150 });
});

test("画面中心换算回页面中心", () => {
  const c = toRemote({ x: 180, y: 320 }, container, css)!;
  near(c.x, 640);
  near(c.y, 350);
});

test("画面四角（含边界）可换算，黑边上的点返回 null", () => {
  const f = fit(container, css)!;
  const top = f.oy;
  const bottom = f.oy + 700 * f.s0;
  const corner = toRemote({ x: 0, y: top + 1e-9 }, container, css)!;
  near(corner.x, 0);
  near(corner.y, 0, 1e-6);
  assert.notEqual(toRemote({ x: 360, y: bottom - 1e-9 }, container, css), null);
  assert.equal(toRemote({ x: 180, y: top - 1 }, container, css), null);
  assert.equal(toRemote({ x: 180, y: bottom + 1 }, container, css), null);
});

test("竖页面放进横屏容器：左右黑边", () => {
  const wide = { w: 800, h: 360 };
  const tall = { w: 800, h: 1000 };
  const f = fit(wide, tall)!;
  near(f.s0, 0.36);
  near(f.ox, (800 - 800 * 0.36) / 2);
  assert.equal(toRemote({ x: 10, y: 180 }, wide, tall), null);
  const c = toRemote({ x: 400, y: 180 }, wide, tall)!;
  near(c.x, 400);
  near(c.y, 500);
});

test("本地缩放与平移：z=2、T=(-100,-50) 下的反算", () => {
  const view = { z: 2, tx: -100, ty: -50 };
  // 容器内 p 对应缩放前 q = (p − T) / z；先用 toScreen 得到某个页面点现在的位置，再反算回去。
  const target = { x: 300, y: 200 };
  const p = toScreen(target, container, css, view)!;
  const back = toRemote(p, container, css, view)!;
  near(back.x, target.x, 1e-9);
  near(back.y, target.y, 1e-9);
  // 放大后屏幕上同一个位置对应的页面点不同于未放大时。
  const plain = toRemote(p, container, css);
  assert.ok(plain === null || Math.abs(plain.x - target.x) > 1);
});

test("往返：网格上的页面点经 toScreen / toRemote 不变（多种视图）", () => {
  const views = [
    { z: 1, tx: 0, ty: 0 },
    { z: 3, tx: -400, ty: -900 },
    { z: 6, tx: -1500, ty: -2200 },
  ];
  for (const view of views) {
    for (let x = 0; x <= 1280; x += 160) {
      for (let y = 0; y <= 700; y += 70) {
        const p = toScreen({ x, y }, container, css, view)!;
        const back = toRemote(p, container, css, view)!;
        near(back.x, x, 1e-7);
        near(back.y, y, 1e-7);
      }
    }
  }
});

test("焦点缩放：焦点下的画面点缩放前后不动", () => {
  // 缩放后图像仍铺满的轴上，焦点不动；此例焦点取在容器中线，两个轴都不受平移限制影响。
  const focus = { x: 180, y: 320 };
  const before = toRemote(focus, container, css)!;
  const view = zoomPan(IDENTITY_VIEW, focus, focus, 2.5, container, css);
  near(view.z, 2.5);
  const after = toRemote(focus, container, css, view)!;
  near(after.x, before.x, 1e-9);
  near(after.y, before.y, 1e-9);
});

test("缩放比例夹在 1~6", () => {
  const f = { x: 180, y: 350 };
  assert.equal(zoomPan(IDENTITY_VIEW, f, f, 100, container, css).z, 6);
  const z3 = zoomPan(IDENTITY_VIEW, f, f, 3, container, css);
  assert.equal(zoomPan(z3, f, f, 0.01, container, css).z, 1);
});

test("缩放后点击换算：放大 3 倍的视图里，手指位置对应的页面点跟随缩放", () => {
  const focus = { x: 100, y: 200 };
  const view = zoomPan(IDENTITY_VIEW, focus, focus, 3, container, css);
  // 焦点下的页面点不变；离焦点 30dp 的点只对应 10dp（未放大）的页面距离。
  const a = toRemote(focus, container, css, view)!;
  const b = toRemote({ x: focus.x + 30, y: focus.y }, container, css, view)!;
  const f = fit(container, css)!;
  near(b.x - a.x, 30 / (3 * f.s0), 1e-9);
});

test("平移限制：放大后不能拖出比黑边更多的空白", () => {
  const f = fit(container, css)!;
  const zoomed = zoomPan(IDENTITY_VIEW, { x: 180, y: 350 }, { x: 180, y: 350 }, 4, container, css);
  // 向右猛拖：左边缘不能离开容器左边界（图像左边缘 ≤ 0 的反面：不露出空白）。
  const right = zoomPan(zoomed, { x: 0, y: 0 }, { x: 5000, y: 5000 }, 1, container, css);
  assert.ok(right.tx + right.z * f.ox <= 1e-9);
  assert.ok(right.ty + right.z * f.oy <= 1e-9);
  // 向左猛拖：右/下边缘不能进到容器之内。
  const left = zoomPan(zoomed, { x: 0, y: 0 }, { x: -5000, y: -5000 }, 1, container, css);
  assert.ok(left.tx + left.z * (f.ox + 1280 * f.s0) >= container.w - 1e-9);
  assert.ok(left.ty + left.z * (f.oy + 700 * f.s0) >= container.h - 1e-9);
});

test("未放大（z=1）时平移无效，图像保持居中", () => {
  const view = zoomPan(IDENTITY_VIEW, { x: 0, y: 0 }, { x: 80, y: -60 }, 1, container, css);
  near(view.z, 1);
  near(view.tx, 0, 1e-9);
  near(view.ty, 0, 1e-9);
});

test("图像比容器小的轴居中：z=2 时竖向仍小于容器则不能上下移动", () => {
  // 1280x700 放进 360 宽容器：高度 ≈197dp；z=2 后 ≈394dp，比容器高 640 小 → 竖向居中。
  const view = zoomPan(IDENTITY_VIEW, { x: 0, y: 0 }, { x: 0, y: 200 }, 2, container, css);
  const centered = zoomPan(IDENTITY_VIEW, { x: 0, y: 0 }, { x: 0, y: 0 }, 2, container, css);
  near(view.ty, centered.ty, 1e-9);
});

test("clampView 对任意视图幂等", () => {
  const messy = { z: 3, tx: 777, ty: -4000 };
  const once = clampView(messy, container, css);
  const twice = clampView(once, container, css);
  near(once.tx, twice.tx, 1e-9);
  near(once.ty, twice.ty, 1e-9);
});

test("钳位后的视图下，往返仍一致（缩放+平移+点击换算）", () => {
  let view = IDENTITY_VIEW;
  view = zoomPan(view, { x: 90, y: 200 }, { x: 90, y: 200 }, 2, container, css);
  view = zoomPan(view, { x: 90, y: 200 }, { x: 150, y: 260 }, 1.7, container, css);
  const target = { x: 640, y: 350 };
  const p = toScreen(target, container, css, view)!;
  const back = toRemote(p, container, css, view);
  if (back) {
    near(back.x, target.x, 1e-7);
    near(back.y, target.y, 1e-7);
  }
});

test("焦点在画面边缘缩放：边缘点不动，且仍不露出空白", () => {
  const focus = { x: 5, y: 320 };
  const before = toRemote(focus, container, css)!;
  const view = zoomPan(IDENTITY_VIEW, focus, focus, 4, container, css);
  const after = toRemote(focus, container, css, view)!;
  near(after.x, before.x, 1e-9);
  assert.ok(view.tx <= 1e-9);
});

test("两指同时缩放并平移：from 下的画面点落到 to", () => {
  const from = { x: 150, y: 320 };
  const to = { x: 170, y: 330 };
  const before = toRemote(from, container, css)!;
  const view = zoomPan(IDENTITY_VIEW, from, to, 3, container, css);
  const after = toRemote(to, container, css, view)!;
  near(after.x, before.x, 1e-9);
});
