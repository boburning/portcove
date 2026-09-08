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

A standalone Linux AppImage release may use a version-bearing asset filename.
When its port declares exactly one AppImage basename and no runtime subdirectory,
the installer gives the verified file that declared name before writing its
manifest. This does not apply to archives, setup executables, or ambiguous hint
lists. The original release filename, digest and size remain the artifact identity;
the installed executable path remains recorded per installation, so existing
installations and rollback retain their original paths. DKR-R retains its existing
declared runtime filename for compatibility; that filename is not a release-version
claim. Version displays and update selection use the recorded release identity.

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

Schema 2 stores new source qualification in `source_catalog.qualification`.
Each record binds the port, platform, release artifact SHA-256, upstream ref,
source contract, exact variant and representation, check-contract version,
method, time, result, and reviewed evidence IDs. Structural checks, automated
lifecycle results, hands-on observations, and known failures remain separate.
The core derives an exact claim only when the whole requested scope matches;
adding an artifact, variant, representation, platform, or check version cannot
inherit an older result. Missing or not-run evidence remains distinct from a
bounded failure and does not change source admission.

`automated_tested_platforms` and `manually_validated_platforms` are retained as
legacy historical coverage. They identify a port/platform intersection but do
not identify the artifact or source variant that was exercised. Migration keeps
those arrays visible and does not manufacture exact records from them. New
qualification belongs in the scoped collection. Never promote synthetic tests,
a clean process exit, or generated files into hands-on evidence. Qualify each
declared platform independently.

Legacy Project `Port stage = Supported` means that at least one declared
platform is present in both historical arrays. That historical claim is limited
to the port/platform intersection and does not become an unconditional claim
about every current source representation or artifact. Catalog support tier, upstream
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

