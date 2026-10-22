fn main() {
    // Expose a stable, human-readable build baseline to the updater UI.
    // This is intentionally a build-time value: release builds from a dirty
    // tree should not claim a clean commit.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .current_dir(&manifest_dir)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "local".to_string());
    let dirty = std::process::Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(&manifest_dir)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| !output.stdout.is_empty())
        .unwrap_or(true);
    let baseline = if dirty {
        format!("{commit}-dirty")
    } else {
        commit
    };
    println!("cargo:rustc-env=MR_BUILD_BASELINE={baseline}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    tauri_build::build()
}
