/**
 * 本地持久化状态安全清洗（Storage Schema Sanitizer）
 *
 * 背景：应用已下线「翻译工作台 / 批量预翻译 / 术语表 / 选区翻译 / 页 OCR 存档 /
 * 服务状态 / 独立数据页」等旧功能，但老用户的浏览器 localStorage 里仍可能残留
 * 这些功能的键、非法枚举值（例如旧主题 "dark-blue"）或被写坏的 JSON。
 * 本模块在 React 挂载前把这些残留清掉，保证「一条脏 localStorage 不会导致白屏」。
 *
 * 设计约束：
 * - 全部导出为纯函数，唯一外部依赖是调用方传入的 storage（最小接口 StorageLike），
 *   因此 QA 可以在页面里注入假 storage 直接断言；
 * - 所有读写都包在 try/catch 中：隐私模式 / 配额写满时静默跳过，绝不抛错；
 * - 清洗幂等：同一份脏数据重复清洗结果一致，且不会反复写盘。
 */

/**
 * 最小 Storage 接口描述。
 * 只声明清洗需要的 5 个成员，便于单测 / QA 注入假 storage。
 */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 问题分类：QA 可按 kind 分组断言。 */
export type StorageIssueKind =
  /** 枚举值不在白名单内（例如 mr-theme = "dark-blue"） */
  | "invalid-enum"
  /** 开关值不是 "0"/"1" */
  | "invalid-flag"
  /** 数值键存的不是数字 */
  | "invalid-number"
  /** 数值键越界（超出代码里的钳制区间） */
  | "out-of-range"
  /** 字符串键超过长度上限 */
  | "too-long"
  /** JSON 解析失败或结构非法 */
  | "invalid-json"
  /** 已下线功能留下的废弃键 */
  | "deprecated"
  /** 不在白名单内的未知键 */
  | "unknown"
  /** 值可解析但写法不规范，已被规范化改写 */
  | "normalized";

export interface StorageIssue {
  /** 原始键名（QA 断言用；对外打印请走 redactStorageKey 脱敏） */
  key: string;
  kind: StorageIssueKind;
  /** 中文处置理由 */
  reason: string;
  /** 处置动作 */
  action: "remove" | "repair";
}

/** 清洗结果摘要。removed / repaired / kept 构成对原始键的完整划分。 */
export interface StorageSummary {
  /** 被删除的键名 */
  removed: string[];
  /** 被改写（规范化）成合法值的键名 */
  repaired: string[];
  /** 通过校验且未被改写的键数量 */
  kept: number;
}

/** 对外可记录的报告：键名已脱敏，绝不含漫画名 / 路径 / 凭据。 */
export interface SanitizeReport {
  removedCount: number;
  repairedCount: number;
  kept: number;
  /** 脱敏后的被删键（动态键折叠成 "mr-wt-*" 形式） */
  removedKeys: string[];
  /** 脱敏后的被改写键 */
  repairedKeys: string[];
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

type Decision =
  | { action: "keep" }
  | { action: "repair"; value: string; reason: string }
  | { action: "remove"; kind: StorageIssueKind; reason: string };

type Rule = (value: string) => Decision;

/** 枚举键：只允许固定取值，非法即删（调用方自带回落默认值）。 */
function enumRule(allowed: readonly string[], label: string): Rule {
  return (value) => {
    if ((allowed as readonly string[]).includes(value)) return { action: "keep" };
    return {
      action: "remove",
      kind: "invalid-enum",
      reason: `${label}取值非法，只允许 ${allowed.join("|")}`,
    };
  };
}

/** 开关键：只允许 "0" / "1"，其它写法一律删（读侧本来也只认这两个）。 */
function flagRule(label: string): Rule {
  return (value) => {
    if (value === "0" || value === "1") return { action: "keep" };
    return {
      action: "remove",
      kind: "invalid-flag",
      reason: `${label}取值非法，只允许 0 或 1`,
    };
  };
}

/**
 * 数值键：必须落在代码里的钳制区间内。
 * 越界直接删除（读侧会回落默认值，保留脏值只会继续越界），非规范写法则规范化改写。
 */
function numberRule(min: number, max: number, label: string): Rule {
  return (value) => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(parsed)) {
      return {
        action: "remove",
        kind: "invalid-number",
        reason: `${label}必须是数值`,
      };
    }
    if (parsed < min || parsed > max) {
      return {
        action: "remove",
        kind: "out-of-range",
        reason: `${label}越界，允许区间 ${min}..${max}`,
      };
    }
    const canonical = String(Math.round(parsed));
    if (canonical !== value) {
      return {
        action: "repair",
        value: canonical,
        reason: `${label}数值规范化`,
      };
    }
    return { action: "keep" };
  };
}

