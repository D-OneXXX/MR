import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./theme.css";
import "./components/ui.css";
import "./v3.css";

// v2「流体」设计语言：深色沉浸为默认。一次性迁移老用户的亮色设置，
// 之后用户仍可自由切换（选择照常持久化）。
let theme = localStorage.getItem("mr-theme") || "dark";
if (!localStorage.getItem("mr-theme-v2")) {
  theme = "dark";
  try {
    localStorage.setItem("mr-theme-v2", "1");
  } catch {
    /* 忽略 */
  }
}
try {
  localStorage.setItem("mr-theme", theme);
} catch {
  /* 忽略 */
}
document.documentElement.dataset.theme = theme;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
