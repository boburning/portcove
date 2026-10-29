# Pinned Tauri transport fixtures

These three unmodified runtime files (`.js.txt`) come from the locally installed Cargo
registry package `tauri 2.11.6`, `scripts/`. All three SHA-256 identities were
also verified unchanged against the Cargo.lock-pinned `tauri 2.12.3` package
downloaded by `cargo fetch --locked` on 2026-10-13. The historical directory
and fixture bytes remain intact. Their original Commons Conservancy
copyright and Apache-2.0/MIT SPDX notices are retained. They are test fixtures,
not a shipped runtime or a replacement transport. The text suffix prevents
automatic formatting or accidental runtime imports from changing their bytes.

On 2026-10-16 all three files were reverified byte-for-byte against the
Cargo.lock-pinned `tauri 2.12.4` archive and its installed registry source. The
archive SHA-256 matches Cargo.lock; fixture bytes and existing hash pins remain
unchanged. The installed API's `core.js` and tslib hashes also remain unchanged.

On 2026-10-28 all three files were reverified byte-for-byte against the
Cargo.lock-pinned `tauri 2.12.5` archive. Its SHA-256 matches Cargo.lock;
fixture bytes, transport hash pins and the installed API remain unchanged.

`desktop-owned-ipc-probe-check.mts` verifies their SHA-256 identities and the
Cargo lock version before evaluating them. It supplies only inert platform/key
template values and wires the actual runtime's `postMessage` into `ipc`.
The current verifier requires `tauri 2.12.5` in Cargo.lock.
The installed `@tauri-apps/api 2.12.4` module supplies the real `invoke` and
`Channel`; its source hash and package version are independently pinned too.
An upgrade must deliberately reconcile these fixtures and assertions.

The hash-pinned API is evaluated in the same isolated VM. Its single tslib
import is supplied from the independently hash-pinned installed module, and its
single export list exposes the actual functions to the controls. The VM observes
scheduled handler errors without installing process-global error hooks. Controls
assert the two deliberately throwing handler errors, continued message indexing,
positive callback cleanup and invoke settlement; unexpected errors fail every case.

Fallback and unrelated native dispatch are spied and inert. These tests observe
actual callback removal and invoke settlement; they do not prove WebView,
backend discovery, mutation, native cancellation, or physical UI behavior.
