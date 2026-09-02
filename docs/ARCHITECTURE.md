# Architecture

Portcove currently has one authority for catalog, source, release, installation, and launch behavior: `portcove-core`. The CLI and Tauri backend are thin adapters around it. The React frontend invokes Tauri commands and never owns installation state.

```text
Playnite / LaunchBox / RetroBat / EmuDeck / scripts
                         │ JSON, JSONL, exit codes
                         ▼
                    portcove CLI
                         │
React UI ── Tauri IPC ───┤
                         ▼
                  portcove-core
       catalog ─ releases ─ adapters ─ installer
                         │
                 SQLite + library tree
```

## Evolution policy

This document records the architecture Portcove tests today; it is not a promise to preserve the initial crate graph forever. The durable requirement is unambiguous ownership, not the name or number of crates. A real implementation need may justify splitting a coherent domain from `portcove-core`, adding a boundary service, or keeping genuinely host-specific orchestration in an adapter.

Make such changes as one reviewed migration: explain the pressure and tradeoffs here, assign one owner to every durable state transition, update `scripts/check-rust-architecture.mjs` and its tests, and remove the superseded route. Safety invariants, machine-readable CLI compatibility, and rollback behavior remain hard constraints. File size, a complexity score, or a desire to make a tool green is not sufficient evidence by itself.

In this document, “thin adapter” means that the CLI and desktop do not reimplement catalog, installation, release, source, or library policy. Adapters may own concerns that exist only at their boundary, including argument and IPC translation, native dialogs, credential-store access, process attachment, and presentation-shaped aggregation. If a boundary concern becomes reusable domain behavior, move it behind the shared authority instead of copying it.

## Library model

The default application-data directory contains:

```text
library/
  portcove.sqlite3
  versions/<port-id>/<artifact-sha256>/
  staging/<operation-id>/
  recovery/<operation-id>/
  user/<port-id>/
  downloads/
  toolchains/
  logs/
```

SQLite stores source references, settings, install records, active/previous version pointers, successful launch history, timestamped successful update-check snapshots, a typed activity ledger, durable launch sessions, and the small set of incomplete cross-store lifecycle operations. An install record keeps its human-readable display version separately from the asset name, verified asset SHA-256 and size, manifest SHA-256, and selected executable. Database opening takes a library-scoped operating-system migration lock before checking or changing the schema. Migrations are contiguous, individually transactional, postcondition-checked steps; a gap, a recorded partial step, or a schema newer than the running build fails with the affected versions instead of guessing. WAL and the busy timeout remain ordinary concurrency aids, not migration locks. Schema-8 migration leaves pre-identity installs explicitly unqualified rather than inventing provenance; they fail current-integrity gates until replaced or re-adopted. Schema 9 records the supervisor, child PID, exact install identity/root, and launch phase needed to fail closed across a frontend or supervisor crash.

Management operations create a running activity before work and finish it as succeeded or failed without replacing the command's primary result. Best-effort progress uses a versioned core event envelope containing that activity UUID, a per-operation sequence, millisecond timestamp, typed target, optional parent operation, and terminal result. Nested work receives its own ID and names the parent. SQLite activity is authoritative after disconnect or restart; event delivery is never treated as durable truth. Update snapshots likewise come from the core, allowing a CLI check to repopulate the desktop after restart; consumers validate the snapshot's installed artifact digest, display version, and channel before presenting it as current.

Every filesystem-mutating operation takes an operating-system advisory lock keyed by library and port. The lock is shared across CLI and desktop processes, fails immediately with a structured conflict instead of waiting indefinitely, and is released automatically if a process exits. A launch retains its lock until the game exits and the exact launched version's mutable data has been collected, so another frontend cannot update, roll back, remove, verify, or launch that port during the save-critical interval. The desktop starts a detached instance of its own native binary in a hidden supervisor mode; Tauri only requests the launch and observes the durable session. The supervisor records its session and child PID before reporting success, writes the per-version launched marker only after child creation, waits for the child, records successful-exit history separately from in-flight state, and clears the session only after exact-install collection. If that supervisor disappears, the durable row continues to block mutation; startup launches a recovery helper that waits for the recorded child when it is still alive and performs the same exact-install collection. Different ports remain independently operable.

