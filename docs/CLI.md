# CLI contract

Without a machine-output flag, Portcove renders concise human output. Catalog, status, source, backup, activity, storage, doctor, plan, paths, authentication-status, and capability reads use labeled summaries or tables; other results use a control-character-safe labeled document rather than exposing transport JSON. `portcove about` remains the one branded command and prints a compact product name, version, tagline, repository, and license without opening the library. Repeated operational commands never print banners or raster/ASCII artwork.

`--json` and `--jsonl` remain the stable automation surfaces and are byte-shape independent from human rendering. Use `--json catalog export` and `--json schema export` when consuming their full documents programmatically.

The CLI API schema version is independent of the Portcove release version. Every `--json` result has this envelope:

```json
{"schema_version":7,"ok":true,"command":"status","data":{},"error":null}
```

Errors use the same envelope with `ok: false`, `data: null`, and a stable error code. `--jsonl` emits versioned operation events followed by one final `type: "result"` object. Each event carries `operation_id`, `sequence`, `timestamp_ms`, operation name, optional typed target and parent ID, plus a terminal `result` for success, failure, or cancellation. Event delivery is best-effort; the activity ledger is authoritative after reconnect or restart. Diagnostics never contaminate JSON stdout.

Argument-parser failures also use the machine envelope when `--json` or `--jsonl` is present. Their stable command name is `cli`, their error code is `usage`, and they exit with code 2. Help and version output remain intentionally human-readable even when a machine-output flag is supplied.

The compiled-binary machine contract is exercised on both Windows and Linux CI. These tests treat stdout line count, envelope fields, nested command names, JSONL completion, parser behavior, and exit codes as public integration behavior rather than implementation details.

## Discovery

```text
portcove --json capabilities
portcove --json schema export
portcove --json catalog export
portcove --json catalog list
portcove --json catalog show <port-id>
portcove --json storage
portcove --json doctor
portcove --json plan <port-id>
portcove --json paths <port-id>
portcove --json backup list <port-id>
```

## GitHub authentication

Authentication is optional. Anonymous operation remains supported, while a GitHub user token raises the API allowance and lets unchanged conditional requests return `304 Not Modified` without consuming the authenticated primary limit.

```text
portcove --json auth status
portcove auth login
portcove auth set-token
Get-Content $tokenFile -Raw | portcove --non-interactive --json auth set-token --stdin
portcove --json auth logout
```

`auth login` uses GitHub's device authorization flow with Portcove's public GitHub App client ID. `PORTCOVE_GITHUB_CLIENT_ID` can override it at runtime or build time; an explicitly empty override disables device login. Its polling wait is asynchronous, follows GitHub's pending and slowdown intervals, reports expiry or denial as typed errors, and can be cancelled with Ctrl-C. `auth set-token` reads interactively with hidden input, or from standard input when `--stdin` is present. A token is deliberately never accepted as a positional option because command arguments can be exposed through process inspection and shell history. Tokens saved by either flow go to the operating-system credential store. `auth logout` removes that saved credential; it cannot remove an environment-provided token.

Automated frontends normally provide `PORTCOVE_GITHUB_TOKEN` in the child-process environment and avoid interactive auth commands. `auth status` reports only the credential source, GitHub login, and rate-limit headers; it never returns the token.

Call `capabilities` rather than assuming commands or platforms. It reports both the machine `schema_version` and the running `product_version`; integrations should branch on advertised capabilities instead of parsing either version string. `raw_stream_commands` identifies commands such as `exec` that intentionally cannot use the advertised machine formats. Generate bindings from `schema export` when useful, and tolerate additive object fields within a schema version. Portcove's own desktop declarations are checked against that export by `just check-rust`, including all catalog adapters, shared enum values, and the top-level fields of transported DTOs.

