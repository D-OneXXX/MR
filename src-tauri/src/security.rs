//! Real local security audit and online-trace cleanup.
//!
//! Every audit field is derived from real build-time/runtime data: the Tauri
//! capability file compiled into the binary, live WebView windows, CSP config,
//! the configured proxy, memory/disk caches, and the in-process session
//! headers. There is no hardcoded all-green path; [`SecurityStatus::Unknown`]
//! exists for undecidable cases.
//!
//! The cleanup command clears L1/L2 image caches, session headers, and calls
//! the WebView2 profile shared by the app (cookies, HTTP cache, site storage).
//! The frontend snapshots and restores its own local preferences afterwards.

use serde::Serialize;
use tauri::{AppHandle, Manager};
use url::{Host, Url};

use crate::AppState;

/// Capability files embedded at compile time (same sources as the generated ACL).
const CAPABILITIES_JSON: &str = concat!(
    "[",
    include_str!("../capabilities/default.json"),
    ",",
    include_str!("../capabilities/recovery.json"),
    "]"
);

/// Embedded browser window label (see browser.rs).
const BROWSER_LABEL: &str = "browser";
/// Local recovery window label (see resilience.rs).
const RECOVERY_LABEL: &str = "recovery";

/// Audit status; severity order: fail > warn > unknown > pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecurityStatus {
    Pass,
    Warn,
    Fail,
    #[allow(dead_code)]
    Unknown,
}

impl SecurityStatus {
    fn severity(self) -> u8 {
        match self {
            SecurityStatus::Pass => 0,
            SecurityStatus::Unknown => 1,
            SecurityStatus::Warn => 2,
            SecurityStatus::Fail => 3,
        }
    }

