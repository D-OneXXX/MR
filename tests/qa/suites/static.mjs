import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fail, note, ok } from "../lib/report.mjs";

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * 只提取 `steps:` 下的步骤文本（含 `run: |` 块），不把注释/on/job 级字段
 * 当成步骤内容。用于发布门禁的“步骤真实存在”断言。
 */
function yamlStepTexts(source) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*steps:\s*$/.test(line));
  if (start < 0) return null;
  let stepIndent = null;
  const steps = [];
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const item = line.match(/^(\s*)-\s+(.*)$/);
    if (item) {
      const indent = item[1].length;
      if (stepIndent === null) stepIndent = indent;
      if (indent === stepIndent) {
        if (current) steps.push(current.join("\n"));
        current = [item[2]];
        continue;
      }
    }
    if (!current) continue;
    const nonEmpty = line.match(/^(\s*)\S/);
    if (
      nonEmpty &&
      nonEmpty[1].length < stepIndent &&
      !line.trim().startsWith("#")
    ) {
      steps.push(current.join("\n"));
      break;
    }
    current.push(line);
  }
  if (current) steps.push(current.join("\n"));
  return steps;
}

/**
 * Remove Rust line/block comments while keeping string literals and newlines.
 * Comments may legitimately document "无 sidecar"; only executable code should
 * trip the sidecar guard.
 */
function stripRustComments(source) {
  let out = "";
  let index = 0;
  let blockDepth = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "*" && next === "/") {
        blockDepth -= 1;
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      blockDepth = 1;
      out += "  ";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const SIDECAR_PATTERNS = [
  {
    name: "Python 自启 Command",
    regex: /\bCommand\s*::\s*new\s*\(\s*"(?:python(?:3(?:\.\d+)?)?(?:\.exe)?|py)"\s*\)/i,
  },
  {
    name: "硬编码 8500 端口",
    regex: /\b8500\b/,
  },
  {
    name: "sidecar 进程启动",
    regex:
      /(?:\bCommand\s*::\s*new(?:_sidecar)?\s*\(\s*"[^"]*sidecar[^"]*"|\.sidecar\s*\(|\bsidecar\b[\s\S]{0,160}?\.(?:spawn|output|status)\s*\()/i,
  },
];

function scanSidecarSources(root) {
  const sourceRoot = path.join(root, "src-tauri", "src");
  if (!fs.existsSync(sourceRoot)) return [];
  const hits = [];
  for (const file of walk(sourceRoot)) {
    if (!file.endsWith(".rs")) continue;
    if (file.split(path.sep).includes("target")) continue;
    const code = stripRustComments(fs.readFileSync(file, "utf8"));
    for (const pattern of SIDECAR_PATTERNS) {
      const global = new RegExp(
        pattern.regex.source,
        pattern.regex.flags.includes("g")
          ? pattern.regex.flags
          : `${pattern.regex.flags}g`,
      );
      for (const match of code.matchAll(global)) {
        const line = code.slice(0, match.index).split("\n").length;
        hits.push({
          file: path.relative(root, file),
          line,
          name: pattern.name,
          snippet: match[0].replace(/\s+/g, " ").slice(0, 80),
        });
      }
    }
  }
  return hits;
}

function loadTsObject(source, exportName) {
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const exports = {};
  new Function("exports", "module", js)(exports, { exports });
  return exports[exportName];
}

function collectDictionary(root) {
  const dir = path.join(root, "src", "i18n", "messages");
  const merged = { "zh-CN": {}, "zh-TW": {}, en: {}, es: {}, ja: {}, ko: {} };
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    const match = source.match(/export const (\w+Messages)\s*=\s*\{/);
    if (!match) continue;
    const table = loadTsObject(source, match[1]);
    for (const locale of Object.keys(merged)) {
      Object.assign(merged[locale], table[locale]);
    }
  }
  return merged;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{[A-Za-z0-9_]+\}/g)]
    .map((match) => match[0])
    .sort()
    .join(",");
}

function sourceKeyUsages(root) {
  const files = walk(path.join(root, "src")).filter(
    (file) =>
      /\.(tsx?|jsx?)$/.test(file) &&
      !file.includes(`${path.sep}i18n${path.sep}`),
  );
  const keys = new Map();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const lines = source.split(/\r?\n/);
    const pattern = /\b(?:t|translate)\(\s*"([^"]+)"/g;
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(pattern)) {
        const key = match[1];
        if (!keys.has(key)) keys.set(key, `${path.relative(root, file)}:${index + 1}`);
      }
    }
  }
  return keys;
}

