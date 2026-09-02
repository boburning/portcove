# CLI contract

`portcove about` is the one intentionally branded human-readable command. It prints a compact product name, version, tagline, repository, and license without opening the library. `--json about` and `--jsonl about` preserve the normal machine envelope. Repeated operational commands never print banners or raster/ASCII artwork.

The CLI API schema version is independent of the Portcove release version. Every `--json` result has this envelope:

```json
{"schema_version":2,"ok":true,"command":"status","data":{},"error":null}
```

Errors use the same envelope with `ok: false`, `data: null`, and a stable error code. `--jsonl` emits operation events followed by one final `type: "result"` object. Diagnostics never contaminate JSON stdout.

## Discovery

```text
portcove --json capabilities
portcove --json schema export
portcove --json catalog export
portcove --json catalog list
portcove --json catalog show <port-id>
portcove --json storage
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

`auth login` uses GitHub's device authorization flow when the build has a public `PORTCOVE_GITHUB_CLIENT_ID`. `auth set-token` reads interactively with hidden input, or from standard input when `--stdin` is present. A token is deliberately never accepted as a positional option because command arguments can be exposed through process inspection and shell history. Tokens saved by either flow go to the operating-system credential store. `auth logout` removes that saved credential; it cannot remove an environment-provided token.

Automated frontends normally provide `PORTCOVE_GITHUB_TOKEN` in the child-process environment and avoid interactive auth commands. `auth status` reports only the credential source, GitHub login, and rate-limit headers; it never returns the token.

Call `capabilities` rather than assuming commands or platforms. It reports both the machine `schema_version` and the running `product_version`; integrations should branch on advertised capabilities instead of parsing either version string. Generate bindings from `schema export` when useful, and tolerate additive object fields within a schema version.

`catalog list` is a concise port array and `catalog show PORT_ID` retrieves one port. `catalog export` returns the complete versioned `CatalogDocument`, including every source profile referenced by a port. External frontends should use that document when they need accepted source extensions, exact multi-file or disc requirements, or source labels instead of copying Portcove's embedded catalog.

Schema version 2 changes the existing `update --all` result from an array of bare successful install records to failure-isolated outcome objects. Single-port `update`, other existing command shapes, and their stable error codes are unchanged. Consumers written for schema version 1 must branch on the envelope version before decoding an `update --all` result.

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

`ensure` returns the active installation when one exists and installs otherwise. `check` is read-only and resolves the latest checksum-qualified release for the selected channel. `reconcile` applies the stored policy: `notify` reports an available release without mutation, `stage` downloads it without switching versions, and `automatic` installs and activates it. Repeated runs reuse the matching staged version, and an automatic run promotes it transactionally. `activate` explicitly promotes the one staged version and preserves the deactivated version as the rollback target. Destructive or copying operations require `--yes` under `--non-interactive`. `exec` is intentionally network-free and GUI-free: it resolves the active executable, working directory, source reference, adapter arguments, and Portcove environment, then inherits standard input/output/error. A registered source is rehashed against its stored baseline before install, update, or launch; an unregistered source remains optional at launch for ports whose generated data is already complete. Adapter arguments are prepended to arguments after `--`; mutable catalog paths are restored before launch and collected from the exact launched version after the child exits. A port may transactionally materialize a catalog-declared runtime source through N64 normalization, bounded copy/ZIP extraction, GameCube ISO conversion, PS1 CHD expansion, or PS2 ISO/CHD normalization. A source marker prevents redundant work and forces restaging when registration changes.

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

The plan reports the resolved release and asset size, current platform and channel, registered game-source and BIOS requirements, containing-volume capacity, and one typed action: `already_active`, `use_staged`, `reuse_retained`, `blocked_unverified`, or `download`. Planning may perform a normal conditional network lookup and update Portcove's HTTP response cache, but it does not download a release, change source registrations, switch versions, or create an activity record. `use_staged` does not imply activation: the following install's `--stage` choice still controls whether that verified release remains staged. Asset size is the upstream download size; callers must not present it as a guarantee of final extracted footprint.

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

`backup create` first collects mutable data from a previously launched active release, then copies the complete canonical user-data root into `backups/<port-id>/<backup-id>/data` and publishes it with an adjacent `backup.json` manifest only after the copy is complete. The result reports its stable ID, absolute path, creation timestamp, file count, byte count, and deterministic tree SHA-256. Empty roots fail with `not_found`; a symlink, non-Unicode path, or unsupported filesystem entry fails closed with no published partial backup. `backup list` is local, read-only, network-free, newest-first, and ignores operation-private staging directories. All backup commands validate the port against the embedded catalog.

`backup restore` is destructive to current persistent data and therefore requires confirmation, or `--yes` for an unattended caller. It copies the selected snapshot into an operation-private staging directory, recomputes and compares its file count, byte count, and tree SHA-256, then creates an automatic safety backup of current non-empty data before atomically replacing the canonical user root. A missing, mismatched, symlinked, or tampered backup fails before live data or the backup list changes. The result includes both `restored_backup` and the new `safety_backup`; the latter is absent only when no current files existed. Restore does not modify application versions or original game sources, and the restored data is synchronized into the active release on its next Portcove launch.

`backup delete` also requires confirmation or `--yes`. It validates the selected snapshot and atomically moves only that directory out of the visible backup set before removal. A filesystem removal failure attempts to put the snapshot back under its original ID; if recovery itself fails, the structured error reports the hidden recovery path. Current persistent data, application versions, original sources, and every other backup are outside the deletion target.

Mutating commands, verification, and `exec` use a cross-process lock for the selected port. A second frontend targeting that same port fails immediately with `error.code: "conflict"`, exit code 14, and `details.port_id`; it should retry later rather than run a competing operation. The launch lock remains held through game exit and post-exit mutable-data collection. Commands for other ports continue independently. `capabilities.port_operation_locking` is `per_port_fail_fast` when this contract is available.

An update also reuses a matching verified version already retained as a rollback or inactive installation. `--stage` marks that local version for activation, while a normal update promotes it without another download.

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
