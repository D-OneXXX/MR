import { invoke } from "@tauri-apps/api/core";

export type SecurityStatus = "pass" | "warn" | "fail" | "unknown";

export interface SecurityAudit {
  checkedAt: string;
  overall: SecurityStatus;
  update: {
    status: SecurityStatus;
    manifestConfigured: boolean;
    manifestHttps: boolean;
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

export interface SecurityAuditInput {
  manifestUrl: string;
}

export const privacyApi = {
  securityAudit: (input: SecurityAuditInput) =>
    invoke<SecurityAudit>("security_audit", {
      manifestUrl: input.manifestUrl,
    }),
  clearOnlineTraces: () => invoke<ClearTracesResult>("clear_online_traces"),
};
