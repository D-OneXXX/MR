/**
 * PDF 错误归类：把后端稳定错误码与 pdf.js 异常统一映射成一组稳定码。
 *
 * 稳定码是前后端契约（后端文案尾部也带同样的 kebab-case 码），前端只
 * 认码不认文案：文案一律交给 i18n，绝不把后端中文直出到界面。
 */

/** PDF 相关稳定错误码。 */
export type PdfErrorCode =
  | "pdf-not-valid"
  | "pdf-not-found"
  | "pdf-render-unsupported"
  | "pdf-encrypted"
  | "pdf-too-large"
  | "pdf-source-unsupported"
  | "pdf-source-not-allowed"
  | "pdf-not-pdf"
  | "pdf-source-not-local"
  | "pdf-cover-missing"
  | "pdf-page-count-invalid"
  | "pdf-cover-invalid"
  | "pdf-cover-too-large"
  | "pdf-cover-dimensions";

/** 已知的稳定码集合（用于识别后端错误文案尾部附的码）。 */
const PDF_ERROR_CODES: readonly PdfErrorCode[] = [
  "pdf-not-valid",
  "pdf-not-found",
  "pdf-render-unsupported",
  "pdf-encrypted",
  "pdf-too-large",
  "pdf-source-unsupported",
  "pdf-source-not-allowed",
  "pdf-not-pdf",
  "pdf-source-not-local",
  "pdf-cover-missing",
  "pdf-page-count-invalid",
  "pdf-cover-invalid",
  "pdf-cover-too-large",
  "pdf-cover-dimensions",
];

/** 判断任意错误里是否带某个稳定码（后端文案尾部附 `（code）`）。 */
export function hasPdfErrorCode(error: unknown, code: PdfErrorCode): boolean {
  const text = errorText(error);
  return text.includes(code);
}

/** 取出错误文本（字符串错误或 Error.message）。 */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * 统一映射：优先认后端稳定码，其次认 pdf.js 异常名，最后兜底
 * `pdf-render-unsupported`（绝不把未知异常直接抛给界面）。
 */
export function mapPdfError(error: unknown): PdfErrorCode {
  const text = errorText(error);
  for (const code of PDF_ERROR_CODES) {
    if (text.includes(code)) return code;
  }
  const name =
    error && typeof error === "object"
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  if (name === "PasswordException") return "pdf-encrypted";
  if (name === "InvalidPDFException") return "pdf-not-valid";
  return "pdf-render-unsupported";
}
