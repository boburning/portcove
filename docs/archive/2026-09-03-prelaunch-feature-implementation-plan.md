> Historical planning evidence. Canonical GitHub issues own executable scope, and Project fields own live priority and status. This file is not a live roadmap authority. Appendix A supersedes its Workstream 1 wherever supported-source identity, provenance, inspection, admission, or qualification conflicts.

# Portcove Prelaunch Feature Implementation Brief for Codex

> Revision 2 — September 3, 2026: feature #3 includes a saved, game-specific export/install destination in both CLI and GUI, in addition to the overall library location. This supersedes the original library-only restriction. Other feature decisions, including optional version pinning, are unchanged.

## Operating instruction

Work directly in `https://github.com/boburning/portcove` from the current `main` branch.

This is an implementation task, not an analysis-only task. Inspect the repository, make the changes, add migrations and tests, update the documentation and machine contracts, and run the repository quality gates. Do not stop after producing another plan.

Complete workstreams 1–4 as required launch work. Workstream 5 is optional and must come last; only expose exact-version selection if its pinning and update semantics are complete and tested.

Read these first:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/CLI.md`
- `README.md`
- the current source-validation, release-provider, library, CLI, Tauri, and React implementations

Establish the baseline with `just check`. Preserve unrelated local work and do not rewrite unrelated history. If the baseline is already failing, record the exact failure, determine whether it is related, and continue without hiding it.

## Current architecture to preserve

Portcove has one durable domain authority:

- `crates/portcove-core` owns catalog validation, source identity, source registration, releases, installs, updates, rollback, library state, and launch safety.
- `crates/portcove-cli` is a thin adapter.
- `apps/desktop/src-tauri` is a thin host/IPC adapter.
- React owns presentation and ephemeral UI state only.

Do not implement source matching, release selection, library-location or per-game output-location rules, or tool resolution independently in CLI and React. Put each rule in core and transport the resulting DTOs.

Preserve all existing safety properties:

- exact source identity and storage identity
- normalized-content versus original-container distinction
- SHA-256-qualified release installation
- archive traversal and size protections
- symlink and special-file protections
- per-port locking and lifecycle recovery
- persistent-data protection and rollback
- child-process environment scrubbing
- credential isolation
- no arbitrary executable or URL injection

## Fixed product decisions

These decisions are part of the task. Do not ask the user to choose among them.

1. **Use “Supported ROMs” or “Supported source” in the product UI, not “good ROMs.”**
2. **Support both an overall library location and a separate export/install folder for each game.** The library remains the authority for metadata, saves/configuration, backups, source registrations, and shared resources. A game without an override uses the existing library-relative output location; a game with an override stores its managed application versions in that game-specific folder. Remember the override per port, expose it in CLI and GUI, and make updates, launch, verification, rollback, and removal honor recorded locations. Do not implement this feature merely by changing `--library` or creating a second whole library per game.
3. **Keep the existing global `--library` option as the highest-priority, one-invocation override.** Add a persisted default library-location workflow for both CLI and desktop.
4. **Add a Portcove-managed Source Inbox under the selected library.** Use a deterministic per-profile directory so a source already placed there can be discovered without another file picker.
5. **Add official tool links and persistent manual executable selection now.** Do not add a generic downloader, `curl | shell`, package-manager invocation, or unverified auto-install path.
6. **A selected historical release is a persistent version pin.** Do not ship a version dropdown that is silently undone by the next update/reconcile operation.
7. **Never link to, download, or search ROM-distribution sites.** Catalog labels and hashes may be enriched only from trustworthy upstream port documentation, build scripts, or established checksum references. Never invent a hash pairing or revision label.

Names below are recommended. They may be adjusted to existing repository conventions, but the semantics and acceptance criteria are required.

---

# Workstream 1 — Structured supported-ROM identity and source inspection

## Goal

For every port with a source profile, show the supported source variants when the catalog has enough information. When the user selects or registers a source, show:

- whether it matches
- the exact matched variant when known
- the full actual digest values
- the full expected digest values
- the distinction between normalized game content and the original storage/container
- a truthful non-match, format-only, or upstream-validation-pending state

A non-empty path must no longer count as “ready” by itself.

## 1.1 Replace parallel hash allowlists with named source variants

The current top-level `accepted_sha1` and `accepted_sha256` arrays cannot reliably say which SHA-1 and SHA-256 belong to the same dump. Introduce one authoritative variant model and migrate the embedded catalog to it.

A suitable shape is:

```rust
pub struct SourceVariant {
    pub id: String,
    pub label: String,
    pub accepted_filenames: Vec<String>,
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub crc32: Option<String>,
    pub volume_ids: Vec<String>,
    pub reference_url: Option<String>,
}

pub enum SourceVerificationPolicy {
    ExactIdentity,
    FormatOnly,
    UpstreamValidator,
}
```

Apply the same named-variant concept where appropriate to:

- a simple `SourceProfile`
- each `SourceMemberProfile` in a file set
- each declared disc in a multi-disc profile

Keep track counts and other structural requirements at the correct profile/member/disc level.

Matching rules:

- An exact variant must contain at least one identity datum.
- Every identity datum present on one variant must match the corresponding computed datum.
- A variant with both SHA-1 and SHA-256 requires both to match.
- Multiple variants may each contain only the algorithm that is actually known.
- Duplicate or ambiguous variant identities must fail catalog validation.
- `FormatOnly` must never render as a checksum match.
- `UpstreamValidator` must clearly say that container admission is provisional and exact revision validation occurs during the reviewed upstream setup step.

Bump the embedded catalog schema from 1 to 2. Migrate all current catalog entries and remove the old parallel hash arrays rather than leaving two authorities.

While migrating data:

- Preserve every currently supported source unless it is demonstrably incorrect.
- Use existing profile labels as a conservative fallback.
- Inspect upstream project repositories, source-checking scripts, and documentation when a friendly region/revision label can be verified.
- Do not guess which hashes form a pair.
- If no exact checksum is known, use the explicit `FormatOnly` or `UpstreamValidator` policy and honest copy.
- Add optional provenance URLs only when they are trustworthy and directly relevant.

## 1.2 Add one non-mutating core inspection authority

Create a non-mutating source-inspection API in core. Registration and verification must consume this same authority rather than maintaining separate hashing/matching implementations.

A suitable result model is:

```rust
pub enum SourceMatchVerdict {
    ExactMatch,
    ExactMismatch,
    FormatAccepted,
    UpstreamValidationPending,
    InvalidStructure,
    ToolRequired,
}

