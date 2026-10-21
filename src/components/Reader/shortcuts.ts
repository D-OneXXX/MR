/** 阅读器快捷键一览（设置页表格与阅读器 ? 弹层共用同一份数据源）。 */
export const READER_SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "← / →", action: "翻页（方向随日式右开/西式左开）" },
  { keys: "Space", action: "下一页" },
  { keys: "Shift + Space", action: "上一页" },
  { keys: "f", action: "切换版式（单页 / 双页 / 条漫）" },
  { keys: "Ctrl + 1…9", action: "切换到书库 / 阅读页签" },
  { keys: "Ctrl + W", action: "关闭当前阅读页签" },
  { keys: "Ctrl + 滚轮 / 双指", action: "缩放" },
  { keys: "拖拽", action: "平移（放大后）" },
  { keys: "双击", action: "重置视图" },
  { keys: "Home / End", action: "第一页 / 最后一页" },
  { keys: "Esc", action: "关弹层 → 返回书库" },
  { keys: "?", action: "本速查表" },
];
