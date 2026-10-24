import { currentLocale, translate, type MessageKey } from "@/i18n";

const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * 后端错误文案内嵌的稳定错误码（括号形式，如 `（archive-encrypted）`）。
 * 非 中文界面按码映射六语文案，不再回落到泛化提示；与 update.rs 的
 * `linux-manual-install` 先例同一套路。新增码时同步补 common.ts 六语键。
 */
const STABLE_ERROR_CODES: ReadonlyArray<{ code: string; key: string }> = [
  { code: "archive-disguised-rar", key: "error.archiveDisguisedRar" },
  { code: "archive-disguised-7z", key: "error.archiveDisguised7z" },
  { code: "archive-not-zip", key: "error.archiveNotZip" },
  { code: "archive-encrypted", key: "error.archiveEncrypted" },
  { code: "db-open-failed", key: "dbRecovery.openFailed" },
  { code: "db-schema-failed", key: "dbRecovery.schemaFailed" },
  { code: "db-quick-check-failed", key: "dbRecovery.quickCheckFailed" },
  { code: "db-already-healthy", key: "dbRecovery.unknown" },
  { code: "linux-manual-install", key: "updates.linux.manualBlocked" },
];

/**
 * Backend commands still return human-readable Chinese strings. Chinese UI
 * keeps the exact detail; other locales show a localized generic message plus
 * an HTTP status when one is available, never raw Chinese mixed into the UI.
 * Errors carrying a stable code (see STABLE_ERROR_CODES) are localized by the
 * code table instead of the generic fallback.
 */
export function localizeBackendError(
  input: unknown,
  locale = currentLocale(),
): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return translate("error.backendGeneric");
  if (locale.startsWith("zh")) return raw;
  for (const entry of STABLE_ERROR_CODES) {
    if (raw.includes(`(${entry.code})`)) return translate(entry.key as MessageKey);
  }
  if (!CJK.test(raw)) return raw;
  const http = raw.match(/HTTP\s*(\d{3})/i)?.[1];
  return http
    ? `${translate("error.backendGeneric")} (HTTP ${http})`
    : translate("error.backendGeneric");
}
