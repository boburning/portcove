# Maintenance inventory store

This guide explains how the maintenance application identifies its sources,
records coverage, and stores data. Use
[#4129](https://github.com/boburning/portcove/issues/4129) for the implementation
requirements and checkpoint results.

Maintainers use this application. Players can install, update, back up, and
launch games without it. Use the separate approval paths for admission,
support, qualification, publication, and credentials.

## Ownership boundary

The store keeps operational history only: collection runs, immutable
observations, policy-bound assessments, ordered transitions, reconsideration
conditions, changes-only notification state and references to original executor
receipts. It references every authoritative input by immutable identity and
never becomes a second copy of it.

| Fact                                                   | Authority (unchanged)                                                          | The store keeps                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Live planning fields, Project membership               | [GitHub Project](PROJECT-GOVERNANCE.md)                                        | Dated observations with collection coverage          |
| Specifications, acceptance, completion evidence        | GitHub issues                                                                  | Issue numbers and observed state                     |
| Listings, integrations, lineage, scoped qualification  | [Per-ID catalog records](CATALOG.md) and generated `catalog.json`              | Observations bound to a source revision              |
| Capability, ownership, compatibility, operation policy | Rust Core through maintained CLI exports                                       | Assessments bound to policy version and input digest |
| Upstream and release-health facts                      | [Upstream observers](UPSTREAM-OBSERVATIONS.md) and their checkpoints           | Observations and their reported coverage             |
| Discovery/intake mutations                             | [Discovery executors](DAILY-PORT-DISCOVERY.md) and their receipts              | Operation state and receipt references               |
| Definition publication                                 | [Definition delivery](DEFINITION-DELIVERY.md) and [signing](SIGNED-CATALOG.md) | Published identities when attributable; else unknown |

Reporting code never infers capability, compatibility or eligibility from issue
closure, titles or tags. Those rules stay in Core.

### Discovery executor checkpoints

The hosted intake executor uses migration `0005` with its own PostgreSQL login
in `portcove_maintenance_executor`, provided to the main-branch workflow as
`PORTCOVE_DISCOVERY_DATABASE_URL`. The existing maintenance migration job applies
the schema. Configure the login after that migration. The executor checks the
active store and advances each batch by exact request hash, previous receipt and
revision. GitHub comments remain the portable public receipts.

The deployment activation row is local to the database being used for writes.
Portable restore verifies the backup, applies pending migrations and clears
discovery activation. Before reactivating a replacement or restored store,
reconcile the retained candidate and receipt bindings against GitHub, including
unconfirmed writes. The schema owner can then set the singleton
`portcove_maintenance_meta.discovery_intake_activation.active` to true. An
executor login has read-only access to that flag.

### Discovery collection

Migration `0007` stores [unattended discovery collection](DAILY-PORT-DISCOVERY.md#unattended-collection).
It adds the concepts the history tables cannot represent:

- `discovery_collection_state`: one fenced collector state per scope (`primary`),
  with its revision, the digest of the source and query definitions that wrote
  it, and the current lease.
- `discovery_collection_attempts`: each run's acquisition ticket (from
  `acquire_collection()`), activation generation, Portcove revision, runner,
  committed pages, outcome and bounded result. A run whose lease is taken over
  closes as `expired`; its committed pages remain.
- `discovery_observations` (append-only): positive provider evidence keyed by
  provider, provider-issued repository ID, parser version and normalized content
  digest. An observation exists before any canonical identity. The path at the
  time is retained, and a reused path never inherits another repository's ID.
- `discovery_watches` and `discovery_watch_transitions` (append-only): the
  current typed waiting condition per provider subject and one row per episode.
  Changed evidence or status opens a new generation, so A to B to A remains three
  episodes; unchanged evidence is quiet.
- `discovery_lead_records` (migration `0009`): the collector's lead records,
  one row per provider repository ID in a scope. The state document keeps the
  rest of the continuation. A commit upserts only records that changed and
  rewrites no unchanged row.

Writes go only through `discovery_acquire`, `discovery_commit` and
`discovery_finish`. They check collection activation, the lease token and the
lease generation; commits also check expiry and the expected revision. They then commit state, observations
and watch changes in one transaction. The collector role may execute them; the
report role reads.

Stored state has no fixed size bound; migration `0008` removed the original
8 MiB check. The worker sizes its transfer admission from the stored state and
recent runs, so reads and commits stay inside an admitted, measured allowance.
`definition_sha256` records the collector definitions (state format,
parser version, search families and curated lists). A worker whose definitions
differ resends its observations; cursor compatibility itself comes from each
search slice's recorded query contract. Discovery tables are ordinary backup
tables: each recovery export copies them in full, so their growth adds to the
daily recovery transfer until they join the history-prefix reuse.

Collection has its own activation (`collection_active`) and
`collection_generation` on the activation singleton. Portable restore clears
both activation flags and advances the generation, so a lease taken before the
backup cannot commit after reactivation. Reactivate collection only after
deciding that the restored store is the single active writer; the worker resumes
from the restored revision.

## Canonical identities

`subject_key` is `<kind>:<identity>` using an existing canonical identity:

- `port:<listing.id>`: the stable port ID, with its canonical port issue
  (`listing.issue_number`).
- `implementation:<uniqueness key>`: the lineage key derived by
  `scripts/upstream-lineage.mts` (`url:` or `repository:` plus `target_key`), so
  distinct implementations of one game stay distinct while sharing `target_key`.
- `issue:<number>` for canonical work without a port record.
- `intake:<request_comment_id>`: one owner-authored hosted-intake request on
  #177, by the immutable ID of its request comment. A withdrawn request keeps its
  identity. Its candidates link to canonical work through `issue:<number>`; a
  candidate `port_key` is not a catalog ID and is never keyed as `port:`.
- `handoff:<kind>:<source subject>`: one [executor handoff](#executor-handoffs)
  of a registered attention kind for one source subject, for example
  `handoff:hosted-intake-blocked:intake:123` or
  `handoff:release-health-relocation:port:<id>`.

The derived universe also exposes each catalog port's descriptive
`original_game_id`, `grouping_disposition` and specific `grouping_reason` beside
its retained `target_key`. These fields do not replace subject identity or
lineage grouping. An engine/framework or unresolved review can intentionally
remain without a single-game ID; missing review, partial target mappings and
multiple game IDs within one lineage scope remain visible for inspection.
Count `kind: port` entries when reporting catalog coverage, independently of
implementation entries. The inventory search and HTML display both identities
and the grouping review context. Authoring remains authoritative.

An observation's `scope` binds the applicable artifact, source, platform, route,
operation and check/policy version. Evidence applies only where its whole scope
matches; a new artifact or platform never inherits unrelated qualification.
Main availability is a repository revision. Published delivery is a definition
identity `(namespace, stable_id, revision, content_sha256)` or published site
generation; tags, titles and issue state never stand in for it.

## Declared sources and coverage

Each collection run belongs to one declared source and records its exact source
revision, expected denominator and gaps. The database derives the observed
count from the run's retained observations when the run finishes; `complete`
requires a known denominator equal to that count with no gaps. `partial`,
`failed` and stale runs are unknown coverage, never absence or deletion, and the last complete observation remains visibly dated.

| Source                              | Maintained owner interface                                                                           | Completeness signal                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Open/closed issues                  | `scripts/repository-issue-inventory.mts` through `node scripts/roadmap.mts doctor --json`            | Total count, terminated pagination, before/after markers      |
| Project items (active and archived) | `scripts/roadmap-inventory.mts` (`items`, `archivedItems`)                                           | Project revision and item totals stable across the read       |
| Catalog, listings, lineage          | Per-ID records; `node scripts/generate-catalog.mts --check`; `portcove --json catalog export`        | Generated projections match the authored tree at one revision |
| Offered capability per port         | `portcove --json port-capabilities PORT_ID`; `portcove --json capabilities`                          | Per port only; no catalog-wide matrix exists                  |
| Scoped qualification                | `catalog.json` `source_catalog.qualification[]` and `evidence[]`                                     | Exact scope per record; no catalog-wide denominator           |
| Upstream observations               | `configured-upstream-observer.yml` checkpoint recovery snapshot (`observer-checkpoint-artifact.mts`) | Per port: every serving source completed with its policy      |
| Release health                      | `scripts/upstream-health-monitor.mts` report and `work/upstream-health/checkpoint.json`              | Fresh complete, partial, stale and unmonitored port IDs       |
| Release content                     | `scripts/release-content-scan.mts` report from `release-content-scan.yml`                            | Every target scanned, reused or not scanned with a typed code |
| Hosted intake receipts              | `node scripts/hosted-discovery-intake.mts status --all --json` over the receipt comments on #177     | Every marker-bearing owner request in one drift-checked read  |
| Definition publication              | `portcove --json catalog inspect-definition-publication DIR`                                         | Index digest and per-target digests on `main`                 |
| Definition delivery                 | `portcove --json catalog inspect-definition-delivery`                                                | Serving status; verified published identities and targets     |

Known gaps stay explicit until an owner exports the fact: there is no persisted
export of full issue rows or Project field values, no catalog-wide capability or
route matrix, no shared schema for `docs/qualification/` files, no durable
upstream-health history beyond cached checkpoints and short-lived artifacts, no
maintained main-versus-published comparison, and route ownership is prose rather than a per-port field. Reports
publish these as unsupported or unknown sources with their exact gaps.

## Storage contract

Standard PostgreSQL 16 or newer, reviewed SQL migrations in
`scripts/maintenance-store/migrations/` and the ordinary `psql`, `pg_dump` and
`pg_restore` clients. No extension or provider API is required. Every command
in this section runs unchanged against any PostgreSQL host and generic runner.

- **Migrations.** Files are `NNNN_name.sql`, contiguous from `0001`. Each one
  runs in its own transaction under an advisory lock together with its ledger
  row in `portcove_maintenance_meta.schema_migrations` (version, name, SHA-256 of
  LF-normalized text). An interrupted migration leaves neither partial schema nor
  ledger row. A changed applied migration, a ledger gap or a version unknown to
  the checkout refuses migration and reports the drift. Applied migrations are
  never edited; corrections are new migrations.
- **History guards.** Observations, assessments and transitions are append-only,
  including against `TRUNCATE`. Observations join only an in-progress run, and a
  finished run is immutable. Identical subject, policy version and input digest
  resolve to one assessment, so full and incremental passes converge.
- **Acquisition order.** Migration 0003 orders collection runs by a
  database-issued acquisition ticket, never by runner clocks or Git SHA order.
  A collector takes its ticket (`acquire_collection()`) before any external
  read. A run is admitted only if its ticket was issued and no run of the same
  source has an equal or newer ticket. An older collection that finishes after
  a newer one is therefore refused whole. It replaces no current state, clears
  no attention and creates no false A to B to A history. Under its source
  locks, the collection also checks that each source's latest finished run is
  still the baseline its changes-only diff was computed against
  (`expect_baseline`). If not, the collector rereads the baseline and retries
  without repeating its external reads. Network reads stay outside every
  database transaction. A restored store keeps issuing newer tickets.
- **Transitions.** A writer names the sequence it creates. The guard accepts only
  the next sequence, so a stale or restored worker cannot overwrite newer state.
  An unchanged result is not a transition. A return to an earlier result is a new
  transition marked `returns_to_earlier_result`.
- **Current provenance.** Current state keeps three facts apart:
  - the last material transition (`assessment_id`, `sequence`, `updated_at`);
  - the latest applicable assessment (`applicable_assessment_id`, with its
    policy and input digest);
  - the latest accepted verification (`verified_run_id`, `verified_at`).

  An assessment with the current result but new policy or inputs moves the
  latter two through `verify_current`, quietly, without a transition or
  notification. Assessment rows and their original timestamps stay immutable.
  A verifying run must exist and must not have failed, and a run that has
  verified state cannot later finish `failed`. A verification or
  transition that names its verifying run (as every collector write does) never
  moves to an older acquisition. A legacy writer that names none binds the
  assessment's own run and is not freshness-checked; the same applies to a run
  inserted without a ticket, which is admitted at insert time. The collection
  transaction runs at `READ COMMITTED`, so its checks see every run committed
  while it waited for its locks.

- **Reassessment.** A full collection re-reads Core for every authored port,
  and a selective one for every port the store selects; with unchanged inputs
  a read only re-verifies (`verified_run_id`, `verified_at`). A new assessment is recorded only when the subject's catalog
  fact changes (authored record, operational definition or scoped
  qualification at the pinned revision), Core's output for the port changes
  (embedded catalog and listings, Core code, the port's holds and listing
  restrictions, the platform, or recommendation observations Core filters by the current time),
  or the assessment policy changes (API schema or projection version). Only a
  changed result records a transition. A rebuild with the same output, a failed
  run, or a port Core could not read in a partial run records neither. The
  report shows each subject's `reassessment`: what it depends on, when its
  catalog fact and Core output last changed (their latest changes-only
  observations from `--all` runs), since when its inputs are unchanged (the
  latest of those and the assessment time, because assessments are deduplicated
  by input and a return to earlier inputs reuses the older assessment) and when
  it was last re-verified.
  - **Selective reassessment (migrations 0004 and 0010).** `collect --all
    --targets --reassess changed` reuses a subject's stored Core result
    without calling Core. The daily workflow uses it. Every run-level
    condition must hold, otherwise the run is full and `collect` reports why:
    - The Core build's source binding is verified: its recorded source
      revision is this checkout's, every keyed path is clean at collection
      time, it uses the compiled catalog with no features, and its embedded
      catalog and listings digests equal the reviewed files. The binding
      trusts the build's recorded revision; the hosted workflow builds from
      the checked-out commit. Build profile and flags outside the keyed
      files are assumed fixed.
    - The latest Core run of the source is complete, and the latest
      complete full read is less than 7 days old. The store picks that read
      by acquisition order; its age is its `started_at`, written by the
      runner that took it, compared with the collecting runner's clock, so
      clock skew between runners shifts the window by that skew. That weekly
      full read is the periodic reconciliation: it re-reads every subject
      under one build, so a dependency the model below missed cannot
      persist for more than about a week.
    - The binary's catalog inspection succeeded in the same run. Core
      validates the whole embedded catalog on load and refuses every port
      when it fails, so a selective run never reuses results across a
      catalog that no longer loads.
  - **Each subject's dependencies** (`scripts/maintenance-assessment-scope.mts`).
    A fresh-library `port-capabilities` report depends on:
    - the mechanism: each repository file in the binary's Cargo dep-info
      (`target/<profile>/portcove.d`) by Git object ID, every package
      manifest, `Cargo.lock`, `rust-toolchain.toml`, `vendor`, other
      out-of-tree build inputs by content. Cargo's binary dep-info does not
      record build environment values, so every variable compiled sources
      read with `env!` or `option_env!` (other than Cargo's manifest-derived
      `CARGO_*`) is declared with its readers and why it cannot change a
      capability report: `PORTCOVE_SOURCE_REVISION` only labels the producer
      in target inspection, and `PORTCOVE_GITHUB_CLIENT_ID` only serves
      sign-in. A test fails when a source reads an undeclared variable or a
      declared one elsewhere. Test-only modules, other crates and data that
      the binary does not embed are not mechanism.
    - the shared data: everything in the embedded `catalog.json` and
      `listings.json` that is not partitioned to one port, including fields
      or `source_catalog` arrays the module does not declare and records that
      no port reaches;
    - the subject's partition: its `ports[]` and `listings[]` entries and the
      `source_catalog` records it reaches. A record is reached when it names
      the port in `port_id` or `scope.port_id`, or when its `id` equals any
      string already in the partition, repeated to a fixpoint. Another port's
      or listing's entries join in both directions when either names the
      other's ID in any field (today `original_game.id` and
      `artwork.game_slug`), whether or not Core follows that field;
    - the policy: API schema, projection, platform identity, compiled
      features and isolation, and the Git blob IDs of the collector's own
      code (`scripts/maintenance-inventory.mts` and
      `scripts/maintenance-assessment-scope.mts`), so any edit to either
      re-assesses every subject once even without a version bump;
    - time: Core compares numeric `observed_at` values with its clock.
  - The subject's scoped key digests the mechanism, shared data, policy and
    its own partition. Doubt never narrows it. Missing, stale, unparseable or
    foreign dep-info, or a dep-info input that is missing or dirty at the
    revision, keys the mechanism by the whole Core tree as before; that tree
    contains the catalog, so any change then reassesses everything.
  - **Bindings (migration 0010).** `core_reuse_bindings` holds one row per
    source and subject: the scoped key, catalog fact digest and Core result
    digest of its last real read, the run and the run's start. Only an
    in-progress run of the same source may write a row, and never over a row
    from a newer acquisition; rows are never deleted. A read rewrites its row
    only when the key, fact, result or newest visible clock value changed.
    The row keeps the clock value its read saw (`visible_until`), or -1 when
    a value became visible while Core read, so the next run reads it again.
  - **Store-side selection.** `core_reassessment_due(source, desired)` takes
    each subject's key, fact digest and newest `observed_at` visible now. It
    returns only the subjects that need Core, with the first reason that
    applies: `unbound`, `scope-changed`, `catalog-changed`, `result-changed`
    (the binding's result is no longer the source's latest member) or `clock`
    (the newest `observed_at` visible now differs from the one the read saw,
    so a later value, or a runner whose clock is behind the reader's, both
    force a read). The collector reads
    those subjects and reuses the rest. Time-dependent inputs therefore stay
    in the decision through each subject's read time; they are never cached.
  - A reused subject is an unchanged member: no observation, assessment,
    transition or verification, so its `verified_at` stays at the last real
    Core read. The run records `reassessment` (`full` or `selective`),
    `reuse_key` (the shared base key) and `reused_count`, all fixed when it
    starts. `collect` also reports the mechanism mode, the selection's
    reasons and the Core read's process count and duration. The report's
    Sources table shows a selective run's reused count.
  - Measured on `main` from 2026-11-17 to 2026-11-23 (550 first-parent
    commits): 98 commits changed only catalog data and would reassess 1,495
    subjects in total instead of 155,880; 35 changed only Core files outside
    the binary and reassess none instead of 57,315. Every day in that window
    also changed compiled Core code, which reassesses every subject, so the
    daily scheduled run remained a full read.
- **Reconsiderations.** Typed as `technical_hold`, `intentional_deferral`,
  `upstream_change` or `evidence_refresh`, each with the owner or policy reference
  required to revisit it. Conditions are immutable, and an intentional deferral is
  satisfied or withdrawn only by a resolution naming its recorded authority. The
  store records that reference; it does not authenticate who supplied it.
  Collections derive them from their owners ([holds and deferrals](#holds-and-deferrals)).
- **Notifications.** Each notification binds one recorded transition, so an
  unchanged observation cannot create one. Delivery requires a delivery receipt.
- **Operations.** Deterministic operation IDs fenced to the subject sequence and
  the applicable assessment they were planned against
  (`fence_sequence`, `fence_assessment_id`). Every update increments the
  revision by exactly one. Planning and dispatch revalidate both, so changed
  inputs invalidate an old plan even when the displayed result is unchanged. An ambiguous operation
  resolves only with the original executor's receipt reference, which is
  immutable once recorded. Rows are never deleted.

### Limited roles

`scripts/maintenance-store/roles.sql` is idempotent and is applied after every
migration and every restore. It defines three `NOLOGIN` group roles:

| Role                             | May write                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `portcove_maintenance_collector` | Runs, observations, assessments, transitions, reconsiderations and new notifications; discovery collection through its fenced functions |
| `portcove_maintenance_executor`  | Operations, intake checkpoints and notification delivery state                                                                          |
| `portcove_maintenance_report`    | Nothing; read-only                                                                                                                      |

All three can read. None owns or alters the schema. Operators grant membership
to their own login roles outside the repository; the migrating role owns the
schema.

## Operator runbook

Commands read the connection URL from an environment variable (default
`PORTCOVE_MAINTENANCE_DATABASE_URL`, or `--database-env NAME`). The URL is
translated into libpq environment variables, so the password never appears in
arguments or output, and inherited `PG*` settings are ignored. Supported URL
parameters are `host`, `port`, `sslmode`, `sslrootcert`, `channel_binding`,
`application_name`, `connect_timeout`, `options` and `target_session_attrs`;
client-certificate authentication (`sslcert`, `sslkey`) is not supported yet. Use
`?host=/socket/dir` for a Unix socket. `PORTCOVE_POSTGRES_BIN` may name the
client directory. Keep URLs in the runner's secret store, never in the
repository, issue comments or logs.

```bash
node scripts/maintenance-store.mts status
```

For local Neon credentials, pass the file and the variable explicitly. The
file supplies only the selected variable and takes precedence over a
process variable of the same name. Use the direct URL for maintenance store
commands, including migrations, backup and restore. Once the maintenance
schema is initialized, inventory commands can use the pooled URL for routine
queries with the same options.

```bash
node scripts/maintenance-store.mts status --database-env-file .env.local --database-env DATABASE_URL_UNPOOLED
node scripts/maintenance-inventory.mts handoffs --database-env-file .env.local --database-env DATABASE_URL
```

```bash
node scripts/maintenance-store.mts migrate
```

```bash
node scripts/maintenance-store.mts backup --output work/maintenance-backup/2026-11-11
```

```bash
PORTCOVE_MAINTENANCE_DATABASE_URL="$RESTORE_TARGET_URL" node scripts/maintenance-store.mts restore --input work/maintenance-backup/2026-11-11
```

- `status` prints applied, pending and drifted migrations and exits nonzero on
  drift.
- `backup` refuses an unmigrated or drifted store. It reads one exported
  REPEATABLE READ snapshot for both the content digests and `pg_dump`, so the
  manifest describes exactly the dumped state while writers continue. It writes
  `maintenance.dump` (custom format, both maintenance schemas, without ownership
  or privileges) and `manifest.json` (format 1: server version, migration ledger,
  dump SHA-256 and size, per-table row counts and content SHA-256) to a new
  directory.
- `restore` verifies the dump digest and migration compatibility and refuses a
  target that already has maintenance schemas. It then applies the dump, the
  role contract and an in-database comparison of every table's count and digest
  with the manifest in one transaction, so any difference rolls the whole restore
  back and the target stays empty for a retry. Verification uses the backup's
  own schema. Any newer migrations of the checkout, and the role contract, then
  apply in that same transaction.
- Use `psql`, `pg_dump` and `pg_restore` from one PostgreSQL client
  installation whose major version matches the server (set
  `PORTCOVE_POSTGRES_BIN` when `PATH` mixes versions). Restore renders the dump
  to a plain-text script in a private temporary directory that is removed when
  the restore finishes; an abruptly killed restore can leave it behind.
- A restore target must run the backup's PostgreSQL major version or a newer
  one, with client tools of that version: an older `pg_restore` refuses a newer
  custom-format archive (PostgreSQL 16 refuses the 1.16 archives that
  PostgreSQL 18 writes). The production backup records its server version in
  the manifest (`server_version_num`); install that major (or a newer one),
  client and server, from the PostgreSQL project repository on the restore
  host.
- Collectors finish runs under the default READ COMMITTED isolation, so the
  derived observed count includes every committed observation of the run.
- `backup` writes to a temporary sibling directory and renames it only when
  complete, so a failed backup leaves nothing to clean up.
- `digest` prints the same per-table counts and digests for an ad hoc
  comparison.
- `server` prints the server version number, its major version and
  `pg_database_size` of the current database, so an operator can pick a matching
  client and measure storage against a provider's limits.

Digests hash UTF-8 row text with SHA-256 under pinned `TimeZone`, `DateStyle`,
`IntervalStyle` and float settings and `C` collation ordering, so they are
identical across hosts and usable on FIPS-mode servers. A failed migration,
backup or restore leaves the previous state in place.

## Read-only inventory path

`scripts/maintenance-inventory.mts` is the first real source-to-report path. It
covers an explicitly declared bounded sample, `scripts/maintenance-store/sample-v1.json`,
not the complete inventory.

```bash
node scripts/maintenance-inventory.mts collect --cli target/debug/portcove
```

```bash
node scripts/maintenance-inventory.mts report --output work/maintenance-report/2026-11-11
```

- `collect` pins the checkout's `HEAD`. It reads each declared port's authored
  record, whether `catalog.json` carries an operational definition and the
  port's scoped qualification records, exactly as committed at that revision. It
  then runs `portcove --json port-capabilities` for each port. Every CLI call
  gets its own temporary library, preferences, diagnostics and runtime lock,
  through the CLI's `--library`, `PORTCOVE_PREFERENCES` and
  `PORTCOVE_APPLICATION_RUNTIME_LOCK` overrides. The temporary root is a
  resolved real path, because Core refuses paths below a symlink. The platform
  home and configuration variables also point into the root, so on Linux and
  macOS any fallback stays isolated. Windows resolves known folders without
  those variables, so there isolation rests on the two overrides. Collection therefore never
  reads, writes or rotates the maintainer's real Portcove state. Core's report is projected unchanged: routes, features, modes
  and Core's own explanations. The recorded state names Core's managed-route
  setup mode. A refusal about the port itself (`not_found`) is recorded as
  `unassessed.not_found`, never as absence. Any other failure, such as network,
  lock or I/O, says nothing about the port. It records no Core observation,
  assessment or transition. The Core run becomes `partial`, or `failed` when no
  port succeeded, and lists each affected port and error code in `gaps`.
- Each source records a collection run. Its coverage is relative to the
  declared sample.
  The catalog observation is bound to the commit. The Core observation is bound
  to the CLI binary SHA-256, the host platform returned by that executable's
  isolated `doctor` command and the isolation scope. Legacy keys derived from
  the launcher's architecture are only reusable with matching producer evidence. Each
  Core run's revision records the binary digest and, with `--targets`, the
  build's recorded source and its `verified` or `unverified` binding ([Core
  target routes](#core-target-routes)). Without `--targets` no source is
  recorded and the binding stays `unverified`. The assessment's policy version
  is `port-capabilities;api=<n>;projection=<n>`. Its input digest covers both
  observations and the host platform. Everything is
  written in one transaction with the collector role, with
  `standard_conforming_strings` pinned for quoting. A repeated pass with
  identical inputs adds no transition. A Git failure stops the collection; only
  a path missing at the pinned revision is recorded as an absent record.
- `report` needs only the report role. It writes `inventory.json`
  (`portcove-maintenance-inventory` format 1) and a self-contained searchable
  `index.html` to a new directory, renamed into place when complete. The report
  lists each source's latest run, coverage and revision, and each subject's
  current Core assessment, history and latest observations, and whether the
  latest Core run assessed it, recorded a gap or did not include it. Unsupported sources
  and published delivery are shown as unknown with their reasons.
  - The subjects table searches every column: each word must appear somewhere
    in the row, including linked work, upstream, offering, qualification,
    attention and next action. Filters narrow it by host platform, Core
    assessment, last change within 1, 7 or 30 days of the report's own
    generation time, and "needs attention or has a next action" (attention
    conditions, this port's own health gap, a next action or a Core gap; a
    source-wide failed read alone does not select every port). The page
    shows how many subjects match. Filtering only selects rows; it never
    changes a value. The filter is one plain-JavaScript function that the page
    embeds and the tests run unchanged.
  - Freshness: for each source the report records its latest attempt and its
    latest complete or partial read (`freshness`). A failed read is an attempt,
    never a refresh. The age of the last good read is measured against the
    report's own generation time; over 36 hours (the schedule is daily) or never
    read is flagged stale. `definition-delivery` counts only a verified read as
    good and records anything else (such as nothing served yet) as a failed
    run, so its freshness is its latest serving observation (verified, not
    served, incomplete or expired); an outage or a failed tool does not count.
    The page shows when it was last verified and last observed, and the
    oldest data age excludes it; the Definition publication section shows what
    was last verified. The page states the oldest data age, names stale
    sources, and shows each source's age; stale facts stay current and visible,
    never treated as absent.

Listing-only records are marked `listing_only`. A listing establishes neither an
install nor a launch route, and the report adds no support, admission or
publication claim.

## Complete inventory collection

```bash
node scripts/maintenance-inventory.mts collect --cli target/release/portcove --all --issues
```

- `--all` covers every authored record committed at `HEAD`, not a sample.
  - Core is read with bounded concurrency (`--concurrency`, default 4). A CLI
    that advertises `port-capabilities-batch` reads up to 200 ports (and
    24,000 argument characters) per process with one catalog load; each
    port's report, or refusal code and message, is what the single-port
    command returns. A batch that exceeds its 120-second or 16 MiB budget is
    split in half, down to single ports; a single port that still exceeds it
    is a gap (`batch-time-budget` or `batch-output-budget`), so the run is
    partial and the next one reads everything. `collect` reports the largest
    batch output and the number of splits. Splitting alone could run up to
    2n-1 processes for an n-port chunk (399 for 200 ports, about 13 hours at
    120 seconds each), so the whole Core read also has a 15-minute deadline:
    no process starts after it, each process's time budget is cut to what
    remains, and every port not yet read is a gap (`core-read-deadline`).
    The worst case is therefore the 15-minute read plus the 15-minute
    collection transaction, inside the hosted step's 40 minutes; the run is
    then partial and the next one is full. The one-process-per-port fallback
    starts no process after the deadline either. A batch process whose output is
    otherwise not a valid envelope stops the collection, which then records
    nothing. On the 1,649-port catalog (debug build,
    Linux x86-64) that is 9 processes and about 16 seconds instead of 1,649
    processes and about 410 seconds. An older CLI is read one port per
    process.
  - The Core source is per host platform, for example
    `core-port-capabilities-linux-x86-64`. Assessments, transitions and
    notifications use the platform-qualified subject `port:<id>@<platform>`, so
    collecting on another host never overwrites or flips another host's state.
  - The report takes each subject's latest-run status and gaps from its own
    platform's latest Core run.
  - Collectors of the same source are serialized by a transaction-scoped
    advisory lock, and freshness follows the acquisition ticket taken before
    any external read ([storage contract](#storage-contract)).
  - Each source is read as a typed outcome and fails alone. A failed issue and
    Project, release-health or publication-bundle read records a `failed` run
    with its gap. Prior facts stay current, and every other source still lands.
    `collect` lists such sources in `failed_sources`.
  - Issue blockers, Project memberships and Project item fields follow their
    own continuation cursors. An incomplete page or a changed revision fails
    the issue collection and retains the prior facts.
- `--issues` adds the `issues-project` source. If GitHub reports a change during
  pagination, the collector discards that read and recollects once on the same
  read-only client and remaining allowance. A failed second read leaves prior
  facts current. The collection log records the first error code and the
  recollection outcome.
  - It reads the maintained, completeness-verified issue inventory with
    issue-side Project memberships (`RoadmapClient.repositoryIssues`), through a
    read-only request scope.
  - Each issue keeps its state, title, Project placement and field values, archive
    state, blockers and canonical port markers. Bodies are not stored. When an
    open issue's dependencies section records explicit, substantive `Blocker:`
    and `Resume condition:` fields (the doctor's shared parser), the issue also
    keeps them as `reconsideration`, truncated to 500 characters; other issues
    are unchanged.
  - Port assessments stay Core-only, so issue activity never creates a false port
    transition. The report links each port to its work through the catalog's
    canonical `issue_number` and the issue's `portcove-catalog-id` marker.
- Migration 0002 makes these sources changes-only:
  - A run stores an observation only for a subject whose content digest changed
    since that subject's latest observation from the same source.
  - Only a complete run records an explicit absence for a previously present
    subject. A partial or failed run never does.
  - Each run declares its member count and a digest over every present subject.
  - When a complete run finishes, the database recomputes both from retained
    observations and refuses any mismatch, so coverage stays verified without a
    row per subject per run.
  - A source can have only one run in progress.
  - Sample-mode runs keep the every-subject semantics of migration 0001.
- The report scope becomes `complete-authored-catalog` once a membership-verified
  catalog run exists.
- Each subject's report entry shows:
  - name and original game;
  - lineage `target_key` and lineage decisions;
  - alternatives, meaning other records with the same target key;
  - platforms and scoped qualification records;
  - canonical and marker-linked work, with Project status;
  - whether the latest Core run assessed it.
- Search covers subject, name, game, target key and state. The page embeds only
  the fields it renders; `inventory.json` keeps every explanation.
- **Games and implementations.** The report's universe (`universe` in
  `inventory.json`, `scripts/maintenance-universe.mts`) lists every known
  identity from facts the store already holds:
  - `port:<id>` from authored records, with its canonical issue;
  - `implementation:<key>` from each record's validated lineage history, using
    the lineage contract's own keys (`lineageIdentityKeys`);
  - `upstream:repository:<host>:<id>` for an immutable repository ID from
    reviewed catalog lineage or a validated hosted intake request. Search for
    this identity to find the listings it serves and journal requests that
    observed it. Each listing keeps its own target and Core assessments;
  - `issue:<n>` for issues named by a catalog record or hosted request, and
    issues that name catalog IDs or port keys. Closed issues remain searchable;
  - `intake:<request>` with its candidate port keys, candidate upstream URL and
    repository identities, and linked work;
  - `definition:<namespace>/<id>` from the publication source.

  Canonical work, retained implementations, accepted fork, alternative and
  independent decisions, and intake links are edges, never merges. Names and
  titles only label entries. A record whose lineage does not validate, or that
  records no lineage (legacy-unassessed), keeps its entry with an
  `identity_gap`. Only entries sharing a validated lineage target group as one
  game. An issue naming a catalog ID outside the observed catalog says
  `names-uncataloged-port` only when the catalog run was complete; after a
  sampled run it says `names-port-catalog-coverage-unknown`. The page searches entries by identity, name, game, port key or
  relationship.

- Each subject shows when it was last verified separately from when it last
  materially changed. Its policy, input digest and explanation come from the
  latest applicable assessment.
- `inventory.json` records `generation`, the newest finished acquisition it
  reflects. The report destination is always new, and a failed write leaves the
  previous report in place. `report --previous DIR` refuses to supersede a
  report of a greater generation. That check is the precondition for the later
  static-publication stage, which must compare generations again at its own
  guarded replacement. Hosted runs today keep each report as its own run
  artifact, so no report replaces another.
- The existing Maintenance inventory job summary includes a public aggregate
  of fleet and route counts, upstream coverage and gaps, the rolling window,
  pending ages and release-to-recorded-eligibility lag. The maintenance
  collection time is distinct from the actual observer execution age, which
  is unknown when the usage receipt has no execution timestamp. Pending
  reasons appear as distinct candidate counts in fixed categories. One
  candidate can appear in multiple categories, and other reasons are counted
  once per candidate. The summary includes runner time and checkpoint size
  for the imported observer attempt when the usage
  receipt matches the exact inventory bytes and observer revision. The summary
  keeps fleet interventions, automatic repairs, released-client availability
  and billed cost unknown without measured evidence. The full report remains
  in its usual run artifact. The summary has no effect on collection,
  retention, or Pages publishing.
  The summary counts open handoffs by the newest recorded operation for each
  current assessment and sequence. It reports missing operations, plans,
  dispatches, ambiguous attempts and operations tied to older assessments.
  The age uses the last change to the oldest current handoff state. Executor
  acceptance and completion require their own receipts. Missing or malformed
  handoff rows leave these counts unknown.

Observed cost (2026-11-11, cloud session, debug CLI, Linux x86-64, PostgreSQL 16):

- A first complete collection with issues took 5.1 minutes. It covered 1,441
  authored records, 1,441 Core assessments with no gaps, and 2,223 issues, and the
  store reached 28.4 MB.
- An unchanged repeat collection without issues stored no observations or
  transitions and added about 0.14 MB.
- The report was 373 KB of HTML and 13 MB of JSON.

### Release health

`--release-health` (with `--all`) adds the `release-health` source.

- **Input:** the report from the latest successful scheduled `main` run of
  `upstream-health.yml`.
  - It is read through the maintained GitHub client and artifact transfer.
  - The run identity, attempt, source commit and artifact SHA-256 are bound into
    the run revision, and the artifact digest must match GitHub's recorded digest.
  - `report.json` is read through the bounded, CRC-checked ZIP reader.
  - The monitor keeps its authority.
- **Stored facts:** each freshly and completely assessed port keeps its known
  conditions with their stable fields: key, material digest, classification,
  accounting, operation, rule, location, first seen and resume condition.
  - Per-run fields such as occurrence counts and observation times are dropped,
    so a routine recurrence stays quiet.
- **Gaps:** partially assessed, stale and unmonitored ports are recorded as
  coverage gaps, never as health facts, and they make the run `partial`.
- **Report:** the "Needs attention" column applies the monitor's own maintained
  triage (`isRoutineProviderCondition`). Only accounted, routine
  `provider-reported-*` conditions are hidden. A port whose latest health run
  that did not fail recorded a gap is marked "health not fresh". A failed
  latest read is shown with that port's previous gap, so prior facts stay
  visibly dated. A port the monitor permanently
  leaves unmonitored keeps every health run `partial`, which never records
  absences.
- **Credentials:** downloading an artifact needs a credential with the GitHub
  `actions` scope, which a hosted job's token provides.

A digest-verified report from scheduled run 43066038874 (2026-11-11) covered
358/358 operational ports with no gaps, and 8 ports need attention:

- 5 ports have unaccounted actionable conditions: four provider redirects and
  one inaccessible location.
- 3 ports have reviewed, accounted endpoint conditions that the triage keeps
  visible.

### Release content

`--release-content` (with `--all`) adds the `release-content` source
([#5353](https://github.com/boburning/portcove/issues/5353)).

- **Input:** the report from the latest successful scheduled `main` run of
  [`release-content-scan.yml`](UPSTREAM-OBSERVATIONS.md#release-content-scan),
  read like release health: through the maintained GitHub client and artifact
  transfer, from the unexpired `release-content-scan-<run>-<attempt>` artifact
  whose SHA-256 must match GitHub's recorded digest, with `report.json` read
  through the bounded, CRC-checked ZIP reader. A dispatched scan never counts.
  The run revision is
  `release-content-scan-run:<run>-<attempt>@<head_sha>#sha256:<artifact digest>`.
- **Report shape:** the scan report (format 3) declares its own target count
  (one target per unheld listing and hinted platform) and a SHA-256 of the
  target list. Every target is counted against that declared count: the
  `scanned`, `reused_targets` and `unscanned` entries must partition exactly
  that list, so an empty or truncated report can never pass as complete and
  record absences. A report with no targets is unsupported.
  - Every finding must belong to a scanned or reused target and name exactly
    its package: the same key, tag, asset and SHA-256 (`reused_targets` carry
    them). A target has at most one finding, and every scanned record with
    signals has one.
  - A finding keeps at most 20 signals (sorted) and the true `signal_count`; a
    count above the kept signals requires the full cap.
  - A finding may carry `accounted` (a reason and a reviewed
    `boburning/portcove` issue or pull request URL).
  - Any other shape is unsupported. Each not-scanned target carries a
    stable `code`, and the consumer reads the scan's own code lists. Deferred
    codes are retried by a later run: `time-budget`, `asset-budget`,
    `time-cut`, `release-read-failed` and `scan-failed` (transient network,
    provider or tool failures). Persistent codes are deterministic for the same release and
    limits: `no-release` and `no-single-asset` (nothing to download),
    `release-unavailable` (a redirect, 404 or 410), `asset-too-large`,
    `digest-mismatch`, `encrypted-archive` and `unlistable`. The scan's
    checkpoint remembers `asset-too-large`, `digest-mismatch` and
    `encrypted-archive` for a downloaded asset and does not fetch it again for
    the same release; `unlistable` is remembered as a retry and re-checked in
    rotation under its own allowance, because a lister or environment fault can
    cause it too. A retry outside this run's rotation is reported as
    `unlistable` again, never deferred, so it never makes its port a gap
    ([scan](UPSTREAM-OBSERVATIONS.md#release-content-scan)). A `release-unavailable`
    entry also names its provider (`github` or `gitlab`), which decides its
    route. Any other shape or
    code is unsupported and fails the read.
- **Stored facts:** a port is a `port:<id>` fact only when none of its targets
  is deferred. The fact keeps each finding's platform, repository, tag, asset,
  SHA-256, rules version, kept signals (path, kind and reason, sorted),
  `signal_count` and any `accounted` review, plus each persistent not-scanned
  target's platform and code. Entry counts, partial-read
  counts, checkpoint keys and free-text reasons are dropped, so a package
  reused from the scan's checkpoint stays quiet.
- **Gaps:** a port with any deferred target is a `release-content-deferred` gap
  that names each deferred platform and code, and makes the run `partial`. The
  gap also carries the findings this report already has for the port. Runs
  stay `partial` until the scan's checkpoint covers every target, which takes
  several runs at its 160-asset budget (about 780 targets on 2026-11-14).
- **Failures:** an unavailable, unbound or unsupported report makes the run
  `failed` with one `unavailable` gap; the last known facts stay current.
- **Report:** "Needs attention" and the "Release content findings" section list
  each flagged package with its listing, package identity and signals. They
  read the port's stored facts and, from the latest run that did not fail, the
  findings on its deferral gap. A finding is therefore visible from a `partial`
  run, marked as not yet covering every target of the listing. A failed latest
  read is named while the stored findings stay visible. Signals the scan's cap
  cut are counted as "and N more".
  - An accounted finding is a confirmed false positive. The section shows it
    as "accounted (reason, evidence)". It is never under "Needs attention" and
    never in a handoff condition.
  - The section's "Not scannable" list shows every persistent not-scanned
    target (listing, platform and code), from the stored facts and the
    deferral gap.
  - `digest-mismatch` (which can also mean altered bytes), `encrypted-archive`,
    `unlistable`, `asset-too-large` and `release-unavailable` leave a package
    nobody has inspected. They are listed under "Needs attention" as
    `release content not scannable: <platform> <code>`.
  - `no-release` and `no-single-asset` mean there is no package. They are
    coverage notes and are never attention.
- **Authority:** a finding is review evidence and never writes a hold. A person
  confirms it, and a reviewed catalog change sets the listing's
  `download_block_reason` under the
  [rights basis](CATALOG.md#rights-basis-for-upstream-hosted-packages). A held
  listing leaves the scan targets, so the next `complete` run records its
  absence. A confirmed false positive instead gets a reviewed entry in
  `.github/release-content-accounting.json`, which the scan applies to that
  exact package (port, platform, SHA-256 and rules version). A dismissal covers
  those package bytes under that rules version, not a particular set of
  signals. A new digest or rules version is not covered. The next `complete`
  run clears a handoff that only the accounted finding held. When a gap from
  a later run and a stored fact hold the same package, the gap's copy is
  shown, so a dismissal applies during `partial` runs too.
- **Credentials:** as for release health, the artifact download needs the
  GitHub `actions` scope.

### Definition publication

Two sources keep three facts apart: what `main` holds, the content last
verified as published, and what the appointed location serves right now.

- **Main (`--publication`, `definition-publication`).** The bundle is exported
  from the pinned revision with `git archive`, so working-tree edits are never
  recorded. Core's maintained `catalog inspect-definition-publication` then
  inspects that copy.
  - It reports the index digest and, for each validated
    `definition:<namespace>/<stable_id>`, the revision, content-addressed
    definition target, policy revision and launch revision.
  - A failed export or inspection makes the run `failed`; the last main facts
    stay current.
- **Published (`--delivery`, `definition-delivery`).** Core's
  `catalog inspect-definition-delivery` reads the appointed official location
  through the client's own trust path: the compiled root, TUF metadata and the
  signed definition index. It writes no trust, replay floor or selection.
  - Only a `verified` read records facts: per definition, the published
    revision, target, target digest and length. The run's revision carries the
    authenticated index digest and timestamp version, so routine metadata
    refreshes record nothing new.
  - A verified read is complete: a definition it no longer indexes is recorded
    as withdrawn.
  - Every other serving status is the run's gap code and makes the run `failed`:
    `not_served` (the timestamp metadata is absent: HTTP 404 or 410),
    `incomplete` (metadata is served but a file it requires is absent),
    `unreachable` (including HTTP 403), `expired`, `verification_failed` or
    `not_configured`. An HTTP status alone is never a publication fact, and
    neither a 404 nor an outage erases the last verified publication.
- **Report.** Per definition, the report compares `main` with the last verified
  publication by identity: `published-matches-main` (same revision and
  content-addressed target), `published-differs-from-main`,
  `never-verified-published`, `published-withdrawn` (a later verified read no
  longer indexed it), `published-not-on-main`, or `main-unobserved`.
  Separately, it shows the latest read's serving status and when the location
  last verified. A main-only target comparison does not cover the policy and
  launch targets, which the published index does not list per definition.
- **Authority:** neither source grants publication authority.

On 2026-11-13, `main` held `official/chameleon-twist-jp-recompiled` revision 1
(index `fd4e8154…`), and Core read the appointed location as `not_served`. No
publication has been verified.

### Upstream observations

`--upstream` (with `--all`) adds the `upstream-observations` source.

- **Input:** the checkpoint recovery snapshot of the newest completed
  `configured-upstream-observer.yml` run on `main` from a natural schedule or a
  push (`producerEvents`), with a `success` or `failure` conclusion, created in
  the last 24 hours, that still retains its unexpired
  `upstream-observer-checkpoint-<config_sha256>-<run>-<attempt>` artifact. Gated
  push runs and runs whose export did not retain a snapshot are passed over.
  - The maintained GitHub client reads up to 24 completed runs per producer
    event and checks candidates newest-first, with at most 56 metadata GETs.
    Push runs that handled admission only cannot displace the scheduled window.
    The in-memory artifact transfer uses the observer's sixteen-MiB streaming
    snapshot limit.
  - The configuration digest in the artifact name must equal the SHA-256 of
    `release/upstream-observer.json` at the run's head commit, which is how the
    workflow names its snapshot. The archive length and SHA-256 must match
    GitHub's recorded digest, the observer's own
    `readRecoverableObserverSnapshotArchive` decodes and validates the complete
    snapshot under that configuration, and the snapshot producer must equal the
    run identity, attempt and head commit.
  - The GitHub reads and the download go through an injectable transport
    (`UpstreamTransport`); the maintained client is the default, and tests
    replace it with a stub to prove the selection and binding refusals.
  - The run revision is
    `upstream-observer-run:<run>-<attempt>@<head_sha>#sha256:<artifact digest>`;
    the artifact digest also binds the configuration digest the snapshot
    carries, which is recorded in each stored observation's scope.
  - Ports are mapped with the observer's own `catalogObservationSources` over
    `catalog.json` and `listings.json` at the producer's source commit. A commit
    or file missing from the local checkout fails the read; nothing is guessed.
- **Stored facts:** per `port:<id>`, one entry per observation source that serves
  it: source key, provider, repository, repository ID, last complete facts digest,
  last change time, exception key and rule, and the Core catalog definition digest
  of the port's last complete policy. A served port that the observer also lists
  as held (for example a `user-prepared` port whose listing is observed, or a
  managed port with an unsupported listing) carries its `held_reasons`.
  - The observer's partial-progress stops (budget, cancellation, quota) keep the
    completed scope and are stored as no exception, so they cause no churn.
  - Per-observation clocks and progress (freshness, completion and due times,
    attempted sequence, retry state, provider progress and cursors), result
    digests and full policy bodies are omitted so routine re-observation stays
    quiet. For a hosted managed route, retain the offered platform and channel,
    exact release identity, publication time, and Core's retained pending or
    eligible result. A reviewed fallback leaves the current release pending.
    Curated pins and descriptive listing observations are outside this measure.
    The identity stays the same when integrity or an asset arrives under the
    same release. This records upstream candidate evidence for history. Actual
    client availability, repair publication and human interventions require
    separate receipts. The JSON report's `managed_release_eligibility` uses
    the last 30 days of retained complete and partial collection observations.
    It counts each candidate published in that window once, using its latest
    recorded state. The same window also counts candidates observed pending and
    how many later had an eligible observation at a strictly later recording time.
    Repeated observations and multiple transitions count once for each target.
    A missing publication time is reported separately. Pending
    age uses publication time. The report counts pending candidates whose latest
    observation has no recorded hold reason. Publication-to-recorded-eligibility
    lag uses the first retained eligible observation. The first and last retained
    recording times show the observed span within the reporting window. The
    report's `managed_route_observation_coverage` counts each Core-offered
    managed port and installation platform once. Its
    `catalog_operation_offers_by_platform` also counts managed installation and
    external registration separately for operational definitions. A pair offering
    both appears once in the distinct total. Declared platforms with neither
    operation have their own count. An incomplete or unbound projection leaves
    the counts unknown. Listing-only registrations and released-client delivery
    require their own evidence. It joins those offers to
    candidate facts in the latest observer collection and reports its revision,
    import time, gaps, and per-platform counts. It uses the existing Core
    definition inspection to compare the current definition digest with the
    observed definition digest. The target projection reports whether the
    CLI embeds the exact committed catalog bytes. Older recorded candidates remain visible as
    retained coverage when the current definition has changed or is unbound. Core's fixed package offers
    are counted separately from release-following offers. It verifies the retained
    checkpoint membership after removing explicitly reported gaps. Older facts
    remain visible in subject history. If the current catalog's Core target
    projection or the latest observer membership is unavailable, its count is
    unknown. When the target scope is complete, `routes` lists each offered port
    and platform with a fixed offer, exact checkpoint evidence, or the same gap
    reason as the aggregate. Exact evidence lists each verified candidate key
    once, with its channel and observed eligible or pending state when available.
    Conflicting facts for the same candidate key are marked ambiguous. Use the
    candidate key to find the recorded tag or hold reasons in the subject's
    upstream facts. The HTML report lists route gaps and links to the JSON
    evidence. Released-client availability, interventions, repairs, and cost
    stay unknown until their receipts are available.
- **Gaps:** a port is a fact only when every source serving it has completed
  with a policy for it. Otherwise the run is `partial` and the port is a gap:
  `held` (no observation source serves the port), `unobserved`
  (its source never completed), or `scope-changed` (its source's completion was
  reset, or does not cover the port). Gaps carry the source's exception key and
  rule. For a port with more than one source in the checkpoint, the gap also
  carries the retained facts for each completed source and names every incomplete
  source. The port remains outside complete coverage. This preserves descriptive
  evidence for a successor repository while an older managed origin is unavailable.
  The current-scope binding includes Core's policy identity and definition
  digests, which the snapshot does not carry, so a completion that predates a
  catalog or Core change is not detected here; the observer's own scope checks
  still apply.
- **Failures:** an unavailable, unbound or invalid snapshot makes the run
  `failed` with one `unavailable` gap and no observations, so the last known
  facts stay current.
- **Report:** an "Upstream" column shows each source's facts digest and last
  change, and the port's gap code from the latest run that did not fail
  (`latest checkpoint: <code>`). When the latest run failed, the column shows
  its source-level gap as `latest attempt failed: <code>` and the port's gap
  from the run before it as `previous checkpoint: <code>`. "Needs attention" lists observer
  exceptions (`exception_key` set) with their rule, from the stored facts or from
  a gap. The observer's own partial-progress rules (`partialProgressRules`:
  budget, cancellation and quota stops) are routine continuation and stay quiet;
  an exception without a recorded rule stays visible. No freshness threshold or
  policy is applied beyond the observer's own.
- Hosted inventory retains `observer-operating-usage.json` when it can verify
  the exact imported observer attempt and checkpoint digest. The evidence binds
  the inventory by its SHA-256. It records the event type, checkpoint bytes, executed job durations and the number of jobs
  with missing times. Skipped jobs contribute no duration. Each report covers
  one imported attempt. Billed cost remains unknown without billing evidence.
- The hosted report artifact retains the rendered aggregate as
  `managed-release-summary.md`. A successful append submits the same bytes to
  the Actions summary. Check the aggregate outcome and file digest in
  `evidence.json` alongside the separate collection outcome. A successful
  aggregate can describe retained data after collection fails.

- **Authority:** this projection grants no admission, eligibility, acquisition or
  publication authority.

To attach operator-supplied intervention assertions, use
`report --intervention-evidence FILE --intervention-evidence-sha256 DIGEST`.
The file has format
`portcove-managed-intervention-evidence`, `format_version` 1 and `sequences`
for up to 96 candidate scopes within 64 KiB. The
existing report then includes `managed_intervention_evidence` in its JSON.
Each sequence binds `candidate_key`, `port_key`, `platform`, `channel`,
`observer_revision`, `definition_sha256` and `client_sha256` to a durable
`review_ref`. Use the exact observer run, attempt, source commit and checkpoint
digest. `start` and `end` are the stated time bounds for that candidate, in UTC
with milliseconds. `coverage` is `complete` or `partial`. `actions` lists up to
32 reported human actions with an immutable `id`, `evidence_sha256` and
`witnessed_at`. Reuse the same action ID when one action affects several routes.
The report counts duplicates of the same digest and timestamp once, even if
their IDs differ. Distinct clients and time intervals for the same candidate
remain separate. An action inside a complete zero interval conflicts with that
zero when both claims refer to the same candidate, client and definition. An actor name, workflow trigger, poll, retry, or absence of an
event cannot witness a human action or a zero-intervention interval.

The report checks the supplied file digest and joins each sequence to exact
retained observer facts recorded in its interval. It shows the matched pending
and eligible states separately from the assertion. Complete coverage with an
empty action list can produce `zero-reported`, including on a pending candidate.
The review URL and client digest are supplied claims. Verified intervention
totals and rates remain unknown.

For hosted integration, give the existing maintenance inventory workflow the
immutable reviewed witness bytes and expected digest from the existing
independent acceptance record. Bind that record to the exact observer candidate
and shipped client. Include the existing protected publisher's live readback
receipt for a claimed signed repair, and the exact client observation for a
claimed availability outcome. The optional input currently records assertions
with explicit provenance. Hosted intervention measurement needs independent
verification of the witness and those bindings.

On 2026-11-11, none of the 24 newest completed schedule or push `main` runs from
the previous 24 hours retained a snapshot. In scheduled runs 43058926577,
42985430786 and 42934324534 the export step failed with "Observer snapshot
records: compressed member exceeds reserved output envelope; checkpoints
retained" (a 14.4 MB controller checkpoint, 27.3 MB decoded), so a live
collection records a `failed` run until the producer retains a snapshot again.
The owner-approved November 11 fresh baseline restored that chain on 2026-11-12:
scheduled run 43152316761 initialized it and retained a checkpoint snapshot, so
later collections read that snapshot.

### Core target routes

```bash
node scripts/maintenance-inventory.mts collect --cli target/release/portcove --all --targets
```

- **Input:** Core's library-free `catalog inspect-targets` for exactly the
  collected ports ([CLI](CLI.md#catalog-target-inspection)). It is bound to the
  same Core binary digest as the host assessments (`cli-sha256:<digest>`).
- **Stored facts:** each port's presence, declared platforms, reviewed
  acquisition hold, download restriction, and per target platform whether the
  managed install and the external registration are offered to a fresh library,
  with Core's reason, and Core's `qualification` match of recorded evidence to
  the catalog-offered artifact (format 2; it carries no observation clock). The
  facts are stored changes-only as `port:<id>`; the first format-2 collection
  records one change per operational port.
- **Producer binding:** the inspection names the producing Core: the source
  revision its build recorded, compiled features, the compiled catalog and
  listings digests, and whether a qualification override replaced the catalog.
  The Core run's revision records the binary, the source, a short producer
  digest and the binding
  (`cli-sha256:<digest>;source=<revision|unrecorded>;producer-sha256=<16>;binding=<verified|unverified>`).
  The report shows it for each subject as `verified_by`.
  Each subject's current verification names that run, so every assessment is
  bound to the exact binary and build that last verified it. A recorded
  revision that is not a Git object ID is stored as `unrecorded`.
  - The assessment policy names only how a Core report becomes a state
    (`port-capabilities;api=<n>;projection=<n>`). The assessment input is Core's
    own output, so any change in Core behavior is a new input and a new
    assessment. A rebuild with identical behavior writes no rows: the hosted
    store measured 1,441 rows per rebuild when the binary digest was in the
    policy.
  - A host assessment's `cli_source_binding` is `verified` only when the
    recorded revision is the collected checkout, that checkout's Core sources
    (`crates`, `Cargo.toml`, `Cargo.lock`) are clean, no catalog override is
    active, and no behavior-changing feature is compiled in. It records that the
    build claims the clean checked-out source; it does not rebuild to prove it.
    The `cli-sha256` digest still pins the exact binary.
  - The hosted workflow builds Core with `PORTCOVE_SOURCE_REVISION` set to the
    run's commit, in the same job and checkout that collects.
  - A new binding with an unchanged result refreshes current provenance quietly.
    If the target inspection fails, that run's policy carries no producer, and
    provenance reads as unbound until the next successful read.
- **Unknowns:** definition trust eligibility and readiness stay Core's
  `unknown`. Collecting on one host never relabels that host's own assessment as
  another platform's offering. Platforms Core does not represent, such as
  Android, are not inspected.
- **Failure:** a failed inspection is a `failed` run of its own, and the earlier
  facts stay current.
- **Report:** the subjects table adds "Offered for a fresh library", for
  example "managed install on windows-x86-64, managed install on
  linux-x86-64; trust eligibility and readiness not assessed", and
  "Qualification for the offered artifact (Core)", worded from Core's state
  only: for example "qualified for reviewed release v1.8.3 on windows-x86-64
  only if the provider resolves it", "structural checks only", "historical
  qualification only", a known failure, or legacy port-wide coverage marked as
  not artifact-bound. A qualified statement always adds that the evidence does
  not record which route it exercised.

### Hosted intake

`--hosted-intake` (with `--all`) adds the `hosted-intake` source.

- **Input:** every owner-authored #177 request the executor selects: a comment
  that starts with the hosted request marker, or a withdrawn request that keeps
  exactly one marker followed by its complete original proposal. Prose that only
  quotes the marker is not a request. They are read through the executor's own read-only
  `node scripts/hosted-discovery-intake.mts status --all --json` route
  ([contract](DAILY-PORT-DISCOVERY.md#hosted-investigation-and-actions-intake)).
  - One complete comment read is bracketed by unchanged #177 node, comment count
    and `updated_at`. Each request is classified by the executor's own request,
    receipt and reconciliation validation and its `status()` classification:
    `submitted`, `partial`, `blocked`, `complete` or `complete_with_holds`. No
    comment text is parsed here.
  - A withdrawn request keeps its exact original proposal after a prepended
    explanation and is classified from that retained proposal.
  - The read is GET-only to #177, its comment pages and exact comments. It needs
    no Roadmap connection, Project scope or write credential.
  - Its request budget comes from the observed queue. The first #177 revision
    read is admitted. Its comment count then admits one read per 20-comment page
    plus one, and the closing revision read. Each selected request whose proposal
    reconciles admits two exact-comment reads. Four retries are added on top. A
    plan over the absolute ceiling of 200 requests fails before its next request.
    The existing per-response byte cap still applies. `status --request` uses the
    same budget.
  - The run revision is
    `hosted-intake:<node_id>:<comments>@<updated_at>#sha256:<digest>`, where the
    digest covers every sorted (comment ID, body SHA-256) pair. A revision over
    200 characters is stored as its own SHA-256. The denominator is the number of
    marker-bearing owner requests.
- **Stored facts:** per `intake:<request_comment_id>`: the receipt comment,
  `withdrawn`, the request it `reconciles`, the requests it is `superseded_by`,
  `body_request_comment`, the status classification, the candidate, delivered,
  existing, held and pending counts, whether a full doctor is required, the
  doctor's status, coverage and global health, the blocker's error code, and one
  slot per ordered candidate: index, port key, repository ID, upstream, delivery
  status, linked issue (created issue or verified existing owner), whether it is
  an existing owner, and a hold's HTTP status and resume condition.
  - Receipt and diagnostic times, run, attempt, head and plan origin, hold
    observation times, doctor receipt digests and error messages are never
    stored, so an unchanged request stays quiet.
- **Gaps:** an unavailable read or an exhausted budget makes the run `failed`
  with one `unavailable` gap; queue movement during the read makes it `failed`
  with one `inventory-changed` gap. Either way nothing is observed and the last
  known facts stay current. A request the executor cannot validate is an
  `invalid-receipt` gap for that request and the run is `partial`.
- **Report:** a "Hosted intake" table lists each request's classification,
  counts, reconciliation links and linked issues, joined to the issue facts'
  state and Project status when `--issues` was collected. Each request's gap
  comes from the latest run that did not fail (`latest read: <code>`, stored as
  the entry's `latest_gap`). When the latest run failed, the state shows its
  source-level gap as `latest attempt failed: <code>` and the request's gap as
  `previous read: <code>`. "Needs attention"
  reuses the executor's classification: `blocked` shows the receipt's blocker
  code and reconciliation, and `complete_with_holds` shows the owner `process`
  resume condition. Routine `partial` continuation and `submitted` stay quiet,
  and withdrawn requests are owner decisions that are never flagged.
  Candidate-to-port joins need upstream-lineage key derivation and stay
  unasserted.
- **Authority:** this projection grants no intake, admission, Priority or support
  authority, and writes, dispatches and runs nothing.

On 2026-11-11 one live read used 18 GETs of a 23-request budget. #177 had 110 comments and 29
marker-bearing owner requests (19 active and 10 withdrawn). The run was
`complete` with no gaps, and an immediate repeat stored no observations. One
active request was `blocked` and is the only attention item. One active request
was a routine `partial`, and 17 were `complete`.

## Holds and deferrals

Typed reconsideration conditions are derived from their canonical owners on
each complete read of that owner, inside the same collection transaction. They
are never edited in the store, and a partial or failed read creates and resolves
nothing.

| Kind                   | Owner and source                                                    | Revisit authority                         |
| ---------------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| `intentional_deferral` | Open issue whose non-archived roadmap Project Status is `Deferred`  | The Project owner of that issue           |
| `technical_hold`       | Open issue whose non-archived roadmap Project Status is `Blocked`   | The Project owner of that issue           |
| `technical_hold`       | A port's reviewed catalog acquisition hold, from Core target routes | The catalog review that recorded the hold |

- Only the configured roadmap Project (`.github/roadmap.json`) counts; the
  collector resolves its identity read-only on each issue read. Another
  Project's Status fields never record a hold or deferral, and without the
  roadmap identity no issue condition changes.
- The condition records the source, the Project status or hold reason, and the
  issue's explicit blocker and resume condition when recorded (`null` otherwise).
- A complete read that no longer records a pending condition resolves it under
  its recorded authority, naming the observing run: `satisfied`
  (`condition-lifted`) when the Status or hold is gone, or `withdrawn`
  (`condition-changed`) when a changed condition replaces it. A closed issue's
  conditions end `withdrawn` (`issue-closed`), never as lifted. The store
  refuses any other authority for a deferral.
- Technical viability never resolves a deferral. For each pending deferral, the
  report lists the linked port assessments that changed after it was recorded,
  for its authority to reconsider.
- Episodes have their own IDs: a condition lifted and later recorded again
  becomes `<id>.1`, so a return to an earlier state stays in history, while an
  unchanged read writes nothing.
- The report's "Holds and deferrals" section shows every pending condition and
  the latest 200 resolutions.
- `upstream_change` and `evidence_refresh` are not derived yet: upstream and
  release-health attention stays with [executor handoffs](#executor-handoffs).

## Executor handoffs

Handoffs connect an attention item to the existing executor that resolves it.
They are not a second backlog: a handoff row has no priority, owner or status
field. Canonical work stays in its issues, Project fields and executors. The
handoff registry cannot dispatch executors.

**Registry.** `scripts/maintenance-handoffs.mts` defines one entry per attention
kind in code; it is never stored. Each entry names:

- the existing action and its exact invocation template;
- its authority (`owner-only`, `protected` or `routine`) and the executor;
- the original receipt that counts;
- `dispatch: disabled` with the exact reason and the resume condition.

| Kind                          | Existing action and invocation                                                                                                                                                         | Authority  | Receipt that counts                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| `release-health-relocation`   | `gh workflow run upstream-relocation-evidence.yml --ref main -f requests="<OWNER/NAME[@TAG]>"`, then a reviewed rename                                                                 | Owner only | The next scheduled main `upstream-health` report no longer shows it |
| `release-health-condition`    | The monitor's recorded resume condition, then an accounting or fix PR; no dispatch is offered                                                                                          | Routine    | The next scheduled main report                                      |
| `upstream-observer-exception` | The observer's recorded rule and resume condition and a fix PR; `gh workflow run configured-upstream-observer.yml --ref main`                                                          | Routine    | The next completed checkpoint snapshot                              |
| `hosted-intake-blocked`       | `status --request <id> --json`; the daily maintenance schedule resumes verified final audits. Other blockers require the recorded owner action ([route](DAILY-PORT-DISCOVERY.md))      | Owner only | A new bot receipt on #177                                           |
| `hosted-intake-holds`         | `gh workflow run hosted-discovery-intake.yml --ref main -f mode=process`                                                                                                               | Owner only | A new bot receipt on #177                                           |
| `release-content-finding`     | By condition: confirm flagged files or inspect an unreadable package, then a reviewed hold or accounting entry; unavailable GitHub releases defer to the owner-only relocation handoff | Routine    | The next scheduled main release-content scan no longer reports it   |

A test parses every referenced workflow and checks its name, trigger and input
names against the registry.

- **Relocation:** a release-health condition is a relocation only when its
  provider is `github` and its rule is one of the monitor's own
  `originalLocationReasons` (`provider-redirect`, `inaccessible-or-missing`).
  They live in the dependency-free `scripts/upstream-location-reasons.mts`,
  which also types the monitor's reviewed original-location conditions, so the
  inventory CLI loads without the monitor, its GitHub client or
  `.github/upstream-health-accounting.json`; a test checks that module closure.
  Every other condition, including transient `transport` and non-GitHub
  locations, is `release-health-condition`.
- **Accounted conditions:** the monitor's triage keeps some accounted conditions
  visible (`accounted_for` true outside the routine `provider-reported-*` case:
  a reviewed GitHub original-location condition, or a catalog-declared
  unavailable original). They keep their kind, `release-health-relocation` or
  `release-health-condition`, and their dispatch reason, but they need no new
  relocation evidence or accounting. When every condition of the handoff is
  accounted, its action says so and its invocation and resume show each
  condition's own recorded `resume_condition`. When some are not, the registry
  action applies to the unaccounted ones and names the accounted ones with their
  recorded resume conditions. With none accounted, the registry entry is shown
  unchanged. The stored condition and its digest are unchanged.
- **Release-content wording:** the action and receipt follow the condition.
  - Flagged files are confirmed against the package.
  - A package the scan could not read is downloaded and inspected by hand,
    naming its codes.
  - Either ends in a reviewed hold or, for a confirmed false positive, a
    reviewed accounting entry.
  - For a `release-unavailable` GitHub target, the routine part is only to
    confirm that the release is unavailable. Relocation evidence
    (`upstream-relocation-evidence.yml`) and any rename are owner-only. They
    follow the port's `release-health-relocation` handoff and its authority.
  - The relocation route reads GitHub repositories only. A GitLab target is
    fixed by a reviewed change to the listing's upstream location, and then the
    next scan reads the release.
  - A condition stored before the provider was recorded gets neutral wording:
    confirm, then fix the location in a reviewed change, through the owner-only
    relocation handoff for a GitHub repository.
  - In both cases the receipt is the next scan reading the release.
  - Adding `signal_count` and the provider to the condition records one changed
    condition for an already-open handoff on the first `complete` run after
    deploy.
- **Scheduled receipt:** `readReleaseHealth` accepts only scheduled `main`
  reports, so the release-health entries offer no `upstream-health.yml`
  dispatch; a dispatched run would never count as the receipt.
- **No handoff:** definition publication (#246) is protected. Core
  `port-capabilities` changes are not handoffs either: Core owns the
  assessment, and a change is reported (the digest and the report's Core and
  Changes columns), not reinterpreted as attention.

**Recording.** `collect --all` records handoffs in the collection transaction.
Upstream observation, hosted intake and release content require a complete run
of the deciding source. Release health also reports complete coverage per port.

- Each attention subject gets an assessment `handoff:<kind>:<source subject>`
  with state `needs-attention`. Its input digest covers the kind, the source
  subject and the stable condition fields, as normalized `jsonb` text. The
  policy version is the registry version (`maintenance-handoffs/1`).
  - Release health: the visible conditions' key, rule, operation, provider,
    location, release reference, classification, accounting and resume
    condition. Clocks and HTTP status are excluded.
  - Upstream: each excepted source's key, repository, exception key and rule.
    Partial-progress stops are excluded.
  - Hosted intake: the receipt comment, reconciliation and blocker code, or each
    held candidate's index, port key, repository ID, HTTP status and resume.
  - Release content: each stored finding's platform, repository, tag, asset,
    SHA-256, rules version, kept signals and signal count, and the platform
    and code of each not-scannable target that needs attention (coverage notes
    excluded). Accounted findings are left out, so a port whose only findings
    are accounted has no handoff. Only the stored facts of a `complete` run
    decide it, so nothing opens a handoff while any target is deferred; a held
    listing leaves the scan and its handoff clears.
- The assessment, transition and notification statements are the store's
  ordinary ones, so the existing guards apply. An unchanged condition resolves to
  the same assessment and records nothing. A changed condition is a new
  transition. A return to an earlier condition is flagged.
- A subject that never needed attention gets no row. A `needs-attention` subject
  whose condition is gone in a complete run transitions to `clear`.
- A partial release-health run may open or clear a handoff only for a port
  the monitor assessed freshly and completely. Gaps retain the previous state.
  Failed reads, sample collections and partial reads of other sources leave their
  existing handoffs in place. The scheduled monitor continues checking reviewed
  historical GitHub locations. When every relocation condition has a reviewed
  accounting decision and a recorded resume condition, its evidence remains in
  the health report and its handoff clears.
- An open handoff of a kind no longer in the registry clears on the next complete
  run of any handoff source, so a removed kind never lingers as open work.
- Unlike source subjects, a handoff's first transition is a pending notification,
  because a handoff appearing is itself the change.

**Hosted intake receipts.** An owner-authored #177 request can finish an existing
hosted-intake handoff through the ordinary worker. The daily schedule can resume
a final audit by passing the original request, authenticated workflow attempt and
exact pending receipt to the existing intake worker. The worker checks the live
receipt and durable checkpoint before it completes the audit.
The intake workflow reads back the authenticated bot receipt and records its
comment URL and exact body digest against the original planned operation. The
daily inventory reuses its one verified native queue read to reconcile before
refreshing handoff conditions. Failed or partial intake reads retain the original
plan. A receipt transaction failure records an intake-specific gap. Other source
collections, reporting, backup and restore continue, and the receipt outcome is
checked after the report and backup are retained. An owner can use the intake workflow's `receipts` mode after an
interruption. These paths make no new intake or Project mutation. They require
a complete request with every slot resolved, its applicable full audit, the
original request and receipt identity, and an exact current operation, assessment
and source-generation fence. For recorded checkpoints the database must agree
with the published receipt. Each previously held slot must match the original
or authorized amended identity and a delivered or pre-existing issue. Replays
leave the same operation and receipt in place. Partial or held requests,
withdrawals, restored inactive stores and unrelated executor handoffs retain
their existing state.

**Operations.** No migration was added; handoffs use the existing `operations`
table and its guard.

```bash
node scripts/maintenance-inventory.mts handoffs [--json]
```

```bash
node scripts/maintenance-inventory.mts handoffs --record
```

- `handoffs` is read-only (report role). It lists each open handoff with its
  registry entry, condition and newest open operation.
- `handoffs --record` runs with the executor role against the local store only.
  - It plans one operation `handoff.<kind>.<source>.<fence>.a<assessment>` of
    kind `handoff.<kind>` per open handoff. The fence is the handoff's current
    sequence and its applicable assessment. A later plan for the same fence
    and assessment (after the assessment moved away and back) gets a `.<n>`
    suffix, so it never collides with an abandoned one. A replay inserts
    nothing, and an open plan from before migration 0003
    (`handoff.<kind>.<source>.<fence>`, bound by the migration) still counts.
    No plan is added while any operation of the handoff is `dispatched` or
    `ambiguous`; that one resolves only through its original executor's
    receipt. Characters
    the identity check refuses (such as `@`) map to `.`. An ID that would
    exceed 200 characters (190 when it names the assessment, leaving room for
    the suffix) replaces the source with a SHA-256 prefix.
  - It moves each planned handoff operation whose subject has moved on (cleared,
    a newer condition, or a newer applicable assessment) from `planned` to
    `abandoned` at revision + 1, and plans its replacement in the same pass.
  - The planning command never dispatches or completes an operation. Separate native intake reconciliation can record a matching execution receipt. Other receipt columns stay
    empty. The guard refuses a plan at a stale fence and any revival of an
    abandoned plan, so a restored or stale worker cannot replay side effects or
    overwrite newer state.
- No dispatch command exists.

**Report.** "Next action" columns in the subjects and hosted-intake tables show
the action, invocation, authority, `dispatch disabled: <reason>; resume:
<condition>`, the receipt, and the open operation with its fence (marked stale
when it predates the current sequence or applicable assessment). Handoffs are not listed as inventory
subjects. The changes-only digest includes handoff transitions with their
recorded condition (`handoff_condition`) and names the same action as the
report.

The registry keeps executor dispatch, separate handoff schedules, digest posting
and publication disabled. The [hosted operation](#hosted-operation) records
handoffs daily and hands verified pending final audits to the native intake
worker on the same run. Other work continues through its recorded resume
condition and existing executor.

**Executor contract.** `handoffContracts` in the same module gives every kind a
typed contract. It is pure data and a pure reducer, `applyHandoffEvent`. It
reads no store, makes no network call, uses no credential and dispatches
nothing. Dispatch stays `disabled` for all six kinds, and a test asserts it.
That includes the three routine kinds: their dispatch also stays disabled
until the owner explicitly decides how executor credentials are delegated.

- **Deciding facts:** the source, the stored facts, the condition fields covered
  by the assessment's `input_digest` and the excluded fields. They match the
  recording rules above.
- **Finding key and operation identity:** the finding key is
  `handoff.<kind>.k<40 hex>`, the SHA-256 of the JSON array of contract
  version, kind, handoff subject, deciding `input_digest` and policy
  generation. The same finding always yields the same key, so a replay is
  recognized and the records of one finding are related. The source generation
  is a fence, not identity. Each operation record has its own `operation_id`:
  the finding key for the finding's first record, then `.<n>` for the n-th, as
  the store numbers a plan needed again. A finding that wakes after completion
  or reappears after abandonment gets a new record. The reducer derives the
  ordinal from the retained records, with no clock or randomness. No finding
  key or contract operation ID has been persisted yet.
- **Generation fence:** sequence, applicable assessment, source generation (the
  subject's `verified_run_id`) and policy generation (the assessment's policy
  version). An executor event whose fence differs from the operation's is
  refused as `stale-fence`. A newer verification of the same finding re-fences
  the open operation under the same key, so a holder must re-read. A changed
  finding abandons the open operation and plans a new one. Claim, checkpoint
  and complete events name the `operation_id` they act on. An event for an
  earlier record of the handoff is refused as `superseded-operation`.
- **Lease and checkpoint:** routine kinds have a 30-minute lease. A live lease
  has one holder; another claim is refused. The first claim after expiry
  reclaims it once, counts the reclaim and resumes after the last completed
  step. Steps are checkpointed in order and are idempotent, so a reclaim never
  repeats an effect. Owner-only kinds have no lease.
- **Receipt:** the store's receipt shape, a reference of at most 500 characters
  with an optional SHA-256, plus evidence references. A routine receipt is the
  scheduled report that shows the subject cleared. A completed receipt is
  immutable.
- **Wake condition:** routine kinds and relocation use `reappears-after-clear`:
  any return to `needs-attention` after the clearing receipt. Hosted intake uses
  `input-digest-changed`: a new receipt comment, reconciliation, blocker or held
  candidate. A policy generation change wakes any kind. Otherwise a completed
  operation stays completed.
- **Replay and effects:** an event ID already applied is a duplicate with no
  effect. The reducer returns effects only as descriptions of store writes.
  Each effect addresses one record by `operation_id` and carries its
  `finding_key`. `applyHandoffEffect` models the guard a store adapter must
  apply: an effect acts only on the record it names, and only while that record
  is planned or leased. A delayed abandon, lease, checkpoint, re-fence or
  receipt for an abandoned or completed record is refused, never applied to a
  newer record of the same finding. A replayed plan or identical receipt
  changes nothing.

Under the registry's policy every claim, checkpoint and completion is refused
(`dispatch-disabled`; `owner-only` for owner kinds). Tests use a `modelled`
policy only to show the lease rules.

| Kind                          | Plan         | Wake                    | Receipt                                     |
| ----------------------------- | ------------ | ----------------------- | ------------------------------------------- |
| `release-health-relocation`   | Owner intake | `reappears-after-clear` | Scheduled main upstream-health report       |
| `release-health-condition`    | Routine      | `reappears-after-clear` | Scheduled main upstream-health report       |
| `upstream-observer-exception` | Routine      | `reappears-after-clear` | Next completed observer checkpoint snapshot |
| `hosted-intake-blocked`       | Owner intake | `input-digest-changed`  | New bot receipt on #177                     |
| `hosted-intake-holds`         | Owner intake | `input-digest-changed`  | New bot receipt on #177                     |
| `release-content-finding`     | Routine      | `reappears-after-clear` | Scheduled main release-content scan report  |

**Routine executor plans.** The three routine kinds carry the plan a
deterministic, non-AI GitHub Actions job would follow. It would run as a step
of the existing scheduled `maintenance-inventory.yml` job; no workflow,
schedule or dispatch exists for it.

1. `read-handoff`: read the handoff, assessment and operation with the report
   role.
2. `check-fence`: stop when the sequence, assessment, source generation or
   policy generation moved.
3. `take-lease`: claim, or reclaim an expired lease, and resume after the last
   checkpoint.
4. `gather-evidence`: from the stored condition only, list the release-health
   conditions with their recorded resume conditions, the observer exceptions,
   or the flagged and unreadable packages for a person to confirm.
5. `publish-evidence`: the job summary and a retained artifact named by the
   operation identity.
6. `await-receipt`: a later scheduled main report or completed observer
   checkpoint. Dispatched and pull-request runs never count.
7. `record-receipt`: the run URL and report SHA-256, then complete and release.

Permissions: `GITHUB_TOKEN` `contents: read` and `actions: read`, and the
existing store executor role. A role grants table access, not one row. What
would bound the job to its own record is a requirement on the future store
adapter: change rows only through a guarded function that addresses one
operation record by its identity and fence, as `applyHandoffEffect` models.
No such function exists yet. The job must never write
repository contents, push, or open, approve or merge a pull request. It must
never comment on or edit issues or Project fields, or dispatch any workflow. It
must never use the Project, signing or publication credentials or any delegated
token. It must never publish, call an AI service, choose a remedy or act on a
moved fence. The release-content plan also never confirms game data, writes a
hold or accounting entry, or starts relocation evidence.

The owner-only kinds (`release-health-relocation`, `hosted-intake-blocked`,
`hosted-intake-holds`) stay inert owner intake. Their executors need owner
authority, which has not been granted.

**Persistence not yet added.** The `operations` table holds the fence sequence
and assessment, executor, state, revision and receipt reference and SHA-256.
Persisting the contract needs a store migration that adds the finding key,
deciding `input_digest`, source and policy generation, lease holder, expiry and
reclaim count, the last checkpoint and the completing sequence. Its guard would
need to refuse a stale fence on every lease or checkpoint update, refuse any
write to a closed record, keep one live holder, and allow a reclaim only after
expiry. Until then the contract is a
tested model only.

## Hosted operation

[`maintenance-inventory.yml`](../.github/workflows/maintenance-inventory.yml)
runs the generic commands above unchanged on a GitHub-hosted runner. It follows
owner decisions recorded on 2026-11-13. Unattended evidence belongs to #4129
checkpoint 5 and is recorded there.

The daily 04:47 UTC run collects every declared source, records eligible
handoffs, takes a portable recovery point and renders inventory and digest files
from that recovery point on a local PostgreSQL server. Core results whose
[scoped dependencies](#storage-contract) are unchanged are reused; the store
selects the subjects whose inputs changed or whose clock-dated facts became
visible. A full Core pass still runs when no complete full pass finished in
the last seven days. A failed
source preserves its last verified data. The backup checks the committed store
independently of the collection exit status.

Manual runs default to `status`. Each purpose runs on repository `main`.
Purpose and revision scope the concurrency groups. A manual request cannot
replace a pending scheduled run. PostgreSQL serializes budget admissions and
fences stale collection writes across groups. Reuse retained artifacts when
inspecting historical executions. Before migration 0006, a historical rerun can still use the original full export path.

| Purpose           | Work                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `status`          | Record the provider reading and exercise bounded admission with a migration-status query.                                           |
| `collect-changed` | Read only pinned catalog and Core facts with selective reassessment. Leave external sources, reports and recovery to the daily run. |
| `report`          | Restore a retained, independently verified backup and render its report and digest on local PostgreSQL.                             |
| `verify-recovery` | Restore a retained backup on a clean local PostgreSQL instance and verify it.                                                       |
| `recover`         | Create and independently restore a portable recovery point using the retained history prefix.                                       |
| `recovery-full`   | Request a separately admitted full recovery export to seed a replacement baseline.                                                  |

Equivalent manual catalog requests with the same pinned revision and a recent
completed result coalesce inside a ten-minute window. A clock-dated change or
an incomplete result remains eligible. Daily collection reads fresh external
source identities.

The daily run keeps existing source and repository access. The production steps
use the direct database secret `PORTCOVE_DATABASE_URL`. Collection uses
`PORTCOVE_ROADMAP_TOKEN` to read the Project. A verified scheduled final audit
uses the existing intake worker's Project credential, separate database role and
metered admission in the same run. Before collection can advance the handoff
fences, the worker reads the intake queue and checkpoints and reconciles the
original receipts under its executor role. The receipt-only job uses the
repository token for reads and has its own concurrency group, so it cannot
displace an owner-authorized writer that is waiting for the intake slot. Each
receipt pass reserves its own run attempt. Collection and backup continue even
when this receipt pass fails. With no bound audit tickets the scheduler performs
no audit. The scoped audit worker checks receipts again after its audit passes
return. The collection report records the delegation and the executor jobs
record their own outcomes. The metered steps also require
`PORTCOVE_NEON_METER_TOKEN` with effective Viewer access to the existing Portcove
project. A personal token from a dedicated Neon Collaborator with only this
project's Viewer grant can supply that access. Project-scoped organization keys
have Editor rights. The application checks effective Viewer access before using
the metadata response. See [Neon API keys](https://neon.com/docs/manage/api-keys)
and [Neon user permissions](https://neon.com/docs/manage/user-permissions).

During local PostgreSQL replay, pass the existing `--database-env` or
`--database-env-file` options with a local connection. On Neon the store and
inventory CLI apply the same meter used by the workflow, including for direct
report, digest, recovery and migration commands. `maintenance-inventory.mts
status` reads small source and notification counts. `history --subject KEY
--before N` reads up to 100 transitions below sequence N. Run the history command
on a local restore for offline investigation. Routine reports keep the latest
12 transitions per subject and indicate when earlier records exist. Report and
digest queries use the same restored snapshot, and the original tables preserve
their full history.

### Portable recovery

The service has an implied daily recovery point from the existing schedule.
There is no separately committed recovery time. The independent restore job
retains its existing 20-minute job budget and records actual restore duration.

The newest retained backup with matching independent restore evidence seeds the
next export. A manual recovery request can reuse a verified backup under 20 hours
old after matching protected table digests and sequence values. PostgreSQL compares ordered content hashes and row counts for the
retained prefix of each large append-only table under one exported snapshot.
When a prefix matches, only newer rows cross the network. A mismatch requires
that table's full payload to fit the admission. The schedule requests a larger
envelope when the retained recovery point is more than 30 hours old. Beyond 54
hours, a live meter can admit a full recovery envelope. Incomplete GitHub
inventory never implies that the prior backup is missing. All smaller tables, including
mutable state and the migration ledger, come from the same snapshot. The
independent reconstruction loads current schema and data, preserves sequence
values and verifies all protected table hashes before writing a new standalone
ordinary PostgreSQL dump. The new dump has no runtime dependency on its seed
artifact. Portable restore still clears discovery intake activation.

The independent job downloads the exact new backup from GitHub and verifies it
on its own local server. Backup, report, and restore-proof artifacts retain their
existing 30-day window. The retention policy covers GitHub files. PostgreSQL
history remains intact. If recovery is pending, the workflow records the last
verified artifact and capture time. At recovery age over 24 hours, or if no
verified artifact can be identified, the job raises an operational warning.

### Free-plan admission and evidence

The policy reads the Free project and production branch metadata over HTTPS.
`data_transfer_bytes` is the cumulative project transfer counter. The branch
counter and logical size are separate corroborating measurements.
`compute_time_seconds / 3600` gives provider CU-hours. Compute active time,
workflow time, file sizes and PostgreSQL payload estimates keep their own units.
The sample time records the API request. Neon does not supply a causal watermark
for individual operations. See [Neon network transfer](https://neon.com/docs/introduction/network-transfer)
and [Neon plans](https://neon.com/docs/introduction/plans).

An admission transaction locks the shared ledger before comparing the measured
period, cumulative counter and prior reservations. Its operation key records the
run, attempt where needed, source revision and trigger. A successful delivery
with a saved output can satisfy an equivalent request. Cancellation or an
uncertain outcome leaves its full reservation charged for the period. A completed
operation records a logical PostgreSQL response estimate with a protocol margin.
It stays provisionally charged alongside the project meter until period reset
because a rise in the meter can belong to another client. This deliberately
overcounts overlap instead of treating an immediate API delta as command bytes.
Evidence shows the difference that can be attributed only as a lower bound
and leaves exact unattributed transfer unknown.

`resource.jsonl` in the existing evidence artifact records sample, operation,
remaining bytes, unreconciled charges, future recovery provision, retry condition
and outcome. The GitHub summary reports deferred work and the dated recovery point.
Publication and player routes keep their existing static signed catalog inputs.
No paid fallback is used.

Missing or regressed readings defer metered work outside the finite November
cutover. The cutover uses the 20:51 UTC November 20 observation only for the
existing production endpoint and charges at most 300 MB through the recorded
December 1 reset. The workflow labels that reading as historical and reports
current remaining allowance as unknown. It keeps full exports and direct report
exports outside this temporary envelope. A configured but invalid Viewer token
defers work. The next scheduled maintenance
run, or the next existing discovery intake event, retries from its durable source
or receipt. Retained-artifact reports and restore checks remain available offline.
A repeated deferral stays visible as the age of the last verified recovery point
and with its remaining allowance. If a large export cannot fit its reservation,
work waits for a separately admissible baseline export. Normal collection
failure does not grant permission for a full export.

### Workload model

The November 20, 2026 sample reported 4,065,773,982 bytes used out of 5,000,000,000,
with 934,226,018 bytes remaining until December 1 at 00:00 UTC. The production
branch was 170,606,592 logical bytes, and the provider had recorded 9,790
compute-seconds (2.72 CU-hours). The cutover policy sets aside 350 MB of emergency
capacity plus projected daily recovery for the remaining days. A normal full
period earmarks 2 GB for recovery and uncertainty, outside the routine 3 GB
allowance. Recovery itself can draw from the earmark while retaining emergency
capacity for failure or unaccounted transfer.

| Case                     | Recurring and burst assumptions                                                     | Transfer model                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Legacy November baseline | One normal export per day, with the same backup size as run 44799126269             | 143.61 MB logical COPY × 31 = 4.45 GB for backups alone. The compressed dump was 17.01 MB. The 26.66 MB rendered inventory was a separate output.                                                                  |
| Cutover period           | 10 additional daily slots at 22 MB recovery forecast and 350 MB emergency allowance | 220 MB projected future recovery. The credential-free transition envelope limits all new admissions to 300 MB of the 934 MB sampled balance. At least 634 MB of the sampled allowance stays outside that envelope. |
| Normal full month        | 31 recovery points at 22 MB and 31 collection admissions at up to 18 MB             | 1.24 GB projected plus narrow handoff and status reads. Reports, digest and independent restore are local.                                                                                                         |
| Development burst        | Normal month plus 15 scoped collection attempts and 15 status probes                | Up to 300 MB in additional reservations before protocol uncertainty, history growth and conservative provider overlap.                                                                                             |

The retained artifact and local PostgreSQL replay measured a zero-change recovery
at approximately 5.27 MB of small-table SQL output and zero remotely needed
history rows. The prior backup's 143.61 MB of COPY included 138.34 MB from
observations and assessments. A high-growth retained collection added about
11.5 MB of history, and a dispatch-heavy day added about 15 MB. A new 48 MB
recovery reservation bounds same-snapshot size before downloading. Recheck the
model as the growing collection ledger or history invalidates these assumptions.
Local replay measures payload and restored content. Only a later production run
can establish actual Neon savings. [Retained run 44799126269](https://github.com/boburning/portcove/actions/runs/44799126269)

**First hosted run (2026-11-13, run 43351437599, `workflow_dispatch` on
f7d26628).** Neon PostgreSQL 18 was detected, and the matching client was
installed and migrated. The first complete collection then exceeded the
client's former two-minute limit (`psql ETIMEDOUT`), and its transaction
committed nothing. Restoring the backup (schema and migration ledger only) onto standard PostgreSQL 18
failed on Neon's `pg_attver` column options. Both failures are addressed by the batching, the collection budget and the restore filter above; a successful hosted rerun is recorded separately. The run was
operationally useful: the store kept no partial state, and the independent
restore found the portability gap before any history depended on it.

**Interruption and provider failure.** Migrations, collection writes and
reconstruction are transactional. Interrupted work retains the previous artifact.
The scheduler reads fresh source inputs at its next attempt. A failed source
records a partial or failed observation. A finished recovery requires upload
and independent restore evidence with the same dump SHA-256.

### Accepted cover CDN health

The existing scheduled maintenance inventory verifies one UTC-day window of
accepted cover URLs after compiling its Core CLI. Windows contain at most 64
distinct images, sorted by accepted image ID. Successive UTC days cover the
whole stable inventory once per rotation. Shared image URLs are read once and
compared separately against each current authored digest. A missed, interrupted
or budget-limited pass leaves those observations unknown for that pass; it does
not create a withdrawal. Image bytes are temporary, and the pass is limited to
64 MiB and 150 seconds before the outstanding Core check is settled.

The producer has no Twitch, GitHub or database credentials. It validates images
using the existing Core decoder. The scheduled collector admits only the same
protected maintenance workflow run and attempt, and compares the report to its
exact checkout, committed listings, binary digest and deterministic window.
The existing store records source `cover-artwork-health`: a matching digest,
an exact HTTP 410, a validated digest mismatch, or a gap for an unavailable or
deferred observation. A partial run does not erase earlier observations.
The receipt and store facts grant no artwork admission, withdrawal, native-client
or publication authority. A changed or withdrawn reference still passes through
the existing artwork review and signed catalog path. This worker verifies
accepted CDN references only. IGDB metadata refresh remains on the established
maintainer host.

## Changes-only digest

```bash
node scripts/maintenance-inventory.mts digest --output work/maintenance-digest/2026-11-11
```

```bash
node scripts/maintenance-inventory.mts acknowledge --digest work/maintenance-digest/2026-11-11/digest.json --receipt URL
```

- Each assessment transition after a subject's baseline creates one pending
  notification in the collection transaction. A first assessment is a baseline,
  not a change, and an unchanged observation creates nothing. A handoff's first
  `needs-attention` transition is a change ([executor handoffs](#executor-handoffs)).
- `digest` reads only pending notifications and writes `digest.json` and
  `digest.md` (format 1). It marks nothing delivered.
  - Each entry names the subject and its previous and new state, and flags a
    return to an earlier result. A handoff entry also carries its recorded
    condition as `handoff_condition` (null for other subjects).
- Posting the digest belongs to an existing authorized executor and is not
  automated here; that dispatch stays disabled.
- `acknowledge` runs with the executor role. It records the delivering
  executor's own receipt reference against exactly that digest's still-pending
  notifications, and a replay changes nothing. The collector and report roles
  cannot acknowledge.

## Validation

`scripts/maintenance-store.test.mts` creates two disposable PostgreSQL clusters,
migrates one, records representative A to B to A history, a pending deferral,
delivered and pending notifications and an ambiguous operation, and exercises
every guard and role boundary, including refusal of a plan whose applicable
assessment has moved. It then backs up, restores to the second cluster,
verifies identical digests and confirms that guards, identity sequences and roles
work on the restored store. A separate case interrupts a migration and proves
that no partial schema remains and that resume and drift detection work.
`scripts/maintenance-handoffs.test.mts` checks the registry, its workflows and
inputs, identities, the per-source projections, the accounted-condition
guidance and that the inventory CLI loads without the monitor or its accounting
file. `scripts/maintenance-upstream.test.mts` drives the observer snapshot
selection through a stubbed transport: foreign producer runs, passed-over and
refused artifacts, digest, configuration and producer mismatches, and no
retained snapshot.
`scripts/maintenance-inventory.test.mts` drives the read-only path through a
stub Core CLI, using the collector and report roles. It checks:

- repeated-pass convergence and A to B to A history;
- quiet provenance refresh for the same result under new inputs, a rebuilt Core
  binary that adds no assessment rows, and a verifying run that states its own
  source binding,
  refusal of an older collection that finishes after a newer one, ticket rather
  than clock order, replayed, unissued and baseline-changed refusals, and
  failed issue and release-health reads that keep earlier facts;
- host-failure gaps (`partial` and `failed` runs with no transition);
- changes-only storage, verified membership and forged-membership refusal;
- absence recorded only by complete runs, and a single in-progress run per source;
- issue and Project joins;
- full-versus-incremental parity;
- per-call isolation and its removal, including under a symlinked `TMPDIR`;
- coverage, listing and absence facts;
- release-health, upstream-observation, hosted-intake and release-content
  coverage, quiet recurrence, needs-attention and failed reads, with
  per-subject gaps from the latest run that did not fail, including a
  release-content finding shown from a `partial` run;
- executor handoffs: one planned operation per appearance, quiet unchanged reruns
  and replays, no clearing by partial or failed runs, `clear` and
  `planned` to `abandoned` after a complete run, supersession and return
  detection, no handoff from Core changes, clearing of unregistered kinds,
  stale-fence refusal and role boundaries;
- the hosted workflow's schedule, permissions, secret placement and artifact
  retention, and the issue collector's own named credential;
- report output and HTML escaping. The
  cases need non-root PostgreSQL 16+ server binaries and are a declared
  prerequisite skip elsewhere. These are fixture results. Hosted provider, backup
  destination and unattended operation evidence belong to the later #4129
  checkpoints.

## Optional upstream research progress

`maintenance-inventory.mts collect --all --cli PATH --progress
scripts/upstream-progress/sources-v1.json` adds the reviewed research scope through
the same collector, transaction and daily workflow. Each exact source has a
`research-progress-<scope digest>` run with the existing acquisition fence,
append-only observations and changes-only membership. Failed sources preserve
last-good rows and checks; an unavailable provider never stalls unrelated
sources or Core assessment.

`report` includes dated progress, exact game/edition, metric meaning, evidence
and last-attempt failure alongside last-good age. Stored optional rows are
validated again before rendering. A missing or stale progress row has no effect
on the offered-route assessment. Research conditions use the existing transition
and notification tables; unchanged checks do not notify and repeated states
retain distinct transition episodes. New progress dispatch is not enabled.
Current project opt-outs suppress future report and pending-digest exposure of
older research evidence, while private immutable recovery history remains.

The owning adapter, scope, precision, failure and opt-out contract is
[Optional research-progress observations](UPSTREAM-OBSERVATIONS.md#optional-research-progress-observations).

## Program cutover view

`node scripts/maintenance-program-view.mts` derives a read-only operator view of
the dynamic native ports program (#1422). It is a projection, not a backlog or
status authority: GitHub Projects and the canonical issues keep planning,
priority and status, and `catalog.json` keeps support. The script reads no
network, writes no store rows and edits no catalog data. It calls
`routeFitReport` from `catalog-route-fit.mts` rather than classifying the
catalog again, reads the handoff registry from `maintenance-handoffs.mts` and
scans repository code for title-specific authorities. Output is deterministic
JSON (`--json`, `--output FILE`) or a summary; it carries no timestamps.
`--check` also verifies that two runs are byte-identical and that the authority
inventory has not rotted. `--observations FILE` passes listing updates to route
fit; `--observer-report FILE` reads a catalog upstream observer report.

Each catalog identity is one subject with its product scope (`in-scope`, or
`deferred-scummvm` when route fit reports `excluded-scummvm`), route-fit
disposition and reason, family, declared restrictions and held operations, the
title-specific authority kinds that still serve it, and one remaining action:
`none`, `retire-title-authority`, `resolve-authority-inventory` (retirement is
unknown because an authority kind cannot derive whom it serves),
`data-enrollment`, `observation`, `bytes-worker`, `admission`,
`missing-capability`, `upstream-condition` or `owner-decision` (deferred product
scope).

**Coverage gates.** Each gate is a ratio over a versioned denominator with a
`state` of `passed`, `failed` or `unknown`, and lists the identities failing it
and those whose result is unknown. Deferred ScummVM identities are in neither
denominator.

| Gate                | Denominator (version)                                               | Passing identity                                                           |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `fitting`           | in-scope identities (`program-view/in-scope/1`)                     | a determined disposition other than `unobserved`                           |
| `retired-authority` | in-scope `enrolled` identities (`program-view/in-scope-enrolled/1`) | no known title-specific authority detector matched it, and none is unknown |

Passing the retired-authority gate means only that no detector in the inventory
matched the identity; it is not proof that its behavior is data-declared. The
gate is conservative: unknown never counts as retired. A kind that cannot
derive the identities it serves takes them from its declared `covered_through`
kind only when that kind derives them fully; a kind with no covering kind, with
a covering kind that cannot derive identities, or with matched entries it cannot
attribute (for example a `native_external_profile` module that is not keyed on
`ExternalProfilePolicy`) is listed in `unknown_kinds`. Every enrolled identity
it does not already fail is then `unknown`, outside the numerator, and the gate
cannot pass.

**Authority kinds.** The retired-authority gate is derived from code, not a
hand list. `authorityKinds` declares each kind of title-specific authority with
a detector over code shape: catalog generator scripts that select records by a
literal identity or upstream repository; production Core Rust that names a
literal identity; Core Rust compiled only under a Cargo feature (such as
`#[cfg(any(test, feature = "qualification-fixtures"))]` items and modules) that
names one, as the separate `qualification-fixture-title-code` kind; Core enum
variants and module files whose names spell a catalog identity, listing name,
GitHub repository name or family key, with the catalog as the dictionary
(`title-named-core-item`); closed per-runtime contract enums
(`ExternalProfilePolicy`, `ManagedInitialization`, `RuntimeDataPolicy` and the
prepared runtime contracts) matched against definition values; the
`native_external_profile` modules, covered through `ExternalProfilePolicy`;
compiled provider binding tables; the bundled frozen artifact registries
(`historical-artifact-registry`); and the retired `github_mods.rs` source
table and `external-mod-portals.json`, which #8567 replaced with catalog
`mod_sources` data and which must stay absent. The registry kind reads every
section of Core's `historical-artifacts.json` and the reviewed
`tool-artifacts.json` builder packs as declared members. A historical row covers its `port_id` or
`projection`, the catalog definition whose release repository equals its
`repository`, or the identity whose definition or port-scoped `source_catalog`
record declares its exact `sha256`; otherwise the catalog title keys its text
spells. A historical row that names no subject this way is an unattributed
entry, so the gate turns unknown instead of passing. A builder pack is chosen
only through a definition's admitted projection and names no title, so an
unmatched tool row is counted and rot-checked but covers no identity. Only `#[test]` functions and items gated on exactly
`#[cfg(test)]`, and test-named files, are excluded; platform gates such as
`cfg(any(test, windows))` are production code. Each kind reports its count,
files, covered identities where derivable and any entries it cannot attribute,
and is `retired` when its detector finds nothing.

The view and its test fail on the detector rot they can see: a kind that finds
nothing but is not declared retired, or matches while declared retired; an
active kind that derives identities but covers none, unless it declares why it
has no catalog consumer (`no_catalog_consumer`, as for
`PreparedRuntimeSettingsContract`, which Core selects for a player-prepared
runtime); and, for enum and table detectors, each declared enum, table or file
that is missing, read without rows or found undeclared, unless that member is
individually declared retired. The enum reader fails loudly on a `rename_all`
other than kebab-case, a variant with fields or a discriminant, or a serde
attribute it cannot read, rather than skipping variants. Rot outside these
checks (a new title-specific shape no detector searches) stays possible; the
detectors bound what the gate can claim.

**Metrics.** Counts per disposition and family over all identities
(`program-view/identities/1`), listing-only GitHub candidates with Windows
packages, restricted identities and held operations, handoff classes with their
dispatch state (`program-view/handoff-classes/1`) and, only when a report is
supplied, observer source coverage by state (`program-view/observer-sources/1`).
Without a report, observer coverage is `unknown`, never zero. A change in a
denominator's meaning bumps its version.