Each registered source keeps its original path, content identity, storage identity, and registration time. A normal file has the same content and storage identity. A ZIP-backed cartridge records the selected inner member separately from the outer ZIP, a GameCube compressed image records its normalized ISO identity separately from its container, and a PS1 CHD records the normalized Track 01 identity separately from the CHD container. A file-set profile registers one folder or ZIP and derives a stable identity from every exact, top-level member; folder symlinks, nested ZIP members, and ambiguous alternative names are rejected. ZIP-backed file sets also retain the outer container identity. A declared multi-disc profile similarly derives a stable identity from its exact filename-sorted CHD set. Verification reruns the catalog profile checks and compares both fresh identities with the stored baseline without updating SQLite or copying the source. It runs on demand and before a registered source is reused for install, update, or launch. Source failure is detected before launch markers or mutable data are changed. Single-profile checks return normal structured failures; bulk checks isolate each profile so one missing or replaced file does not hide the others.

Before launch, catalog-declared persistent paths are synchronized from `user/<port-id>/` into the active version. They are collected from that exact launched version when the child exits and before update, staged activation, rollback, removal, or backup. Synchronization refuses symlink destinations and ancestors. A per-version marker prevents a fresh release's defaults from replacing established user data while still recovering changes after an abnormal exit. Adapters may also use an upstream storage contract: Libultraship receives `SHIP_HOME`, N64 recomp releases get their upstream-supported `portable.txt` marker, and a reviewed catalog entry can declare a portable marker beside its executable together with a narrowly validated source-import variable and fixed arguments. Mutable paths are resolved against the same working directory the adapter launches, including when a release archive contains a wrapper directory.

Persistent-data backups use the same per-port lock and canonical user root. A backup is copied into a same-volume temporary directory, rejects symlinks or unsupported entries, writes and flushes its identity/count/size/tree-digest manifest, and is then renamed into `backups/<port-id>/<backup-id>`. Listing ignores private dot-directories and validates manifest identity against both the requested port and directory name. Restore stages and rehashes the selected tree before mutation, creates an automatic safety backup when current data is non-empty, and records the staged/current/recovery paths before swapping them. Startup can finish either half of an unambiguous interrupted swap. Confirmed deletion similarly renames one validated snapshot to a private recovery path before removing it and attempts to return it on failure. Backups are intentionally independent of install rollback: they preserve mutable data, while release rollback changes application versions.

## Install transaction

1. Validate catalog, channel, platform, and required source reference.
2. Query the declared GitHub or GitLab game upstream, or a reviewed pinned direct manifest, and enforce its lifecycle policy.
3. Select a platform asset and require a SHA-256 digest or checksum sidecar.
4. Create a durable SQLite intent tied to the activity UUID, then download into a same-volume operation-specific staging directory.
5. Enforce the declared compressed size and global download ceiling while streaming, then verify SHA-256 before extraction.
6. Preflight the complete ZIP or TAR before writing. The shared release/toolchain policy accepts regular files and directories only; rejects traversal, links, special files, duplicate/case-folded paths, Windows device names, alternate-data-stream separators, trailing-dot/space aliases, unsafe Unicode, and file/directory collisions; and bounds compressed bytes, expanded bytes, entry bytes/count, compression ratio, path length/depth, and required free space.
7. Resolve the executable only from catalog-qualified hints. Hash immutable files into a schema-2 manifest bound to port, install, display version, artifact, selected executable, and critical-file identities; then record the `prepared` postcondition.
8. Atomically rename the version into the library, record `payload_published`, commit activation or staging metadata, and record `metadata_committed`.
9. Remove only the operation-private staging tree. Failed cleanup remains `cleanup_pending` for retry; completed journals are removed because the activity ledger owns terminal history.

Adoption uses the same publication state machine and never copies into a final version path directly. Removal runs it in reverse: every registered managed version is renamed under `recovery/<operation-id>/` before SQLite metadata is deleted, then quarantine cleanup is retried. Startup advances only recorded states whose payload, manifest, and path layout are unambiguous. It never deletes an untracked final directory. The read-only doctor repair plan reports incomplete journals, cleanup-pending trees, registered paths that are missing, and orphaned final directories with proposed review actions.