/** 字符串键：内容任意，但长度有上限，超长删除（防止无意义膨胀）。 */
function textRule(maxLength: number, label: string): Rule {
  return (value) => {
    if (value.length > maxLength) {
      return {
        action: "remove",
        kind: "too-long",
        reason: `${label}超过 ${maxLength} 字符上限`,
      };
    }
    return { action: "keep" };
  };
}

/** 判断字符串是否是合法 JSON（用于动态前缀的宽松校验）。 */
function isJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * JSON 键：解析失败即删；解析成功但结构非法也删（读侧本来就会忽略）。
 * 结构合法但写法不规范的，规范化改写成与读侧一致的形状。
 */
function jsonRule(
  label: string,
  canonicalize: (parsed: unknown) => unknown | null,
): Rule {
  return (value) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        action: "remove",
        kind: "invalid-json",
        reason: `${label}JSON 解析失败`,
      };
    }
    const canonical = canonicalize(parsed);
    if (canonical === null) {
      return {
        action: "remove",
        kind: "invalid-json",
        reason: `${label}JSON 结构非法`,
      };
    }
    const next = JSON.stringify(canonical);
    if (next !== value) {
      return {
        action: "repair",
        value: next,
        reason: `${label}JSON 结构规范化`,
      };
    }
    return { action: "keep" };
  };
}

/** 更新偏好：与 features/update/types.ts 的 loadUpdatePrefs 保持同一套回落规则。 */
function canonicalUpdatePrefs(parsed: unknown): unknown | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  return {
    manifestUrl: typeof source.manifestUrl === "string" ? source.manifestUrl : "",
    channel: source.channel === "beta" ? "beta" : "stable",
    autoCheck: source.autoCheck !== false,
    autoDownload: source.autoDownload === true,
  };
}

/** 在线连通性记录：与 lib/onlineLastTest.ts 的 readOnlineLastTest 保持一致。 */
function canonicalOnlineLastTest(parsed: unknown): unknown | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  if (typeof source.ok !== "boolean") return null;
  if (typeof source.at !== "number" || !Number.isFinite(source.at)) return null;
  if (typeof source.urlHost !== "string") return null;
  const urlHost = source.urlHost
    .replace(/^.*@/, "")
    .split(/[/?#]/)[0]
    .trim()
    .slice(0, 120);
  if (!urlHost) return null;
  return { ok: source.ok, at: source.at, urlHost };
}

/** 浏览器最近访问：与 pages/Browser.tsx 的 readRecents 保持一致（最多 20 条）。 */
function canonicalRecents(parsed: unknown): unknown | null {
  if (!Array.isArray(parsed)) return null;
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    result.push(item);
    if (result.length >= 20) break;
  }
  return result;
}

/**
 * 已知键注册表：键 -> 合法值 + 修复策略。
 * 键名与取值全部对照真实代码（ThemeProvider / i18n / tauri / Reader / Browser / Library /
 * onlineLastTest / update\types / PrivacyDialog），不在此表的键只会命中动态前缀或被当作未知键删除。
 */
