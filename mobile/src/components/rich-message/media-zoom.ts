export type Point = { x: number; y: number };
export type Size = { w: number; h: number };
export type ZoomView = { z: number; tx: number; ty: number };
export const RESET_ZOOM: ZoomView = { z: 1, tx: 0, ty: 0 };
export const MAX_MEDIA_ZOOM = 8;

/** Clamp the visible image, not its letterboxed container; a short axis stays centered. */
export function boundMediaZoom(view: ZoomView, box: Size, image: Size): ZoomView {
  'worklet';
  if (box.w <= 0 || box.h <= 0 || image.w <= 0 || image.h <= 0) return view;
  const fit = Math.min(box.w / image.w, box.h / image.h);
  const w = image.w * fit;
  const h = image.h * fit;
  const ox = (box.w - w) / 2;
  const oy = (box.h - h) / 2;
  const x = w * view.z <= box.w ? box.w / 2 - view.z * (ox + w / 2) : Math.min(-view.z * ox, Math.max(box.w - view.z * (ox + w), view.tx));
  const y = h * view.z <= box.h ? box.h / 2 - view.z * (oy + h / 2) : Math.min(-view.z * oy, Math.max(box.h - view.z * (oy + h), view.ty));
  return { z: view.z, tx: x, ty: y };
}

/** Move the previous focal image point under the new fingers, bounded to 1–8×. */
export function moveMediaZoom(view: ZoomView, from: Point, to: Point, scale: number, box: Size, image: Size): ZoomView {
  'worklet';
  const z = Math.max(1, Math.min(MAX_MEDIA_ZOOM, view.z * scale));
  const ratio = z / view.z;
  return boundMediaZoom({ z, tx: to.x - (from.x - view.tx) * ratio, ty: to.y - (from.y - view.ty) * ratio }, box, image);
}
