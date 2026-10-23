import type { MessageValues } from "./i18n-types.ts";

type Translate = (message: string, values?: MessageValues) => string;

type SubtitleOptions = {
  title: string;
  source?: "user" | "schedule";
  collaboration?: { creatorName: string; rootTitle: string };
  browserUrl?: string;
};

/** Browser activity takes precedence; malformed or non-web URLs leave the conversation subtitle intact. */
export function chatSubtitle({ title, source, collaboration, browserUrl }: SubtitleOptions, t: Translate): string {
  if (browserUrl) {
    try {
      const url = new URL(browserUrl);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.hostname) {
        return url.hostname.replace(/^www\./i, "");
      }
    } catch {
      // Browser tasks may carry an incomplete address while navigating.
    }
  }
  if (collaboration) {
    return t("{creator} 发起 · {title}", { creator: collaboration.creatorName, title: collaboration.rootTitle || t("新对话") });
  }
  return source === "schedule" ? t("定时 · {title}", { title: title || t("新对话") }) : title || t("新对话");
}

