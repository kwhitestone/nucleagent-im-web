import { createI18n } from "vue-i18n";
import zh from "./zh.ts";
import en from "./en.ts";

export type SupportedLocale = "zh" | "en";

/**
 * Same key the shell and the other sub-apps use. Each origin keeps its own copy
 * (localStorage is not shared cross-origin), so this only aligns the two when
 * im-web runs standalone on its own host — but reusing the name costs nothing
 * and means one less convention to remember.
 */
export const LOCALE_STORAGE_KEY = "nucleagent_locale";

export function detectLocale(): SupportedLocale {
  try {
    const saved = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // Storage blocked by policy: fall through to the browser preference.
  }
  const browser = globalThis.navigator?.language?.toLowerCase() || "";
  return browser.startsWith("en") ? "en" : "zh";
}

const initialLocale = detectLocale();

const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  // Chinese is the source language, so a missing translation shows Chinese
  // rather than a raw key. (The shell currently falls back to "en"; per the UX2
  // spec that value looks like a historical accident and should align here.)
  fallbackLocale: "zh",
  messages: { zh, en },
});

/** Keeps <html lang> truthful: screen readers and hyphenation both read it. */
function syncDocumentLang(locale: SupportedLocale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
  }
}

syncDocumentLang(initialLocale);

export function setLocale(locale: SupportedLocale): void {
  i18n.global.locale.value = locale;
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // A locale that does not survive a reload still beats failing the click.
  }
  syncDocumentLang(locale);
}

export function getLocale(): SupportedLocale {
  return i18n.global.locale.value as SupportedLocale;
}

export function toggleLocale(): SupportedLocale {
  const next = getLocale() === "zh" ? "en" : "zh";
  setLocale(next);
  return next;
}

export default i18n;
