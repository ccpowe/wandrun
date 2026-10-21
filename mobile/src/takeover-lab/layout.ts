// 鼠标模式左/右键钮的布局（纯 TS）。
// 钮叠在画面区下部、不占布局空间，所以画面区的尺寸与位置只由窗口、顶部标题行、底栏、键盘决定，不随模式变化
// （第 15 节“第三轮”）；本函数的输入里没有“模式”以外的任何会影响画面区的量，输出的矩形都在画面区内。

export type Rect = { left: number; top: number; width: number; height: number };
export type ButtonLayout = { left: Rect; right: Rect };

export const BUTTON_SIZE = 64;
export const COMPACT_SIZE = { width: 96, height: 40 };
export const BUTTON_MARGIN = 12;
export const BUTTON_GAP = 32;
/** 右侧滚轮条占的宽度：钮不能压到它。 */
export const WHEEL_WIDTH = 56;

/** 触控模式没有钮（返回 null）；鼠标模式两个钮在画面区底部水平居中（避开右侧滚轮条）。键盘弹出时用紧凑尺寸。 */
export function buttonLayout(mode: "mouse" | "touch", area: { w: number; h: number }, keyboard: boolean): ButtonLayout | null {
  if (mode === "touch") return null;
  const width = keyboard ? COMPACT_SIZE.width : BUTTON_SIZE;
  const height = keyboard ? COMPACT_SIZE.height : BUTTON_SIZE;
  // Centered on the full width as in TakeoverV2; the wheel sits at mid-height and never meets the buttons.
  const total = 2 * width + BUTTON_GAP;
  const left = Math.max(0, (area.w - total) / 2);
  const top = Math.max(0, area.h - height - BUTTON_MARGIN);
  return { left: { left, top, width, height }, right: { left: left + width + BUTTON_GAP, top, width, height } };
}
