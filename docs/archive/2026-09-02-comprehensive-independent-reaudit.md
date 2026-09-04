> Historical evidence only. This September 2, 2026 report is preserved in full,
> but it is not a live source of priority or finding status. The Portcove Roadmap
> and linked repository issues contain the current post-PR-#12 dispositions.

# Portcove comprehensive independent re-audit

**Audit date:** September 2, 2026 (America/New_York)  
**Audited repository:** `boburning/portcove`  
**Pinned source snapshot:** [`8eb6881de65fba49ee643026545791cc3a40a5d0`](https://github.com/boburning/portcove/commit/8eb6881de65fba49ee643026545791cc3a40a5d0)  
**Previous audit snapshot:** [`02654c757c24a8eabc0c518a1aea305264944070`](https://github.com/boburning/portcove/commit/02654c757c24a8eabc0c518a1aea305264944070)  
**Primary remediation implementation snapshot:** [`df9de02b73ba23754f6395a879e54d9af4dd0aa6`](https://github.com/boburning/portcove/commit/df9de02b73ba23754f6395a879e54d9af4dd0aa6)  
**Mode:** Analysis only. No repository files, settings, branches, releases, or user data were modified.

## Scope and evidence standard

This is a new repository-wide review, not a mechanical re-score of the previous audit. The earlier findings were used as a regression checklist, but each conclusion below was revalidated against the pinned current source. I reviewed the project instructions and design documents, the Rust workspace, core/CLI/Tauri/React implementations, catalog, tests, scripts, dependency manifests, GitHub Actions, release workflow, live repository ruleset, and the remediation ledger.

The audit is source- and CI-evidence-backed. This environment could query the exact GitHub snapshot and GitHub Actions data but could not resolve `github.com` from the local execution container, so I did **not** independently clone the repository or rerun `just check`, `just audit`, `just deep`, or `just mutants` locally. Hosted results are labeled as CI evidence rather than represented as locally reproduced execution. Static findings are marked by confidence and include exact validation work needed to prove or disprove them dynamically.

## Finding count

| Priority | Count |
|---|---:|
| P0 | 0 |
| P1 | 9 |
| P2 | 23 |
| P3 | 4 |
| **Total** | **36** |

## Finding index

| ID | Priority | Finding | Confidence | Effort |
|---|---|---|---|---|
| PCV-REAUD-001 | P1 | Launch-time adapter mutations invalidate the immutable install manifest | High | M |
| PCV-REAUD-002 | P1 | ZIP/TAR extraction discards Unix executable permissions | High | M |
| PCV-REAUD-003 | P1 | Launch verification does not reject newly added loader-relevant companions | High | M |
| PCV-REAUD-004 | P1 | Runtime-source reuse is keyed by metadata rather than verified content identity | High | S |
| PCV-REAUD-005 | P1 | “Verified source” conflates byte stability with supported-game identity | High | L |
| PCV-REAUD-006 | P1 | Catalog validation accepts platform contracts that cannot be installed | High | M |
| PCV-REAUD-007 | P1 | The desktop launch timeout is an error report, not cancellation | High | M |
| PCV-REAUD-008 | P1 | Backup deletion is not represented in the durable lifecycle journal | High | M |
| PCV-REAUD-009 | P1 | One malformed backup can hide every healthy backup and block new snapshots | High | S |
| PCV-REAUD-010 | P2 | A malformed successful HTTP response can poison the conditional cache indefinitely | High | S |
| PCV-REAUD-011 | P2 | Executable hints remain basename-only and first-match wins | High | M |
| PCV-REAUD-012 | P2 | Equally scored hosted assets are silently resolved by filename | High | S |
| PCV-REAUD-013 | P2 | Hosted release discovery only examines the first 30 releases | High | M |
| PCV-REAUD-014 | P2 | GitLab package-file discovery can fan out into serial N+1 API requests | High | M |
| PCV-REAUD-015 | P2 | Aggregate checksum manifests accept an unscoped bare hash | High | XS |
| PCV-REAUD-016 | P2 | Recovered launch liveness is based on PID alone | Medium | M |
| PCV-REAUD-017 | P2 | Reading one port status scans and parses state for the entire library | High | M |
| PCV-REAUD-018 | P2 | `all_installs` reintroduces an explicit SQLite N+1 query pattern | High | S |
| PCV-REAUD-019 | P2 | Destructive review and authorization can hash the same trees three times | High | M |
| PCV-REAUD-020 | P2 | Install publication is restart-recoverable but not fully power-loss durable | Medium | L |
| PCV-REAUD-021 | P2 | Database verification checks schema shape, not full schema semantics | Medium | M |
| PCV-REAUD-022 | P2 | CLI cancellation cannot stop expensive pre-spawn launch preparation | High | M |
| PCV-REAUD-023 | P2 | Install-plan results can repopulate after the selected port/channel changes | High | S |
| PCV-REAUD-024 | P2 | Adoption preview results can repopulate after path or target changes | High | S |
| PCV-REAUD-025 | P2 | “Continue” ignores current source, BIOS, and setup readiness | High | XS |
| PCV-REAUD-026 | P2 | Controller navigation performs DOM queries and layout reads every animation frame | High | M |
| PCV-REAUD-027 | P2 | Each desktop launch observer polls the full launch-session table at 4 Hz | High | M |
| PCV-REAUD-028 | P2 | The Rust-to-TypeScript transport gate verifies names, not complete types | High | M |
| PCV-REAUD-029 | P2 | Readiness is based on registration, not current source health | High | M |
| PCV-REAUD-030 | P2 | Required CI runs the full Rust workspace only on Windows | High | M |
| PCV-REAUD-031 | P2 | The core facade has become a workflow monolith | High | L |
| PCV-REAUD-032 | P2 | Provider JSON and checksum bodies are read into memory without explicit size limits | Medium | S |
| PCV-REAUD-033 | P3 | Frontend operation-event state grows for the lifetime of the app | Medium | S |
| PCV-REAUD-034 | P3 | Diagnostic durability may be paying an fsync cost per event | Low | S |
| PCV-REAUD-035 | P3 | Support-bundle redaction is pattern-based rather than data-classification-based | Medium | M |
| PCV-REAUD-036 | P3 | The migration lock has no bounded wait or owner diagnostics | Medium | S |


## 1. Executive summary

### Overall assessment

Portcove is **materially stronger** than at the previous audit snapshot. The remediation program fixed many of the most serious architectural and safety weaknesses rather than papering over them:

- child processes now launch from a cleared, explicitly reconstructed environment;
- install/adopt/remove/restore/activate workflows have durable lifecycle records and restart recovery;
- installed versions are keyed by immutable artifact identity rather than display version;
- archive handling now has centralized path, collision, link, entry-count, expanded-size, and compression-ratio policy;
- launch supervision is parent-independent and save collection remains protected by the port lock;
- destructive desktop operations use native confirmation plus core-owned one-use authorization;
- blocking filesystem/database work is routed off the Tauri async runtime;
- status/update bulk work is set-oriented and bounded;
- the repository has an active main-branch ruleset, pinned actions/tooling, a single-writer release design, checksum reconciliation, and four-platform release rehearsal;
- the frontend now has a root error boundary, better modal focus scoping, bounded diagnostics, and a support bundle.

Those are substantive improvements. Portcove's fundamental architecture remains appropriate: `portcove-core` is the domain authority; CLI and Tauri are adapters; React owns presentation and ephemeral interaction state; catalog data owns port-specific behavior. I found no reason to replace that model.

### Readiness verdict

I would describe the current state as **a strong pre-release beta, but not yet ready to call V1 broadly reliable across every declared platform**.

There are no established P0 findings. The nine P1 findings are narrower than the previous audit's risks, but several cut across core promises:

1. normal adapter launch behavior can invalidate the immutable install manifest;
2. archive extraction drops Unix execute permissions;
3. targeted pre-launch verification does not reject newly added loader-relevant files;
4. prepared runtime sources are cached by path/size/mtime rather than verified content identity;
5. some “verified” sources are only extension-checked and integrity-tracked;
6. the catalog can declare platform combinations that cannot qualify;
7. the desktop's five-minute launch timeout does not cancel its detached supervisor;
8. backup deletion is still outside the durable lifecycle model;
9. one malformed backup can hide every healthy snapshot.

These are fixable without changing Portcove's product direction. The most important conceptual lesson is that the remediation added strong primitives, but three integration boundaries remain under-modeled:

- **install-tree policy:** immutable files, runtime-generated files, persistent data, and launch-critical files are not represented by one authority;
- **source material identity:** registration/verification identity is not carried all the way into runtime materialization;
- **detached operation state:** the desktop has a detached supervisor, but the request/wait/cancel lifecycle is still modeled as a synchronous response with a timeout.

### Overengineering and underengineering

I do **not** see broad overengineering. Lifecycle journals, manifest identities, authorization fingerprints, process isolation, and bounded extraction are proportionate to an application that downloads, installs, updates, and launches third-party executables while preserving user saves.

The primary underengineering is now at the seams between those systems. `service.rs` has also accumulated enough workflow responsibility that omissions are becoming easier even though the individual primitives are generally well designed. Decomposition should follow transaction and invariant boundaries—not complexity metrics or arbitrary file size.

### Biggest opportunities

The highest-value next step is not another broad refactor. It is a focused “trust-contract closure” phase:

- define one install-tree policy consumed by manifesting, launch preparation, verification, and adapters;
- make source identity explicit and carry it into materialization;
- validate every catalog `(port, platform)` into an executable/bundle contract;
- finish backup and launch-request recovery;
- add the targeted Linux/macOS tests that would have caught the current platform defects.

After that, Portcove is close to a credible V1 foundation.


## 2. Baseline verification

### Repository movement since the previous audit

The current branch is 23 commits ahead of `02654c757c24a8eabc0c518a1aea305264944070` and zero behind. The re-audit is pinned to `8eb6881de65fba49ee643026545791cc3a40a5d0` rather than a moving `main`. The core remediation was recorded at `df9de02b73ba23754f6395a879e54d9af4dd0aa6`; the six subsequent commits through the audited head changed repository ruleset/settings scripts and documentation, not runtime core/desktop behavior.

### Current hosted checks

The required CI run associated with `8eb6881de65fba49ee643026545791cc3a40a5d0` completed successfully across its required `rust`, `rust-quality`, `frontend`, and `catalog` jobs. The implementation ledger and hosted logs report the final deterministic baseline as:

- 177 `portcove-core` tests;
- 19 CLI unit tests;
- 7 compiled CLI machine-contract tests;
- 6 Tauri backend tests;
- 69 frontend tests;
- format, workspace check, Clippy with warnings denied;
- frontend build, theme contract, Fallow gate;
- cargo-shear, cargo-deny, architecture and rscheck gates;
- catalog/release/repository-settings contract checks.

Deep Quality passed all three lanes on `df9de02b73ba23754f6395a879e54d9af4dd0aa6`, and the manual Release rehearsal passed Windows, Linux, Intel macOS, and Apple Silicon artifact builders while correctly skipping publication.

### Live governance

The repository's active `Protect main` ruleset requires pull requests, one approval, dismissal of stale approvals, approval of the latest push, resolved conversations, strict required status checks, and deletion/non-fast-forward protection. The repository-admin bypass is pull-request-only, which is a sensible solo-maintainer compromise.

### `docs/QUALITY.md` accuracy

`docs/QUALITY.md` is broadly accurate about the deterministic toolchain, pinned versions, required/deep lanes, MSRV, and documented non-blocking advisories. Its command baseline is well supported by CI evidence.

The remediation ledger's stronger statement that every audit finding is resolved is **not fully accurate**. In particular, the runtime-source marker remains metadata-bound (PCV-REAUD-004), backup listing remains failure-coupled (PCV-REAUD-009), stale plan/preview and Continue readiness issues remain (PCV-REAUD-023 through -025), and the new manifest/adapter and Unix-permission issues were introduced or exposed by the remediation architecture.

### What was not executed here

- no local clone or local `just` command execution;
- no live install/launch of real port artifacts;
- no macOS process or bundle execution;
- no destructive tests against a real user library;
- no power-loss/VM-crash experiment;
- no performance profiler or benchmark beyond repository evidence.

None of those absences is treated as a clean result.


## 3. P0/P1 findings

No P0 issue was established. The following P1 findings should be addressed before a serious V1 declaration.

### PCV-REAUD-001 — Launch-time adapter mutations invalidate the immutable install manifest

**Category:** Correctness / Security  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs#L300-L620) — `Installer::verify`, `manifest_files`, `verified_manifest`; [`crates/portcove-core/src/adapter.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/adapter.rs#L180-L360) — `StandardAdapter::launch_spec_with_executable`; catalog `persistent_paths`

**Evidence**

The installer records every immutable file before activation and full verification later rejects any file that was not in the manifest, except `.portcove-manifest.json`, `.portcove-launched`, and catalog-declared mutable paths. After that manifest is written, the launch adapter creates or rewrites files inside the managed install: `portable.txt` for every N64-recomp/portable-marker port, `data_location.json` for referenced-disc ports, and `game.toml` for managed PS1 ports. The catalog does not declare `portable.txt` or `data_location.json` as persistent/mutable paths. A normal first launch can therefore make a previously valid install report `unexpected: portable.txt` or `unexpected: data_location.json`; a source-path change can make the PS1 config report as changed.

**Why it matters**

This breaks Portcove's own trust model. The product says an immutable manifest proves the installed application tree, yet ordinary Portcove behavior mutates that tree outside the manifest's policy. Users can see false tamper failures after successful play, and future code cannot reliably distinguish expected runtime materialization from an actual modification.

**Recommendation**

Create one explicit install-tree policy owned by core. It should classify, before manifest creation, every path as immutable, persistent user data, deterministic Portcove-generated state, or ephemeral marker. Prefer creating deterministic files such as `portable.txt` before manifesting. Move user-specific descriptors outside the immutable tree where upstream supports it; otherwise include them in a typed generated-path policy with exact generation/verification rules. Do not solve this by broadly ignoring unknown files.

**Validation**

Add install→launch→full-verify tests for at least N64RecompPortable, ReferencedDisc, PsxRecompManaged, UpstreamManagedSetup, and a portable-marker override. Then add a negative test proving an unrelated new file still makes full verification fail.

**Dependencies / interactions**

Implement together with PCV-REAUD-003 and before changing manifest caching or launch readiness.


### PCV-REAUD-002 — ZIP/TAR extraction discards Unix executable permissions

**Category:** Correctness / Cross-platform  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/archive.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/archive.rs#L1-L520) — ZIP/TAR extraction writers and `ArchivePolicy`; [`crates/portcove-core/src/install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs#L700-L750) — `extract_asset`

**Evidence**

The shared archive layer defensively validates names, entry counts, sizes, ratios, collisions, links, and special entries, but extracted regular files are created with normal host defaults. ZIP `unix_mode()` and TAR header modes are inspected only to reject unsafe entry kinds; safe execute bits are not restored. By contrast, the direct `.exe`/`.AppImage` path explicitly applies mode `0755` on Unix. A Linux or macOS executable inside a ZIP/TAR therefore normally lands as non-executable even though qualification only checks that the selected path is a file.

**Why it matters**

Many hosted Linux/macOS releases are archives rather than direct AppImages. Those installations can download, verify, publish, and then fail at process creation with `Permission denied`. This is a public-platform correctness blocker and is exactly the kind of issue a Windows-only full test lane will miss.

**Recommendation**

Define a safe permission policy: directories `0755`; ordinary data files `0644`; entries carrying any owner/group/other execute bit become `0755` (or preserve only the three execute bits plus safe read/write defaults). Always strip setuid, setgid, sticky, device, and ownership metadata. Apply the same policy to ZIP and TAR and verify the selected executable is executable after extraction on Unix.

**Validation**

Create ZIP and TAR fixtures containing an executable with mode `0755`, extract on Linux, assert the safe resulting mode, and actually spawn a tiny helper. Add a fixture proving setuid/setgid bits are stripped. Run this in required Linux CI.

**Dependencies / interactions**

PCV-REAUD-030 is the CI coverage counterpart. Coordinate with macOS bundle handling in PCV-REAUD-006.


### PCV-REAUD-003 — Launch verification does not reject newly added loader-relevant companions

**Category:** Security  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs#L360-L720) — `verify_critical`, `is_critical_companion`

**Evidence**

At manifest creation, files beside the selected executable with extensions such as `.dll`, `.so`, `.dylib`, `.bat`, `.cmd`, `.sh`, `.toml`, `.ini`, and `.cfg` are marked critical and rehashed before launch. The launch verifier only rechecks critical entries already present in the manifest. It does not enumerate the executable directory and reject a new, unmanifested DLL/shared library/script/config file. Full manual verification would catch the addition, but launch does not run that negative check.

**Why it matters**

Platform loaders and launchers may consume newly introduced companions before or during executable startup. An added DLL beside a Windows executable is the clearest example. Portcove can therefore say the selected executable and recorded companions are intact while launching with an unrecorded load-influencing file.

**Recommendation**

During targeted launch verification, enumerate the selected executable's load-sensitive scope and reject unmanifested entries matching the platform-specific critical policy. Keep the check narrow enough to avoid hashing the whole install, but make it both positive (recorded files unchanged) and negative (no new critical files). Treat expected adapter-generated files through the explicit policy from PCV-REAUD-001 rather than a blanket allowlist.

**Validation**

Install a fixture, add an unmanifested same-directory DLL/`.so`/`.dylib`, and prove launch preparation fails closed. Add a benign non-critical file in an allowed mutable root and prove it remains permitted.

**Dependencies / interactions**

Depends on a coherent generated/mutable path policy from PCV-REAUD-001.


### PCV-REAUD-004 — Runtime-source reuse is keyed by metadata rather than verified content identity

**Category:** Correctness / Data integrity  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** S

**Location:** [`crates/portcove-core/src/adapter.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/adapter.rs#L340-L520) — `RuntimeSourceMarker`, `runtime_source_marker`, `prepare_runtime_source`

**Evidence**

The prepared-source marker contains canonical source path, optional archive member name, storage size, modification timestamp, and materialization kind. It does not contain the registered source's SHA-256/storage SHA-256. Reuse is granted when the destination exists and the JSON marker equals newly computed path/size/mtime metadata. A newly registered valid replacement can therefore reuse stale prepared output when path, size, and timestamp are preserved. The remediation ledger describes source identity hardening, but this specific cache remains metadata-bound.

**Why it matters**

Portcove can validate the new source record correctly and still launch materialized bytes derived from the old source. This is especially reachable for profiles with multiple accepted variants or identity-light profiles. It also makes forensic reasoning difficult because the marker does not say which verified bytes produced the runtime artifact.

**Recommendation**

Pass a typed `VerifiedSourceIdentity`/`SourceRecord` into materialization rather than only a path. Store the normalized content digest, storage digest, member identity/digest, materialization version, and output digest in the marker. On reuse, verify the marker is bound to the current registered identity; for cheap outputs, optionally verify the output digest too.

**Validation**

Register source A, materialize, replace it with valid source B at the same path while preserving size and mtime, update the registration, and prove rematerialization occurs. Include ZIP member and multi-disc/set cases.

**Dependencies / interactions**

Related to PCV-REAUD-005 and should precede source-health UX work in PCV-REAUD-029.


### PCV-REAUD-005 — “Verified source” conflates byte stability with supported-game identity

**Category:** Correctness / Product trust  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** L

**Location:** [`crates/portcove-core/src/catalog.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/catalog.rs#L30-L210) — source-profile validation, especially `SourceKind::File`; [`crates/portcove-core/catalog/catalog.json`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/catalog/catalog.json#L1-L90) — identity-light source profiles; source verification UI

**Evidence**

Catalog validation permits an ordinary `file` source profile with no accepted SHA-1 or SHA-256 values. The current catalog uses that form for, among others, Ocarina of Time, Majora's Mask, Star Fox 64, Twilight Princess, Dinosaur Planet, Diddy Kong Racing, Dr. Mario 64, and Blue Dragon. Registration hashes whatever file matches the extension, and later “verification” proves only that the bytes still match the registered baseline. The UI and product language do not clearly distinguish exact supported identity from integrity-only tracking or upstream validation.

**Why it matters**

A wrong region, revision, prototype, unrelated ROM/disc image, or random same-extension file can be shown as “verified” by Portcove even though Portcove has not established that it is a supported original. Upstream may reject some files later, but that is a different trust boundary and is not represented in the domain model.

**Recommendation**

Make trust level explicit. Exact profiles should require an allowlisted digest/structured disc identity. Where the upstream tool intentionally owns identity validation, add a distinct `upstream-validated-file/disc` contract and do not label the pre-upstream state as identity-verified. Expose separate `identity_status` and `integrity_status` in core, CLI, and desktop. Populate reviewed identities where legally and technically possible.

**Validation**

Catalog validation must reject identity-less ordinary exact-source profiles. Tests should show the UI/CLI distinctions among exact-match verified, unchanged but identity-unconfirmed, upstream-validated, changed, and missing. Confirm every current identity-light profile has an explicit disposition.

**Dependencies / interactions**

Coordinate with catalog admission documentation, PCV-REAUD-004, and PCV-REAUD-029.


### PCV-REAUD-006 — Catalog validation accepts platform contracts that cannot be installed

**Category:** Correctness / Catalog  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/catalog/catalog.json`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/catalog/catalog.json#L160-L260) — `dinosaur-planet`, `donkey-kong-64-recompiled`; [`crates/portcove-core/src/install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs#L600-L720) — `InstallQualification::from_port`, `resolve_declared_executable`; [`crates/portcove-core/src/catalog.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/catalog.rs#L210-L620) — per-platform catalog validation

**Evidence**

`dinosaur-planet` declares four supported platforms but has an empty `executable_hints` map. `InstallQualification::from_port` requires a non-empty hint list for the selected platform, so the port cannot qualify on any declared platform. `donkey-kong-64-recompiled` declares macOS Apple Silicon with `DK64Recompiled.app` as the executable hint, while qualification recursively walks files and matches a file basename; an `.app` bundle is a directory, so that hint cannot match the intended bundle. Existing catalog validation does not prove that each declared platform has a usable executable contract.

**Why it matters**

The catalog can advertise a stable, installable port and allow release planning/download before failing at qualification. This damages trust in the support matrix and can waste large downloads. It also reveals that the current macOS process model does not consistently represent app bundles.

**Recommendation**

Add a catalog-level `InstallQualification::from_port` validation for every `(port, declared platform)` tuple. Reject missing hints at catalog load. Model macOS bundles explicitly with a bundle path plus inner executable contract, or require the actual `Contents/MacOS/<binary>` basename/path. Correct or temporarily remove unsupported platform declarations until fixtures prove them.

**Validation**

A table-driven test should build qualification for all 61 ports across every declared platform. Add synthetic archive trees for each distinct contract shape and prove exactly one executable/bundle resolves. Specifically cover Dinosaur Planet and DK64 macOS.

**Dependencies / interactions**

Implement before broader platform qualification; pairs with PCV-REAUD-011 and PCV-REAUD-030.


### PCV-REAUD-007 — The desktop launch timeout is an error report, not cancellation

**Category:** Reliability / Desktop UX  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** M

**Location:** [`apps/desktop/src-tauri/src/lib.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src-tauri/src/lib.rs#L940-L1160) — `request_supervised_launch`, `run_supervisor_request`

**Evidence**

The Tauri command writes a request file, starts a detached helper, and waits up to 300 seconds for a response. At the deadline it returns “did not report a child process within five minutes” but does not terminate the helper, delete/cancel the request, or write a deadline consumed by the helper. The helper independently opens the library, performs launch preparation/setup, and can publish a response or start the game after the caller has already received an error.

**Why it matters**

A slow first-launch setup can show failure and then launch minutes later. A user may retry, producing duplicate supervisors or a busy-port conflict, and stale response files can remain. The detached architecture is correct for parent independence, but the request lifecycle is incomplete.

**Recommendation**

Make launch requests durable state machines with `queued/preparing/spawned/failed/cancel_requested/cancelled/expired`. Either return a request/session ID immediately and let the UI observe state, or propagate an absolute deadline/cancellation record that the helper checks before spawn and at safe preparation boundaries. Never map “caller stopped waiting” to “operation failed” while autonomous work continues invisibly.

**Validation**

Use a helper that deliberately blocks longer than the UI deadline. Prove timeout/cancel prevents later spawn, or prove the UI transitions to a still-running operation with a reconnectable ID. Test retry, app exit, orphan response cleanup, and first-launch setup.

**Dependencies / interactions**

Coordinate with PCV-REAUD-016, PCV-REAUD-022, and PCV-REAUD-027.


### PCV-REAUD-008 — Backup deletion is not represented in the durable lifecycle journal

**Category:** Reliability / Data integrity  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/service.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/service.rs#L700-L860) — `delete_backup`; [`crates/portcove-core/src/operation.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/operation.rs) — `LifecycleOperationKind`; [`crates/portcove-core/src/recovery.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/recovery.rs) — lifecycle recovery

**Evidence**

Install, adopt, remove, restore, and activate have durable operation records and restart recovery. Backup deletion does not. It renames the selected backup directory to `.deleting-<uuid>` and then removes it, with an in-process rename-back fallback if deletion immediately fails. A process/host crash between rename and removal leaves the backup hidden because listing skips dot-prefixed directories, and no lifecycle record tells recovery whether to restore or complete deletion.

**Why it matters**

A valid user backup can disappear from all Portcove interfaces after interruption. The bytes may remain recoverable manually, but that is still a data-integrity failure in a workflow explicitly presented as safe and confirmation-gated.

**Recommendation**

Add a `DeleteBackup` lifecycle kind with original path, tombstone path, reviewed identity, and phases. Before rename, persist intent; after rename, persist publication; after removal, finish the journal. Recovery should deterministically restore the original until a commit point, or finish deletion after the authorization/commit point. Doctor/repair should surface legacy orphan `.deleting-*` directories.

**Validation**

Fault-inject immediately before rename, after rename, during removal, and after removal before journal cleanup. Restart Portcove and prove the backup is either visible and intact or definitively deleted according to the documented commit point—never silently hidden.

**Dependencies / interactions**

Implement with PCV-REAUD-009 so backup enumeration and repair share one degraded-entry model.


### PCV-REAUD-009 — One malformed backup can hide every healthy backup and block new snapshots

**Category:** Reliability  
**Priority:** **P1**  
**Confidence:** High  
**Effort:** S

**Location:** [`crates/portcove-core/src/service.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/service.rs#L430-L640) — `list_backups`, `create_backup_locked`

**Evidence**

`list_backups` iterates every non-hidden directory and returns immediately if `backup.json` is missing, invalid JSON, non-Unicode, or has mismatched identity. It does not isolate errors per backup. `create_backup_locked` calls `list_backups` to derive a monotonic timestamp, so one damaged historical backup also prevents creation of a new backup. The desktop and CLI consequently lose access to all healthy snapshots.

**Why it matters**

The moment backups matter most—after corruption or manual filesystem damage—the recovery interface can become unusable. A single bad entry should not erase discoverability of unrelated valid snapshots.

**Recommendation**

Return a backup inventory containing valid records plus typed degraded entries. Quarantine only entries whose path/manifest cannot be trusted, and keep healthy snapshots listable/restorable. Derive new timestamps independently of successful parsing of every old backup. Add repair actions to inspect, quarantine, or delete a degraded entry.

**Validation**

Create three valid backups and corrupt the middle manifest in several ways. Prove the other two remain visible and restorable, a new backup can be created, doctor reports the damaged entry, and repair never mutates healthy snapshots.

**Dependencies / interactions**

Share types and recovery UI with PCV-REAUD-008.


## 4. P2 findings

### PCV-REAUD-010 — A malformed successful HTTP response can poison the conditional cache indefinitely

**Category:** Reliability  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** S

**Location:** [`crates/portcove-core/src/release.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/release.rs#L100-L260) — `GithubReleaseProvider::get_json`; GitLab provider equivalent; HTTP-cache table

**Evidence**

Provider code reads a successful body, stores it with ETag/Last-Modified, and only then deserializes JSON. If the body is truncated or malformed, the call fails but the bad body remains cached. A later 304 response deserializes that same cached body and fails again; there is no purge-and-unconditional-retry path. The GitLab provider follows the same pattern.

**Why it matters**

A transient proxy/CDN truncation can turn into a persistent update failure that survives process restarts and looks like an upstream outage. Users have no normal cache-clear control.

**Recommendation**

Deserialize and validate before storing. On a 304 whose cached body fails to parse, delete that cache entry and retry once without conditional headers. Bound cached body size and preserve the original parsing error if the unconditional retry also fails.

**Validation**

Serve malformed `200 + ETag`, then `304`, then valid `200`. Assert the malformed body is never retained as authoritative and the provider self-heals with exactly one unconditional retry.

**Dependencies / interactions**

Coordinate with PCV-REAUD-032 response-size bounds.


### PCV-REAUD-011 — Executable hints remain basename-only and first-match wins

**Category:** Security / Reliability  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs#L600-L720) — `resolve_declared_executable`; adapter executable discovery

**Evidence**

Qualification walks every file under the runtime root and, for each hint, returns the first case-insensitive basename match. It does not reject duplicate matches or bind a hint to a relative path. Filesystem traversal order is not a product contract. Archives with two `game.exe` files in different subdirectories can therefore select whichever appears first.

**Why it matters**

The selected executable is subsequently trusted and stored in the manifest, so ambiguity becomes a silent installation decision. Upstream archive layout changes can switch the selected binary without a catalog change.

**Recommendation**

Make executable contracts relative-path-aware and fail closed on ambiguity. Support explicit alternatives as ordered exact paths or constrained globs under a declared runtime root. For legacy basename hints, require exactly one match and report all candidates on conflict.

**Validation**

Archive fixtures should cover duplicate basenames, case collisions, nested launchers, macOS bundles, and one valid exact path. Selection must be deterministic and ambiguity must fail before publication.

**Dependencies / interactions**

PCV-REAUD-006 should enforce that every platform has a valid contract.


### PCV-REAUD-012 — Equally scored hosted assets are silently resolved by filename

**Category:** Correctness / Release resolution  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** S

**Location:** [`crates/portcove-core/src/release.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/release.rs#L700-L820) — `choose_asset`; GitLab `choose_link`

**Evidence**

GitHub assets are scored by catalog hints, platform tokens, and archive preference. Equal scores are sorted lexicographically and the first asset is selected. GitLab package links use the same general scoring approach. No ambiguity error is produced when two runnable packages are equally plausible.

**Why it matters**

An upstream adding a second package can silently redirect Portcove to a different build flavor—portable vs installer, debug vs release, SDL vs Qt—without a catalog review. Checksums prove bytes, not that the correct artifact was chosen.

**Recommendation**

Require a unique highest-scoring candidate. If the top score ties, fail with candidate names and require the catalog to add a distinguishing hint or exact asset pattern. Prefer explicit exact/anchored match rules for stable ports.

**Validation**

Add two equally scored runnable assets and assert resolution fails. Then add a catalog discriminator and prove the intended asset wins.

**Dependencies / interactions**

Pairs with PCV-REAUD-006 and catalog admission checks.


### PCV-REAUD-013 — Hosted release discovery only examines the first 30 releases

**Category:** Correctness  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/release.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/release.rs#L430-L540) — GitHub `releases?per_page=30`; GitLab releases request

**Evidence**

Both hosted providers request a single page of up to 30 releases. A stable release older than a long sequence of prereleases, or a configured rolling tag outside the first page, is treated as nonexistent. The documented beta fallback can also choose a newer stable while an older beta exists beyond the window.

**Why it matters**

Long-lived projects commonly accumulate more than 30 releases. Resolution behavior changes as history grows, which is precisely the scale-up failure class requested by this audit.

**Recommendation**

Paginate with a small, bounded policy until the needed channel/tag is found or a documented maximum is reached. Rolling tags can use a direct tag endpoint where available. Record pagination/rate-limit context in errors.

**Validation**

Provider fixtures should place stable, beta, and rolling candidates on page 2/3 and prove correct selection, bounded requests, ordering, cancellation, and rate-limit behavior.

**Dependencies / interactions**

Consider with PCV-REAUD-014 and PCV-REAUD-032.


### PCV-REAUD-014 — GitLab package-file discovery can fan out into serial N+1 API requests

**Category:** Performance / Reliability  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/gitlab.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/gitlab.rs) — `package_file` and release resolution

**Evidence**

The provider lists up to 100 generic packages, prioritizes matching versions, then requests each package's file list sequentially until it finds the release link's file ID. If metadata is inconsistent or the target is late, one resolution can generate dozens of serial requests.

**Why it matters**

Update-all across many GitLab-backed ports can become slow and rate-limit-prone despite the core's four-operation concurrency bound. This is strong static evidence, though the real catalog currently limits exposure.

**Recommendation**

Derive the package/file directly from the release link when possible, query only version-matching packages, cache project/package metadata, and cap fallback probes. Emit a precise ambiguity/not-found error rather than scanning unrelated historical packages.

**Validation**

A fake GitLab server should count requests for best, missing, and ambiguous cases. Establish a small maximum request budget and prove bulk checks remain bounded.

**Dependencies / interactions**

PCV-REAUD-013 and PCV-REAUD-032.


### PCV-REAUD-015 — Aggregate checksum manifests accept an unscoped bare hash

**Category:** Reliability / Verification  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** XS

**Location:** [`crates/portcove-core/src/release.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/release.rs#L380-L500) — `checksum_from_sidecar`

**Evidence**

The parser prefers an exact `<asset>.sha256` sidecar but may fall back to aggregate files such as `SHA256SUMS`. In either case a line is accepted when the filename field is empty or equals the target. A bare hash is reasonable for an exact one-file sidecar, but it is ambiguous in an aggregate checksum file and can bind the wrong line to the selected asset.

**Why it matters**

The later download hash check prevents execution of mismatched bytes, so this is not a signature bypass. It does create confusing, avoidable verification failures and can make a valid release appear broken.

**Recommendation**

Track whether the chosen sidecar is exact or aggregate. Permit a bare hash only in the exact sidecar and only when there is exactly one valid hash line. Require an exact normalized filename match in aggregate manifests.

**Validation**

Test exact bare sidecars, GNU/BSD formats, aggregate files with unrelated bare hashes, `*filename`, spaces, and duplicate entries.

**Dependencies / interactions**

Independent quick win.


### PCV-REAUD-016 — Recovered launch liveness is based on PID alone

**Category:** Reliability  
**Priority:** **P2**  
**Confidence:** Medium  
**Effort:** M

**Location:** [`crates/portcove-core/src/launch.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/launch.rs) — `process_alive` and stale-session recovery; launch-session schema

**Evidence**

After a supervising process disappears, recovery checks whether the recorded child PID is alive. The durable session does not bind that PID to a process creation time/start token, executable identity, or OS handle. PID reuse can therefore make an unrelated process look like the old game.

**Why it matters**

Port mutation may remain blocked and save collection deferred until an unrelated process exits. The fail-closed choice is safer than collecting while a game might run, but the identity is too weak for years of accumulated state or rapid PID reuse.

**Recommendation**

Persist an OS-specific process birth identity: creation time on Windows, `/proc/<pid>/stat` start time on Linux, and process start information on macOS, plus executable/install identity where available. Treat PID+birth mismatch as exited, not alive. Keep a conservative fallback on hosts where strong identity cannot be read.

**Validation**

Abstract process inspection and simulate PID reuse. Integration tests should prove a matching PID with a different birth identity is not considered the launched child.

**Dependencies / interactions**

Coordinate with the launch request/session redesign in PCV-REAUD-007.


### PCV-REAUD-017 — Reading one port status scans and parses state for the entire library

**Category:** Performance / Reliability  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/library.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/library.rs#L680-L920) — `status`, `statuses_with_metrics`

**Evidence**

`status(port_id)` delegates to the bulk status read model with one requested port, but that model selects every row from `port_settings`, `installs`, `launch_history`, and `update_snapshots`, then parses every channel/policy and every snapshot JSON before filtering to the requested port. Query count is constant, but work is proportional to the entire library.

**Why it matters**

Detail views, launch preparation, backup operations, and other single-port workflows become O(total retained state). More seriously, malformed snapshot JSON for an unrelated port can make status for a healthy port fail. The current scale tests count queries but do not measure rows parsed or fault isolation.

**Recommendation**

Provide distinct scoped and bulk read paths. The single-port path should query only that port with joins/subqueries; the bulk path should remain set-oriented. Isolate malformed optional snapshots per port rather than failing unrelated status reads.

**Validation**

At 1,000+ unrelated rows, assert the single-port path reads a bounded row count and remains successful when an unrelated snapshot is malformed. Retain the current constant-query bulk benchmark.

**Dependencies / interactions**

Implement before broader service decomposition in PCV-REAUD-031.


### PCV-REAUD-018 — `all_installs` reintroduces an explicit SQLite N+1 query pattern

**Category:** Performance  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** S

**Location:** [`crates/portcove-core/src/library.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/library.rs#L920-L1030) — `all_installs`, `port_install_paths`

**Evidence**

`all_installs` first selects every install ID, then calls `install_by_id` once per ID on the same connection. `port_install_paths` loads all installs and filters in memory even when one port is requested.

**Why it matters**

Repair and removal-related workflows grow linearly in database round trips and allocations as retained versions accumulate. It also duplicates row decoding already implemented in the bulk status model.

**Recommendation**

Select and decode all required install columns in one query, and query `WHERE port_id = ?` for port-scoped paths. Centralize install-row decoding to prevent contract drift.

**Validation**

Instrument query count for 1,000 installs and assert one query for all installs and one for a port's paths.

**Dependencies / interactions**

Can be completed with PCV-REAUD-017.


### PCV-REAUD-019 — Destructive review and authorization can hash the same trees three times

**Category:** Performance / UX  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/service.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/service.rs) — backup/source/remove/adoption preview, authorization, and execute flows

**Evidence**

The safety design recomputes deterministic copy/removal/backup plans during preview, again while issuing authorization, and again under the operation lock before consuming authorization. For adoption and backup restore, those plans can recursively hash large trees. The final locked recheck is necessary; the middle full re-scan is not always required for safety because stale consent will still fail at consumption.

**Why it matters**

Large existing installations or save/mod trees can make one confirmed action perform multiple full filesystem passes before any mutation. Users experience long, apparently duplicated waits.

**Recommendation**

Retain the final under-lock revalidation. Make authorization issuance bind the already reviewed fingerprint without rehashing, or persist a short-lived typed preview object whose identity is rechecked once at execution. Keep all current TOCTOU guarantees.

**Validation**

Instrument file opens/bytes hashed for preview→authorize→execute on a large fixture. Prove two-state changes (before authorization and before execution) are still detected while eliminating one redundant pass.

**Dependencies / interactions**

Do after P1 correctness work; do not weaken authorization semantics.


### PCV-REAUD-020 — Install publication is restart-recoverable but not fully power-loss durable

**Category:** Reliability  
**Priority:** **P2**  
**Confidence:** Medium  
**Effort:** L

**Location:** [`crates/portcove-core/src/install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs) — archive extraction, manifest write, publish/metadata phases; [`crates/portcove-core/src/durability.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/durability.rs) — focused backup durability support

**Evidence**

The lifecycle journal makes install publication recoverable after process interruption, and backup creation has explicit Linux directory-sync support. Install extraction mostly flushes userspace buffers but does not consistently `sync_all` every payload file, manifest, staging directory, final parent directory, and database boundary in a documented order before declaring metadata committed. A power loss can therefore differ from a normal process crash.

**Why it matters**

Portcove carefully distinguishes process recovery from filesystem durability for backups; the same distinction is not yet fully implemented for installed application payloads. The risk is platform/filesystem dependent and was not dynamically reproduced in this environment.

**Recommendation**

Document the exact guarantee first. If power-loss durability is a V1 goal, reuse a generalized durable-publication primitive for install/adopt/restore: sync payload, sync manifest, rename on same volume, sync parent, commit DB, sync DB/WAL as feasible. Otherwise explicitly promise process-crash recovery only and ensure repair detects incomplete files after reboot.

**Validation**

Use fault injection around each fsync/rename/DB boundary and, where feasible, filesystem/VM crash tests on Linux. Verify recovery never registers an incomplete manifest tree.

**Dependencies / interactions**

Should build on the existing durability module rather than adding per-workflow ad hoc fsyncs.


### PCV-REAUD-021 — Database verification checks schema shape, not full schema semantics

**Category:** Reliability / Testing  
**Priority:** **P2**  
**Confidence:** Medium  
**Effort:** M

**Location:** [`crates/portcove-core/src/database.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/database.rs) — migration registry and structural verification

**Evidence**

Startup verifies expected migration versions, table presence, and columns. It does not establish that indexes, unique constraints, foreign-key actions, defaults, check constraints, or full table definitions match the intended schema. A manually altered or partially reconstructed database can pass the shape check while carrying weaker semantics.

**Why it matters**

Recovery and concurrency guarantees depend on constraints as much as columns. This is primarily a corrupted/manual-drift hardening gap, not evidence that normal migrations currently produce the wrong schema.

**Recommendation**

Maintain a canonical schema fingerprint or verify the critical `sqlite_master` definitions and PRAGMA metadata for indexes/foreign keys. Focus on invariants whose absence can cause duplicate staged installs, dangling settings, or incorrect cleanup; do not compare irrelevant SQL formatting.

**Validation**

Create databases with the right columns but missing/wrong critical indexes, foreign keys, and defaults. Startup or doctor should identify the exact semantic drift and offer export/rebuild guidance.

**Dependencies / interactions**

Can be part of database/recovery hardening after P1 work.


### PCV-REAUD-022 — CLI cancellation cannot stop expensive pre-spawn launch preparation

**Category:** CLI / Reliability  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-cli/src/main.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-cli/src/main.rs) — `exec_game`, signal state, launch preparation; core `OperationCoordinator`

**Evidence**

The CLI installs signal handling so that a signal can be forwarded once a child process/group exists. Source verification, hashing, conversion, setup, manifest checks, and runtime materialization occur before the child PID is available. A Ctrl-C during those phases does not provide a cooperative cancellation token to the core preparation work and may only be acted on after preparation completes.

**Why it matters**

Multi-gigabyte source verification or first-launch conversion can make the CLI appear unresponsive to termination. External launchers also need deterministic cancellation semantics.

**Recommendation**

Extend `OperationCoordinator` with a cancellation flag/token checked at safe boundaries in hashing loops, downloads, archive extraction, external-tool waits, and setup phases. Define whether cancellation leaves resumable/recoverable state and keep lifecycle cleanup deterministic.

**Validation**

Run helpers that block in hashing, conversion, and setup; send Ctrl-C/TERM before spawn; assert prompt cancellation, no later game launch, correct exit code, and recoverable staging/journal state.

**Dependencies / interactions**

Use the same launch request cancellation model as PCV-REAUD-007.


### PCV-REAUD-023 — Install-plan results can repopulate after the selected port/channel changes

**Category:** React/UI  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** S

**Location:** [`apps/desktop/src/use-portcove.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/use-portcove.ts) — `useInstallPlanning`

**Evidence**

The hook clears the plan when `portId` or `channel` changes, but an older in-flight `desktopApi.plan` promise can still resolve afterward and call `setPlan(result)`. The main data refresh has a generation guard; install planning does not.

**Why it matters**

The detail panel can display the release/version/size/action for the previously selected port under the new selection. The later install call is independently validated, so this is primarily misleading consent/UX rather than an unsafe backend mutation.

**Recommendation**

Track a request generation or request key (`portId:channel`) and only commit a result that matches the latest key. Also clear/ignore on panel close. Abortable IPC is optional; stale-result rejection is required.

**Validation**

Deferred-promise hook tests should resolve requests out of order across port and channel changes and prove only the newest plan renders.

**Dependencies / interactions**

Use the same frontend request primitive for PCV-REAUD-024.


### PCV-REAUD-024 — Adoption preview results can repopulate after path or target changes

**Category:** React/UI  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** S

**Location:** [`apps/desktop/src/App.tsx`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/App.tsx) — adoption preview effects/handlers; adoption modal state

**Evidence**

Changing adoption path/port clears the displayed preview, but the prior asynchronous preview request is not generation-checked. A late response can repopulate counts and fingerprint for an old path/target. Core authorization fingerprints still prevent the wrong tree from being adopted, which limits the impact.

**Why it matters**

The confirmation UI can describe the wrong source tree, causing confusing conflicts or misleading reviewed counts. This is the same conceptual stale-request class the general refresh code already solved.

**Recommendation**

Create a shared keyed-request hook for plan/preview flows. Commit results only when the response key matches the current path, selected port, and modal generation. Invalidate on close.

**Validation**

Resolve old/new previews in reverse order and prove the old result never appears or becomes confirmable.

**Dependencies / interactions**

PCV-REAUD-023.


### PCV-REAUD-025 — “Continue” ignores current source, BIOS, and setup readiness

**Category:** Accessibility/UX / Correctness  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** XS

**Location:** [`apps/desktop/src/view-model.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/view-model.ts) — `mostRecentPort`; [`apps/desktop/src/components/PortBrowser.tsx`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/components/PortBrowser.tsx) — `ContinueCard`

**Evidence**

The recent-port selector requires only an active install and `last_launched_at`. The Continue card then exposes an unconditional “Play again” action. It does not require `status.readiness.launchable`, account for missing/changed source or BIOS, or route a pending setup state through details.

**Why it matters**

The most prominent action can predictably fail after a source is removed/moved or setup becomes incomplete. Controller-first users are especially likely to take that direct path.

**Recommendation**

Choose the most recent currently launchable port, or render the most recent port with a state-aware primary action such as “Finish setup”/“Review source”. Reuse the same readiness presentation as normal cards.

**Validation**

Component/view-model tests should cover missing source, missing BIOS, pending setup, stale source health, and staged update states.

**Dependencies / interactions**

PCV-REAUD-029 provides richer source-health state.


### PCV-REAUD-026 — Controller navigation performs DOM queries and layout reads every animation frame

**Category:** Performance / Accessibility/UX  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`apps/desktop/src/gamepad.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/gamepad.ts) — `useGamepadNavigation`, `focusables`, spatial navigation

**Evidence**

The requestAnimationFrame loop runs continuously. Whenever a gamepad is present it queries all visible `[data-focusable]` elements and reads their client rectangles as part of navigation processing, including frames with no directional input. This forces repeated style/layout work at display cadence.

**Why it matters**

Large catalogs and low-power handhelds can pay a 60/120/165 Hz layout tax merely because a controller is connected. That is a strong static concern; actual frame cost still requires profiling.

**Recommendation**

Poll button/axis state cheaply, compute focusable geometry only on a navigation edge/repeat, and cache/invalidate candidates with dialog/view changes, resize, scroll, or a MutationObserver. Preserve top-dialog scoping and focus restoration.

**Validation**

Instrument `querySelectorAll`/`getBoundingClientRect` calls during idle gamepad frames and assert zero layout scans; then exercise navigation after resize/modal changes.

**Dependencies / interactions**

Profile after implementation; do not alter the current accessible focus model.


### PCV-REAUD-027 — Each desktop launch observer polls the full launch-session table at 4 Hz

**Category:** Performance / Desktop/Tauri  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`apps/desktop/src-tauri/src/lib.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src-tauri/src/lib.rs#L900-L980) — post-launch observer loop; library launch-session reads

**Evidence**

After receiving a session ID, Tauri starts a thread that repeatedly loads launch sessions and searches for that ID every 250 ms until it disappears. With multiple concurrent games, each observer repeats a whole-table read, creating approximately O(active launches²) session-row processing plus frequent SQLite wakeups.

**Why it matters**

The current catalog is small, but long-running games make this persistent background activity. It is unnecessary because the session has a stable primary key and completion events already exist conceptually.

**Recommendation**

Add a `launch_session(id)` query or one shared observer per library. Better, have the supervisor publish a durable completion event/state transition and let the frontend subscribe/poll one ID at a slower adaptive interval.

**Validation**

Count database queries with 1, 4, and 16 simulated launches and prove linear or constant observer work. Verify UI refresh still occurs after successful/failed collection.

**Dependencies / interactions**

Can be folded into PCV-REAUD-007 launch-state redesign.


### PCV-REAUD-028 — The Rust-to-TypeScript transport gate verifies names, not complete types

**Category:** Architecture / Testing  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`scripts/check-transport-contract.mjs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/scripts/check-transport-contract.mjs) — schema comparison logic; [`apps/desktop/src/types.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/types.ts) — hand-maintained DTOs

**Evidence**

The deterministic checker compares top-level interface field names and selected enum literals/variants. It does not prove nested object shapes, scalar types, arrays, requiredness, `Option` nullability, tagged-union payloads, or numeric-width expectations. TypeScript DTOs therefore remain a partial second authority despite the generated schema input.

**Why it matters**

A Rust field can change from optional to required, number to string, or alter a nested payload while the gate remains green if top-level names do not change. Strict TypeScript cannot detect a runtime payload it was told to trust.

**Recommendation**

Generate TypeScript types directly from the exported schema, or use a real JSON-Schema compatibility checker covering nested shapes and required arrays. Keep a small handwritten API wrapper, not handwritten transport models. Add runtime parsing only at the IPC boundary if it materially improves failure diagnostics.

**Validation**

Mutation tests to the generated schema should show that changing a nested type, nullability, requiredness, enum payload, or array element type fails the gate.

**Dependencies / interactions**

Do after P1 domain changes settle so generated contracts do not churn twice.


### PCV-REAUD-029 — Readiness is based on registration, not current source health

**Category:** Reliability / UX  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`crates/portcove-core/src/service.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/service.rs) — `with_launch_readiness` / source requirements; desktop readiness view model

**Evidence**

Status marks source/BIOS blockers based on whether a registration record exists. It does not report whether the file is missing, its cheap metadata has changed, or its last full verification failed. Launch correctly performs a full identity check later, so a port can appear “Ready to launch” and then fail before spawn.

**Why it matters**

The safety boundary is sound, but recovery UX is late and surprising. A NAS path disconnect or moved source is common and should be visible before the user presses Play.

**Recommendation**

Represent source health separately as `unknown/available/metadata_changed/missing/verified/invalid`, with timestamps and a cheap startup stat check. Do not rehash multi-gigabyte files on every status read. Make launchability conservative only where the health state proves a blocker, and surface “verification required” distinctly.

**Validation**

Move/delete/change a registered source after a successful verification and assert status/UI transitions without full hashing; launch must still perform the authoritative check.

**Dependencies / interactions**

Build on the trust-level model in PCV-REAUD-005 and marker identity in PCV-REAUD-004.


### PCV-REAUD-030 — Required CI runs the full Rust workspace only on Windows

**Category:** CI/CD / Testing  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** M

**Location:** [`.github/workflows/ci.yml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/.github/workflows/ci.yml#L1-L180) — `rust` and `rust-quality` jobs

**Evidence**

The required `rust` job performs check, Clippy, and all workspace tests on `windows-latest`. Linux required CI runs the CLI machine contract, one backup-durability test, and quality tools, not the full core/workspace suite. macOS is exercised by release artifact builders/rehearsals rather than normal PR tests. Unix-only archive permissions and macOS bundle qualification can therefore merge without a routine platform test detecting them.

**Why it matters**

Portcove advertises Windows, Linux, Intel macOS, and Apple Silicon macOS. The most important remaining P1 failures are platform-specific and escaped an otherwise strong green baseline.

**Recommendation**

Add a focused required Linux core lane covering archive modes, process groups/signals, symlinks, and host-tool discovery. Add a small macOS qualification/smoke lane for bundle/executable contracts and path/process behavior; it need not repeat every Windows test. Keep expensive full packaging in release workflows.

**Validation**

The new tests for PCV-REAUD-002 and PCV-REAUD-006 must fail on current code and pass only with the fixes. Measure CI cost and keep targeted lanes bounded.

**Dependencies / interactions**

Directly validates PCV-REAUD-002, -006, -016, and -022.


### PCV-REAUD-031 — The core facade has become a workflow monolith

**Category:** Architecture / Maintainability  
**Priority:** **P2**  
**Confidence:** High  
**Effort:** L

**Location:** [`crates/portcove-core/src/service.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/service.rs) — `PortcoveService` and workflow helpers

**Evidence**

`service.rs` now coordinates status/readiness, planning, source registration/removal, backup inventory and hashing, destructive authorization, install/update/reconcile, activation/rollback/removal, adoption, launch supervision/recovery, repair, and many fingerprint/copy helpers. The file is roughly 200 KB. The concern is not line count alone: lifecycle journals, authorization fingerprints, persistence synchronization, and catalog policy are interleaved, making it easy for equivalent workflows to omit one invariant—as backup deletion did.

**Why it matters**

The next feature or safety fix requires understanding many unrelated workflows in one module. Conceptual duplication is more likely, and review boundaries are weak even though the public core authority is correct.

**Recommendation**

Keep `PortcoveService` as the stable public facade, but delegate internally to capability services/modules such as `BackupService`, `SourceService`, `InstallService`, `LaunchService`, `AdoptionService`, and `RepairService`, each receiving the same library/catalog/policy dependencies. Centralize shared lifecycle and authorization primitives. Decompose by invariant and transaction boundary, not arbitrary function size.

**Validation**

Architecture tests should enforce that CLI/Tauri still call the facade/core, and capability-level fault-injection tests should show identical behavior. Fallow/rscheck changes are secondary; the primary validation is fewer duplicated lifecycle patterns and explicit ownership.

**Dependencies / interactions**

Do after P1 behavior is corrected to avoid moving known bugs.


### PCV-REAUD-032 — Provider JSON and checksum bodies are read into memory without explicit size limits

**Category:** Security / Performance  
**Priority:** **P2**  
**Confidence:** Medium  
**Effort:** S

**Location:** [`crates/portcove-core/src/release.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/release.rs) — `get_json`, `checksum_from_sidecar`; GitLab provider

**Evidence**

Successful API and checksum responses use `response.text().await`, which buffers the entire body. Archive downloads are size-checked, but metadata/sidecar bodies have no explicit byte cap before allocation or caching. Curated GitHub/GitLab endpoints are lower risk than arbitrary internet content, yet upstream release descriptions/assets can still grow unexpectedly.

**Why it matters**

A huge response can consume memory, enlarge the SQLite cache, and degrade update-all. This is a strong static boundary concern, not an observed production incident.

**Recommendation**

Apply endpoint-specific caps (for example a few MiB for API JSON and far less for checksum text), stream with `take`/bounded accumulation, and reject oversize cache entries with typed diagnostics.

**Validation**

Fake providers should send oversized chunked JSON and checksum bodies; assert bounded memory behavior, no cache write, and an actionable error.

**Dependencies / interactions**

Combine with cache self-healing in PCV-REAUD-010.


## 5. P3 findings

### PCV-REAUD-033 — Frontend operation-event state grows for the lifetime of the app

**Category:** React/UI / Performance  
**Priority:** **P3**  
**Confidence:** Medium  
**Effort:** S

**Location:** [`apps/desktop/src/operation-state.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/operation-state.ts) — operation event map and latest-event selection

**Evidence**

Operation events are retained in a map so overlapping commands do not erase each other. Completed entries are not aggressively pruned, and selecting the current presentation sorts accumulated entries. In a days-long session with many bulk operations, memory and selection work grow monotonically.

**Why it matters**

The scale is likely modest today, so this is polish rather than a release blocker. The new overlap-safe design should retain bounded history rather than unbounded ephemeral UI state.

**Recommendation**

Remove terminal operations after a short display grace period or keep a fixed-size recent deque. Track the active/latest event incrementally rather than sorting the full map.

**Validation**

Feed tens of thousands of synthetic events and assert bounded retained entries and stable latest-operation behavior.

**Dependencies / interactions**

Independent.


### PCV-REAUD-034 — Diagnostic durability may be paying an fsync cost per event

**Category:** Performance  
**Priority:** **P3**  
**Confidence:** Low  
**Effort:** S

**Location:** [`apps/desktop/src-tauri/src/diagnostics.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src-tauri/src/diagnostics.rs) — JSONL append/rotation

**Evidence**

Diagnostics prioritize crash survivability and synchronize appended log data. Depending on filesystem and operation-event frequency, per-event syncing can be expensive. I did not profile this path, and current event volume may make the tradeoff entirely acceptable.

**Why it matters**

This is explicitly a profiling candidate, not a demonstrated defect. High-frequency progress events during downloads/builds are the only plausible pressure point.

**Recommendation**

Measure write latency and event throughput on Windows and a slower disk. Only if material, batch progress events while synchronizing start/finish/error records immediately. Preserve bounded rotation and crash-useful diagnostics.

**Validation**

Benchmark representative install/update event streams and compare latency, lost-tail behavior under forced termination, and bundle usefulness.

**Dependencies / interactions**

Do not change without measurements.


### PCV-REAUD-035 — Support-bundle redaction is pattern-based rather than data-classification-based

**Category:** Security  
**Priority:** **P3**  
**Confidence:** Medium  
**Effort:** M

**Location:** [`apps/desktop/src-tauri/src/diagnostics.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src-tauri/src/diagnostics.rs) — redaction and support bundle assembly

**Evidence**

The support bundle is commendably bounded and excludes source payloads, SQLite state, HTTP cache, and known credentials. Remaining log redaction searches keys/text patterns. A future structured diagnostic field with a novel secret-like value can bypass the pattern list if the producer does not remember the convention. I found no evidence of a current exposed token.

**Why it matters**

The current implementation is appropriate for V1, but a typed classification boundary scales better as diagnostics grow.

**Recommendation**

Introduce structured diagnostic fields with `Public`, `Path`, `Sensitive`, and `Secret` classes, defaulting unknown fields conservatively for export. Keep textual fallback redaction for third-party/error strings.

**Validation**

Property tests should generate sensitive keys/values and prove exported bundles never contain raw values; preserve readable non-sensitive diagnostics.

**Dependencies / interactions**

Longer-term hardening, not a V1 blocker.


### PCV-REAUD-036 — The migration lock has no bounded wait or owner diagnostics

**Category:** Developer Experience / Reliability  
**Priority:** **P3**  
**Confidence:** Medium  
**Effort:** S

**Location:** [`crates/portcove-core/src/database.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/database.rs) — migration lock acquisition

**Evidence**

Database initialization serializes migrations with an OS file lock, which correctly releases on process death. A live but hung process can hold it indefinitely, and another Portcove startup has no bounded wait, owner metadata, or actionable busy error comparable to per-port operation locks.

**Why it matters**

This is rare and the lock is safer than concurrent migration. The improvement is diagnosability and avoiding an apparently frozen startup.

**Recommendation**

Use a bounded acquisition loop with lock metadata (PID/start time/version) and return a typed conflict after a generous timeout. Do not allow force-breaking a demonstrably live migration lock.

**Validation**

Hold the lock in a helper process and assert bounded startup failure with owner details; terminate the helper and prove startup succeeds.

**Dependencies / interactions**

Independent.


## 6. Quick wins

These are high-confidence XS/S changes with good payoff. They do not replace the larger P1 work.

1. **Reject missing executable hints for every declared platform at catalog load.** This immediately catches Dinosaur Planet and future equivalents.
2. **Correct the DK64 macOS contract or remove that platform declaration until a bundle-aware fixture passes.**
3. **Reject tied top-scoring GitHub/GitLab artifacts instead of picking lexicographically.**
4. **Parse provider JSON successfully before writing it to the conditional-response cache.**
5. **On cached-304 parse failure, purge and retry once unconditionally.**
6. **Scope bare checksum lines to exact one-file sidecars; require filenames in aggregate manifests.**
7. **Guard `useInstallPlanning` and adoption preview with request generations.**
8. **Make Continue use the existing readiness model rather than only launch history.**
9. **Replace `all_installs` and `port_install_paths` with direct set/port queries.**
10. **Add the Linux executable-mode fixture to required CI before changing archive behavior, so the current defect is demonstrated first.**

Two apparently small fixes should **not** be applied as one-line ignores:

- do not “fix” PCV-REAUD-001 by ignoring all unknown runtime files;
- do not “fix” PCV-REAUD-003 by trusting any new DLL/shared library beside the executable.


## 7. Architecture assessment

### Boundary assessment

The high-level boundary is correct and should remain:

- `portcove-core` owns catalog interpretation, source/install identity, lifecycle transitions, backup semantics, launch coordination, and durable state;
- CLI and Tauri translate transport, confirmation, host integration, streams, and process presentation;
- React renders and orchestrates ephemeral interaction state;
- catalog data owns per-port contracts.

The remediation improved these boundaries. Native confirmation now belongs in Tauri while authorization remains in core; the CLI uses the same core grants. Blocking work is moved off the async runtime without duplicating domain logic. The detached helper is host-specific Tauri machinery but invokes core launch supervision.

### Missing domain abstractions

The next architectural improvements should be targeted:

#### 1. `InstallTreePolicy`

One policy should answer:

- which files are immutable application payload;
- which paths are persistent user data;
- which paths Portcove generates at install time;
- which paths Portcove may regenerate at launch;
- which files can influence process loading and must be negatively enumerated before spawn.

Today the installer, adapter, catalog, and launch verifier independently encode pieces of this concept. PCV-REAUD-001 and -003 are consequences.

#### 2. `VerifiedSourceMaterial`

Materialization should receive a content-bound object, not merely `&Path`. It should carry profile, normalized/storage digests, selected archive member/disc identity, and verification time. This closes PCV-REAUD-004 and supports the trust distinctions in PCV-REAUD-005.

#### 3. Durable `LaunchRequest`

A detached launch is no longer a synchronous function call. Model it accordingly: request ID, state, deadline/cancellation, child/session identity, completion, and cleanup. The UI should observe it rather than infer failure from a waiter timeout.

#### 4. Degraded backup inventory

Backup enumeration should be a resilient domain read model: valid backups plus typed damaged/tombstoned entries. That supports listing, doctor, repair, restore, and deletion without making one corrupted item a global error.

#### 5. Scoped and bulk reads

“Constant query count” is valuable for a catalog-wide read, but it is not the same as an efficient single-port read. Provide both. Share row decoders so scoped and bulk contracts cannot drift.

### `PortcoveService`

Keep the public facade. Internally separate capability services only after the P1 behavior is settled. The goal is to make transaction boundaries reviewable, not to create an abstract service layer for its own sake.


## 8. Security and reliability assessment

### Strong controls worth preserving

Portcove now has unusually good safety fundamentals for its size:

- child environments are cleared and reconstructed from an allowlist;
- catalog arguments are validated and processes are invoked without a shell;
- GitHub bearer credentials are origin-scoped and are not attached to asset origins;
- source files are referenced/read rather than uploaded or casually rewritten;
- release payloads require SHA-256 identity;
- install records bind artifact, manifest, and selected executable;
- archive extraction rejects traversal, links, special entries, collisions, excessive entry counts, oversized expansion, and suspicious compression ratios;
- per-port locks cover game runtime and post-exit save collection;
- destructive grants are action/target/fingerprint-bound, short-lived, and one-use;
- lifecycle operations recover across process interruption;
- backups hash deterministic path/content structure and preserve safety snapshots on restore.

These controls should not be weakened to reduce code or I/O.

### Remaining security-relevant risks

The most consequential remaining security concern is PCV-REAUD-003: targeted launch verification checks known critical files but not newly introduced load-relevant files. PCV-REAUD-001 also means the immutable-tree contract currently produces false positives, which encourages future developers to add broad exceptions; that would be dangerous.

Source identity needs more precise language. Extension-only profiles are not evidence of malicious code execution by themselves—the downloaded port remains checksum-verified—but they weaken the promise that Portcove has validated the user's original input. The right response is explicit trust state, not pretending every upstream can be independently identified.

### Recovery completeness

Install/adopt/remove/restore/activate recovery is a major success. Backup deletion and damaged backup inventory are the clear omissions. Launch recovery is conservative but should strengthen process identity beyond PID. Repair should eventually surface orphan launch request/response files and legacy deletion tombstones.

### Data-loss assessment

I found no established path that directly and silently deletes current user saves under normal successful workflows. The highest data-recovery concern is hidden backup tombstones after interruption, followed by global backup-list failure from one corrupt manifest.


## 9. Performance assessment

### Demonstrated or repository-measured

- Catalog-wide status uses a constant number of database queries and has tests at 250/500/1,000 rows.
- Bulk update checking is bounded to four concurrent resolutions and preserves requested order.
- Frontend Fallow reports a healthy maintainability/duplication baseline.
- The current desktop build size and catalog are modest; there is no evidence that React rendering is generally slow.

### Strong static-code concerns

1. **Single status reads the entire library** (PCV-REAUD-017).
2. **`all_installs` is N+1** (PCV-REAUD-018).
3. **Destructive flows can hash the same tree three times** (PCV-REAUD-019).
4. **GitLab metadata probing is serial N+1** (PCV-REAUD-014).
5. **Controller navigation reads layout at animation cadence** (PCV-REAUD-026).
6. **Per-launch observers repeatedly scan the launch-session table** (PCV-REAUD-027).
7. **Provider metadata bodies are unbounded** (PCV-REAUD-032).

These are worth correcting without speculative micro-optimization because the cost follows directly from library/port/session size.

### Profiling-only hypotheses

- per-event diagnostic syncing may be expensive during chatty progress streams;
- service construction plus lifecycle recovery on many Tauri commands may be measurable;
- source hashing remains inherently expensive and should be profiled before introducing persistent hash shortcuts;
- support bundle creation and activity rendering may need tuning only after real large libraries exist.

Do not add caching simply to avoid source revalidation. Any cache must remain bound to content identity and filesystem evidence.


## 10. Test strategy gaps

The existing test suite is substantial, but the following exact invariant tests are missing or insufficient:

| Subsystem | Required test | Failure class protected |
|---|---|---|
| Install manifest + adapters | Install, launch, then full verify for each adapter family | Expected Portcove mutation falsely treated as tampering |
| Launch trust | Add an unmanifested DLL/`.so`/`.dylib` before launch | Loader-side substitution not covered by positive rehash |
| Archive extraction | Preserve safe executable bits and spawn fixture on Linux; strip setuid | Non-launchable Unix installs / unsafe mode preservation |
| Catalog | Build qualification for every declared `(port, platform)` | Missing hints, directory-vs-file bundle contracts |
| Runtime materialization | Replace a valid source with same path/size/mtime | Stale prepared source reuse |
| Backup deletion | Fault after tombstone rename and restart | Hidden/lost backup |
| Backup inventory | Corrupt one of several manifests | Global backup outage |
| HTTP cache | Malformed 200→304→valid 200 | Persistent poisoned cache |
| Desktop launch | Preparation exceeding five minutes | Late surprise launch after timeout |
| Launch recovery | PID reused with different process birth identity | False live-session detection |
| React planning | Out-of-order plan/preview promises | Stale consent UI |
| Continue card | Missing/stale source and pending setup | Prominent guaranteed-failure action |
| CLI signals | SIGINT/CTRL-C during hashing/setup, before child | Uncancellable preparation |
| Transport | Nested type/nullability/schema mutation | Rust/TypeScript contract drift |
| Database | Correct columns but wrong constraints/indexes | Semantically weakened schema |
| Performance | Row/query/file-open budgets at 1,000+ records | Regressions hidden by constant-query metrics |

### Fuzzing/property testing

Targeted property/fuzz work would be valuable in only a few places:

- archive path normalization/collision/reserved-name logic;
- manifest relative-path parsing and generated/mutable policy disjointness;
- source-set/member matching and runtime marker serialization;
- checksum-manifest parsing;
- lifecycle recovery phase transitions.

Generic UI snapshots or broad property testing elsewhere would add less value than the concrete integration tests above.

### Mutation testing

Keep mutation testing focused on safety decisions: skipping a digest comparison, allowing an unknown critical companion, weakening path checks, bypassing authorization fingerprint comparison, or treating a recovery phase incorrectly. Mutating formatting/labels is not useful.


## 11. UI/UX/accessibility assessment

### Improvements since the previous audit

The desktop is notably better:

- root render failures have a recovery surface;
- native confirmation replaces renderer-only destructive confirmation;
- dialogs trap/restore focus and controller navigation stays within the top modal;
- main refreshes reject stale generations;
- concurrent operations are tracked independently;
- source, backup, update, and activity states are more discoverable;
- errors have copyable technical details;
- diagnostics/support bundle are user-accessible;
- theme and contrast contracts are automated.

### Remaining flow problems

#### Install review

An old plan can appear under a new port/channel. Add request-key validation and show the plan fingerprint/source state that will be rechecked on execution.

#### Adoption

A late old preview can repopulate after path/port changes. The backend safely rejects stale fingerprints, but the review screen should never display stale counts.

#### Continue

“Play again” must honor readiness. Controller-first users should not have to discover missing source/BIOS only after choosing the hero action.

#### Source health

“Registered” and “verified” need separate visible meanings. Show exact identity vs upstream validation vs unchanged baseline, plus missing/changed state without forcing a full rehash on every render.

#### Long-running launch preparation

The UI needs a durable operation state, not a five-minute spinner that can become a false failure while work continues elsewhere. Show an operation/session ID, current phase, safe cancel availability, and recovery after app restart.

### Controller performance

The interaction model is good; the implementation should stop doing geometry work on idle frames. This is a performance refinement that preserves, rather than replaces, the controller-first design.


## 12. CI/CD and release assessment

### Strong current state

The release/governance work is one of the repository's strongest areas:

- GitHub Actions are pinned to commits;
- workflow permissions default to read-only;
- dependency review runs on pull requests;
- the release matrix produces read-only artifacts;
- one publisher job receives write permission only after all platform builders;
- checksums are generated and reconciled;
- release reruns reconcile the exact expected asset set;
- published releases are not casually overwritten;
- manual rehearsal executes the same builders without publication;
- repository rules are both checked in and applied live;
- the ruleset requires strict status checks and review discipline.

This is appropriate supply-chain engineering for a public desktop application that installs third-party executables. It is not enterprise theater.

### Main gap

The required full Rust suite is Windows-only. Linux required CI runs selected contracts; macOS appears mainly in release builds. The current P1 archive-mode and macOS executable-contract defects illustrate why build success is not enough.

Add targeted required platform lanes rather than quadrupling every expensive check. Linux should execute the core Unix/process/archive tests; macOS should execute bundle/path/process qualification fixtures.

### Signing, notarization, SBOM, and provenance

The current decision to defer code signing/notarization until credentials and release process are available is reasonable, provided release documentation remains explicit. An SBOM/provenance attestation would be useful later, but it is lower value than fixing runtime trust and catalog qualification first. Do not block the next engineering phase on enterprise attestation machinery.


## 13. Dependency/tooling assessment

### Keep unchanged

- the pinned Rust 1.88 toolchain/MSRV contract;
- the documented `aes` compatibility pin needed to preserve that MSRV;
- exact pnpm version and frozen lockfile;
- SHA-pinned GitHub Actions;
- cargo-deny, cargo-shear, rscheck, Fallow, theme, release, architecture, and repository-settings gates;
- Tauri capability minimization;
- `rusqlite`/SQLite as the local durable store;
- keyring-backed credential storage;
- the current bounded-concurrency approach.

I found no evidence-based reason to replace these libraries or upgrade simply because newer versions may exist.

### Current dependency health

Hosted audit evidence reports no blocking cargo-deny/rscheck issues and no high-severity production npm advisory in required CI. Existing advisory/shape exceptions are documented rather than silently suppressed. That is the right practice.

### Tooling improvements

The primary tooling opportunity is to strengthen existing gates, not add more tools:

- make the transport gate type-complete;
- make the catalog gate instantiate every platform qualification;
- add targeted Unix/macOS runtime tests;
- extend recovery fault injection to backup deletion and launch request state;
- add row/file-open budgets alongside query-count tests.

Do not add another general-purpose linter until one of these concrete contracts requires it.


## 14. Documentation drift

### `docs/AUDIT-REMEDIATION.md`

The ledger is valuable and unusually detailed, but “all findings resolved” is too strong. At minimum:

- prior runtime-source marker identity remains incomplete (PCV-REAUD-004);
- prior backup failure isolation remains incomplete (PCV-REAUD-009);
- prior stale frontend planning and Continue readiness are still present (PCV-REAUD-023 through -025);
- executable/asset ambiguity is only partially resolved (PCV-REAUD-011/-012);
- controller scanning is improved in scope but not in idle cost (PCV-REAUD-026);
- the transport gate reduces drift but does not eliminate the second DTO authority (PCV-REAUD-028).

The ledger should move from binary “resolved” to `resolved / partially resolved / superseded / accepted / reopened`, with proof links.

### README and SECURITY

Claims about immutable install manifests need the expected runtime-generated-file exception defined correctly; current adapter behavior can invalidate the manifest. “Verified sources” should distinguish exact identity from integrity-only or upstream validation.

### Catalog/support claims

A declared platform currently implies more installability than the validator proves. Documentation should define:

- declared upstream availability;
- automated artifact/build qualification;
- Portcove install-contract qualification;
- hands-on launch validation.

Dinosaur Planet and DK64 macOS show why those stages should not be conflated.

### QUALITY

The current quality baseline is mostly accurate. Add the proposed cross-platform qualification contracts and clarify that query-count tests do not establish bounded row processing for single-port reads.

### DEFERRED

The deferred-work document is generally disciplined. Do not reopen signing, public OAuth/device-login packaging, delegated relay, remaining physical platform validation, or upstream-blocked ports as newly discovered findings unless their assumptions change.


## 15. Product gaps and feature opportunities

### V1 blocker/candidate

#### Trust-state clarity

Users need to know whether a source is:

- exact identity verified by Portcove;
- integrity-tracked but identity-unconfirmed;
- expected to be validated by an upstream setup tool;
- missing or metadata-changed;
- fully reverified recently.

This is not optional polish because source ownership is central to Portcove's value proposition.

#### Catalog installability status

The UI should not present a normal install action for a `(port, platform)` contract that cannot resolve a unique executable/bundle. A local catalog-health result should be available to CLI and desktop and should explain “upstream release unavailable”, “artifact ambiguous”, “executable contract incomplete”, or “qualification pending”.

#### Recovery center

Doctor/repair already exists in core. Make degraded backups, orphan deletion tombstones, launch-request debris, and incomplete lifecycle records visible in one recovery-oriented surface with conservative actions.

#### Durable launch preparation state

First-launch conversion/setup can be long. Expose a reconnectable operation/request rather than a synchronous five-minute wait.

### Near-term

#### Cached source-health observations

Store last verification time and cheap metadata observations to improve readiness without weakening authoritative launch revalidation.

#### Catalog qualification artifacts

For reviewed ports, keep tiny synthetic/metadata fixtures representing expected archive layout and executable path. This is more scalable than adding hand-written tests per port.

#### Backup export

Allow exporting one verified backup plus manifest as a portable archive and importing it through the same hostile-archive and identity checks. This solves a real local-first migration/recovery problem without cloud infrastructure.

#### Operation history detail

Persist concise phase/failure/repair linkage for long operations so users can understand what resumed, failed, or was recovered after restart.

### Long-term / optional

#### Library metadata export/import

A signed-or-hashed local metadata snapshot could support moving Portcove to another machine while revalidating local sources and installed artifacts. Do not copy user-owned game sources implicitly.

#### Community catalog contribution tooling

A maintainer-facing command could generate a proposed catalog entry, qualification report, checksums/evidence placeholders, and required tests. Avoid runtime third-party plugin catalogs until the trust model is explicit.

#### Optional OS integration

Shortcuts/protocol handlers are useful only after launch/request semantics and signing are stable.

### Already deferred

The following remain correctly deferred and are not counted as new findings:

- production GitHub App/device-login packaging and delegated relay;
- Windows code signing;
- macOS signing/notarization;
- remaining hands-on controller/TV/handheld validation;
- broader physical platform qualification;
- ports blocked on upstream release/source/setup behavior;
- future self-update/notification work where credentials and packaging are prerequisites.

### Features I would not build now

- cloud accounts or telemetry;
- a general plugin system;
- arbitrary untrusted remote catalogs;
- automatic source-file copying into a cloud/library;
- social/discovery features unrelated to local port management;
- microservices or a background daemon merely to avoid the current process model.


## 16. Things I would deliberately leave alone

1. **Core as the single domain authority.** Do not move lifecycle/source/install decisions into Tauri or React.
2. **SQLite with WAL and explicit locks.** It fits a local-first single-user desktop/CLI product.
3. **Holding the per-port lock through child exit and save collection.** The long lock is intentional protection against update/remove/rollback races.
4. **Full source revalidation before use.** Optimize redundant passes, but do not replace content verification with mtime alone.
5. **Fail-closed release checksums.** Do not accept checksum-less hosted artifacts for convenience.
6. **Central archive policy and rejection of links/special entries.** Preserve the conservative V1 extraction model.
7. **Explicit Unicode boundary for serialized/process paths.** It is a defensible V1 restriction if documented.
8. **Documented beta fallback semantics.** The code now consistently defines beta as newest prerelease, otherwise newest stable, excluding rolling-only tags. Do not reopen it as a bug unless product semantics change.
9. **Process-local destructive authorization.** Short-lived, one-use grants are appropriate and avoid durable capability leakage.
10. **Pinned toolchain and quality tools.** The exact-version discipline is a strength.
11. **Single-writer release publication.** Keep builders read-only.
12. **No telemetry/cloud dependency.** This matches the local-first product.
13. **No broad abstraction just to shrink large functions.** Decompose only around the domain boundaries identified above.
14. **Brand masters and documented visual provenance.** Do not recompress or regenerate them for trivial repository-size savings.


## 17. Prioritized implementation roadmap

### Phase 0 — close the install/launch trust contract

**Order**

1. Define `InstallTreePolicy` and fix launch-generated file classification (PCV-REAUD-001).
2. Add negative enumeration for unmanifested launch-critical companions (PCV-REAUD-003).
3. Preserve safe executable bits during archive extraction (PCV-REAUD-002).
4. Make every catalog platform construct a valid qualification; fix/remove Dinosaur Planet and DK64 macOS declarations (PCV-REAUD-006, -011).
5. Add required Linux/macOS targeted CI lanes (PCV-REAUD-030).

**Why first:** These changes determine whether an installed artifact is launchable and whether launch trust is real. Later caching/performance work must not encode the current inconsistent policy.

### Phase 1 — close source and backup identity/recovery

1. Introduce explicit source identity/integrity/upstream-validation states (PCV-REAUD-005).
2. Carry verified source identity into runtime materialization markers (PCV-REAUD-004).
3. Journal backup deletion and recover tombstones (PCV-REAUD-008).
4. Make backup inventory resilient to damaged entries (PCV-REAUD-009).
5. Self-heal malformed provider cache entries and scope checksum parsing (PCV-REAUD-010, -015, -032).

**Dependency:** Source marker design should consume the new trust-state type, not a transitional path-only API.

### Phase 2 — make long-running launch state honest and controllable

1. Replace synchronous request/response timeout with durable `LaunchRequest` state (PCV-REAUD-007).
2. Add cooperative pre-spawn cancellation to core/CLI (PCV-REAUD-022).
3. Strengthen recovered process identity beyond PID (PCV-REAUD-016).
4. Replace per-launch full-table polling (PCV-REAUD-027).
5. Expose source health/readiness and fix Continue (PCV-REAUD-029, -025).

### Phase 3 — fault isolation and scaling

1. Split single-port and bulk status reads (PCV-REAUD-017).
2. Remove install N+1 reads (PCV-REAUD-018).
3. Eliminate redundant destructive-plan hashing while preserving the locked recheck (PCV-REAUD-019).
4. Paginate hosted releases and bound GitLab package lookup (PCV-REAUD-013, -014).
5. Reject tied hosted artifacts (PCV-REAUD-012).
6. Add full schema-semantic verification where it protects real invariants (PCV-REAUD-021).

### Phase 4 — frontend contracts and internal structure

1. Add keyed stale-result protection for plan/adoption (PCV-REAUD-023, -024).
2. Make the transport gate type-complete or generate DTOs (PCV-REAUD-028).
3. Decompose `PortcoveService` by capability/transaction boundary (PCV-REAUD-031).
4. Optimize controller geometry only on input/layout invalidation (PCV-REAUD-026).
5. Bound operation-event state (PCV-REAUD-033).

### Phase 5 — durability and optional hardening

1. Decide and implement/document install power-loss durability (PCV-REAUD-020).
2. Add typed diagnostic field classification (PCV-REAUD-035).
3. Profile diagnostic syncing before changing it (PCV-REAUD-034).
4. Add bounded migration-lock diagnostics (PCV-REAUD-036).

Every phase should keep `just check` green; Phases 0–2 should also add focused fault-injection/process tests before closing findings in the ledger.


## 18. Top 10 recommendations

Ranked by improvement relative to implementation cost and risk:

1. **Unify immutable, mutable, generated, and launch-critical install-tree policy.** This fixes the most important internal trust contradiction.
2. **Preserve safe Unix executable permissions during archive extraction and prove actual spawn in Linux CI.**
3. **Add durable backup-deletion journaling plus resilient damaged-backup inventory.**
4. **Make source trust explicit and bind runtime materialization to verified digests.**
5. **Validate every declared port/platform into a unique executable or macOS bundle contract.**
6. **Reject newly introduced loader-relevant files before launch.**
7. **Replace the detached helper's five-minute waiter with a durable, observable, cancellable launch request.**
8. **Add focused required Linux/macOS runtime-contract CI rather than relying on Windows tests and release builds.**
9. **Make provider caches self-healing and release/asset selection fail closed on ambiguity.**
10. **Separate single-port reads from catalog-wide reads, then remove the remaining N+1 paths.**


## Appendix A — Previous-audit remediation assessment

### Clearly resolved or materially strengthened

The current implementation provides convincing evidence of closure for the major credential inheritance, pre-spawn marker, parent-bound desktop supervision, broad archive path/link/bomb controls, install artifact identity, ordered migrations, Unicode boundary, Tauri blocking-runtime, React error-boundary, structured error-kind, governance, MSRV, diagnostics, and release single-writer findings.

### Partially resolved or reopened

- runtime-source identity: stronger source revalidation exists, but the materialization marker is still metadata-bound;
- executable and asset selection: fallbacks were reduced, but basename and tied-score ambiguity remain;
- backup resilience: durability improved, but one corrupt manifest still fails the inventory and deletion lacks restart recovery;
- frontend concurrency: global refresh generations exist, but plan/adoption requests remain stale-able;
- Continue readiness remains unchanged;
- controller navigation is better scoped but still scans at animation cadence;
- Rust/TypeScript drift is checked more than before, but types are not generated or fully schema-compared;
- bulk status query count improved, but single-port reads now process global state.

### New integration defects exposed by remediation

- manifest policy does not account for adapter-generated launch files;
- the centralized archive writer drops safe Unix mode bits;
- the detached helper's synchronous five-minute response contract can diverge from autonomous execution.

This is why a fresh audit was necessary even after a thorough remediation pass.

## Appendix B — Evidence index

### Project intent and contracts

- [`AGENTS.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/AGENTS.md)
- [`README.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/README.md)
- [`SECURITY.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/SECURITY.md)
- [`CONTRIBUTING.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/CONTRIBUTING.md)
- [`docs/ARCHITECTURE.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/ARCHITECTURE.md)
- [`docs/QUALITY.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/QUALITY.md)
- [`docs/CATALOG.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/CATALOG.md)
- [`docs/CLI.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/CLI.md)
- [`docs/DEFERRED.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/DEFERRED.md)
- [`docs/DESIGN-SYSTEM.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/DESIGN-SYSTEM.md)
- [`docs/GUI-COMPETITIVE-REVIEW.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/GUI-COMPETITIVE-REVIEW.md)
- [`docs/RELEASING.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/RELEASING.md)
- [`docs/THEME.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/THEME.md)
- [`docs/BRAND-ASSETS.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/BRAND-ASSETS.md)
- [`docs/V1-CUTOFF.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/V1-CUTOFF.md)
- [`docs/AUDIT-REMEDIATION.md`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/docs/AUDIT-REMEDIATION.md)

### Core hostile-boundary and state code

- [`archive.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/archive.rs)
- [`install.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/install.rs)
- [`adapter.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/adapter.rs)
- [`process.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/process.rs)
- [`launch.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/launch.rs)
- [`operation.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/operation.rs)
- [`recovery.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/recovery.rs)
- [`authorization.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/authorization.rs)
- [`database.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/database.rs)
- [`library.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/library.rs)
- [`service.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/service.rs)
- [`release.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/release.rs)
- [`gitlab.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/gitlab.rs)
- [`catalog.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/src/catalog.rs)
- [`catalog.json`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-core/catalog/catalog.json)

### CLI, Tauri, and React

- [`crates/portcove-cli/src/main.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/crates/portcove-cli/src/main.rs)
- [`apps/desktop/src-tauri/src/lib.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src-tauri/src/lib.rs)
- [`apps/desktop/src-tauri/src/diagnostics.rs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src-tauri/src/diagnostics.rs)
- [`apps/desktop/src/api.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/api.ts)
- [`apps/desktop/src/types.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/types.ts)
- [`apps/desktop/src/use-portcove.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/use-portcove.ts)
- [`apps/desktop/src/App.tsx`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/App.tsx)
- [`apps/desktop/src/view-model.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/view-model.ts)
- [`apps/desktop/src/gamepad.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/gamepad.ts)
- [`apps/desktop/src/operation-state.ts`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/src/operation-state.ts)

### CI/release/tooling

- [`.github/workflows/ci.yml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/.github/workflows/ci.yml)
- [`.github/workflows/deep-quality.yml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/.github/workflows/deep-quality.yml)
- [`.github/workflows/release.yml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/.github/workflows/release.yml)
- [`.github/dependabot.yml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/.github/dependabot.yml)
- [`.github/repository-ruleset.json`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/.github/repository-ruleset.json)
- [`scripts/check-transport-contract.mjs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/scripts/check-transport-contract.mjs)
- [`scripts/check-release-metadata.mjs`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/scripts/check-release-metadata.mjs)
- [`scripts/release-preflight.ps1`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/scripts/release-preflight.ps1)
- [`Cargo.toml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/Cargo.toml)
- [`deny.toml`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/deny.toml)
- [`apps/desktop/package.json`](https://github.com/boburning/portcove/blob/8eb6881de65fba49ee643026545791cc3a40a5d0/apps/desktop/package.json)

## Appendix C — Severity interpretation

- **P0:** immediate critical security/correctness/data-loss condition;
- **P1:** should be corrected before serious V1/public-release claims;
- **P2:** worthwhile engineering improvement with concrete Portcove impact;
- **P3:** polish, optional hardening, or profiling-led opportunity.

No finding was promoted solely because a function/file is large, a dependency is not newest, or a generic best practice exists.


