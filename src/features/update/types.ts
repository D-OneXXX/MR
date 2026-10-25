/** Software update contract shared by the updater provider and settings UI. */

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