const KEY_RULES: Record<string, Rule> = {
  // 主题：只允许 system|light|dark，旧版 "dark-blue" 之类一律删除，ThemeProvider 回落到 system。
  "mr-theme": enumRule(["system", "light", "dark"], "主题"),
  // 界面语言：与 i18n/config.ts 的 LOCALES 完全一致。
  "mr-locale": enumRule(["zh-CN", "zh-TW", "en", "es", "ja", "ko"], "界面语言"),
  // 实验性开关镜像（lib/tauri.ts）：只认 "1"。
  "mr-exp-wt": flagRule("实验性条漫开关"),
  "mr-exp-online": flagRule("实验性在线直读开关"),
  // 多页签运行时开关（features/workspace）：只有 "0" 有意义，其余写法删除后回到默认开启。
  "mr-tabs": flagRule("多页签开关"),
  // 阅读版式 / 方向（pages/Reader.tsx loadPrefs）。
  "mr-reader-mode": enumRule(["single", "double"], "阅读版式"),
  "mr-reader-dir": enumRule(["rtl", "ltr"], "阅读方向"),
  // 条漫阅读宽度：钳制区间对齐 pages/Reader.tsx 的 WT_MIN_WIDTH(50) / WT_MAX_WIDTH(150)。
  "mr-reader-wt-width": numberRule(50, 150, "条漫阅读宽度"),
  // 更早期的宽度键名，同一套钳制区间。
  "mr-wt-width": numberRule(50, 150, "条漫阅读宽度"),
  // 隐私弹窗确认标记：内容任意，但长度有上限（正常形如 "2026-10:0"）。
  "mr-privacy-ack": textRule(128, "隐私确认标记"),
  // JSON 键：解析失败即删，结构合法则规范化。
  "mr-update-prefs": jsonRule("更新偏好", canonicalUpdatePrefs),
  "mr-online-last-test": jsonRule("在线连通性记录", canonicalOnlineLastTest),
  "mr-browser-recents": jsonRule("浏览器最近访问", canonicalRecents),
  // 书库分组 / 来源筛选（pages/Library.tsx）。
  "mr-library-group-series": flagRule("书库分组开关"),
  "mr-library-source-filter": enumRule(["all", "local", "online"], "书库来源筛选"),
};

/** 已知键清单（QA 断言用）。 */
export const KNOWN_STORAGE_KEYS: readonly string[] = Object.keys(KEY_RULES);

/**
 * 动态前缀白名单：按书 id 生成的阅读态。
 * 值必须是受限字符串（阅读版式）或可解析的 JSON，否则删除。
 */
const DYNAMIC_PREFIX_RULES: ReadonlyArray<{ prefix: string; rule: Rule }> = [
  {
    prefix: "mr-wt-",
    // 按书记忆的版式：pages/Reader.tsx 只认 webtoon|single|double。
    rule: (value) => {
      if (value === "webtoon" || value === "single" || value === "double") {
        return { action: "keep" };
      }
      if (isJson(value)) return { action: "keep" };
      return {
        action: "remove",
        kind: "invalid-enum",
        reason: "按书阅读版式非法，只允许 webtoon|single|double 或合法 JSON",
      };
    },
  },
  {
    prefix: "mr-reader-",
    // 其余阅读器状态键：短字符串或合法 JSON。
    rule: (value) => {
      if (value.length <= 64 && /^[A-Za-z0-9_.:\-]*$/.test(value)) {
        return { action: "keep" };
      }
      if (isJson(value)) return { action: "keep" };
      return {
        action: "remove",
        kind: "invalid-enum",
        reason: "阅读器状态值非法（仅允许短字符串或合法 JSON）",
      };
    },
  },
];

/** 动态前缀清单（QA 断言用）。 */
export const DYNAMIC_KEY_PREFIXES: readonly string[] = DYNAMIC_PREFIX_RULES.map(
  (rule) => rule.prefix,
);

/**
 * 废弃前缀（含其后任意后缀一律删除）：
 * 翻译工作台 / 批量预翻译 / 术语表 / 选区翻译 / 页 OCR 存档 / 服务状态 / 独立数据页 等旧功能残留。
 */
