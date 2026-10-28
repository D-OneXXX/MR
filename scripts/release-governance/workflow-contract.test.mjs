import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { inputBlock, parseSteps, workflow } from "./contract-helpers.mjs";
import { fileURLToPath } from "node:url";


test("release-candidate：候选阶段产出并回填 signature-verification.json", () => {
  const source = workflow("release-candidate.yml");
  const rc = source.indexOf("Build and upload RC record");
  const verify = source.indexOf("Verify candidate signature");
  assert.ok(rc >= 0, "缺少 RC 记录步骤");
  assert.ok(verify > rc, "签名验证必须位于 RC 记录之后");
  for (const marker of [
    "scripts/release-governance/fetch-minisign.mjs",
    "scripts/release-governance/verify-signature.mjs",
    "mr-signature-evidence",
    "configured.pub",
    "--platform windows-x86_64",
    '--out "$EVIDENCE_DIR/signature-verification.json"',
    'gh release upload "$TAG" "$EVIDENCE_DIR/signature-verification.json" --clobber',
  ]) {
    assert.ok(source.includes(marker), `缺少签名证据标记：${marker}`);
  }
  // 公钥必须从仓库当前 tauri.conf.json 派生，而不是外部输入。
  assert.ok(source.includes("src-tauri/tauri.conf.json"));
  assert.ok(source.includes("plugins.updater.pubkey"));
  assert.ok(source.includes("contents: write"));
  assert.ok(!source.includes("permissions: write-all"));
});


test("release-install-verify：previous_tag/previous_version 无版本默认值且失败关闭", () => {
  const source = workflow("release-install-verify.yml");
  for (const name of ["tag", "previous_tag", "previous_version"]) {
    const block = inputBlock(source, name);
    assert.match(block, /required:\s*true/, `${name} 必须必填`);
    assert.ok(!/^\s*default:/m.test(block), `${name} 不得有版本特定默认值`);
  }
  for (const marker of [
    'if [ "$PREVIOUS_TAG" = "$TAG" ]',
    "'^0\\.[0-9]+\\.[0-9]+$'",
    'if [ "v${PREVIOUS_VERSION}" != "$PREVIOUS_TAG" ]',
    "MangaReader_${PREVIOUS_VERSION}_x64-setup.exe",
  ]) {
    assert.ok(source.includes(marker), `缺少升级基线校验：${marker}`);
  }
  const validate = source.indexOf("Validate previous release inputs");
  const download = source.indexOf("Download previous installer");
  assert.ok(validate >= 0 && validate < download, "基线校验必须先于下载旧安装包");
});

test("release-install-verify：只回填通过总闸且哈希一致的那一份安装证据", () => {
  const source = workflow("release-install-verify.yml");
  for (const marker of [
    "Attach verified install evidence to Draft",
    'BEFORE="$(sha256 "$SRC")"',
    'AFTER="$(sha256 "$STAGE/install-verification.json")"',
    'if [ "$BEFORE" != "$AFTER" ]',
    'gh release upload "$TAG" "$STAGE/install-verification.json" --clobber',
  ]) {
    assert.ok(source.includes(marker), `缺少证据回填标记：${marker}`);
  }
  const uploads = [...source.matchAll(/^\s+gh release upload/gm)];
  assert.equal(uploads.length, 1, "只允许一次 gh release upload");
  assert.ok(!/gh release\s+(edit|delete)/.test(source), "不得修改/删除 Release");
  // 回填必须在证据总闸之后。
  const gate = source.indexOf("verify-evidence.mjs");
  const attach = source.indexOf("Attach verified install evidence to Draft");
  assert.ok(gate >= 0 && attach > gate, "回填必须位于 verify-evidence 之后");
});

test("候选容器：RC 记录排除治理文件（Windows 与 Linux 一致）", () => {
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    const source = workflow(name);
    assert.ok(source.includes("collectCandidateArtifacts"), `${name} 必须使用统一制品收集器`);
    assert.ok(!source.includes('n !== "rc-record.json"'), `${name} 仍只排除单一治理文件`);
  }
});

