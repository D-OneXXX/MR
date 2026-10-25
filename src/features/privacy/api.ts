import { invoke } from "@tauri-apps/api/core";

export type SecurityStatus = "pass" | "warn" | "fail" | "unknown";

export interface SecurityAudit {
  checkedAt: string;
  overall: SecurityStatus;
  update: {
    status: SecurityStatus;
    manifestConfigured: boolean;
    manifestHttps: boolean;
    manifestLoopback: boolean;
    signatureConfigured: boolean;
    sha256Enforced: boolean;
    keySource: string;
  };
  isolation: {
    status: SecurityStatus;
    capabilityScoped: boolean;
    capabilityWindows: string[];
    remoteCapabilities: number;
    browserWindowOpen: boolean;
    cspConfigured: boolean;
    initScripts: boolean;
  };
  network: {
    status: SecurityStatus;
    mode: "direct" | "proxy";
    proxyScheme: string | null;
    httpsPreferred: boolean;
  };
  storage: {
    status: SecurityStatus;
    memoryCacheBytes: number;
    diskCacheBytes: number;
    liveWebviews: number;
    sessionHeadersInMemory: boolean;
  };
}

export interface ClearTracesResult {
  webviewsCleared: number;
  bytesFreed: number;
  sessionHeadersCleared: boolean;
  timestamp: string;
}

export const privacyApi = {
  /**
   * 本机安全自检。更新通道的结论完全来自 Rust 侧读取的构建期配置
   * （`tauri.conf.json plugins.updater`），前端不再提供任何更新源地址。
   */
  securityAudit: () => invoke<SecurityAudit>("security_audit"),
  clearOnlineTraces: () => invoke<ClearTracesResult>("clear_online_traces"),
};
