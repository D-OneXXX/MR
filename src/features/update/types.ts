/** Software update contract shared by the updater provider and settings UI. */

export type UpdateChannel = "stable" | "beta";

export interface AppInfo {
  version: string;
  buildBaseline: string;
  /** 构建来源指纹：official / community（关于页徽章 + 诊断快照）。 */
  buildOrigin: string;
  target: string;
  profile: string;
  signatureConfigured: boolean;
  sha256Enforced: boolean;
  /**
   * Linux 安装形态（Rust `platform::install_channel`）：
   * `appimage` 可自动替换 / `system` deb/rpm 引导手动安装 / `portable` /
   * 空串 = 非 Linux（前端跳过 Linux 更新策略提示）。
   */
  linuxInstall: string;
}

/**
 * 补丁通道的本机遗留偏好。设置页不再暴露清单地址编辑；该值仅供隐私
 * 安全审计评估「自定义补丁源」的回环/HTTPS 策略。
 */
export interface UpdatePrefs {
  manifestUrl: string;
  channel: UpdateChannel;
}

const PREFS_KEY = "mr-update-prefs";

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  manifestUrl: "",
  channel: "stable",
};

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "beta";
}

export function loadUpdatePrefs(): UpdatePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_UPDATE_PREFS };
    const parsed = JSON.parse(raw) as Partial<UpdatePrefs> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_UPDATE_PREFS };
    }
    return {
      manifestUrl:
        typeof parsed.manifestUrl === "string" ? parsed.manifestUrl : "",
      channel: isUpdateChannel(parsed.channel) ? parsed.channel : "stable",
    };
  } catch {
    return { ...DEFAULT_UPDATE_PREFS };
  }
}

export function saveUpdatePrefs(prefs: UpdatePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Preferences stay in memory when storage is unavailable. */
  }
}

/** `{channel}` is optional; without it the URL is used verbatim. */
export function resolveManifestUrl(prefs: UpdatePrefs): string {
  const url = prefs.manifestUrl.trim();
  if (!url) return "";
  return url.split("{channel}").join(prefs.channel);
}
