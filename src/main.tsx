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
import "./index.css";

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