`doctor` is a local, network-free, read-only host report. It returns the current platform, library capacity, catalog/installation/source counts, one typed entry for each optional host tool Portcove can use, and a repair plan. The repair plan reports partial lifecycle operations, cleanup-pending private trees, missing registered install paths, and untracked final directories; it proposes an action but never mutates or deletes them. Tool state is `available`, `missing`, or `misconfigured`; an available tool includes its resolved path and whether it came from an environment override or normal discovery. Missing optional tools do not fail the command because callers may never select a port or source format that needs them. An explicit but invalid `PORTCOVE_CHDMAN` or `PORTCOVE_DOLPHIN_TOOL` remains `misconfigured` instead of silently falling back to another executable. `status` and `doctor` never initialize missing per-port settings; their in-memory defaults come from the catalog, choosing stable when offered and otherwise the port's first declared channel. A later policy-only change persists that same catalog default.

`catalog list` is a concise port array and `catalog show PORT_ID` retrieves one port. `catalog export` returns the complete versioned `CatalogDocument`, including every source profile referenced by a port. External frontends should use that document when they need accepted source extensions, exact multi-file or disc requirements, or source labels instead of copying Portcove's embedded catalog.

Schema version 2 changed `update --all` from an array of bare successful install records to failure-isolated outcome objects. Schema version 3 adds immutable `artifact`, `manifest_sha256`, and `selected_executable` fields to install records, plus `installed_artifact` to update checks. Schema version 4 adds deterministic adoption, backup-action, and managed-removal previews and renames the source-removal consent fingerprint to `preview_sha256`. The human-facing `version` remains the upstream display tag; integrations must use the artifact SHA-256 when deciding whether two releases are identical. Consumers written for an earlier schema must branch on the envelope version before decoding these results.

`source add` validates the configured extension plus any exact SHA-1 and SHA-256 allowlists before recording the source reference. A source that matches the game name but not the required revision fails with `source_invalid` and exit code 5. An `upstream-validated-disc` profile is deliberately two-stage: registration records and later rechecks the local ISO/CHD container, while exact retail-revision admission is delegated during setup to a checksum-verified upstream extractor with fixed catalog arguments. Extractor rejection is returned as the same structured `source_invalid` failure before the game can launch.

PS1 managed recomp profiles accept CHD sources. Pass one `.chd` path for a single-disc title. For a declared multi-disc title such as Final Fantasy VII, pass one directory containing exactly the required `.chd` files with filenames that sort in disc order:

```text
portcove --library <path> --json source add twisted-metal-4-psx "D:\ROMs\Twisted Metal 4.chd"
portcove --library <path> --json source add final-fantasy-vii-psx "D:\ROMs\Final Fantasy VII"
portcove --library <path> --jsonl ensure mortal-kombat-4-recompiled --source "D:\ROMs\Mortal Kombat 4.chd" --bios "D:\BIOS\scph1001.bin"
```

Portcove uses `chdman` only in an operation-specific temporary directory to validate normalized disc content. It checks `PORTCOVE_CHDMAN`, `PATH`, its own executable directory, `MAME_HOME`, launcher-provided `RETROBAT_ROOT` paths, EmuDeck's backend tool path, and the normal MAME/Batocera system paths. A missing tool fails with structured `searched_paths` and `setup_hint` details; Portcove never silently downloads an executable. A declared `--bios` is independently checked against its catalog source profile, registered for future updates, passed to the reviewed generator, and removed from staging after its generated backend is built. The managed PS1 runtime mounts the original registered CHD directly after installation; it does not retain an expanded BIN/CUE copy.

GameCube source profiles accept the catalog-declared ISO/GCM and compressed RVZ/CISO/GCZ/WIA formats. Portcove validates the normalized ISO hash and records the original container hash separately. When a port needs an ISO in its managed runtime, the same locally supplied DolphinTool performs a transactional conversion. Discovery checks `PORTCOVE_DOLPHIN_TOOL`, `PATH`, Portcove's executable directory, `DOLPHIN_HOME`, launcher-provided `RETROBAT_ROOT` paths, common Unix locations, and the standard macOS app bundle. Missing tooling fails with structured setup details and never triggers a download.

File-set profiles take one directory or ZIP path. Every required top-level member is matched by its catalog filename allowlist and exact SHA-1, SHA-256, and/or CRC32 identity; missing members, duplicate alternatives, nested ZIP entries, and directory symlinks fail closed. The source record aggregates all member identities, records a ZIP container identity separately, and launch can transactionally stage each reviewed member to a separate managed destination. This keeps the CLI contract one-path-per-profile for external frontends even when a port requires a cartridge, disk, firmware, or arcade ROM set.

