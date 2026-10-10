# Pinned Tauri transport fixtures

These three unmodified runtime files (`.js.txt`) come from the locally installed Cargo
registry package `tauri 2.11.6`, `scripts/`. Their original Commons Conservancy
copyright and Apache-2.0/MIT SPDX notices are retained. They are test fixtures,
not a shipped runtime or a replacement transport. The text suffix prevents
automatic formatting or accidental runtime imports from changing their bytes.

`desktop-owned-ipc-probe-check.mjs` verifies their SHA-256 identities and the
Cargo lock version before evaluating them. It supplies only inert platform/key
template values and wires the actual runtime's `postMessage` into `ipc`.
The installed `@tauri-apps/api 2.11.1` module supplies the real `invoke` and
`Channel`; its source hash and package version are independently pinned too.
An upgrade must deliberately reconcile these fixtures and assertions.

Fallback and unrelated native dispatch are spied and inert. These tests observe
actual callback removal and invoke settlement; they do not prove WebView,
backend discovery, mutation, native cancellation, or physical UI behavior.
