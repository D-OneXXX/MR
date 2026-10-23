import { isLocale, type Locale } from "@/i18n/config";
import type { ThemeMode } from "@/features/theme/ThemeProvider";
import { sanitizeStorage } from "@/lib/storageSanitizer";

/**
 * 备份偏好白名单：只允许轻量、可安全跨设备迁移的 localStorage 键。
 *
 * 明确排除（绝不允许进入备份）：
 * - 更新源 URL / 更新偏好（mr-update-prefs）
 * - 浏览器最近访问（mr-browser-recents）与辅助 WebView 交接状态
 * - 页签 / 会话 / 请求头 / Cookie 等凭据或运行时状态
 * - 按书的阅读态（mr-wt-*），避免把旧 bookId 带到恢复后的书库
 */
export const BACKUP_PREFERENCE_KEYS = [
  "mr-theme",
  "mr-locale",
  "mr-reader-mode",
  "mr-reader-dir",
  "mr-reader-wt-width",
  "mr-wt-width",
  "mr-exp-wt",
  "mr-exp-online",
  "mr-library-group-series",
  "mr-library-source-filter",
  "mr-privacy-ack",
] as const;

export type BackupPreferenceKey = (typeof BACKUP_PREFERENCE_KEYS)[number];

/** 单个偏好值的长度上限：超出视为脏数据，读写两侧都跳过。 */
const MAX_VALUE_LENGTH = 4096;

interface BackupPreferencesPayload {
  version: 1;
  values: Partial<Record<BackupPreferenceKey, string>>;
}

export interface AppliedBackupPreferences {
  theme?: ThemeMode;
  locale?: Locale;
}

const PREFERENCE_KEY_SET: ReadonlySet<string> = new Set(BACKUP_PREFERENCE_KEYS);

/** 安全获取 localStorage：隐私模式或访问被拒绝时返回 null。 */
function safeStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * 采集当前设备的轻量偏好，返回 `{ version:1, values }` JSON 字符串。
 * 只读取白名单内、存在且不超过 4096 字符的字符串值；
 * localStorage 不可用时返回空 values，绝不抛错。
 */
export function captureBackupPreferences(): string {
  const values: Record<string, string> = {};
  const storage = safeStorage();
  if (storage) {
    for (const key of BACKUP_PREFERENCE_KEYS) {
      try {
        const value = storage.getItem(key);
        if (typeof value === "string" && value.length <= MAX_VALUE_LENGTH) {
          values[key] = value;
        }
      } catch {
        /* 单键读取失败：跳过该键，不中断整份备份 */
      }
    }
  }
  const payload: BackupPreferencesPayload = { version: 1, values };
  return JSON.stringify(payload);
}

/**
 * 把备份中的偏好写回 localStorage。
 *
 * 安全策略：
 * - JSON 解析失败 / 结构非法 / 版本不符时静默返回 {};
 * - 只写白名单内的字符串键，并再次执行长度校验，杜绝任意键注入；
 * - 写入后调用 `sanitizeStorage` 规范化枚举值与数值，非法值直接删除；
 * - 最后从清洗后的存储中读回 theme / locale，供调用方即时应用。
 */
export function applyBackupPreferences(
  raw: string | null | undefined,
): AppliedBackupPreferences {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed) || parsed.version !== 1) return {};
  if (!isRecord(parsed.values)) return {};

  const storage = safeStorage();
  if (!storage) return {};

  for (const [key, value] of Object.entries(parsed.values)) {
    if (!PREFERENCE_KEY_SET.has(key)) continue;
    if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) continue;
    try {
      storage.setItem(key, value);
    } catch {
      /* 单键写入失败：其余偏好仍尽量恢复 */
    }
  }

  try {
    sanitizeStorage(storage);
  } catch {
    /* 清洗失败不阻断恢复流程 */
  }

  const applied: AppliedBackupPreferences = {};
  try {
    const theme = storage.getItem("mr-theme");
    if (isThemeMode(theme)) applied.theme = theme;
    const locale = storage.getItem("mr-locale");
    if (isLocale(locale)) applied.locale = locale;
  } catch {
    /* 读回失败：不返回即时应用项，页面会按默认值/数据库设置加载 */
  }
  return applied;
}