A reviewed single-disc PS1 port may request `psx-bin-cue` runtime materialization. Portcove uses the same registered CHD and local `chdman` trust boundary to create one cue sheet and split track BIN files in a staging directory, then swaps the complete directory into the managed release. A reviewed multi-disc profile may instead request `psx-raw-set`, which validates each filename-sorted CHD and transactionally writes numbered raw data tracks such as `disc-01.bin`. A failed extraction leaves the prior runtime directory intact. Original CHDs remain the registered sources and are never modified.

Source integrity checks are local, network-free, and read-only:

```text
portcove --library <path> --json source verify <profile-id>
portcove --library <path> --json source verify --all
```

Verification reruns the source profile validation and compares the current file's size and SHA-256 with the baseline stored by `source add`. It never replaces that baseline. A missing or changed file fails a single-profile command with the normal structured error and exit code. `--all` returns one failure-isolated outcome per registered profile; completing the batch returns exit code 0, so consumers inspect each outcome's `ok`, `result`, and `error` fields. An empty registry returns an empty successful batch.

`source remove <profile-id>` first returns or prints a preview containing the exact registered source, every catalog port that shares it, the currently installed dependents, and a confirmation token. Removal requires interactive confirmation or `--yes`; core rejects the token if the source identity or installed-dependent set changes before deletion. Only the reference is removed. Original source bytes and managed installs are never deleted.

After moving a source yourself, preview and apply its new location without resetting its content identity:

```text
portcove --library <path> --json source relink <profile-id> <new-path>
portcove --library <path> --json source relink <profile-id> <new-path> --apply --expected-plan <preview_sha256>
```

The preview validates the new path against the current catalog profile and the registered content hash and size; the old path may be offline. It returns the original record, validated replacement, and `preview_sha256` without changing either file or the registry. Apply takes the profile and dependent-port locks, revalidates the replacement, and rejects a stale plan if registration, catalog rules, location, or validated bytes changed. A different container is allowed only when its normalized content is identical. Settings → Sources → Relink source uses the same core operation. Registration, relinking, and removal fail with a conflict while a dependent port is running or another source writer holds the profile lock.

## Opt-in source discovery

```powershell
portcove --json source discover --root D:\Sources --profile minish-cap-gba --profile super-smash-bros-64
portcove --json source add <profile-id> <candidate-path> --expected-sha256 <candidate-sha256>
```

Discovery requires explicit roots and source profiles. It never registers a match automatically. Defaults are 10,000 examined entries, six nested directory levels, 512 MiB per file, 8 GiB of cumulative hashing, and 64 matches. The corresponding `--max-entries`, `--max-depth`, `--max-file-bytes`, `--max-hash-bytes`, and `--max-candidates` flags can narrow these limits; core also enforces hard ceilings. The report identifies searched scope, validated candidates, hashed bytes, reached limits, and bounded per-path issues. A partial search is not evidence that every file was considered.

Only exact-hash original-file and cartridge-ZIP profiles participate automatically. Other source contracts report that manual selection is required. Symlinks and entries outside the selected canonical roots are skipped. Equal profile contracts share hashing; both normalized ZIP payload and original container bytes count toward the budget. Accepting a candidate with `--expected-sha256` checks the current profile and reviewed content under the normal source locks before registration. Settings → Sources → Find source files exposes the same search, cancellation, and explicit acceptance.

## Cancellation

```text
portcove --json activity
portcove --json cancel <activity-uuid>
```

An active cancellable activity reports `cancellation.phase` (`preparing` or `finishing`) and `cancellation.requested`. `cancel` accepts only a running preparation and returns request acknowledgement. Wait for the operation or ledger to report its terminal outcome. A completed cancellation has status/error code `cancelled`, a schema-2 finished event with `result: cancelled`, and exit code 130 for the cancelled command. A late request returns `conflict`; it cannot interrupt publication. Existing failure-isolated batch commands still return per-port outcomes, which must be inspected individually.

