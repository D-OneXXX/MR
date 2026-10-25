export const LOCALES = ["zh-CN", "zh-TW", "en", "es", "ja", "ko"] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_OPTIONS: ReadonlyArray<{
  value: Locale;
  label: string;
}> = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
];

export const DEFAULT_LOCALE: Locale = "zh-CN";
export const LOCALE_STORAGE_KEY = "mr-locale";

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (LOCALES as readonly string[]).includes(value)
  );
}

export function readStoredLocale(): Locale | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

function matchLocale(tag: string): Locale | null {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("zh")) {
    return /hant|tw|hk|mo/.test(normalized) ? "zh-TW" : "zh-CN";
  }
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("es")) return "es";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ko")) return "ko";
  return null;
}

/** First launch follows the OS language list; unsupported tags fall back to zh-CN. */
export function detectSystemLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const candidates =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
  for (const candidate of candidates) {
    const match = matchLocale(candidate);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function initialLocale(): Locale {
  return readStoredLocale() ?? detectSystemLocale();
}

export function localeLabel(locale: Locale): string {
  return (
    LOCALE_OPTIONS.find((option) => option.value === locale)?.label ?? locale
  );
}