test("发布接力：只从已公开且非预发布的 Release 携带另一通道清单", () => {
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const source = workflow(name);
    assert.ok(
      source.includes("select(.draft == false and .prerelease == false)"),
      `${name} 的清单接力必须排除 Draft / 预发布`,
    );
    assert.ok(!source.includes("--jq '.[].tag_name'"), `${name} 仍会从 Draft 接力清单`);
  }
});

test("候选通道：已公开的 Release 不得被候选流程覆盖（Windows 与 Linux 一致）", () => {
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    const source = workflow(name);
    const guard = source.indexOf("Refuse to touch a published release");
    assert.ok(guard >= 0, `${name} 必须显式拒绝改写已公开发布的 Release`);
    assert.ok(
      source.slice(guard, guard + 900).includes('gh release view "$TAG" --json isDraft'),
      `${name} 的守卫必须先判定目标 Release 是否仍是 Draft`,
    );
    assert.ok(
      /release-guard\.mjs[\s\S]{0,1400}\*\)[^\n]*exit 1/.test(source.slice(guard)),
      `${name} 的守卫必须经分类器失败关闭（未知状态 exit 1）`,
    );
    // 守卫必须早于任何 Release 写入与构建步骤，确保失败发生在副作用之前。
    // 注意用具体步骤名，不要用 “Build signed”（job 名里也有这几个字）。
    for (const marker of [
      "gh release upload",
      "gh release create",
      "Build signed NSIS bundle",
      "Build signed Linux bundles",
    ]) {
      const at = source.indexOf(marker);
      if (at >= 0) assert.ok(guard < at, `${name} 的守卫必须先于「${marker}」`);
    }
  }
});

test("发布通道：干净环境证据必须来自 GitHub-hosted（Windows 与 Linux 一致）", () => {
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const source = workflow(name);
    const verifyAt = source.indexOf("verify-provenance.mjs");
    assert.ok(verifyAt >= 0, `${name} 必须在线核验安装证据 provenance`);
    assert.ok(
      source.slice(verifyAt, verifyAt + 400).includes("--require-github-actions"),
      `${name} 的 provenance 核验必须要求 GitHub-hosted 干净环境，不得接受自述的本地 VM`,
    );
  }
});

test("发布通道：已公开但缺清单必须可重跑补齐（Windows 与 Linux 一致）", () => {
  const channels = {
    "release-publish.yml": "windows",
    "release-publish-linux.yml": "linux",
  };
  for (const [name, channel] of Object.entries(channels)) {
    const source = workflow(name);
    assert.ok(source.includes("Assess publication state"), `${name} 必须显式判定发布状态`);
    assert.ok(
      source.includes(`publish-state.mjs --channel ${channel}`),
      `${name} 必须使用 ${channel} 通道的清单定义`,
    );

    // 公开与接力必须由两个独立状态驱动，不能共用一个 published 布尔值。
    const publishAt = source.indexOf("Publish the Draft");
    const handoffAt = source.indexOf("Channel hand-off");
    assert.ok(publishAt > 0 && handoffAt > publishAt, `${name} 的步骤顺序异常`);
    assert.ok(
      source.slice(publishAt, publishAt + 160).includes("need_publish == 'true'"),
      `${name} 的公开步骤必须由 need_publish 驱动`,
    );
    assert.ok(
      source.slice(handoffAt, handoffAt + 160).includes("need_handoff == 'true'"),
      `${name} 的接力步骤必须由 need_handoff 驱动`,
    );

    // 发布后校验不得被“已发布”短路，否则部分失败的重跑永远不会被检查。
    const verifyAt = source.indexOf("Post-release verification");
    const verifyBlock = source.slice(verifyAt, verifyAt + 1800);
    assert.ok(!verifyBlock.includes("published != 'true'"), `${name} 的发布后校验不得跳过已公开状态`);
    const peer = channel === "windows" ? "latest-linux-critical.json" : "latest.json";
    assert.ok(
      verifyBlock.includes(peer),
      `${name} 的发布后校验必须确认另一通道清单 ${peer} 存在`,
    );

    // 摘要不得用 always()：失败时不能打印"已公开"的完成态。
    assert.ok(
      !/Summarize publication\n\s+if: always\(\)/.test(source),
      `${name} 的发布摘要不得使用 always()`,
    );
  }
});

