import { agentsMessages } from "../locales/agents.ts";
import { browserMessages } from "../locales/browser.ts";
import { chatMessages } from "../locales/chat.ts";
import { commonMessages } from "../locales/common.ts";
import { filesMessages } from "../locales/files.ts";
import { gatewayMessages } from "../locales/gateway.ts";
import { settingsMessages } from "../locales/settings.ts";
import type { Language, MessageCatalog, MessageValues, Translation } from "./i18n-types.ts";
import { getLanguage, getLocale, useLanguage } from "./locale-store.ts";

export { getLanguage, getLocale } from "./locale-store.ts";
export type { Language, MessageCatalog, MessageValues, Translation } from "./i18n-types.ts";

export const messages: MessageCatalog = {
  ...gatewayMessages, ...agentsMessages, ...browserMessages, ...chatMessages, ...filesMessages, ...settingsMessages, ...commonMessages,
};

type Pattern = { match: RegExp; names: string[]; source: string; translation: Translation; specificity: number };
const reverse: Record<string, string> = {};
const patterns: Pattern[] = [];
const placeholder = /\{([a-z][a-z0-9_]*)\}/gi;
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function addPattern(text: string, source: string, translation: Translation): void {
  const names: string[] = [];
  let expression = "^";
  let start = 0;
  let specificity = 0;
  for (const match of text.matchAll(placeholder)) {
    const literal = text.slice(start, match.index);
    expression += escapePattern(literal) + "([\\s\\S]+?)";
    specificity += literal.length;
    names.push(match[1]);
    start = match.index + match[0].length;
  }
  if (!names.length) return;
  const last = text.slice(start);
  // A translated template such as "{day}" cannot identify a system message:
  // matching it in reverse would capture and rewrite every unknown string.
  if (!(text.replace(placeholder, "").trim())) return;
  patterns.push({ match: new RegExp(expression + escapePattern(last) + "$"), names, source, translation, specificity: specificity + last.length });
}

for (const [source, translation] of Object.entries(messages)) {
  const variants = typeof translation === "string" ? [translation] : [translation.one, translation.other];
  addPattern(source, source, translation);
  for (const variant of variants) {
    reverse[variant] ??= source;
    addPattern(variant, source, translation);
  }
}
patterns.sort((a, b) => b.specificity - a.specificity);

function interpolate(text: string, values: MessageValues): string {
  return text.replace(placeholder, (token: string, name: string) => values[name] === undefined ? token : String(values[name]));
}

function render(source: string, translation: Translation, language: Language, values: MessageValues): string {
  if (language === "zh") return interpolate(source, values);
  const text = typeof translation === "string" ? translation : Number(values.count) === 1 ? translation.one : translation.other;
  return interpolate(text, values);
}

/** Call only for App-authored UI or gateway-owned system text, never user/model content.
 * Recognizing catalog templates at the rendering boundary keeps persisted system messages
 * and existing error state responsive to a language switch without rewriting stored data.
 */
export function translate(message: string, language: Language, values: MessageValues = {}): string {
  const source = Object.hasOwn(messages, message) ? message : Object.hasOwn(reverse, message) ? reverse[message] : undefined;
  if (source !== undefined) return render(source, messages[source], language, values);
  for (const pattern of patterns) {
    const matched = pattern.match.exec(message);
    if (!matched) continue;
    const captured: Record<string, string | number> = { ...values };
    pattern.names.forEach((name, index) => { captured[name] = matched[index + 1]; });
    return render(pattern.source, pattern.translation, language, captured);
  }
  return interpolate(message, values);
}

export function t(message: string, values?: MessageValues): string {
  return translate(message, getLanguage(), values);
}

/** Each screen/feedback surface subscribes explicitly; sessions and route identity stay intact. */
export function useTranslation() {
  const language = useLanguage();
  return { t, language, locale: getLocale() };
}
