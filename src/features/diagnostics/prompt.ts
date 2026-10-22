import type { DiagnosticBundle } from "./types";
import { APP_VERSION, BUILD_COMMIT } from "@/lib/version";

const ACTION_LABELS: Record<string, string> = {
  navigation: "Navigation",
  readerMode: "Reader mode change",
  archiveImport: "Archive import",
  folderImport: "Folder import",
  onlineRead: "Online direct read",
  settingsChange: "Settings change",
  themeChange: "Theme change",
  localeChange: "Locale change",
  onlinePairing: "External browser pairing",
  recovery: "Recovery action",
  safeMode: "Safe mode",
  update: "App update",
  privacy: "Privacy / security action",
  readerPage: "Reader page change",
  other: "Other action",
};

function fenceFor(content: string): string {
  let longest = 0;
  let current = 0;
  for (const char of content) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function codeBlock(content: string, language = ""): string {
  const safe = content.trim() || "(none)";
  const fence = fenceFor(safe);
  return `${fence}${language}\n${safe}\n${fence}`;
}

function actionLabel(kind: string): string {
  return ACTION_LABELS[kind] ?? kind;
}

function readerLabel(mode?: string | null): string {
  if (mode === "single" || mode === "double" || mode === "webtoon") {
    return mode;
  }
  return "unknown";
}

function runtimeSection(bundle: DiagnosticBundle): string {
  const r = bundle.runtime;
  return [
    "## Runtime environment",
    `- App version: ${r.version}`,
    `- Build baseline: ${r.buildBaseline}`,
    `- Frontend bundle: ${APP_VERSION} (${BUILD_COMMIT})`,
    `- OS: ${r.os} (${r.arch})`,
    `- Route: ${r.route ?? "unknown"}`,
    `- Reader layout: ${readerLabel(r.readerMode)}${
      r.readerPage !== null && r.readerPage !== undefined
        ? `, page ${r.readerPage + 1}`
        : ""
    }`,
    `- Network: ${r.networkMode}${r.proxyScheme ? ` (${r.proxyScheme})` : ""}`,
    `- Online direct-read enabled: ${r.onlineEnabled ? "yes" : "no"}`,
    `- Safe mode: ${r.safeMode ? "active" : "inactive"}`,
  ].join("\n");
}

function breadcrumbSection(bundle: DiagnosticBundle): string {
  if (bundle.breadcrumbs.length === 0) {
    return "## Recent action trail (last 20)\n\nNone recorded.";
  }
  return [
    "## Recent action trail (last 20)",
    "",
    ...bundle.breadcrumbs.map(
      (item) =>
        `- ${item.at} — ${actionLabel(item.kind)}${
          item.route ? ` — ${item.route}` : ""
        }`,
    ),
  ].join("\n");
}

function errorSection(bundle: DiagnosticBundle): string {
  if (bundle.errors.length === 0) {
    return "## Frontend / backend errors\n\nNone recorded.";
  }
  const items = bundle.errors.map((error, index) => {
    const body = [
      `time: ${error.at}`,
      `source: ${error.source}`,
      error.route ? `route: ${error.route}` : "",
      "",
      error.message,
      error.stack ? `\n${error.stack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `### Error ${index + 1}\n\n${codeBlock(body, "text")}`;
  });
  return ["## Frontend / backend errors", "", ...items].join("\n\n");
}

function logSection(bundle: DiagnosticBundle): string {
  if (bundle.logs.length === 0) {
    return "## Developer logs\n\nNone recorded.";
  }
  const body = bundle.logs
    .map((entry) => `[${entry.at}] [${entry.scope}] ${entry.message}`)
    .join("\n");
  return `## Developer logs\n\n${codeBlock(body, "text")}`;
}

/**
 * Deterministic prompt for a coding agent. All bundle values already passed the
 * Rust sanitizer; the user has previewed this text before copying/exporting.
 */
export function buildDiagnosticPrompt(
  bundle: DiagnosticBundle,
  description: string,
): string {
  const note = description.trim() || "(No additional description provided.)";
  return [
    "# MangaReader diagnostic report",
    "",
    `Generated at: ${bundle.generatedAt}`,
    "",
    "> This report was generated locally. It has not been uploaded. Sensitive credentials and local manga paths were sanitized before preview.",
    "",
    "## User reproduction / description",
    "",
    note,
    "",
    runtimeSection(bundle),
    "",
    breadcrumbSection(bundle),
    "",
    errorSection(bundle),
    "",
    logSection(bundle),
    "",
    "## Requested diagnosis",
    "",
    "Act as a senior engineer debugging the local-first MangaReader desktop app (Tauri 2 + React 19 + TypeScript + Rust). Use the evidence above and return a concise, actionable report with exactly these sections:",
    "",
    "1. **Root cause** — classify as frontend rendering/state, Tauri IPC, Rust local-file/network parsing, or another category, and explain the evidence. If evidence is insufficient, say what is missing instead of guessing.",
    "2. **Suspected code locations** — name the most likely MangaReader modules, functions, or file paths and why they fit the evidence; distinguish confirmed facts from hypotheses.",
    "3. **Fix and temporary workaround** — propose a concrete fix, a minimal verification/test plan, and a safe user-facing workaround. Do not suggest uploading private logs or bypassing the local privacy model.",
    "",
    "Output clear Markdown. Prefer specific, testable steps over generic advice.",
    "",
  ].join("\n");
}