pub struct SourceHashes {
    pub sha1: Option<String>,
    pub sha256: Option<String>,
    pub crc32: Option<String>,
    pub size: u64,
}

pub struct SourceObjectEvidence {
    pub content: SourceHashes,
    pub storage_sha256: Option<String>,
    pub storage_size: Option<u64>,
    pub volume_id: Option<String>,
    pub track_count: Option<u32>,
}

pub struct SourceInspection {
    pub profile_id: String,
    pub path: PathBuf,
    pub verdict: SourceMatchVerdict,
    pub registerable: bool,
    pub matched_variant_id: Option<String>,
    pub matched_variant_label: Option<String>,
    pub actual: SourceObjectEvidence,
    pub expected: Vec<ExpectedSourceVariant>,
    pub members: Vec<MemberInspection>,
    pub messages: Vec<String>,
}
```

Required behavior:

- A readable but wrong ROM returns a successful inspection DTO with `ExactMismatch`; it must not be reduced to an exception that loses the expected-versus-actual evidence.
- Missing files, unsafe paths, unreadable data, unsafe archives, and internal failures remain typed errors.
- `register_source` calls inspection and only records a source when `registerable` is true.
- Existing `source add` failure behavior remains nonzero for a mismatch, but error details should include useful actual and expected digest information.
- `verify_source` continues to fail integrity verification when bytes changed, while also making structured evidence available to desktop callers.
- Compute SHA-1, SHA-256, and CRC32 in one streaming pass where those values are relevant. Do not read large files multiple times only to calculate different digests.
- Keep long-running hashing off the Tauri async/UI thread and emit useful operation progress for large source/disc inspections.
- Reuse all current normalization semantics:
  - inner ROM identity versus outer ZIP identity
  - normalized GameCube ISO identity versus RVZ/CISO/GCZ/WIA container identity
  - normalized PS1 content/disc evidence versus CHD storage identity
  - file-set member identities plus aggregate identity
  - multi-disc evidence per disc plus aggregate identity
- For compressed or normalized sources, the UI must label `content` and `original file/container` hashes explicitly. Do not compare a container hash to an expected normalized-content hash.

If `adapter.rs` becomes harder to maintain, extract the touched hashing, inspection, and matching code into a focused `source.rs` or `source_identity.rs` module. Do not perform an unrelated broad refactor.

## 1.3 Persist enough evidence for fast rendering

Add a forward-only SQLite migration after the current schema version.

Persist:

- computed actual identity evidence
- matched variant ID, when known
- enough metadata to render a registered source without rehashing a multi-gigabyte image every time the UI opens

Do not persist the expected catalog variants as durable truth; they remain catalog-owned and may evolve.

For existing source rows:

- preserve the current baseline SHA-256, size, storage SHA-256, and storage size
- backfill a minimal evidence object from those values
- derive an exact match from the stored SHA-256 where possible
- otherwise show a legacy/unclassified state until the next successful verification enriches the derived evidence
- never silently replace the registered integrity baseline during migration or ordinary verification

Update migration verification tests.

## 1.4 Expose inspection in the CLI contract

Add:

```text
portcove source inspect <profile-id> <path>
```

Human output should show a compact digest comparison. JSON output must contain the complete structured inspection.

Recommended semantics:

- readable exact match: command succeeds, verdict `exact_match`
- readable mismatch: inspection data is still emitted, but the command exits with the existing source-invalid exit category
- format-only/upstream-pending: succeeds with a visible warning state
- unsafe/unreadable source: normal structured error

Update:

- `CapabilityDocument`
- `schema export`
- CLI parser/integration tests
- `human.rs`
- `docs/CLI.md`

Bump the machine API schema once, from 4 to 5, for the complete feature set in this task.

## 1.5 Upgrade the desktop source UX

Update the shared TypeScript DTOs, `api.ts`, state hooks, `DetailPanel.tsx`, source-health settings, and tests.

In the port detail panel:

- Always show a **Supported ROMs** / **Supported source** section when the port has a source profile.
- Render each catalog variant with its friendly label and all known expected hashes.
- Render full hashes in a monospaced, wrapping/copyable control. A shortened summary is acceptable, but the full value must be one click or expansion away; the current twelve-character-only display is insufficient.
- After picker selection or path submission, call `inspect_source`.
- Do not hash on every keystroke. Inspect after a picker result, explicit “Check source” action, path blur, or a carefully debounced stable path with stale-request cancellation.
- Show accessible states using icon/text in addition to color:
  - `Matches <variant>`
  - `Does not match`
  - `Format accepted; no published checksum`
  - `Container accepted; final upstream validation pending`
  - `Required tool missing`
- Show an expected-versus-actual table grouped by algorithm.
- Show normalized content and original container identities separately when they differ.
- Disable registration/install/launch for an exact mismatch.
- Do not treat `sourcePath.length > 0` as source readiness.
- Preserve path pasting as well as native pickers.
- When a selected source matches, allow immediate registration with clear feedback.
- Update Source Health in Settings to show matched variant and comparison evidence, not just a generic pass/fail row.

For ports that share a source profile, use the same catalog and registered evidence rather than duplicating state.

---

# Workstream 2 — Portcove Source Inbox and managed import

## Goal

A user can place or import a ROM/source into a deterministic Portcove folder and subsequently install the matching port without selecting that source again.

## 2.1 Add a deterministic inbox layout

Add core path helpers and create the directory as part of the library layout:

```text
<library-root>/source-inbox/
<library-root>/source-inbox/<profile-id>/
```

The profile-specific directory is authoritative for automatic lookup. Validate that all constructed paths remain below `source-inbox`; never trust an arbitrary profile ID from a caller.

Expose the root and per-profile paths in a DTO.

The feature must work for every source shape already supported where practical:

- ordinary ROM/file
- ZIP-wrapped ROM
- file-set directory or ZIP
- single-disc CHD
- multi-disc directory
- GameCube image/container
- BIOS profile

Use the same profile-specific path for every port sharing that profile.

## 2.2 Add safe source import

Add an import preview and result in core, following the repository’s existing preview/authorization patterns.

CLI:

```text
portcove source inbox path [<profile-id>]
portcove source inbox scan [<profile-id>] [--register]
portcove source import <profile-id> <path> [--move] [--yes]
```

Behavior:

- Copy is the safe default.
- `--move` is explicit and destructive because it removes the original after successful import.
- Under `--non-interactive`, `--move` requires `--yes`.
- Inspect the source against the target profile before publishing it.
- Copy into a temporary path on the destination filesystem.
- Verify the staged copy’s storage and content identity.
- Atomically publish it into the profile inbox.
- Register the published path only after verification.
- Delete the original only after destination publication and registration succeed.
- If original deletion fails, retain the verified imported copy and return a precise “copied, original retained” result rather than destroying the safe copy.
- Reject symlinks and special files, and reuse the existing bounded/archive-safe copy rules.
- Preserve a safe original filename. On a conflicting filename:
  - reuse the destination if storage identity is identical
  - otherwise append a deterministic short digest before the extension
- A failed import must leave the original untouched and must not leave a partially published source.
- `source remove` continues to remove only the registration. Do not silently delete inbox bytes.

Add an `ImportSource` activity operation and progress events.

## 2.3 Automatically resolve inbox sources

Centralize install-time source resolution in core with this order:

1. explicit source/BIOS override supplied for the operation
2. existing registered source
3. unique valid candidate in `<library>/source-inbox/<profile-id>/`
4. missing-source error

Rules:

- Exact-identity profiles may be auto-registered only on an exact match.
- Zero matches means no automatic registration.
- More than one matching candidate is a typed conflict listing the candidates; never choose by filesystem order.
- A mismatching file is never auto-used.
- `FormatOnly` and `UpstreamValidator` candidates require one explicit user confirmation before first registration; after registration, normal source reuse applies.
- Installation, ensure, update, CLI, and desktop all use this same resolver.
- Do not add a fragile always-running file watcher. Scan on explicit request, when the relevant source is needed, and when the Source Inbox UI is opened.
- Prefilter candidates by source kind/extension/structure before expensive hashing.
- Avoid an O(profiles × files × full-hash) global scan. Profile-specific directories should make the normal path bounded. If a global scan is added, compute each candidate’s identity once and match through an indexed catalog identity map.

## 2.4 Desktop Source Inbox UX

Add a Source Inbox card/section in Settings and contextual actions in the port detail panel:

- `Open Source Inbox`
- `Open folder for this game`
- `Scan now`
- `Import to Portcove…` — copies by default
- secondary explicit `Move original to Portcove…`

When a unique matching source already exists in the profile inbox:

- show `Found in Source Inbox`
- show its inspection evidence
- allow core to register it automatically when the user installs
- do not open a picker

Show unmatched, ambiguous, tool-required, and pending-validation candidates with actionable messages. Never silently discard or relocate them.

Use the existing platform folder opener through the Tauri host boundary. File-system mutation remains in core.

---

# Workstream 3 — Library location and game-specific export/install folders

## Goal

Let users control **where each game's generated or installed application files go**, not only the overall Portcove library. Keep the global library chooser, but add an independent, remembered per-game destination available before installation and from the installed game's detail panel.

The user calls this the **export folder**. For this workstream, that means the destination for that game's Portcove-managed output. Do not satisfy the request with only a whole-library setting, a metadata export, or a folder-opening button.

Use three distinct concepts:

- **Portcove library:** the central database, settings, activity, locks, saves/configuration, backups, Source Inbox, downloads, and shared tools. It also provides the default managed-version location.
- **Game export/install folder:** an optional destination override for one `port_id`, including its managed active, staged, and retained application versions. It may be outside the library and on another drive.
- **Original source location:** the registered ROM/disc/BIOS path or Source Inbox. Changing the game's output folder must not move or rewrite original sources.

A custom game folder is not a second Portcove library and does not get a separate database. Key the preference by `port_id`, not ROM profile ID or display name: different native ports of the same source game may need different destinations.

If the current checkout has a genuine standalone portable-export operation, preserve its separate contract and let its game-specific destination use the same location authority where appropriate. Do not invent a detached portable-export subsystem or promise exported builds work independently of Portcove merely because their managed files live elsewhere.

## 3.1 Preserve pre-library host preferences and global controls

The overall library path cannot be stored inside the library needed to locate it. Keep a small, versioned host-preferences file in the OS configuration directory, separate from library SQLite and separate from secrets.

A suitable shape is:

```rust
pub struct HostPreferences {
    pub schema_version: u32,
    pub library_root: Option<PathBuf>,
    pub host_tool_paths: BTreeMap<String, PathBuf>,
}
```

Requirements:

- atomic write/replace with serialization against concurrent preference updates
- valid-Unicode path policy consistent with Portcove
- no credentials
- no silent fallback when an explicitly configured path is invalid
- a recoverable parse/version error with actionable details
- round-trip, malformed-config, atomic-replacement, and precedence tests

Overall library-root precedence remains:

1. explicit CLI `--library`
2. `PORTCOVE_LIBRARY`
3. persisted host preference
4. current OS default

Keep these commands, available before opening an invalid currently selected library:

```text
portcove --library <path> <command>
portcove library show
portcove library set <path>
portcove library reset
```

`library show` reports effective, persisted, environment, and default locations with their selection sources. `library set` previews the target without opening/initializing it, then persists the preference. Report a saved preference that is shadowed by an environment override.

Whole-library target preview must distinguish a creatable new path, empty usable directory, recognized compatible library, unrelated non-empty directory, and inaccessible/invalid path. Refuse unsupported schemas and unrelated non-empty directories. Probe without `Library::open` or any layout creation.

Changing the overall library means **switching libraries**, not moving one. Whole-library migration remains out of scope. Preserve desktop restart/recovery behavior and keep library chooser/reset available after failed bootstrap. Block switching while relevant operations or supervised launches are active; do not rely only on a React busy flag.

The new per-game controls below are required in addition to these global controls.

## 3.2 Persist a destination per game and centralize path resolution

Add a forward-only SQLite migration for an optional `output_directory` on each port's settings, or a typed per-port location table if the current schema makes that cleaner. Add a stable library ID if needed to bind ownership of external game directories.

- `None` means inherit the existing library-relative managed-version location.
- A custom value is a normalized absolute path for this game's output root.
- Existing ports migrate with no override; preserve every existing install path, artifact identity, active/previous/staged pointer, source reference, and user-data path.
- Do not store per-game destinations in React local storage or a host-wide map shared by unrelated libraries.
- Setting one game's folder must not change any other game's folder, the selected library, or the Source Inbox.

Create one core location resolver behind `PortcoveService`. CLI, Tauri, planning, installer, adapters, launch, rollback, removal, and repair must consume it or the exact recorded install paths, not reconstruct paths independently.

Destination precedence for a new installation is:

1. explicit per-game `--output-dir` for that plan/install request
2. persisted override for that `port_id` in the selected library
3. the existing default beneath the selected library, such as `versions/<port-id>/`

This is separate from library-selection precedence. `--library` selects central state; `--output-dir` selects one game's managed files. Do not introduce an environment variable that silently overrides every game's custom folder.

Store the exact concrete install root on each install record. Launch, verify, rollback, backup collection, and removal must use that record, even when the preferred destination later changes. The preferred output folder determines future publication; it must never retroactively reinterpret existing paths.

A suitable transport shape is:

```rust
pub struct PortOutputLocation {
    pub port_id: String,
    pub library_root: PathBuf,
    pub default_output_directory: PathBuf,
    pub configured_output_directory: Option<PathBuf>,
    pub effective_output_directory: PathBuf,
    pub selection_source: OutputLocationSource,
    pub user_data_root: PathBuf,
    // Also include the actual active/staged/previous paths and availability.
}

