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
- `intake:<request_comment_id>`: one owner-authored hosted-intake request on
  #177, by the immutable ID of its request comment. A withdrawn request keeps its
  identity. Its candidates link to canonical work through `issue:<number>`; a
  candidate `port_key` is not a catalog ID and is never keyed as `port:`.

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
| Hosted intake receipts              | `node scripts/hosted-discovery-intake.mts status --all --json` over the receipt comments on #177     | Every marker-bearing owner request in one drift-checked read  |
| Definition publication              | `portcove --json catalog inspect-definition-publication DIR`; published site readback                | Index digest and per-target digests                           |

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
- **Transitions.** A writer names the sequence it creates. The guard accepts only
  the next sequence, so a stale or restored worker cannot overwrite newer state.
  An unchanged result is not a transition. A return to an earlier result is a new
  transition marked `returns_to_earlier_result`.
- **Reconsiderations.** Typed as `technical_hold`, `intentional_deferral`,
  `upstream_change` or `evidence_refresh`, each with the owner or policy reference
  required to revisit it. Conditions are immutable, and an intentional deferral is
  satisfied or withdrawn only by a resolution naming its recorded authority. The
  store records that reference; it does not authenticate who supplied it.
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
`application_name`, `connect_timeout`, `options` and `target_session_attrs`;
client-certificate authentication (`sslcert`, `sslkey`) is not supported yet. Use
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
- Collectors finish runs under the default READ COMMITTED isolation, so the
  derived observed count includes every committed observation of the run.
- `backup` writes to a temporary sibling directory and renames it only when
  complete, so a failed backup leaves nothing to clean up.
- `digest` prints the same per-table counts and digests for an ad hoc
  comparison.

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
  to the CLI binary SHA-256, the host platform and the isolation scope. The
  binary's build source is not proven, so its binding is labelled `unverified`.
  The assessment's policy version is the CLI API schema plus binary digest. Its
  input digest covers both observations and the host platform. Everything is
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

Listing-only records are marked `listing_only`. A listing establishes neither an
install nor a launch route, and the report adds no support, admission or
publication claim.

## Complete inventory collection

```bash
node scripts/maintenance-inventory.mts collect --cli target/release/portcove --all --issues
```

- `--all` covers every authored record committed at `HEAD`, not a sample.
  - Core is called for each port with bounded concurrency (`--concurrency`, default 4).
  - The Core source is per host platform, for example
    `core-port-capabilities-linux-x86-64`. Assessments, transitions and
    notifications use the platform-qualified subject `port:<id>@<platform>`, so
    collecting on another host never overwrites or flips another host's state.
  - The report takes each subject's latest-run status and gaps from its own
    platform's latest Core run.
  - Collectors of the same source are serialized by a transaction-scoped
    advisory lock.
  - A truncated Project field page fails the issue collection rather than
    dropping fields.
- `--issues` adds the `issues-project` source.
  - It reads the maintained, completeness-verified issue inventory with
    issue-side Project memberships (`RoadmapClient.repositoryIssues`), through a
    read-only request scope.
  - Each issue keeps its state, title, Project placement and field values, archive
    state, blockers and canonical port markers. Bodies are not stored.
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
  recorded a gap is marked "health not fresh". A port the monitor permanently
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

### Definition publication

`--publication` (with `--all`) adds the `definition-publication` source. It
compares what `main` holds with what is published.

- **Main side:** the bundle is exported from the pinned revision with
  `git archive`, so working-tree edits are never recorded. Core's maintained
  `catalog inspect-definition-publication` then inspects that copy.
  - It reports the index digest and, for each validated
    `definition:<namespace>/<stable_id>`, the revision, content-addressed
    definition target, policy revision and launch revision.
- **Published side:** one bounded HTTPS `HEAD` of `timestamp.json` at the
  appointed official metadata location.
  - The result is recorded as a site-level fact: `absent` for HTTP 404, or
    `metadata-present-unverified` for HTTP 200.
  - Per definition, the source records `not-published` only when the site is
    absent. When the site is present, each definition is `unknown` until its
    published index is read and verified.
  - Any other result, such as another status or an unreachable host, makes the
    run `failed` with a gap. The last known facts stay current, and the report
    names the failed probe.
  - Node's `fetch` does not use `HTTPS_PROXY`, so on proxy-only runners the probe
    is always a gap.
  - During a probe gap the main-side inspection is not recorded either, so a
    bundle change made during an outage appears once the site can be classified
    again. A complete run over an empty bundle is reported as observed, with no
    committed definitions.
- **Authority:** this source grants no publication authority.

On 2026-11-11, `main` held `official/chameleon-twist-jp-recompiled` revision 1
(index `fd4e8154…`). The appointed site returned HTTP 404, so the definition was
not published.

