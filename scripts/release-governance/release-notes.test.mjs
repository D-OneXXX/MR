import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inputBlock, parseSteps, workflow } from "./contract-helpers.mjs";
import {
  DEFAULT_RELEASE_BODY,
  EXAMPLE_END,
  EXAMPLE_START,
  extractCopyReadyExample,
  stripLeadingComment,
  loadTemplate,
  renderGithubOutput,
  resolveReleaseBody,
  splitLanguages,
  validateManifestNotes,
  validateReleaseNotes,
  writeReleaseBody,
} from "./release-notes.mjs";

/** 解析单条多行 GITHUB_OUTPUT，验证分隔符格式可被 Actions 还原。 */
function parseBodyOutput(text) {
  const lines = text.split("\n");
  assert.match(lines[0], /^body<<.+$/);
  const delimiter = lines[0].slice("body<<".length);
  const end = lines.lastIndexOf(delimiter);
  assert.ok(end > 0, "缺少结束分隔符");
  return lines.slice(1, end).join("\n");
}

const EN_INTRO = "Moyu is a free, local-first manga reader for Windows and Linux.";
const ZH_INTRO = "Moyu 是一款免费的本地优先漫画阅读器，支持 Windows 与 Linux。";

/** 按模板拼一份正文；默认英文三条、中文三条、两段都带说明与双平台下载。 */
function buildNotes({
  en = ["Reads local PDF files.", "Remembers your page.", "Ships six languages."],
  zh = ["支持本地 PDF。", "记住阅读页码。", "提供六种语言。"],
  enNotes = ["Encrypted PDFs are not supported."],
  zhNotes = ["不支持加密 PDF。"],
  enDownload = ["Windows: `MangaReader_x64-setup.exe`", "Linux: `.deb`, `.rpm`, `.AppImage`"],
  zhDownload = ["Windows：`MangaReader_x64-setup.exe`", "Linux：`.deb`、`.rpm`、`.AppImage`"],
  withNotes = true,
  withZh = true,
} = {}) {
  const lines = [EN_INTRO, "", "### What's new", ...en.map((item) => `- ${item}`), ""];
  if (withNotes && enNotes.length > 0) {
    lines.push("### Notes", ...enNotes.map((item) => `- ${item}`), "");
  }
  lines.push("### Download", ...enDownload.map((item) => `- ${item}`));
  if (withZh) {
    lines.push("", "## 简体中文", "", ZH_INTRO, "", "### 更新内容", ...zh.map((item) => `- ${item}`), "");
    if (withNotes && zhNotes.length > 0) {
      lines.push("### 说明", ...zhNotes.map((item) => `- ${item}`), "");
    }
    lines.push("### 下载", ...zhDownload.map((item) => `- ${item}`));
  }
  return lines.join("\n");
}

function errorsOf(body) {
  return validateReleaseNotes(body).errors.join("\n");
}

test("release-notes：空输入 / 纯空白回落占位文案", () => {
  for (const value of [undefined, "", "   ", "\r\n\t "]) {
    assert.equal(resolveReleaseBody(value), DEFAULT_RELEASE_BODY);
  }
  assert.match(DEFAULT_RELEASE_BODY, /Draft/);
  assert.match(DEFAULT_RELEASE_BODY, /rc-record\.json/);
});

test("release-notes：多行输入原样保留（不经过 YAML 块标量）", () => {
  const notes = "## Moyu 0.18.0\n\n- PDF 阅读\n- 数据库自检\n\n> 升级前请备份";
  assert.equal(resolveReleaseBody(notes), notes);
  const rendered = renderGithubOutput(notes);
  assert.equal(parseBodyOutput(rendered), notes);
});

test("release-notes：CRLF 归一为 LF，特殊字符不被解释", () => {
  const notes = "第一行\r\n第二行 ${{ secrets.TOKEN }} %PATH% \"quoted\" `tick`";
  const expected = "第一行\n第二行 ${{ secrets.TOKEN }} %PATH% \"quoted\" `tick`";
  assert.equal(resolveReleaseBody(notes), expected);
  assert.equal(parseBodyOutput(renderGithubOutput(resolveReleaseBody(notes))), expected);
});