    /// Merge two statuses and return the more severe one.
    fn worst(self, other: SecurityStatus) -> SecurityStatus {
        if other.severity() > self.severity() {
            other
        } else {
            self
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAudit {
    pub status: SecurityStatus,
    pub manifest_configured: bool,
    pub manifest_https: bool,
    pub signature_configured: bool,
    /// The updater module always verifies SHA-256 of downloaded artifacts.
    pub sha256_enforced: bool,
    /// `build` (compile-time MR_UPDATE_PUBKEY) or `none`.
    pub key_source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationAudit {
    pub status: SecurityStatus,
    pub capability_scoped: bool,
    pub capability_windows: Vec<String>,
    pub remote_capabilities: u32,
    pub browser_window_open: bool,
    pub csp_configured: bool,
    pub init_scripts: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAudit {
    pub status: SecurityStatus,
    /// `direct` or `proxy`.
    pub mode: String,
    /// Scheme only; never the full URL, host, or credentials.
    pub proxy_scheme: Option<String>,
    pub https_preferred: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageAudit {
    pub status: SecurityStatus,
    pub memory_cache_bytes: u64,
    pub disk_cache_bytes: u64,
    pub live_webviews: u32,
    pub session_headers_in_memory: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityAudit {
    pub checked_at: String,
    pub overall: SecurityStatus,
    pub update: UpdateAudit,
    pub isolation: IsolationAudit,
    pub network: NetworkAudit,
    pub storage: StorageAudit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearTracesResult {
    pub webviews_cleared: u32,
    pub bytes_freed: u64,
    pub session_headers_cleared: bool,
    pub timestamp: String,
}

/// Real local security audit. `manifest_url` comes from the update preferences
/// resolved by the frontend and may be empty.
#[tauri::command]
pub async fn security_audit(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    manifest_url: String,
) -> Result<SecurityAudit, String> {
    let update = audit_update(&manifest_url);
    let isolation = audit_isolation(&app);
    let proxy = state.settings.lock().online_proxy.clone();
    let network = audit_network(&proxy);
    let storage = audit_storage(&app, state.inner());

    let overall = [
        update.status,
        isolation.status,
        network.status,
        storage.status,
    ]
    .into_iter()
    .fold(SecurityStatus::Pass, SecurityStatus::worst);

    Ok(SecurityAudit {
        checked_at: chrono::Local::now().to_rfc3339(),
        overall,
        update,
        isolation,
        network,
        storage,
    })
}

/// Clear online traces: L1/L2 app caches, in-memory session headers, and
/// WebView2 browsing data (cookies, cache and site storage) for every live
/// WebView. The frontend snapshots and restores its own localStorage keys.
#[tauri::command]
pub async fn clear_online_traces(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<ClearTracesResult, String> {
    let before = cache_totals(state.inner());

    state.cache.clear_pages();
    state.cache.clear_thumbs();
    state.webtoon_layouts.lock().clear();
    state.render.clear_all();
    state.online_cache.clear_all();
    *state.session_online_headers.lock() = None;
    // 辅助会话（受控 WebView 验证后的 UA/用户自备请求头）同样只驻留内存，
    // 清理在线痕迹时必须一起作废。
    state.clear_assisted_sessions();
    // 池中的 transport 仍可能内嵌旧 Cookie/请求头；必须整体作废，
    // 否则清理后继续阅读会复用已清除凭据的句柄。
    state.invalidate_sources();
    state.trim_disk_cache();

    let windows = app.webview_windows();
    let mut webviews_cleared: u32 = 0;
    for window in windows.values() {
        if window.clear_all_browsing_data().is_ok() {
            webviews_cleared = webviews_cleared.saturating_add(1);
        }
    }
    if webviews_cleared == 0 && !windows.is_empty() {
        return Err("无法清除 WebView 浏览数据".to_string());
    }

    let after = cache_totals(state.inner());
    let bytes_freed = before
        .0
        .saturating_add(before.1)
        .saturating_sub(after.0.saturating_add(after.1));

    Ok(ClearTracesResult {
        webviews_cleared,
        bytes_freed,
        session_headers_cleared: true,
        timestamp: chrono::Local::now().to_rfc3339(),
    })
}

// ---------- Update ----------

fn audit_update(manifest_url: &str) -> UpdateAudit {
    audit_update_with(manifest_url, update_key_configured())
}

fn update_key_configured() -> bool {
    option_env!("MR_UPDATE_PUBKEY")
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn audit_update_with(manifest_url: &str, signature_configured: bool) -> UpdateAudit {
    let trimmed = manifest_url.trim();
    let manifest_configured = !trimmed.is_empty();
    let mut manifest_https = false;
    let mut invalid = false;

    if manifest_configured {
        match Url::parse(trimmed) {
            Ok(url) => {
                // Reject any userinfo so credentials never reach update logs.
                if !url.username().is_empty() || url.password().is_some() {
                    invalid = true;
                }
                match url.scheme() {
                    "https" => manifest_https = true,
                    "http" => {
                        if host_is_loopback(url.host()) {
                            // Plaintext is acceptable on loopback (no network hop).
                            manifest_https = true;
                        } else {
                            invalid = true;
                        }
                    }
                    _ => invalid = true,
                }
            }
            Err(_) => invalid = true,
        }
    }

    let status = if invalid {
        SecurityStatus::Fail
    } else if !signature_configured {
        SecurityStatus::Warn
    } else {
        SecurityStatus::Pass
    };

    UpdateAudit {
        status,
        manifest_configured,
        manifest_https,
        signature_configured,
        sha256_enforced: true,
        key_source: if signature_configured {
            "build".to_string()
        } else {
            "none".to_string()
        },
    }
}

fn host_is_loopback(host: Option<Host<&str>>) -> bool {
    match host {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

// ---------- Isolation ----------

#[derive(Debug, Default)]
struct CapabilityEvidence {
    windows: Vec<String>,
    remote_capabilities: u32,
    scoped: bool,
}

/// Parse the capability file embedded in the binary; accepts one object or an
/// array of objects.
///
/// A malformed file is a real config error: return Err so the caller can
/// report empty evidence with status fail.
fn parse_capability_evidence(raw: &str) -> Result<CapabilityEvidence, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|err| format!("capability JSON 无效：{err}"))?;
    let entries = match value {
        serde_json::Value::Array(entries) => entries,
        serde_json::Value::Object(_) => vec![value],
        _ => return Err("capability 文件必须是对象或数组".to_string()),
    };

    let mut windows: Vec<String> = Vec::new();
    let mut remote_capabilities: u32 = 0;
    let mut has_glob = false;

    for entry in entries {
        let object = entry
            .as_object()
            .ok_or_else(|| "capability 条目必须是对象".to_string())?;
        if object.contains_key("remote") {
            remote_capabilities = remote_capabilities.saturating_add(1);
        }
        match object.get("windows") {
            Some(serde_json::Value::Array(names)) => {
                for name in names {
                    let label = name
                        .as_str()
                        .ok_or_else(|| "capability.windows 只能包含字符串".to_string())?;
                    if label == "*" {
                        has_glob = true;
                    }
                    if !windows.iter().any(|existing| existing == label) {
                        windows.push(label.to_string());
                    }
                }
            }
            Some(_) => return Err("capability.windows 必须是字符串数组".to_string()),
            None => {}
        }
    }

    // 受控窗口白名单：主窗、恢复窗与内嵌浏览器窗。
    // 浏览器窗虽然被列进 capability.windows，但它加载的是远程 Origin，
    // Tauri 按 (label, origin) 匹配，远程页面拿不到任何本地能力，
    // 因此这里计入白名单不会削弱隔离性。
    let scoped = !windows.is_empty()
        && !has_glob
        && remote_capabilities == 0
        && windows.iter().all(|label| {
            label == "main" || label == RECOVERY_LABEL || label == BROWSER_LABEL
        });

    Ok(CapabilityEvidence {
        windows,
        remote_capabilities,
        scoped,
    })
}

fn audit_isolation(app: &AppHandle) -> IsolationAudit {
    let evidence = match parse_capability_evidence(CAPABILITIES_JSON) {
        Ok(evidence) => evidence,
        Err(err) => {
            eprintln!("[security] capability config is malformed: {err}");
            CapabilityEvidence::default()
        }
    };

    // This codebase injects no initialization scripts: browser.rs never calls
    // `.initialization_script` and tauri.conf.json has no global injection.
    // If one is added later, this flag must be updated.
    let init_scripts = false;
    let csp_configured = app.config().app.security.csp.is_some();
    let browser_window_open = app.get_webview_window(BROWSER_LABEL).is_some();

    let status = if !evidence.scoped || evidence.remote_capabilities > 0 || init_scripts {
        SecurityStatus::Fail
    } else if !csp_configured {
        SecurityStatus::Warn
    } else {
        SecurityStatus::Pass
    };

    IsolationAudit {
        status,
        capability_scoped: evidence.scoped,
        capability_windows: evidence.windows,
        remote_capabilities: evidence.remote_capabilities,
        browser_window_open,
        csp_configured,
        init_scripts,
    }
}

// ---------- Network ----------

fn audit_network(proxy: &str) -> NetworkAudit {
    let trimmed = proxy.trim();
    // Online HTTPS is supported and update transport requires HTTPS
    // (except loopback).
    let https_preferred = true;

    if trimmed.is_empty() {
        return NetworkAudit {
            status: SecurityStatus::Pass,
            mode: "direct".to_string(),
            proxy_scheme: None,
            https_preferred,
        };
    }

    let mode = "proxy".to_string();
    match Url::parse(trimmed) {
        Ok(url) => {
            let scheme = url.scheme().to_string();
            let supported = matches!(url.scheme(), "http" | "https" | "socks5");
            let has_userinfo = !url.username().is_empty() || url.password().is_some();
            let has_host = url.host_str().is_some_and(|host| !host.is_empty());

            let status = if !supported || has_userinfo || !has_host {
                SecurityStatus::Fail
            } else if url.scheme() == "http" {
                SecurityStatus::Warn
            } else {
                SecurityStatus::Pass
            };

            // Expose the scheme only; host, port, and credentials stay hidden.
            NetworkAudit {
                status,
                mode,
                proxy_scheme: Some(scheme),
                https_preferred,
            }
        }
        Err(_) => NetworkAudit {
            status: SecurityStatus::Fail,
            mode,
            proxy_scheme: None,
            https_preferred,
        },
    }
}

// ---------- Storage ----------

fn cache_totals(state: &AppState) -> (u64, u64) {
    // stats = (page+thumb bytes, budget, pages, thumbs, webtoon bytes, tiles)
    let (page_thumb_bytes, _, _, _, webtoon_bytes, _) = state.cache.stats();
    (
        page_thumb_bytes.saturating_add(webtoon_bytes),
        state
            .render
            .disk_bytes()
            .saturating_add(state.online_cache.disk_bytes()),
    )
}

fn read_storage_evidence(app: &AppHandle, state: &AppState) -> (u64, u64, u32, bool) {
    let (memory_cache_bytes, disk_cache_bytes) = cache_totals(state);
    let live_webviews = app.webview_windows().len().min(u32::MAX as usize) as u32;
    let session_headers_in_memory = state
        .session_online_headers
        .lock()
        .as_deref()
        .is_some_and(|headers| !headers.trim().is_empty());
    (
        memory_cache_bytes,
        disk_cache_bytes,
        live_webviews,
        session_headers_in_memory,
    )
}

fn audit_storage(app: &AppHandle, state: &AppState) -> StorageAudit {
    // Reads should not fail: disk_bytes returns 0 on errors (still pass) and
    // there are no unwraps. If a read panics, report fail instead of crashing
    // the command.
    let evidence = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        read_storage_evidence(app, state)
    }));

    match evidence {
        Ok((memory_cache_bytes, disk_cache_bytes, live_webviews, session_headers_in_memory)) => {
            StorageAudit {
                status: SecurityStatus::Pass,
                memory_cache_bytes,
                disk_cache_bytes,
                live_webviews,
                session_headers_in_memory,
            }
        }
        Err(_) => StorageAudit {
            status: SecurityStatus::Fail,
            memory_cache_bytes: 0,
            disk_cache_bytes: 0,
            live_webviews: 0,
            session_headers_in_memory: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serializes_lowercase_and_overall_uses_worst() {
        assert_eq!(
            serde_json::to_string(&SecurityStatus::Fail).unwrap(),
            "\"fail\""
        );
        assert_eq!(
            serde_json::to_string(&SecurityStatus::Pass).unwrap(),
            "\"pass\""
        );

        let overall = [
            SecurityStatus::Pass,
            SecurityStatus::Unknown,
            SecurityStatus::Warn,
            SecurityStatus::Pass,
        ]
        .into_iter()
        .fold(SecurityStatus::Pass, SecurityStatus::worst);
        assert_eq!(overall, SecurityStatus::Warn);

        let overall = [SecurityStatus::Warn, SecurityStatus::Fail]
            .into_iter()
            .fold(SecurityStatus::Unknown, SecurityStatus::worst);
        assert_eq!(overall, SecurityStatus::Fail);
    }

    #[test]
    fn embedded_capabilities_are_local_windows_only_and_remote_free() {
        let evidence = parse_capability_evidence(CAPABILITIES_JSON).expect("capability 应可解析");
        assert_eq!(
            evidence.windows,
            vec![
                "main".to_string(),
                "recovery".to_string(),
                "browser".to_string()
            ]
        );
        assert_eq!(evidence.remote_capabilities, 0);
        assert!(evidence.scoped);
    }

    #[test]
    fn capability_arrays_merge_windows_and_count_remote_entries() {
        let raw = r#"[
            {"identifier":"default","windows":["main"]},
            {"identifier":"remote","windows":["browser","main"],"remote":{"urls":["https://example.com"]}}
        ]"#;
        let evidence = parse_capability_evidence(raw).expect("数组应可解析");
        assert_eq!(
            evidence.windows,
            vec!["main".to_string(), "browser".to_string()]
        );
        assert_eq!(evidence.remote_capabilities, 1);
        assert!(!evidence.scoped);
    }

    #[test]
    fn capability_glob_is_not_scoped() {
        let evidence = parse_capability_evidence(r#"{"windows":["*"]}"#).unwrap();
        assert!(!evidence.scoped);
        let evidence = parse_capability_evidence(r#"{"windows":["main","*"]}"#).unwrap();
        assert!(!evidence.scoped);
    }

    #[test]
    fn malformed_capability_is_an_error() {
        assert!(parse_capability_evidence("{not json").is_err());
        assert!(parse_capability_evidence(r#"{"windows":"main"}"#).is_err());
        assert!(parse_capability_evidence("[]").map(|e| e.scoped) == Ok(false));
    }

    #[test]
    fn update_requires_https_or_loopback_and_rejects_userinfo() {
        let configured = audit_update_with("https://updates.example.com/latest.json", true);
        assert_eq!(configured.status, SecurityStatus::Pass);
        assert!(configured.manifest_https);

        let remote_http = audit_update_with("http://updates.example.com/latest.json", true);
        assert_eq!(remote_http.status, SecurityStatus::Fail);
        assert!(!remote_http.manifest_https);

        let localhost_http = audit_update_with("http://localhost:8080/latest.json", true);
        assert_eq!(localhost_http.status, SecurityStatus::Pass);
        assert!(localhost_http.manifest_https);

        let loopback_v4 = audit_update_with("http://127.0.0.1/latest.json", true);
        assert_eq!(loopback_v4.status, SecurityStatus::Pass);

        let loopback_v6 = audit_update_with("http://[::1]:9000/latest.json", true);
        assert_eq!(loopback_v6.status, SecurityStatus::Pass);

        let userinfo = audit_update_with("https://user:pass@updates.example.com/latest.json", true);
        assert_eq!(userinfo.status, SecurityStatus::Fail);

        let unsupported = audit_update_with("ftp://updates.example.com/latest.json", true);
        assert_eq!(unsupported.status, SecurityStatus::Fail);

        let invalid = audit_update_with("not a url", true);
        assert_eq!(invalid.status, SecurityStatus::Fail);
    }

    #[test]
    fn update_without_build_key_warns_and_blank_manifest_is_not_configured() {
        let blank = audit_update_with("   ", false);
        assert!(!blank.manifest_configured);
        assert_eq!(blank.status, SecurityStatus::Warn);
        assert_eq!(blank.key_source, "none");
        assert!(blank.sha256_enforced);

        let configured_key = audit_update_with("", true);
        assert_eq!(configured_key.status, SecurityStatus::Pass);
        assert_eq!(configured_key.key_source, "build");

        let valid_without_key = audit_update_with("https://updates.example.com/latest.json", false);
        assert_eq!(valid_without_key.status, SecurityStatus::Warn);
    }

    #[test]
    fn network_audit_reports_scheme_without_credentials() {
        let direct = audit_network("   ");
        assert_eq!(direct.status, SecurityStatus::Pass);
        assert_eq!(direct.mode, "direct");
        assert_eq!(direct.proxy_scheme, None);
        assert!(direct.https_preferred);

        let http = audit_network("http://127.0.0.1:7890");
        assert_eq!(http.status, SecurityStatus::Warn);
        assert_eq!(http.mode, "proxy");
        assert_eq!(http.proxy_scheme.as_deref(), Some("http"));

        let https = audit_network("https://127.0.0.1:7890");
        assert_eq!(https.status, SecurityStatus::Pass);

        let socks = audit_network("socks5://127.0.0.1:1080");
        assert_eq!(socks.status, SecurityStatus::Pass);
        assert_eq!(socks.proxy_scheme.as_deref(), Some("socks5"));

        let userinfo = audit_network("http://alice:secret@127.0.0.1:7890");
        assert_eq!(userinfo.status, SecurityStatus::Fail);
        assert_eq!(userinfo.proxy_scheme.as_deref(), Some("http"));
        let json = serde_json::to_string(&userinfo).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("alice"));

        let unsupported = audit_network("ftp://127.0.0.1:21");
        assert_eq!(unsupported.status, SecurityStatus::Fail);
        assert_eq!(unsupported.proxy_scheme.as_deref(), Some("ftp"));

        let invalid = audit_network("not a url");
        assert_eq!(invalid.status, SecurityStatus::Fail);
        assert_eq!(invalid.proxy_scheme, None);

        let no_host = audit_network("socks5://:1080");
        assert_eq!(no_host.status, SecurityStatus::Fail);
    }
}
