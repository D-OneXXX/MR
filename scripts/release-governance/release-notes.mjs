#!/usr/bin/env node
/**
 * 公开 Release Notes 的解析、结构校验与 GITHUB_OUTPUT 渲染。
 *
 * 强制结构（Windows 与 Linux 通道一致，见 .github/RELEASE_NOTES_TEMPLATE.md）：
 *
 *   英文完整版：一句产品介绍 → 3–5 条更新 → 可选「限制 / 兼容」说明 → 下载指引
 *   `## 简体中文`
 *   中文完整版：同样四段、同样的条目数、同样的信息
 *
 * 校验只判定四件事：双语是否齐全、段落顺序、更新条目数、"内部信息是否泄漏到
 * 公开文案"。它不改写正文，也不评价文案质量。
 *
 * 用法：
 *   node scripts/release-governance/release-notes.mjs            # 读 RELEASE_NOTES，校验后写 GITHUB_OUTPUT
 *   node scripts/release-governance/release-notes.mjs --check F  # 只校验文件，失败退出码 1
 *   node scripts/release-governance/release-notes.mjs --template # 打印模板
 *
 * 不写文件（除 GITHUB_OUTPUT）、不联网、不读取或输出任何密钥。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE_PATH = path.join(ROOT, ".github", "RELEASE_NOTES_TEMPLATE.md");

/** Draft 占位文案：只出现在未公开的 Draft 上；发布工作流的结构门禁会拒绝它。 */
export const DEFAULT_RELEASE_BODY = [
  "Release Candidate（**Draft，未公开**）。",
  "审批通过后由 release-publish 工作流校验绑定并发布。",
  "RC 记录（版本 / Commit / 制品 SHA-256 / 平台）见资产 rc-record.json。",
].join("\n");

export const ZH_DIVIDER = "## 简体中文";

/** 允许的 H3 段落名。顺序即强制顺序（Notes 可省略）。 */
export const SECTION_NAMES = {
  en: { updates: "### What's new", notes: "### Notes", download: "### Download" },
  zh: { updates: "### 更新内容", notes: "### 说明", download: "### 下载" },
};

/**
 * 公开文案里不应出现的内部信息。每条都对应"公开说明只讲用户可见变化"这条规则，
 * 而不是为了压缩篇幅。
 */
const INTERNAL_PATTERNS = [
  [/\bqa-full\b/i, "内部 QA 工作流名（qa-full）"],
  [/\b(?:workflow run|run id|actions run)\b/i, "CI run 标识"],
  [/\brun[ :#]*\d{6,}\b/i, "CI run 编号"],
  [/\bDraft\b/, "内部发布状态（Draft）"],
  [/\b[0-9a-f]{40}\b/, "完整 commit SHA"],
  [/\b[0-9a-f]{64}\b/, "完整 SHA-256"],
  [/(?:（|\()\s*[0-9a-f]{7,12}\s*(?:）|\))/i, "短 commit SHA"],
  [/\bP[0-3]\s*=\s*\d/, "内部缺陷分级计数"],
  [/\b\d{2,3}\s*\/\s*\d{2,3}\b/, "测试用例计数"],
  [/(?:^|\s)#\d{2,}\b/, "PR / Issue 编号"],
  [/\b(?:rc-record|install-verification|signature-verification)\.json\b/, "内部证据文件引用"],
  [/\bCSP\b|\b(?:connect|script|style|img|font)-src\b/, "CSP 配置细节"],
  [/\bprovenance\b/i, "构建 provenance 细节"],
  [/\bsha-?256\b/i, "制品哈希清单"],
  [/\bD-OneXXX\/MR\b/, "旧仓库名（应为 D-OneXXX/Moyu）"],
  [/<!--/, "模板注释（发布前必须删除）"],
];

/** 下载段只允许指向本仓库的 Releases：不接受外域、http、或旧仓库名。 */
const RELEASE_URL_PATTERN = /^https:\/\/github\.com\/d-onexxx\/moyu\/releases(?:\/|$)/i;
const ARTIFACT_TOKEN = /`[^`]*\.(?:exe|deb|rpm|appimage)`/i;

/**
 * 校验下载条目：必须给出可识别的安装包文件名，或本仓库 Releases 的 https 链接。
 * 返回错误描述，或 null 表示合格。
 */
export function checkDownloadBullet(text) {
  const urls = String(text).match(/https?:\/\/[^\s)）`]+/gi) || [];
  const badUrl = urls.find((url) => !RELEASE_URL_PATTERN.test(url));
  if (badUrl) {
    return `下载链接必须指向 https://github.com/D-OneXXX/Moyu/releases（发现 ${badUrl}）`;
  }
  if (urls.length === 0 && !ARTIFACT_TOKEN.test(text)) {
    return "下载条目必须给出安装包文件名（如 `MangaReader_0.19.0_x64-setup.exe`）或 releases 链接";
  }
  return null;
}

