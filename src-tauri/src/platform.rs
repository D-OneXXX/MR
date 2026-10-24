//! 跨平台启动期加固与安装形态探测。
//!
//! Linux（WebKitGTK）专属逻辑全部用 `#[cfg(target_os = "linux")]` 隔离；
//! Windows 路径零改动。纯决策函数保持跨平台可测（Windows 宿主上
//! `cargo test` 也能覆盖决策表）。

/// setup 之前的启动期环境加固。
///
/// Linux + WebKitGTK：在安全模式、用户显式请求或「Wayland + NVIDIA」
/// 组合下注入 `WEBKIT_DISABLE_DMABUF_RENDERER=1`，避免 DMABUF 渲染器
/// 在部分驱动栈上黑屏/闪烁。用户已手动设置的值永远优先，不覆盖。
pub fn early_env_hardening() {
    #[cfg(target_os = "linux")]
    linux_webkit_hardening();
}

/// DMABUF 禁用决策（纯函数，便于测试）。
///
/// - `user_set`：用户环境里已有 `WEBKIT_DISABLE_DMABUF_RENDERER` → 不动；
/// - `force`：`MR_FORCE_DISABLE_DMABUF=1` 显式请求 → 禁用；
/// - `safe_mode`：安全模式激活 → 禁用；
/// - `wayland && nvidia`：Wayland 合成器 + NVIDIA 专有驱动 → 禁用。
// 非 Linux 目标上唯一调用方被 cfg 掉，保留函数供测试与文档引用。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn decide_dmabuf_disable(user_set: bool, force: bool, safe_mode: bool, wayland: bool, nvidia: bool) -> bool {
    if user_set {
        return false;
    }
    force || safe_mode || (wayland && nvidia)
}

#[cfg(target_os = "linux")]
const DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

#[cfg(target_os = "linux")]
fn linux_webkit_hardening() {
    if std::env::var_os(DMABUF_ENV).is_some() {
        return;
    }
    let force = std::env::var("MR_FORCE_DISABLE_DMABUF").map(|v| v == "1").unwrap_or(false);
    let safe_mode = linux_safe_mode_active();
    let wayland = linux_wayland_session();
    let nvidia = linux_nvidia_present();
    if decide_dmabuf_disable(false, force, safe_mode, wayland, nvidia) {
        // Rust 2021 edition：set_var 仍是安全 API。
        std::env::set_var(DMABUF_ENV, "1");
        let reason = if force {
            "user-override"
        } else if safe_mode {
            "safe-mode"
        } else {
            "nvidia-wayland"
        };
        eprintln!("[platform] WEBKIT_DISABLE_DMABUF_RENDERER=1（{reason}）");
    }
}

/// 安全模式标记文件在 setup 之前读取：数据根尚未经 Tauri 解析，
/// 按 XDG 约定直接定位（`MR_DATA_DIR` > `$XDG_DATA_HOME` > `~/.local/share`）。
#[cfg(target_os = "linux")]
fn linux_pre_setup_data_dir() -> Option<std::path::PathBuf> {
    if let Some(raw) = std::env::var_os("MR_DATA_DIR") {
        let trimmed = raw.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return Some(std::path::PathBuf::from(trimmed));
        }
    }
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })?;
    Some(base.join("com.local.manga-reader"))
}

#[cfg(target_os = "linux")]
fn linux_safe_mode_active() -> bool {
    let Some(dir) = linux_pre_setup_data_dir() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(dir.join("safe-mode.json")) else {
        return false;
    };
    #[derive(serde::Deserialize)]
    struct SafeModeFlag {
        #[serde(default)]
        active: bool,
    }
    serde_json::from_str::<SafeModeFlag>(&raw)
        .map(|flag| flag.active)
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_nvidia_present() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::env::var("__GLX_VENDOR_LIBRARY_NAME").map(|v| v == "nvidia").unwrap_or(false)
}

/// 当前安装形态（更新策略使用；跨平台编译，非 Linux 恒为空串）。
///
/// - `appimage`：AppImage 运行态（`APPIMAGE`/`APPDIR` 由运行时注入）；
/// - `system`：`/usr`、`/opt` 下的系统安装（deb/rpm 包管理器管辖）；
/// - `portable`：其余（开发态、手动解压运行）；
/// - Windows/macOS：空串，前端据此完全跳过 Linux 更新策略分支。
pub fn install_channel() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_some() && std::env::var_os("APPDIR").is_some() {
            return "appimage";
        }
        if let Ok(exe) = std::env::current_exe() {
            if exe.starts_with("/usr/") || exe.starts_with("/opt/") {
                return "system";
            }
        }
        "portable"
    }
    #[cfg(not(target_os = "linux"))]
    {
        ""
    }
}

/// 目标路径所在卷的可用字节数（更新下载前预检）。
///
/// 用 sysinfo 的挂载点列表做跨平台探测：取包含 canonical path 的最长挂载点，
/// 避免把 Windows 多盘符或 Linux bind mount 的 `/` 当成唯一答案。
pub fn free_bytes(path: &std::path::Path) -> Option<u64> {
    let canonical = path.canonicalize().ok()?;
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dmabuf_decision_table() {
        // 用户已设置 → 永不覆盖。
        assert!(!decide_dmabuf_disable(true, false, false, true, true));
        // 显式请求 / 安全模式 / NVIDIA+Wayland 各自独立触发。
        assert!(decide_dmabuf_disable(false, true, false, false, false));
        assert!(decide_dmabuf_disable(false, false, true, false, false));
        assert!(decide_dmabuf_disable(false, false, false, true, true));
        // NVIDIA 但 X11、或 Wayland 但非 NVIDIA → 不动默认渲染路径。
        assert!(!decide_dmabuf_disable(false, false, false, true, false));
        assert!(!decide_dmabuf_disable(false, false, false, false, true));
        assert!(!decide_dmabuf_disable(false, false, false, false, false));
    }

    #[test]
    fn install_channel_is_empty_off_linux() {
        let channel = install_channel();
        if cfg!(target_os = "linux") {
            assert!(matches!(channel, "appimage" | "system" | "portable"));
        } else {
            assert_eq!(channel, "");
        }
    }
}
