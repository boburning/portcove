# Upstream lineage policy and decisions — 2026-10-23

This record supplies the real continuity cases for
[#139](https://github.com/boburning/portcove/issues/139). The
[shared policy](../CATALOG.md#upstream-lineage-and-alternative-implementations)
separates stable Portcove identity, upstream continuity, accepted release identity
and acquisition locations. The decisions are stored on the existing authored
records; they grant no runtime, publication, migration or distribution authority.

## Star Fox Enhanced: unresolved candidate

**Decision: unresolved; retain the historical identity and acquisition declaration.**

The candidate contains the accepted historical source commit and its release tag,
with subsequent development on that ancestry. The bounded observations below do
not establish sufficient attributable continuity of maintainer authority for
accepting a successor or replacement acquisition location. This is not a finding
of compromise or illegitimacy.

The completed [#124 admission](https://github.com/boburning/portcove/issues/124)
and [PR #819](https://github.com/boburning/portcove/pull/819) remain credited at
their exact scope. #124 stays closed. This decision changes no runtime, source,
persistence, support or qualification declaration.

### Primary observations

These metadata and source observations were made on October 23, 2026. No release
package was downloaded or executed.

| Subject | Observation |
| --- | --- |
| Original location | The [repository endpoint](https://api.github.com/repos/kandowontu/starfox-enhanced) returned HTTP 404. This establishes observed unavailability, not deletion, retirement, compromise or a successor. |
| Candidate identity | The [candidate endpoint](https://api.github.com/repos/kandowontu2/starfox-enhanced) returned repository ID `1393981305`, owner `kandowontu2` / ID `335174380`, creation time `2026-09-29T00:03:05Z`, public visibility, and `archived: false` / `disabled: false`. |
| Historical source | [Commit `2455f8cc`](https://api.github.com/repos/kandowontu2/starfox-enhanced/commits/2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273) is present with tree `82965c571b6a2db8dc1a0fa215dde14f23c943da`. GitHub associates its author with original account `kandowontu`, ID `95717282`; the commit is unsigned. |
| Historical tag | [Tag ref `v0.0.6.7`](https://api.github.com/repos/kandowontu2/starfox-enhanced/git/ref/tags/v0.0.6.7) points to [annotated tag `a739cbf8`](https://api.github.com/repos/kandowontu2/starfox-enhanced/git/tags/a739cbf8b6d54f32c4bbc7fc5489f7632ae413ff), targeting the historical commit above. Its tagger date is `2026-09-14T02:06:52Z`; it is unsigned. This supersedes the earlier observation that the candidate tag was unavailable. |
| Historical release | The [release lookup for `v0.0.6.7`](https://api.github.com/repos/kandowontu2/starfox-enhanced/releases/tags/v0.0.6.7) returned HTTP 404. A present Git tag does not establish a present release or recover its package. |
| Subsequent ancestry | Main resolved to [`0f889bdc`](https://api.github.com/repos/kandowontu2/starfox-enhanced/commits/0f889bdc3d605cdb2cb28abb008fd9d7ea2a8f8e). The [compare summary](https://api.github.com/repos/kandowontu2/starfox-enhanced/compare/2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273...0f889bdc3d605cdb2cb28abb008fd9d7ea2a8f8e?per_page=1) reports 203 commits ahead, zero behind, and the historical commit as merge base. This is ancestry metadata, not review of all intervening commits. |
| Current account activity | GitHub reports a valid signature on that GitHub-created current commit attributed to `kandowontu2`. Its coauthor text names `kandowontu`. Current-account activity does not independently establish equivalence of the two account owners. |

Historical [credits](https://github.com/kandowontu2/starfox-enhanced/blob/2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273/CREDITS.md)
identify KandoWontU as creator. Copied attribution/history, matching names and
provider license classification do not authenticate current maintainer or
distribution authority.

A search index exposed a possible move statement at
[this `@kandowontu` post](https://x.com/kandowontu/status/2103583916003090836).
Direct retrieval returned HTTP 403 and exact searches returned inconsistent
post/thread text. Retain it as a research lead, not a verified transfer statement
or a reason to claim that no such statement exists.

### Accepted bytes and reconsideration

The historical accepted Windows package is
`StarFoxEnhanced-0.0.6.7-windows-x64.zip`, exactly `8891375` bytes, SHA-256
`e1b8569fe5712b4e2cb99effa50b8527d86311ede55f3570ae1537d414f29abe`.
A source commit, tag, rebuild, repackaged installation or later release cannot
substitute for those bytes. No current obtainability, preservation, distribution
permission, absence of holds or new runtime qualification was established here.

Reconsider when a bounded evidence set supplies attributable continuity between
the historical project authority and the candidate, and independent review
resolves relevant contradictory ownership, takeover, compromise and
license/provenance evidence. Useful evidence may include authenticated maintainer
attribution, established project channels, provider identity continuity or other
corroborated records; no single announcement format or universal checklist is
mandatory. Record acceptance or rejection of the exact proposed relationship as
a new decision, retaining this unresolved event.

Accepting continuity would still leave each release's bytes, acquisition
authority, runtime ownership, source/persistence compatibility and qualification
to their existing checks. Players' installed historical contracts cannot be
reinterpreted or moved by a lineage declaration. The authored Star Fox record
keeps its old project/release repository and all operational fields unchanged.

## Retained positive case: Paper Mario ReCut

[PR #2354](https://github.com/boburning/portcove/pull/2354), merged as
`6e952aa151213292d684d069beceba5355cfc270`, already accepted a bounded relocation.
Its [October 21 evidence](2026-10-21-paper-mario-recut-relocation.md) combines
numeric repository identity `1247923238`, retained release ID `332755572`,
tag/commit continuity and attributable verified README deprecation. Its final
independent review covers source `18ca8a7d01794137d6387ac2b72f68f06cf8f6ac`.

The imported decision preserves original `SMCGames/Paper-Mario-ReCut` and current
`SMCGames/Paper-Mario-ReCut-Deprecated` locations. The current numeric repository
ID is recorded only where observed; no historical numeric baseline is invented.
The review digest binds this transcription to the canonical port/issue/target
and facts. It is not a new reviewer signature; this PR's independent diff review
checks the transcription against the already delivered evidence.

That earlier correction changed project URL, release repository and maintenance
status. It retained `paper-mario-recut`, its issue #118, source/persistence
contracts, installed provenance and the independent `paperboat` entry.
Recommending PaperBoat did not establish succession or authorize migration.
This import adds no new artifact or runtime qualification.

## Executable boundaries and preserved behavior

The same module validates authoring records and assembled identity uniqueness,
and guards real `preparePort` changes against the accepted baseline. Its tests
exercise relocation, successor, cross-host migration, insufficient/contradictory
evidence, malformed enums, reused names, parallel implementations, duplicates,
failed transitions, append-only reversals, legacy absence and exact review scope.
The two real decisions are checked against their unchanged complete catalog and
listing projections. Preparation tests prove success/refusal without changing
accepted authored files.

Runtime preservation remains in Core's existing captured-contract implementation
and tests: `installed_versions_keep_execution_and_saves_after_catalog_contract_changes`,
`successor_staged_and_rollback_versions_keep_exact_contracts`, and
`authenticated_admission_survives_staging_rollback_activation_and_refresh` in
`crates/portcove-core/src/service.rs`. These cover retained formats 1–3, staged
versions, activation and rollback across catalog changes. They are existing
regressions, not new local execution evidence in this record. This change adds no
runtime or installed-state input, and generation remains byte-for-byte unchanged.

The observer still reports lineage as unresolved unless its own authority is
explicitly extended by its owning work. This authoring policy does not silently
turn provider metadata or health accounting into a lineage decision. #251 can
consume this shared representation; preservation, release/distribution authority,
protected delivery and proposals retain their existing owners.