pub enum OutputLocationSource {
    RequestOverride,
    PortSetting,
    LibraryDefault,
}
```

Adapt names to the current types. Include the resolved destination and selection source in `InstallPlan`, `PortPaths`, and suitable status/read models.

## 3.3 Preserve version isolation outside the library

A game-specific destination must still support content-addressed versions and rollback. Do not install all releases over one mutable flat game directory.

Recommended layout:

```text
<library>/
  portcove.sqlite3
  user/<port-id>/
  backups/<port-id>/
  source-inbox/<profile-id>/
  ... shared resources ...

<game-output-root>/
  .portcove-game-output.json
  <artifact-sha256>/
  <another-retained-artifact-sha256>/
  .staging/<operation-id>/
  .recovery/<operation-id>/
```

For an inherited destination, preserve the existing `versions/<port-id>/<artifact-sha256>/` convention. The example hidden directories are destination-local operation infrastructure, not a second database or source registry.

The chosen folder is the root for **this game**, not a shared parent that silently acquires another game-name directory. Review UI/CLI must show both that root and the concrete version/executable destination so users know exactly where files will appear.

Keep canonical saves/configuration, backups, original sources, source registrations, credentials, and shared tools in their existing locations. Runtime copies or generated game data must follow the existing adapter and persistent-data rules; do not broadly classify user data as disposable output.

External destinations introduce real lifecycle requirements:

- Stage extracted/build output on the destination filesystem so publication does not depend on cross-volume rename.
- Use destination-local recovery/quarantine for removal or replacement when needed.
- Download cache may remain central, but space checks must cover each filesystem actually receiving data. Display output-drive capacity separately from library-drive capacity.
- Extend durable journals and recovery validation for recorded external roots; do not simply remove library-containment checks.
- Record destination ownership using library ID, port ID, and a versioned marker plus library metadata. A marker alone must not authorize deletion of arbitrary files.
- Claim a new destination atomically under the operation's locking protocol. Reject a root owned by another game or library, including concurrent claims and overlapping/nested game roots.
- Apply existing safe-path, symlink/junction, special-entry, archive, and executable policies at every mutation boundary.
- For an unavailable custom drive, report it as unavailable. Never install a surprise replacement into the default library.
- Removal must touch only recorded, verified Portcove-owned version/operation paths. It must never recursively delete the user-selected parent folder or unrelated neighboring files.
- `doctor` and recovery must inventory registered external roots as well as default roots without scanning arbitrary drives.

Use a focused location module if appropriate. Do not copy these rules into each command.

## 3.4 Preview and change a game's folder safely

Add a read-only core preview for a game's destination. It must include:

- port ID, current preference, proposed destination, and concrete publication paths when known
- actual active/staged/retained paths, which may differ from the preference
- whether the target is new/empty, already owned by this game/library, conflicting, or unavailable
- ownership, ancestor/descendant overlap, protected-library-area, path, schema, and known permission issues
- available space on the target or nearest existing parent volume
- whether the requested action changes future installs only or moves existing game files
- a state fingerprint including the current location setting and relevant install identities

Preview must not create directories, write ownership markers, migrate a database, or persist the location. Revalidate writability and all mutable assumptions when executing; a read-only preview cannot guarantee a later write will succeed.

Allow a new/empty dedicated game folder or a recognized same-library/same-port folder. Reject an unrelated non-empty folder; offer choosing a new subfolder instead. Existing-install adoption remains a separate explicit workflow. Reject dangerous roots such as a volume root, the library root itself, its protected `user`, `backups`, or source areas, and overlapping ownership of another game's output. The established inherited version path remains permitted under its existing ownership rules.

Support two explicit actions for an already installed game:

**Set folder for future installs/updates.** Persist the new preference after successful validation. Do not move existing versions or rewrite their paths. Explain that the current installation stays where it is until a future installation or an explicit move. Resetting to the inherited location has the same non-moving semantics.

**Move installed game files.** Provide a separate previewed, authorized relocation operation for the recorded active/staged/retained versions of this one game. Do not couple this to whole-library migration.

Relocation must:

1. Take the shared per-port lock and a destination reservation; reject unfinished launch sessions or conflicting operations across CLI and GUI.
2. Recheck the authorized inventory, source manifests, destination ownership, paths, and space.
3. Journal the intent, old paths, private destination staging paths, install IDs, and location setting before copying.
4. Copy into private staging on the target volume, preserve required executable permissions, and verify immutable content and required persistent/generated-state invariants.
5. Rebuild only explicitly path-bound generated descriptors or caches using existing core rules. Never patch game files with blind string replacement or weaken manifests to make verification pass.
6. Publish verified target versions, then transactionally update install paths and the saved preference while preserving artifact identities and active/previous/staged roles.
7. Remove only the old verified Portcove-owned version trees after the new installation is committed and usable. Never move/delete the registered original ROM, canonical user-data root, or backup root.
8. On interruption before commit, retain the old authoritative installation. On interruption after commit, recover the new authoritative paths and report/retry old-tree cleanup. Never claim cross-filesystem publication and SQLite commit are one atomic operation.

Keep the original installed copy until the destination is verified and committed. A cleanup failure becomes a truthful `cleanup_pending` result, not data loss or a silent switch back. Persist any copy inventory, generated-path changes, and verification evidence needed to reconcile a partially completed multi-version relocation.

Fingerprint authorization must be action-, game-, source-state-, and destination-bound. Tauri obtains destructive consent in the native backend; CLI follows existing confirmation/`--yes` conventions.

## 3.5 CLI controls for per-game destinations

Add a clear install-time option and saved-location commands, for example:

```text
portcove plan <port-id> --output-dir <directory>
portcove install <port-id> --output-dir <directory>
portcove ensure <port-id> --output-dir <directory>

