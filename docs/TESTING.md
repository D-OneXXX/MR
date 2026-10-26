# Testing

MangaReader uses layered checks so a release is validated without touching a real library.

The CDP harness uses Node’s global `WebSocket`, so run the QA suite with **Node.js 22+**.
The CI workflows pin Node 22 for this reason.

## Quick verification

```bash
npm run version:check
npm run test:version
npm run test:fixtures
npx tsc --noEmit
npm run build
npm run format:check
node tests/qa/run-qa.mjs --suite=static
```

`npm run format:check` is a read-only `cargo fmt --check`: it never rewrites the tree.
`npm run test:fixtures` guards the QA fixtures themselves (for example, the
ultra-tall webtoon fixture must stay a **ramp**: a solid-color image would make every
slice byte-identical and turn the "multiple distinct slices" assertion invalid — Issue #32).

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

## Chaos/CDP flake status

Full QA previously failed intermittently in the chaos safe-mode/freeze stages with a
`CDP Runtime.enable/evaluate timeout` after the heavy suites. This was tracked in #23 and is
now mitigated:

- `reconnectMain` retries only CDP timeouts, up to 3 attempts.
- Recovery-window cleanup treats a timed-out close command as success only when the recovery
  target has actually disappeared.
- The fixes were verified with 3 consecutive chaos runs (31/31 each) and 3 consecutive
  complete QA runs (228/228 each, P0–P3=0).

Do not skip the chaos suite or weaken assertions. If the timeout recurs, reopen #23 with the
QA artifact; the release workflow still retries the complete QA once as a coarse fallback.

## What to include in a failure report

- Command and suite name.
- First failing check ID and the file/line it references.
- The relevant portion of the QA report.
- App version, platform, and whether the run used a release or debug binary.

Remove personal paths, book titles, cookies, tokens, and full private URLs before sharing logs.

## CI gates

- `.github/workflows/ci-windows-check.yml` — version gate, TypeScript, production build,
  Rust unit and integration tests, governance tests, fixture unit tests, `cargo fmt --check`,
  and static QA.
- `.github/workflows/ci-linux-check.yml` — Linux `cfg` compilation, clippy, Rust tests,
  xvfb-backed integration tests, governance tests, fixture unit tests, `cargo fmt --check`,
  and blocking dependency audits.
- All workflows pin every action to a full 40-character commit SHA (version kept as a trailing
  comment). `static:actions-pinned` fails the build if a floating tag or branch reappears.
- `.github/workflows/ci-pr-governance.yml` — required PR metadata gate: linked issue,
  branch issue number, verification/data/release sections, and main-only base. Dependabot
  and Renovate PRs are skipped.
- `.github/workflows/qa-full.yml` — reusable/dispatchable release-candidate full QA. It runs
  version/governance/type/build/Rust/integration/clippy/audit gates and the Windows/WebView2
  full QA, then uploads `qa-evidence-<sha>` with reports and logs.
- `.github/workflows/release-windows.yml` — full QA before signing/publishing NSIS artifacts.
- `.github/workflows/release-linux-critical.yml` — critical-fix Linux channel.

## Full QA evidence

Run the exact release-candidate commit:

```bash
gh workflow run qa-full.yml -f ref=<commit-sha>
gh run watch <run-id>
```

The workflow checks out the requested ref, records its actual `git rev-parse HEAD`, and
uploads `qa-evidence-<sha>` on success or failure. A release candidate must reference that
artifact; do not substitute a hand-written local QA count. It has no access to signing
secrets and cannot publish a Release.

If hosted QA is blocked by a recorded platform issue (for example #42,
`chaos:rage-click` on windows-2022), use the controlled local attestation in
[LOCAL_QA_ATTESTATION.md](dev/LOCAL_QA_ATTESTATION.md). It still requires an exact Commit,
clean tree, complete suite, P0/P1=0, report hashes, environment details, and maintainer
approval; it does not authorize a release.

The full QA step runs the suite **once**. The earlier "one retry of the complete suite"
escape hatch was removed after the root cause of the `arch:ultra-tall-webtoon` failure was
identified and fixed (#32: the ultra-tall fixture was a solid-color image, so every slice
was byte-identical and the "distinct slices" assertion was measuring render width instead
of slicing). A retry would have masked real failures; any remaining failure now blocks the
job on the first attempt.

> Phase 1–3: the release workflows still publish directly from a tag push. Do not push
> any `v*` tag until Phase 4 replaces them with Draft + approval.

Production `npm audit --omit=dev --audit-level=high` is blocking in both CI jobs.
`cargo audit` is blocking on Linux with documented exceptions for the updater's
zip 4.6.1 extract advisories (NSIS updates do not use the `.zip` path) and the
accepted glib 0.18.5 risk (#18). Unmaintained/unsound warnings remain visible.
Do not add an ignore without a TECHNICAL/issue record and a review trigger.

The manual Windows/Linux smoke checklist is kept at
[docs/dev/smoke-test.md](dev/smoke-test.md).
