import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffLabels,
  loadLabelDefinitions,
  validateLabelDefinitions,
} from "./sync-labels.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, ".github", "labels.json");

const requiredNames = [
  "status:new",
  "status:triaged",
  "status:reproducing",
  "status:in-progress",
  "status:testing",
  "status:review",
  "status:merged",
  "status:release-pending",
  "status:released",
  "status:verified",
  "status:closed",
  "status:blocked",
  "status:duplicate",
  "status:cannot-reproduce",
  "status:wont-fix",
  "status:reopened",
  "severity:p0",
  "severity:p1",
  "severity:p2",
  "severity:p3",
  "severity:p4",
  "area:library",
  "area:reader",
  "area:online",
  "area:updater",
  "area:database",
  "area:security",
  "area:release",
  "release:blocker",
];

test("repository label definitions are valid and contain the lifecycle contract", () => {
  const definitions = loadLabelDefinitions(configPath);
  assert.ok(Array.isArray(definitions));
  const names = new Set(definitions.map((label) => label.name));
  for (const name of requiredNames) {
    assert.ok(names.has(name), `missing label ${name}`);
  }
  assert.deepEqual(validateLabelDefinitions(definitions), []);
});

test("validateLabelDefinitions rejects duplicate names, invalid colors and empty descriptions", () => {
  const errors = validateLabelDefinitions([
    { name: "status:new", color: "0e8a16", description: "New issue" },
    { name: "status:new", color: "nothex", description: "" },
  ]);
  assert.ok(errors.some((error) => error.includes("duplicate")));
  assert.ok(errors.some((error) => error.includes("color")));
  assert.ok(errors.some((error) => error.includes("description")));
});

test("diffLabels plans create, update and unchanged without deleting unmanaged labels", () => {
  const current = [
    { name: "status:new", color: "ededed", description: "Old" },
    { name: "status:triaged", color: "fbca04", description: "Triaged" },
    { name: "bug", color: "d73a4a", description: "Something isn't working" },
  ];
  const desired = [
    { name: "status:new", color: "0e8a16", description: "New" },
    { name: "status:triaged", color: "fbca04", description: "Triaged" },
    { name: "status:blocked", color: "b60205", description: "Blocked" },
  ];

  const plan = diffLabels(current, desired);

  assert.deepEqual(plan.create.map((label) => label.name), ["status:blocked"]);
  assert.deepEqual(plan.update.map((label) => label.name), ["status:new"]);
  assert.deepEqual(plan.unchanged.map((label) => label.name), ["status:triaged"]);
  assert.deepEqual(plan.deletes, []);
});