portcove location show <port-id>
portcove location preview <port-id> <directory>
portcove location set <port-id> <directory>
portcove location reset <port-id>
portcove location move <port-id> <directory> [--yes]
```

The spelling may follow current CLI conventions, but the behavior is mandatory. Describe `--output-dir` as the **game-specific export/install folder**, not another library selector. A `--export-dir` alias may be added if it has exactly the same semantics; do not create competing settings.

Rules:

- `plan --output-dir` previews the proposed folder without creating it or saving a preference.
- An explicit folder used by a successful initial install is remembered for that game. Persist it with the successful install commit, not before a failed download/validation.
- `location set` deliberately saves the future-install preference without moving existing versions. It may be used before installation.
- `location reset` restores inheritance for future publication; it does not move files or erase install records.
- `location move` moves this game's recorded versions and saves the new preference only after a successful verified relocation. Require `--yes` under `--non-interactive` and existing backend authorization rules.
- A requested destination must never be silently ignored by `install`/`ensure` because an active or retained artifact exists elsewhere. Return a destination-conflict/action-required result with the exact current path and move command, unless the user has separately approved relocation. Do not relocate implicitly.
- Omitted `--output-dir` uses the saved game setting for new installs/updates. Existing `ensure` idempotence may return an active installation at its recorded path, but must show that actual path separately from a future preferred destination.
- `update`, `reconcile`, and optional version-pinning operations publish new versions using the saved per-game location, while reuse/rollback retains the exact recorded paths.
- Never apply one per-game directory argument to every member of an `--all` operation. Reject that combination; batch operations resolve each game's setting independently.
- JSON reports preference, effective new-install destination, actual installed paths, selection source, and any pending relocation/cleanup. Human output must be equally unambiguous.

Illustrative proposed commands, not claims that these commands already exist:

```text
portcove install ship-of-harkinian --output-dir "D:\Games\Ship of Harkinian"
portcove location set banjo-recompiled "E:\Native Ports\Banjo"
portcove location show ship-of-harkinian
portcove location move ship-of-harkinian "E:\Native Ports\Ship of Harkinian" --yes
```

Verify catalog IDs before turning examples into executable repository tests.

## 3.6 Desktop controls at both global and game scope

Replace the unclear global **Managed files** title with **Storage locations**, containing a **Portcove library** row and the existing global capacity/selection controls.

Global explanatory copy:

> The library stores Portcove's records, saves, backups, sources, and shared tools. Games use the library's default location unless you choose a separate folder for a game.

Keep `Open library folder`, `Change library…`, and `Reset library location`. Clearly state that changing the library switches collections and does not move the old library. Apply a whole-library change through the host restart/recovery flow.

In **each game's detail/install view**, add an **Export / install folder** control, visible before the install review:

- `Use library default` versus `Choose a folder for this game`
- full effective output path and inherited/custom label
- actual current install path when it differs from the preferred folder
- `Browse…`, `Open game folder`, and `Reset to library default`
- target-drive free space and actionable unavailable/conflict messages
- `Move installed game files…` for an already installed game
- a separate labeled saves/configuration location so users do not confuse it with game output

Changing a per-game folder must not switch the whole library, restart the application, or affect another game. Save through core and refresh the relevant game/plan. When installed files exist, explicitly distinguish saving a future-install preference from relocating current files; show exact old/new paths and what remains unchanged.

The install review must show the final destination next to version and download information. Invalidate and generation-gate asynchronous plans/previews on changes to port, source, release selector, library identity, destination, or location-setting revision. Revalidate at commit so an old plan cannot install into a stale folder.

Preserve keyboard/gamepad focus, native directory dialogs, copyable paths, and text-based status. No placeholder destination button or GUI-only preference.

## 3.7 Required integration touchpoints

Inspect every current assumption that managed files live directly beneath `library.versions_dir()`. Update the relevant core path policy rather than disabling containment checks.

Cover at least:

- planning and target-volume space preflight
- installer, adoption, retained-artifact reuse, and content-addressed version lookup
- launch and supervised-session recovery
- update, reconcile, staged activation, rollback, and optional exact-version pinning
- persistent-data restore/collection and generated path-dependent descriptors
- verification, removal, backup workflows that read an installed version, and doctor/repair
- journals, ownership markers, locking, and relocation crash recovery
- `PortPaths`, status, CLI command-copy helpers, Tauri DTOs, React types/API, capability discovery, and schema fixtures

Default installs must keep working without an override. Mixed default/custom destinations within the same library are a supported, tested state. This workstream is incomplete if the UI can save a folder but any lifecycle operation still assumes all game output is inside the library.

---

# Workstream 4 — Source-tool setup links and persistent manual paths

## Goal

Make `chdman`, `DolphinTool`, and future source tools understandable and configurable without environment-variable knowledge.

## 4.1 Create a core host-tool registry

Replace UI-specific assumptions with core-owned tool definitions, for example:

```rust
pub struct HostToolDefinition {
    pub id: String,
    pub display_name: String,
    pub purpose: String,
    pub configuration_variable: String,
    pub official_url: String,
    pub executable_names: BTreeMap<Platform, Vec<String>>,
}
```

Keep definitions for at least:

- `chdman` — distributed by MAME
- `dolphin_tool` — distributed by Dolphin

Extend status data as needed with:

- display name
- official URL
- configured path
- resolved path
- source
- actionable setup message
- probe/misconfiguration detail

Resolution precedence:

1. existing environment override
2. persisted manual path in host preferences
3. current automatic discovery candidates
4. missing

An invalid explicit environment or persisted path must remain `misconfigured`; do not silently fall through to an unrelated executable.

Refactor tool resolution so source inspection/materialization and `doctor` consume the same registry/context rather than reading process globals independently in several functions.

## 4.2 Validate manual selections

A manually selected path must:

- exist as a regular file
- satisfy the platform’s executable expectations
- be safe to pass through `ChildProcessPolicy`
- optionally pass a short, fixed, timeout-bounded help/version probe appropriate to that tool

A failed probe is `misconfigured` with details. Never execute arbitrary caller-provided arguments.

Tool paths are machine-level preferences and should remain outside a movable library.

## 4.3 CLI controls

Add:

```text
portcove tool list
portcove tool set-path <tool-id> <executable-path>
portcove tool clear-path <tool-id>
```

Keep `doctor` read-only, but have it reflect the new configured source.

Human output should include the official setup URL and current resolution source. JSON output exposes the full typed status without exposing unrelated environment data.

## 4.4 Desktop controls

Upgrade the current **Source tools** rows:

- clear display name and purpose
- `Ready`, `Missing`, or `Check path`
- resolved path and source
- `Download` / `Official site` button
- `Locate executable…` button
- `Clear custom path` when configured
- `Recheck` action

The official-site action opens only the URL from the core tool definition. The locate action uses a native file picker and persists through the shared host-preferences API.

A valid tool selection should refresh Doctor/Source Tools immediately without restarting the app.

## 4.5 Explicit non-goal for this launch

Do not implement automatic binary installation in this workstream.

A future managed installer is acceptable only if each platform/tool has reviewed package metadata with:

- trusted official origin
- exact version
- exact SHA-256
- archive type
- executable allowlist
- archive traversal protections
- atomic install under a Portcove-owned toolchain directory
- explicit user initiation

Do not create a generic URL field or shell-command installer.

---

# Workstream 5 — Optional exact release selection and pinning

Start this only after workstreams 1–4 pass `just check`.

Do not expose partial version selection. If implemented, complete all provider, persistence, update-policy, CLI, desktop, and test behavior below.

## 5.1 Generalize release providers

The current provider contract resolves only the newest eligible release in a channel. Add provider-wide concepts such as:

```rust
pub enum ReleaseSelector {
    Latest { channel: ReleaseChannel },
    Exact { version: String },
}