Staged activation and rollback collect user data from the version being deactivated only when its per-version launch marker proves it has actually run, then change active/previous pointers transactionally. The same guard applies before install, update, removal, and retained-version reuse, so a verified but never-launched release cannot propagate absent files as user-requested deletions. Adoption copies files into a new managed version and leaves the source directory untouched.

When an update resolves to an artifact already present in the managed library, Portcove compares the verified digest, asset name, and size rather than the display tag. A republished stable, beta, rolling, or direct-manifest tag therefore remains visibly the same version while becoming a distinct update and content-addressed install. Before active/staged/retained reuse, activation, rollback, recovery, or launch, Portcove validates the manifest identity and rehashes the selected executable plus immutable libraries and bootstrap configuration beside it. Catalog-declared mutable paths are excluded from this hot critical set; explicit full verification checks every other immutable file and rejects unexpected immutable additions.

The desktop process shares one release provider across Tauri commands. Successful resolutions are cached in memory for five minutes, so checking the Update Center and immediately applying stored policies does not repeat GitHub repository and release requests. GitHub repository and release response bodies also use a library-scoped SQLite cache with their `ETag` and `Last-Modified` validators. A later GUI or CLI process sends conditional requests and reuses the cached body on `304 Not Modified`. Failures are never cached, and each installed port retains an independent batch outcome.

Disk-heavy desktop commands run on Tauri's blocking worker pool. Source hashing, manifest verification, managed-tree copies or removal, adoption, rollback, activation, and launch preparation therefore do not occupy the IPC event loop. Their command names, structured errors, and core-service safety boundaries are unchanged.

## GitHub trust and discovery

Portcove works anonymously, with a token supplied by the host process, or with a user credential held by the operating-system secure store. Environment credentials take precedence so launchers and managed deployments remain deterministic. Neither tokens nor device-flow access codes enter the library database, cache, structured output, logs, release downloads, or launched-game environments.

Device authorization uses a public GitHub App client ID and stores the resulting user token only after GitHub validates it. A personal token follows the same validation and storage path. The GUI and CLI expose authentication status and rate-limit metadata without exposing credential material.

Authentication does not grant webhook access to arbitrary upstream repositories. A future optional Portcove update relay may combine webhooks from cooperative upstreams with one centralized conditional poller and publish signed advisory catalog events. Local polling remains authoritative and available without an account or relay; every event must still pass normal repository, channel, asset, and checksum validation before installation.

RetComM is not a Portcove release provider. Its title catalog is used only by a CI audit to confirm that PS1 entries still name the same direct per-game repositories. The RetComM launcher cannot satisfy a game release request and is explicitly rejected by catalog validation. `retcomm-toolchains` is a separate checksum-pinned build dependency used by the shared PS1 adapter.

## Adapter boundary

Adapters describe recurring families rather than individual games: libultraship portable releases, N64 recomp portable releases, staged-source portable releases, referenced-disc ports, generated-cache ports, upstream-managed setup, and managed PS1 recomp builds. Port-specific facts stay in `catalog.json`: repository, channels, platform availability, source profile, executable hints, launch behavior, persistent paths, and optional runtime subdirectory and source paths. Source profiles may use exact SHA-1, SHA-256, file-set CRC32, reviewed PS1 ISO-volume allowlists, or a tightly bounded upstream-validator handoff so Portcove can enforce the strongest identity form an upstream actually publishes while continuing to record SHA-256 in local state. A declared runtime subdirectory keeps working-directory, portable-marker, and stored-source behavior inside a stable nested release layout without port-specific code. Runtime source materialization is limited to reviewed generic operations: N64 byte-order normalization, bounded exact copy or ZIP-member extraction, GameCube or PS2 ISO conversion, single-disc PS1 CHD expansion to a multi-BIN/CUE directory, and multi-disc PS1 CHD expansion to numbered raw data tracks. File replacements and directory swaps preserve the prior destination until the staged replacement is ready; source sidecars force restaging when registration changes.

