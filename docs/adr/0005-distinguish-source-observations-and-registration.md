# Distinguish source observations, registration and the coordinated domain cutover

## Status and ownership

Accepted terminology and migration direction; **the breaking implementation is
pending** under [#1686](https://github.com/boburning/portcove/issues/1686).
[#209](https://github.com/boburning/portcove/issues/209#issuecomment-6091503248)
delivers this decision and the [glossary](../../GLOSSARY.md) independently.
This ADR changes no command, request field, schema, stored bytes, operation
authority or release commitment. Current contracts remain in [CLI](../CLI.md),
[integration authoring](../INTEGRATION-AUTHOR.md) and [architecture](../ARCHITECTURE.md).

## Context

An original game, a runnable catalog port, a release of that port and Portcove's
own application release are different objects. Operational identity remains
library identity plus catalog port ID, not a display name, artwork identifier,
filesystem path or version label.

Current `SourceRecord` is used both for committed registrations and for
inspected replacement data in `SourceRelinkPlan`. The latter's `original` is a
registration and `replacement` is planning data until Core applies the reviewed
relink. Renaming every occurrence to a registration record would preserve that
ambiguity. Discovery and inspection do not grant registration or installation
permission, and a stored record does not prove that its bytes remain present,
unchanged or compatible with every port.

## Decision

Preserve those roles at inspection, planning, persistence and return boundaries,
sharing field implementation privately when useful:

| Proposed concept             | Boundary                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SourceCandidate`            | Unregistered observed/inspected input with scoped evidence.                                                   |
| `SourceRegistrationProposal` | Internal prepared registration data only where the write boundary needs it; not a new public workflow state.  |
| `SourceRegistrationRecord`   | A registration committed by Core; no implied current health, universal compatibility or operation permission. |

The proposed relink roles are `original_source_registration` and
`replacement_source_candidate`. Inspection/discovery/import planning stays
read-only; successful import exposes `registered_source` only after commit.
A later installation failure neither erases nor invents a completed registration.
Historical codecs must preserve each old record's actual role.

The type direction is also **proposed**, not a list of available exports:

| Current name                                | Intended name                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `SupportTier`                               | `CatalogDesignation`                                                        |
| `ReleaseSource`                             | `GameReleaseProviderKind`                                                   |
| `ReleaseProvider`                           | `GameReleaseProvider`                                                       |
| `ReleaseSpec` / `DirectReleaseSpec`         | `GameReleaseSpec` / `DirectGameReleaseSpec`                                 |
| `ReleaseAsset`                              | `GameReleaseAsset`                                                          |
| `ResolvedRelease` / `ScopedResolvedRelease` | `ResolvedGameRelease` / `ScopedResolvedGameRelease`                         |
| `InstallRecord`                             | `InstallationRecord`                                                        |
| `SourceRecord`                              | The role-specific candidate, proposal or committed registration type above. |

Use explicit catalog, game-release, installation and source-role fields at the
cutover: `catalog_designation`, `game_release`, `game_release_channel`,
`active_installation`, `previous_installation`, `staged_installation`, their
applicable IDs/roots, and `game_source` / `bios_source`. Managed port installation
collections should not be named as Portcove application versions. Generic
provenance fields outside these concepts are not global rename targets.

Retain `source` as the command umbrella with registration-specific operations;
the migration owner defines the coordinated `game` and `source registration`
routes. Do not publish those proposed routes as executable current examples.
Player wording remains contextual: “Game files” and “Saved file location” can
express the task more clearly than a canonical developer type.

## One coordinated cutover, separate compatibility contracts

Core exports, CLI, Tauri requests, generated artifacts, maintained consumers,
capabilities and command generators must agree before the changed current
contract ships. Reviewable commits may form one candidate; incompatible
intermediate consumers must not be merged as a usable current contract.

At that future cutover:

- Removed commands and old-only or mixed current request fields are rejected
  at the compiled boundary before dispatch, consent or mutation, including
  nested and optional fields. A Serde rename or generated schema alone does
  not prove closed-key validation. Do not retain permanent removed-command aliases.
- Supported legacy consumers use each version's actual commands, fields and
  capabilities. Preserve documented additive-response tolerance where it
  applies; unknown consequential values must not be guessed or downgraded.
- API envelopes, operation events and durable formats are versioned separately.
  Decide each event/format change from its actual shape and semantics; a symbol
  rename or changed API envelope does not automatically require every version
  to change. Refresh version allocations against the actual cutover source.
- Before changing codecs, capture representative historical fixtures from
  identified writers with original bytes and digests/MACs. Authenticate and
  admit them under the original rules before projection, preserving the
  authenticated representation. New-serializer round trips are not historical
  proof. Retain tamper, unsupported-version and wrong identity/scope/role cases.
- A new reader uses the supported historical codec; an old reader beyond its
  compatibility fence refuses without rewriting durable state. Do not impose
  current request strictness on unrelated historical decoders or mass-rewrite
  private storage. Stale scan contracts follow their actual rescan rules.

## Saved commands, plans and interrupted work

Regenerate maintained and copied commands through the appropriate owner at
cutover. Selected Portcove-owned Steam entries use the existing reviewed
Add/Repair route, preserving unrelated artwork, names and customization.
Historical command recognition for repair inspection does not authorize
execution of a removed command or silent edits to arbitrary shortcuts.

Affected old plans require fresh review bound to the current contract, target,
fingerprint and state. Old consent must not authorize translated work. Preserve
cancellation requests versus terminal outcomes and authoritative readback.
Supported historical recovery continues only under its original phase contract
and current identity/locking rules; otherwise retain evidence and explain the
needed review. Lost output never authorizes automatic replay, and renaming
concepts does not justify a blanket refusal of every unfinished operation.

## Consequences and proof

The glossary can improve current reasoning without an API migration or a second
durable authority. The future implementation remains responsible for compiled
CLI/Tauri refusal and success, version-specific consumers, original authenticated
fixtures, independent event decisions, saved-command regeneration and scoped
native acceptance where its changes require it. [#1686](https://github.com/boburning/portcove/issues/1686)
owns its prerequisites, evidence and closure; this document supplies none of that
runtime proof and does not reopen completed discovery or qualification work.
