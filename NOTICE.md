# MangaReader — NOTICE

Required Notice: MangaReader (https://github.com/D-OneXXX/MR) — Copyright the MangaReader authors. Licensed under the PolyForm Noncommercial License 1.0.0 (see [`LICENSE`](./LICENSE)).

This file identifies the work covered by [`LICENSE`](./LICENSE) and spells out
the project's authorization boundary in plain language. Where this file and
the license differ, **the license prevails**.

## 1. What the license grants

Subject to the terms of the PolyForm Noncommercial License 1.0.0, individuals
and community members are granted, **at no charge**, the right to:

- view, study, and audit the source code;
- modify, patch, port, and adapt the software — in particular to adapt the
  Linux builds to any distribution, toolkit version, or CPU architecture;
- redistribute the original, modified, repackaged, or derivative versions,
  provided the distribution itself remains **noncommercial** and the license
  terms plus this notice travel along with every copy.

## 2. What the license forbids (Non-Commercial Only)

No individual, organization, or company may use this project — including
modified, repackaged, or derived versions — for any commercial purpose,
including but not limited to:

- selling the software or any derivative of it (one-time sale, paid license,
  paid download);
- offering it as (or inside) a paid subscription, paid tier, or paid service;
- bundling it with commercial promotion or distributing it as an added-value
  good of a commercial product;
- monetizing it with built-in advertisements, affiliate redirects, or data
  resale of any kind;
- deploying it internally to support commercial operations of a business
  ("commercial internal deployment").

Use by charities, schools, public research / safety / health / environmental
organizations, and government institutions is a permitted purpose under the
license regardless of funding.

## 3. Build origin fingerprint (Build Origin)

The application embeds a compile-time build fingerprint exposed in
**Settings → About & Maintenance** and in every exported diagnostics
snapshot ("Bug 诊断与 AI 排查提示词生成器"):

| Fingerprint | Meaning |
|---|---|
| `Official Release` | Built by the official release pipeline, which injects `MR_BUILD_ORIGIN=official` and signs updater artifacts with the official key. |
| `Community Modified Build (Non-Commercial)` | Built from community-modified sources (default when the official marker is absent — including local `tauri build` / `tauri dev`). |

The fingerprint exists so that bugs introduced by third-party modifications are
not misattributed to official builds. When reporting a bug, attach the
diagnostics snapshot so the build origin is unambiguous. Community builds
receive **no official updater signatures**; the community build script
(`npm run build:community`, see `docs/TECHNICAL.md`) disables updater artifact
generation automatically so unsigned local builds compile out of the box.

## 4. Update channels

- **Windows** is the primary platform and follows the regular channel
  (`latest.json`) for features and routine patches.
- **Linux** is a long-term-stability branch: the official channel for it
  (`latest-linux-critical.json`) delivers **only high-severity security and
  crash-level fixes**. Day-to-day feature work on Linux is expected to come
  from community noncommercial modifications.

## 5. Trademarks and identity

The product name `MangaReader`, the identifier `com.local.manga-reader`, and
the upgrade identity anchored by them (NSIS uninstall/upgrade keys, desktop
shortcuts, `.cbz`/`.zip` file associations) must not be reused in a way that
presents a community build as an official release. Community builds must keep
the `Community Modified Build` fingerprint intact (see §3).
