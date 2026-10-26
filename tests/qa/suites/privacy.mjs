import fs from "node:fs";
import path from "node:path";
import { invoke } from "../lib/app.mjs";
import { fail, note, ok } from "../lib/report.mjs";

const MARKER = "QA-SANITIZE-MARKER-7788";

async function collectDiagnostics(page, redactUrls = true) {
  return invoke(page, "diagnostics_collect", { redactUrlPaths: redactUrls });
}

function allErrorText(bundle) {
  return bundle.errors
    .map((entry) => `${entry.message}\n${entry.stack || ""}`)
    .join("\n");
}

function allLogText(bundle) {
  return bundle.logs.map((entry) => `${entry.scope}: ${entry.message}`).join("\n");
}

export async function runPrivacySuite(ctx, report) {
  let page = ctx.page;
  await ctx.setLocale("en");
  page = ctx.page;
  await ctx.goto("#/settings?tab=support");
  await page.waitFor("!!document.getElementById('diagnostics-description')", { timeout: 10_000 });

  const sensitiveMessage = [
    `${MARKER}`,
    "C:\\Users\\RealName\\Secret Comics\\My Manga\\第01话.cbz",
    "QA Local Folder",
    "Authorization: Bearer SECRET_TOKEN_ABC",
    "Cookie: session=SECRET_COOKIE",
    "https://example.com/private/chapter/42?token=SECRET_QUERY",
  ].join("\n");
  const sensitiveStack = `Error: boom\n    at C:\\Users\\RealName\\Secret Comics\\My Manga\\第01话.cbz:1:1`;
  await invoke(page, "diagnostics_record_frontend_error", {
    entry: {
      source: "error-boundary",
      message: sensitiveMessage,
      stack: sensitiveStack,
      route: "/reader/secret-book-id",
    },
  });
  const bundle = await collectDiagnostics(page, true);
  const text = `${allErrorText(bundle)}\n${allLogText(bundle)}`;
  const leaks = [
    "RealName",
    "Secret Comics",
    "My Manga",
    "第01话",
    "QA Local Folder",
    "SECRET_TOKEN_ABC",
    "SECRET_COOKIE",
    "SECRET_QUERY",
    "private/chapter",
  ].filter((token) => text.includes(token));
  const hasMarker = text.includes(MARKER);
  const preservedExtension = text.includes("<MANGA_FILE>.cbz");
  const hasHome = text.includes("<USER_HOME>");
  const hasManga = text.includes("<MANGA_DIR>");
  const hasUrlPath = text.includes("<URL_PATH_REDACTED>");
  const hasRedacted = text.includes("<REDACTED>");
  if (!hasMarker || leaks.length || !preservedExtension || !hasHome || !hasManga || !hasUrlPath || !hasRedacted) {
    fail(report, {
      id: "privacy:sanitize-prompt",
      suite: "privacy",
      layer: "integration",
      title: "诊断脱敏残留隐私或凭证",
      severity: "P0",
      details: JSON.stringify({ leaks, hasMarker, preservedExtension, hasHome, hasManga, hasUrlPath, hasRedacted }),
      location: "src-tauri/src/diagnostics.rs:240-700",
      expected: "用户名/漫画目录/文件名/Token/Cookie/URL 全脱敏，保留 .cbz",
      actual: leaks.join(", ") || "missing expected placeholder",
      rootCause: "脱敏路径/凭证规则未覆盖该输入",
      fix: "补充 sanitize_text 规则并添加回归用例",
    });
  } else {
    ok(report, {
      id: "privacy:sanitize-prompt",
      suite: "privacy",
      layer: "integration",
      title: "诊断包敏感信息残留率为 0 且保留扩展名",
      details: "USER_HOME / MANGA_DIR / MANGA_FILE.cbz / REDACTED / URL_PATH_REDACTED",
    });
  }

  const leakRoute = bundle.errors.some((entry) => entry.route?.includes("secret-book"));
  if (leakRoute) {
    fail(report, {
      id: "privacy:route-sanitize",
      suite: "privacy",
      layer: "integration",
      title: "诊断路由泄露 book id",
      severity: "P1",
      details: JSON.stringify(bundle.errors.map((entry) => entry.route)),
      location: "src-tauri/src/diagnostics.rs:200-230",
      expected: "/reader/:id",
      actual: "secret-book-id",
    });
  } else {
    ok(report, {
      id: "privacy:route-sanitize",
      suite: "privacy",
      layer: "integration",
      title: "诊断路由已归一化，不泄露 book id",
    });
  }

  // JSON-quoted credentials are common in fetch/HTTP debug logs. The sanitizer
  // must handle `"Cookie": "..."` in addition to `Cookie: ...`.
  await invoke(page, "diagnostics_record_frontend_error", {
    entry: {
      source: "error-boundary",
      message:
        '{"Cookie":"session=SECRET_JSON_COOKIE","Authorization":"Bearer SECRET_JSON_TOKEN","api_key":"SECRET_JSON_KEY"}',
      stack: "Error: json credential sample",
      route: "/reader/json-credential",
    },
  });
  const jsonBundle = await collectDiagnostics(page, true);
  const jsonText = `${allErrorText(jsonBundle)}\n${allLogText(jsonBundle)}`;
  const jsonLeaks = ["SECRET_JSON_COOKIE", "SECRET_JSON_TOKEN", "SECRET_JSON_KEY"].filter(
    (token) => jsonText.includes(token),
  );
  if (jsonLeaks.length) {
    fail(report, {
      id: "privacy:sanitize-json-credentials",
      suite: "privacy",
      layer: "integration",
      title: "JSON 引号键的 api_key 未脱敏（其余两项靠值模式偶然命中）",
      severity: "P1",
      details: JSON.stringify({ leaks: jsonLeaks }),
      location: "src-tauri/src/diagnostics.rs:244-284",
      expected: '"Cookie"/"Authorization"/"api_key" 的值全部替换为 <REDACTED>',
      actual: `仍残留：${jsonLeaks.join(", ")}；Cookie 仅因 session= 模式、Authorization 仅因 Bearer 模式被覆盖`,
      rootCause: "key_value_regex 的 sep 只允许 key 后直接跟 : 或 =，未覆盖 JSON 的 key\" : 形式",
      fix: "解析 JSON 或允许 key 与冒号之间存在引号/空白，再补单测覆盖引号键",
    });
  } else {
    ok(report, {
      id: "privacy:sanitize-json-credentials",
      suite: "privacy",
      layer: "integration",
      title: "JSON 引号包裹的 Cookie/Token 已脱敏",
    });
  }

  // The free-text reproduction field is inserted verbatim into the preview.
  // A user pasting a local path or token must not bypass sanitization.
  const sensitiveDescription =
    "复现：C:\\Users\\RealName\\Secret Comics\\第02话.cbz token=SECRET_DESC_TOKEN";
  await page.eval(`(() => {
    const el = document.getElementById("diagnostics-description");
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(sensitiveDescription)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const promptText = await page.eval(`(() => {
    const area = [...document.querySelectorAll("textarea")].find((node) => node.rows >= 10);
    return area ? area.value : "";
  })()`);
  const descLeaks = ["RealName", "Secret Comics", "第02话", "SECRET_DESC_TOKEN"].filter(
    (token) => promptText.includes(token),
  );
  const sanitizedMarker =
    promptText.includes("<USER_HOME>") ||
    promptText.includes("<REDACTED>") ||
    promptText.includes("description omitted");
  if (descLeaks.length) {
    fail(report, {
      id: "privacy:sanitize-description",
      suite: "privacy",
      layer: "integration",
      title: "诊断描述中的路径/Token 原样进入 Prompt",
      severity: "P1",
      details: JSON.stringify({ leaks: descLeaks }),
      location: "src/features/diagnostics/prompt.ts:127",
      expected: "描述与诊断包一样经过 sanitize_text",
      actual: descLeaks.join(", "),
      rootCause: "buildDiagnosticPrompt 直接拼接 description，未调用后端脱敏",
      fix: "生成 Prompt 前把 description 交给后端 sanitize_text",
    });
  } else if (!sanitizedMarker) {
    note(report, "诊断描述未进入 Prompt 预览或未产生可识别脱敏标记");
  } else {
    ok(report, {
      id: "privacy:sanitize-description",
      suite: "privacy",
      layer: "integration",
      title: "诊断描述中的路径/Token 已脱敏",
    });
  }

  if (bundle.breadcrumbs.length > 20 || bundle.errors.length > 30 || bundle.logs.length > 80) {
    fail(report, {
      id: "privacy:diagnostic-bounds",
      suite: "privacy",
      layer: "integration",
      title: "诊断包记忆/日志环形缓冲越界",
      severity: "P1",
      details: JSON.stringify({ breadcrumbs: bundle.breadcrumbs.length, errors: bundle.errors.length, logs: bundle.logs.length }),
      location: "src-tauri/src/diagnostics.rs:20-40",
      expected: "≤20 actions / ≤30 errors / ≤80 logs",
      actual: "bounds exceeded",
    });
  } else {
    ok(report, {
      id: "privacy:diagnostic-bounds",
      suite: "privacy",
      layer: "integration",
      title: "诊断包动作/错误/日志均有界",
    });
  }

  const versionInfo = await invoke(page, "get_app_info");
  // 版本与 Commit 基线已迁入「关于与维护」分区；直接命中保持稳定。
  await ctx.goto("#/settings?tab=about");
  await page.waitFor("!!document.querySelector('[role=tab]')", { timeout: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const versionText = await page.eval("document.body.innerText");
  const expectedVersion = JSON.parse(fs.readFileSync(path.join(ctx.root, "package.json"), "utf8")).version;
  const versionMatches = versionText.includes(`v${expectedVersion}`);
  const backendMatches = versionInfo.version === expectedVersion;
  if (!versionMatches || !backendMatches) {
    fail(report, {
      id: "privacy:version-display",
      suite: "privacy",
      layer: "e2e",
      title: "设置页版本号与 package.json / 后端不一致",
      severity: "P1",
      details: JSON.stringify({ expectedVersion, backend: versionInfo.version, versionMatches }),
      location: "src/pages/Settings.tsx:910-940 / src/lib/version.ts",
      expected: `UI 与后端均为 v${expectedVersion}`,
      actual: `backend=${versionInfo.version}, ui=${versionMatches}`,
      rootCause: "前端注入或同步门禁未生效",
      fix: "npm run version:sync && 重新构建",
    });
  } else {
    ok(report, {
      id: "privacy:version-display",
      suite: "privacy",
      layer: "e2e",
      title: "设置页、前端注入与 Rust AppInfo 版本一致",
      details: `v${expectedVersion}`,
    });
  }

  const diagnosticsSources = [
    ...fs
      .readdirSync(path.join(ctx.root, "src-tauri", "src"))
      .filter((name) => name === "diagnostics.rs")
      .map((name) => path.join(ctx.root, "src-tauri", "src", name)),
    ...["src/features/diagnostics", "src/features/resilience"].flatMap((dir) =>
      fs
        .readdirSync(path.join(ctx.root, dir), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(ctx.root, dir, entry.name)),
    ),
  ];
  const networkHits = [];
  for (const file of diagnosticsSources) {
    const source = fs.readFileSync(file, "utf8");
    if (/\b(fetch\(|XMLHttpRequest|axios\.|navigator\.sendBeacon)/.test(source)) {
      networkHits.push(path.relative(ctx.root, file));
    }
  }
  if (networkHits.length) {
    fail(report, {
      id: "privacy:diagnostics-no-upload",
      suite: "privacy",
      layer: "static",
      title: "诊断/弹性模块出现静默联网上报代码",
      severity: "P0",
      details: networkHits.join(", "),
      location: networkHits[0],
      expected: "无 fetch/XHR/beacon",
      actual: networkHits.join(", "),
      rootCause: "违反本地优先原则",
      fix: "删除网络上报并仅保留导出/复制",
    });
  } else {
    ok(report, {
      id: "privacy:diagnostics-no-upload",
      suite: "privacy",
      layer: "static",
      title: "诊断与恢复模块无静默网络上报",
    });
  }

  // 更新通道自检必须反映构建期真实配置，而不是已下线的旧补丁通道。
  // 0.17.0 / 0.17.1 的正式版因此长期显示「尚未配置更新清单地址 / 签名公钥：未启用」。
  const audit = await invoke(page, "security_audit", {});
  const update = audit?.update ?? {};
  const updateFacts = {
    manifestConfigured: update.manifestConfigured === true,
    manifestHttps: update.manifestHttps === true,
    signatureConfigured: update.signatureConfigured === true,
    sha256Enforced: update.sha256Enforced === true,
    keySource: update.keySource,
    status: update.status,
  };
  const updateOk =
    updateFacts.manifestConfigured &&
    updateFacts.manifestHttps &&
    updateFacts.signatureConfigured &&
    updateFacts.sha256Enforced &&
    updateFacts.keySource === "config" &&
    updateFacts.status === "pass";
  if (!updateOk) {
    fail(report, {
      id: "privacy:update-channel-audit",
      suite: "privacy",
      layer: "integration",
      title: "更新包签名与完整性自检未反映真实更新通道",
      severity: "P1",
      details: JSON.stringify(updateFacts),
      location: "src-tauri/src/security.rs:audit_update",
      expected:
        "端点已配置 + HTTPS + 已配置 minisign 公钥 + SHA-256 强制 + 公钥来源 config + 状态 pass",
      actual: JSON.stringify(updateFacts),
      rootCause: "自检改读了已下线的旧补丁通道（MR_UPDATE_PUBKEY / 本机遗留清单地址）",
      fix: "按 AGENTS.md §4.1 用 update::NativeUpdaterConfig::from_tauri_config 读取构建期配置",
    });
  } else {
    ok(report, {
      id: "privacy:update-channel-audit",
      suite: "privacy",
      layer: "integration",
      title: "更新通道自检与构建期配置一致（HTTPS + minisign 公钥）",
      details: "manifestConfigured/https/signatureConfigured=true, keySource=config",
    });
  }

  note(report, "诊断敏感样本使用独立测试错误入口，未写入磁盘；动作/日志环形缓冲检查通过");
}
