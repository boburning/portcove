# Catalog policy

`crates/portcove-core/catalog/catalog.json` is the machine-readable authority
for actual ports, platforms, upstream sources, release channels, adapters,
source contracts, and qualification evidence. The catalog grows continuously
and independently of Portcove's product release stages. Durable prose must not
copy its current count or maintain a second title list.

## Continuous admission

A candidate is eligible only when Portcove can represent it without weakening
the architecture or trust model. Admission requires:

- a direct and attributable upstream;
- a useful native release for each declared platform;
- immutable artifact identity through a published digest, verified checksum
  sidecar, or a narrowly reviewed retired-project manifest;
- an exact, lawful local-source contract when upstream code needs game data;
- deterministic executable, setup, persistence, and update boundaries;
- a reusable existing adapter or a justified family-level adapter owned by
  `portcove-core`; and
- honest automated and manual qualification fields.

The currently enforced policy rejects archived upstream repositories. A
dedicated Alpha 1 security issue owns the proposed narrower retired-project
rule: no dynamic archived-upstream resolution, with support possible only after
code, validation, and policy agree on a manually maintained direct manifest
that pins every allowed artifact by SHA-256. Until that issue is complete,
archived, superseded, abandoned, non-runnable, or unverifiable projects remain
ineligible.

Discovery creates one durable issue immediately for every independently
catalogable or independently prioritizable port, with the direct upstream URL,
title identity, a durable game/target key for non-catalog candidates, neutral
Inbox/Watchlist fields, and an explicit statement that research intake does not
grant support. The key identifies the independently prioritizable game or
target, not merely a shared upstream repository. Project drafts are only for
fleeting non-port ideas. Triage records platform, artifact-integrity, source,
persistence, adapter, blocker, and resume-condition evidence. A newly cataloged
port does not automatically become a global V1
blocker.

## Channels, support, and qualification

Stable, beta, and rolling are user-selected release channels, not qualification
claims. A catalog entry may be beta, rolling, platform-limited,
qualification-pending, or blocked while the application continues toward V1,
provided the UI and documentation represent that state honestly.

`automated_tested_platforms` records deterministic evidence for the exact
port/platform contract. `manually_validated_platforms` records hands-on
gameplay, graphics, audio, controller, save/load, and platform behavior. Never
promote synthetic tests, a clean process exit, or generated files into manual
evidence. Qualify each declared platform independently.

On 2026-09-04, the repository owner reported completing the defined hands-on
Windows checks for every catalog port whose Windows automation was complete and
whose only remaining gate was manual qualification. All 57 catalog entries with
Windows automation evidence therefore also carry Windows manual validation. The
other eight catalog entries remain unqualified because they have source,
release, upstream, or native-platform blockers. This attestation does not imply
qualification for any other declared platform.

## Adding or changing a port

1. Capture or update the roadmap item and direct upstream evidence.
2. Search the catalog and core adapters before adding behavior.
3. Add declarative metadata and the narrowest reusable adapter contract.
4. Run catalog validation, release-resolution tests, source/profile tests,
   lifecycle tests, and the relevant platform checks.
5. Record only the qualification evidence that actually passed.
6. Link the pull request to its issue and update Project status.

Catalog changes must preserve source identity, checksums, bounded archive
extraction, symlink refusal, persistent-data ownership, per-port locking,
atomic activation, rollback, credential boundaries, and executable trust. See
[ARCHITECTURE.md](ARCHITECTURE.md) and [PROJECT-GOVERNANCE.md](PROJECT-GOVERNANCE.md).

The detailed pre-migration qualification narrative is preserved as a
[dated historical snapshot](archive/2026-09-03-catalog-qualification-history.md).
