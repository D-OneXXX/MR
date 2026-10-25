import test from "node:test";
import assert from "node:assert/strict";
import {
  isAutomationPr,
  parseIssueReferences,
  validatePrMetadata,
} from "./pr-governance.mjs";

const validBody = `## 关联 Issue

Refs #19

## 验证

- npm run test:governance

## 数据与隐私

- 不涉及数据库或用户数据。

## 发布影响

- 不触发发布。
`;

function validMetadata(overrides = {}) {
  return {
    authorLogin: "D-OneXXX",
    headRefName: "chore/19-pr-governance",
    baseRefName: "main",
    title: "chore(governance): test",
    body: validBody,
    isDraft: false,
    ...overrides,
  };
}

test("parseIssueReferences accepts Closes, Fixes, Resolves and Refs", () => {
  assert.deepEqual(
    parseIssueReferences("Closes #12\nFixes #13\nResolves #14\nRefs #15"),
    [12, 13, 14, 15],
  );
  assert.deepEqual(parseIssueReferences("no issue here"), []);
  assert.deepEqual(parseIssueReferences("closes: #16\nrefs #16"), [16]);
});

test("isAutomationPr skips Dependabot and other bots", () => {
  assert.equal(
    isAutomationPr({
      authorLogin: "app/dependabot",
      headRefName: "dependabot/npm_and_yarn/react-1",
    }),
    true,
  );
  assert.equal(
    isAutomationPr({
      authorLogin: "github-actions[bot]",
      headRefName: "chore/19-bot",
    }),
    true,
  );
  assert.equal(
    isAutomationPr({
      authorLogin: "D-OneXXX",
      headRefName: "dependabot/npm_and_yarn/react-1",
    }),
    true,
  );
  assert.equal(
    isAutomationPr({
      authorLogin: "D-OneXXX",
      headRefName: "chore/19-pr-governance",
    }),
    false,
  );
});

test("validatePrMetadata accepts a compliant PR", () => {
  assert.deepEqual(validatePrMetadata(validMetadata()), []);
});

test("validatePrMetadata skips automation PRs even without sections", () => {
  const errors = validatePrMetadata(
    validMetadata({
      authorLogin: "app/dependabot",
      headRefName: "dependabot/npm_and_yarn/react-1",
      body: "Bumps react from 1 to 2.",
    }),
  );
  assert.deepEqual(errors, []);
});

test("validatePrMetadata requires an issue link", () => {
  const errors = validatePrMetadata(
    validMetadata({ body: validBody.replace("Refs #19", "No reference") }),
  );
  assert.ok(errors.some((error) => error.includes("issue-link")));
});

test("validatePrMetadata requires the branch issue number to match the linked issue", () => {
  const errors = validatePrMetadata(
    validMetadata({ headRefName: "chore/20-pr-governance" }),
  );
  assert.ok(errors.some((error) => error.includes("branch-issue-mismatch")));
});

test("validatePrMetadata rejects invalid branch names", () => {
  const errors = validatePrMetadata(
    validMetadata({ headRefName: "feature/19-pr-governance" }),
  );
  assert.ok(errors.some((error) => error.includes("branch-name")));
});

test("validatePrMetadata requires verification, data and release sections", () => {
  const errors = validatePrMetadata(
    validMetadata({
      body: validBody
        .replace(/## 验证[\s\S]*?(?=## 数据与隐私)/, "")
        .replace(/## 数据与隐私[\s\S]*?(?=## 发布影响)/, "")
        .replace(/## 发布影响[\s\S]*$/, ""),
    }),
  );
  assert.ok(errors.some((error) => error.includes("section:验证")));
  assert.ok(errors.some((error) => error.includes("section:数据与隐私")));
  assert.ok(errors.some((error) => error.includes("section:发布影响")));
});

test("validatePrMetadata rejects a non-main base branch", () => {
  const errors = validatePrMetadata(validMetadata({ baseRefName: "release/0.17" }));
  assert.ok(errors.some((error) => error.includes("base-branch")));
});

test("validatePrMetadata accepts multiple issue references when the branch matches one", () => {
  const errors = validatePrMetadata(
    validMetadata({
      body: validBody.replace("Refs #19", "Closes #19\nRefs #15"),
    }),
  );
  assert.deepEqual(errors, []);
});