const PUBLISH_WORKFLOWS = ["release-publish.yml", "release-publish-linux.yml"];

function publishSteps(name) {
  return parseSteps(workflow(name));
}

/** draft-assets/ 的唯一产出者：下载 Release 资产的步骤。 */
function draftAssetsProducer(steps) {
  return steps.find(
    (step) => step.run.includes("gh release download") && step.run.includes("draft-assets"),
  );
}

test("候选通道：发布状态守卫必须早于本地门禁与构建（Windows 与 Linux 一致）", () => {
  const cases = [
    ["release-candidate.yml", "Build signed NSIS bundle → Draft"],
    ["release-candidate-linux.yml", "Build signed Linux bundles"],
  ];
  for (const [name, buildStep] of cases) {
    const steps = parseSteps(workflow(name));
    const at = (title) => steps.findIndex((step) => step.name === title);
    const identity = at("Resolve candidate identity");
    const guard = at("Refuse to touch a published release");
    const gates = at("Local gates");
    const build = at(buildStep);
    for (const [label, index] of [
      ["Resolve candidate identity", identity],
      ["Refuse to touch a published release", guard],
      ["Local gates", gates],
      [buildStep, build],
    ]) {
      assert.ok(index >= 0, `${name} 缺少步骤：${label}`);
    }
    assert.ok(identity < guard, `${name}: 守卫必须在身份解析之后`);
    assert.ok(
      guard < gates,
      `${name}: 发布状态守卫必须早于 Local gates，否则已发布 Release 也要先编译完才被拒`,
    );
    assert.ok(guard < build, `${name}: 守卫必须早于构建`);
    assert.ok(gates < build, `${name}: Local gates 必须仍在构建之前`);
  }
});

test("候选通道：Release 存在性判定必须按错误分类 fail closed", () => {
  for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
    const steps = parseSteps(workflow(name));
    const guard = steps.find((step) => step.name === "Refuse to touch a published release");
    assert.ok(guard, `${name} 缺少发布状态守卫`);
    assert.ok(
      guard.run.includes("release-guard.mjs"),
      `${name} 必须用分类器判定 Release 状态，而不是裸 if gh release view`,
    );
    assert.ok(guard.run.includes("--status"), `${name} 必须显式捕获 gh 退出码`);
    assert.ok(
      guard.run.includes("--stdout-file") && guard.run.includes("--stderr-file"),
      `${name} 必须保留 stdout/stderr 供分类`,
    );
    assert.ok(!/if gh release view/.test(guard.run), `${name} 不得再用裸 if gh release view 判定`);
    assert.ok(
      /set \+e[\s\S]*STATUS=\$\?[\s\S]*set -e/.test(guard.run),
      `${name} 必须显式记录退出码后再恢复严格模式`,
    );
  }
});

test("重跑依赖：Windows 与 Linux 的 draft-assets 产出步骤都必须无条件执行", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const producer = draftAssetsProducer(publishSteps(name));
    assert.ok(producer, `${name} 缺少下载 Release 资产的步骤`);
    assert.equal(
      producer.if,
      "",
      `${name}: "${producer.name}" 不得被 need_publish/published 门控——已公开但缺清单的重跑同样需要这些资产`,
    );
  }
});

test("重跑依赖：消费 draft-assets 的步骤不得在产出步骤被跳过的路径上运行", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const steps = publishSteps(name);
    const producer = draftAssetsProducer(steps);
    const consumers = steps.filter(
      (step) => step !== producer && step.run.includes("draft-assets"),
    );
    assert.ok(consumers.length >= 3, `${name} 应至少有 3 个消费 draft-assets 的步骤`);
    for (const consumer of consumers) {
      assert.ok(
        !/need_publish|published/.test(consumer.if),
        `${name}: "${consumer.name}" 依赖 draft-assets，却按发布状态被跳过`,
      );
    }
  }
});

