import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/features/theme/ThemeProvider";
import RecoveryApp from "./RecoveryApp";
import "../index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider documentTitleKey="recovery.windowTitle">
        <RecoveryApp />
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
