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
