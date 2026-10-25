# Testing

MangaReader uses layered checks so a release is validated without touching a real library.

The CDP harness uses Node’s global `WebSocket`, so run the QA suite with **Node.js 22+**.
The CI workflows pin Node 22 for this reason.

## Quick verification

```bash
npm run version:check
npm run test:version
npx tsc --noEmit
npm run build
node tests/qa/run-qa.mjs --suite=static
```

## Governance checks

```bash
npm run test:governance
npm run status
npm run labels:check   # requires gh auth and labels already applied
```

`npm run status` writes `docs/PROJECT_STATE.md`; it is generated and must not be
hand-edited. `npm run labels:check` never changes remote labels; use
`npm run labels:sync -- --apply` only from a maintainer account. The workflow
rules live in [ENGINEERING_WORKFLOW.md](ENGINEERING_WORKFLOW.md).

## Rust checks

```bash
cargo test --lib --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --test e2e_stage1 --test memory_budget
```

Linux builds also run `cargo check --all-targets` and
`cargo clippy --all-targets -- -D warnings` on `ubuntu-22.04`, because Windows hosts skip
Linux-only `cfg` blocks.

## QA harness

The QA harness lives in `tests/qa/`.

```bash
node tests/qa/run-qa.mjs                 # full suite
node tests/qa/run-qa.mjs --suite=static  # fast static/version guards
```

Suites include static architecture guards, reader behavior, online fixtures, cache behavior,
privacy/redaction checks, visual layout checks, and chaos/recovery checks. Reports are written
under `tests/qa/reports/` and are ignored by Git.

Two checks guard long-list overflow: `visual:rules-list-bounded` seeds 30 synthetic
online-filter rules and asserts the list stays inside its card and scrolls internally, while
`static:scroll-area-bounds` keeps the scroll-area height contract (`max-h-[inherit]` on the
viewport, `overflow-hidden` on the root) from regressing.

The harness starts the application with isolated directories:

- `MR_DATA_DIR`
- `MR_RENDER_CACHE_DIR`
- `MR_ONLINE_CACHE_DIR`
- a dedicated WebView2 user-data folder

It refuses to continue if the isolated database already contains books. **Never point the
harness at a real library or share a database path with the normal application profile.**

## What to include in a failure report

- Command and suite name.
- First failing check ID and the file/line it references.
- The relevant portion of the QA report.
- App version, platform, and whether the run used a release or debug binary.

Remove personal paths, book titles, cookies, tokens, and full private URLs before sharing logs.

## CI gates

- `.github/workflows/ci-windows-check.yml` — version gate, TypeScript, production build,
  Rust unit and integration tests, governance tests, and static QA.
- `.github/workflows/ci-linux-check.yml` — Linux `cfg` compilation, clippy, Rust tests,
  xvfb-backed integration tests, governance tests, and visible dependency-audit reports.
- `.github/workflows/ci-pr-governance.yml` — required PR metadata gate: linked issue,
  branch issue number, verification/data/release sections, and main-only base. Dependabot
  and Renovate PRs are skipped.
- `.github/workflows/release-windows.yml` — full QA before signing/publishing NSIS artifacts.
- `.github/workflows/release-linux-critical.yml` — critical-fix Linux channel.

> Phase 1–3: the release workflows still publish directly from a tag push. Do not push
> any `v*` tag until Phase 4 replaces them with Draft + approval.

Dependency-audit steps are currently visible reports rather than hard blockers. Triage results
before a release; do not disable a failing guard just to make the pipeline green.

The manual Windows/Linux smoke checklist is kept at
[docs/dev/smoke-test.md](dev/smoke-test.md).
