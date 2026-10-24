//! 系统代理探测：环境变量优先，Windows 下回退到当前用户 Internet Settings。

use url::Url;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::ERROR_SUCCESS;
#[cfg(windows)]
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

fn select_env_proxy_raw(pairs: &[(String, String)]) -> Option<String> {
    for wanted in ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"] {
        if let Some((_, value)) = pairs
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
        {
            if !value.trim().is_empty() {
                return Some(value.clone());
            }
        }
    }
    None
}

fn select_proxy_server(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut https = None;
    let mut http = None;
    for part in raw.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if key.eq_ignore_ascii_case("https") {
            https = Some(value.to_string());
            break;
        }
        if key.eq_ignore_ascii_case("http") {
            http = Some(value.to_string());
        }
    }
    https.or(http).or_else(|| Some(raw.to_string()))
}

fn normalize_proxy_value(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.contains(';') {
        return None;
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    if crate::online::validate_proxy(&candidate).is_err() {
        return None;
    }
    let url = Url::parse(&candidate).ok()?;
    let host = match url.host()? {
        url::Host::Ipv6(addr) => format!("[{addr}]"),
        url::Host::Ipv4(addr) => addr.to_string(),
        url::Host::Domain(domain) => domain.to_string(),
    };
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn proxy_from_system_settings(
    proxy_enable: Option<u32>,
    proxy_server: Option<&str>,
) -> Option<String> {
    if proxy_enable.unwrap_or(0) == 0 {
        return None;
    }
    let server = proxy_server?;
    normalize_proxy_value(&select_proxy_server(server)?)
}

/// 系统代理探测可能启动 `gsettings` / 读取 KDE 配置，必须离开主线程；
/// 同步命令在部分平台上会卡住首帧。Tauri 侧只暴露异步包装。
#[tauri::command]
pub async fn detect_system_proxy() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(detect_system_proxy_blocking)
        .await
        .map_err(|error| format!("系统代理探测失败：{error}"))?
}

fn detect_system_proxy_blocking() -> Result<Option<String>, String> {
    let pairs: Vec<(String, String)> = std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    if let Some(raw) = select_env_proxy_raw(&pairs) {
        return Ok(normalize_proxy_value(&raw));
    }

    #[cfg(windows)]
    {
        let (enable, server) = read_registry_proxy();
        Ok(proxy_from_system_settings(enable, server.as_deref()))
    }
    #[cfg(target_os = "linux")]
    {
        // 环境变量未配置时：GNOME gsettings → KDE kioslaverc。
        return Ok(proxy_from_desktop_settings());
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Ok(None)
    }
}

// ---------- Linux 桌面代理（GNOME gsettings / KDE kioslaverc） ----------
//
// 纯解析函数用 `cfg(any(target_os = "linux", test))` 隔离：Windows 宿主上
// `cargo test` 依然覆盖解析逻辑；子进程/文件 IO 才严格限定在 Linux。

/// `gsettings get` 输出剥引号：`'manual'` → `manual`，`7890` → `7890`。
#[cfg(any(target_os = "linux", test))]
fn gsettings_unquote(raw: &str) -> &str {
    raw.trim().trim_matches('\'')
}

/// GNOME 手动代理合成（纯函数）：host 为空或端口为 0 视为未配置；
/// 优先 https，其次 http，最后 socks（组合为 socks5://）。
#[cfg(any(target_os = "linux", test))]
fn proxy_from_gsettings_values<S: AsRef<str>>(
    https: Option<(S, u32)>,
    http: Option<(S, u32)>,
    socks: Option<(S, u32)>,
) -> Option<String> {
    let pick_http = |entry: Option<(S, u32)>| -> Option<String> {
        let (host, port) = entry?;
        let host = host.as_ref().trim();
        if host.is_empty() || port == 0 {
            return None;
        }
        normalize_proxy_value(&format!("http://{host}:{port}"))
    };
    if let Some(proxy) = pick_http(https).or_else(|| pick_http(http)) {
        return Some(proxy);
    }
    let (host, port) = socks?;
    let host = host.as_ref().trim();
    if host.is_empty() || port == 0 {
        return None;
    }
    normalize_proxy_value(&format!("socks5://{host}:{port}"))
}

/// KDE `kioslaverc` 解析（纯函数）。
///
/// `[Proxy Settings]` 段：`ProxyType=1` 才是手动代理（0=无、2=PAC、
/// 3=自动发现、4=环境变量——环境变量已在前一步探测过）；值形如
/// `httpsProxy=http://127.0.0.1:7890` 或 `host:port`。
#[cfg(any(target_os = "linux", test))]
fn proxy_from_kioslaverc(content: &str) -> Option<String> {
    let mut in_proxy_section = false;
    let mut proxy_type: Option<u32> = None;
    let (mut https, mut http, mut socks) = (None, None, None);
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_proxy_section = line == "[Proxy Settings]";
            continue;
        }
        if !in_proxy_section {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "ProxyType" => proxy_type = value.trim().parse::<u32>().ok(),
            "httpsProxy" => https = Some(value.trim().to_string()),
            "httpProxy" => http = Some(value.trim().to_string()),
            "socksProxy" => socks = Some(value.trim().to_string()),
            _ => {}
        }
    }
    if proxy_type != Some(1) {
        return None;
    }
    [https, http, socks]
        .into_iter()
        .flatten()
        .find_map(|raw| normalize_proxy_value(&raw))
}