function versionCheck(root) {
  return execFileSync(process.execPath, ["scripts/version-check.mjs", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
}

export async function runStaticSuite(ctx, report) {
  const { root } = ctx;

  try {
    const output = versionCheck(root);
    const parsed = JSON.parse(output);
    if (!parsed.ok) {
      fail(report, {
        id: "static:version-sync",
        suite: "static",
        layer: "unit",
        title: "三端版本号与前端注入应完全一致",
        severity: "P1",
        details: parsed.errors.map((error) => `${error.file}:${error.line}`).join(", "),
        expected: "package.json / tauri.conf.json / Cargo.toml / Cargo.lock / package-lock 一致",
        actual: "存在不一致",
        location: parsed.errors[0]
          ? `${parsed.errors[0].file}:${parsed.errors[0].line}`
          : "scripts/version-check.mjs:1",
        rootCause: "版本号被手工修改或构建未运行 version:check",
        fix: "npm run version:sync",
      });
    } else {
      ok(report, {
        id: "static:version-sync",
        suite: "static",
        layer: "unit",
        title: "三端版本号与前端注入完全一致",
        details: `v${parsed.expected}`,
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:version-sync",
      suite: "static",
      layer: "unit",
      title: "版本同步门禁无法执行",
      severity: "P0",
      details: error.message,
      location: "scripts/version-check.mjs",
      rootCause: "门禁脚本自身异常",
      fix: "修复脚本并重新运行",
    });
  }

  try {
    execFileSync(process.execPath, ["--test", "scripts/version.test.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    ok(report, {
      id: "static:version-mismatch-line",
      suite: "static",
      layer: "unit",
      title: "故意改错版本时能指出文件与行号",
      details: "fixture 中 tauri.conf.json 第 3 行不一致被捕获",
    });
  } catch (error) {
    fail(report, {
      id: "static:version-mismatch-line",
      suite: "static",
      layer: "unit",
      title: "版本不一致行号定位失败",
      severity: "P0",
      details: error.stdout || error.message,
      location: "scripts/version.test.mjs",
    });
  }

  // 滚动区高度契约：视口必须继承根节点 max-height，根节点负责裁剪。
  // 缺任一条，父级只有 max-height 时视口高度会退化为 auto，长列表就会
  // 冲出卡片压到相邻区块（回归：在线源规则列表）。
  const scrollAreaPath = path.join(root, "src", "components", "ui", "scroll-area.tsx");
  if (fs.existsSync(scrollAreaPath)) {
    const scrollAreaSource = fs.readFileSync(scrollAreaPath, "utf8");
    const missing = [];
    if (!scrollAreaSource.includes("max-h-[inherit]")) {
      missing.push("viewport 缺少 max-h-[inherit]");
    }
    if (!scrollAreaSource.includes("overflow-hidden")) {
      missing.push("root 缺少 overflow-hidden");
    }
    if (missing.length) {
      fail(report, {
        id: "static:scroll-area-bounds",
        suite: "static",
        layer: "ui",
        title: "滚动区缺少高度上限契约",
        severity: "P1",
        details: missing.join("; "),
        location: "src/components/ui/scroll-area.tsx",
        rootCause: "视口 height:100% 在 max-height 父级下退化为 auto，内容会溢出容器",
        fix: "视口继承 max-h-[inherit]，根节点补 overflow-hidden",
      });
    } else {
      ok(report, {
        id: "static:scroll-area-bounds",
        suite: "static",
        layer: "ui",
        title: "滚动区高度上限契约完整",
      });
    }
  }

  let dictionary = {};
  try {
    dictionary = collectDictionary(root);
    const locales = Object.keys(dictionary);
    const base = dictionary["zh-CN"];
    const errors = [];
    for (const locale of locales) {
      const table = dictionary[locale] || {};
      for (const key of Object.keys(base)) {
        if (!(key in table)) errors.push(`${locale} missing ${key}`);
        else if (placeholders(table[key]) !== placeholders(base[key])) {
          errors.push(`${locale} placeholder mismatch ${key}`);
        } else if (!String(table[key]).trim()) errors.push(`${locale} empty ${key}`);
      }
      for (const key of Object.keys(table)) {
        if (!(key in base)) errors.push(`${locale} extra ${key}`);
      }
    }
    const usages = sourceKeyUsages(root);
    for (const [key, location] of usages) {
      if (!(key in base)) errors.push(`used key missing: ${key} @ ${location}`);
    }
    recordDictionaryResult(report, errors, Object.keys(base).length, locales.length);
  } catch (error) {
    fail(report, {
      id: "static:i18n-parity",
      suite: "static",
      layer: "unit",
      title: "六语种字典完整性与占位符一致",
      severity: "P1",
      details: error.message,
      location: "src/i18n/messages",
      rootCause: "字典模块无法解析或结构错误",
      fix: "修复字典并补齐键",
    });
  }

  try {
    const appSource = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
    const shellSource = fs.readFileSync(
      path.join(root, "src", "components", "shell", "AppShell.tsx"),
      "utf8",
    );
    const routes = [
      ...appSource.matchAll(/<Route\s+path="([^"]+)"/g),
      ...shellSource.matchAll(/<Route\s+path="([^"]+)"/g),
    ].map((match) => match[1]);
    const allowed = new Set(["/reader/:id", "/", "/browser", "/settings", "*"]);
    const ghost = routes.filter((route) => !allowed.has(route));
    if (ghost.length) {
      fail(report, {
        id: "static:removed-routes",
        suite: "static",
        layer: "static",
        title: "已移除模块不得残留前端路由",
        severity: "P1",
        details: ghost.join(", "),
        location: "src/App.tsx / src/components/shell/AppShell.tsx",
        expected: "仅保留书库、阅读器、浏览器、设置",
        actual: `发现 ${ghost.join(", ")}`,
      });
    } else {
      ok(report, {
        id: "static:removed-routes",
        suite: "static",
        layer: "static",
        title: "已移除模块无残留前端路由",
      });
    }
  } catch (error) {
    fail(report, {
      id: "static:removed-routes",
      suite: "static",
      layer: "static",
      title: "路由表静态检查失败",
      severity: "P2",
      details: error.message,
      location: "src/App.tsx",
    });
  }

  const removedPatterns = [
    "翻译工作台",
    "批量预翻译",
    "术语表",
    "选区翻译",
    "页 OCR 存档",
    "OCR 存档",
    "服务状态",
    "translation workbench",
    "batch translate",
    "glossary",
    "sidecar status",
  ];
  const runtimeRoots = [
    path.join(root, "src", "pages"),
    path.join(root, "src", "components"),
    path.join(root, "src", "features"),
    path.join(root, "src", "App.tsx"),
  ];
  const runtimeFiles = [];
  for (const target of runtimeRoots) {
    if (!fs.existsSync(target)) continue;
    if (fs.statSync(target).isDirectory()) runtimeFiles.push(...walk(target));
    else runtimeFiles.push(target);
  }
  const ghostHits = [];
  for (const file of runtimeFiles) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of removedPatterns) {
      if (source.toLowerCase().includes(pattern.toLowerCase())) {
        ghostHits.push(`${path.relative(root, file)} :: ${pattern}`);
      }
    }
  }
  if (ghostHits.length) {
    fail(report, {
      id: "static:removed-ui-text",
      suite: "static",
      layer: "static",
      title: "已砍掉模块不得残留前端可见入口/幽灵引用",
      severity: "P1",
      details: ghostHits.join(" | "),
      location: ghostHits[0].split(" :: ")[0],
      expected: "翻译工作台、术语表、OCR/批量翻译、独立服务状态页 100% 无入口",
      actual: ghostHits.join(", "),
      rootCause: "功能减法不彻底",
      fix: "删除残留 UI 文案/入口",
    });
  } else {
    ok(report, {
      id: "static:removed-ui-text",
      suite: "static",
      layer: "static",
      title: "已砍掉模块无前端可见入口",
    });
  }

  let sidecarHits = [];
  try {
    sidecarHits = scanSidecarSources(root);
  } catch (error) {
    sidecarHits = [
      {
        file: "src-tauri/src",
        line: 0,
        name: "扫描失败",
        snippet: String(error),
      },
    ];
  }
  if (sidecarHits.length) {
    fail(report, {
      id: "static:no-python-sidecar",
      suite: "static",
      layer: "static",
      title: "后端残留 Python/sidecar 进程自启痕迹",
      severity: "P1",
      details: sidecarHits
        .map((hit) => `${hit.file}:${hit.line} [${hit.name}] ${hit.snippet}`)
        .join(" | "),
      location: `${sidecarHits[0].file}:${sidecarHits[0].line}`,
      expected: "src-tauri/src 无 Command::new(python/python3)、8500 端口硬编码与 sidecar 启动调用",
      actual: sidecarHits.map((hit) => `${hit.file}:${hit.line} ${hit.name}`).join(", "),
      rootCause: "本地推理服务 sidecar 被重新引入或启动代码未清理",
      fix: "删除 Python 自启/8500 端口/sidecar 进程启动代码；注释说明不受影响",
    });
  } else {
    ok(report, {
      id: "static:no-python-sidecar",
      suite: "static",
      layer: "static",
      title: "后端无 Python/sidecar 进程自启痕迹",
      details: "注释已剥离；仅扫描可执行代码",
    });
  }

  const sidecarModule = path.join(root, "src-tauri", "src", "sidecar.rs");
  if (fs.existsSync(sidecarModule)) {
    fail(report, {
      id: "static:no-sidecar-module",
      suite: "static",
      layer: "static",
      title: "sidecar 模块文件仍存在",
      severity: "P1",
      details: path.relative(root, sidecarModule),
      location: path.relative(root, sidecarModule),
      expected: "src-tauri/src/sidecar.rs 不存在",
      actual: "文件存在",
      rootCause: "sidecar 模块未彻底移除",
      fix: "删除 sidecar.rs 及其 mod 声明",
    });
  } else {
    ok(report, {
      id: "static:no-sidecar-module",
      suite: "static",
      layer: "static",
      title: "sidecar 模块文件已移除",
      details: "src-tauri/src/sidecar.rs 不存在",
    });
  }

  const legacyStyles = ["theme.css", "ui.css", "v3.css"];
  const legacyFiles = legacyStyles.filter((name) =>
    fs.existsSync(path.join(root, "src", name)),
  );
  const sourceFiles = walk(path.join(root, "src"));
  const legacyImports = [];
  for (const file of sourceFiles) {
    if (!/\.(tsx?|jsx?|css)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const name of legacyStyles) {
      if (text.includes(`./${name}`) || text.includes(`/${name}`)) {
        legacyImports.push(`${path.relative(root, file)} -> ${name}`);
      }
    }
  }
  if (legacyFiles.length || legacyImports.length) {
    fail(report, {
      id: "static:legacy-styles",
      suite: "static",
      layer: "static",
      title: "旧版样式文件与引用必须净空",
      severity: "P2",
      details: [...legacyFiles, ...legacyImports].join(", "),
      location: legacyImports[0] || "src/index.css",
    });
  } else {
    ok(report, {
      id: "static:legacy-styles",
      suite: "static",
      layer: "static",
      title: "无 theme.css/ui.css/v3.css 残留",
    });
  }

  if (dictionary["zh-CN"]) {
    note(report, `字典共 ${Object.keys(dictionary["zh-CN"]).length} 个键 × 6 语种`);
  }

  checkCapabilityWall(root, report);
  checkStorageWhitelist(root, report);
  checkUpdateChannelSource(root, report);
  checkWebtoonTextureGuard(root, report);
  checkProductionBundle(root, report);
  checkNoUnusedCustomProtocol(root, report);
  checkCsp(root, report);
  checkPostI18nHardcodedText(root, report);
  checkReleaseSurface(root, report);
  checkAntiMockGuards(root, report);
  checkActionsPinned(root, report);
  checkReleaseGovernance(root, report);
}

/* ------------------------------------------------------------------ */
/* §3.4 发布治理静态守卫（Phase 4）                                     */
/* ------------------------------------------------------------------ */

/**
 * 发布链路必须满足的硬约束（静态可验证部分）：
 *
 * 1. **没有任何 workflow 由 Tag 推送触发**——`push: tags:` 一旦出现，
 *    推送 `v*` 就会直接进入发版流水线（Phase 0 审计出的最高风险）。
 * 2. 发布相关 workflow 只能由 `workflow_dispatch` 手动触发。
 * 3. 发布（publish）workflow 必须声明 `environment:`（人工审批门禁）。
 * 4. 发布 workflow **不得**持有签名私钥（产物已在候选阶段签好名）。
 * 5. 不得存在 `skip_full_qa` / `releaseDraft: false` 之类的绕过开关。
 * 6. 发布 workflow 必须显式声明最小权限（工作流级 `contents: read`，
 *    需要写权限的 job 单独提升），不得使用 `permissions: write-all`。
 */
