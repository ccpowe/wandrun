import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 自定义字号必须登记，否则合并器会把 text-title / text-body / text-caption 当颜色，
// 加前景色时丢掉字号，或加字号时丢掉前景色，并留下默认 text-base。
const merge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["title", "body", "caption"] }] } },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
