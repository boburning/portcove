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

Every declared platform must provide at least one executable hint. A hint is an
ASCII safe relative path under the declared runtime root; a basename remains a
legacy shorthand only when it identifies exactly one file. Ordered alternatives
do not make an ambiguous basename acceptable. Catalog validation rejects
missing platform entries, duplicate hints, traversal, cross-platform filename
aliases, and macOS bundle directories in place of the executable inside the
bundle.

Hosted GitHub and GitLab providers inspect repository metadata before every
resolution, including reuse of a five-minute in-memory release selection, and
reject resolution when the host reports the repository as archived. A
conditional `304 Not Modified` reuses only the last semantically valid metadata
body. If repository-state revalidation cannot reach the host, resolution fails
with that network error instead of treating the cached release as either
supported or withdrawn.

The hosting service's archive flag is not the same as Portcove's catalog
`Retired` status. A `Retired` entry cannot use a hosted provider; current
catalog validation permits it only through a manually reviewed
`DirectManifest` containing exactly one stable artifact for every declared
platform, each with an HTTPS URL, nonzero size, version, and SHA-256 digest.
`Superseded` and `Abandoned` entries are rejected. Active projects may also use
direct manifests when their immutable artifacts satisfy the same contract.

Future work to harden approval, withdrawal, cache, rollback, or signing
governance for retired-project manifests is tracked in
[issue #233](https://github.com/boburning/portcove/issues/233). That optional
work does not grant catalog eligibility and is not an Alpha 1 or V1
requirement. Current catalog admission and all ordinary source, archive,
executable, install, and rollback checks remain authoritative.

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

Project `Port stage = Supported` means that at least one declared platform is
present in both arrays. The support claim is limited to that exact intersection;
other declared platforms may remain unqualified. Catalog support tier, upstream
release channel, upstream status, catalog admission, source-contract coverage,
Project Status, and Port stage are independent. In particular, a stable support
tier, successful download, or catalog entry does not itself mean Supported.

On 2026-09-04, the repository owner reported completing the defined hands-on
Windows checks for every catalog port whose Windows automation was complete and
whose only remaining gate was manual qualification. Those entries therefore
pair their Windows automation evidence with Windows manual validation. Catalog
entries with source, release, upstream, or native-platform blockers remain
unqualified. This attestation does not imply qualification for any other
declared platform.

Yu-Gi-Oh! Forbidden Memories v0.5.3 and Revelations: Persona v0.1.1 have exact
upstream Track 01 contracts and completed clean Windows managed builds,
post-build manifest verification, registered-source rechecks, and responsive
named-launcher checks from matching RomM CHDs. Removal and clean reinstallation
also restored their generated input configuration byte-for-byte. Their
`input.ini` files are persistent user configuration and
`psx_last_run_report.json` is reviewed disposable runtime output. Neither entry
claims automated or hands-on qualification until update, rollback, controls,
gameplay, and real save/load evidence is complete.

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
