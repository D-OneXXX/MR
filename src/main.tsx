import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./features/theme/ThemeProvider";
import { UpdateProvider } from "./features/update/UpdateProvider";
import { SafeModeProvider } from "./features/safeMode/SafeModeContext";
import { installResilienceRuntime } from "./features/resilience/runtime";
import AppErrorBoundary from "./components/AppErrorBoundary";
import {
  installStorageSanitizerApi,
  reportSanitizeResult,
  sanitizeStorage,
} from "./lib/storageSanitizer";
import "./index.css";

// —— 本地持久化状态安全清洗 ——
// 老用户 localStorage 可能残留已下线功能（翻译工作台 / 术语表 / OCR / 服务状态等）的键，
// 也可能有非法枚举值（如旧主题 "dark-blue"）或写坏的 JSON。
// 必须在 React 挂载前清掉，否则首屏可能因脏状态白屏；任何异常都不得阻断启动。
try {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null; // 隐私模式 / 禁用 Cookie：取不到存储就静默跳过
  }
  reportSanitizeResult(sanitizeStorage(storage));
} catch {
  /* 清洗失败绝不阻断启动 */
}

// QA 入口：页面控制台可直接调用 window.__mrStorageSanitizer.sanitizeStorage(...) 断言。
installStorageSanitizerApi();

installResilienceRuntime();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <UpdateProvider>
          <HashRouter>
            <SafeModeProvider>
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </SafeModeProvider>
          </HashRouter>
        </UpdateProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>,
);