The upstream-managed setup adapter runs only a checksum-verified executable selected by catalog hints, fixed reviewed arguments, and the normalized registered source. It requires a concrete safe-relative marker before producing a game launch specification. The service writes its first-success marker only after all adapter preparation succeeds, so source rejection or partial extraction cannot be reported as a completed launch.

The managed PS1 adapter downloads a platform-specific, fixed-version toolchain asset, verifies its declared size and SHA-256, and extracts it through the same bounded archive policy into Portcove's private toolchain cache. Its schema-2 marker binds the pinned artifact to the current bytes of bundled Python, CMake, Ninja, and toolchain metadata; cache reuse fails after any critical-file change. It invokes only the reviewed `generate` and `rebuild` commands with toolchain downloads disabled; it does not execute arbitrary catalog scripts. CHD extraction for identity checks is temporary. A title may declare a second exact BIOS source profile; it is validated and recorded independently, supplied only to the reviewed generator, and the staged raw dump is removed after backend generation. The installed runtime is configured to mount the verified original CHD path directly, and that path is rewritten from the registered source before each launch so moving and re-registering a source remains recoverable. Generated compiler intermediates and expanded disc files are pruned before activation.

V1 deliberately avoids automating arbitrary build scripts or installers. A new adapter is warranted only when several active projects share a deterministic, reviewable workflow.

## Child-process boundary

`portcove-core::ChildProcessPolicy` is the single construction path for every production child process. Callers select a typed class for games, upstream setup, host tools such as `chdman` and DolphinTool, managed builders, or operating-system integration. All classes begin from the same reviewed session allowlist rather than inheriting the complete Portcove environment. The allowlist preserves cross-platform process discovery, profile/home, temporary-directory, locale, desktop/display, audio/graphics, Steam/Proton, Wine, and dynamic-runtime variables needed by native ports. GitHub variables and other credential-shaped token, secret, password, API-key, cloud-key, SSH-agent, and askpass variables are removed centrally. Catalog/adapter overlays are checked by the same policy and cannot reintroduce a credential-shaped variable.

Native game executables receive catalog-owned arguments plus literal caller arguments. Windows `.bat` and `.cmd` launchers are represented as `WindowsBatch`; caller arguments are rejected, and fixed catalog arguments pass a strict metacharacter check before the implicit `cmd.exe` boundary. Setup tools, validators, builders, conversion tools, and host integration require native executables. `scripts/check-child-process-policy.mjs` prevents a production adapter from reintroducing direct `Command::new` construction outside the core policy.

Supervised native games run in their own process group. The CLI intercepts Ctrl-C and, on Unix, termination, forwards it to that group, and continues waiting so the core can complete exact-install save collection. A nonzero exit or signal is a failed launch outcome and never advances successful-launch history, but it does not skip collection. The desktop supervisor is detached from the UI process and uses null standard streams; closing the window therefore cannot become a save-lifecycle decision.

## External frontend contract

The CLI is the integration boundary. Consumers should probe `capabilities`, including `product_version`, `failure_isolated_batches`, and `port_operation_locking`, use `--json` for request/response automation or `--jsonl` for progress streams, select an explicit library, and launch through `exec`. `catalog export` supplies the complete versioned port and source-profile document, `activity` supplies a bounded, newest-first durable ledger for frontends that need recent results without replaying progress streams, and `storage` reports the resolved root and containing-volume capacity. `plan` combines release resolution, retained/staged version discovery, registered requirements, and capacity into a typed preflight without changing installed state. `paths` exposes canonical persistent-data and managed-version roots so backup tools do not depend on private layout conventions; `backup create`, `list`, and confirmed `restore` provide a first-party snapshot lifecycle. Bulk check, reconcile, and update operations isolate every installed port; bulk source verification isolates every registered profile. Frontends must inspect each nested outcome rather than treating a completed batch as proof that every item succeeded. `catalog export`, `source verify --all`, `activity`, `storage`, `paths`, `backup list`, and `exec` are network-free; backup create/restore are also network-free but copy local data, `plan` may make a conditional release request, and launch inherits the child's standard streams and exit code.
