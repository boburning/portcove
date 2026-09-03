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

## Metadata export and library access lease

Core now produces a versioned metadata snapshot in one SQLite transaction, including source references, version/artifact identities, active/previous/staged state, settings, and launch history. It identifies application versions, user data, backups, and toolchains as separate content roots without embedding their bytes or credentials. The CLI exposes `library export` and `--output`; Settings exposes the same no-overwrite file publication through a native save dialog. Tests verify source preservation, no-overwrite behavior, and active/previous/staged identity preservation. Every open library also retains a shared OS lease until its last clone is dropped, establishing the exclusion boundary required for transfer.

`just check` and `just deep` passed at this checkpoint. Rscheck reported 14 advisory findings and zero blocking findings; cargo-modules reported the existing inherent-item cycle; Hawk 0.1.13 is unsupported on Windows and was skipped explicitly. Library move/import and their publication/recovery tests remain the next portability work; metadata export is not a completed transfer feature.

## Verified library moves and interruption recovery

Core move planning now binds metadata and content hashes, checks capacity and portable filesystem paths, and requires a fresh plan before mutation. Applying a move takes exclusive source/destination leases, retains the original, copies without overwriting existing files, rebases a SQLite snapshot, and verifies complete inventories, logical metadata, database integrity, and immutable application manifests. Authority markers and a bounded journal prevent two writable copies. Resume after activation preserves new destination saves; abort before publication retains both trees. Old configured library paths follow only verified relocation receipts.

The CLI exposes review/apply, `library resume-move`, and `library abort-move`; Settings and startup recovery invoke the same core operations. Tauri's separate transfer module handles only cached-handle release and reopening. Machine schema 5 adds the move activity and exported transfer contracts. The transport checker now matches complete interface names, fixing its prefix collision between `LibraryMetadata` and `LibraryMetadataFile`.

Five focused move tests cover active/previous/staged preservation, immutable verification, stale plans, shared-handle conflicts, changed source/destination data, four interruption boundaries, early journal/directory creation, abort-marker recovery, and post-activation save changes. A compiled CLI test confirms required review arguments and relocation across fresh processes. A native adapter test confirms that outstanding work blocks a move and that a later successful handoff reopens the new root. Browser QA at 1280×720 exercised review, changed destination invalidation, visible interrupted-copy actions/errors, Escape closing, and focus return to Move library. The temporary browser fixtures contained synthetic state only and were removed after testing. This is not a new physical controller or compact-window certification.

`just check` and `just deep` passed: 19 CLI unit tests, 10 compiled CLI contract tests, 189 core tests, 8 desktop tests, and 78 frontend tests. Fallow reported maintainability 87.9 with 0% duplication; rscheck retained 14 advisory findings and zero blockers. Cargo-modules retained its existing inherent-item cycle; Hawk remained unsupported on Windows. Directory power-loss durability is only claimed on supporting Linux filesystems; Windows/macOS recovery is certified here for process interruption. Metadata import is still outstanding at this checkpoint.
