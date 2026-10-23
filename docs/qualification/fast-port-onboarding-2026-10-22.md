# Fast port onboarding and self-service catalog — October 22, 2026

Owning issue: [#2404](https://github.com/boburning/portcove/issues/2404).
This record covers implementation, captured intake and bounded observations. The
owning PR carries the final independent review, exact-head hosted checks and
delivery result. Client publication and protected catalog delivery remain separate.

## Delivered source behavior

Each stable identity has one authored record under
`crates/portcove-core/catalog/ports/`. Deterministic generation produces the broad
listing directory and strict operational catalog. Existing strict definitions,
shared source facts and retained installation/recovery contracts keep their
meaning. Neither generated aggregate is a parallel authoring source.

`prepare-port.mts` collects bounded facts for one requested route, prepares artwork,
and emits resumable reviewable proposals. It does not execute upstream code,
publish definitions or modify accepted sources. The same entry point prepares
explicit artwork worksets of up to 400 IDs against a larger complete catalog.

Core owns listing visibility, download decisions, private staging, fresh-folder
publication, durable pending setup and explicit selected-runtime registration.
Desktop and CLI expose the same operations. A downloaded package stays marked for
setup across restart; an installer remains a file for the user to run. Registration
uses an explicitly selected native executable, working directory and bounded
literal arguments. Relinking preserves identity and arguments. Removing the
registration or setup reminder preserves the user's files. Runtime updates, game
data generation, saves and settings remain with upstream or the user.

Existing compatible managed integrations remain preferred. A listing does not
assert installability or add runtime replacement, backup, migration or rollback
rights. Current publisher/artifact holds still apply to known retained identities.

## Captured intake coverage

The [intake record](fast-port-onboarding-intake-2026-10-22.json) retains the complete
dated join: six search pages, 548 unique search hits, 524 exact port issue records,
522 distinct authored identities and two explicit duplicate mappings. All 113
existing integration identities are preserved; 409 additional projects become
discoverable listings. Six new listings carry reviewed package/setup facts; the
other 403 additional listings retain unknown availability. There is no claim that
522 games are ready to install, playable or Supported, and individual port issues
are not closed by this coverage work.

The DKR, Yoshi's Cookie NES and Dr. Mario NES changes from concurrent main were
migrated into their authored records. Both regenerated strict catalogs were
independently compared as parsed JSON against main `886bfd1`, with complete equality
of all 113 definitions and shared facts. Main's later UI refinement `ea4dc2c` does
not change those catalog or Core/CLI inputs.

## Authoring and artwork observations

The [compact observation record](fast-port-onboarding-observations-2026-10-22.json)
retains selected IDs, source and receipt digests, Core inspection counts, provider
costs and the package file inventories.

| Actual preparation                                   | Result                                                                                                                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artwork workset of 400 IDs                           | 102 accepted mappings reused, 298 fallbacks; 1,046.883 ms scoped elapsed time                                                                                           |
| Artwork workset of 122 IDs                           | 122 fallbacks; 571.156 ms scoped elapsed time                                                                                                                           |
| Isolated Sopwith addition replay, 521 to 522 records | Exactly one added authored record, no integration change; three upstream requests, 28,936 bytes and all seven selected-release assets; 1,253.402 ms scoped elapsed time |
| Sopwith presentation correction                      | Exactly one summary-field change, no integration change; three upstream requests and complete selected-release asset enumeration                                        |

The two artwork worksets are disjoint and cover all 522 authored identities. Each
completed Core inspection of the full listing projection and preserved the strict
operational projection. Preparation did not alter the accepted source. The
addition replay uses the actual upstream project/release in an isolated source
snapshot with that one record omitted; it is not a second published addition.

Maintainer IGDB credentials were unavailable. Both batches made zero artwork
provider HTTP requests: 102 existing mappings were reused and 420 entries remained
on explicit fallback. Port identity is attempted first, followed by an attributable
original-game identity when available. Missing artwork does not hide a project,
and clients need no API key. No successful new image acquisition is claimed here.

Reported times cover preparation and provider/subprocess waiting, excluding
research, engineering, intervention, review, CI and delivery. They establish the
small data-change workflow, not a comparative speedup or a universal completion
time. The correction is presentation metadata, not a new runtime-release update.

## Real upstream package observations

A normal production-feature CLI was built from local source
`c9e57cf66dbcd3bd5142a13bce719f2881328da9`. Its SHA-256 is
`c1c33f3786a4823cc0b05d298d35af783bf6464e42acf36a1bb26bf637583a3a`.
Core and CLI source subtrees are recorded in the observation JSON so their equality
can be checked after the UI/documentation reconciliation. No qualification fixture
provider or test-only acquisition route was enabled.

| Upstream package                                                                                                                                 | Observed production behavior                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SDL Sopwith 2.9.0 Windows x64 ZIP](https://github.com/fragglet/sdl-sopwith/releases/tag/sdl-sopwith-2.9.0), release 268043256 / asset 325276947 | Downloaded 1,142,869 bytes, verified the upstream digest, safely extracted to a new user-owned child folder; 10 resulting files including the recovery receipt |
| [VCMI 1.7.5 Windows x64 installer](https://github.com/vcmi/vcmi/releases/tag/1.7.5), release 370777167 / asset 514825731                         | Downloaded 34,381,177 bytes, verified the upstream digest, retained the installer without execution or extraction alongside its recovery receipt               |

Both cases used explicit candidate/preview selection through the production CLI,
outside the complete Library root. Each durable pending record survived a new CLI
process. Forgetting its exact setup reminder removed that record and preserved
every downloaded/extracted file byte, confirmed by the retained file hashes.

The first VCMI harness assertion incorrectly expected the installer to be the only
file. Production acquisition had succeeded and also wrote its intentional
`.portcove-download.json` recovery receipt. The original failed harness report was
retained. The corrected check required exactly the installer and a matching receipt;
only the remaining restart/forget checks resumed. No product change or repeated
download was needed.

These observations ran on Linux. They do not establish Windows game or installer
execution, original-game data preparation, gameplay, save/load or device acceptance.
Native registration/relink/removal preservation is separately covered by the
existing focused production CLI contracts with a small native fixture.

## Focused contract evidence

The owning PR records the final hosted Windows and frontend results. Local feedback
established these affected contracts before publication:

- Authoring/generation/staged catalog suite: 140 passed; final artwork batch delta:
  14 preparation tests passed. These overlapping runs are not summed.
- Repaired Core self-service, migration, retained artwork and workspace selection:
  26 passed, nextest run `f7c88366-4ff0-4f9f-a749-70e71baaf665`.
- Production CLI selected-runtime contracts: two passed, nextest run
  `ce6fb924-6979-4b26-aa5b-5593f4038d04`.
- Incoming DKR/source/authority and artifact-policy interaction selection:
  18 passed at `c9e57cf`, nextest run
  `a05ee2c5-20db-4d28-980a-408971d0a643`.
- Generated Core/CLI/Tauri transport inspection, whole frontend type checking,
  and focused real-browser interaction tests passed before the final UI merge;
  its affected interaction rerun is recorded on the owning PR.

The initial Core run retained ten fixture timeouts caused by repeatedly copying
and hashing a roughly 480 MB debug test executable. Reusing the repository's small
native fixture removed that setup cost while preserving all assertions and product
deadlines; the affected tests then passed. Failure records and recovery sentinels
were retained. No skipped or synthetic observation is promoted to title acceptance.

## Remaining delivery boundaries

The completed upstream-first reset and the amended scopes of #254 and #1742 remain
complete. Broader rollout stays with #1422. Publication through the existing client
release path remains necessary for users to receive this feature. Protected
data-only delivery to an unchanged capable client remains with #246/#534; neither
repository merge nor this addition/correction replay satisfies that later outcome.

GitHub Projects transport was unavailable during this work. The intake join and
owning issue are not substitutes for live Project fields, and no final Roadmap
doctor success is claimed.
