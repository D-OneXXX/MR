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
npm run test:release
npm run status
npm run labels:check   # requires gh auth and labels already applied
```

`npm run test:release` checks the release surface that CI cannot see at runtime:
product identity, NSIS targets/languages, updater public key, independent Windows/Linux
update endpoints, the Linux updater-manifest generator (including its failure paths), and
the public manifest verifier (`scripts/verify-updater-manifest.mjs`). SQLite
upgrade/rollback compatibility is covered by `cargo test --lib`
(`legacy_library_file_migrates_without_data_loss`, `newer_schema_version_is_not_downgraded`).
Real NSIS install/upgrade/rollback is covered by
`.github/workflows/release-install-verify.yml` on a GitHub-hosted `windows-2022`
ephemeral VM; the v0.17.2 evidence is recorded in
[dev/PHASE5_WINDOWS_RELEASE_ACCEPTANCE.md](dev/PHASE5_WINDOWS_RELEASE_ACCEPTANCE.md).
A local interactive desktop VM remains BLOCKED on this host — see
[dev/RELEASE.md](dev/RELEASE.md).

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

## `visual:theme-token` observation (watch list)

`visual:theme-token` (background token per locale × theme) failed **once** as a P2 during a
concurrent-load local run: the computed `--sh-background` value was read before the requested
theme was applied, so the assertion compared against the previous theme's token.

Evidence and current status:

- Definition: `tests/qa/suites/visual.mjs` (12 assertions = 6 locales × light/dark).
- Since that observation the check has passed in **every** subsequent run: 12/12 locally on the
  clean candidate tree, 12/12 in hosted QA run `40324223701` (230/230, P0–P3=0), and 12/12 in the
  standalone visual re-run.
- The hosted history shows the only recent QA failure was a *different* check
  (`cache:clear-isolated`, P1, commit `463a5ed`), which was fixed separately.

Treat it as a watch-list item, not a known failure: do not lower the assertion. If it recurs,
open an issue with the QA artifact (locale, theme, expected/actual token) and the run id, then
look at the theme-apply → token-read ordering in the harness before touching the product CSS.

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
- `.github/workflows/release-candidate.yml` / `release-candidate-linux.yml` — manual
  (`workflow_dispatch`) candidate builds: they verify tag/version/QA-evidence binding, build and
  sign, and create a **Draft** release with `rc-record.json`. They never publish.
- `.github/workflows/release-install-verify.yml` — manual (`workflow_dispatch`), clean
  GitHub-hosted `windows-2022` install/upgrade/rollback verification. It downloads the Draft
  read-only, binds the installer to `rc-record.json` (tag + Commit + SHA-256), runs a fresh
  install and a 0.17.1 → 0.17.2 upgrade/rollback with a synthetic library/progress and
  `list_books` IPC check, self-checks the evidence gate, and uploads evidence artifacts. It never
  writes or publishes a Release. The publish workflow verifies the recorded run online with
  `verify-provenance.mjs`.
- `.github/workflows/release-publish.yml` / `release-publish-linux.yml` — manual
  (`workflow_dispatch`) publication: they re-verify the binding, fetch the official minisign to
  verify the artifact signature, and require the clean-environment install/upgrade evidence before
  turning the Draft into a public release.
- `.github/workflows/release-rehearsal.yml` — secret-free rehearsal of the release state machine
  (candidate → Draft → approval binding → publish → recovery → concurrency → manifest safety →
  cross-channel → evidence gate). It runs on every push and pull request.

## Clean Windows VM install verification

The release gate requires an `install-verification.json` produced on a clean Windows VM, not on a
shared development host. Two sources are accepted, both with machine-checkable provenance:

- **GitHub-hosted `windows-2022` runner (recommended)**:
  `gh workflow run release-install-verify.yml --ref main -f tag=v0.17.2 -f previous_tag=v0.17.1 -f previous_version=0.17.1`.
  The workflow downloads the Draft read-only, validates `rc-record.json` and every artifact
  SHA-256, runs a fresh install and an upgrade/rollback pair, writes a synthetic library
  (`page_count=3`, `current_page=2`, `scroll_pct=0.5`, two `reading_log` rows totaling 3 pages),
  reads it back through the app's real `list_books` IPC, and self-checks
  `verify-evidence.mjs`. It uploads `install-verification.json`, logs, and `run-manifest.json`
  as Actions artifacts; it never writes the Draft.
- **A disposable local Windows VM**: run
  `scripts/release-smoke/windows-install-upgrade.ps1` with `-CleanEnvironment`, `-Hypervisor`,
  `-VmId`, `-VmImageSha256`, `-VmStartedAt`, and the isolated `-DataDirForApp`. The evidence
  records `provenance.kind=local-vm`; the maintainer must verify the image hash and VM log.

The evidence must include:

- `artifactSha256 === expectedArtifactSha256`, plus `previousVersion` /
  `previousArtifactSha256` for the upgrade pass;
- `machine.cleanEnvironment=true`, `machine.image`, and `machine.provenance`;
- `library.quickCheck=ok`, a non-decreasing schema version, the synthetic book/progress,
  `readingLogPages>0`, and `library.ipc` matching `books[0]` (`list_books`).

After reviewing the workflow artifact, upload it to the Draft:

```bash
gh release upload vX.Y.Z install-verification.json --clobber
```

Do not substitute an earlier build's receipt: the version, Commit, and artifact SHA-256 must match
the Draft's `rc-record.json`. The publish workflow rejects old shared-host receipts
(`cleanEnvironment=false`) and receipts without provenance/library; for GitHub-hosted evidence it
also verifies online that the recorded run is a real successful `workflow_dispatch` run on `main`.
Local-VM evidence prints a manual-verification requirement instead.

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

> Phase 4 removed every tag-push release trigger. Pushing a `v*` tag only creates the ref;
> it does not build or publish. A formal release is a manual candidate → Draft → Environment
> approval → publish flow with binding, signature, and clean-VM evidence checks.

Production `npm audit --omit=dev --audit-level=high` is blocking in both CI jobs.
`cargo audit` is blocking on Linux with documented exceptions for the updater's
zip 4.6.1 extract advisories (NSIS updates do not use the `.zip` path) and the
accepted glib 0.18.5 risk (#18). Unmaintained/unsound warnings remain visible.
Do not add an ignore without a TECHNICAL/issue record and a review trigger.

The manual Windows/Linux smoke checklist is kept at
[docs/dev/smoke-test.md](dev/smoke-test.md).