#[cfg(target_os = "linux")]
fn proxy_from_desktop_settings() -> Option<String> {
    proxy_from_gnome().or_else(proxy_from_kde)
}

/// GNOME：`gsettings get org.gnome.system.proxy mode` 为 `manual` 时
/// 读取 https/http/socks 三组 host+port。
#[cfg(target_os = "linux")]
fn proxy_from_gnome() -> Option<String> {
    let gsettings_get = |schema: &str, key: &str| -> Option<String> {
        let output = std::process::Command::new("gsettings")
            .args(["get", schema, key])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        Some(gsettings_unquote(&String::from_utf8_lossy(&output.stdout)).to_string())
    };
    let mode = gsettings_get("org.gnome.system.proxy", "mode")?;
    if mode != "manual" {
        return None;
    }
    let read_pair = |schema: &str| -> Option<(String, u32)> {
        let host = gsettings_get(schema, "host")?;
        let port = gsettings_get(schema, "port")?.parse::<u32>().ok()?;
        Some((host, port))
    };
    proxy_from_gsettings_values(
        read_pair("org.gnome.system.proxy.https"),
        read_pair("org.gnome.system.proxy.http"),
        read_pair("org.gnome.system.proxy.socks"),
    )
}

/// KDE：解析 `~/.config/kioslaverc`。
#[cfg(target_os = "linux")]
fn proxy_from_kde() -> Option<String> {
    let config = dirs::config_dir()?.join("kioslaverc");
    let content = std::fs::read_to_string(config).ok()?;
    proxy_from_kioslaverc(&content)
}

#[cfg(windows)]
const REGISTRY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_registry_dword(subkey: &str, name: &str) -> Option<u32> {
    let subkey = wide(subkey);
    let name = wide(name);
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(value)
}