pub struct ReleaseCandidate {
    pub version: String,
    pub channel: ReleaseChannel,
    pub published_at: Option<String>,
    pub latest_for_channel: bool,
}
```

Extend the provider trait with:

- list eligible release candidates
- resolve a latest or exact selector to the existing checksum-qualified `ResolvedRelease`

Requirements:

- GitHub exact tags use the provider’s exact-tag endpoint and URL-safe construction.
- GitLab exact tags use its exact release endpoint with correct percent encoding.
- Direct-manifest ports list and resolve only their one pinned catalog release.
- Draft, upcoming, archived, platform-incompatible, or checksum-less releases remain ineligible.
- Exact selection still uses reviewed asset selection and mandatory SHA-256 qualification.
- Never accept a user-supplied asset URL.
- Cache keys include the selector/version, not only channel and platform.
- Listing may be paginated or bounded, but the CLI must be able to resolve an explicitly supplied older tag even when it is not in the first list page.

## 5.2 Persist release selection

Add a forward-only database migration and a typed status field representing:

- follow latest in channel
- pinned exact version

Existing users default to follow latest in their current channel.

Semantics:

- `set channel` clears an exact pin and follows latest in the selected channel.
- selecting an exact version validates it through the provider before saving the pin
- install/plan/update/check/reconcile all honor the stored selector
- a pinned port is not silently upgraded by automatic reconciliation
- the UI can still report that newer releases exist, but it must distinguish that informational state from an actionable update under the pin
- unpin/follow-latest resumes normal channel tracking
- rollback remains the existing retained-artifact operation and is not conflated with version pinning
- `ensure --version` must not return an unrelated already-active release

## 5.3 CLI controls

Add:

```text
portcove releases list <port-id> [--channel <channel>]
portcove install <port-id> --version <tag>
portcove plan <port-id> --version <tag>
portcove version pin <port-id> <tag>
portcove version follow <port-id> [--channel <channel>]
```

`--channel` and `--version` are mutually exclusive where both are accepted.

Installing with `--version` should pin that version unless an explicit, well-documented alternative is implemented. Do not make a historical install immediately eligible for replacement without warning.

Update schema, capabilities, human rendering, CLI docs, parser tests, and compiled-binary integration tests.

## 5.4 Desktop controls

In Advanced controls:

- keep the channel control
- add a version control whose first option is `Latest <channel>`
- load release candidates only when needed
- show tag and publication date
- clearly label an exact choice as `Pinned`
- show `Follow latest` action
- include the selector in install-plan review

Do not obscure or remove existing stable/beta/rolling behavior.

---

# Cross-cutting API, persistence, and documentation work

## Machine contracts

Update all Rust/TypeScript transport declarations together:

- Rust DTOs and schema export
- `apps/desktop/src/types.ts`
- `apps/desktop/src/api.ts`
- Tauri command inputs/outputs
- `scripts/check-transport-contract.*`
- `CapabilityDocument`
- CLI envelope schema version 5
- generated/fixture schema expectations

Use additive fields where practical, but treat command/result shape changes as versioned public behavior. Include per-game location settings/previews, relocation results, destination-aware install plans, and actual install paths. Add forward-only migrations after the current database version; reserve exact catalog/API version numbers only after confirming the current checkout.

## Activity and operation reporting

Add typed activity operations where durable mutation occurs, including source import, game-output-location changes, game-output relocation, and any release-pin changes that warrant ledger visibility. External-destination journals must retain verified ownership, exact old/new paths, and cleanup state; the central library remains the domain authority.

Inspection and scan are read-only but may emit best-effort progress events. Durable activity history remains authoritative for mutations.

## Logging and diagnostics

- Never log ROM contents.
- Avoid putting full local source paths or digest inventories into broad informational logs.
- Keep support bundles free of source payloads.
- It is acceptable for explicit source-inspection command/UI results to show paths and hashes to the local user.
- Preserve control-character sanitization in human CLI output.

## Documentation

Update at least:

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/CLI.md`
- relevant design/metadata documentation
- user-facing help text

