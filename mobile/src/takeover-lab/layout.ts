// 接管页控件与画面的几何（纯 TS，L1：test/browser_protocol.test.ts）。

export type Rect = { left: number; top: number; width: number; height: number };
export type ButtonLayout = { left: Rect; right: Rect };

export const BUTTON_SIZE = 52;
export const BUTTON_MARGIN = 12;
export const BUTTON_GAP = 16;

/** 触控模式没有钮（返回 null）；鼠标模式两个钮在给定区域底部、以区域中线水平居中（browser.B8）。 */
export function buttonLayout(mode: "mouse" | "touch", area: { w: number; h: number }): ButtonLayout | null {
  if (mode === "touch") return null;
  const total = 2 * BUTTON_SIZE + BUTTON_GAP;
  const left = Math.max(0, (area.w - total) / 2);
  const top = Math.max(0, area.h - BUTTON_SIZE - BUTTON_MARGIN);
  return { left: { left, top, width: BUTTON_SIZE, height: BUTTON_SIZE }, right: { left: left + BUTTON_SIZE + BUTTON_GAP, top, width: BUTTON_SIZE, height: BUTTON_SIZE } };
}

/**
 * 竖屏画面位置（browser.B8）：键盘关闭时以整屏为准垂直居中（`above` / `below` 为舞台到屏幕上下沿的距离），
 * 会压到按钮带才上移，放不下才缩小；键盘弹起时沿原机制在剩余舞台内居中。
 */
export function portraitPicture(area: { w: number; h: number }, edges: { above: number; below: number }, ratio: number, band: number, keyboard: boolean) {
  const room = Math.max(0, area.h - band);
  const height = Math.min(room, area.w * ratio);
  const centered = keyboard ? (area.h - height) / 2 : (area.h + edges.above + edges.below - height) / 2 - edges.above;
  return { top: Math.max(0, Math.min(centered, room - height)), height };
}

/** 横屏 B 右侧控件列（browser.B6 / W7）：交还 48、左右键 52 + 12 + 52、底栏三项；三组在列中部聚拢。 */
export const CONTROL_COLUMN = { handback: 48, pairGap: 12, groupGap: 24, padding: 12, dockIcon: 24, dockPadding: 4, dockLabelGap: 4, dockLabel: 16 } as const;

/**
 * 按列实际高度决定间距与是否紧凑（browser.W7，待确认）：先缩小组间距与上下留白；
 * 带文字的底栏仍放不下时底栏只显示图标；仍放不下由列内滚动兜底（调用者用 ScrollView）。
 * `height` 为 0（尚未测量）时按完整布局。
 */
export function controlColumnLayout(height: number, fontScale = 1) {
  const c = CONTROL_COLUMN;
  const fixed = c.handback + 2 * BUTTON_SIZE + c.pairGap;
  const fullItem = c.dockPadding * 2 + c.dockIcon + c.dockLabelGap + c.dockLabel * fontScale;
  const compactItem = c.dockPadding * 2 + c.dockIcon;
  const compact = height > 0 && height < fixed + 3 * fullItem;
  const content = fixed + 3 * (compact ? compactItem : fullItem);
  const spare = height > 0 ? Math.max(0, height - content) : 2 * (c.padding + c.groupGap);
  // Spare room goes to the two group gaps first, then the column's top/bottom padding.
  const gap = Math.min(c.groupGap, spare / 2);
  const padding = Math.min(c.padding, (spare - 2 * gap) / 2);
  return { compact, gap, padding, content };
}
