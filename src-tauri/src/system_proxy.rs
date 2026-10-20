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

#[tauri::command]
pub fn detect_system_proxy() -> Result<Option<String>, String> {
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
        return Ok(proxy_from_system_settings(enable, server.as_deref()));
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
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
    let mut buffer = vec![0u16; (size as usize + 1) / 2];
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
}