Ctrl-C requests cancellation of this CLI command's current and queued source discovery, release checks, install, update, ensure, or reconciliation work, then keeps waiting. Unix SIGTERM uses the same path. Another client's operations are unaffected. Downloads and hashing stop cooperatively; extraction, conversion, or compilation may need to finish their current preparation step. Repeated signals do not force an unsafe publication interruption. Restore, library transfer, migration, and game supervision retain their existing recovery/lifetime behavior. Desktop game details and activity history offer the same core cancellation request; source search also keeps its own Cancel search control inside its dialog.

## Library metadata

```text
portcove --library <path> --json library export
portcove --library <path> --json library export --output <new-file.json>
```

Export reads one consistent SQLite snapshot. The versioned metadata document contains source references, managed version identities, active/previous/staged state, per-port preferences, and successful launch history. Application versions, user data, backups, and toolchains are identified as separate content roots; their contents and credentials are not embedded. Managed installation paths become relative to the original library root, while source references retain their original paths and identities.

Without `--output`, the document appears in the normal CLI response. With `--output`, core writes a raw metadata document to a new file and returns its path, byte size, and SHA-256. Publication does not replace an existing file. Settings → Library → Export metadata invokes the same operation through a native save dialog.

## Library imports and recovery

Import a trusted metadata export together with a separate backup folder containing its `versions`, `user`, `backups`, and `toolchains` trees:

```text
portcove --library <new-or-empty-root> --json library import <metadata.json> <copied-library-folder>
portcove --library <new-or-empty-root> --json library import <metadata.json> <copied-library-folder> --apply --expected-plan <plan-sha256>
portcove --library <destination> --json library resume-import
portcove --library <destination> --json library abort-import
```

Review reads only the explicitly selected metadata and content, checks capacity and portable paths, and rejects existing application/source/settings/history state. Apply requires both flags, recomputes the plan, acquires exclusive library access, copies without replacing existing files, restores metadata transactionally, and verifies the copied manifests against current platform executable and persistence rules. Active, previous, and staged identity and source references survive the round trip. Import does not copy input SQLite, credentials, HTTP caches, or logs; metadata JSON is limited to 16 MiB and the recoverable inventory to 64 MiB. Source references remain subject to normal validation and relinking.

An interrupted import reports `details.import_destination` and `recovery_action: resume_library_import`. Unpublished copies remain closed until recovery succeeds. Resume after publication preserves new destination saves and works with the old backup offline. Abort retains every copied file and keeps the incomplete destination closed; choose a different empty destination for another import. Settings → Library → Import library exposes review, native confirmation, and recovery for the currently configured empty library. This is a trusted local-backup restore, not a merge operation or proof of third-party backup authenticity.

## Library moves and recovery

```text
portcove --library <original> --json library move <new-directory>
portcove --library <original> --json library move <new-directory> --apply --expected-plan <plan-sha256>
portcove --library <original> --json library resume-move
portcove --library <original> --json library abort-move
```

Review is read-only. The destination must be a new directory beneath an existing parent. The plan identifies the four managed content categories, source references, required working space, and available capacity. It rejects symlinks, special entries, case-insensitive collisions, and paths outside the conservative portable ASCII filename policy. Source references stay at their original paths. Complete all launch/lifecycle recovery and close other Portcove clients before applying; every open handle holds a library lease. Settings → Library → Move library uses the same plan and core operation while releasing its own cached handles.

Apply recomputes the reviewed fingerprint, copies with no overwrite, verifies file inventories, metadata, SQLite integrity and immutable installation manifests, then switches authority. The original directory is retained as a recovery copy. Opening that old path subsequently follows the verified relocation, so configured paths survive an ordinary move. For disk removal or machine migration, configure the new root directly. Metadata export alone is not a payload backup or import.

An interrupted move blocks normal use until `resume-move` finishes or `abort-move` reactivates an unpublished original. Pass the original directory, including when normal opening is blocked. Abort never deletes copied files, and it refuses once authority publication has begun. An unmarked destination with ambiguous database state is retained for inspection. Startup and the move dialog expose these same recovery actions. Recovery after activation preserves any new destination saves. Do not manually remove authority markers to bypass these checks.

