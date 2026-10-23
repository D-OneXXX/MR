import { invoke } from "@tauri-apps/api/core";

/** 导出备份的返回值（与 Rust `export_backup` 契约一致，camelCase）。 */
export interface BackupExportResult {
  path: string;
  bytes: number;
  books: number;
  readingDays: number;
  rules: number;
  profiles: number;
  preferencesIncluded: boolean;
  createdAt: string;
}

/** 导入备份的返回值；`preferencesJson` 为前端打包的轻量偏好快照。 */
export interface BackupImportResult {
  books: number;
  readingDays: number;
  rules: number;
  profiles: number;
  preferencesJson: string | null;
  createdAt: string | null;
  appVersion: string | null;
}

/**
 * 本地备份命令封装。
 * 参数统一使用 Tauri 的驼峰命名（destPath / sourcePath），
 * 后端负责 SQLite 数据与缓存，偏好由前端 capture/apply 处理。
 */
export const backupApi = {
  exportBackup: (destPath: string, preferencesJson: string) =>
    invoke<BackupExportResult>("export_backup", { destPath, preferencesJson }),

  importBackup: (sourcePath: string) =>
    invoke<BackupImportResult>("import_backup", { sourcePath }),
};
