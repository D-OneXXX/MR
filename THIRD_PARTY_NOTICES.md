# Third-party notices

Moyu bundles or links the components listed below. The project’s own license
(PolyForm Noncommercial 1.0.0) is separate from these third-party licenses; see
[LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

This file covers bundled visual assets, direct runtime dependencies, and the CA infrastructure's
crypto stack (including the listed transitive crates). Other transitive dependencies retain their
upstream licenses and notices. The exact dependency graph is recorded in `package-lock.json` and
`src-tauri/Cargo.lock`.

## Bundled visual assets

### Plus Jakarta Sans Variable

- **Used for:** the application UI font.
- **Copyright:** Copyright 2020 The Plus Jakarta Sans Project Authors
  (https://github.com/tokotype/PlusJakartaSans).
- **License:** SIL Open Font License 1.1.
- **Full text:** [docs/licenses/OFL-1.1.txt](docs/licenses/OFL-1.1.txt).

### Lucide icons

- **Used for:** interface icons.
- **Copyright:** Portions of Lucide are held by Cole Bemis 2013–2022 as part of Feather (MIT).
  All other copyright is held by Lucide Contributors 2022.
- **License:** ISC.
- **Full text:** [docs/licenses/ISC.txt](docs/licenses/ISC.txt).

### Application icon and documentation artwork

The Moyu application icon, favicon, and README screenshots are original project assets.
The README screenshots use original synthetic comic pages generated for this repository; no
third-party manga artwork is bundled.

### PDF.js runtime assets

- **Used for:** rendering local PDF documents inside the application window.
- **Components:** the `pdfjs-dist` legacy build (`pdf.min.mjs`, `pdf.worker.min.mjs`), plus the
  `cmaps/` and `standard_fonts/` data directories copied into the application bundle.
- **Copyright:** Copyright Mozilla Foundation and PDF.js contributors.
- **License:** Apache-2.0.
- **Full text:** [docs/licenses/Apache-2.0.txt](docs/licenses/Apache-2.0.txt).

The WebAssembly components of PDF.js (`openjpeg.wasm`, `jbig2.wasm`, `qcms_bg.wasm`) and the
`quickjs-eval` document-script sandbox are **not** bundled: the first group would require relaxing
the Content Security Policy with `wasm-unsafe-eval`, and the sandbox would allow embedded PDF
JavaScript to run, which the project's security policy forbids.

## Frontend runtime dependencies

| Package | License | Notes |
|---|---|---|
| `@base-ui/react` | MIT | Copyright (c) 2019 Material-UI SAS |
| `@fontsource-variable/plus-jakarta-sans` | OFL-1.1 | Font asset; see above |
| `@tauri-apps/api` | Apache-2.0 OR MIT | Tauri frontend API |
| `@tauri-apps/plugin-dialog` | MIT OR Apache-2.0 | Dialog plugin |
| `@tauri-apps/plugin-opener` | MIT OR Apache-2.0 | Opener plugin |
| `@tauri-apps/plugin-updater` | MIT OR Apache-2.0 | Updater plugin |
| `class-variance-authority` | Apache-2.0 | UI variant helper |
| `cn` | MIT | Copyright (c) 2026 shadcn |
| `lucide-react` | ISC | Icon set; see above |
| `pdfjs-dist` | Apache-2.0 | Mozilla PDF.js 6.4.299; in-WebView PDF rendering (see below) |
| `react`, `react-dom` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| `react-router-dom` | MIT | Routing |
| `tailwindcss`, `@tailwindcss/vite`, `tw-animate-css` | MIT | Styling and animation tooling |
| `shadcn` | MIT | Build-time component tooling; not a runtime renderer |

## Rust direct dependencies

| Crates | License expression |
|---|---|
| `base64`, `chrono`, `dirs`, `hex`, `image`, `jpeg-decoder`, `libc`, `parking_lot`, `percent-encoding`, `regex`, `reqwest`, `serde`, `serde_json`, `sha2`, `tauri`, `tauri-build`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-single-instance`, `tauri-plugin-updater`, `thiserror`, `ureq`, `url`, `windows` | MIT OR Apache-2.0 (Tauri packages: Apache-2.0 OR MIT) |
| `encoding_rs` | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| `lru`, `minisign-verify`, `rusqlite`, `sysinfo`, `tokio`, `zip` | MIT |
| `argon2`, `chacha20poly1305`, `rand`, `rcgen`, `rustls-pki-types`, `time`, `x509-parser`, `zeroize` | MIT OR Apache-2.0 (RustCrypto crates: Apache-2.0 OR MIT) |
| `rustls-webpki` | ISC |
| `http-body-util`, `hyper`, `hyper-util` | MIT |
| `if-addrs` | MIT OR BSD-3-Clause |
| `rustls` | Apache-2.0 OR ISC OR MIT |
| `tokio-rustls` | MIT OR Apache-2.0 |

### CA infrastructure dependencies (W7-CA)

Versions are the resolved versions in `src-tauri/Cargo.lock`; the license expression is the
crate's declared `license` metadata. "Transitive" means it is not declared directly in
`src-tauri/Cargo.toml` but is still linked into the application through the CA stack.

| Crate | Version | License | Role |
|---|---|---|---|
| `rcgen` | 0.14.10 | MIT OR Apache-2.0 | Certificate/key generation (P-256, X.509) |
| `rustls-webpki` | 0.103.16 | ISC | Chain and name verification |
| `rustls-pki-types` | 1.15.1 | MIT OR Apache-2.0 | Shared certificate/key types |
| `x509-parser` | 0.18.1 | MIT OR Apache-2.0 | Certificate parsing, extension checks, signature verification |
| `argon2` | 0.5.3 | MIT OR Apache-2.0 | Argon2id KDF for the AEAD backup |
| `chacha20poly1305` | 0.10.1 | Apache-2.0 OR MIT | XChaCha20-Poly1305 AEAD |
| `zeroize` | 1.9.0 | Apache-2.0 OR MIT | Wiping private key and derived key buffers |
| `rand` | 0.8.8 (direct); 0.10.3 (transitive) | MIT OR Apache-2.0 | OS randomness for salts and nonces |
| `time` | 0.3.55 | MIT OR Apache-2.0 | Validity windows and clock injection |
| `ring` | 0.17.14 | Apache-2.0 AND ISC | Transitive crypto backend (via rcgen/webpki) |
| `pem` | 4.0.0 | MIT | Transitive PEM encoding/decoding |
| `aead` | 0.5.2 | MIT OR Apache-2.0 | Transitive AEAD trait layer |
| `password-hash` | 0.5.0 | MIT OR Apache-2.0 | Transitive password-hash trait layer |

All listed licenses are permissive (MIT, ISC, Apache-2.0, BSD-3-Clause) and compatible with the
project's PolyForm Noncommercial 1.0.0 license. No GPL/AGPL/SSPL or other copyleft dependency is
introduced by the CA or W7-TLS stacks.

### W7-TLS transport dependencies

The TLS transport slice adds a real HTTPS listener using the CA-issued leaf. The listener is not
started by application startup, commands, or UI in this slice.

| Crate | Version | License | Role |
|---|---|---|---|
| `rustls` | 0.23.46 | Apache-2.0 OR ISC OR MIT | TLS 1.2/1.3 server |
| `tokio-rustls` | 0.26.6 | MIT OR Apache-2.0 | Tokio TLS acceptor |
| `hyper` | 1.11.1 | MIT | HTTP/1.1 server |
| `hyper-util` | 0.1.21 | MIT | Tokio I/O adapter |
| `http-body-util` | 0.1.5 | MIT | Empty response bodies |
| `pem` | 4.0.0 | MIT | Direct PEM decoding for W7-TLS leaf material (also present transitively in the CA stack) |
| `if-addrs` | 0.15.0 | MIT OR BSD-3-Clause | Private LAN IPv4 enumeration for SANs |
| `httpdate` | 1.0.3 | MIT OR Apache-2.0 | Transitive HTTP date handling |

License texts used by these components are included under [docs/licenses](docs/licenses):

- [MIT](docs/licenses/MIT.txt)
- [Apache-2.0](docs/licenses/Apache-2.0.txt)
- [ISC](docs/licenses/ISC.txt)
- [OFL-1.1](docs/licenses/OFL-1.1.txt)
- [BSD-3-Clause](docs/licenses/BSD-3-Clause.txt)

## Notes for distributors

- Keep this file, `LICENSE`, `NOTICE.md`, and the `docs/licenses/` directory with binary
  distributions where their licenses require notice retention.
- The Windows installer is not Authenticode-signed. The Tauri updater signature is a separate
  control and does not replace code signing.
- Do not add third-party manga artwork, publisher logos, or scanlation assets to this
  repository or its release assets.