Machine schema version 5 introduced `move_library` to the activity operation enum and exports library metadata, move-plan, and move-result schemas. Move result fields identify the retained source, destination, active root, and terminal completion state. A transfer awaiting recovery has a durable journal and running activity; a resumed or aborted transfer records its explicit terminal outcome.

## Idempotent automation

```text
portcove --library <path> --json --non-interactive ensure <port-id> [--channel stable|beta|rolling] [--source <path>]
portcove --library <path> --json status [port-id]
portcove --library <path> --json check <port-id>
portcove --library <path> --json check --all
portcove --library <path> --jsonl reconcile <port-id>
portcove --library <path> --jsonl reconcile --all
portcove --library <path> --jsonl update --all [--stage]
portcove --library <path> --json verify <port-id>
portcove --library <path> --json activate <port-id>
portcove --library <path> exec <port-id> -- <game arguments...>
```

`ensure` returns the active installation when one exists and installs otherwise. `check` is read-only and resolves the latest checksum-qualified release for the selected channel. Stable selection excludes prereleases; beta selects an eligible prerelease when present and otherwise falls back only to an eligible stable release; rolling selects only its exact configured tag. GitHub and GitLab use this same core rule. `check --all` uses the core batch path, runs at most four provider resolutions concurrently, preserves catalog order in its outcomes, and does not retry a rate-limited item implicitly. `reconcile` applies the stored policy: `notify` reports an available release without mutation, `stage` downloads it without switching versions, and `automatic` installs and activates it. Repeated runs reuse the matching staged version, and an automatic run promotes it transactionally. `activate` explicitly promotes the one staged version and preserves the deactivated version as the rollback target. Destructive or copying operations require `--yes` under `--non-interactive`; after confirmation, core issues a five-minute, one-use authorization bound to the action, target, and reviewed state and consumes it only under the operation lock. Adoption prints a content-hashed copy plan and every skipped symlink or special entry before confirmation. `exec` is intentionally network-free and GUI-free: it resolves the active executable, working directory, source reference, adapter arguments, and Portcove environment, then inherits standard input/output/error. Because the launched game owns those streams and its process exit code, `exec` rejects `--json` and `--jsonl` with a structured usage error before starting a child; external frontends should use machine mode for management and plain `exec` for launch. A registered source is rehashed against its stored baseline before install, update, or launch and receives one final identity check after adapter preparation before a child can start. Managed PS1 builds likewise recheck storage bytes around disc materialization and BIOS use. An unregistered source remains optional at launch for ports whose generated data is already complete. Adapter arguments are prepended to arguments after `--`; mutable catalog paths are restored before launch and collected from the exact launched version after the child exits. A port may transactionally materialize a catalog-declared runtime source through N64 normalization, bounded copy/ZIP extraction, GameCube ISO conversion, PS1 CHD expansion, or PS2 ISO/CHD normalization. A source marker prevents redundant work and forces restaging when registration changes.

Portcove V1 requires every path that crosses a durable SQLite/JSON boundary or child-process argument/environment boundary to be valid Unicode. On Unix, a non-UTF-8 library, source, install, backup, lifecycle, executable, or generated runtime path fails with `unsupported` instead of being stored or launched through a lossy alias.

`exec` forwards arguments after `--` literally only to native executables. A cataloged Windows `.bat` or `.cmd` launcher crosses an implicit `cmd.exe` boundary, so Portcove rejects caller-supplied arguments for that launch kind and permits only fixed catalog arguments that pass the batch metacharacter policy. The same core process policy removes GitHub and credential-shaped environment variables from games and every third-party setup, validation, conversion, and builder process while retaining the reviewed host/session variables required for graphics, audio, locale, profile paths, Steam/Proton, Wine, and executable discovery. Native games run in a supervised process group. Ctrl-C, plus SIGTERM on Unix, is forwarded to that group; the CLI keeps supervising until the child exits and exact-install save collection finishes.

