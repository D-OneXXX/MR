# Testing

MangaReader uses layered checks so a release is validated without touching a real library.

## Quick verification

```bash
npm run version:check
npm run test:version
npx tsc --noEmit
npm run build
node tests/qa/run-qa.mjs --suite=static
```

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
  Rust unit and integration tests, static QA.
- `.github/workflows/ci-linux-check.yml` — Linux `cfg` compilation, clippy, Rust tests,
  xvfb-backed integration tests, and visible dependency-audit reports.
- `.github/workflows/release-windows.yml` — full QA before signing/publishing NSIS artifacts.
- `.github/workflows/release-linux-critical.yml` — critical-fix Linux channel.

Dependency-audit steps are currently visible reports rather than hard blockers. Triage results
before a release; do not disable a failing guard just to make the pipeline green.

The manual Windows/Linux smoke checklist is kept at
[docs/dev/smoke-test.md](dev/smoke-test.md).
