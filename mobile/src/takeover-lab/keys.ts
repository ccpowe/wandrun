// 特殊键映射：手机发完整的 CDP Input.dispatchKeyEvent 描述符，正式画面通道直接转交。
// 描述符的取值参照 DOM KeyboardEvent 与 Windows 虚拟键码（Chrome 用 windowsVirtualKeyCode 决定编辑命令与 keyCode）。

export type KeyName = "Enter" | "Tab" | "Escape" | "Backspace" | "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export type KeyDescriptor = {
  key: string;
  code: string;
  /** Windows 虚拟键码，对应 DOM 的 keyCode。 */
  vk: number;
  /** 有 text 的键按 keyDown（会产生 char 事件，input 里才会提交/换行），否则按 rawKeyDown（同 Puppeteer）。 */
  text?: string;
};

export const KEYS: Record<KeyName, KeyDescriptor> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
};

/** 键盘上方辅助键行的顺序与标签（参照 Cue 终端页）。 */
export const HELPER_KEYS: { name: KeyName; label: string }[] = [
  { name: "Tab", label: "Tab" },
  { name: "Escape", label: "Esc" },
  { name: "ArrowLeft", label: "←" },
  { name: "ArrowRight", label: "→" },
  { name: "ArrowUp", label: "↑" },
  { name: "ArrowDown", label: "↓" },
];
