import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@/i18n";
import WebApp from "./WebApp";
import "../index.css";

/**
 * Web Access 独立入口（W2 / BLK-2 验证原型）。
 *
 * 与桌面入口（src/main.tsx）刻意保持分离：
 * - 不引入 ThemeProvider / SafeModeProvider / DbRecoveryGate / UpdateProvider
 *   等任何依赖 Tauri IPC 的 Provider；
 * - 不引入 features/online、features/pdf、features/resilience 等桌面专属模块。
 *
 * 主题由 web.html 的首屏内联脚本处理（与主入口同源），从而避免为了套用主题
 * 而把 @tauri-apps/api/core 拖进 Web 产物。
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider documentTitleKey="app.title">
      <WebApp />
    </I18nProvider>
  </React.StrictMode>,
);