Document:

- supported-ROM comparison states
- normalized content versus container hashes
- Source Inbox layout and copy/move semantics
- source lookup precedence
- overall library selection precedence and switching behavior
- per-game export/install destination precedence, persistence, concrete version layout, and target-drive capacity
- the difference between changing a future-install preference and explicitly moving installed game files
- external-root ownership, unavailable-drive handling, relocation recovery, and preservation of sources/saves/backups
- manual tool configuration and trust boundary
- exact-version pin behavior if workstream 5 ships
- all schema/database version changes

Do not document a feature until its implementation and tests exist.

---

# Required test matrix

## Core/catalog/source tests

Add tests covering:

- catalog schema 2 parses and old parallel hash authority is gone
- duplicate variant IDs and duplicate/ambiguous identities fail
- malformed SHA-1, SHA-256, CRC32, and URLs fail
- exact simple-file match
- exact mismatch returns actual and expected evidence
- variant with both SHA-1 and SHA-256 requires both
- multiple supported variants choose the correct one
- format-only state is not called a match
- upstream-validator state is clearly pending
- ZIP inner-content hash versus outer-container hash
- file-set per-member evidence and aggregate identity
- PS1 single- and multi-disc evidence
- GameCube normalized-versus-storage evidence
- missing tool produces `ToolRequired`/typed setup evidence
- registration consumes inspection and rejects a mismatch
- existing source baseline is preserved through verification
- source evidence database migration and backfill

