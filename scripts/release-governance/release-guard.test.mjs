import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  classifyReleaseView,
  evaluateReleaseGuard,
  GUARD_EXIT_CODES,
} from "./release-guard.mjs";

const TAG = "v0.19.0";
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-guard.mjs");

test("release-guard：成功输出只接受严格的 true/false", () => {
  assert.equal(classifyReleaseView({ status: 0, stdout: "true\n" }), "draft");
  assert.equal(classifyReleaseView({ status: 0, stdout: "false" }), "published");
  // 任何多余内容（例如 gh 的升级提示被误并入 stdout）都不可信。
  assert.equal(classifyReleaseView({ status: 0, stdout: "" }), "unknown");
  assert.equal(classifyReleaseView({ status: 0, stdout: "TRUE" }), "unknown");
  assert.equal(classifyReleaseView({ status: 0, stdout: "true\nwarning: ..." }), "unknown");
});

test("release-guard：只有正向 404 证据判定为不存在", () => {
  assert.equal(
    classifyReleaseView({ status: 1, stderr: "release not found" }),
    "missing",
  );
  assert.equal(
    classifyReleaseView({
      status: 1,
      stderr:
        'HTTP 404: Not Found (https://api.github.com/repos/D-OneXXX/Moyu/releases/tags/v0.19.0)',
    }),
    "missing",
  );
});

test("release-guard：鉴权、权限、限流一律拒绝", () => {
  assert.equal(
    classifyReleaseView({
      status: 1,
      stderr:
        "HTTP 401: Bad credentials (https://api.github.com/repos/D-OneXXX/Moyu/releases/tags/v0.19.0)",
    }),
    "unknown",
  );
  assert.equal(
    classifyReleaseView({ status: 1, stderr: "HTTP 403: Resource not accessible by integration" }),
    "unknown",
  );
  assert.equal(
    classifyReleaseView({
      status: 1,
      stderr: "HTTP 403: API rate limit exceeded for 203.0.113.1",
    }),
    "unknown",
  );
});

test("release-guard：服务端、网络、DNS、超时一律拒绝", () => {
  for (const stderr of [
    "HTTP 500: Internal Server Error",
    "HTTP 502: Bad Gateway",
    "HTTP 503: Service Unavailable",
    'Get "https://api.github.com/...": EOF',
    "dial tcp: lookup api.github.com: no such host",
    "net/http: request canceled (Client.Timeout exceeded while awaiting headers)",
    "dial tcp 140.82.112.6:443: connection refused",
  ]) {
    assert.equal(classifyReleaseView({ status: 1, stderr }), "unknown", stderr);
  }
});

test("release-guard：空输出与未知文本默认拒绝", () => {
  assert.equal(classifyReleaseView({ status: 1 }), "unknown");
  assert.equal(classifyReleaseView({ status: 1, stderr: "   " }), "unknown");
  assert.equal(classifyReleaseView({ status: 1, stderr: "something unexpected" }), "unknown");
  assert.equal(classifyReleaseView({ status: 128, stderr: "command not found: gh" }), "unknown");
});

test("release-guard：401/5xx 即使夹带 not found 也不得放行（优先级）", () => {
  assert.equal(
    classifyReleaseView({ status: 1, stderr: "HTTP 500: release not found" }),
    "unknown",
  );
  assert.equal(
    classifyReleaseView({ status: 1, stderr: "HTTP 401: release not found" }),
    "unknown",
  );
});

test("release-guard：退出码与状态一一对应", () => {
  assert.equal(GUARD_EXIT_CODES.missing, 0);
  assert.equal(GUARD_EXIT_CODES.draft, 0);
  assert.equal(GUARD_EXIT_CODES.published, 2);
  assert.equal(GUARD_EXIT_CODES.unknown, 3);

  assert.equal(
    evaluateReleaseGuard({ status: 0, stdout: "false", tag: TAG }).exitCode,
    2,
  );
  assert.equal(
    evaluateReleaseGuard({ status: 1, stderr: "HTTP 401: Bad credentials", tag: TAG }).exitCode,
    3,
  );
});

test("release-guard：拒绝信息包含 tag 与原因，便于值班判断", () => {
  const published = evaluateReleaseGuard({ status: 0, stdout: "false", tag: TAG });
  assert.match(published.message, /v0\.19\.0/);
  assert.match(published.message, /已经公开发布/);

  const unknown = evaluateReleaseGuard({
    status: 1,
    stderr: "HTTP 403: Resource not accessible by integration",
    tag: TAG,
  });
  assert.match(unknown.message, /状态无法确认/);
  assert.match(unknown.message, /退出码 1/);
  assert.match(unknown.message, /人工确认/);
});

test("release-guard CLI：状态文件缺失也按拒绝处理", () => {
  const missing = spawnSync(
    process.execPath,
    [SCRIPT, "--status", "1", "--stdout-file", "no-such-file", "--stderr-file", "no-such-file"],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 3, missing.stderr || missing.stdout);
});

test("release-guard CLI：missing 输出状态并返回 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mr-release-guard-"));
  try {
    const out = path.join(dir, "out.txt");
    const err = path.join(dir, "err.txt");
    fs.writeFileSync(out, "", "utf8");
    fs.writeFileSync(err, "release not found\n", "utf8");
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "--status", "1", "--stdout-file", out, "--stderr-file", err, "--tag", TAG],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^missing$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
