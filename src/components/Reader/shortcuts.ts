import type { MessageKey } from "@/i18n";

/** 阅读器快捷键一览（阅读器 ? 弹层使用；键位保持原样，说明走 i18n）。 */
export const READER_SHORTCUTS: {
  keys?: string;
  keysKey?: MessageKey;
  actionKey: MessageKey;
}[] = [
  { keys: "← / →", actionKey: "reader.shortcut.pageTurn" },
  { keys: "Space", actionKey: "reader.nav.next" },
  { keys: "Shift + Space", actionKey: "reader.nav.prev" },
  { keys: "f", actionKey: "reader.shortcut.mode" },
  { keys: "Ctrl + 1…9", actionKey: "reader.shortcut.tabs" },
  { keys: "Ctrl + W", actionKey: "reader.shortcut.closeTab" },
  { keysKey: "reader.shortcut.keys.zoom", actionKey: "reader.shortcut.zoom" },
  { keysKey: "reader.shortcut.keys.pan", actionKey: "reader.shortcut.pan" },
  { keysKey: "reader.shortcut.keys.reset", actionKey: "reader.shortcut.reset" },
  { keys: "Home / End", actionKey: "reader.shortcut.homeEnd" },
  { keys: "Esc", actionKey: "reader.shortcut.escape" },
  { keys: "?", actionKey: "reader.shortcut.help" },
];
