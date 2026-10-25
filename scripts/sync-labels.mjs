#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = path.join(repoRoot, ".github", "labels.json");

export function normalizeColor(color) {
  return String(color || "").trim().replace(/^#/, "").toLowerCase();
}

export function validateLabelDefinitions(definitions) {
  const errors = [];
  if (!Array.isArray(definitions)) {
    return ["labels.json must contain an array"];
  }
  if (definitions.length === 0) {
    errors.push("labels.json must contain at least one label");
  }
  const seen = new Set();
  for (const [index, label] of definitions.entries()) {
    const where = `labels[${index}]`;
    if (!label || typeof label !== "object") {
      errors.push(`${where} must be an object`);
      continue;
    }
    if (typeof label.name !== "string" || label.name.trim() === "") {
      errors.push(`${where}.name must be a non-empty string`);
      continue;
    }
    const key = label.name.trim().toLowerCase();
    if (seen.has(key)) {
      errors.push(`duplicate label name: ${label.name}`);
    }
    seen.add(key);
    if (!/^[0-9a-f]{6}$/.test(normalizeColor(label.color))) {
      errors.push(`${where}.color must be a 6-digit hex color (${label.name})`);
    }
    if (typeof label.description !== "string" || label.description.trim() === "") {
      errors.push(`${where}.description must be non-empty (${label.name})`);
    } else if (label.description.length > 100) {
      errors.push(`${where}.description must be <= 100 chars (${label.name})`);
    }
  }
  return errors;
}

export function loadLabelDefinitions(filePath = defaultConfig) {
  const definitions = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const errors = validateLabelDefinitions(definitions);
  if (errors.length) {
    throw new Error(`Invalid label definitions:\n- ${errors.join("\n- ")}`);
  }
  return definitions.map((label) => ({
    name: label.name.trim(),
    color: normalizeColor(label.color),
    description: label.description.trim(),
  }));
}

export function diffLabels(current, desired) {
  const currentByName = new Map(
    (Array.isArray(current) ? current : []).map((label) => [
      String(label.name || "").toLowerCase(),
      {
        name: label.name,
        color: normalizeColor(label.color),
        description: String(label.description || "").trim(),
      },
    ]),
  );
  const plan = { create: [], update: [], unchanged: [], deletes: [] };
  for (const label of desired) {
    const existing = currentByName.get(label.name.toLowerCase());
    if (!existing) {
      plan.create.push(label);
    } else if (
      existing.color !== normalizeColor(label.color) ||
      existing.description !== label.description.trim()
    ) {
      plan.update.push(label);
    } else {
      plan.unchanged.push(label);
    }
  }
  return plan;
}

function ghLabelList() {
  const output = execFileSync(
    "gh",
    ["label", "list", "--limit", "200", "--json", "name,color,description"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return JSON.parse(output);
}

function printPlan(plan) {
  console.log(
    `[labels] create=${plan.create.length} update=${plan.update.length} unchanged=${plan.unchanged.length} deletes=0`,
  );
  for (const label of plan.create) {
    console.log(`[labels] + ${label.name} #${label.color}`);
  }
  for (const label of plan.update) {
    console.log(`[labels] ~ ${label.name} #${label.color}`);
  }
}

function applyPlan(plan) {
  for (const label of plan.create) {
    execFileSync(
      "gh",
      ["label", "create", label.name, "--color", label.color, "--description", label.description],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }
  for (const label of plan.update) {
    execFileSync(
      "gh",
      ["label", "edit", label.name, "--color", label.color, "--description", label.description],
      { cwd: repoRoot, stdio: "inherit" },
    );
  }
}

function usage() {
  console.log(`Usage: node scripts/sync-labels.mjs [--apply] [--check] [--json]

  default   Dry-run: show what would be created/updated.
  --apply   Create/update managed labels with gh. Never deletes unmanaged labels.
  --check   Exit 2 when managed labels drift from .github/labels.json.
  --json    Print the plan as JSON (implies dry-run unless --apply is also set).`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const apply = args.includes("--apply");
  const check = args.includes("--check");
  const asJson = args.includes("--json");
  const definitions = loadLabelDefinitions();
  const current = ghLabelList();
  const plan = diffLabels(current, definitions);

  if (asJson) {
    console.log(JSON.stringify({ ...plan, apply, check }, null, 2));
  } else {
    printPlan(plan);
  }

  if (check) {
    if (plan.create.length || plan.update.length) {
      console.error("[labels] drift detected; run npm run labels:sync -- --apply");
      process.exitCode = 2;
    }
    return;
  }

  if (apply) {
    applyPlan(plan);
    console.log("[labels] applied; unmanaged labels were left untouched");
  } else {
    console.log("[labels] dry-run only; pass --apply to write changes");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[labels] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
