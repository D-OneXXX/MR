import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  initialLocale,
  isLocale,
  localeLabel,
  LOCALE_STORAGE_KEY,
  type Locale,
} from "./config";
import { messages, type MessageKey } from "./locales";

export {
  LOCALE_OPTIONS,
  LOCALES,
  localeLabel,
  type Locale,
} from "./config";
export type { MessageKey } from "./locales";

export type TranslateVars = Record<string, string | number>;

function fill(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export function formatMessage(
  template: string,
  vars?: TranslateVars,
): string {
  return fill(template, vars);
}

let activeLocale: Locale = initialLocale();

/** Non-React callbacks (toasts, event listeners) use the active locale. */
export function translate(key: MessageKey, vars?: TranslateVars): string {
  const table = messages[activeLocale] ?? messages["zh-CN"];
  return fill(table[key] ?? messages["zh-CN"][key] ?? key, vars);
}

export function currentLocale(): Locale {
  return activeLocale;
}

export function formatNumber(value: number, locale = activeLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatDateTime(
  value: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
  locale = activeLocale,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, options).format(date);
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: TranslateVars) => string;
  formatNumber: (value: number) => string;
  formatDateTime: (
    value: Date | number | string,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  localeName: string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  children,
  documentTitleKey = "app.title",
}: {
  children: ReactNode;
  documentTitleKey?: MessageKey;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const externalSyncRef = useRef(false);
  activeLocale = locale;

  // 跨窗口同步：其它窗口改写 mr-locale 时只更新状态，不回写 localStorage。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      if (!isLocale(event.newValue)) return;
      externalSyncRef.current = true;
      setLocaleState(event.newValue);
      activeLocale = event.newValue;
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    document.title =
      messages[locale][documentTitleKey] ?? messages["zh-CN"][documentTitleKey];
    if (externalSyncRef.current) {
      // 本次变更来自 storage 事件，写入方已落盘，跳过 write 以避免回环
      externalSyncRef.current = false;
      return;
    }
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      /* localStorage 不可用时仅保留本次会话 */
    }
  }, [locale, documentTitleKey]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    activeLocale = next;
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: TranslateVars) =>
      fill(messages[locale][key] ?? messages["zh-CN"][key] ?? key, vars),
    [locale],
  );

  const number = useCallback(
    (value: number) => new Intl.NumberFormat(locale).format(value),
    [locale],
  );

  const dateTime = useCallback(
    (value: Date | number | string, options?: Intl.DateTimeFormatOptions) =>
      formatDateTime(value, options, locale),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t,
      formatNumber: number,
      formatDateTime: dateTime,
      localeName: localeLabel(locale),
    }),
    [dateTime, locale, number, setLocale, t],
  );

  return (
    <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}