/** 空输入回落占位文案；否则保留用户提供的多行正文（CRLF/CR 归一为 LF）。 */
export function resolveReleaseBody(notes) {
  const value = String(notes ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return value.length > 0 ? value : DEFAULT_RELEASE_BODY;
}

function normalize(line) {
  return line.replace(/\u2019/g, "'").trim();
}

/** 把正文按 `## 简体中文` 切成英文段与中文段；两段都不做任何改写。 */
export function splitLanguages(body) {
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const divider = lines.findIndex((line) => normalize(line) === ZH_DIVIDER);
  if (divider < 0) {
    return { english: lines, chinese: null, dividerLine: -1 };
  }
  return {
    english: lines.slice(0, divider),
    chinese: lines.slice(divider + 1),
    dividerLine: divider,
  };
}

/** 找出某一语言段里的 H2 / H3 标题及其行号（相对本段）。 */
function collectHeadings(lines) {
  const headings = [];
  lines.forEach((line, index) => {
    const text = normalize(line);
    if (text.startsWith("### ")) headings.push({ level: 3, text, index });
    else if (text.startsWith("## ")) headings.push({ level: 2, text, index });
  });
  return headings;
}

/** 收集列表项：顶层条目计入公开条目数，嵌套条目只用于报错。 */
function collectBullets(lines) {
  const bullets = [];
  for (const line of lines) {
    if (/^[-*]\s+/.test(line)) {
      bullets.push({ text: line.replace(/^[-*]\s+/, "").trim(), nested: false });
    } else if (/^\s+[-*]\s+/.test(line)) {
      bullets.push({ text: line.trim(), nested: true });
    }
  }
  return bullets;
}

function sectionBody(lines, headings, name, label, errors) {
  const found = headings.filter((heading) => heading.text === normalize(name));
  if (found.length === 0) return null;
  if (found.length > 1) errors.push(`${label}：段落「${name}」出现了 ${found.length} 次，只允许一次`);
  const heading = found[0];
  const next = headings.find((item) => item.index > heading.index);
  const end = next ? next.index : lines.length;
  return lines.slice(heading.index + 1, end);
}

function checkSection({ lines, headings, names, label, errors, warnings, platforms }) {
  const updates = sectionBody(lines, headings, names.updates, label, errors);
  const notes = sectionBody(lines, headings, names.notes, label, errors);
  const download = sectionBody(lines, headings, names.download, label, errors);

  if (!updates) errors.push(`${label}：缺少更新段落「${names.updates}」`);
  if (!download) errors.push(`${label}：缺少下载段落「${names.download}」`);

  // 顺序：引言 → 更新 → 说明 → 下载
  const indexOf = (name) => headings.find((heading) => heading.text === normalize(name))?.index ?? -1;
  const updatesAt = indexOf(names.updates);
  const notesAt = indexOf(names.notes);
  const downloadAt = indexOf(names.download);
  if (updatesAt >= 0 && downloadAt >= 0 && downloadAt < updatesAt) {
    errors.push(`${label}：「${names.download}」必须位于「${names.updates}」之后`);
  }
  if (notesAt >= 0 && updatesAt >= 0 && notesAt < updatesAt) {
    errors.push(`${label}：「${names.notes}」必须位于「${names.updates}」之后`);
  }
  if (notesAt >= 0 && downloadAt >= 0 && notesAt > downloadAt) {
    errors.push(`${label}：「${names.notes}」必须位于「${names.download}」之前`);
  }

  // 禁止段落内出现 H2（发布标题由 Release name 承担，正文只放结构与内容）
  const strayH2 = headings.filter((heading) => heading.level === 2);
  if (strayH2.length > 0) {
    errors.push(`${label}：正文不得使用二级标题（发现「${strayH2[0].text}」）`);
  }

  // 引言：更新段之前必须恰好一段产品介绍（允许 Markdown 源码硬折行）
  const introEnd = updatesAt >= 0 ? updatesAt : lines.length;
  const introParagraphs = [];
  let current = [];
  for (const line of lines.slice(0, introEnd)) {
    const text = normalize(line);
    if (text.length > 0) {
      current.push(text);
    } else if (current.length > 0) {
      introParagraphs.push(current);
      current = [];
    }
  }
  if (current.length > 0) introParagraphs.push(current);
  const intro = introParagraphs.flat();
  if (introParagraphs.length !== 1) {
    errors.push(`${label}：更新段之前必须恰好一段产品介绍（当前 ${introParagraphs.length} 段）`);
  } else if (/^#{1,6}\s/.test(intro[0]) || /^[-*]\s/.test(intro[0])) {
    errors.push(`${label}：产品介绍不能是标题或列表项`);
  }

  // 更新条目：3–5 条，不接受空条目或嵌套条目
  let bulletCount = 0;
  if (updates) {
    const bullets = collectBullets(updates);
    const topLevel = bullets.filter((item) => !item.nested);
    bulletCount = topLevel.length;
    if (bullets.some((item) => item.nested)) {
      errors.push(`${label}：更新段不得使用嵌套列表，每条更新只用一行说清`);
    }
    if (topLevel.some((item) => item.text.length === 0)) {
      errors.push(`${label}：更新条目内容不得为空`);
    }
    if (bulletCount < 3 || bulletCount > 5) {
      errors.push(`${label}：更新段必须为 3–5 条，当前 ${bulletCount} 条`);
    }
  }

  if (notes) {
    const noteBullets = collectBullets(notes);
    if (noteBullets.length === 0) {
      errors.push(`${label}：「${names.notes}」写出来了就必须至少有一条内容，否则整段删除`);
    }
    if (noteBullets.length > 3) {
      warnings.push(`${label}：限制/兼容说明有 ${noteBullets.length} 条，建议压到 3 条以内`);
    }
  }

  if (download) {
    const links = collectBullets(download);
    if (links.length === 0) {
      errors.push(`${label}：下载段必须至少给出一条安装包或下载入口`);
    }
    for (const item of links) {
      const problem = checkDownloadBullet(item.text);
      if (problem) errors.push(`${label}：${problem}`);
    }
    if (links.length > 4) {
      warnings.push(`${label}：下载段有 ${links.length} 条，建议按平台合并`);
    }
    const text = download.join("\n").toLowerCase();
    for (const platform of platforms) {
      if (!text.includes(platform)) {
        errors.push(`${label}：下载段缺少 ${platform} 的下载或安装说明`);
      }
    }
  }

  // 只允许既定段落名，防止结构漂移
  const allowed = new Set(Object.values(names).map((name) => normalize(name)));
  for (const heading of headings) {
    if (heading.level === 3 && !allowed.has(heading.text)) {
      errors.push(`${label}：出现未定义的段落「${heading.text}」，只允许 ${[...allowed].join(" / ")}`);
    }
  }

  return bulletCount;
}

/**
 * 校验公开 Release Notes。
 *
 * @param {string} body 完整正文
 * @param {{platforms?: string[]}} [options] 必须出现在下载段的平台关键字
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
/** 模板里「可直接复制」示例的定界标记。 */
export const EXAMPLE_START = "<!-- mr:example:start -->";
export const EXAMPLE_END = "<!-- mr:example:end -->";

/**
 * 去掉正文**开头**的 HTML 注释块（模板使用说明）。
 * 结构分析不能把它当成若干段引言；但注释本身仍是"发布前必须删除"的内部信息。
 */
export function stripLeadingComment(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("<!--");
  if (start < 0 || raw.slice(0, start).trim().length > 0) return raw;
  const end = raw.indexOf("-->", start);
  if (end < 0) return raw;
  return raw.slice(0, start) + raw.slice(end + 3);
}

/** 取出模板里标记为「可直接复制」的示例正文；没有标记时返回 null。 */
export function extractCopyReadyExample(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf(EXAMPLE_START);
  const end = raw.indexOf(EXAMPLE_END);
  if (start < 0 || end < 0 || end < start) return null;
  return raw.slice(start + EXAMPLE_START.length, end);
}

export function validateReleaseNotes(body, { platforms = ["windows", "linux"] } = {}) {
  const errors = [];
  const warnings = [];
  const raw = String(body ?? "").replace(/\r\n?/g, "\n");
  // 结构分析用去掉开头注释后的正文；注释本身仍按内部信息规则报错。
  const text = stripLeadingComment(raw).trim();
  if (raw !== text && raw.includes("<!--")) {
    errors.push("包含模板注释（发布前必须删除）");
  }

  if (text.length === 0) {
    return { ok: false, errors: ["Release Notes 为空"], warnings };
  }

  const { english, chinese, dividerLine } = splitLanguages(text);
  if (dividerLine < 0) {
    errors.push(`缺少中文段分隔标题「${ZH_DIVIDER}」：必须先给完整英文版，再给完整中文版`);
  }

  const englishHeadings = collectHeadings(english);
  const englishBullets = checkSection({
    lines: english,
    headings: englishHeadings,
    names: SECTION_NAMES.en,
    label: "英文段",
    errors,
    warnings,
    platforms,
  });

  let chineseBullets = null;
  if (chinese) {
    const chineseHeadings = collectHeadings(chinese);
    chineseBullets = checkSection({
      lines: chinese,
      headings: chineseHeadings,
      names: SECTION_NAMES.zh,
      label: "中文段",
      errors,
      warnings,
      platforms,
    });
  }

  if (chinese && englishBullets > 0 && chineseBullets !== null && chineseBullets !== englishBullets) {
    errors.push(
      `中英条目数不一致：英文 ${englishBullets} 条，中文 ${chineseBullets} 条；两个版本必须传达同样的更新`,
    );
  }

  // 内部信息泄漏：逐行定位，便于直接改稿
  text.split("\n").forEach((line, index) => {
    for (const [pattern, reason] of INTERNAL_PATTERNS) {
      if (pattern.test(line)) {
        errors.push(`第 ${index + 1} 行出现${reason}，公开说明不得包含内部工程细节`);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** 校验失败时抛出带全部条目的错误，供工作流直接打印。 */
export function assertReleaseNotes(body, options) {
  const result = validateReleaseNotes(body, options);
  if (!result.ok) {
    throw new Error(`Release Notes 结构不合格：\n- ${result.errors.join("\n- ")}`);
  }
  return result;
}

/**
 * 更新器清单（latest.json）的 `notes` 会原样显示在应用的更新弹窗里，
 * 而它由 tauri-action 从候选阶段的 releaseBody 写入。候选阶段留空、
 * 之后手工补写 Draft 正文时，清单里的占位文案不会被追平——所以发布前
 * 必须单独校验清单里的那份正文。
 *
 * @param {object} manifest
 * @param {{mode?: "full"|"summary", expectedBody?: string}} [options]
 *   full：与应用内正文同构的完整双语说明（Windows 通道）；
 *   summary：单行双语摘要（Linux 高危通道的 notes 只有一句话）；
 *   expectedBody：给出时要求 notes 与该正文一致，防止"正文改了、弹窗没改"。
 */
/**
 * 正文/清单的归一化：CRLF→LF + 整串 trim。
 * 逐行内容与行内、行间空白一律保留（Markdown 的行尾两空格是硬换行）。
 * 例外：整串 trim 会去掉首行的行前空白与末行的行尾空白——首行缩进会变成代码块，
 * 末行硬换行无渲染语义，两处不参与一致性判断。
 */
export function normalizeBodyText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

/** 比较清单 notes 与正文；归一化规则见 normalizeBodyText。 */
export function compareManifestBody(notes, body) {
  const equal = normalizeBodyText(notes) === normalizeBodyText(body);
  return {
    equal,
    message: equal
      ? ""
      : "更新器清单的 notes 与已审批的 Release 正文不一致；用户弹窗会看到另一份文案",
  };
}

export function validateManifestNotes(manifest, { mode = "full", expectedBody } = {}) {
  const notes = typeof manifest?.notes === "string" ? manifest.notes : "";
  if (notes.trim().length === 0) {
    return { ok: false, errors: ["更新器清单缺少 notes，用户将看不到任何更新说明"], warnings: [] };
  }

  if (mode === "summary") {
    const errors = [];
    const text = notes.replace(/\r\n?/g, "\n").trim();
    if (text.includes("\n")) errors.push("摘要型 notes 必须是单行");
    if (text.length > 240) errors.push(`摘要型 notes 过长（${text.length} 字符，上限 240）`);
    // 只出现 "Linux"、版本号这类单词不算英文摘要：要求至少三个连续英文词。
    if (!/[A-Za-z][A-Za-z'’,.-]*(?:\s+[A-Za-z][A-Za-z'’,.-]*){2,}/.test(text)) {
      errors.push("摘要型 notes 缺少英文内容（至少三个连续英文词）");
    }
    if (!/[\u4e00-\u9fff]/.test(text)) errors.push("摘要型 notes 缺少简体中文内容");
    if (/^#{1,6}\s/m.test(text)) errors.push("摘要型 notes 不得使用 Markdown 标题");
    for (const [pattern, reason] of INTERNAL_PATTERNS) {
      if (pattern.test(text)) errors.push(`摘要型 notes 出现${reason}`);
    }
    return { ok: errors.length === 0, errors, warnings: [] };
  }

  const result = validateReleaseNotes(notes);
  if (expectedBody !== undefined) {
    const comparison = compareManifestBody(notes, expectedBody);
    if (!comparison.equal) {
      result.errors.push(comparison.message);
      result.ok = false;
    }
  }
  return result;
}

/**
 * 渲染成 GITHUB_OUTPUT 的多行 step output。分隔符随机生成并确认正文里
 * 不存在，避免用户说明恰好包含分隔符时截断输出。
 */
export function renderGithubOutput(body, key = "body") {
  let delimiter = `MR_RELEASE_BODY_${crypto.randomBytes(8).toString("hex")}`;
  while (String(body).includes(delimiter)) {
    delimiter = `MR_RELEASE_BODY_${crypto.randomBytes(8).toString("hex")}`;
  }
  return `${key}<<${delimiter}\n${String(body)}\n${delimiter}\n`;
}

/** 写 step output（GITHUB_OUTPUT 不存在时退回 stdout）。 */
export function writeBody(body, { outputPath = process.env.GITHUB_OUTPUT } = {}) {
  const rendered = renderGithubOutput(body);
  if (outputPath) {
    try {
      fs.appendFileSync(outputPath, rendered, "utf8");
    } catch (error) {
      // 写入失败属于 IO/用法错误，不该抛 Node 堆栈。
      throw new UsageError(`无法写入 GITHUB_OUTPUT ${outputPath}：${error.code ?? error.message}`);
    }
  } else {
    process.stdout.write(rendered);
  }
  return body;
}

/** 追加到 GITHUB_OUTPUT；没有该文件（本地调试）时退回 stdout。 */
export function writeReleaseBody(notes, options = {}) {
  return writeBody(resolveReleaseBody(notes), options);
}

/** 模板正文（单一事实源是仓库里的模板文件）。 */
export function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, "utf8");
}

function printErrors(errors, warnings) {
  for (const warning of warnings) console.warn(`[release-notes] 提示：${warning}`);
  for (const error of errors) console.error(`[release-notes] 不合格：${error}`);
}

const USAGE = [
  "用法：",
  "  node scripts/release-governance/release-notes.mjs                  # 读 RELEASE_NOTES，校验后写 GITHUB_OUTPUT",
  "  node … --check <notes.md>                                          # 只校验正文结构",
  "  node … --check-manifest <latest.json> [--mode full|summary] \\",
  "            [--require-match <notes.md>] [--warn-only]              # 校验清单 notes",
  "  node … --template                                                  # 打印模板",
  "",
  "退出码：0 通过 / 1 内容不合格 / 2 用法或 IO 错误",
].join("\n");

class UsageError extends Error {}

function readTextFile(file, label) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`无法读取${label} ${file}：${error.code ?? error.message}`);
  }
}

/** 先解析并校验全部参数，再决定分支；任何非法组合都在这里失败（退出码 2）。 */
export function parseArgs(argv) {
  const opts = {
    template: false,
    check: null,
    checkTemplate: null,
    manifest: null,
    mode: "full",
    modeGiven: false,
    requireMatch: null,
    warnOnly: false,
  };
  const seen = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new UsageError(`参数 ${flag} 重复出现`);
    seen.add(flag);
    const valueOf = (name) => {
      const next = argv[index + 1];
      // 以 -- 开头的下一项是另一个 flag，不能当作取值（旧实现会把 flag 当文件名）。
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${name} 需要一个值`);
      }
      // 空串是"没给值"，不能当成"给了空值"：否则该检查会被静默跳过。
      if (next.length === 0) {
        throw new UsageError(`${name} 需要一个非空路径`);
      }
      index += 1;
      return next;
    };

    if (flag === "--template") opts.template = true;
    else if (flag === "--check") opts.check = valueOf("--check");
    else if (flag === "--check-template") opts.checkTemplate = valueOf("--check-template");
    else if (flag === "--check-manifest") opts.manifest = valueOf("--check-manifest");
    else if (flag === "--require-match") opts.requireMatch = valueOf("--require-match");
    else if (flag === "--mode") {
      opts.mode = valueOf("--mode");
      opts.modeGiven = true;
    } else if (flag === "--warn-only") opts.warnOnly = true;
    else throw new UsageError(`未知参数 ${flag}`);
  }

  if (!["full", "summary"].includes(opts.mode)) {
    throw new UsageError(`--mode 只接受 full / summary（收到 ${opts.mode}）`);
  }
  if (opts.template && (opts.check !== null || opts.checkTemplate !== null || opts.manifest !== null || opts.requireMatch !== null || opts.modeGiven || opts.warnOnly)) {
    throw new UsageError("--template 不能与其它参数同时使用");
  }
  if (opts.check !== null && (opts.manifest !== null || opts.checkTemplate !== null)) {
    throw new UsageError("--check 与 --check-manifest / --check-template 互斥，请分多次调用");
  }
  if (opts.checkTemplate !== null && opts.manifest !== null) {
    throw new UsageError("--check 与 --check-manifest 互斥，请分两次调用");
  }
  if (opts.modeGiven && opts.manifest === null) {
    throw new UsageError("--mode 只能与 --check-manifest 一起使用");
  }
  if (opts.requireMatch !== null && opts.manifest === null) {
    throw new UsageError("--require-match 只能与 --check-manifest 一起使用（--check 校验的是正文本身）");
  }
  if (opts.manifest !== null && opts.mode === "summary" && opts.requireMatch !== null) {
    throw new UsageError("--require-match 不适用于 --mode summary：摘要不是完整正文，无法比对");
  }
  if (opts.warnOnly && opts.requireMatch === null) {
    throw new UsageError("--warn-only 只能与 --require-match 一起使用");
  }
  return opts;
}

function main(argv) {
  try {
    return run(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[release-notes] ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }
}

function run(argv) {
  const opts = parseArgs(argv.slice(2));

  if (opts.template) {
    process.stdout.write(loadTemplate());
    return 0;
  }

  if (opts.checkTemplate !== null) {
    const raw = readTextFile(opts.checkTemplate, "模板文件");
    const example = extractCopyReadyExample(raw);
    if (example === null) {
      throw new UsageError(
        `${opts.checkTemplate} 里没有找到可直接复制的示例（需要 ${EXAMPLE_START} 与 ${EXAMPLE_END} 标记）`,
      );
    }
    const result = validateReleaseNotes(example);
    printErrors(result.errors, result.warnings);
    if (!result.ok) {
      console.error("[release-notes] 模板里的可复制示例不合格，请按上面的提示修正");
      return 1;
    }
    console.log("[release-notes] 模板示例校验通过");
    return 0;
  }

  if (opts.check !== null) {
    const result = validateReleaseNotes(readTextFile(opts.check, "Release Notes 文件"));
    printErrors(result.errors, result.warnings);
    if (!result.ok) {
      console.error("[release-notes] 公开说明结构不合格，已失败关闭。模板见 .github/RELEASE_NOTES_TEMPLATE.md");
      return 1;
    }
    console.log("[release-notes] 结构校验通过");
    return 0;
  }

  if (opts.manifest !== null) {
    let manifest;
    try {
      manifest = JSON.parse(readTextFile(opts.manifest, "更新器清单"));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      console.error(`[release-notes] 无法解析清单 ${opts.manifest}：${error.message}`);
      return 1;
    }

    const result = validateManifestNotes(manifest, { mode: opts.mode });
    printErrors(result.errors, result.warnings);
    if (!result.ok) {
      console.error("[release-notes] 更新器清单 notes 不合格，已失败关闭");
      return 1;
    }

    if (opts.requireMatch !== null) {
      const expected = readTextFile(opts.requireMatch, "期望正文");
      if (expected.trim().length === 0) {
        throw new UsageError("--require-match 指向的正文为空，无法比对");
      }
      const comparison = compareManifestBody(manifest.notes, expected);
      if (!comparison.equal) {
        const message = comparison.message;
        if (opts.warnOnly) {
          console.warn(`::warning::${message}`);
        } else {
          console.error(`[release-notes] ${message}`);
          return 1;
        }
      } else {
        console.log("[release-notes] 清单 notes 与正文一致");
      }
    }

    console.log("[release-notes] 更新器清单 notes 校验通过");
    return 0;
  }

  const raw = process.env.RELEASE_NOTES ?? "";
  if (String(raw).trim().length === 0) {
    // 清单 notes 在候选阶段就被固化，事后只改 Draft 正文无法追平；
    // 因此普通候选必须在这里失败，只有隔离演练允许占位。
    if (String(process.env.ALLOW_PLACEHOLDER ?? "").toLowerCase() !== "true") {
      console.error(
        "[release-notes] RELEASE_NOTES 为空：候选阶段必须提供双语说明（仅隔离演练可设 ALLOW_PLACEHOLDER=true）。模板见 .github/RELEASE_NOTES_TEMPLATE.md",
      );
      return 2;
    }
    console.warn("::warning::演练模式：release_notes 为空，使用占位正文；该正文不可公开发布");
    writeBody(DEFAULT_RELEASE_BODY);
    console.log("[release-notes] 已写入演练占位 releaseBody");
    return 0;
  }

  const body = resolveReleaseBody(raw);
  const result = validateReleaseNotes(body);
  printErrors(result.errors, result.warnings);
  if (!result.ok) {
    console.error("[release-notes] 公开说明结构不合格，已失败关闭。模板见 .github/RELEASE_NOTES_TEMPLATE.md");
    return 1;
  }

  writeBody(body);
  console.log(`[release-notes] 已写入 releaseBody（${body.split("\n").length} 行）`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exitCode = main(process.argv);
}
