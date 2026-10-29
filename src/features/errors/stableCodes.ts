/**
 * 后端稳定码的括号匹配。
 *
 * Rust 侧统一使用全角括号（`archive-encrypted` 形如 `（archive-encrypted）`），
 * 但历史文案、测试夹具与第三方错误可能使用半角括号。两种都必须识别，
 * 否则非中文界面会退化为泛化提示。
 */
export function hasStableCode(raw: string, code: string): boolean {
  return raw.includes(`(${code})`) || raw.includes(`（${code}）`);
}
