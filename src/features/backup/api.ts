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

export interface SkippedBackupBook {
  id: string;
  title: string;
  /** path-relative / path-missing / path-not-book / path-unsafe */
  reason: string;
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
  /** 路径不存在/不是书源/命中敏感目录而被跳过的本地书。 */
  skippedBooks?: SkippedBackupBook[] | null;
  /** 备份 manifest schema 高于当前程序时的前向兼容标记（同版本为空）。 */
  forwardSchema?: number | null;
}

/**
 * 本地备份命令封装。
 * 参数统一使用 Tauri 的驼峰命名（destPath / sourcePath），
 * 后端负责 SQLite 数据与缓存，偏好由前端 capture/apply 处理。
 */
export const backupApi = {
  exportBackup: (destPath: string, preferencesJson: string) =>
    invoke<BackupExportResult>("export_backup", { destPath, preferencesJson }),

  importBackup: (sourcePath: string, allowSkipped = false) =>
    invoke<BackupImportResult>("import_backup", { sourcePath, allowSkipped }),
};