#[cfg(windows)]
fn read_registry_sz(subkey: &str, name: &str) -> Option<String> {
    let subkey = wide(subkey);
    let name = wide(name);
    let mut size = 0u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS || size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut c_void),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let len = (size as usize / 2).min(buffer.len());
    let end = buffer[..len]
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(len);
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(windows)]
fn read_registry_proxy() -> (Option<u32>, Option<String>) {
    let enable = read_registry_dword(REGISTRY_PATH, "ProxyEnable");
    let server = if enable.unwrap_or(0) != 0 {
        read_registry_sz(REGISTRY_PATH, "ProxyServer")
    } else {
        None
    };
    (enable, server)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn env_proxy_priority_is_case_insensitive() {
        let env = pairs(&[
            ("all_proxy", "socks5://127.0.0.1:3"),
            ("http_proxy", "127.0.0.1:2"),
            ("https_proxy", "127.0.0.1:1"),
        ]);
        assert_eq!(select_env_proxy_raw(&env).as_deref(), Some("127.0.0.1:1"));

        let env = pairs(&[
            ("ALL_PROXY", "socks5://127.0.0.1:3"),
            ("HTTP_PROXY", "127.0.0.1:2"),
        ]);
        assert_eq!(select_env_proxy_raw(&env).as_deref(), Some("127.0.0.1:2"));
    }

    #[test]
    fn empty_high_priority_env_falls_through() {
        let env = pairs(&[
            ("HTTPS_PROXY", "   "),
            ("HTTP_PROXY", "127.0.0.1:2"),
            ("ALL_PROXY", "socks5://127.0.0.1:3"),
        ]);
        assert_eq!(select_env_proxy_raw(&env).as_deref(), Some("127.0.0.1:2"));
    }

    #[test]
    fn normalizes_proxy_values() {
        assert_eq!(
            normalize_proxy_value("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            normalize_proxy_value("HTTPS://proxy.example:8443/path").as_deref(),
            Some("https://proxy.example:8443")
        );
        assert_eq!(
            normalize_proxy_value("socks5://127.0.0.1:1080").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(normalize_proxy_value(""), None);
        assert_eq!(normalize_proxy_value("ftp://127.0.0.1:21"), None);
        assert_eq!(normalize_proxy_value("http://"), None);
        assert_eq!(
            normalize_proxy_value("http://user:pass@127.0.0.1:7890"),
            None
        );
    }

    #[test]
    fn parses_proxy_server_entries() {
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("http=127.0.0.1:8080;https=127.0.0.1:8443"))
                .as_deref(),
            Some("http://127.0.0.1:8443")
        );
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("http=127.0.0.1:8080")).as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("127.0.0.1:9090")).as_deref(),
            Some("http://127.0.0.1:9090")
        );
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("HTTPS=proxy.example:443")).as_deref(),
            Some("http://proxy.example:443")
        );
    }

    #[test]
    fn disabled_or_missing_proxy_enable_returns_none() {
        assert_eq!(
            proxy_from_system_settings(Some(0), Some("127.0.0.1:7890")),
            None
        );
        assert_eq!(
            proxy_from_system_settings(None, Some("127.0.0.1:7890")),
            None
        );
        assert_eq!(proxy_from_system_settings(Some(1), None), None);
        assert_eq!(proxy_from_system_settings(Some(1), Some("")), None);
    }

    #[test]
    fn invalid_system_proxy_values_return_none() {
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("ftp://127.0.0.1:21")),
            None
        );
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("http=;https=")),
            None
        );
        assert_eq!(
            proxy_from_system_settings(Some(1), Some("socks=127.0.0.1:1080")),
            None
        );
    }

    #[test]
    fn gsettings_values_pick_https_then_http_then_socks() {
        assert_eq!(
            proxy_from_gsettings_values(
                Some(("proxy.gnome.example", 8443)),
                Some(("127.0.0.1", 8080)),
                None
            )
            .as_deref(),
            Some("http://proxy.gnome.example:8443")
        );
        assert_eq!(
            proxy_from_gsettings_values(
                None,
                Some(("127.0.0.1", 8080)),
                Some(("127.0.0.1", 1080))
            )
            .as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(
            proxy_from_gsettings_values(None, None, Some(("127.0.0.1", 1080))).as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        // 空 host 或 0 端口视为未配置；全部缺失 → None。
        assert_eq!(
            proxy_from_gsettings_values(Some(("  ", 8443)), None, None),
            None
        );
        assert_eq!(
            proxy_from_gsettings_values(Some(("127.0.0.1", 0)), None, None),
            None
        );
        assert_eq!(
            proxy_from_gsettings_values::<&str>(None, None, None),
            None
        );
    }

    #[test]
    fn gsettings_mode_unquote_strips_single_quotes() {
        assert_eq!(gsettings_unquote("'manual'\n"), "manual");
        assert_eq!(gsettings_unquote("7890\n"), "7890");
        assert_eq!(gsettings_unquote("  'none'  "), "none");
    }

    #[test]
    fn kioslaverc_requires_manual_proxy_type_and_prefers_https() {
        let manual = "[Proxy Settings]\nProxyType=1\nhttpsProxy=http://127.0.0.1:8443\nhttpProxy=127.0.0.1:8080\nsocksProxy=socks5://127.0.0.1:1080\n";
        assert_eq!(
            proxy_from_kioslaverc(manual).as_deref(),
            Some("http://127.0.0.1:8443")
        );
        // https 缺失时回退 http（无 scheme，由 normalize 补 http://）。
        let http_only = "[Proxy Settings]\nProxyType=1\nhttpProxy=127.0.0.1:8080\n";
        assert_eq!(
            proxy_from_kioslaverc(http_only).as_deref(),
            Some("http://127.0.0.1:8080")
        );
        // ProxyType ≠ 1（0=无 / 2=PAC / 3=自动发现 / 4=环境变量）→ None。
        for disabled in [0u32, 2, 3, 4] {
            let content = format!(
                "[Proxy Settings]\nProxyType={disabled}\nhttpsProxy=http://127.0.0.1:8443\n"
            );
            assert_eq!(proxy_from_kioslaverc(&content), None, "ProxyType={disabled}");
        }
        // 缺段、缺 ProxyType、坏端口 → None。
        assert_eq!(proxy_from_kioslaverc("[Other]\nProxyType=1\n"), None);
        assert_eq!(
            proxy_from_kioslaverc("[Proxy Settings]\nhttpsProxy=http://127.0.0.1:1\n"),
            None
        );
        // 值带凭据或非法 scheme → normalize 拒绝。
        let cred = "[Proxy Settings]\nProxyType=1\nhttpsProxy=http://user:pass@127.0.0.1:1\n";
        assert_eq!(proxy_from_kioslaverc(cred), None);
    }
}