test("场景 1/2：首次公开与已发布重跑走同一套资产校验，产出步骤都先生效", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const steps = publishSteps(name);
    const producerIndex = steps.indexOf(draftAssetsProducer(steps));
    const firstConsumer = steps.findIndex(
      (step) => step.run.includes("draft-assets/") && step !== draftAssetsProducer(steps),
    );
    assert.ok(producerIndex >= 0, `${name} 缺少资产产出步骤`);
    assert.ok(
      producerIndex < firstConsumer,
      `${name} 资产必须先下载再被消费（首次公开与重跑同一顺序）`,
    );
    // 两种状态（Draft / 已公开）都不会让产出步骤消失：它没有 if。
    assert.equal(draftAssetsProducer(steps).if, "");
  }
});

test("场景 3：重试时资产齐全——覆盖式下载且不提前退出", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const producer = draftAssetsProducer(publishSteps(name));
    assert.ok(producer.run.includes("--clobber"), `${name} 重试下载必须允许覆盖本地残留`);
    const downloadAt = producer.run.indexOf("gh release download");
    const earlyExitAt = producer.run.indexOf("exit 0");
    assert.ok(downloadAt >= 0, `${name} 资产产出步骤必须真正下载资产`);
    if (earlyExitAt >= 0) {
      assert.ok(
        downloadAt < earlyExitAt,
        `${name} 不得在下载前就用 exit 0 结束步骤`,
      );
    }
  }
});

test("场景 4：缺少必需资产时必须失败关闭并给出稳定线索", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const producer = draftAssetsProducer(publishSteps(name));
    for (const marker of ["rc-record.json", "install-verification.json"]) {
      assert.ok(
        producer.run.includes(`if [ ! -f draft-assets/${marker} ]`),
        `${name} 缺少对 ${marker} 的存在性检查`,
      );
    }
    assert.ok(/exit 1/.test(producer.run), `${name} 资产缺失分支必须以非零退出`);
  }
});

test("场景 5：下载失败必须中断步骤，不得被吞掉", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const producer = draftAssetsProducer(publishSteps(name));
    assert.match(producer.run, /set -euo pipefail/, `${name} 资产下载步骤缺少严格模式`);
    assert.ok(
      !/gh release download[^\n]*\|\|\s*true/.test(producer.run),
      `${name} 下载失败不得用 || true 吞掉`,
    );
  }
});

test("场景 6：验签/证据校验失败必须向上传播，不得降级为告警", () => {
  for (const name of PUBLISH_WORKFLOWS) {
    const steps = publishSteps(name);
    const verifiers = steps.filter((step) =>
      /verify-signature\.mjs|verify-evidence\.mjs|verify-provenance\.mjs|verify-updater-manifest\.mjs/.test(
        step.run,
      ),
    );
    assert.ok(verifiers.length >= 2, `${name} 至少应保留签名与证据两类校验`);
    for (const verifier of verifiers) {
      assert.ok(
        !/\|\|\s*true/.test(verifier.run),
        `${name}: "${verifier.name}" 不得把校验失败吞成成功`,
      );
    }
    assert.ok(
      !/continue-on-error:\s*true/.test(workflow(name)),
      `${name} 不得对任一步骤启用 continue-on-error`,
    );
  }
});

/** 读取 GITHUB_OUTPUT（key=value 每行一条）。 */
function readGithubOutput(file) {
  const outputs = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) outputs.set(line.slice(0, at), line.slice(at + 1));
  }
  return outputs;
}

