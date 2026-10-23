/** Cross-page DOM events. Keep names stable: Tauri listeners and pages rely on them. */
export const LIBRARY_REFRESH_EVENT = "mr-online-library-refresh";
export const FOCUS_LIBRARY_SEARCH_EVENT = "mr-focus-library-search";
export const SETTINGS_UPDATED_EVENT = "mr-settings-updated";
/** 后端单实例/文件关联队列有新请求的唤醒信号（无载荷）。 */
export const OPEN_WITH_PENDING_EVENT = "open-with-pending";
