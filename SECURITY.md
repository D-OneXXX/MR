# Security Policy

## Supported versions

Security fixes are applied to the latest published Moyu release.

- **Windows** follows the regular release channel.
- **Linux** follows the long-term critical-fix channel for high-severity security and
  crash-level issues.

Older releases may continue to work, but they do not receive security updates.

## Reporting a vulnerability

Please use GitHub’s private vulnerability reporting:

**https://github.com/D-OneXXX/MR/security/advisories/new**

Do not open a public issue for a vulnerability, and do not publish proof-of-concept details
before a fix is available.

A useful report includes:

- Moyu version and build origin (shown in **Settings → About & maintenance**).
- Operating system and package type (NSIS, deb, rpm, or AppImage).
- A clear description of the impact and affected component.
- Minimal reproduction steps.
- Whether the issue requires a malicious local file, a malicious remote URL, or user action.

Please remove the following before submitting:

- Personal directory paths and book titles.
- Cookies, authorization headers, tokens, or session values.
- Full URLs that contain private query parameters.
- Contents of your library or diagnostic snapshots that are not necessary to explain the issue.

## Scope

Reports are especially useful for:

- The updater, release signature verification, and update staging.
- Archive parsing, path handling, and local file deletion boundaries.
- Online fetching, redirect handling, and SSRF protections.
- The embedded browser window and navigation restrictions.
- Session-header handling and diagnostic/log redaction.
- Capability permissions and CSP regressions.

Reports are reviewed on a best-effort basis. This policy does not create a service-level
agreement or authorize testing against systems or data you do not own.

## Thank you

Good-faith reports help keep local-first reading safe. Please include only the minimum data
needed to reproduce the issue.
