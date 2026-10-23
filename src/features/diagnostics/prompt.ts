import type { DiagnosticBundle } from "./types";
import { APP_VERSION, BUILD_COMMIT } from "@/lib/version";
import { translate, type MessageKey, type TranslateVars } from "@/i18n";

/**
 * `translate` 绑定的是 `I18nProvider` 维护的活动语言，因此本模块无需接收
 * locale 参数；组件侧在 useMemo 依赖里加入 locale 即可在切换语言后重建。
 * 字典值只承载纯文本，Markdown 结构（标题层级、列表符号、代码围栏）由本模块保证。
 */
function tr(key: MessageKey, vars?: TranslateVars): string {
  return translate(key, vars);
}

const ACTION_KEY_PREFIX = "diagnostics.actionKind.";

function actionLabel(kind: string): string {
  const key = `${ACTION_KEY_PREFIX}${kind}` as MessageKey;
  const label = tr(key);
  // 未知 kind 的 key 在字典里不存在，translate 会原样返回 key，此时回落原字符串。
  return label === key ? kind : label;
}

function readerLabel(mode?: string | null): string {
  if (mode === "single" || mode === "double" || mode === "webtoon") {
    return tr(`diagnostics.mode.${mode}`);
  }
  return tr("diagnostics.prompt.unknown");
}

function valueLabel(value: boolean): string {
  return value ? tr("diagnostics.prompt.yes") : tr("diagnostics.prompt.no");
}

function stateLabel(active: boolean): string {
  return active ? tr("diagnostics.prompt.active") : tr("diagnostics.prompt.inactive");
}

function heading(title: string): string {
  return `## ${title}`;
}

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

function runtimeSection(bundle: DiagnosticBundle): string {
  const r = bundle.runtime;
  const network = `${r.networkMode}${r.proxyScheme ? ` (${r.proxyScheme})` : ""}`;
  const layout = `${readerLabel(r.readerMode)}${
    r.readerPage !== null && r.readerPage !== undefined
      ? `, ${tr("diagnostics.prompt.page", { page: r.readerPage + 1 })}`
      : ""
  }`;
  const lines = [
    tr("diagnostics.prompt.runtimeVersion", { version: r.version }),
    tr("diagnostics.prompt.runtimeBuild", { build: r.buildBaseline }),
    tr("diagnostics.prompt.runtimeBundle", {
      version: APP_VERSION,
      commit: BUILD_COMMIT,
    }),
    tr("diagnostics.prompt.runtimeOs", { os: r.os, arch: r.arch }),
    tr("diagnostics.prompt.runtimeRoute", {
      route: r.route ?? tr("diagnostics.prompt.unknown"),
    }),
    tr("diagnostics.prompt.runtimeReader", { mode: layout }),
    tr("diagnostics.prompt.runtimeNetwork", { network }),
    tr("diagnostics.prompt.runtimeOnline", { value: valueLabel(r.onlineEnabled) }),
    tr("diagnostics.prompt.runtimeSafeMode", { value: stateLabel(r.safeMode) }),
  ];
  return [
    heading(tr("diagnostics.prompt.runtimeTitle")),
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}

function breadcrumbSection(bundle: DiagnosticBundle): string {
  const title = heading(tr("diagnostics.prompt.breadcrumbsTitle"));
  if (bundle.breadcrumbs.length === 0) {
    return [title, "", tr("diagnostics.prompt.breadcrumbsNone")].join("\n");
  }
  return [
    title,
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
  const title = heading(tr("diagnostics.prompt.errorsTitle"));
  if (bundle.errors.length === 0) {
    return [title, "", tr("diagnostics.prompt.errorsNone")].join("\n");
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
    const itemTitle = `### ${tr("diagnostics.prompt.errorItem", { index: index + 1 })}`;
    return `${itemTitle}\n\n${codeBlock(body, "text")}`;
  });
  return [title, "", ...items].join("\n\n");
}

function logSection(bundle: DiagnosticBundle): string {
  const title = heading(tr("diagnostics.prompt.logsTitle"));
  if (bundle.logs.length === 0) {
    return [title, "", tr("diagnostics.prompt.logsNone")].join("\n");
  }
  const body = bundle.logs
    .map((entry) => `[${entry.at}] [${entry.scope}] ${entry.message}`)
    .join("\n");
  return `${title}\n\n${codeBlock(body, "text")}`;
}

/**
 * Deterministic prompt for a coding agent. All bundle values already passed the
 * Rust sanitizer; the user has previewed this text before copying/exporting.
 * Text follows the active UI locale through `translate`.
 */
export function buildDiagnosticPrompt(
  bundle: DiagnosticBundle,
  description: string,
): string {
  const note =
    description.trim() || tr("diagnostics.prompt.noDescription");
  return [
    `# ${tr("diagnostics.prompt.title")}`,
    "",
    tr("diagnostics.prompt.generatedAt", { time: bundle.generatedAt }),
    "",
    `> ${tr("diagnostics.prompt.localNote")}`,
    "",
    heading(tr("diagnostics.prompt.descriptionTitle")),
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
    heading(tr("diagnostics.prompt.requestedTitle")),
    "",
    tr("diagnostics.prompt.requestedRole"),
    "",
    `1. ${tr("diagnostics.prompt.rootCause")}`,
    `2. ${tr("diagnostics.prompt.codeLocations")}`,
    `3. ${tr("diagnostics.prompt.fix")}`,
    "",
    tr("diagnostics.prompt.format"),
    "",
  ].join("\n");
}