## Source Inbox/import tests

Add tests covering:

- deterministic profile inbox path cannot escape its root
- valid unique inbox source is discovered and registered
- mismatch is not auto-registered
- two valid candidates produce a deterministic conflict
- copy import succeeds and leaves original
- move import deletes original only after verified publication
- simulated copy/verification/publication failure leaves original intact
- original deletion failure retains the imported copy and reports the condition
- identical destination deduplicates
- different same-name destination gets deterministic suffix
- file-set directory copy rejects symlinks/special files
- explicit override and registered source precedence remain correct
- source removal does not delete inbox bytes

## Per-game export/install location tests

Add tests covering:

- old libraries migrate without moving files or changing install IDs, artifact identities, source references, saves, or active/previous/staged pointers
- no override preserves the existing library-relative layout
- two games use different custom destinations while sharing one central library
- different ports sharing a ROM profile may still use different output folders
- explicit plan/install destination, saved per-game setting, and library default resolve in the documented order
- planned overrides do not create folders or persist preferences
- initial install saves its explicit destination only on successful commit
- changing/resetting a future destination leaves existing recorded paths unchanged
- `ensure` never silently ignores an explicit conflicting destination or moves a game implicitly
- updates and batch reconciliation honor each game's own destination
- launch, verify, staged activation, rollback, source reuse, and removal work for custom and mixed-root retained versions
- output-drive space preflight is distinct from central-library capacity
- destination-local staging/publication works across volumes without cross-volume rename assumptions
- unavailable custom drives fail explicitly without falling back to the library
- another library/game's owned root, unrelated non-empty target, overlapping roots, unsafe ancestors, symlinks/junctions, and protected library areas are rejected
- competing processes cannot claim the same destination or relocate while a game/operation is active
- relocation preserves all recorded versions, executable permissions, artifact identities, and version roles
- path-bound generated descriptors/caches are safely regenerated or invalidated after relocation
- failure before relocation commit retains the old authoritative installation
- failure after commit retains the new authoritative installation and exposes cleanup-pending old copies
- interrupted multi-version relocation recovers deterministically from its journal
- source ROMs, canonical saves/configuration, backups, other games, and unrelated neighboring files are untouched
- removal never recursively deletes the user-selected output root or unrelated files
- doctor/repair inventories registered external roots without scanning arbitrary drives
- location changes invalidate stale install plans and require commit-time state revalidation

## Library/preferences/tool tests

Add tests covering:

- host-preferences atomic round trip
- malformed/newer config fails recoverably
- library precedence: CLI > environment > persisted > default
- empty target accepted
- valid existing library accepted
- unrelated non-empty directory rejected without mutation
- invalid saved library can be reset from bootstrap UI
- persisted tool path beats discovery
- environment tool path beats persisted path
- invalid explicit path does not fall through
- clearing a path restores discovery
- tool status and actual resolver agree

## Release tests if workstream 5 ships

Add tests covering:

- GitHub and GitLab latest behavior remains unchanged
- exact stable, prerelease, and rolling classification
- exact tag URL encoding
- exact selection still requires a checksum-qualified asset
- direct manifest exposes one release
- selector-aware cache keys
- existing settings migrate to follow latest
- pin survives restart
- check/update/reconcile honor pin
- follow latest resumes updates
- `ensure --version` does not return a different active artifact

