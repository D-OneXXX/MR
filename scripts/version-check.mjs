#!/usr/bin/env node
import process from "node:process";
import { checkProjectVersions } from "./version-lib.mjs";

const asJson = process.argv.includes("--json");
const result = checkProjectVersions(process.cwd());

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
  console.log(`[version] OK ${result.expected}`);
  console.log(
    "[version] package.json, tauri.conf.json, Cargo.toml, Cargo.lock and package-lock.json agree",
  );
  console.log("[version] frontend build injection is wired to package.json");
} else {
  console.error("[version] FAILED: version mismatch");
  for (const error of result.errors) {
    const prefix = `${error.file}:${error.line}`;
    const message = String(error.message || "").startsWith(prefix)
      ? error.message
      : `${prefix} ${error.message}`;
    console.error(`  ${message}`);
  }
  console.error(
    "Fix with: npm run version:sync   (or pass a new MAJOR.MINOR.PATCH)",
  );
}

process.exit(result.ok ? 0 : 1);
