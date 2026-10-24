import { invoke } from "@tauri-apps/api/core";
import type { BackupImportResult } from "@/features/backup/api";

export interface DbHealth {
  ok: boolean;
  /** db-open-failed / db-schema-failed / db-quick-check-failed；健康时为 null。 */
  errorCode: string | null;
  dataDir: string;
}

export const recoveryApi = {
  getDbHealth: () => invoke<DbHealth>("get_db_health"),
  openDataDir: () => invoke<void>("open_data_dir"),
  recoverDatabase: (sourcePath: string) =>
    invoke<BackupImportResult>("recover_database_from_backup", {
      sourcePath,
    }),
};