Status objects include additive `readiness`, `last_launched_at`, `successful_launches`, and `last_update_check` fields. Readiness separates missing source/BIOS blockers from one-time upstream setup. Launch history advances only after a child process exits successfully; a failed start, crash, or non-zero exit never becomes a Continue candidate. Both the CLI and desktop write the same SQLite record, so external frontends can use these fields without scraping GUI state.

`last_update_check` contains the timestamped successful `UpdateCheck` most recently produced by `check`, `update`, or `reconcile`. It survives process and desktop restarts. Consumers should display it as current only when its channel equals the status channel and its `installed_version` equals the active version; Portcove's GUI applies both guards so activating a release or changing channels cannot leave a stale update badge. A failed network or release check does not overwrite the last successful snapshot, and its error remains available through the command result and applicable activity record.

Durable management activity is available without scraping transient JSONL progress or the desktop UI:

```text
portcove --library <path> --json activity [--limit 1..200]
```

The newest records are returned first. Each record has a stable `id`, typed `operation`, `target_kind` (`port`, `source`, or `library`), optional `target_id`, `status` (`running`, `succeeded`, or `failed`), start and finish timestamps, and an optional failure message. Core-managed update checks, install, update, policy reconciliation, install/source verification, activation, rollback, backup, restore, adoption, removal, and source registration all write this same SQLite ledger whether initiated by the CLI or desktop. Listing activity is local, read-only, and network-free. Portcove retains the newest 1,000 terminal records plus any still-running records; callers can request at most 200 at once. A `running` record means the operation has not reported a terminal result; consumers should not infer success from it. The desktop labels a record that remains running for 24 hours as `Unfinished`, but this is presentation only: CLI consumers retain the original state and can choose a threshold appropriate to their host.

Storage preflight is also local, read-only, and network-free:

```bash
portcove --library <path> --json storage
```

The response contains the resolved `library_root` plus `volume_total_bytes` and `volume_available_bytes` for the filesystem containing it. LaunchBox, Playnite, RetroBat, EmuDeck, Batocera, and other callers can use the raw byte counts to warn before a large install without scraping platform-specific disk tools. The values describe the containing volume, not Portcove's own footprint.

Before presenting an install or update confirmation, a frontend can resolve Portcove's intended work without mutating installed state:

```bash
portcove --library <path> --json plan <port-id> [--channel stable|beta|rolling]
```

The plan reports the resolved release and asset size, current platform and channel, registered game-source and BIOS requirements, containing-volume capacity, and one typed action: `already_active`, `use_staged`, `reuse_retained`, `blocked_unverified`, or `download`. These actions compare immutable artifact identity, not display version, so an upstream republish under the same tag is still an update. Planning may perform a normal conditional network lookup and update Portcove's HTTP response cache, but it does not download a release, change source registrations, switch versions, or create an activity record. `use_staged` does not imply activation: the following install's `--stage` choice still controls whether that verified release remains staged. Asset size is the upstream download size; callers must not present it as a guarantee of final extracted footprint.

Save managers and launcher integrations should ask Portcove for its canonical roots rather than constructing internal paths:

```bash
portcove --library <path> --json paths <port-id>
```

The response contains `user_data_root` plus the active, previous, and staged install roots when those versions exist. Back up the complete user-data root: catalog persistence rules may include saves, configuration, controller bindings, mods, generated assets, or upstream-specific portable state. The path remains canonical even before the directory has been populated. Treat install roots as read-only implementation state and never modify SQLite directly.

Portcove can also create and enumerate its own immutable snapshots:

```bash
portcove --library <path> --json backup create <port-id>
portcove --library <path> --json backup list <port-id>
portcove --library <path> --json backup restore <port-id> <backup-id> --yes
portcove --library <path> --json backup delete <port-id> <backup-id> --yes
```

