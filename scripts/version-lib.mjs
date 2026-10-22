import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAIN_CARGO_PACKAGE = "manga-reader-tauri";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export function parseVersion(raw) {
  const value = String(raw ?? "").trim();
  if (!VERSION_RE.test(value)) {
    throw new Error(`版本号必须是 MAJOR.MINOR.PATCH：${JSON.stringify(raw)}`);
  }
  const [major, minor, patch] = value.split(".").map(Number);
  return { major, minor, patch, raw: value };
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

/**
 * Release semantics used by this repository:
 * - PATCH: patch-preferred
 * - MINOR: patch-capable (crossing >= 2 minor versions requires full at update time)
 * - MAJOR: full-only
 */
export function classifyVersionChange(previous, next) {
  const before = parseVersion(previous);
  const after = parseVersion(next);
  const order = compareVersions(previous, next);
  if (order === 0) {
    return { kind: "unchanged", updateMode: "none" };
  }
  if (order > 0) {
    return {
      kind: "downgrade",
      updateMode: "manual-only",
      message: "目标版本低于源版本；正式发布请显式确认降级。",
    };
  }
  if (after.major !== before.major) {
    return { kind: "major", updateMode: "full-only" };
  }
  if (after.minor !== before.minor) {
    return {
      kind: "minor",
      updateMode: "patch-capable",
      minorSpan: after.minor - before.minor,
    };
  }
  return { kind: "patch", updateMode: "patch-preferred" };
}

function readText(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function writeText(root, rel, text) {
  writeFileSync(path.join(root, rel), text, "utf8");
}

function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function lineOfJsonProperty(text, key) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*"${key}"\\s*:`);
  for (let index = 0; index < lines.length; index += 1) {
    if (re.test(lines[index])) {
      const match = lines[index].match(/:\s*"([^"]*)"/);
      return { line: index + 1, value: match?.[1] ?? null };
    }
  }
  return { line: 0, value: null };
}

export function lineOfCargoTomlPackageVersion(text) {
  const lines = text.split(/\r?\n/);
  let inPackage = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) {
      inPackage = /^\s*\[package\]\s*$/.test(line);
      continue;
    }
    if (inPackage) {
      const match = line.match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
      if (match) return { line: index + 1, value: match[1] };
    }
  }
  return { line: 0, value: null };
}

export function lineOfCargoLockVersion(text, packageName = MAIN_CARGO_PACKAGE) {
  const lines = text.split(/\r?\n/);
  let currentName = null;
  for (let index = 0; index < lines.length; index += 1) {
    const nameMatch = lines[index].match(/^\s*name\s*=\s*"([^"]+)"\s*$/);
    if (nameMatch) currentName = nameMatch[1];
    if (currentName !== packageName) continue;
    const versionMatch = lines[index].match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
    if (versionMatch) return { line: index + 1, value: versionMatch[1] };
  }
  return { line: 0, value: null };
}

export function packageLockVersionLines(text) {
  const root = lineOfJsonProperty(text, "version");
  const lines = text.split(/\r?\n/);
  let packagesIndex = -1;
  let emptyIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*"packages"\s*:\s*\{/.test(lines[index])) packagesIndex = index;
    if (packagesIndex >= 0 && index > packagesIndex && /^\s{4}"":\s*\{/.test(lines[index])) {
      emptyIndex = index;
      break;
    }
  }
  let inner = { line: 0, value: null };
  if (emptyIndex >= 0) {
    for (let index = emptyIndex + 1; index < lines.length; index += 1) {
      if (/^\s{4}\}/.test(lines[index])) break;
      const match = lines[index].match(/^\s*"version"\s*:\s*"([^"]*)"\s*,?\s*$/);
      if (match) {
        inner = { line: index + 1, value: match[1] };
        break;
      }
    }
  }
  return { root, packagesRoot: inner };
}

function replaceLineValue(text, lineNumber, regex, version) {
  if (lineNumber <= 0) throw new Error("待写入的版本字段不存在");
  const lines = text.split(/\r?\n/);
  const index = lineNumber - 1;
  if (!lines[index] || !regex.test(lines[index])) {
    throw new Error(`第 ${lineNumber} 行不是预期的版本字段`);
  }
  lines[index] = /:\s*"/.test(lines[index])
    ? lines[index].replace(/(:\s*")[^"]*(")/, `$1${version}$2`)
    : lines[index].replace(/"[^"]*"/, `"${version}"`);
  return lines.join(detectNewline(text));
}

export function updateJsonVersionField(text, version) {
  const found = lineOfJsonProperty(text, "version");
  if (!found.line) throw new Error("找不到顶层 version 字段");
  const updated = replaceLineValue(
    text,
    found.line,
    /^\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/,
    version,
  );
  return { text: updated, line: found.line };
}

export function updatePackageLockVersion(text, version) {
  const found = packageLockVersionLines(text);
  if (!found.root.line || !found.packagesRoot.line) {
    throw new Error("package-lock.json 缺少根版本或 packages[\"\"].version");
  }
  let updated = replaceLineValue(
    text,
    found.root.line,
    /^\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/,
    version,
  );
  // The first replacement does not change line positions.
  updated = replaceLineValue(
    updated,
    found.packagesRoot.line,
    /^\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/,
    version,
  );
  return { text: updated, lines: [found.root.line, found.packagesRoot.line] };
}

export function updateCargoTomlVersion(text, version) {
  const found = lineOfCargoTomlPackageVersion(text);
  if (!found.line) throw new Error("Cargo.toml 的 [package] 缺少 version");
  return {
    text: replaceLineValue(
      text,
      found.line,
      /^\s*version\s*=\s*"[^"]*"\s*$/,
      version,
    ),
    line: found.line,
  };
}

export function updateCargoLockVersion(text, version, packageName = MAIN_CARGO_PACKAGE) {
  const found = lineOfCargoLockVersion(text, packageName);
  if (!found.line) throw new Error(`Cargo.lock 找不到 ${packageName} 的 version`);
  return {
    text: replaceLineValue(
      text,
      found.line,
      /^\s*version\s*=\s*"[^"]*"\s*$/,
      version,
    ),
    line: found.line,
  };
}

export function readProjectVersions(root) {
  const pkgText = readText(root, "package.json");
  const tauriText = readText(root, "src-tauri/tauri.conf.json");
  const cargoText = readText(root, "src-tauri/Cargo.toml");
  const cargoLockText = readText(root, "src-tauri/Cargo.lock");
  const packageLockText = readText(root, "package-lock.json");
  return {
    packageJson: { file: "package.json", ...lineOfJsonProperty(pkgText, "version") },
    tauriConf: {
      file: "src-tauri/tauri.conf.json",
      ...lineOfJsonProperty(tauriText, "version"),
    },
    cargoToml: {
      file: "src-tauri/Cargo.toml",
      ...lineOfCargoTomlPackageVersion(cargoText),
    },
    cargoLock: {
      file: "src-tauri/Cargo.lock",
      ...lineOfCargoLockVersion(cargoLockText),
    },
    packageLock: {
      file: "package-lock.json",
      ...packageLockVersionLines(packageLockText).root,
    },
    packageLockInner: {
      file: "package-lock.json",
      ...packageLockVersionLines(packageLockText).packagesRoot,
    },
  };
}

export function checkProjectVersions(root) {
  const versions = readProjectVersions(root);
  const packageVersion = versions.packageJson.value;
  const errors = [];
  if (!packageVersion) {
    errors.push({
      file: "package.json",
      line: 1,
      expected: "MAJOR.MINOR.PATCH",
      actual: "<missing>",
      message: "package.json 缺少唯一事实来源 version",
    });
    return { ok: false, expected: null, versions, errors };
  }
  try {
    parseVersion(packageVersion);
  } catch (error) {
    errors.push({
      file: "package.json",
      line: versions.packageJson.line,
      expected: "MAJOR.MINOR.PATCH",
      actual: packageVersion,
      message: error.message,
    });
    return { ok: false, expected: packageVersion, versions, errors };
  }
  const entries = [
    ["tauriConf", "src-tauri/tauri.conf.json"],
    ["cargoToml", "src-tauri/Cargo.toml"],
    ["cargoLock", "src-tauri/Cargo.lock"],
    ["packageLock", "package-lock.json"],
    ["packageLockInner", "package-lock.json"],
  ];
  for (const [key, label] of entries) {
    const item = versions[key];
    if (item.value !== packageVersion) {
      errors.push({
        file: item.file || label,
        line: item.line || 1,
        expected: packageVersion,
        actual: item.value ?? "<missing>",
        message: `${item.file || label}:${item.line || 1} 版本 ${item.value ?? "<missing>"} 与 package.json:${versions.packageJson.line} 的 ${packageVersion} 不一致`,
      });
    }
  }
  const frontendVersion = path.join(root, "src/lib/version.ts");
  const viteConfig = path.join(root, "vite.config.ts");
  if (!existsSync(frontendVersion)) {
    errors.push({
      file: "src/lib/version.ts",
      line: 1,
      expected: "frontend runtime version constants",
      actual: "<missing>",
      message: "缺少前端运行时常量 src/lib/version.ts",
    });
  } else {
    const source = readFileSync(frontendVersion, "utf8");
    if (!source.includes("__APP_VERSION__") || !source.includes("__BUILD_COMMIT__")) {
      errors.push({
        file: "src/lib/version.ts",
        line: 1,
        expected: "__APP_VERSION__ / __BUILD_COMMIT__",
        actual: "<missing injection binding>",
        message: "前端运行时常量未绑定 Vite 注入值",
      });
    }
  }
  if (!existsSync(viteConfig)) {
    errors.push({
      file: "vite.config.ts",
      line: 1,
      expected: "version define",
      actual: "<missing>",
      message: "缺少 Vite 版本注入配置",
    });
  } else {
    const source = readFileSync(viteConfig, "utf8");
    if (!source.includes("__APP_VERSION__") || !source.includes("__BUILD_COMMIT__")) {
      errors.push({
        file: "vite.config.ts",
        line: 1,
        expected: "define __APP_VERSION__ / __BUILD_COMMIT__",
        actual: "<missing>",
        message: "Vite 未注入版本与构建哈希常量",
      });
    }
  }
  return { ok: errors.length === 0, expected: packageVersion, versions, errors };
}

export function syncProjectVersions(root, requestedVersion) {
  const packagePath = path.join(root, "package.json");
  const packageText = readText(root, "package.json");
  const packageVersion = lineOfJsonProperty(packageText, "version").value;
  const target = requestedVersion?.trim() || packageVersion;
  parseVersion(target);
  const change = classifyVersionChange(packageVersion, target);
  if (change.kind === "downgrade" && !process.env.MR_ALLOW_VERSION_DOWNGRADE) {
    throw new Error(
      `${change.message} 如确需降级，请设置 MR_ALLOW_VERSION_DOWNGRADE=1。`,
    );
  }

  const writes = [];
  const writeVersionFile = (rel, reader, updater) => {
    const text = readText(root, rel);
    const result = updater(text, target);
    writeText(root, rel, result.text);
    writes.push({ file: rel, line: result.line ?? result.lines?.[0] ?? reader(text).line, version: target });
  };

  const packageUpdated = updateJsonVersionField(packageText, target);
  writeText(root, "package.json", packageUpdated.text);
  writes.push({ file: "package.json", line: packageUpdated.line, version: target });

  writeVersionFile(
    "package-lock.json",
    (text) => packageLockVersionLines(text).root,
    (text, value) => {
      const result = updatePackageLockVersion(text, value);
      return {
        text: result.text,
        line: result.lines[0],
        lines: result.lines,
      };
    },
  );
  writeVersionFile(
    "src-tauri/tauri.conf.json",
    (text) => lineOfJsonProperty(text, "version"),
    (text, value) => {
      const result = updateJsonVersionField(text, value);
      return { text: result.text, line: result.line };
    },
  );
  writeVersionFile(
    "src-tauri/Cargo.toml",
    lineOfCargoTomlPackageVersion,
    updateCargoTomlVersion,
  );
  writeVersionFile(
    "src-tauri/Cargo.lock",
    lineOfCargoLockVersion,
    updateCargoLockVersion,
  );

  return {
    source: packageVersion,
    version: target,
    change,
    writes,
    checked: checkProjectVersions(root),
  };
}

export function buildCommit(root) {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return "local";
  }
}

export { MAIN_CARGO_PACKAGE as CARGO_PACKAGE };
