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

Archived upstreams are not rejected solely for being archived. They must still
have a useful immutable artifact, a stable direct manifest, and supportable
source and user-data boundaries. Superseded, abandoned, non-runnable, or
unverifiable projects remain ineligible.

Discovery starts as a draft item in the
[Portcove Roadmap](https://github.com/users/boburning/projects/1), with the direct
upstream URL and why it matters. Triage records platform, artifact-integrity,
source, persistence, and adapter observations. Promote the item to an issue
when it becomes actionable, high priority, materially blocked, or needs durable
evidence. A newly cataloged port does not automatically become a global V1
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
Windows checks for Gen2Recomped: Pokémon Gold, Pokémon Silver, Pokémon Crystal,
and Final Fantasy VII: Recompiled. Their catalog records therefore pair the
existing Windows automation evidence with Windows manual validation; this does
not imply qualification for any other declared platform.

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
