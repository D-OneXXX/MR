#!/usr/bin/env node
import process from "node:process";
import {
  classifyVersionChange,
  parseVersion,
  syncProjectVersions,
} from "./version-lib.mjs";

function usage() {
  console.log(`Usage:
  npm run version:sync             Sync from package.json to all version files
  npm run version:sync -- 0.10.2   Set package.json and sync every target
  npm run version:sync -- --dry-run 0.10.2

Environment:
  MR_ALLOW_VERSION_DOWNGRADE=1     Permit an intentional downgrade
`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}
const dryRun = args.includes("--dry-run");
const requested = args.find((arg) => !arg.startsWith("-"));

try {
  if (requested) parseVersion(requested);
  if (dryRun) {
    const { checkProjectVersions } = await import("./version-lib.mjs");
    const current = checkProjectVersions(process.cwd());
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          current: current.expected,
          requested: requested ?? current.expected,
          change: requested
            ? classifyVersionChange(current.expected ?? "0.0.0", requested)
            : null,
          errors: current.errors,
        },
        null,
        2,
      ),
    );
    process.exit(current.ok ? 0 : 1);
  }

  const result = syncProjectVersions(process.cwd(), requested);
  const classification = classifyVersionChange(result.source, result.version);
  console.log(`[version] source: package.json ${result.source}`);
  console.log(`[version] target: ${result.version}`);
  console.log(
    `[version] change: ${classification.kind} / ${classification.updateMode}` +
      (classification.minorSpan !== undefined
        ? ` (minor span ${classification.minorSpan})`
        : ""),
  );
  for (const write of result.writes) {
    console.log(`[version] wrote ${write.file}:${write.line} -> ${write.version}`);
  }
  if (!result.checked.ok) {
    for (const error of result.checked.errors) {
      console.error(`[version] ${error.message}`);
    }
    process.exit(1);
  }
  console.log("[version] synchronized; frontend constants are injected from package.json at build time");
} catch (error) {
  console.error(`[version] ${error instanceof Error ? error.message : error}`);
  usage();
  process.exit(1);
}