`backup create` first collects mutable data from a previously launched active release, then copies the complete canonical user-data root into a private directory and publishes it as `backups/<port-id>/<backup-id>` with an adjacent `backup.json` manifest only after the copy is complete. Every copied file and the manifest are flushed. The same-volume rename gives atomic namespace visibility to running processes. On Linux filesystems that accept directory `fsync`, Portcove additionally synchronizes the staged directory tree and the backup parent before reporting success, covering that supported directory-durability boundary. Other platforms and Linux filesystems that reject directory synchronization do not receive that claim, so a successful backup there does not promise that the final directory entry survives sudden power loss even though partial data is never published during normal execution or process failure. The result reports its stable ID, absolute path, creation timestamp, file count, byte count, and deterministic tree SHA-256. Empty roots fail with `not_found`; a symlink, non-Unicode path, or unsupported filesystem entry fails closed with no published partial backup. `backup list` is local, read-only, network-free, newest-first, and ignores operation-private staging directories. All backup commands validate the port against the embedded catalog.

`backup restore` is destructive to current persistent data and therefore requires confirmation, or `--yes` for an unattended caller. It copies the selected snapshot into an operation-private staging directory, recomputes and compares its file count, byte count, and tree SHA-256, then creates an automatic safety backup of current non-empty data before replacing the canonical user root with same-volume renames. Those renames and the lifecycle journal prevent another running process from observing a partial staged tree and allow unambiguous process-crash recovery; they are not a cross-platform sudden-power-loss guarantee. A missing, mismatched, symlinked, or tampered backup fails before live data or the backup list changes. The result includes both `restored_backup` and the new `safety_backup`; the latter is absent only when no current files existed. Restore does not modify application versions or original game sources, and the restored data is synchronized into the active release on its next Portcove launch.

`backup delete` also requires confirmation or `--yes`. It validates the selected snapshot and moves only that directory out of the visible backup set with a same-volume rename before removal. This is process-visibility isolation, not a claim that deletion survives sudden power loss. A filesystem removal failure attempts to put the snapshot back under its original ID; if recovery itself fails, the structured error reports the hidden recovery path. Current persistent data, application versions, original sources, and every other backup are outside the deletion target.

Mutating commands, verification, and `exec` use a cross-process lock for the selected port. A second frontend targeting that same port fails immediately with `error.code: "conflict"`, exit code 14, and `details.port_id`; it should retry later rather than run a competing operation. The launch lock remains held through game exit and post-exit mutable-data collection. An unfinished durable launch session continues to block the port even if its supervisor crashes; desktop startup recovers that exact recorded child/install before clearing the session. Commands for other ports continue independently. `capabilities.port_operation_locking` is `per_port_fail_fast` when this contract is available.

An update also reuses a matching artifact already retained as a rollback or inactive installation. Before reuse, activation, rollback, or launch, Portcove checks the registered manifest identity and current critical executable/library/bootstrap bytes. `--stage` marks the checked local artifact for activation, while a normal update promotes it without another download. An install migrated from an older schema without immutable identity must be replaced or re-adopted; Portcove never fabricates its provenance.

`check --all`, `reconcile --all`, and `update --all` are failure-isolated and operate on installed ports. Every port produces an outcome with its own `port_id`, `ok`, `result`, and `error` fields. A metadata, source, verification, or download failure for one port does not suppress other results. Completing the batch returns exit code 0, so schedulers must inspect each outcome's `ok`; a command-level setup failure still uses the normal non-zero exit codes. `update --all --stage` stages successful updates without activation. Without `--stage`, each port's stored update policy is honored: a `stage` policy remains staged while `notify` and `automatic` ports activate the requested update. A source override is deliberately rejected with `--all` because one path cannot safely satisfy multiple source profiles.

`source verify --all` follows the same batch rule, keyed by `profile_id` rather than `port_id`. `capabilities.failure_isolated_batches` advertises these contracts so launchers do not need to infer support from a Portcove version string.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 2 | Usage or confirmation required |
| 3 | Unsupported channel/platform/workflow |
| 4 | Not found |
| 5 | Invalid source |
| 10 | Network failure |
| 11 | Verification failure |
| 12 | Installation failure |
| 13 | Local state failure |
| 14 | Conflict |
| 125 | Launch setup failure |

For `exec`, a successfully started game returns its exit code when it fits the portable `0..=255` process range. Native Windows crash statuses and other out-of-range codes map to `1`, never `0`, while termination without a code maps to `125`. Integrators should treat the structured `error.code` as authoritative for management commands.

## Environment

