# Deferred campaign evidence

This record complements the live queue in [DEFERRED.md](DEFERRED.md). It distinguishes engineering checks from the user's physical observations. Local qualification libraries, owned sources, credentials, and generated artifacts are not repository fixtures.

## PCV-DEF-001 — Public GitHub App completed, 2026-09-03

- Registered the public [Portcove GitHub App](https://github.com/apps/portcove), owned by `boburning`, with device flow enabled, webhooks disabled, no added permissions, and no events. Homepage: `https://github.com/boburning/portcove`. Public app ID: `4813101`; public client ID: `Iv23liakfuffw2l9zB48`. No client secret or private key was generated.
- Core defaults to that public client ID. Explicit runtime and build overrides retain precedence; an explicitly empty override disables device login. Anonymous and environment-token modes remain available.
- The user authorized the CLI device flow. A fresh process with token environment variables removed read `credential_store`, `authenticated: true`, account `boburning`, and the 5,000-request allowance.
- The user confirmed the Settings connected-account display, reported that opening links works, and then confirmed "Logging out and back in worked." A fresh CLI process after that GUI login again read the operating-system credential store and authenticated as `boburning` (4,973 of 5,000 requests remaining at the check).
- The tested native desktop includes the public client ID and the browser handoff fix. Desktop SHA-256: `5eac1238fefbcf8a36648891452050d5bdf8eadd86be58369b4313c7c55b1366`. NSIS installer SHA-256: `5cf520ac20a367449388953b399635a31554b69dd8b3514920a0248a1c8f2cdf`. These are local build identities, not a signing or release-publication claim.
- Validation: Rust check, clippy and workspace tests; the Rust/TypeScript transport and child-process policy gates; 78 frontend tests, theme checks and Fallow; `just audit` completed with zero blocking rscheck findings and the existing advisory inherent-item cycle. Controller/browser fixes are committed in `0744a12`; source relinking is independently committed in `1268b6a`.

Remaining Settings edge-case qualification is tracked separately under `PCV-DEF-004`; the public App registration and actual CLI/GUI device login no longer depend on an external account setup action.

## Source relinking implemented

Commit `1268b6a` adds read-only relink planning and content-bound apply through core, CLI, and Tauri. It revalidates current source rules, preserves normalized source content identity, permits an offline old location, and refuses stale plans or changes while a dependent port is busy. Source registration and removal use the same cross-process profile/dependent-port locks. Three core regressions and a compiled CLI contract test cover successful relinking, changed bytes, stale registration, lock conflicts, and required plan arguments. This is one completed portability capability; it does not claim that library move/export/import is implemented.

## Controller and links: actual user observations

The initial Xbox test failed: invisible focus, unreliable actions, and no dependable sidebar return. The next build improved input handling but skipped short rows and account actions. Commit `0744a12` fixes those reports with nearest-row navigation, explicit control groups, a full-field search outline, matching 42-pixel header controls, clearer appearance copy, and the native browser bridge. The user's subsequent observations were "The controller feels much better" and "opening links also works." Remaining detailed modal/minimum-size observations stay explicit in `PCV-DEF-005`.