test("候选守卫：实际 run 块对 404/401/已发布返回不同退出码", (t) => {
  // 纯文本断言无法证明 shell 接线正确（例如清理动作覆盖退出码、stdout 多一行导致
  // case 失配）。这里把工作流里的 run 块原样抽出来，用桩 gh 真跑一遍。
  const probe = spawnSync("bash", ["-c", "true"], { encoding: "utf8" });
  if (probe.error) {
    t.skip("当前环境缺少 bash，跳过守卫接线测试");
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-guard-wire-"));
  const binDir = path.join(workDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "gh");
  fs.writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'case "$FAKE_MODE" in',
      '  missing) echo "release not found" >&2; exit 1 ;;',
      '  auth) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;',
      '  published) echo "false"; exit 0 ;;',
      '  draft) echo "true"; exit 0 ;;',
      '  *) echo "boom" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(stub, 0o755);

  const scenarios = [
    ["missing", 0],
    ["draft", 0],
    ["published", 2],
    ["auth", 3],
    ["unknown", 3],
  ];

  try {
    for (const name of ["release-candidate.yml", "release-candidate-linux.yml"]) {
      const guard = parseSteps(workflow(name)).find(
        (step) => step.name === "Refuse to touch a published release",
      );
      assert.ok(guard, `${name} 缺少发布状态守卫`);
      const script = path.join(workDir, `${name}.sh`);
      fs.writeFileSync(script, guard.run, "utf8");

      for (const [mode, expected] of scenarios) {
        // GitHub Actions 始终提供 GITHUB_OUTPUT；本地跑真实 run 块时也要补上。
        const outputFile = path.join(workDir, `output-${name}-${mode}.txt`);
        fs.writeFileSync(outputFile, "", "utf8");
        const result = spawnSync("bash", [script], {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            FAKE_MODE: mode,
            TAG: "v0.19.0",
            RUNNER_TEMP: workDir,
            GITHUB_OUTPUT: outputFile,
          },
        });
        assert.equal(
          result.status,
          expected,
          `${name} / ${mode}: 期望退出码 ${expected}，实际 ${result.status}\n${result.stderr || result.stdout}`,
        );

        // 状态必须写给下游：可继续的分支写 state=<state>，拒绝的分支不得留残留值。
        const outputs = readGithubOutput(outputFile);
        if (expected === 0) {
          assert.equal(
            outputs.get("state"),
            mode,
            `${name} / ${mode}: 守卫必须把判定写入 GITHUB_OUTPUT`,
          );
        } else {
          assert.ok(
            !outputs.has("state"),
            `${name} / ${mode}: 拒绝时不得留下 state，否则下游会把残留值当成可继续`,
          );
        }
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("候选通道：Linux 写入前复检并复用其状态，不得二次查询", () => {
  const source = workflow("release-candidate-linux.yml");
  const steps = parseSteps(source);
  const guardIndex = steps.findIndex((s) => s.name === "Refuse to touch a published release");
  const recheckIndex = steps.findIndex(
    (s) => s.name === "Re-check release state before Draft write",
  );
  const createIndex = steps.findIndex((s) => s.name === "Create or reuse Draft release");

  assert.ok(guardIndex >= 0, "缺少早期发布状态守卫");
  assert.ok(recheckIndex >= 0, "缺少写入前复检步骤");
  assert.ok(createIndex >= 0, "缺少 Create or reuse Draft release 步骤");
  assert.ok(guardIndex < recheckIndex, "复检必须在早期守卫之后");
  assert.ok(recheckIndex < createIndex, "复检必须位于写入步骤之前");

  const recheck = steps[recheckIndex];
  assert.ok(recheck.run.includes("release-guard.mjs"), "复检必须复用同一分类器");
  assert.ok(recheck.run.includes("GITHUB_OUTPUT"), "复检必须把新状态写给下游");

  const createBlock = source.slice(
    source.indexOf("Create or reuse Draft release"),
    source.indexOf("Upload candidate artifacts to Draft"),
  );
  assert.match(
    createBlock,
    /RELEASE_STATE:\s*\$\{\{\s*steps\.release_recheck\.outputs\.state\s*\}\}/,
    "创建步骤必须消费复检写出的状态，而不是构建前的旧状态",
  );

  const create = steps[createIndex];
  assert.ok(
    !/gh release view/.test(create.run),
    "Draft 创建/复用步骤不得再次调用 gh release view（瞬时故障会被误判为不存在）",
  );
});



test("发布通道：安装包必须唯一命中解析，不得依赖 ls 的失败语义", () => {
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const source = workflow(name);
    assert.ok(
      source.includes("resolve-draft-asset.mjs"),
      `${name} 必须用唯一命中解析器取安装包与签名`,
    );
    assert.ok(
      !/ls draft-assets\/\*\./.test(source),
      `${name} 不得再用 ls 取安装包（set -euo pipefail 下 ls 无匹配会先退出，友好提示成死代码）`,
    );
    const steps = parseSteps(source);
    const resolverStep = steps.find((step) => step.run.includes("resolve-draft-asset.mjs"));
    assert.ok(resolverStep, `${name} 缺少安装包解析步骤`);
    assert.match(
      resolverStep.run,
      /set -euo pipefail/,
      `${name} 解析步骤必须保持严格模式`,
    );
    assert.ok(
      !/\|\| true/.test(resolverStep.run),
      `${name} 不得吞掉解析失败（缺件必须失败关闭）`,
    );
  }
});

test("Linux 写入前复检：真实 run 块的状态传递、失败关闭与分支选择", (t) => {
  if (spawnSync("bash", ["-c", "true"], { encoding: "utf8" }).error) {
    t.skip("当前环境缺少 bash，跳过复检接线测试");
    return;
  }
  const steps = parseSteps(workflow("release-candidate-linux.yml"));
  const recheck = steps.find((s) => s.name === "Re-check release state before Draft write");
  const create = steps.find((s) => s.name === "Create or reuse Draft release");
  assert.ok(recheck, "缺少写入前复检步骤");
  assert.ok(create, "缺少 Draft 创建/复用步骤");

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-recheck-wire-"));
  const binDir = path.join(workDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const ghStub = path.join(binDir, "gh");
  fs.writeFileSync(
    ghStub,
    [
      "#!/usr/bin/env bash",
      'echo "$*" >> "$GH_CALLS"',
      'case "$FAKE_MODE" in',
      '  draft) echo "true"; exit 0 ;;',
      '  missing) echo "release not found" >&2; exit 1 ;;',
      '  published) echo "false"; exit 0 ;;',
      '  auth) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;',
      '  ratelimit) echo "HTTP 403: API rate limit exceeded" >&2; exit 1 ;;',
      '  server) echo "HTTP 500: Internal Server Error" >&2; exit 1 ;;',
      '  network) echo "Get https://api.github.com/: EOF" >&2; exit 1 ;;',
      "  empty) exit 1 ;;",
      '  *) echo "boom" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(ghStub, 0o755);

  const runRecheck = (mode, env = {}) => {
    const suffix = `${mode}-${Math.random().toString(36).slice(2, 8)}`;
    const outFile = path.join(workDir, `recheck-${suffix}.txt`);
    const callsFile = path.join(workDir, `calls-${suffix}.txt`);
    fs.writeFileSync(outFile, "", "utf8");
    fs.writeFileSync(callsFile, "", "utf8");
    const result = spawnSync("bash", ["-c", recheck.run], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_MODE: mode,
        TAG: "v0.19.0",
        RUNNER_TEMP: workDir,
        GITHUB_OUTPUT: outFile,
        GH_CALLS: callsFile,
        ...env,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr ?? "",
      state: readGithubOutput(outFile).get("state"),
      hasState: readGithubOutput(outFile).has("state"),
      calls: fs.readFileSync(callsFile, "utf8"),
    };
  };

  const writeCalls = /release (upload|create|edit)/;

  try {
    const draft = runRecheck("draft");
    assert.equal(draft.status, 0, draft.stderr);
    assert.equal(draft.state, "draft", "Draft 必须写出 state=draft");
    assert.ok(!writeCalls.test(draft.calls), "复检本身不得写 Release");

    const missing = runRecheck("missing");
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.state, "missing", "确认不存在必须写出 state=missing");

    const published = runRecheck("published");
    assert.notEqual(published.status, 0, "已发布 Release 必须失败关闭");
    assert.equal(published.hasState, false, "拒绝时不得留下 state（下游会把残留值当成可继续）");
    assert.ok(!writeCalls.test(published.calls), "已发布时不得写 Release");

    for (const mode of ["auth", "ratelimit", "server", "network", "empty"]) {
      const failed = runRecheck(mode);
      assert.notEqual(failed.status, 0, `${mode} 必须失败关闭`);
      assert.equal(failed.hasState, false, `${mode} 不得留下 state`);
      assert.ok(!writeCalls.test(failed.calls), `${mode} 不得写 Release`);
    }

    // 写入步骤必须按复检给出的状态分叉：Draft 原地复用，确认不存在才新建。
    const runCreate = (state) => {
      const callsFile = path.join(workDir, `create-calls-${Math.random().toString(36).slice(2, 8)}.txt`);
      const outFile = path.join(workDir, `create-out-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.writeFileSync(callsFile, "", "utf8");
      fs.writeFileSync(outFile, "", "utf8");
      const result = spawnSync("bash", ["-c", create.run], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          FAKE_MODE: "draft",
          TAG: "v0.19.0",
          GH_CALLS: callsFile,
          GITHUB_OUTPUT: outFile,
          RELEASE_STATE: state,
          RELEASE_BODY: "body",
        },
      });
      return { status: result.status, calls: fs.readFileSync(callsFile, "utf8") };
    };

    const reuse = runCreate(draft.state);
    assert.equal(reuse.status, 0, reuse.calls);
    assert.match(reuse.calls, /release edit/, "Draft 必须原地复用");
    assert.doesNotMatch(reuse.calls, /release create/, "Draft 不得新建 Release");

    const fresh = runCreate(missing.state);
    assert.equal(fresh.status, 0, fresh.calls);
    assert.match(fresh.calls, /release create/, "确认不存在必须新建 Draft");
    assert.match(fresh.calls, /--draft/, "新建必须是 Draft");

    // 清理失败不得覆盖原始退出码。
    const failBin = path.join(workDir, "failbin");
    fs.mkdirSync(failBin, { recursive: true });
    const rmStub = path.join(failBin, "rm");
    fs.writeFileSync(rmStub, "#!/usr/bin/env bash\nexit 1\n", "utf8");
    fs.chmodSync(rmStub, 0o755);
    const withFailingCleanup = runRecheck("published", {
      PATH: `${failBin}${path.delimiter}${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    assert.equal(withFailingCleanup.status, 2, "清理失败不得把退出码改成别的值");
    assert.equal(withFailingCleanup.hasState, false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("演练标签门禁：候选接受 v0.0.0-rehearsal 系列，常规通道仍只收 vX.Y.Z，发布无条件拒绝 rehearsal", () => {
  const source = workflow("release-candidate.yml");
  const patterns = [...source.matchAll(/grep -Eq '([^']+)'/g)].map((m) => m[1]);
  const rehearsalPattern = patterns.find((p) => p.includes("rehearsal"));
  const releasePattern = patterns.find((p) => p.includes("v[0-9]"));
  assert.ok(rehearsalPattern, "候选工作流缺少演练标签门控");
  assert.ok(releasePattern, "候选工作流缺少常规标签门控");

  const rehearsalGate = new RegExp(rehearsalPattern);
  const releaseGate = new RegExp(releasePattern);

  // 演练族：允许递增后缀，便于每次演练用独立标签而不动旧标签。
  for (const tag of ["v0.0.0-rehearsal", "v0.0.0-rehearsal2", "v0.0.0-rehearsal12"]) {
    assert.ok(rehearsalGate.test(tag), `演练标签族必须接受 ${tag}`);
  }
  for (const tag of ["v0.0.0-rehearsalX", "v0.0.0-rehearsal-2", "v0.1.0", "v0.19.0", "v0.0.0"]) {
    assert.ok(!rehearsalGate.test(tag), `演练标签族必须拒绝 ${tag}`);
  }

  // 常规通道：演练标签永远不是合法发布标签。
  for (const tag of ["v0.19.0", "v1.2.3"]) {
    assert.ok(releaseGate.test(tag), `常规通道必须接受 ${tag}`);
  }
  for (const tag of ["v0.0.0-rehearsal2", "v0.19.0-linux-sec1", "v0.19", "v0.19.0.1"]) {
    assert.ok(!releaseGate.test(tag), `常规通道必须拒绝 ${tag}`);
  }

  // 发布侧：任何含 rehearsal 的标签无条件拒绝（子串匹配，新增后缀也不放过）。
  for (const name of ["release-publish.yml", "release-publish-linux.yml"]) {
    const publish = workflow(name);
    assert.ok(
      publish.includes('grep -q "rehearsal"'),
      `${name} 必须对任何含 rehearsal 的标签无条件拒绝`,
    );
    assert.ok(
      publish.includes("演练标签永远不得发布"),
      `${name} 必须给出明确的演练拒绝提示`,
    );
  }
});
