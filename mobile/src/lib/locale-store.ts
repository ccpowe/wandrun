import { useSyncExternalStore } from "react";
import type { Language } from "./i18n-types.ts";

let language: Language = "zh";
const listeners = new Set<() => void>();

export const getLanguage = (): Language => language;
export const subscribeLanguage = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Preferences owns persistence. Applying a language never replaces a session or navigator. */
export function applyLanguage(next: Language): void {
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener();
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

export function getLocale(): "zh-CN" | "en-US" {
  return language === "zh" ? "zh-CN" : "en-US";
}