export function checkReleaseGovernance(root, report) {
  const dir = path.join(root, ".github", "workflows");
  const errors = [];
  const evidence = [];
  const publishFiles = ["release-publish.yml", "release-publish-linux.yml"];
  const candidateFiles = ["release-candidate.yml", "release-candidate-linux.yml"];

  if (!fs.existsSync(dir)) {
    fail(report, {
      id: "static:release-governance",
      suite: "static",
      layer: "static",
      title: "发布治理静态契约缺失",
      severity: "P1",
      details: ".github/workflows 目录不存在",
      location: ".github/workflows",
    });
    return;
  }

  const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    // 1) 禁止 Tag 触发。
    if (/push:\s*\n\s*tags:/m.test(source)) {
      errors.push(`${name} 仍由 Tag 推送触发（必须改为 workflow_dispatch 手动触发）`);
    }
    if (/^\s*-\s*"?v\*/m.test(source) && /tags:/m.test(source)) {
      errors.push(`${name} 仍声明了 v* Tag 触发器`);
    }
    // 6) 权限收敛。
    if (/permissions:\s*write-all/.test(source)) {
      errors.push(`${name} 使用了 permissions: write-all`);
    }
    // 5) 绕过开关。
    for (const bypass of ["skip_full_qa", "releaseDraft: false", "skip_approval"]) {
      if (source.includes(bypass)) {
        errors.push(`${name} 含绕过开关 ${bypass}`);
      }
    }
  }

  // 2) 发布相关 workflow 必须手动触发。
  for (const name of [...publishFiles, ...candidateFiles]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      errors.push(`缺少发布工作流 ${name}`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("workflow_dispatch")) {
      errors.push(`${name} 必须由 workflow_dispatch 手动触发`);
    }
    if (!/permissions:\s*\n\s*contents:\s*read/.test(source)) {
      errors.push(`${name} 必须显式声明工作流级 permissions: contents: read`);
    }
  }

  // 3) 发布工作流必须有人工审批门禁；4) 不得持有签名私钥。
  for (const name of publishFiles) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (!/environment:\s*release-(windows|linux)/.test(source)) {
      errors.push(`${name} 必须声明 environment: release-*（人工审批门禁）`);
    }
    if (source.includes("TAURI_SIGNING_PRIVATE_KEY")) {
      errors.push(`${name} 不得引用签名私钥（产物已在候选阶段签名）`);
    }
    if (!source.includes("verify-draft.mjs")) {
      errors.push(`${name} 必须调用发布前绑定校验 verify-draft.mjs`);
    }
    // 强制验收：签名验证 + 真实安装/升级验证必须进发布链路，且无开关可绕。
    if (!source.includes("verify-evidence.mjs")) {
      errors.push(`${name} 必须调用发布证据总闸 verify-evidence.mjs`);
    }
    if (!source.includes("verify-signature.mjs")) {
      errors.push(`${name} 必须执行签名验证 verify-signature.mjs`);
    }
    if (!source.includes("install-verification.json")) {
      errors.push(`${name} 必须要求安装/升级验证证据 install-verification.json`);
    }
    // 发布门禁必须用 main 上的**当前**治理脚本执行：标签提交里的旧副本会让
    // 「候选创建后修过门禁脚本」的情形必然发布失败，只剩绕过门禁一条路。
    if (!source.includes("git checkout FETCH_HEAD -- scripts/")) {
      errors.push(
        `${name} 必须用 main 上的当前门禁脚本执行发布校验（git checkout FETCH_HEAD -- scripts/）`,
      );
    }
    for (const bypass of ["skip_evidence", "skip_signature", "skip_install", "SKIP_EVIDENCE"]) {
      if (source.includes(bypass)) {
        errors.push(`${name} 含证据绕过开关 ${bypass}`);
      }
    }
    if (!source.includes("rehearsal")) {
      errors.push(`${name} 必须显式拒绝演练标签（rehearsal）`);
    }
    evidence.push(`${name}: 手动触发 + environment 门禁 + 绑定校验`);
  }

  // 候选工作流必须持有签名私钥并产出 Draft。
  for (const name of candidateFiles) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("TAURI_SIGNING_PRIVATE_KEY")) {
      errors.push(`${name} 必须使用签名私钥构建候选制品`);
    }
    if (!source.includes("releaseDraft: true") && !source.includes("--draft")) {
      errors.push(`${name} 必须只创建 Draft（releaseDraft: true / --draft），不得直接公开`);
    }
    if (source.includes("releaseDraft: false")) {
      errors.push(`${name} 不得直接公开发布（releaseDraft: false）`);
    }
    if (!source.includes("rc-record.json")) {
      errors.push(`${name} 必须产出 rc-record.json（审批依据）`);
    }
    // 隔离演练模式：只允许 v0.0.0-rehearsal，产物带前缀且永不发布。
    // 目前只在 Windows 候选工作流提供（NSIS 安装验证是正式发布的强制条件）。
    if (name === "release-candidate.yml" && !source.includes("rehearsal")) {
      errors.push(`${name} 必须提供隔离演练模式（rehearsal），否则无法做非正式发布演练`);
    }
    evidence.push(`${name}: 构建签名 → Draft + rc-record`);
  }

  // 7) 安装/升级验证必须声明「干净环境」：共享宿主上的回执不能满足发布强制条件。
  //    契约与产出脚本两侧都要有，缺任一侧门禁都会失效。
  const installScript = path.join(
    root,
    "scripts",
    "release-smoke",
    "windows-install-upgrade.ps1",
  );
  const evidenceModule = path.join(
    root,
    "scripts",
    "release-governance",
    "evidence.mjs",
  );
  const rcModule = path.join(root, "scripts", "release-governance", "rc-record.mjs");
  for (const [label, file, needle] of [
    ["安装验证脚本", installScript, "cleanEnvironment"],
    ["证据契约 evidence.mjs", evidenceModule, "cleanEnvironment"],
    ["回执契约 rc-record.mjs", rcModule, "cleanEnvironment"],
  ]) {
    if (!fs.existsSync(file)) {
      errors.push(`缺少${label}：${path.relative(root, file)}`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes(needle)) {
      errors.push(
        `${label} 必须要求安装证据声明干净环境（cleanEnvironment）：${path.relative(root, file)}`,
      );
    }
  }

  // 8) 干净环境必须可核实：provenance / 合成书库+进度+IPC / 精确制品摘要，
  //    并且 hosted 验证工作流只做只读下载与验证。
  if (fs.existsSync(installScript)) {
    const source = fs.readFileSync(installScript, "utf8");
    for (const marker of [
      "ExpectedSha256",
      "expectedArtifactSha256",
      "previousArtifactSha256",
      "cleanEnvironment",
      "provenance",
      "imageVersion",
      "library",
      "list_books",
      "MergeFrom",
    ]) {
      if (!source.includes(marker)) {
        errors.push(`安装验证脚本缺少可核实证据标记 ${marker}`);
      }
    }
  }
  const installVerifyWorkflow = path.join(dir, "release-install-verify.yml");
  if (!fs.existsSync(installVerifyWorkflow)) {
    errors.push("缺少干净 VM 安装验证工作流 release-install-verify.yml");
  } else {
    const source = fs.readFileSync(installVerifyWorkflow, "utf8");
    for (const marker of [
      "workflow_dispatch",
      "runs-on: windows-2022",
      "CleanEnvironment",
      "prepare-candidate.mjs",
      "library-ui-check.mjs",
      "install-verification.json",
      "verify-evidence.mjs",
    ]) {
      if (!source.includes(marker)) {
        errors.push(`release-install-verify.yml 缺少 ${marker}`);
      }
    }
    if (/push:\s*\n\s*tags:/m.test(source)) {
      errors.push("release-install-verify.yml 不得由 Tag 推送触发");
    }
    const secretRefs = [...source.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
      (match) => match[1],
    );
    const disallowed = [...new Set(secretRefs.filter((name) => name !== "GITHUB_TOKEN"))];
    if (disallowed.length > 0) {
      errors.push(`release-install-verify.yml 不得引用非默认 Secret：${disallowed.join(", ")}`);
    }
    if (/gh release\s+(upload|edit|delete)|--draft=false/i.test(source)) {
      errors.push("release-install-verify.yml 不得写 Release（只允许只读下载与验证）");
    }
    evidence.push("release-install-verify.yml: workflow_dispatch + windows-2022 + 只读证据");
  }
  const windowsPublishPath = path.join(dir, "release-publish.yml");
  if (fs.existsSync(windowsPublishPath)) {
    const source = fs.readFileSync(windowsPublishPath, "utf8");
    if (!source.includes("verify-provenance.mjs")) {
      errors.push("release-publish.yml 必须在线核验安装证据 provenance");
    }
    if (!source.includes("Audit deployment approval boundary")) {
      errors.push("release-publish.yml 必须记录触发者与 deployment 审批人的边界审计");
    }
    if (!/actions:\s*read/.test(source)) {
      errors.push("release-publish.yml 必须声明 actions: read（读取 run 审批/运行来源）");
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:release-governance",
      suite: "static",
      layer: "static",
      title: "发布治理静态契约被破坏（Tag 触发 / 缺审批门禁 / 存在绕过开关）",
      severity: "P1",
      details: errors.join(" | "),
      location: ".github/workflows",
      expected:
        "无 Tag 触发的发布工作流；手动触发 + environment 审批门禁 + 发布前绑定校验；无跳过 QA/审批的开关",
      actual: errors.join(" | "),
      rootCause: "新增或修改发版工作流时引入了 Tag 触发、宽松权限或绕过开关",
      fix: "按内部发布治理文档（维护者本地维护）恢复：dispatch 触发 + environment + verify-draft 绑定校验",
    });
  } else {
    ok(report, {
      id: "static:release-governance",
      suite: "static",
      layer: "static",
      title: "发布治理静态契约成立（无 Tag 触发 / 有审批门禁 / 无绕过开关）",
      details: evidence.join("；"),
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3.3 GitHub Actions 供应链固定守卫                                  */
/* ------------------------------------------------------------------ */

/**
 * 所有 `uses:` 必须固定到 40 位 commit SHA（可带版本注释）。
 *
 * 理由：浮动 tag（`@v4` / `@stable`）可以在无人 review 的情况下改变被执行的
 * 代码；固定 SHA 后，升级必须走一次显式提交（同时保留版本注释可读性）。
 */
export function checkActionsPinned(root, report) {
  const dir = path.join(root, ".github", "workflows");
  const errors = [];
  const evidence = [];
  if (!fs.existsSync(dir)) {
    fail(report, {
      id: "static:actions-pinned",
      suite: "static",
      layer: "static",
      title: "GitHub Actions 未固定到 commit SHA",
      severity: "P1",
      details: ".github/workflows 目录不存在",
      location: ".github/workflows",
      expected: "所有 uses: 固定到 40 位 SHA",
      actual: "目录缺失",
    });
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  for (const name of files) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    let count = 0;
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/uses:\s*([^\s#]+)/);
      if (!match) continue;
      count += 1;
      const ref = match[1];
      const sha = ref.match(/@([0-9a-f]{40})$/);
      if (!sha) {
        errors.push(`${name}: ${ref} 未固定到 40 位 commit SHA`);
      }
    }
    if (count > 0) evidence.push(`${name}: ${count} 处 uses 已固定`);
  }
  if (errors.length) {
    fail(report, {
      id: "static:actions-pinned",
      suite: "static",
      layer: "static",
      title: "GitHub Actions 未固定到 commit SHA",
      severity: "P1",
      details: errors.join(" | "),
      location: ".github/workflows",
      expected: "所有 uses: 固定到 40 位 commit SHA（保留版本注释）",
      actual: errors.join(" | "),
      rootCause: "新增或升级 workflow 时使用了浮动 tag/分支引用",
      fix: "把 uses 改为 <action>@<40 位 SHA> # <版本>",
    });
  } else {
    ok(report, {
      id: "static:actions-pinned",
      suite: "static",
      layer: "static",
      title: "GitHub Actions 全部固定到 commit SHA",
      details: evidence.join("；"),
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3.2 更新通道唯一事实源守卫                                         */
/* ------------------------------------------------------------------ */

/**
 * 更新通道的端点与公钥只能来自构建期写进二进制的 `tauri.conf.json
 * plugins.updater`。设置页签名徽章（`get_app_info`）与隐私安全自检
 * （`security_audit`）必须读同一份配置。
 *
 * 0.17.0 / 0.17.1 的事故：自检卡读的是已下线的旧补丁通道（编译期 MR_UPDATE_PUBKEY +
 * 本机遗留清单地址），正式版必然显示「尚未配置更新清单地址 / 签名公钥：未启用」
 * 的假告警。本守卫把「唯一事实源」写成硬契约，防止回归。
 */
export function checkUpdateChannelSource(root, report) {
  const errors = [];
  const read = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      errors.push(`缺少 ${relative}`);
      return "";
    }
    return fs.readFileSync(file, "utf8");
  };

  const updateRs = read("src-tauri/src/update.rs");
  const securityRs = read("src-tauri/src/security.rs");
  const privacyApi = read("src/features/privacy/api.ts");
  const updateTypes = read("src/features/update/types.ts");
  const sanitizer = read("src/lib/storageSanitizer.ts");

  // 1) 提取器与唯一读取点必须存在。
  if (!updateRs.includes("NativeUpdaterConfig")) {
    errors.push("update.rs 缺少 NativeUpdaterConfig（更新通道配置提取器）");
  }
  if (!updateRs.includes("from_tauri_config")) {
    errors.push("update.rs 缺少 from_tauri_config（未从运行时 Tauri 配置读取更新通道）");
  }
  if (!securityRs.includes("from_tauri_config")) {
    errors.push(
      "security.rs 的自检未读取构建期更新通道配置（正式版会出现未配置/未签名假告警）",
    );
  }

  // 2) 自检不得回退到旧补丁通道的单一事实源。
  if (securityRs.includes("update_key_configured")) {
    errors.push("security.rs 仍在用旧补丁通道的 update_key_configured 判定签名");
  }
  if (securityRs.includes("manifest_url")) {
    errors.push("security.rs 仍在读本机遗留清单地址 manifest_url");
  }
  if (/manifestUrl\s*[:=]/.test(privacyApi)) {
    errors.push("privacy/api.ts 仍在向 security_audit 传本机更新源地址");
  }

  // 3) 已下线的遗留偏好不得复活。
  if (updateTypes.includes("mr-update-prefs") || updateTypes.includes("manifestUrl")) {
    errors.push("features/update/types.ts 仍在读写旧补丁通道的本机偏好");
  }
  if (!/DEPRECATED_KEY_PREFIXES[\s\S]*?"mr-update-prefs"/.test(sanitizer)) {
    errors.push("storageSanitizer.ts 未把 mr-update-prefs 登记为废弃键");
  }

  if (errors.length) {
    fail(report, {
      id: "static:update-channel-source",
      suite: "static",
      layer: "static",
      title: "更新通道未收敛到构建期唯一事实源",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/src/security.rs / src/features/privacy/api.ts",
      expected:
        "端点与公钥只来自 tauri.conf.json plugins.updater；自检与徽章共用 NativeUpdaterConfig",
      actual: errors.join(" | "),
      rootCause: "自检改读了已下线的旧补丁通道，正式版出现「未配置 / 未签名」假告警",
      fix: "按 AGENTS.md §4.1 用 update::NativeUpdaterConfig::from_tauri_config 统一读取",
    });
  } else {
    ok(report, {
      id: "static:update-channel-source",
      suite: "static",
      layer: "static",
      title: "更新通道端点与公钥收敛到构建期唯一事实源",
      details: "自检与签名徽章共用 NativeUpdaterConfig，旧补丁通道偏好已下线",
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3.1 CSP 无条件守卫                                               */
/* ------------------------------------------------------------------ */

/**
 * 生产 CSP 不得为空。审计要求即使没有自定义 URI 协议，也必须验证
 * default/script/img/connect/style 五个关键指令；null/缺失直接红灯。
 */
export function checkCsp(root, report) {
  let csp = null;
  try {
    csp = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    )?.app?.security?.csp;
  } catch {
    csp = null;
  }
  const value = typeof csp === "string" ? csp.trim() : "";
  const problems = [];
  if (!value) {
    problems.push("app.security.csp 为空或缺失");
  } else {
    const directives = {
      "default-src": /(?:^|;)\s*default-src\s+[^;]*'self'/,
      "script-src": /(?:^|;)\s*script-src\s+[^;]*'self'/,
      "img-src": /(?:^|;)\s*img-src\s+[^;]*'self'[^;]*\bdata:/,
      "connect-src-ipc": /(?:^|;)\s*connect-src\s+[^;]*\bipc:/,
      "connect-src-host": /(?:^|;)\s*connect-src\s+[^;]*(?:tauri\.localhost|ipc\.localhost)/,
      "style-src": /(?:^|;)\s*style-src\s+[^;]*'self'[^;]*'unsafe-inline'/,
    };
    for (const [name, regex] of Object.entries(directives)) {
      if (!regex.test(value)) problems.push(`CSP 缺少 ${name} 关键指令`);
    }
  }

  if (problems.length) {
    fail(report, {
      id: "static:csp",
      suite: "static",
      layer: "static",
      title: "生产 CSP 缺失或关键指令不完整",
      severity: "P1",
      details: problems.join(" | "),
      location: "src-tauri/tauri.conf.json",
      expected:
        "app.security.csp 至少包含 default-src 'self'、script-src 'self'、img-src 'self' data:、connect-src ipc: + tauri/ipc.localhost、style-src 'self' 'unsafe-inline'",
      actual: value || "null/missing",
      rootCause: "CSP 被置空，或收紧时漏掉 IPC/data URL/内联样式关键来源",
      fix: "按内部技术文档的 CSP 基线恢复（维护者本地维护）；devCsp 单独放行 Vite，不要放宽生产 csp",
    });
  } else {
    ok(report, {
      id: "static:csp",
      suite: "static",
      layer: "static",
      title: "生产 CSP 非空且覆盖 IPC/data URL/内联样式",
      details: value,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §2.3 发行级长尾体验：文件关联 / 备份 / Updater / 单实例           */
/* ------------------------------------------------------------------ */

/**
 * 守卫 0.16.0 的发行面：文件关联、备份命令、官方 Updater 公钥/endpoint、
 * 签名 CI、主窗专属 capability，以及三个用户入口文件。
 * 只做静态契约检查，不启动应用；运行期行为由 Rust 单测 + 真机冒烟覆盖。
 */
export function checkReleaseSurface(root, report) {
  const errors = [];
  const read = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      errors.push(`缺少 ${relative}`);
      return "";
    }
    return fs.readFileSync(file, "utf8");
  };
  const parseJson = (relative) => {
    try {
      return JSON.parse(read(relative));
    } catch (error) {
      errors.push(`${relative} 不是合法 JSON: ${error.message}`);
      return null;
    }
  };

  const conf = parseJson("src-tauri/tauri.conf.json");
  if (conf) {
    // 升级身份：NSIS 的卸载/升级键、快捷方式与文件关联都依赖这两个值。
    // 一旦改名，旧版本的桌面快捷方式、.cbz 关联和自动更新继承会断链。
    if (conf.productName !== "MangaReader") {
      errors.push(`productName 必须固定为 MangaReader（当前 ${conf.productName}）`);
    }
    if (conf.identifier !== "com.local.manga-reader") {
      errors.push(
        `identifier 必须固定为 com.local.manga-reader（当前 ${conf.identifier}）`,
      );
    }
    if (conf.mainBinaryName !== "manga-reader-tauri") {
      errors.push(
        `mainBinaryName 必须固定为 manga-reader-tauri（当前 ${conf.mainBinaryName}）`,
      );
    }

    const expectedTargets = ["nsis", "deb", "rpm", "appimage"];
    const targets = Array.isArray(conf.bundle?.targets)
      ? conf.bundle.targets
      : [];
    if (JSON.stringify(targets) !== JSON.stringify(expectedTargets)) {
      errors.push(
        `bundle.targets 必须锁定为 ${JSON.stringify(expectedTargets)}（当前 ${JSON.stringify(targets)}）`,
      );
    }
    if (targets.includes("msi")) {
      errors.push("bundle.targets 不得包含 msi：Windows 只发布 NSIS");
    }

    const associations = Array.isArray(conf.bundle?.fileAssociations)
      ? conf.bundle.fileAssociations
      : [];
    const extensions = associations.flatMap((entry) =>
      Array.isArray(entry?.ext) ? entry.ext : [],
    );
    for (const ext of ["cbz", "zip"]) {
      if (!extensions.includes(ext)) {
        errors.push(`bundle.fileAssociations 缺少 .${ext}`);
      }
    }

    const nsis = conf.bundle?.windows?.nsis;
    if (!nsis || typeof nsis !== "object") {
      errors.push("bundle.windows.nsis 缺失");
    } else {
      if (nsis.installMode !== "both") {
        errors.push("bundle.windows.nsis.installMode 必须为 both");
      }
      if (nsis.compression !== "lzma") {
        errors.push("bundle.windows.nsis.compression 必须为 lzma");
      }
      if (nsis.displayLanguageSelector !== true) {
        errors.push("bundle.windows.nsis.displayLanguageSelector 必须为 true");
      }
      const expectedLanguages = [
        "SimpChinese",
        "TradChinese",
        "English",
        "Spanish",
        "Japanese",
        "Korean",
      ];
      if (JSON.stringify(nsis.languages) !== JSON.stringify(expectedLanguages)) {
        errors.push(
          `bundle.windows.nsis.languages 必须为 ${JSON.stringify(expectedLanguages)}`,
        );
      }
    }

    if (conf.bundle?.createUpdaterArtifacts !== true) {
      errors.push("bundle.createUpdaterArtifacts 必须为 true");
    }
    if (
      typeof conf.plugins?.updater?.pubkey !== "string" ||
      conf.plugins.updater.pubkey.trim().length < 32
    ) {
      errors.push("plugins.updater.pubkey 缺失或过短");
    }
    const endpoints = Array.isArray(conf.plugins?.updater?.endpoints)
      ? conf.plugins.updater.endpoints
      : [];
    if (
      !endpoints.some(
        (endpoint) =>
          typeof endpoint === "string" &&
          endpoint.includes("github.com") &&
          endpoint.endsWith("latest.json"),
      )
    ) {
      errors.push("plugins.updater.endpoints 缺少 GitHub latest.json");
    }
    if (conf.plugins?.updater?.windows?.installMode !== "passive") {
      errors.push("plugins.updater.windows.installMode 必须为 passive");
    }
  }

  const updaterCapability = parseJson("src-tauri/capabilities/updater.json");
  if (updaterCapability) {
    const windows = Array.isArray(updaterCapability.windows)
      ? updaterCapability.windows
      : [];
    const permissions = Array.isArray(updaterCapability.permissions)
      ? updaterCapability.permissions
      : [];
    if (windows.length !== 1 || windows[0] !== "main") {
      errors.push("updater.json 只能覆盖 main 窗口");
    }
    if (!permissions.includes("updater:default")) {
      errors.push("updater.json 缺少 updater:default");
    }
    if (permissions.some((permission) => String(permission).startsWith("process:"))) {
      errors.push("updater.json 不得声明 process:* 权限（重启走自研 restart_app）");
    }
  }

  // Phase 4：发布链路拆成「候选（Draft）→ 发布（审批后公开）」，双通道各自独立。
  const windowsCandidate = read(".github/workflows/release-candidate.yml");
  const windowsPublish = read(".github/workflows/release-publish.yml");
  const linuxCandidate = read(".github/workflows/release-candidate-linux.yml");
  const linuxPublish = read(".github/workflows/release-publish-linux.yml");

  const windowsCandidateSteps = yamlStepTexts(windowsCandidate);
  const windowsCandidateText = windowsCandidateSteps
    ? windowsCandidateSteps.join("\n")
    : "";
  if (!windowsCandidateSteps || windowsCandidateSteps.length === 0) {
    errors.push("release-candidate.yml 未解析到 steps");
  }
  for (const marker of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "MR_BUILD_ORIGIN: official",
    "npx tsc --noEmit",
    "cargo test --lib",
    "npm run build",
    // 候选只落成 Draft，并产出审批依据。
    "releaseDraft: true",
    "uploadUpdaterJson: true",
    "rc-record.json",
    // QA 证据按 run id 绑定到候选 Commit。
    "qa_run_id",
    "verify-updater-manifest.mjs",
  ]) {
    if (!windowsCandidateText.includes(marker)) {
      errors.push(`release-candidate.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of [
    "windows-2022",
    "workflow_dispatch",
    "environment: release-windows",
    "contents: read",
    "contents: write",
  ]) {
    if (!windowsCandidate.includes(marker)) {
      errors.push(`release-candidate.yml 缺少 ${marker}`);
    }
  }
  if (/releaseDraft:\s*false/.test(windowsCandidate)) {
    errors.push("release-candidate.yml 不得直接公开发布（只能创建 Draft）");
  }

  const windowsPublishSteps = yamlStepTexts(windowsPublish);
  const windowsPublishText = windowsPublishSteps ? windowsPublishSteps.join("\n") : "";
  if (!windowsPublishSteps || windowsPublishSteps.length === 0) {
    errors.push("release-publish.yml 未解析到 steps");
  }
  for (const marker of [
    "verify-draft.mjs",
    "gh release edit",
    "--draft=false",
    "verify-updater-manifest.mjs",
    "latest-linux-critical.json",
  ]) {
    if (!windowsPublishText.includes(marker)) {
      errors.push(`release-publish.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of ["workflow_dispatch", "environment: release-windows"]) {
    if (!windowsPublish.includes(marker)) {
      errors.push(`release-publish.yml 缺少 ${marker}`);
    }
  }
  if (windowsPublish.includes("TAURI_SIGNING_PRIVATE_KEY")) {
    errors.push("release-publish.yml 不得持有签名私钥（产物已在候选阶段签名）");
  }

  const linuxCandidateSteps = yamlStepTexts(linuxCandidate);
  const linuxCandidateText = linuxCandidateSteps ? linuxCandidateSteps.join("\n") : "";
  if (!linuxCandidateSteps || linuxCandidateSteps.length === 0) {
    errors.push("release-candidate-linux.yml 未解析到 steps");
  }
  for (const marker of [
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "latest-linux-critical.json",
    "MR_BUILD_ORIGIN: official",
    "make-linux-critical-manifest.mjs",
    "npx tsc --noEmit",
    "cargo test --lib",
    "npm run build",
    "--config src-tauri/tauri.linux.conf.json",
    "--draft",
    "rc-record.json",
    "qa_run_id",
    "verify-updater-manifest.mjs",
  ]) {
    if (!linuxCandidateText.includes(marker)) {
      errors.push(`release-candidate-linux.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of [
    "ubuntu-22.04",
    "workflow_dispatch",
    "environment: release-linux",
    "contents: read",
    "contents: write",
  ]) {
    if (!linuxCandidate.includes(marker)) {
      errors.push(`release-candidate-linux.yml 缺少 ${marker}`);
    }
  }

  const linuxPublishSteps = yamlStepTexts(linuxPublish);
  const linuxPublishText = linuxPublishSteps ? linuxPublishSteps.join("\n") : "";
  if (!linuxPublishSteps || linuxPublishSteps.length === 0) {
    errors.push("release-publish-linux.yml 未解析到 steps");
  }
  for (const marker of [
    "verify-draft.mjs",
    "gh release edit",
    "--draft=false",
    "verify-updater-manifest.mjs",
    "linux-x86_64",
  ]) {
    if (!linuxPublishText.includes(marker)) {
      errors.push(`release-publish-linux.yml 的 steps 缺少 ${marker}`);
    }
  }
  for (const marker of ["workflow_dispatch", "environment: release-linux"]) {
    if (!linuxPublish.includes(marker)) {
      errors.push(`release-publish-linux.yml 缺少 ${marker}`);
    }
  }
  if (linuxPublish.includes("TAURI_SIGNING_PRIVATE_KEY")) {
    errors.push("release-publish-linux.yml 不得持有签名私钥（产物已在候选阶段签名）");
  }

  // Linux 端 updater 端点必须独立指向高危补丁通道（平台专属配置覆盖）。
  const linuxConf = parseJson("src-tauri/tauri.linux.conf.json");
  if (linuxConf) {
    const endpoints = Array.isArray(linuxConf.plugins?.updater?.endpoints)
      ? linuxConf.plugins.updater.endpoints
      : [];
    if (
      !endpoints.some((endpoint) =>
        typeof endpoint === "string" ? endpoint.endsWith("latest-linux-critical.json") : false,
      )
    ) {
      errors.push("tauri.linux.conf.json 的 updater 端点必须指向 latest-linux-critical.json");
    }
  }

  // Linux 发布链必须真的应用平台 overlay：overlay 文件存在不等于被使用。
  // 少了 --config，Linux 产物会带着 Windows 的 latest.json 端点，
  // 更新功能对 Linux 客户端形同虚设。
  if (linuxCandidateText && !linuxCandidateText.includes("--config src-tauri/tauri.linux.conf.json")) {
    errors.push(
      "release-candidate-linux.yml 的 tauri build 必须带 --config src-tauri/tauri.linux.conf.json",
    );
  }
  // 建 Draft 必须用 --verify-tag：不传 target_commitish，就不会触发对标签引用的写入尝试。
  // 本仓库的 tag ruleset 没有任何豁免者，集成令牌一旦尝试写标签引用就会被拒。
  if (linuxCandidateText && !/gh release create[^\n]*--verify-tag/.test(linuxCandidateText)) {
    errors.push("release-candidate-linux.yml 必须用 gh release create --verify-tag（不传 target_commitish）");
  }
  // AppImage 的 minisign 签名必须作为 Release 资产发布：清单里虽然内嵌了签名，
  // 但缺了 .sig 资产，用户就无法手动验签（Windows 通道同样发布 .exe.sig）。
  if (linuxCandidateText && !linuxCandidateText.includes("appimage/*.AppImage.sig")) {
    errors.push("release-candidate-linux.yml 必须上传 appimage/*.AppImage.sig");
  }

  // 常规 CI 必须覆盖 main 与 PR，且门禁步骤真实存在于 steps 内。
  for (const [file, markers] of [
    [
      ".github/workflows/ci-linux-check.yml",
      [
        "cargo clippy",
        "-D warnings",
        "--test e2e_stage1",
        "--test memory_budget",
        "cargo audit",
        "npm audit",
      ],
    ],
    [
      ".github/workflows/ci-windows-check.yml",
      [
        "npx tsc --noEmit",
        "cargo test --lib",
        "--test e2e_stage1",
        "--test memory_budget",
        "tests/qa/run-qa.mjs",
        "npm audit",
      ],
    ],
  ]) {
    const source = read(file);
    const steps = yamlStepTexts(source);
    const body = steps ? steps.join("\n") : "";
    if (!/branches:\s*\[[^\]]*main[^\]]*\]/.test(source)) {
      errors.push(`${file} 的 push/PR 分支未覆盖 main`);
    }
    if (!steps || steps.length === 0) {
      errors.push(`${file} 未解析到 steps`);
    }
    for (const marker of markers) {
      if (!body.includes(marker)) {
        errors.push(`${file} 的 steps 缺少 ${marker}`);
      }
    }
  }

  // 双端锁定：CI 与打包配置不得出现 macOS 残留（runner / darwin / icns）。
  const workflowsDir = path.join(root, ".github", "workflows");
  if (fs.existsSync(workflowsDir)) {
    for (const file of fs.readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"))) {
      const source = read(path.join(".github", "workflows", file));
      for (const pattern of ["macos-", "aarch64-apple-darwin", "x86_64-apple-darwin"]) {
        if (source.includes(pattern)) {
          errors.push(`${file} 含 macOS 构建残留 ${pattern}`);
        }
      }
    }
  }
  if (fs.existsSync(path.join(root, "src-tauri", "icons", "icon.icns"))) {
    errors.push("src-tauri/icons/icon.icns 仍存在（macOS 图标残留）");
  }

  const lib = read("src-tauri/src/lib.rs");
  for (const command of [
    "commands::relocate_book",
    "open_with::take_pending_open",
    "backup::export_backup",
    "backup::import_backup",
    "update::restart_app",
  ]) {
    if (!lib.includes(command)) {
      errors.push(`lib.rs 未注册 ${command}`);
    }
  }

  for (const entry of [
    "src/components/library/RelocateDialog.tsx",
    "src/components/settings/DataBackupPanel.tsx",
    "src/features/openWith/OpenWithBridge.tsx",
  ]) {
    if (!fs.existsSync(path.join(root, entry))) {
      errors.push(`缺少用户入口 ${entry}`);
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:release-surface",
      suite: "static",
      layer: "static",
      title: "发行级长尾体验的静态契约不完整",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/tauri.conf.json",
      expected:
        "文件关联 .cbz/.zip、createUpdaterArtifacts、plugins.updater、签名 CI、主窗 updater 权限、五个命令与三个用户入口齐全",
      actual: errors.join(" | "),
      rootCause: "新增发行能力时漏改配置、命令注册或权限文件",
      fix: "按内部发布与技术文档（维护者本地维护）补齐缺失项",
    });
  } else {
    ok(report, {
      id: "static:release-surface",
      suite: "static",
      layer: "static",
      title: "文件关联/备份/Updater/单实例静态契约齐全",
      details: "tauri.conf + tauri.linux.conf + 双发版流水线 + 命令注册 + 三个入口文件",
    });
  }
}

/* ------------------------------------------------------------------ */
/* §3 Tauri 2 权限能力墙                                             */
/* ------------------------------------------------------------------ */

/** 真实窗口标签：主窗 / 独立恢复窗 / 内嵌浏览器窗。 */
const REQUIRED_WINDOW_LABELS = ["main", "recovery", "browser"];

/** 过宽权限黑名单：全量 fs / shell / process 一律禁止。 */
const FORBIDDEN_PERMISSION_PATTERNS = [
  { name: "fs 全量权限", regex: /^fs:/ },
  { name: "shell 权限", regex: /^shell:/ },
  { name: "process 权限", regex: /^process:/ },
  { name: "http 权限", regex: /^http:/ },
];

export function checkCapabilityWall(root, report) {
  const dir = path.join(root, "src-tauri", "capabilities");
  const defaultFile = path.join(dir, "default.json");
  const errors = [];
  let defaultCapability = null;

  if (!fs.existsSync(defaultFile)) {
    fail(report, {
      id: "static:capability-wall",
      suite: "static",
      layer: "static",
      title: "Tauri 能力墙文件缺失",
      severity: "P1",
      details: "src-tauri/capabilities/default.json 不存在",
      location: "src-tauri/capabilities/default.json",
      expected: "default.json 覆盖 main/recovery/browser 三个窗口标签",
      actual: "文件缺失",
    });
    return;
  }

  const capabilityFiles = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));

  for (const file of capabilityFiles) {
    let capability = null;
    try {
      capability = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`${path.basename(file)} 不是合法 JSON: ${error.message}`);
      continue;
    }
    if (file === defaultFile) defaultCapability = capability;
    const permissions = Array.isArray(capability.permissions)
      ? capability.permissions
      : [];
    for (const permission of permissions) {
      for (const pattern of FORBIDDEN_PERMISSION_PATTERNS) {
        if (pattern.regex.test(String(permission))) {
          errors.push(
            `${path.basename(file)} 含过宽权限 ${permission}（${pattern.name}）`,
          );
        }
      }
    }
    const windows = Array.isArray(capability.windows) ? capability.windows : [];
    if (windows.length === 0) {
      errors.push(`${path.basename(file)} 未声明任何窗口标签`);
    }
  }

  if (defaultCapability) {
    const windows = Array.isArray(defaultCapability.windows)
      ? defaultCapability.windows
      : [];
    const missing = REQUIRED_WINDOW_LABELS.filter(
      (label) => !windows.includes(label),
    );
    if (missing.length) {
      errors.push(`default.json 的 windows 缺少 ${missing.join(",")}`);
    }
    // 恢复窗使用 @tauri-apps/api/window 的 setTitle() 同步原生标题时，
    // 必须显式声明 core:window:allow-set-title（core:default 不包含）。
    const recoverySource = path.join(root, "src", "recovery", "RecoveryApp.tsx");
    const recoveryUsesSetTitle =
      fs.existsSync(recoverySource) &&
      /\bsetTitle\s*\(/.test(fs.readFileSync(recoverySource, "utf8"));
    if (recoveryUsesSetTitle) {
      const permissions = Array.isArray(defaultCapability.permissions)
        ? defaultCapability.permissions
        : [];
      if (!permissions.includes("core:window:allow-set-title")) {
        errors.push(
          "RecoveryApp 使用 setTitle()，但 default.json 缺少 core:window:allow-set-title",
        );
      }
    }
    // 恢复窗 / 浏览器窗的真实标签必须与 Rust 常量一致。
    const rustSources = ["resilience.rs", "browser.rs"]
      .map((name) => path.join(root, "src-tauri", "src", name))
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const labelMatch = rustSources.match(
      /const\s+(?:RECOVERY|BROWSER)_LABEL\s*:\s*&str\s*=\s*"([^"]+)"/g,
    );
    for (const match of labelMatch || []) {
      const label = match.match(/"([^"]+)"/)?.[1];
      if (!label) continue;
      const covered = capabilityFiles.some((file) => {
        const capability = JSON.parse(fs.readFileSync(file, "utf8"));
        return (capability.windows || []).includes(label);
      });
      if (!covered) {
        errors.push(`窗口标签 ${label} 未被任何 capability 覆盖`);
      }
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:capability-wall",
      suite: "static",
      layer: "static",
      title: "Tauri 能力墙缺失窗口标签或声明了过宽权限",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/capabilities/default.json",
      expected:
        "default.json 的 windows = [main, recovery, browser]；权限只允许 core:window:allow-* / opener:default / dialog:default 等真实调用项",
      actual: errors.join(" | "),
      rootCause: "新增窗口未补齐 capability，或声明了 fs/shell/process 全量权限",
      fix: "补齐 windows 数组；删除过宽权限，改用精确 allow-* 授权",
    });
  } else {
    ok(report, {
      id: "static:capability-wall",
      suite: "static",
      layer: "static",
      title: "能力墙覆盖 main/recovery/browser 且无过宽权限",
      details: `检查 ${capabilityFiles.length} 个 capability 文件`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §2.2 存储清洗白名单必须覆盖前端实际使用的全部 mr-* 键            */
/* ------------------------------------------------------------------ */
function collectMrLiterals(root) {
  const found = new Map();
  const srcRoot = path.join(root, "src");
  const skip = path.join("lib", "storageSanitizer.ts");
  for (const file of walk(srcRoot)) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue;
    if (path.normalize(file).endsWith(skip)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/"(mr-[A-Za-z0-9_-]+)"/g)) {
      const key = match[1];
      if (!found.has(key)) {
        found.set(key, path.relative(root, file));
      }
    }
  }
  return found;
}

export function checkStorageWhitelist(root, report) {
  const sanitizerPath = path.join(root, "src", "lib", "storageSanitizer.ts");
  const errors = [];
  let known = [];
  let dynamic = [];
  let deprecated = [];
  if (fs.existsSync(sanitizerPath)) {
    const source = fs.readFileSync(sanitizerPath, "utf8");
    known = loadTsObject(source, "KNOWN_STORAGE_KEYS") || [];
    dynamic = loadTsObject(source, "DYNAMIC_KEY_PREFIXES") || [];
    deprecated = loadTsObject(source, "DEPRECATED_KEY_PREFIXES") || [];
  } else {
    errors.push("缺少 src/lib/storageSanitizer.ts");
  }

  // 非存储用途的 mr-* 标识（事件名 / 状态名 / 广播名），不属于 localStorage 键。
  const nonStorage = new Set([
    "mr-focus-library-search",
    "mr-online-handoff-state",
    "mr-online-last-test-updated",
    "mr-online-library-refresh",
    "mr-privacy-open",
    "mr-settings-changed",
    "mr-settings-updated",
    "mr-storage-sanitized",
  ]);

  const used = collectMrLiterals(root);
  for (const [key, file] of used) {
    if (nonStorage.has(key)) continue;
    if (deprecated.some((prefix) => key.startsWith(prefix))) {
      errors.push(`${file}: 仍在使用已废弃键 ${key}`);
      continue;
    }
    if (known.includes(key)) continue;
    if (dynamic.some((prefix) => key.startsWith(prefix))) continue;
    errors.push(
      `${file}: ${key} 未登记到存储清洗白名单，启动清洗时会被当作未知键删除`,
    );
  }

  if (errors.length) {
    fail(report, {
      id: "static:storage-whitelist",
      suite: "static",
      layer: "static",
      title: "前端 localStorage 键未与存储清洗白名单对齐",
      severity: "P1",
      details: errors.join(" | "),
      location: "src/lib/storageSanitizer.ts",
      expected:
        "src/ 下出现的每个 mr-* 键都必须在 KNOWN_STORAGE_KEYS / DYNAMIC_KEY_PREFIXES 中登记",
      actual: errors.join(" | "),
      rootCause: "新增 localStorage 键时没有同步清洗器白名单，用户状态会在启动时被静默删除",
      fix: "把新键登记进 storageSanitizer.ts 的 KEY_RULES（或加入 DYNAMIC 前缀）",
    });
  } else {
    ok(report, {
      id: "static:storage-whitelist",
      suite: "static",
      layer: "static",
      title: "前端存储键与清洗白名单完全对齐",
      details: `扫描 ${used.size} 个 mr-* 标识`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §4.2 超高分辨率条漫纹理安全线                                     */
/* ------------------------------------------------------------------ */
export function checkWebtoonTextureGuard(root, report) {
  const pipelineFile = path.join(root, "src-tauri", "src", "pipeline.rs");
  const errors = [];
  let details = "";

  if (!fs.existsSync(pipelineFile)) {
    fail(report, {
      id: "static:webtoon-texture-guard",
      suite: "static",
      layer: "static",
      title: "图片管线源文件缺失",
      severity: "P1",
      details: "src-tauri/src/pipeline.rs 不存在",
      location: "src-tauri/src/pipeline.rs",
    });
    return;
  }

  const source = fs.readFileSync(pipelineFile, "utf8");
  const safeMatch = source.match(
    /pub const MAX_SAFE_TEXTURE_H\s*:\s*u32\s*=\s*(\d+)\s*;/,
  );
  const sliceMatch = source.match(
    /pub const MAX_SLICE_H\s*:\s*u32\s*=\s*(\d+)\s*;/,
  );
  const tileMatch = source.match(
    /pub const WEBTOON_TILE_H\s*:\s*u32\s*=\s*(\d+)\s*;/,
  );

  if (!safeMatch) {
    errors.push("pipeline.rs 未定义 MAX_SAFE_TEXTURE_H");
  } else if (Number(safeMatch[1]) < 4096) {
    errors.push(`MAX_SAFE_TEXTURE_H=${safeMatch[1]} < 4096`);
  }
  if (!sliceMatch) {
    errors.push("pipeline.rs 未定义 MAX_SLICE_H");
  } else if (Number(sliceMatch[1]) < 2048) {
    errors.push(`MAX_SLICE_H=${sliceMatch[1]} < 2048`);
  }
  if (!tileMatch) {
    errors.push("pipeline.rs 未定义 WEBTOON_TILE_H");
  }
  // 钳制必须真的被单页渲染路径使用，而不只是定义了常量。
  if (safeMatch && !/safe_fit\(|clamp_texture_safe\(/.test(source)) {
    errors.push("MAX_SAFE_TEXTURE_H 未被 safe_fit/clamp_texture_safe 使用");
  }
  if (!/render_webtoon_tiles/.test(source)) {
    errors.push("pipeline.rs 缺少 render_webtoon_tiles（条漫先切后缩入口）");
  }

  // 前后端切片高度常量必须一致（AGENTS.md §4.2）。
  const tauriFile = path.join(root, "src", "lib", "tauri.ts");
  if (fs.existsSync(tauriFile)) {
    const tsSource = fs.readFileSync(tauriFile, "utf8");
    const tsMatch = tsSource.match(
      /export const WEBTOON_TILE_H\s*=\s*(\d+)\s*;/,
    );
    if (!tsMatch) {
      errors.push("src/lib/tauri.ts 未导出 WEBTOON_TILE_H");
    } else if (tileMatch && Number(tsMatch[1]) !== Number(tileMatch[1])) {
      errors.push(
        `切片高度常量不一致：Rust=${tileMatch[1]} vs TS=${tsMatch[1]}`,
      );
    } else {
      details = `WEBTOON_TILE_H=${tileMatch ? tileMatch[1] : "?"}`;
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:webtoon-texture-guard",
      suite: "static",
      layer: "static",
      title: "超高条漫纹理安全线常量缺失或前后端不一致",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/src/pipeline.rs",
      expected:
        "MAX_SAFE_TEXTURE_H ≥ 4096、MAX_SLICE_H ≥ 2048、WEBTOON_TILE_H 前后端一致",
      actual: errors.join(" | "),
      rootCause: "巨图防线常量被删除/改名或前后端漂移",
      fix: "恢复常量并保持 pipeline.rs 与 src/lib/tauri.ts 同值",
    });
  } else {
    ok(report, {
      id: "static:webtoon-texture-guard",
      suite: "static",
      layer: "static",
      title: "超高条漫纹理安全线常量齐备且前后端一致",
      details: `MAX_SAFE_TEXTURE_H=${safeMatch ? safeMatch[1] : "?"}，MAX_SLICE_H=${
        sliceMatch ? sliceMatch[1] : "?"
      }，${details}`,
    });
  }
}

function recordDictionaryResult(report, errors, keys, locales) {
  if (errors.length) {
    fail(report, {
      id: "static:i18n-parity",
      suite: "static",
      layer: "unit",
      title: "六语种字典完整性与占位符一致",
      severity: "P1",
      details: errors.slice(0, 20).join(" | "),
      expected: "所有键存在且占位符一致",
      actual: errors.slice(0, 20).join(" | "),
      location: "src/i18n/messages",
      rootCause: "新增文案未补齐或占位符改写",
      fix: "按包名补齐六语种并校验 {variables}",
    });
  } else {
    ok(report, {
      id: "static:i18n-parity",
      suite: "static",
      layer: "unit",
      title: "六语种字典完整性与占位符一致",
      details: `${keys} keys × ${locales} locales`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §6 生产构建：不得携带 sidecar / externalBin / 资源外挂            */
/* ------------------------------------------------------------------ */

function nonEmptyBundleEntry(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function checkProductionBundle(root, report) {
  const errors = [];
  let conf = null;
  try {
    conf = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    );
  } catch (error) {
    fail(report, {
      id: "static:production-bundle",
      suite: "static",
      layer: "static",
      title: "生产构建清单无法解析",
      severity: "P1",
      details: String(error),
      location: "src-tauri/tauri.conf.json",
    });
    return;
  }

  const bundle = conf?.bundle || {};
  if (nonEmptyBundleEntry(bundle.externalBin)) {
    errors.push(`bundle.externalBin 非空：${JSON.stringify(bundle.externalBin)}`);
  }
  if (nonEmptyBundleEntry(bundle.resources)) {
    errors.push(`bundle.resources 非空：${JSON.stringify(bundle.resources)}`);
  }

  let scripts = {};
  try {
    scripts = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ).scripts || {};
  } catch (error) {
    errors.push(`package.json 无法解析：${error.message}`);
  }
  const sidecarScriptPatterns = [
    { name: "python 启动", regex: /(^|[^a-z])python(?:3(?:\.\d+)?)?(?:\.exe)?([^a-z]|$)/i },
    { name: "sidecar 启动", regex: /\bsidecar\b/i },
    { name: "OCR 服务", regex: /(^|[^a-z])ocr([^a-z]|$)/i },
    { name: "8500 端口", regex: /\b8500\b/ },
  ];
  for (const [name, command] of Object.entries(scripts)) {
    const text = `${name} ${String(command)}`;
    for (const pattern of sidecarScriptPatterns) {
      if (pattern.regex.test(text)) {
        errors.push(`npm script "${name}" 含 ${pattern.name}：${command}`);
      }
    }
  }

  if (errors.length) {
    fail(report, {
      id: "static:production-bundle",
      suite: "static",
      layer: "static",
      title: "生产构建携带 sidecar/外部资源痕迹",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/tauri.conf.json / package.json",
      expected:
        "bundle.externalBin / bundle.resources 为空或不存在；npm scripts 不拉起 Python/OCR sidecar、不监听 8500",
      actual: errors.join(" | "),
      rootCause: "生产构建配置重新引入了外部二进制或 sidecar 启动脚本",
      fix: "删除 externalBin/resources 条目与 python/ocr 启动脚本",
    });
  } else {
    ok(report, {
      id: "static:production-bundle",
      suite: "static",
      layer: "static",
      title: "生产构建不含 externalBin/resources 与 sidecar 启动脚本",
      details: `bundle 键：${Object.keys(bundle).join(", ") || "空"}；scripts=${Object.keys(scripts).length}`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §4.3 自定义图片协议：要么完全不存在，要么有编解码测试 + CSP      */
/* ------------------------------------------------------------------ */

/** 去掉 JS/TS 注释但保留字符串，避免文档性注释误报。 */
function stripJsComments(source) {
  let out = "";
  let index = 0;
  let inString = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === inString) inString = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "  ";
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function collectProtocolHits(root) {
  const patterns = [/register_uri_scheme_protocol/, /manga-proxy:\/\//];
  const hits = [];
  const rustRoot = path.join(root, "src-tauri", "src");
  if (fs.existsSync(rustRoot)) {
    for (const file of walk(rustRoot).filter((name) => name.endsWith(".rs"))) {
      const code = stripRustComments(fs.readFileSync(file, "utf8"));
      for (const pattern of patterns) {
        for (const match of code.matchAll(
          new RegExp(pattern.source, "g"),
        )) {
          hits.push({
            file: path.relative(root, file),
            line: code.slice(0, match.index).split("\n").length,
            snippet: match[0],
          });
        }
      }
    }
  }
  const frontRoot = path.join(root, "src");
  if (fs.existsSync(frontRoot)) {
    for (const file of walk(frontRoot).filter((name) => /\.(tsx?|jsx?|mjs)$/.test(name))) {
      const code = stripJsComments(fs.readFileSync(file, "utf8"));
      for (const pattern of patterns) {
        for (const match of code.matchAll(
          new RegExp(pattern.source, "g"),
        )) {
          hits.push({
            file: path.relative(root, file),
            line: code.slice(0, match.index).split("\n").length,
            snippet: match[0],
          });
        }
      }
    }
  }
  return hits;
}

function collectRustTestSources(root) {
  const sourceRoot = path.join(root, "src-tauri", "src");
  if (!fs.existsSync(sourceRoot)) return [];
  const sources = [];
  for (const file of walk(sourceRoot).filter((name) => name.endsWith(".rs"))) {
    const source = fs.readFileSync(file, "utf8");
    const index = source.indexOf("#[cfg(test)]");
    if (index >= 0) sources.push(source.slice(index));
  }
  return sources;
}

export function checkNoUnusedCustomProtocol(root, report) {
  let hits = [];
  try {
    hits = collectProtocolHits(root);
  } catch (error) {
    fail(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "自定义协议扫描失败",
      severity: "P2",
      details: String(error),
      location: "src / src-tauri/src",
    });
    return;
  }

  if (hits.length === 0) {
    ok(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "无 manga-proxy 自定义协议（图片经命令通道）",
      details: "未发现 register_uri_scheme_protocol / manga-proxy:// 引用",
    });
    note(report, "图片经命令通道，无需自定义协议（static:no-custom-protocol）");
    return;
  }

  const testSources = collectRustTestSources(root);
  const testRoot = path.join(root, "tests");
  if (fs.existsSync(testRoot)) {
    for (const file of walk(testRoot).filter((name) => /\.(mjs|js|ts)$/.test(name))) {
      testSources.push(fs.readFileSync(file, "utf8"));
    }
  }
  const combinedTests = testSources.join("\n");
  const hasProtocolTest =
    /manga-proxy|register_uri_scheme_protocol/i.test(combinedTests) &&
    /\bencode\b/i.test(combinedTests) &&
    /\bdecode\b/i.test(combinedTests) &&
    /\bassert|expect\(|deepEqual|strictEqual/i.test(combinedTests);

  let csp = null;
  try {
    csp = JSON.parse(
      fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
    )?.app?.security?.csp;
  } catch {
    csp = null;
  }
  const hasCsp = typeof csp === "string" && csp.trim().length > 0;

  const problems = [];
  if (!hasProtocolTest) {
    problems.push("缺少自定义协议的编码/解码测试（需同时包含 encode/decode 与断言）");
  }
  if (!hasCsp) {
    problems.push("tauri.conf.json app.security.csp 为空，自定义协议缺少 CSP 约束");
  }

  if (problems.length) {
    fail(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "自定义图片协议缺少编解码测试或 CSP 配置",
      severity: "P1",
      details: `${problems.join(" | ")}；命中：${hits
        .map((hit) => `${hit.file}:${hit.line}`)
        .join(", ")}`,
      location: `${hits[0].file}:${hits[0].line}`,
      expected:
        "manga-proxy 协议要么完全不存在；存在时必须有 encode/decode round-trip 测试与非空 CSP",
      actual: problems.join(" | "),
      rootCause: "绕过命令通道直接注册自定义协议，且缺少配套安全/回归约束",
      fix: "恢复图片命令通道；如确需自定义协议，补编解码测试并配置 CSP",
    });
  } else {
    ok(report, {
      id: "static:no-custom-protocol",
      suite: "static",
      layer: "static",
      title: "自定义图片协议具备编解码测试与 CSP 约束",
      details: `${hits.length} 处协议引用，CSP 已配置`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* §1.2 设置/诊断/隐私/恢复窗：不得残留硬编码 JSX 文案              */
/* ------------------------------------------------------------------ */

const HARDCODED_TEXT_DIRS = [
  path.join("src", "components", "settings"),
  path.join("src", "components", "diagnostics"),
  path.join("src", "components", "privacy"),
  path.join("src", "recovery"),
];

/** 设置页主体（5 分区标题/说明）同样属于本轮后置 i18n 覆盖范围。 */
const HARDCODED_TEXT_FILES = [path.join("src", "pages", "Settings.tsx")];

/** 技术缩写/专有名词/单位：不视为待翻译的硬编码文案。 */
const ALLOWED_UI_TOKENS = new Set([
  "MB",
  "KB",
  "GB",
  "AI",
  "URL",
  "UA",
  "HTTP",
  "HTTPS",
  "CPU",
  "API",
  "TXT",
  "JSON",
  "SHA",
  "Rust",
  "Tauri",
  "Windows",
  "PowerShell",
  "SmartScreen",
  "MangaReader",
  "GitHub",
  "WebView",
  "WebView2",
  "SQLite",
  "Vite",
  "MSI",
  "NSIS",
  "localhost",
  "127.0.0.1",
]);

function suspiciousHardcodedText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/[\u3400-\u9fff]/.test(value)) return value;
  const words = value.match(/[A-Za-z]{2,}/g) || [];
  const suspicious = words.filter(
    (word) =>
      !ALLOWED_UI_TOKENS.has(word) &&
      // 全大写缩写（SHA/MB/URL…）视为技术标识，不误报。
      !/^[A-Z][A-Z0-9]*$/.test(word),
  );
  return suspicious.length ? value : null;
}

export function checkPostI18nHardcodedText(root, report) {
  const hits = [];
  const missingDirs = [];
  const files = [];
  for (const dir of HARDCODED_TEXT_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) {
      missingDirs.push(dir);
      continue;
    }
    files.push(...walk(full).filter((name) => name.endsWith(".tsx")));
  }
  for (const relative of HARDCODED_TEXT_FILES) {
    const full = path.join(root, relative);
    if (fs.existsSync(full)) files.push(full);
    else missingDirs.push(relative);
  }
  for (const file of files) {
    {
      const source = fs.readFileSync(file, "utf8");
      let ast = null;
      try {
        ast = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
      } catch (error) {
        hits.push({
          file: path.relative(root, file),
          line: 1,
          kind: "parse-error",
          text: String(error),
        });
        continue;
      }
      const visit = (node) => {
        if (ts.isJsxText(node)) {
          const text = suspiciousHardcodedText(node.text);
          if (text) {
            hits.push({
              file: path.relative(root, file),
              line:
                ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              kind: "jsx-text",
              text: text.slice(0, 100),
            });
          }
        }
        if (
          ts.isJsxAttribute(node) &&
          /^(aria-label|title)$/.test(node.name.getText(ast))
        ) {
          const initializer = node.initializer;
          if (initializer && ts.isStringLiteral(initializer)) {
            const text = suspiciousHardcodedText(initializer.text);
            if (text) {
              hits.push({
                file: path.relative(root, file),
                line:
                  ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
                kind: node.name.getText(ast),
                text: text.slice(0, 100),
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }

  if (hits.length) {
    fail(report, {
      id: "static:post-i18n-hardcode",
      suite: "static",
      layer: "static",
      title: "设置/诊断/隐私/恢复窗仍含硬编码可见文案",
      severity: "P1",
      details: hits
        .slice(0, 20)
        .map((hit) => `${hit.file}:${hit.line} [${hit.kind}] ${JSON.stringify(hit.text)}`)
        .join(" | "),
      location: `${hits[0].file}:${hits[0].line}`,
      expected:
        "JSX 文本节点与 aria-label/title 字符串统一走 t()；仅允许技术缩写/单位",
      actual: hits
        .slice(0, 20)
        .map((hit) => `${hit.file}:${hit.line} ${hit.text}`)
        .join(", "),
      rootCause: "新增分区时直接写入中英文文案，未走六语字典",
      fix: "改用 useI18n().t(key)，并同步六语字典",
    });
  } else {
    ok(report, {
      id: "static:post-i18n-hardcode",
      suite: "static",
      layer: "static",
      title: "设置/诊断/隐私/恢复窗无硬编码 JSX 文案",
      details: `扫描 ${files.length} 个文件（${
        HARDCODED_TEXT_DIRS.length
      } 个目录 + Settings.tsx）${
        missingDirs.length ? `（缺失：${missingDirs.join(", ")}）` : ""
      }`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 反 Mock 审计：关键算法必须有真实函数调用与断言                     */
/* ------------------------------------------------------------------ */

const ANTI_MOCK_AREAS = [
  {
    name: "自然序",
    file: path.join("src-tauri", "src", "commands.rs"),
    definition: /fn\s+natural_cmp(?:_path)?\s*\(/,
    symbol: "natural_cmp_path",
    testSymbols: ["natural_cmp", "natural_cmp_path"],
  },
  {
    name: "日志脱敏",
    file: path.join("src-tauri", "src", "diagnostics.rs"),
    definition: /fn\s+sanitize_text\s*\(/,
    symbol: "sanitize_text",
    testSymbols: ["sanitize_text"],
  },
  {
    name: "在线提纯",
    file: path.join("src-tauri", "src", "online", "filter.rs"),
    definition: /fn\s+filter_candidates\s*\(/,
    symbol: "filter_candidates",
    testSymbols: ["filter_candidates"],
  },
  {
    name: "条漫切片",
    file: path.join("src-tauri", "src", "pipeline.rs"),
    definition: /fn\s+render_webtoon_tiles\s*\(/,
    symbol: "render_webtoon_tiles",
    testSymbols: ["render_webtoon_tiles"],
  },
  {
    name: "进度事务",
    file: path.join("src-tauri", "src", "db.rs"),
    definition: /fn\s+set_progress\s*\(/,
    symbol: "set_progress",
    testSymbols: ["set_progress"],
  },
  {
    name: "重定位历史",
    file: path.join("src-tauri", "src", "db.rs"),
    definition: /fn\s+relocate_book\s*\(/,
    symbol: "relocate_book",
    testSymbols: ["relocate_book"],
  },
  {
    name: "NO_PROXY",
    file: path.join("src-tauri", "src", "online", "http.rs"),
    definition: /fn\s+no_proxy_matches\s*\(/,
    symbol: "no_proxy_matches",
    testSymbols: ["no_proxy_matches"],
  },
];

export function checkAntiMockGuards(root, report) {
  const errors = [];
  const evidence = [];
  const rustRoot = path.join(root, "src-tauri", "src");
  const prodSources = [];
  const testSources = [];

  if (fs.existsSync(rustRoot)) {
    for (const file of walk(rustRoot).filter((name) => name.endsWith(".rs"))) {
      const source = fs.readFileSync(file, "utf8");
      const index = source.indexOf("#[cfg(test)]");
      prodSources.push(index >= 0 ? source.slice(0, index) : source);
      if (index >= 0) testSources.push(source.slice(index));
    }
  }
  const allProd = prodSources.join("\n");
  const allTests = testSources.join("\n");

  for (const area of ANTI_MOCK_AREAS) {
    const file = path.join(root, area.file);
    if (!fs.existsSync(file)) {
      errors.push(`${area.name}：缺少 ${area.file}`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    const index = source.indexOf("#[cfg(test)]");
    const prod = index >= 0 ? source.slice(0, index) : source;
    const tests = index >= 0 ? source.slice(index) : "";
    if (!area.definition.test(prod)) {
      errors.push(`${area.name}：${area.file} 缺少生产函数定义`);
    }
    if (!tests) {
      errors.push(`${area.name}：${area.file} 缺少 #[cfg(test)] 测试`);
    } else {
      const mentionsReal = area.testSymbols.some((symbol) =>
        new RegExp(`\\b${symbol}\\s*\\(`).test(tests),
      );
      if (!mentionsReal) {
        errors.push(
          `${area.name}：测试未调用真实函数（${area.testSymbols.join("/")}）`,
        );
      }
      if (!/\bassert(?:_eq|_ne)?!\s*\(/.test(tests)) {
        errors.push(`${area.name}：测试缺少断言`);
      }
    }
    const stripped = allProd.replace(
      new RegExp(`fn\\s+${area.symbol}\\s*\\(`, "g"),
      "",
    );
    const calls = (
      stripped.match(new RegExp(`\\b${area.symbol}\\s*\\(`, "g")) || []
    ).length;
    if (calls < 1) {
      errors.push(
        `${area.name}：生产路径未调用 ${area.symbol}（疑似仅剩 mock/常量）`,
      );
    }
    evidence.push(`${area.name}: 生产调用 ${calls} 次`);
  }

  // QA 套件不得用 mock 替换 Tauri invoke。
  const overrideHits = [];
  const testsRoot = path.join(root, "tests");
  if (fs.existsSync(testsRoot)) {
    for (const file of walk(testsRoot).filter((name) => /\.(tsx?|jsx?|mjs)$/.test(name))) {
      const source = fs.readFileSync(file, "utf8");
      if (/__TAURI_INTERNALS__\s*\.\s*invoke\s*=/.test(source)) {
        overrideHits.push(path.relative(root, file));
      }
    }
  }
  if (overrideHits.length) {
    errors.push(`QA 套件替换了真实 invoke：${overrideHits.join(", ")}`);
  }

  if (errors.length) {
    fail(report, {
      id: "static:anti-mock-guards",
      suite: "static",
      layer: "static",
      title: "关键算法只有 mock/常量而缺少真实调用与断言",
      severity: "P1",
      details: errors.join(" | "),
      location: "src-tauri/src",
      expected:
        "自然序、脱敏、在线过滤、条漫切片都有真实生产调用 + #[cfg(test)] 断言；QA 不得替换 invoke",
      actual: errors.join(" | "),
      rootCause: "测试以假常量替代真实函数，或关键算法被 mock 化",
      fix: "恢复真实函数断言；禁止在 QA 中覆写 __TAURI_INTERNALS__.invoke",
    });
  } else {
    ok(report, {
      id: "static:anti-mock-guards",
      suite: "static",
      layer: "static",
      title: "自然序/脱敏/在线过滤/条漫切片均有真实调用与断言",
      details: evidence.join("；"),
    });
  }
}
