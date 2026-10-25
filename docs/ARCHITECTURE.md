# Architecture overview

MangaReader is a local-first desktop application built with Tauri 2, Rust, React, TypeScript,
and SQLite. This document is the English overview; detailed module notes live in
[TECHNICAL.md](TECHNICAL.md) (Chinese), and the binding engineering rules are in
[AGENTS.md](../AGENTS.md).

## Design goals

- Keep the library, reading progress, rules, and statistics on the local machine.
- Make network access user-initiated: online reading, update checks, and browser navigation.
- Keep destructive actions explicit and recoverable.
- Preserve progress when files move or a source disappears.
- Prefer deterministic, testable Rust code for parsing, caching, persistence, and security
  boundaries.

## Runtime shape

```text
main WebView (React)
  │  Tauri IPC
  ├─ SQLite library.db
  ├─ source/import pipeline
  ├─ render + online cache
  └─ online fetch / filtering

recovery WebView (React)
  └─ resilience + database recovery UI

browser WebView
  └─ user navigation; no IPC capability
```

- The **main** window hosts the library, reader, browser entry, and settings.
- The **recovery** window is an independent window used when the main window or database needs
  recovery. It never silently replaces the main window.
- The **browser** window is isolated from application IPC and accepts only `http` / `https`
  navigation. It must not navigate back to the application’s local origin.

## Local data

- Library metadata, progress, statistics, settings, and filter rules live in SQLite under
  Tauri’s `app_data_dir`.
- Database connections use WAL, a busy timeout, foreign keys, and normal synchronous mode.
- Schema versions move forward only; migrations and startup checks are part of the boot path.
- Rendered pages and online images share a bounded disk cache under `app_cache_dir`. Cache
  cleanup removes derived data only, never `library.db` or reading progress.
- Missing source files are marked and can be relocated. Relocation preserves progress,
  webtoon position, and reading statistics.

## Import and reading

- Local sources are image folders, ZIP, and CBZ. Entry names are decoded with a
  display/lookup split so legacy encodings do not reorder or lose pages.
- Page and chapter ordering is natural, numeric-aware, and stable across mixed extensions,
  nested folders, and leading zeroes.
- The reader offers single-page, double-page, RTL/LTR, and continuous webtoon layouts.
- Very tall webtoon images are sliced into bounded tiles before rendering; the frontend
  stitches them in order. A failed tile has a visible failure state, not an empty gap.
- Progress writes update the book row and reading log in one transaction.

## Online reading and the browser

- Online reading starts from a URL the user explicitly provides. There are no bundled manga
  sources or background crawlers.
- Fetches go through the Rust backend so request headers, redirects, SSRF checks, filtering,
  and caching are consistent.
- Session request headers are scoped by origin and can be kept in memory only. They are never
  written to SQLite, logs, diagnostics, or backups.
- The embedded browser is for user-driven navigation and download handoff. It has no IPC
  capability and cannot navigate to the application’s local origin.
- Online image filtering uses layered signals (URL/DOM, dimensions, sequence clustering, and
  site profiles). It is not a substitute for the user’s responsibility for the content they
  access.

## Privacy and diagnostics

- No account, cloud sync, or library upload flow exists.
- Diagnostics and prompt generation redact local paths, book names, session headers, and
  token-like query values before display or export.
- Backups contain a sanitized database snapshot and an explicit allowlist of preferences.
  They exclude image caches, online headers, proxies, cookies, filter events, and internal
  version markers.
- The application does not start a Python sidecar or background service.

## Updates

- Update checks are manual. The application does not silently restart, switch reading modes,
  or replace a running binary in memory.
- Windows follows the regular GitHub Releases channel and NSIS installer. Linux follows the
  critical-fix channel (deb/rpm/AppImage). System package installs are not replaced in place.
- Update manifests and artifacts are verified with the configured Tauri updater key. The
  Windows installer is not Authenticode-signed; the updater signature is a separate control.

## Security boundaries

- `src-tauri/capabilities/` grants only the permissions used by the main, recovery, and
  browser windows.
- The production CSP restricts scripts, styles, images, and IPC connections; the development
  CSP is relaxed only for the Vite dev server.
- Online URL and redirect handling rejects loopback, private, link-local, and metadata
  addresses in release builds.
- The repository’s static QA suite guards the capability surface, CSP profile, route fallbacks,
  storage sanitization, and other long-lived invariants.

## Repository map

| Path | Purpose |
|---|---|
| `src/` | React UI, reader, settings, i18n, diagnostics, and resilience |
| `src-tauri/src/` | Rust commands, database, import/render pipeline, online fetch, security, updates |
| `src-tauri/capabilities/` | Tauri permission boundaries per window |
| `tests/qa/` | Static, behavioral, visual, privacy, cache, online, and chaos checks |
| `docs/` | User-facing/testing/architecture docs and build assets |
| `docs/dev/` | Maintainer release and manual smoke-check runbooks |
| `scripts/` | Version, build, and release helpers |

See [TESTING.md](TESTING.md) for the verification workflow.