Ghostship 3.0.0 writes its disposable extraction cache to `torch.hash.yml` and
rotates `logs/Ghostship.log` through `logs/Ghostship.10.log`. The catalog declares
those exact runtime outputs through the existing nonpersistent runtime-path
contract, now available to the libultraship portable adapter. Source, executable,
Portcove metadata and persistent-path overlap checks still apply. Other files in
`logs` remain subject to immutable
verification. Generated `sm64.o2r`, configuration, saves, screenshots and mods keep
their existing persistent ownership. This declaration does not grant gameplay
or platform qualification. The paths come from the tagged
[Ghostship engine](https://github.com/HarbourMasters/Ghostship/blob/deb091c29caff57dd986398087b058f16b11911e/src/port/Engine.cpp),
its pinned [logger](https://github.com/Kenix3/libultraship/blob/6b861a64d29d9fe95d100be228eb6d190231cc0d/src/ship/log/Logger.cpp),
and [Torch cache writer](https://github.com/HarbourMasters/Torch/blob/106621f0f0f9731b8739bec95227c2c5887492df/src/Companion.cpp).

The procedure below describes the current repository workflow. Future automatic
admission is owned by [#245](https://github.com/boburning/portcove/issues/245)
and [#246](https://github.com/boburning/portcove/issues/246); this policy direction
does not remove current runtime checks or activate a publisher.

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

The embedded catalog uses schema 2. It contains reusable identities, logical
variants, tagged physical representations, explicitly scoped conjunctive digest
records, per-port game and BIOS contracts, validators, exact qualification facts,
and immutable evidence
references. `scripts/migrate-catalog-schema2.mjs --check` regenerates it
deterministically from the frozen schema-1 fixture. Core owns the temporary
schema-1 compatibility projection required by the existing matcher and rejects
any conflicting projection supplied by catalog input. The deterministic
migration emits an empty exact-qualification collection while preserving the
legacy arrays because their missing artifact and source dimensions cannot be
guessed.

`catalog-schema1-fixture.json` preserves the full pre-migration document, while
`catalog-schema1-admission-baseline.json` fingerprints every source profile and
the complete port/profile/adapter binding set. Tests compare every projected
profile and port definition to that frozen input. The reviewed
Bomberman Party Edition correction records raw MODE2/2352 and cooked ISO as two
physical alternatives using the upstream contract at commit
`0aef0b66186b3f8f29d1bd9a3ba15b6307739c7b`; the compatibility projection keeps
the old matcher boundary unchanged until the shared schema-2 inspector lands.

The same migration records the reviewed versioned N64 contracts without
broadening that temporary matcher: Ghostship 2.0.0 (US and Japanese), Lighthouse
1.1.0 (US revisions 0 and 1, PAL, and Japanese), Ship of Harkinian 9.2.3,
2Ship2Harkinian 5.0.1, Zelda 64: Recompiled 1.2.2, Starship 2.0.0's selected US
revisions, and Banjo: Recompiled 1.0.2. Each contract points to its immutable
upstream commit and selects variants from the shared game identity. Transitional
`legacy_projection_only` variants preserve schema-1 matching and cannot be
selected by a schema-2 contract.

The core source inspector matches ordinary-file and cartridge-ZIP observations
against schema 2. It records original-container, original-file or archive-member,
normalized-content, and canonical N64 big-endian digests separately. Every
digest present in one identity must match; representations remain alternatives,
and multiple matching representations are an ambiguity rather than an automatic
choice. Extension-only compatibility can pass existing structural admission but
is never reported by discovery as an exact identity.

File-set representations match only when every declared member has exactly one
top-level filename match and one conjunctive digest identity. Directory
symlinks and nested or traversal-shaped ZIP entries cannot satisfy a member.
Observed member facts remain available separately from the aggregate identity.

The detailed pre-migration qualification narrative is preserved as a
[dated historical snapshot](archive/2026-09-03-catalog-qualification-history.md).

## Planned policy acceptance and evidence

Operation eligibility is independent of publisher/source trust, artifact
integrity, game-file compatibility, and evidence/health. Release channels and
Project stages are separate again. Policy-eligible untested entries remain
ordinary installable catalog entries when installation prerequisites pass.
Missing/stale gameplay reports change the evidence display, not automatically
installation or update eligibility. A known relevant failure holds only the
affected operation/artifact/platform/variant. A schema pass is not an install
test, and source-file correctness is not gameplay certification.

Reusable capabilities, templates and narrowly scoped publisher authorities are
reviewed once; deterministic checks decide routine candidates within them.

| Candidate | Planned result |
|---|---|
| Accepted upstream, ordinary new artifact, supported contract and required checks pass | Automatically available; verify its new digest. Existing selectors need no needless definition PR. |
| New definition or path/metadata correction inside accepted capabilities and authority | Automatically admit with honest evidence, including zero gameplay reports. |
| Established asset identity unexpectedly changes bytes | Hold replacement, retain pinned identity and deduplicate the exception. |
| New authority, ambiguous identity, new capability, widened access or unsupported migration | Scoped trust/engineering review; retain usable versions. |
| Missing optional input or gameplay | Not run/Unknown, not a blanket block or a fabricated pass. |
| Integrity, archive, source, executable or mandatory operation failure | Reject/hold the affected operation; untested cannot bypass it. |
| Unsupported client capability or failing platform | Isolate the affected definition/platform, retaining compatible entries. |

Source hashes, variants and relative paths may be accepted data inside a bounded
schema. Ownership reinterpretation needs explicit migration/consent semantics;
safe reusable migration templates can later be policy-authorized. Publisher
onboarding specifies actual repository/artifact authority and reauthorization
conditions, not a broad domain popularity rule. Missing published digests must
be inventoried by #245; a same-download hash does not replace today's required
independent integrity evidence. No integrity-policy change is implemented here.

Local/community definitions use the same validator, explicit namespaced origin,
conflict handling and scoped trust. Partial management may permit install/launch
while saves or updates are unavailable. Unknown persistence cannot authorize
destructive replacement, cleanup, broad backups or false recovery claims. This
future behavior is owned by [#268](https://github.com/boburning/portcove/issues/268).

Evidence collection distinguishes reusable adapter fixtures, actual artifact
lifecycle checks and voluntary attributed observations. Invalidate only facts
whose relevant inputs change; preserve historical and legacy evidence honestly.
Opt-in reports must exclude game data, secrets and personal paths; untrusted
reports cannot revoke the whole catalog. Ordinary success needs no owner action;
exceptions have bounded retries, scope and a reproducible resume condition.
