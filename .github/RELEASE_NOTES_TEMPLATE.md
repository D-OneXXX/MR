<!--
Moyu public Release Notes template — mandatory for every Windows and Linux release.

How to use:
  1. Copy the copy-ready example below (everything between the mr:example markers)
     into the `release_notes` input of the release-candidate workflow.
     Empty notes are rejected for normal candidates: the updater manifest is generated
     during candidate creation from this exact text, so it must be final at that point.
     Only an explicitly marked Windows rehearsal run may fall back to a placeholder.
  2. Do not plan to paste the notes into the Draft body afterwards. Editing the Draft
     body alone does not regenerate `latest.json` / `latest-linux-critical.json`; the
     in-app updater keeps showing the original text. If the notes must change, re-run
     the candidate workflow for a new tag using the documented regeneration procedure.
  3. Write the complete English version first, then the complete Simplified Chinese version.
  4. Inside each language keep this order: one-sentence introduction, 3-5 update bullets,
     optional limitation/compatibility notes, download instructions.
  5. Both versions must carry the same features, the same limitations and the same downloads.
  6. The example below is checked by CI against the real validator:
       node scripts/release-governance/release-notes.mjs \
         --check-template .github/RELEASE_NOTES_TEMPLATE.md
     Keep it passing.

Keep out of public notes (they belong in release assets, Actions records or internal docs):
  - QA reports, pass counts, CI run identifiers
  - PR or Issue numbers, commit-by-commit logs, commit hashes
  - architecture and implementation details, content-security-policy directives,
    database migration internals, workflow permissions
  - approval records, provenance evidence, full artifact hash lists

`scripts/release-governance/release-notes.mjs` validates this structure. The candidate
workflow fails fast on an invalid body or on empty notes; the publish workflow refuses to
publish a Draft whose body or manifest notes do not comply. A copy with empty bullets is
intentionally invalid: fill it in.

The Windows publish workflow also compares the manifest notes with the approved body and
reports a warning when they diverge. That comparison is not a hard gate: the manifest is
frozen at candidate time and cannot be regenerated without a new candidate run.
-->

<!-- mr:example:start -->
Moyu is a free, local-first manga reader for Windows and Linux.

### What's new
- Reads local PDF files.
- Remembers your page.
- Ships six languages.

### Notes
- Encrypted PDFs are not supported.

### Download
- Windows: `MangaReader_0.19.0_x64-setup.exe`
- Linux: `.deb`, `.rpm`, `.AppImage`

## 简体中文

Moyu 是一款免费的本地优先漫画阅读器，支持 Windows 与 Linux。

### 更新内容
- 支持本地 PDF。
- 记住阅读页码。
- 提供六种语言。

### 说明
- 不支持加密 PDF。

### 下载
- Windows：`MangaReader_0.19.0_x64-setup.exe`
- Linux：`.deb`、`.rpm`、`.AppImage`
<!-- mr:example:end -->