export const DEPRECATED_KEY_PREFIXES: readonly string[] = [
  "mr-translator",
  "mr-translation",
  "mr-ocr",
  "mr-glossary",
  "mr-batch",
  "mr-sidecar",
  "mr-status",
  "mr-data",
  "mr-pretranslate",
];

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

interface StorageEntry {
  key: string;
  value: string;
}

/**
 * 读取 storage 快照。
 * 逐键 try/catch：个别键读取异常不应中断整轮扫描；整体异常（隐私模式等）返回已读到的部分。
 */
function readSnapshot(storage: StorageLike | null | undefined): StorageEntry[] {
  const entries: StorageEntry[] = [];
  if (!storage) return entries;
  const seen = new Set<string>();
  try {
    const total = Number(storage.length);
    if (!Number.isFinite(total) || total <= 0) return entries;
    for (let index = 0; index < total; index += 1) {
      let key: string | null = null;
      try {
        key = storage.key(index);
      } catch {
        break;
      }
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let value: string | null = null;
      try {
        value = storage.getItem(key);
      } catch {
        /* 单键读取异常：跳过该键，避免误删 */
        continue;
      }
      entries.push({ key, value: typeof value === "string" ? value : "" });
    }
  } catch {
    /* 存储不可用：返回已读到的部分 */
  }
  return entries;
}

/** 判定单个键该怎么处置。 */
function decide(key: string, value: string): Decision {
  const exact = KEY_RULES[key];
  if (exact) return exact(value);

  for (const prefix of DEPRECATED_KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      return {
        action: "remove",
        kind: "deprecated",
        reason: `已下线功能遗留键（${prefix} 前缀）`,
      };
    }
  }

  for (const rule of DYNAMIC_PREFIX_RULES) {
    if (key.startsWith(rule.prefix)) return rule.rule(value);
  }

  return {
    action: "remove",
    kind: "unknown",
    reason: "未知键，不在白名单内",
  };
}

