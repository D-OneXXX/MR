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
  { code: "backup-file-missing", key: "error.backupFileMissing" },
  { code: "backup-invalid-format", key: "error.backupInvalidFormat" },
  { code: "backup-unsupported-schema", key: "error.backupUnsupportedSchema" },
  { code: "backup-integrity-failed", key: "error.backupIntegrity" },
  { code: "backup-too-large", key: "error.backupTooLarge" },
  { code: "backup-restore-failed", key: "error.backupRestoreFailed" },
  { code: "online-url-invalid", key: "error.onlineUrlInvalid" },
  { code: "online-blocked-address", key: "error.onlineBlockedAddress" },
  { code: "online-too-many-pages", key: "error.onlineTooManyPages" },
  { code: "online-fetch-failed", key: "error.onlineFetchFailed" },
  { code: "update-unsupported-format", key: "error.updateUnsupportedFormat" },
  { code: "non-utf8-path", key: "error.nonUtf8Path" },
  { code: "online-page-count-drop", key: "error.onlinePageCountDrop" },
  { code: "pdf-not-valid", key: "error.pdfNotValid" },
  { code: "pdf-not-found", key: "error.pdfNotFound" },
  { code: "pdf-source-not-allowed", key: "error.pdfSourceNotAllowed" },
  { code: "pdf-not-pdf", key: "error.pdfSourceNotAllowed" },
  { code: "pdf-source-not-local", key: "error.pdfSourceNotAllowed" },
  { code: "pdf-render-unsupported", key: "error.pdfRenderUnsupported" },
  { code: "pdf-encrypted", key: "error.pdfEncrypted" },
  { code: "pdf-too-large", key: "error.pdfTooLarge" },
  { code: "pdf-source-unsupported", key: "error.pdfSourceUnsupported" },
  { code: "pdf-cover-missing", key: "error.pdfCoverMissing" },
  { code: "pdf-page-count-invalid", key: "error.pdfPageCountInvalid" },
  { code: "pdf-cover-invalid", key: "error.pdfCoverInvalid" },
  { code: "pdf-cover-too-large", key: "error.pdfCoverTooLarge" },
  { code: "pdf-cover-dimensions", key: "error.pdfCoverDimensions" },
];

/**
 * 按稳定码直接取本地化文案。
 *
 * 用于「前端自己归类出来的错误」（例如 pdf.js 异常 → `pdf-encrypted`）：
 * 没有后端文案可解析，只有码，因此不能走 `localizeBackendError`。
 * 未知码一律落到泛化文案，绝不显示原始异常。
 */
export function localizeStableErrorCode(code: string): string {
  const entry = STABLE_ERROR_CODES.find((item) => item.code === code);
  return entry
    ? translate(entry.key as MessageKey)
    : translate("error.backendGeneric");
}

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
