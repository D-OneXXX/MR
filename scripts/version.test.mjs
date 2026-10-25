import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkProjectVersions,
  classifyVersionChange,
  lineOfCargoLockVersion,
  lineOfCargoTomlPackageVersion,
  lineOfJsonProperty,
  packageLockVersionLines,
  syncProjectVersions,
} from "./version-lib.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mr-version-"));
  mkdirSync(path.join(root, "src-tauri"), { recursive: true });
  mkdirSync(path.join(root, "src", "lib"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    `{
  "name": "manga-reader-tauri",
  "private": true,
  "version": "1.2.3"
}
`,
  );
  writeFileSync(
    path.join(root, "package-lock.json"),
    `{
  "name": "manga-reader-tauri",
  "version": "1.2.3",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "manga-reader-tauri",
      "version": "1.2.3"
    }
  }
}
`,
  );
  writeFileSync(
    path.join(root, "src-tauri", "tauri.conf.json"),
    `{
  "productName": "MangaReader",
  "version": "1.2.3"
}
`,
  );
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    `[package]
name = "manga-reader-tauri"
version = "1.2.3"
description = "fixture"

[dependencies]
serde = "1"
`,
  );
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.lock"),
    `version = 3

[[package]]
name = "adler2"
version = "2.0.1"

[[package]]
name = "manga-reader-tauri"
version = "1.2.3"
dependencies = []
`,
  );
  writeFileSync(
    path.join(root, "src", "lib", "version.ts"),
    `export const APP_VERSION = __APP_VERSION__;\nexport const BUILD_COMMIT = __BUILD_COMMIT__;\n`,
  );
  writeFileSync(
    path.join(root, "vite.config.ts"),
    `export default { define: { __APP_VERSION__: "x", __BUILD_COMMIT__: "y" } };\n`,
  );
  return root;
}

test("field readers preserve exact line numbers", () => {
  const text = `{\n  "name": "x",\n  "version": "1.2.3"\n}\n`;
  assert.deepEqual(lineOfJsonProperty(text, "version"), {
    line: 3,
    value: "1.2.3",
  });
  const cargo = `[package]\nname = "x"\nversion = "1.2.3"\n\n[dependencies]\nversion = "9.9.9"\n`;
  assert.deepEqual(lineOfCargoTomlPackageVersion(cargo), {
    line: 3,
    value: "1.2.3",
  });
  const lock = `version = 3\n\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "manga-reader-tauri"\nversion = "1.2.3"\n`;
  assert.deepEqual(lineOfCargoLockVersion(lock), {
    line: 9,
    value: "1.2.3",
  });
  assert.deepEqual(packageLockVersionLines(text), {
    root: { line: 3, value: "1.2.3" },
    packagesRoot: { line: 0, value: null },
  });
});

test("checker reports the exact mismatched file and line", () => {
  const root = fixture();
  try {
    const checked = checkProjectVersions(root);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));

    const tauriPath = path.join(root, "src-tauri", "tauri.conf.json");
    writeFileSync(
      tauriPath,
      readFileSync(tauriPath, "utf8").replace('"version": "1.2.3"', '"version": "1.2.4"'),
    );
    const mismatched = checkProjectVersions(root);
    assert.equal(mismatched.ok, false);
    const issue = mismatched.errors.find(
      (error) => error.file === "src-tauri/tauri.conf.json",
    );
    assert.ok(issue, JSON.stringify(mismatched.errors));
    assert.equal(issue.line, 3);
    assert.equal(issue.expected, "1.2.3");
    assert.equal(issue.actual, "1.2.4");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync updates every manifest and remains idempotent", () => {
  const root = fixture();
  try {
    const synced = syncProjectVersions(root, "2.0.0");
    assert.equal(synced.version, "2.0.0");
    assert.equal(synced.checked.ok, true, JSON.stringify(synced.checked.errors));
    for (const file of [
      "package.json",
      "package-lock.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
    ]) {
      const text = readFileSync(path.join(root, file), "utf8");
      assert.ok(text.includes("2.0.0"), `${file} did not receive version`);
      assert.ok(!text.includes("1.2.3"), `${file} retained old version`);
    }
    const again = syncProjectVersions(root, "2.0.0");
    assert.equal(again.change.kind, "unchanged");
    assert.equal(again.checked.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync validates every file before writing anything", () => {
  const root = fixture();
  try {
    const cargo = path.join(root, "src-tauri", "Cargo.toml");
    writeFileSync(
      cargo,
      readFileSync(cargo, "utf8").replace('version = "1.2.3"\n', ""),
    );
    assert.throws(() => syncProjectVersions(root, "2.0.0"));
    // package.json / tauri.conf.json 必须保持原版本，不能出现半迁移。
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
      "1.2.3",
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version,
      "1.2.3",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release semantics map patch/minor/major to the correct update mode", () => {
  assert.deepEqual(classifyVersionChange("0.10.1", "0.10.2"), {
    kind: "patch",
    updateMode: "patch-preferred",
  });
  assert.deepEqual(classifyVersionChange("0.10.1", "0.11.0"), {
    kind: "minor",
    updateMode: "patch-capable",
    minorSpan: 1,
  });
  assert.deepEqual(classifyVersionChange("0.10.1", "1.0.0"), {
    kind: "major",
    updateMode: "full-only",
  });
  assert.equal(classifyVersionChange("1.0.0", "0.10.1").kind, "downgrade");
});

test("refuses accidental downgrades unless explicitly allowed", () => {
  const root = fixture();
  const previous = process.env.MR_ALLOW_VERSION_DOWNGRADE;
  delete process.env.MR_ALLOW_VERSION_DOWNGRADE;
  try {
    assert.throws(() => syncProjectVersions(root, "1.0.0"), /降级/);
  } finally {
    if (previous === undefined) delete process.env.MR_ALLOW_VERSION_DOWNGRADE;
    else process.env.MR_ALLOW_VERSION_DOWNGRADE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
