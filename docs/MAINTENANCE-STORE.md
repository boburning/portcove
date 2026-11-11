# Maintenance inventory store

This document owns the stable source, identity, coverage and storage contracts
for the maintainer-facing maintenance application specified in
[#4129](https://github.com/boburning/portcove/issues/4129). The issue owns the
executable acceptance and checkpoint evidence; this page is not a backlog.

The application is maintainer tooling. Player installation, update, backup and
launch never depend on it, and it grants no admission, support, qualification,
publication or credential authority.

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

## Canonical identities

`subject_key` is `<kind>:<identity>` using an existing canonical identity:

- `port:<listing.id>`: the stable port ID, with its canonical port issue
  (`listing.issue_number`).
- `implementation:<uniqueness key>`: the lineage key derived by
  `scripts/upstream-lineage.mts` (`url:` or `repository:` plus `target_key`), so
  distinct implementations of one game stay distinct while sharing `target_key`.
- `issue:<number>` for canonical work without a port record.

An observation's `scope` binds the applicable artifact, source, platform, route,
operation and check/policy version. Evidence applies only where its whole scope
matches; a new artifact or platform never inherits unrelated qualification.
Main availability is a repository revision. Published delivery is a definition
identity `(namespace, stable_id, revision, content_sha256)` or published site
generation; tags, titles and issue state never stand in for it.

## Declared sources and coverage

Each collection run belongs to one declared source and records its exact source
revision, expected denominator, observed count and gaps. `complete` requires a
known denominator equal to the observed count with no gaps; the database
enforces this. `partial`, `failed` and stale runs are unknown coverage, never
absence or deletion, and the last complete observation remains visibly dated.

| Source                              | Maintained owner interface                                                                                | Completeness signal                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Open/closed issues                  | `scripts/repository-issue-inventory.mts` through `node scripts/roadmap.mts doctor --json`                 | Total count, terminated pagination, before/after markers      |
| Project items (active and archived) | `scripts/roadmap-inventory.mts` (`items`, `archivedItems`)                                                | Project revision and item totals stable across the read       |
| Catalog, listings, lineage          | Per-ID records; `node scripts/generate-catalog.mts --check`; `portcove --json catalog export`             | Generated projections match the authored tree at one revision |
| Offered capability per port         | `portcove --json port-capabilities PORT_ID`; `portcove --json capabilities`                               | Per port only; no catalog-wide matrix exists                  |
| Scoped qualification                | `catalog.json` `source_catalog.qualification[]` and `evidence[]`                                          | Exact scope per record; no catalog-wide denominator           |
| Upstream observations               | `scripts/observe-catalog-upstreams.mts` and `scripts/observe-configured-upstream.mts` checkpoints/reports | `total_sources` versus completed and pending source keys      |
| Release health                      | `scripts/upstream-health-monitor.mts` report and `work/upstream-health/checkpoint.json`                   | Fresh complete, partial, stale and unmonitored port IDs       |
| Hosted intake receipts              | `node scripts/hosted-discovery-intake.mts status --request ID --json`; receipt comments on #177           | Per request: delivered, existing and pending counts           |
| Definition publication              | `portcove --json catalog inspect-definition-publication DIR`; published site readback                     | Index digest and per-target digests                           |

Known gaps stay explicit until an owner exports the fact: there is no persisted
export of full issue rows or Project field values, no catalog-wide capability or
route matrix, no shared schema for `docs/qualification/` files, no durable
upstream-health history beyond cached checkpoints and short-lived artifacts, no
aggregated hosted-intake receipt export, no maintained main-versus-published
comparison, and route ownership is prose rather than a per-port field. Reports
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
- **Transitions.** A writer names the sequence it creates. The guard accepts only
  the next sequence, so a stale or restored worker cannot overwrite newer state.
  An unchanged result is not a transition. A return to an earlier result is a new
  transition marked `returns_to_earlier_result`.
- **Reconsiderations.** Typed as `technical_hold`, `intentional_deferral`,
  `upstream_change` or `evidence_refresh`, each with the owner or policy reference
  required to revisit it. Conditions are immutable, and an intentional deferral is
  satisfied only by a resolution naming its recorded authority.
- **Notifications.** Each notification binds one recorded transition, so an
  unchanged observation cannot create one. Delivery requires a delivery receipt.
- **Operations.** Deterministic operation IDs fenced to the subject sequence they
  were planned against. Every update increments the revision by exactly one.
  Dispatch revalidates that the subject has not advanced. An ambiguous operation
  resolves only with the original executor's receipt reference, which is
  immutable once recorded. Rows are never deleted.

### Limited roles

`scripts/maintenance-store/roles.sql` is idempotent and is applied after every
migration and every restore. It defines three `NOLOGIN` group roles:

| Role                             | May write                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `portcove_maintenance_collector` | Runs, observations, assessments, transitions, reconsiderations and new notifications |
| `portcove_maintenance_executor`  | Operations and notification delivery state                                           |
| `portcove_maintenance_report`    | Nothing; read-only                                                                   |

All three can read. None owns or alters the schema. Operators grant membership
to their own login roles outside the repository; the migrating role owns the
schema.

## Operator runbook

Commands read the connection URL from an environment variable (default
`PORTCOVE_MAINTENANCE_DATABASE_URL`, or `--database-env NAME`). The URL is
translated into libpq environment variables, so the password never appears in
arguments or output, and inherited `PG*` settings are ignored. Supported URL
parameters are `host`, `port`, `sslmode`, `sslrootcert`, `channel_binding`,
`application_name`, `connect_timeout`, `options` and `target_session_attrs`. Use
`?host=/socket/dir` for a Unix socket. `PORTCOVE_POSTGRES_BIN` may name the
client directory. Keep URLs in the runner's secret store, never in the
repository, issue comments or logs.

```bash
node scripts/maintenance-store.mts status
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
  dump SHA-256 and size, per-table row counts and content MD5) to a new
  directory.
- `restore` verifies the dump digest and migration compatibility, refuses a
  target that already has maintenance schemas, restores in one transaction,
  reapplies the role contract and compares every table's count and digest with
  the manifest. Any difference fails the restore. Run `migrate` afterwards if the
  checkout carries newer migrations.
- `digest` prints the same per-table counts and digests for an ad hoc
  comparison.

Digests use UTC, ISO dates and `C` collation ordering so they are identical
across hosts. A failed migration, backup or restore leaves the previous state in
place.

## Validation

`scripts/maintenance-store.test.mts` creates two disposable PostgreSQL clusters,
migrates one, records representative A to B to A history, a pending deferral,
delivered and pending notifications and an ambiguous operation, and exercises
every guard and role boundary. It then backs up, restores to the second cluster,
verifies identical digests and confirms that guards, identity sequences and roles
work on the restored store. A separate case interrupts a migration and proves
that no partial schema remains and that resume and drift detection work. The
cases need non-root PostgreSQL 16+ server binaries and are a declared
prerequisite skip elsewhere. These are fixture results. Hosted provider, backup
destination and unattended operation evidence belong to the later #4129
checkpoints.