- `PORTCOVE_LIBRARY`: overrides the default library root.
- `PORTCOVE_GITHUB_TOKEN`: preferred optional GitHub API token for unattended update checks.
- `GH_TOKEN` / `GITHUB_TOKEN`: compatible fallbacks when the Portcove-specific token is absent.
- `PORTCOVE_GITHUB_CLIENT_ID`: public GitHub App client ID used by device login. It may be embedded at build time or provided at runtime; it is not a client secret.
- `PORTCOVE_PORT_ID`: supplied to launched ports.
- `PORTCOVE_USER_DATA`: stable per-port mutable-data directory.
- `PORTCOVE_SOURCE`: registered source path when the port needs one.
- `PORTCOVE_CACHE`: generated-cache location for applicable adapters.
- `PORTCOVE_CHDMAN`: optional full path to `chdman`; an invalid explicit path fails closed instead of falling back to another copy.
- `PORTCOVE_DOLPHIN_TOOL`: optional full path to `DolphinTool`; an invalid explicit path fails closed instead of falling back to another copy.
- `DOLPHIN_HOME`: optional Dolphin installation directory hint used after `PATH` discovery.
- `MAME_HOME`: optional MAME directory hint used after `PATH` discovery.
- `RETROBAT_ROOT`: optional RetroBat root hint used to inspect its MAME and tools subdirectories.
- `PORTCOVE_TEMP_DIR`: optional parent directory for operation-specific temporary disc extraction; useful when the system drive lacks working space.

Adapters and reviewed catalog entries may additionally set an upstream-native variable such as `SHIP_HOME` or `POKEPORT_IMPORT_ROM`, create a documented portable-mode marker, and prepend fixed launch arguments. Consumers should treat all environment fields, portable markers, and built-in arguments as Portcove-owned and add only game-specific arguments after `--`.

Environment tokens take precedence over a credential saved by Portcove. Tokens are sent only as bearer authorization to the configured GitHub API origin. Release assets, checksum URLs, redirects to other origins, operation journals, structured output, SQLite state, cached response bodies, and child-game environments never receive the token.

There is no prompt unless an operation needs confirmation. Pass `--non-interactive` from frontends and services.

## Signed catalog delivery

API schema 7 adds catalog provenance to `doctor`, public-key trust and selection state, signed-envelope/payload schemas, reviewed catalog updates, and the `update_catalog` activity operation. Operation event schema stays at 2.

- `catalog status`: current effective provenance, trusted public keys, highest accepted sequence, valid rollback/cache availability, and `state_sha256`.
- `catalog trust-key <64-character-public-key-hex> [--yes]`: explicitly trust a publisher. Non-interactive callers need `--yes`; verify its fingerprint independently first.
- `catalog revoke-key <key-id> --expected-state <state_sha256>`: remove trust and immediately recompute fallback.
- `catalog update --file <signed.json>` or `--url <https-address>`: verify and return a read-only plan, including changed port IDs, validity, publisher fingerprint, and `plan_sha256`.
- The same command with `--apply --expected-plan <plan_sha256>`: reread, reverify, and atomically publish only the reviewed candidate against unchanged trust/selection state.
- `catalog rollback --expected-state <state_sha256>`: select the still-trusted, unexpired previous catalog. The replay floor never decreases, and the rejected newer version is not retained as fallback.
- `catalog use-embedded --expected-state <state_sha256>`: choose the built-in catalog without discarding trust, cached versions, or replay history.
- `catalog use-cached --expected-state <state_sha256>`: reverify and select the cached signed catalog without downloading or admitting an older external candidate.

Local-file review does not write library domain state. Explicit HTTPS delivery is anonymous, bounded to 4 MiB and 20 seconds, and rejects redirects, userinfo, fragments, and non-HTTPS URLs. Catalog application supports cross-process cancellation and CLI Ctrl-C/SIGTERM until publication admission; SQLite activation, replay advancement, and the terminal activity outcome commit together. A service command uses the catalog snapshot it opened with; subsequent commands see the new selection. See [SIGNED-CATALOG.md](SIGNED-CATALOG.md) for the exact signing contract and offline publisher utility.
