/** Software update contract shared by the updater provider and settings UI. */

export type UpdateKind = "patch" | "full";
export type UpdateChannel = "stable" | "beta";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "error";

export interface AppInfo {
  version: string;
  buildBaseline: string;
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

export interface ArtifactInfo {
  kind: UpdateKind;
  size: number;
  format: string;
}

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  kind: UpdateKind | null;
  patchEligible: boolean;
  /** no-patch | version-mismatch | major-upgrade | patch-available | "" */
  fallbackReason: string;
  patch: ArtifactInfo | null;
  full: ArtifactInfo;
  notes: string;
  releasedAt: string | null;
  mandatory: boolean;
}

export interface UpdateProgress {
  requestId: string;
  phase: "downloading" | "verifying" | "ready";
  downloaded: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
}

export interface ReadyUpdate {
  version: string;
  kind: UpdateKind;
  size: number;
  format: string;
  sha256: string;
}

export interface PreviousUpdateFailure {
  version: string;
  kind: UpdateKind;
  startedAt: string;
}

export interface UpdateSnapshot {
  ready: ReadyUpdate | null;
  downloading: boolean;
  lastVerifiedAt: string | null;
  lastVerifiedKind: string | null;
  previousAttemptFailed: PreviousUpdateFailure | null;
}

export type UpdateErrorStage = "check" | "download" | "install";

export interface UpdateError {
  stage: UpdateErrorStage;
  message: string;
  failedKind: UpdateKind | null;
}

export interface UpdatePrefs {
  manifestUrl: string;
  channel: UpdateChannel;
  autoCheck: boolean;
  autoDownload: boolean;
}

const PREFS_KEY = "mr-update-prefs";

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  manifestUrl: "",
  channel: "stable",
  autoCheck: true,
  autoDownload: false,
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
      autoCheck: parsed.autoCheck !== false,
      autoDownload: parsed.autoDownload === true,
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