test("release-notes：writeReleaseBody 追加到 GITHUB_OUTPUT 并可还原", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-release-notes-"));
  const output = path.join(dir, "github_output");
  const notes = "line-1\nline-2\nline-3";
  const body = writeReleaseBody(notes, { outputPath: output });
  assert.equal(body, notes);
  const text = fs.readFileSync(output, "utf8");
  assert.equal(parseBodyOutput(text), notes);
  // 追加而不是覆盖：第二次写入后两条 output 都在。
  writeReleaseBody("second", { outputPath: output });
  const appended = fs.readFileSync(output, "utf8");
  assert.ok(appended.includes("second"));
  assert.equal((appended.match(/^body<</gm) || []).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("release-notes：合规双语正文通过校验", () => {
  const result = validateReleaseNotes(buildNotes());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test("release-notes：Draft 占位正文永远过不了发布门禁", () => {
  const result = validateReleaseNotes(DEFAULT_RELEASE_BODY);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /中文段分隔标题/);
});

test("release-notes：缺少中文段必须先给完整英文版再给完整中文版", () => {
  const errors = errorsOf(buildNotes({ withZh: false }));
  assert.match(errors, /缺少中文段分隔标题「## 简体中文」/);
});

test("release-notes：splitLanguages 以分隔标题切分且不丢内容", () => {
  const body = buildNotes();
  const { english, chinese, dividerLine } = splitLanguages(body);
  assert.ok(dividerLine > 0);
  assert.ok(english.join("\n").includes(EN_INTRO));
  assert.ok(!english.join("\n").includes(ZH_INTRO));
  assert.ok(chinese.join("\n").includes(ZH_INTRO));
});

test("release-notes：更新段必须是 3–5 条", () => {
  for (const count of [3, 4, 5]) {
    const bullets = Array.from({ length: count }, (_, index) => `Change ${index + 1}.`);
    const result = validateReleaseNotes(buildNotes({ en: bullets, zh: bullets }));
    assert.equal(result.ok, true, `${count} 条应当通过：${result.errors.join("; ")}`);
  }
  for (const count of [2, 6]) {
    const bullets = Array.from({ length: count }, (_, index) => `Change ${index + 1}.`);
    const errors = errorsOf(buildNotes({ en: bullets, zh: bullets }));
    assert.match(errors, new RegExp(`更新段必须为 3–5 条，当前 ${count} 条`), `${count} 条必须被拒绝`);
  }
});

test("release-notes：中英条目数必须一致", () => {
  const body = buildNotes({
    en: ["One.", "Two.", "Three."],
    zh: ["一。", "二。"],
  });
  assert.match(errorsOf(body), /中英条目数不一致：英文 3 条，中文 2 条/);
});

test("release-notes：段落顺序固定为 更新 → 说明 → 下载", () => {
  const body = buildNotes()
    .replace("### What's new", "@@UPDATES@@")
    .replace("### Download", "### What's new")
    .replace("@@UPDATES@@", "### Download");
  const errors = errorsOf(body);
  assert.match(errors, /「### Download」必须位于「### What's new」之后/);
});

test("release-notes：缺少下载段无法发布", () => {
  const body = buildNotes()
    .replace(/\n### Download\n[\s\S]*?\n\n## 简体中文/, "\n\n## 简体中文")
    .replace(/\n### 下载\n[\s\S]*$/, "");
  assert.match(errorsOf(body), /缺少下载段落|下载段必须至少给出一条/);
});

test("release-notes：下载段必须同时交代 Windows 与 Linux", () => {
  const body = buildNotes({
    enDownload: ["Windows: `MangaReader_x64-setup.exe`"],
    zhDownload: ["Windows：`MangaReader_x64-setup.exe`"],
  });
  const errors = errorsOf(body);
  assert.match(errors, /下载段缺少 linux 的下载或安装说明/);
});

test("release-notes：产品介绍必须恰好一段且不能是标题或列表", () => {
  const body = buildNotes().replace(EN_INTRO, "# Moyu 0.19.0\n\nMoyu is a reader.");
  assert.match(errorsOf(body), /正文不得使用二级标题|恰好一段产品介绍/);
});

test("release-notes：引言允许 Markdown 源码硬折行", () => {
  const wrapped = `${EN_INTRO}\nIt keeps the library on your disk.`;
  const result = validateReleaseNotes(buildNotes().replace(EN_INTRO, wrapped));
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("release-notes：内部工程细节不得进入公开说明", () => {
  const cases = [
    ["QA: `qa-full` 通过", /qa-full/],
    ["CI: run 40613349127", /CI run 编号/],
    ["Closes #123", /PR \/ Issue 编号/],
    ["Commit 0123456789abcdef0123456789abcdef01234567", /完整 commit SHA/],
    ["Artifact 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", /完整 SHA-256/],
    ["见 rc-record.json", /内部证据文件引用/],
    ["CSP 收紧 connect-src", /CSP 配置细节/],
    ["Still a Draft", /内部发布状态/],
    ["Diff: https://github.com/D-OneXXX/MR/compare/v1...v2", /旧仓库名/],
    ["<!-- 模板注释 -->", /模板注释/],
  ];
  for (const [line, expected] of cases) {
    const body = buildNotes({ en: ["One.", "Two.", line], zh: ["一。", "二。", "三。"] });
    const errors = errorsOf(body);
    assert.match(errors, expected, `未能拦截：${line}`);
  }
});

test("release-notes：模板结构完整但不可直接发布", () => {
  const template = loadTemplate();
  assert.ok(template.includes("## 简体中文"));
  for (const heading of ["### What's new", "### Notes", "### Download", "### 更新内容", "### 说明", "### 下载"]) {
    assert.ok(template.includes(heading), `模板缺少段落：${heading}`);
  }
  const result = validateReleaseNotes(template);
  assert.equal(result.ok, false, "未填写的模板必须被拒绝");
  assert.match(result.errors.join("\n"), /更新段必须为 3–5 条|模板注释/);
});

test("release-notes：更新器清单 notes 会显示在更新弹窗，必须同样合规", () => {
  assert.equal(validateManifestNotes({ version: "0.19.0", notes: buildNotes() }).ok, true);

  const placeholder = validateManifestNotes({ notes: DEFAULT_RELEASE_BODY });
  assert.equal(placeholder.ok, false, "占位文案不得进入用户更新弹窗");

  const missing = validateManifestNotes({ version: "0.19.0" });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /缺少 notes/);
});

test("release-notes：只有中文版（缺英文完整版）必须被拒绝", () => {
  const zhOnly = [
    "## 简体中文",
    "",
    ZH_INTRO,
    "",
    "### 更新内容",
    "- 一。",
    "- 二。",
    "- 三。",
    "",
    "### 下载",
    "- Windows：`MangaReader_x64-setup.exe`",
    "- Linux：`.deb`、`.rpm`、`.AppImage`",
  ].join("\n");
  const errors = errorsOf(zhOnly);
  assert.match(errors, /缺少更新段落「### What's new」/);
  assert.match(errors, /产品介绍|恰好一段/);
});

test("release-notes：下载段只接受本仓库 Releases 链接或可识别安装包", () => {
  const bad = [
    ["- Windows: https://example.com/MangaReader_x64-setup.exe", /必须指向 https:\/\/github\.com\/D-OneXXX\/Moyu\/releases/],
    ["- Windows: http://github.com/D-OneXXX/Moyu/releases", /必须指向 https:\/\/github.com\/D-OneXXX\/Moyu\/releases/],
    ["- Windows: 直接下载即可", /必须给出安装包文件名/],
  ];
  for (const [line, expected] of bad) {
    const body = buildNotes({
      enDownload: [line, "Linux: `.deb`, `.rpm`, `.AppImage`"],
      zhDownload: ["Windows：`MangaReader_x64-setup.exe`", "Linux：`.deb`、`.rpm`、`.AppImage`"],
    });
    assert.match(errorsOf(body), expected, `未能拦截：${line}`);
  }

  // releases 页面链接是允许的（用户点进去自己选包）。
  const ok = validateReleaseNotes(
    buildNotes({
      enDownload: ["Windows and Linux: https://github.com/D-OneXXX/Moyu/releases"],
      zhDownload: ["Windows 与 Linux：https://github.com/D-OneXXX/Moyu/releases"],
    }),
  );
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

test("release-notes：清单 notes 与已审批正文不一致会被拒绝", () => {
  const body = buildNotes();
  assert.equal(validateManifestNotes({ notes: body }, { expectedBody: body }).ok, true);

  const drifted = validateManifestNotes(
    { notes: body.replace("Reads local PDF files.", "Reads PDFs.") },
    { expectedBody: body },
  );
  assert.equal(drifted.ok, false);
  assert.match(drifted.errors.join("\n"), /与已审批的 Release 正文不一致/);
});

test("release-notes：Linux 摘要型 notes 必须是单行双语且不含内部信息", () => {
  const good =
    "Security and crash fixes for the Linux long-term channel (v0.19.0-linux-sec1) / Linux 长期稳定分支高危安全/崩溃修复补丁（v0.19.0-linux-sec1）。";
  assert.equal(validateManifestNotes({ notes: good }, { mode: "summary" }).ok, true);

  const chineseOnly = validateManifestNotes(
    { notes: "Linux 长期稳定分支高危安全/崩溃修复补丁（v0.19.0-linux-sec1）。" },
    { mode: "summary" },
  );
  assert.equal(chineseOnly.ok, false);
  assert.match(chineseOnly.errors.join("\n"), /缺少英文内容/);

  const multiline = validateManifestNotes({ notes: `${good}\n\n- extra` }, { mode: "summary" });
  assert.equal(multiline.ok, false);
  assert.match(multiline.errors.join("\n"), /必须是单行/);

  const leaked = validateManifestNotes(
    { notes: `${good} qa-full run 40613349127` },
    { mode: "summary" },
  );
  assert.equal(leaked.ok, false);
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-notes.mjs");

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-notes-cli-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeNotes(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

test("CLI：--require-match 缺值必须给可读错误，而不是堆栈", () => {
  withTmp((dir) => {
    const manifest = writeNotes(dir, "m.json", JSON.stringify({ notes: buildNotes() }));
    const result = cli(["--check-manifest", manifest, "--require-match"]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /需要一个值/);
    assert.doesNotMatch(result.stderr, /node:internal|ERR_INVALID_ARG_TYPE|\n\s+at /);
  });
});

test("CLI：--check 下给 --require-match 必须报错而不是静默忽略", () => {
  withTmp((dir) => {
    const body = writeNotes(dir, "body.md", buildNotes());
    const result = cli(["--check", body, "--require-match", body]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /只能与 --check-manifest/);
    assert.doesNotMatch(result.stdout, /结构校验通过/);
  });
});

test("CLI：summary 模式下给 --require-match 必须报错", () => {
  withTmp((dir) => {
    const manifest = writeNotes(
      dir,
      "m.json",
      JSON.stringify({ notes: "Security and crash fixes for the Linux channel / Linux 长期稳定分支补丁。" }),
    );
    const body = writeNotes(dir, "body.md", buildNotes());
    const result = cli(["--check-manifest", manifest, "--mode", "summary", "--require-match", body]);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /不适用于 --mode summary/);
  });
});

test("CLI：互斥与非法参数组合一律退出 2", () => {
  withTmp((dir) => {
    const body = writeNotes(dir, "body.md", buildNotes());
    const manifest = writeNotes(dir, "m.json", JSON.stringify({ notes: buildNotes() }));

    const cases = [
      [["--check", body, "--check-manifest", manifest], /互斥/],
      [["--template", "--check", body], /不能与其它参数/],
      [["--check-manifest", manifest, "--mode"], /需要一个值/],
      [["--check-manifest", manifest, "--mode", "bogus"], /只接受 full \/ summary/],
      [["--check", body, "--mode", "full"], /只能与 --check-manifest/],
      [["--check", body, "--check", body], /重复出现/],
      [["--bogus"], /未知参数/],
    ];
    for (const [args, expected] of cases) {
      const result = cli(args);
      assert.equal(result.status, 2, `${args.join(" ")} → ${result.status}\n${result.stderr}`);
      assert.match(result.stderr, expected, args.join(" "));
      assert.doesNotMatch(result.stderr, /node:internal|\n\s+at /, args.join(" "));
    }
  });
});

test("CLI：文件缺失退出 2 且无堆栈；JSON 损坏仍算内容错误（1）", () => {
  withTmp((dir) => {
    const missing = cli(["--check", path.join(dir, "nope.md")]);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /无法读取/);
    assert.doesNotMatch(missing.stderr, /node:internal|\n\s+at /);

    const broken = writeNotes(dir, "broken.json", "{not json");
    const result = cli(["--check-manifest", broken]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /无法解析清单/);
  });
});

test("CLI：--require-match 端到端生效，--warn-only 只告警不阻断", () => {
  withTmp((dir) => {
    const body = buildNotes();
    const manifest = writeNotes(dir, "m.json", JSON.stringify({ notes: body }));
    const same = writeNotes(dir, "same.md", body);
    const diff = writeNotes(dir, "diff.md", body.replace("Reads local PDF files.", "Reads PDFs."));

    assert.equal(cli(["--check-manifest", manifest, "--require-match", same]).status, 0);

    const strict = cli(["--check-manifest", manifest, "--require-match", diff]);
    assert.equal(strict.status, 1, strict.stderr);
    assert.match(strict.stderr, /不一致/);

    const warned = cli(["--check-manifest", manifest, "--require-match", diff, "--warn-only"]);
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /::warning::.*不一致/);
  });
});

test("CLI：普通候选缺 Release Notes 必须失败，演练才允许占位", () => {
  const missing = cli([], { RELEASE_NOTES: "", GITHUB_OUTPUT: "" });
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /候选阶段必须提供双语说明/);

  const rehearsal = cli([], { RELEASE_NOTES: "", ALLOW_PLACEHOLDER: "true", GITHUB_OUTPUT: "" });
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  assert.match(rehearsal.stdout, /Draft/);
});

test("归一化：逐字节相同 / 尾部换行 / CRLF 都通过，实质差异与行尾空白差异必须失败", () => {
  const body = buildNotes();
  assert.equal(validateManifestNotes({ notes: body }, { expectedBody: body }).ok, true);
  assert.equal(
    validateManifestNotes({ notes: `${body.replace(/\n/g, "\r\n")}` }, { expectedBody: body }).ok,
    true,
  );
  assert.equal(validateManifestNotes({ notes: body.trimEnd() }, { expectedBody: body }).ok, true);

  const different = validateManifestNotes(
    { notes: body.replace("Reads local PDF files.", "Reads PDFs.") },
    { expectedBody: body },
  );
  assert.equal(different.ok, false);

  // 行尾空白是 Markdown 硬换行，不做逐行 trim：这类差异必须判为不一致。
  const hardBreak = validateManifestNotes(
    { notes: body.replace("Reads local PDF files.", "Reads local PDF files.  ") },
    { expectedBody: body },
  );
  assert.equal(hardBreak.ok, false);
});

test("CLI：空取值与不可写的 GITHUB_OUTPUT 都必须给可读错误而不是堆栈", () => {
  const emptyCheck = cli(["--check", ""]);
  assert.equal(emptyCheck.status, 2, emptyCheck.stderr);
  assert.match(emptyCheck.stderr, /非空路径/);
  assert.doesNotMatch(emptyCheck.stderr, /node:internal|\n\s+at /);

  const emptyMatch = cli(["--check-manifest", "whatever.json", "--require-match", ""]);
  assert.equal(emptyMatch.status, 2, emptyMatch.stderr);
  assert.match(emptyMatch.stderr, /非空路径/);

  const unwritable = cli([], {
    RELEASE_NOTES: buildNotes(),
    GITHUB_OUTPUT: path.join(os.tmpdir(), "mr-missing-dir-xyz", "out.txt"),
  });
  assert.equal(unwritable.status, 2, unwritable.stderr);
  assert.match(unwritable.stderr, /无法写入 GITHUB_OUTPUT/);
  assert.doesNotMatch(unwritable.stderr, /node:internal|\n\s+at /);
});

test("模板：可复制示例必须通过真实校验器（校验仓库里实际的模板文件）", () => {
  const templatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".github",
    "RELEASE_NOTES_TEMPLATE.md",
  );
  const raw = fs.readFileSync(templatePath, "utf8");

  const example = extractCopyReadyExample(raw);
  assert.ok(example !== null, "模板必须包含用 mr:example 标记的可复制示例");
  const result = validateReleaseNotes(example);
  assert.equal(result.ok, true, `模板示例不合格：${result.errors.join("；")}`);

  // 用真实 CLI 再验一遍（不是 mock）。
  const cliResult = cli(["--check-template", templatePath]);
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /模板示例校验通过/);

  // 缺标记时必须是清晰的用法错误。
  const missing = cli(["--check-template", path.join(os.tmpdir(), "mr-no-such-template.md")]);
  assert.equal(missing.status, 2, missing.stderr);
  assert.match(missing.stderr, /无法读取/);
});

test("模板：开头的说明注释不得被当成引言段，但注释本身仍必须被拒", () => {
  const commented = `<!--\nHow to use:/n  1. copy the example below\n  2. delete this comment\n-->\n\n${buildNotes()}`;
  const result = validateReleaseNotes(commented);
  assert.match(result.errors.join("\n"), /模板注释/, "模板注释必须被报出来");
  assert.doesNotMatch(
    result.errors.join("\n"),
    /产品介绍/,
    "开头的说明注释不得被算成多段引言（那会给出误导性的错误）",
  );

  assert.equal(stripLeadingComment(commented).includes("<!--"), false);
  assert.equal(stripLeadingComment(buildNotes()), buildNotes());
  assert.ok(EXAMPLE_START.length > 0 && EXAMPLE_END.length > 0);
});

// ---- 跨工作流的发布说明契约（PR B 归属；随 release-notes.test.mjs 一起进包） ----

test("release-candidate：release_notes 必填（仅演练可留空），多行走 step output", () => {
  const source = workflow("release-candidate.yml");
  const notes = inputBlock(source, "release_notes");
  assert.match(notes, /required:\s*false/);
  assert.match(notes, /type:\s*string/);
  assert.ok(source.includes("scripts/release-governance/release-notes.mjs"));
  assert.ok(source.includes("releaseBody: ${{ steps.notes.outputs.body }}"));
  assert.ok(source.includes("RELEASE_NOTES: ${{ inputs.release_notes }}"));
  assert.ok(
    source.includes("ALLOW_PLACEHOLDER"),
    "占位豁免必须显式声明：空备注在普通候选里必须失败",
  );
});


test("发布说明：双语结构与内部信息门禁在两条通道上同时生效", () => {
  // 候选阶段：非空输入一旦不合规就失败，避免不合规文案被带进 Draft。
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    const source = workflow(name);
    assert.ok(
      source.includes("Validate and resolve bilingual release notes"),
      `${name} 必须在候选阶段校验发布说明结构`,
    );
    assert.ok(
      source.includes("node scripts/release-governance/release-notes.mjs"),
      `${name} 必须调用统一的结构校验器`,
    );
  }
  // 发布阶段：校验对象是即将公开的 Draft 正文，且必须先于 --draft=false。
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const source = workflow(name);
    const gate = source.indexOf("Enforce bilingual release notes");
    const publish = source.indexOf("Publish the Draft");
    assert.ok(gate >= 0, `${name} 缺少公开说明门禁`);
    assert.ok(publish > gate, `${name} 的说明门禁必须先于公开发布步骤`);
    const block = source.slice(gate, publish);
    assert.ok(
      block.includes("--json body --jq .body"),
      `${name} 必须校验 Draft 的真实正文，而不是 workflow 输入`,
    );
    assert.ok(
      block.includes("release-notes.mjs --check"),
      `${name} 必须以失败关闭方式校验公开说明`,
    );
  }
  // latest.json 的 notes 会显示在更新弹窗里，且由候选阶段生成，必须单独校验。
  const windows = workflow("release-publish.yml");
  const windowsGate = windows.slice(
    windows.indexOf("Enforce bilingual release notes"),
    windows.indexOf("Publish the Draft"),
  );
  assert.ok(windowsGate.includes("--pattern latest.json"), "Windows 发布必须取回即将公开的更新清单");
  assert.ok(windowsGate.includes("--check-manifest"), "Windows 发布必须校验清单里的 notes");
  assert.ok(
    windowsGate.includes("--require-match") && windowsGate.includes("--warn-only"),
    "Windows 发布必须把正文/清单一致性作为告警（结构校验仍为硬门禁）",
  );

  // Linux 通道的 notes 是单行双语摘要，必须用 summary 模式校验自己的清单。
  const linux = workflow("release-publish-linux.yml");
  const linuxGate = linux.slice(
    linux.indexOf("Enforce bilingual release notes"),
    linux.indexOf("Publish the Draft"),
  );
  assert.ok(
    linuxGate.includes("--check-manifest pre-publish-notes/latest-linux-critical.json"),
    "Linux 发布必须校验 latest-linux-critical.json 的 notes",
  );
  assert.ok(linuxGate.includes("--mode summary"), "Linux 清单 notes 必须按摘要模式校验");
});


test("候选备注：仅 Windows 演练允许占位，Linux 无豁免且先于构建校验", () => {
  const windows = workflow("release-candidate.yml");
  const notesBlock = windows.slice(
    windows.indexOf("Validate and resolve bilingual release notes"),
    windows.indexOf("Refuse to touch a published release"),
  );
  assert.ok(
    notesBlock.includes("ALLOW_PLACEHOLDER") && notesBlock.includes("inputs.rehearsal"),
    "Windows 的占位豁免必须绑定 rehearsal 输入，不能默认放开",
  );

  const linux = workflow("release-candidate-linux.yml");
  assert.ok(
    !/ALLOW_PLACEHOLDER/.test(linux),
    "Linux 候选没有演练模式，不得出现占位豁免",
  );

  const steps = parseSteps(linux);
  const notesAt = steps.findIndex(
    (step) => step.name === "Validate and resolve bilingual release notes",
  );
  const buildAt = steps.findIndex((step) => step.name === "Build signed Linux bundles");
  assert.ok(notesAt >= 0 && buildAt >= 0, "缺少备注校验或构建步骤");
  assert.ok(notesAt < buildAt, "备注校验必须在构建之前，避免空备注白跑构建");
});


test("候选通道：备注校验必须早于本地门禁与构建（Windows 与 Linux 一致）", () => {
  const cases = [
    ["release-candidate.yml", "Build signed NSIS bundle → Draft"],
    ["release-candidate-linux.yml", "Build signed Linux bundles"],
  ];
  for (const [name, buildStep] of cases) {
    const steps = parseSteps(workflow(name));
    const at = (title) => steps.findIndex((step) => step.name === title);
    const identity = at("Resolve candidate identity");
    const notes = at("Validate and resolve bilingual release notes");
    const gates = at("Local gates");
    const build = at(buildStep);
    for (const [label, index] of [
      ["Resolve candidate identity", identity],
      ["Validate and resolve bilingual release notes", notes],
      ["Local gates", gates],
      [buildStep, build],
    ]) {
      assert.ok(index >= 0, `${name} 缺少步骤：${label}`);
    }
    assert.ok(identity < notes, `${name}: 备注校验必须在身份解析之后`);
    assert.ok(
      notes < gates,
      `${name}: 备注校验必须早于 Local gates，否则空备注会白跑一次完整 Rust 编译`,
    );
    assert.ok(gates < build, `${name}: Local gates 必须仍在构建之前`);
  }
});