## CLI integration tests

Cover human, JSON, JSONL where applicable:

- `source inspect`
- source mismatch output and exit code
- source inbox path/scan/import
- destructive move confirmation rules
- `library show/set/reset`
- existing `--library` precedence independently from per-game `--output-dir` precedence
- `plan/install/ensure --output-dir` destination reporting and persistence semantics
- `location show/preview/set/reset/move`, including non-interactive move authorization
- explicit destination conflicts and invalid `--all`/single-destination combinations
- `tool list/set-path/clear-path`
- new capabilities and schema
- version commands if shipped
- parser conflicts and stable command names

## Desktop/UI tests

Use existing React test conventions. Cover:

- supported variants rendered before selection
- full expected and actual hashes available
- exact match, mismatch, format-only, upstream-pending, and tool-required copy
- install disabled for mismatch
- stale async inspection result cannot overwrite a newer path
- registered/inbox source avoids another picker
- Source Inbox controls
- Storage Locations card rename and whole-library switch confirmation
- per-game Export / Install Folder control before install review
- inherited/custom paths, destination capacity, unavailable drives, and reset behavior
- setting one game's folder does not alter another game or restart/switch the library
- future-install preference versus explicit relocation confirmation and progress
- stale destination previews/plans cannot overwrite a newer selection
- invalid bootstrap library recovery
- tool locate/clear/link controls
- version pin/follow-latest controls if shipped
- accessibility labels and status text, not color alone

## Quality gates

Run during implementation:

```text
just check-rust
just check-ui
just check
```

Before finalizing:

```text
just audit
```

Run `just deep` if it is operational in the environment; report diagnostic-only failures separately rather than weakening required checks.

Also review:

```text
git diff --check
git status --short
```

Do not suppress Clippy, transport-contract, Fallow, architecture, process-policy, or migration failures merely to get green output.

---

# Recommended implementation sequence

Use focused commits or equivalent reviewable change groups.

1. **Source catalog/domain model**
   - source variants and verification policy
   - catalog schema 2 migration
   - validation tests

2. **Structured source inspection**
   - one core authority
   - evidence persistence migration
   - registration/verification integration
   - CLI inspection and transport schema 5

3. **Desktop ROM comparison**
   - TypeScript DTOs/API/hooks
   - detail panel and source health
   - readiness correction
   - UI tests

4. **Source Inbox**
   - layout, preview/import, automatic resolution
   - CLI and desktop controls
   - lifecycle/activity and failure tests

5. **Global and per-game storage locations**
   - shared pre-library preferences and global library probe/selection
   - per-port destination migration, resolver, ownership, and target-volume preflight
   - external-root lifecycle support and explicit recoverable game relocation
   - CLI library/location commands and install-time `--output-dir`
   - global storage card plus per-game folder controls and destination-aware review
   - bootstrap recovery, mixed-root lifecycle, and fault-injection tests

6. **Source-tool configuration**
   - shared host preferences from the storage work
   - tool registry, manual path commands, and GUI actions
   - resolution, persistence, and trust-boundary tests

7. **Optional exact-version pinning**
   - provider list/exact selection
   - persistence and update semantics
   - CLI/desktop
   - full tests

8. **Final contract/docs/review**
   - schema/capability fixtures
   - architecture and CLI docs
   - complete quality gates
   - inspect final diff for duplicated authorities or accidental scope

Do not mix a large visual redesign into this work. Reuse current Portcove components, visual language, spacing, typography, and accessibility patterns.

---

# Definition of done

Workstreams 1–4 are complete only when all of the following are true:

1. A port detail view lists its supported ROM/source variants when known.
2. Selecting a wrong ROM shows a clear mismatch with full actual and expected digests and cannot be registered or installed.
3. Selecting a correct ROM shows the exact matched variant and differentiates content and container hashes.
4. Profiles without published hashes are labeled honestly rather than falsely “verified.”
5. A valid source placed in the Portcove profile inbox can be used without another picker.
6. Copy/move import is transactional, and an original is never removed before verified destination publication.
7. The CLI keeps its one-run `--library` override and can persist/show/reset the default library.
8. Every game can independently inherit the default or save a custom export/install folder in both CLI and GUI, including a different drive.
9. `plan/install/ensure --output-dir` and per-game location controls show the real destination; plans remain non-mutating and explicit conflicting paths are never silently ignored.
10. The GUI's former `Managed files` card becomes clear Storage Locations controls, while each game's detail/install view exposes its own Export / Install Folder.
11. Changing one game's folder never changes the whole library, another game, its original ROM/source path, or the canonical saves/backups location.
12. Existing versions keep their recorded paths when a future preference changes; an explicit authorized move relocates only that game's managed files with verification, recovery, and no premature old-copy deletion.
13. Install/update/reconcile, launch, verification, activation, rollback, removal, and doctor/repair work with default, external, and mixed-root versions and fail clearly for unavailable destinations.
14. Destination ownership, target-volume staging/space checks, cross-process locking, and cleanup boundaries protect unrelated folders and files.
15. An invalid saved library can be recovered from the desktop bootstrap state.
16. Source tools expose official links and persistent manual executable selection in CLI and GUI.
17. Tool resolution has one core authority and preserves environment override behavior.
18. Machine schemas, capabilities, docs, migrations, and TypeScript declarations agree.
19. `just check` and `just audit` pass, apart from clearly documented pre-existing or environment-only failures.

Workstream 5 is complete only if exact versions are provider-resolved, checksum-qualified, persisted as pins, honored by update policy, exposed consistently in CLI/GUI, and fully tested. Otherwise leave it unexposed and report it as the one optional deferred item.

## Final report to return

At completion, provide:

- concise implementation summary
- product/architecture decisions made
- database, catalog, and machine-schema migrations
- new CLI commands with examples
- new GUI behavior, including the per-game export/install destination and move flow
- evidence for two games using different output drives/folders within one library, plus default/custom/mixed-root update and rollback tests
- important safety behavior
- tests and exact quality-gate results
- any remaining optional work
- final `git status --short`