/** 键名脱敏：动态键折叠成前缀通配，未知键整体屏蔽，杜绝用户数据进入日志。 */
export function redactStorageKey(key: string): string {
  if (KEY_RULES[key]) return key;
  for (const rule of DYNAMIC_PREFIX_RULES) {
    if (key.startsWith(rule.prefix)) return `${rule.prefix}*`;
  }
  return "<unknown-key>";
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 扫描 storage，返回问题清单（非法枚举值、JSON 解析失败、废弃键、未知键……）。
 * 只读，不做任何修改；可安全地在 QA 页面里反复调用。
 */
export function collectStorageIssues(
  storage: StorageLike | null | undefined,
): StorageIssue[] {
  const issues: StorageIssue[] = [];
  for (const entry of readSnapshot(storage)) {
    const decision = decide(entry.key, entry.value);
    if (decision.action === "keep") continue;
    issues.push({
      key: entry.key,
      kind: decision.action === "remove" ? decision.kind : "normalized",
      reason: decision.reason,
      action: decision.action === "remove" ? "remove" : "repair",
    });
  }
  return issues;
}

/**
 * 执行清洗：删除非法 / 废弃 / 未知键，规范化可修复的键。
 * 返回 { removed, repaired, kept }；三者是原始键的完整划分。
 * 全程 try/catch：localStorage 不可用（隐私模式 / 配额满）时静默返回空结果。
 */
export function sanitizeStorage(
  storage: StorageLike | null | undefined,
): StorageSummary {
  const summary: StorageSummary = { removed: [], repaired: [], kept: 0 };
  try {
    for (const entry of readSnapshot(storage)) {
      const decision = decide(entry.key, entry.value);
      if (decision.action === "remove") {
        try {
          storage?.removeItem(entry.key);
          summary.removed.push(entry.key);
        } catch {
          /* 单键删除失败：忽略，不影响其余键 */
        }
      } else if (decision.action === "repair") {
        try {
          storage?.setItem(entry.key, decision.value);
          summary.repaired.push(entry.key);
        } catch {
          /* 单键写入失败：忽略，不影响其余键 */
        }
      } else {
        summary.kept += 1;
      }
    }
  } catch {
    /* 存储整体不可用：静默跳过，绝不抛错 */
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 结果记录（脱敏）
// ---------------------------------------------------------------------------

/** 清洗完成事件名：外部（QA / 诊断面板）可监听。 */
export const STORAGE_SANITIZED_EVENT = "mr-storage-sanitized";

let lastSummary: StorageSummary | null = null;
let lastReport: SanitizeReport | null = null;

/** 生成脱敏报告：只含键名与数量，绝不含漫画名 / 路径 / 凭据。 */
export function buildSanitizeReport(summary: StorageSummary): SanitizeReport {
  return {
    removedCount: summary.removed.length,
    repairedCount: summary.repaired.length,
    kept: summary.kept,
    removedKeys: summary.removed.map(redactStorageKey),
    repairedKeys: summary.repaired.map(redactStorageKey),
  };
}

/** 最近一次清洗摘要（未脱敏，供 QA 在页面内断言）。 */
export function getLastSanitizeSummary(): StorageSummary | null {
  return lastSummary;
}

/** 最近一次清洗报告（已脱敏，可安全展示 / 导出）。 */
export function getLastSanitizeReport(): SanitizeReport | null {
  return lastReport;
}

/**
 * 记录清洗结果：写入模块状态 + 派发 DOM 事件 + 一条脱敏控制台日志。
 * 这是 console.debug 之外的记录通道，避免只在开发者控制台可见。
 */
export function reportSanitizeResult(summary: StorageSummary): SanitizeReport {
  const report = buildSanitizeReport(summary);
  lastSummary = summary;
  lastReport = report;
  try {
    if (typeof window !== "undefined" && typeof CustomEvent === "function") {
      window.dispatchEvent(
        new CustomEvent(STORAGE_SANITIZED_EVENT, { detail: report }),
      );
    }
  } catch {
    /* 事件派发失败不影响启动 */
  }
  try {
    if (typeof console !== "undefined" && typeof console.info === "function") {
      console.info("[storage-sanitizer] localStorage 清洗完成", {
        removed: report.removedCount,
        repaired: report.repairedCount,
        kept: report.kept,
        removedKeys: report.removedKeys,
        repairedKeys: report.repairedKeys,
      });
    }
  } catch {
    /* 日志失败不影响启动 */
  }
  return report;
}

// ---------------------------------------------------------------------------
// QA 入口
// ---------------------------------------------------------------------------

export interface StorageSanitizerApi {
  collectStorageIssues: typeof collectStorageIssues;
  sanitizeStorage: typeof sanitizeStorage;
  buildSanitizeReport: typeof buildSanitizeReport;
  getLastSanitizeSummary: typeof getLastSanitizeSummary;
  getLastSanitizeReport: typeof getLastSanitizeReport;
  redactStorageKey: typeof redactStorageKey;
  KNOWN_KEYS: readonly string[];
  DEPRECATED_PREFIXES: readonly string[];
  DYNAMIC_PREFIXES: readonly string[];
}

declare global {
  interface Window {
    __mrStorageSanitizer?: StorageSanitizerApi;
  }
}

/**
 * 把纯函数挂到 window 上，方便 QA 在页面控制台直接调用断言。
 * 只在显式调用时挂载，模块本身不产生任何副作用。
 */
export function installStorageSanitizerApi(target?: Window): void {
  const host =
    target ?? (typeof window !== "undefined" ? window : undefined);
  if (!host) return;
  try {
    host.__mrStorageSanitizer = {
      collectStorageIssues,
      sanitizeStorage,
      buildSanitizeReport,
      getLastSanitizeSummary,
      getLastSanitizeReport,
      redactStorageKey,
      KNOWN_KEYS: KNOWN_STORAGE_KEYS,
      DEPRECATED_PREFIXES: DEPRECATED_KEY_PREFIXES,
      DYNAMIC_PREFIXES: DYNAMIC_KEY_PREFIXES,
    };
  } catch {
    /* 挂载失败不影响启动 */
  }
}
