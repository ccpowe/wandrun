// 画面区（dp）与远端页面（CSS 像素）之间的换算。没有 React 依赖，公式见
// docs/research/mobile-takeover-prototype-2026-10-08.md 第 5 节。
//
//   q = o + s0 · c         未缩放时在容器内的位置
//   p = T + z · q          叠加本地缩放 z 与平移 T 之后（手指/光标在容器内的位置）
//
// 反算：c = ((p − T) / z − o) / s0。滚动偏移不参与：滚动已经体现在画面里。

export type Size = { w: number; h: number };
export type Point = { x: number; y: number };
/** 本地缩放与平移；只影响怎么显示，不发给远端。 */
export type View = { z: number; tx: number; ty: number };

export const IDENTITY_VIEW: View = { z: 1, tx: 0, ty: 0 };

export type Fit = {
  /** 适配缩放：一个远端 CSS 像素占多少 dp。 */
  s0: number;
  /** 适配后画面左上角在容器里的位置（黑边偏移）。 */
  ox: number;
  oy: number;
};

/** 把远端视口等比放进容器并居中；任何一个尺寸还没量出来（≤ 0）就没有结果。 */
export function fit(container: Size, css: Size): Fit | null {
  if (container.w <= 0 || container.h <= 0 || css.w <= 0 || css.h <= 0) return null;
  const s0 = Math.min(container.w / css.w, container.h / css.h);
  return { s0, ox: (container.w - css.w * s0) / 2, oy: (container.h - css.h * s0) / 2 };
}

/** 容器内的点 → 远端 CSS 坐标；落在黑边（画面之外）返回 null。 */
export function toRemote(p: Point, container: Size, css: Size, view: View = IDENTITY_VIEW): Point | null {
  const f = fit(container, css);
  if (!f) return null;
  const qx = (p.x - view.tx) / view.z;
  const qy = (p.y - view.ty) / view.z;
  const c = { x: (qx - f.ox) / f.s0, y: (qy - f.oy) / f.s0 };
  return c.x < 0 || c.y < 0 || c.x > css.w || c.y > css.h ? null : c;
}

/** 远端 CSS 坐标 → 容器内的点（toRemote 的逆；鼠标模式画光标用）。 */
export function toScreen(c: Point, container: Size, css: Size, view: View = IDENTITY_VIEW): Point | null {
  const f = fit(container, css);
  if (!f) return null;
  return { x: view.tx + view.z * (f.ox + f.s0 * c.x), y: view.ty + view.z * (f.oy + f.s0 * c.y) };
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

/** 一个轴上的平移限制：缩放后的图像 [t+z·o, t+z·(o+len)] 不露出比黑边更多的空白；图像比容器小的轴居中不动。 */
function clampAxis(t: number, z: number, o: number, len: number, extent: number): number {
  const size = z * len;
  if (size <= extent) return extent / 2 - z * (o + len / 2);
  return Math.min(-z * o, Math.max(extent - z * (o + len), t));
}

/** 把平移限制在合法范围内（缩放比例原样保留）；尺寸未知时原样返回。 */
export function clampView(view: View, container: Size, css: Size): View {
  const f = fit(container, css);
  if (!f) return view;
  return {
    z: view.z,
    tx: clampAxis(view.tx, view.z, f.ox, css.w * f.s0, container.w),
    ty: clampAxis(view.ty, view.z, f.oy, css.h * f.s0, container.h),
  };
}

/**
 * 双指一步：缩放比例乘 k（夹在 1~6），并让“上一次中点 from 下的画面点”跟到新中点 to。
 * 以 from 为焦点缩放就是 to = from；只平移就是 k = 1。结果再做平移限制。
 *   z' = clamp(z·k)，T' = to − (from − T) · z'/z
 */
export function zoomPan(view: View, from: Point, to: Point, k: number, container: Size, css: Size): View {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.z * k));
  const ratio = z / view.z;
  return clampView({ z, tx: to.x - (from.x - view.tx) * ratio, ty: to.y - (from.y - view.ty) * ratio }, container, css);
}

// ---- 鼠标模式的指针（位置存远端 CSS 坐标）----

/** 指针增益：1.0 时指针在屏幕上的移动与手指一致（与当前缩放无关）。集中在这里便于真机调参。 */
export const POINTER_GAIN = 1.0;

export const clampPoint = (c: Point, css: Size): Point => ({
  x: Math.min(css.w, Math.max(0, c.x)),
  y: Math.min(css.h, Math.max(0, c.y)),
});

/** A newly displayed viewport always owns the cursor bounds, even when the old frame was discarded. */
export function pointerForViewport(pointer: Point | null, width: number, height: number): Point {
  if (!pointer) return { x: width / 2, y: height / 2 };
  if (pointer.x >= 0 && pointer.x <= width && pointer.y >= 0 && pointer.y <= height) return pointer;
  return clampPoint(pointer, { w: width, h: height });
}

/** 手指移动 (dx, dy) dp → 指针移动 (dx, dy)·gain/(z·s0) 个 CSS 像素，结果夹在视口内。 */
export function movePointer(pointer: Point, dx: number, dy: number, container: Size, css: Size, view: View, gain: number = POINTER_GAIN): Point {
  const f = fit(container, css);
  if (!f) return pointer;
  const k = gain / (view.z * f.s0);
  return clampPoint({ x: pointer.x + dx * k, y: pointer.y + dy * k }, css);
}

/**
 * 滚轮条的落点（远端 CSS 坐标）：鼠标模式 = 指针；触控模式 = 最后一次触点；都还没有时用画面中心。
 */
export function wheelAnchor(mode: "mouse" | "touch", pointer: Point | null, lastTouch: Point | null, css: Size): Point {
  return (mode === "mouse" ? pointer : lastTouch) ?? { x: css.w / 2, y: css.h / 2 };
}

/** 容器内的点 → 远端 CSS 坐标，落在黑边时钳到画面边缘（触控模式记录“最后触点”用）；尺寸未知返回 null。 */
export function toRemoteClamped(p: Point, container: Size, css: Size, view: View = IDENTITY_VIEW): Point | null {
  const f = fit(container, css);
  if (!f) return null;
  const qx = (p.x - view.tx) / view.z;
  const qy = (p.y - view.ty) / view.z;
  return clampPoint({ x: (qx - f.ox) / f.s0, y: (qy - f.oy) / f.s0 }, css);
}

/** 容器内的点 → 远端 CSS 坐标，不钳位也不判黑边（可能落在画面外）；落点可视化用。尺寸未知返回 null。 */
export function toRemoteRaw(p: Point, container: Size, css: Size, view: View = IDENTITY_VIEW): Point | null {
  const f = fit(container, css);
  if (!f) return null;
  return { x: ((p.x - view.tx) / view.z - f.ox) / f.s0, y: ((p.y - view.ty) / view.z - f.oy) / f.s0 };
}