### Upstream observations

`--upstream` (with `--all`) adds the `upstream-observations` source.

- **Input:** the checkpoint recovery snapshot of the newest completed
  `configured-upstream-observer.yml` run on `main` from a natural schedule or a
  push (`producerEvents`), with a `success` or `failure` conclusion, created in
  the last 24 hours, that still retains its unexpired
  `upstream-observer-checkpoint-<config_sha256>-<run>-<attempt>` artifact. Gated
  push runs and runs whose export did not retain a snapshot are passed over.
  - It is read through the maintained GitHub client (GET-only, at most 24
    candidate runs and 32 requests) and the in-memory artifact transfer, bounded
    by the observer's eight-MiB streaming snapshot limit.
  - The configuration digest in the artifact name must equal the SHA-256 of
    `release/upstream-observer.json` at the run's head commit, which is how the
    workflow names its snapshot. The archive length and SHA-256 must match
    GitHub's recorded digest, the observer's own
    `readRecoverableObserverSnapshotArchive` decodes and validates the complete
    snapshot under that configuration, and the snapshot producer must equal the
    run identity, attempt and head commit.
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
    digests and policy bodies are never stored: Core and listing policies embed
    observation clocks, so a routine re-observation stays quiet.
- **Gaps:** a port is a fact only when every source serving it has completed
  with a policy for it. Otherwise the run is `partial` and the port is a gap:
  `held` (no observation source serves the port), `unobserved`
  (its source never completed), or `scope-changed` (its source's completion was
  reset, or does not cover the port). Gaps carry the source's exception key and
  rule. The current-scope binding includes Core's policy identity and definition
  digests, which the snapshot does not carry, so a completion that predates a
  catalog or Core change is not detected here; the observer's own scope checks
  still apply.
- **Failures:** an unavailable, unbound or invalid snapshot makes the run
  `failed` with one `unavailable` gap and no observations, so the last known
  facts stay current.
- **Report:** an "Upstream" column shows each source's facts digest and last
  change, and the latest run's gap code. "Needs attention" lists observer
  exceptions (`exception_key` set) with their rule, from the stored facts or from
  a gap. The observer's own partial-progress rules (`partialProgressRules`:
  budget, cancellation and quota stops) are routine continuation and stay quiet;
  an exception without a recorded rule stays visible. No freshness threshold or
  policy is applied beyond the observer's own.
- **Authority:** this projection grants no admission, eligibility, acquisition or
  publication authority.

On 2026-11-11, none of the 24 newest completed schedule or push `main` runs from
the previous 24 hours retained a snapshot. In scheduled runs 43058926577,
42985430786 and 42934324534 the export step failed with "Observer snapshot
records: compressed member exceeds reserved output envelope; checkpoints
retained" (a 14.4 MB controller checkpoint, 27.3 MB decoded), so a live
collection records a `failed` run until the producer retains a snapshot again.

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
  state and Project status when `--issues` was collected. "Needs attention"
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

## Changes-only digest

```bash
node scripts/maintenance-inventory.mts digest --output work/maintenance-digest/2026-11-11
```

```bash
node scripts/maintenance-inventory.mts acknowledge --digest work/maintenance-digest/2026-11-11/digest.json --receipt URL
```

- Each assessment transition after a subject's baseline creates one pending
  notification in the collection transaction. A first assessment is a baseline,
  not a change, and an unchanged observation creates nothing.
- `digest` reads only pending notifications and writes `digest.json` and
  `digest.md` (format 1). It marks nothing delivered.
  - Each entry names the subject and its previous and new state, and flags a
    return to an earlier result.
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
every guard and role boundary. It then backs up, restores to the second cluster,
verifies identical digests and confirms that guards, identity sequences and roles
work on the restored store. A separate case interrupts a migration and proves
that no partial schema remains and that resume and drift detection work.
`scripts/maintenance-inventory.test.mts` drives the read-only path through a
stub Core CLI, using the collector and report roles. It checks:

- repeated-pass convergence and A to B to A history;
- host-failure gaps (`partial` and `failed` runs with no transition);
- changes-only storage, verified membership and forged-membership refusal;
- absence recorded only by complete runs, and a single in-progress run per source;
- issue and Project joins;
- full-versus-incremental parity;
- per-call isolation and its removal, including under a symlinked `TMPDIR`;
- coverage, listing and absence facts;
- release-health, upstream-observation and hosted-intake coverage, quiet
  recurrence, needs-attention and failed reads;
- report output and HTML escaping. The
  cases need non-root PostgreSQL 16+ server binaries and are a declared
  prerequisite skip elsewhere. These are fixture results. Hosted provider, backup
  destination and unattended operation evidence belong to the later #4129
  checkpoints.
