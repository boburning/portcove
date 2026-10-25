# Ready-archive rollout — October 25, 2026

This is partial delivery for Public beta / Required #2510 and rollout child
#2926. The foundation and earlier batches remain delivered. This batch starts
from `d4d93d6ef5011319f9e4cc5d0f4b5e452e47bd15`, reconciles current main
`35acf576`, and preserves the complete proposal source
`9e160ec99ddfd5b78be6762e7ab3ca05e3415ec1`. It does not close either owner or
promote a port's Project status merely because a route is cataloged.

## Three fitting Windows routes

| Identity / canonical owner               | Observed release | Setup and player-data boundary                                                                                                                                              |
| ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mstan-supermarioadvance4recomp` / #1892 | beta v0.0.3      | Explicit Play opens the upstream original-game/retail-BIOS chooser. Default saves and states follow the selected external original.                                         |
| `mstan-wariowaretwistedrecomp` / #1906   | beta v0.0.2      | Same first-Play chooser; an explicitly selected packaged variant can instead use installation-local cartridge saves. Android remains a separate upstream app/storage route. |
| `goldeneye-007-n64-pc-port` / #1129      | stable v0.5.0    | Core verifies and copies the exact NTSC-U USA big-endian original. Explicit Play lets the game generate its version-specific assets.                                        |

All three use the existing ready `staged-source-portable` contract and official
GitHub release providers with version-independent discriminating package rules.
No new adapter, engine, setup marker, helper invocation or lifecycle authority is
introduced. The 156 existing integrations remain semantically unchanged; these
three existing identities gain operational routes. Concurrent Switch intake is
preserved rather than overwritten with an older listing aggregate.

The GBA routes preserve local settings, input pointers, user `game.toml` and
installation-local `saves/` where actually selected. External originals, BIOS,
normal original-adjacent saves and custom output locations remain outside their
backup. Generated native-code caches and diagnostics remain with their producing
runtime. Packaged variants, DLLs and compiler companions remain immutable. These
two titles do not acquire a managed mod-package promise. Other GBA candidates
still need their own mod-coexistence or credential-preservation work.

GoldenEye's source identity comes from the pinned upstream README, checksum file
and converter. No alternate byte order, region, source size, BIOS requirement or
normalization is invented. The managed data declaration preserves the original,
EEPROM, settings, screenshots and all 99 upstream EEPROM-import backup names,
including data created before first Play. Generated sidecars, shader lists and
conversion staging remain version-local. The upstream importer can overwrite its
last backup slot when full, and converter failure handling is imperfect; neither
becomes a Core guarantee. Optional source/Python-tool bytecode remains an unknown
addition requiring preservation rather than an exemption for a whole tools tree.

Portcove stages compatible runtime replacements before activation and carries
current declared data. Runtime rollback does not rewind saves or promise older
reader compatibility. Existing external copies keep their files and ownership.
Listing guidance conditions managed promises on the actual Library ownership
state, including for historical self-service downloads.

## Authoring and verification

Proposal preparation now includes accepted listing-only artwork in its artwork
context. This fixes approved covers disappearing during managed adoption without
changing Core's accepted operational baseline. Separate hashes bind both contexts.
Identity, explicit refresh and observed-Gone guards remain intact. GoldenEye's new
source profile uses an explicit original-game identity to reuse its accepted
cover; Wario retains its accepted unchanged mapping. No provider image download
was needed.

Fresh complete release metadata selects exactly one Windows archive for each
route. All three independently expected publisher SHA-256 identities reconcile
with retained actual archives and source/package inventories. Three coherent
Core accepted/input/output proposal inspections passed. The accompanying JSON
binds per-ID source, artifact, data and preparation facts. Two initial proposal
refusals (invalid presentation enum and missing source presentation requirement)
and the earlier artwork-dropping output are retained; only the repaired proposal
is selected. Review caught and repaired unrelated escaped-text changes in private
shared input before applying source.

The unchanged-definition production-provider fixtures exercise all three selected
rules across controlled N→N+1 responses, cache expiry, fresh resolution and wrong
package rejection. Those successors are synthetic, not published-release claims.
Fifty local artwork/generation tests passed, including accepted-listing promotion,
changed-project/source refusal, explicit original identity, unavailable refresh,
Gone invalidation and unchanged operational authority. Initial test failures are
retained; fixture counters distinguish attempted requests from successful network
requests, and synthetic identity avoids collision with an actual accepted cover.
Final independent candidate review and exact-head required hosted checks remain
pending at this source checkpoint. No timeout or product assertion is weakened.

No game, helper, compiler or original was executed for these observations.
Archive inspection, first-party fixtures, native execution, gameplay, packaged
Desktop and real-save acceptance remain separate. #2225/#47/#48 keep independent
acceptance and #534/#246 keep publication authority.

## Remaining commitment

The 524 frozen identities, 312 original affected authored additions and 22
original roadmap-only joins remain preserved. The six original Direct-route
decisions and unresolved individual fit, maintenance and joins remain open.
After this batch is actually merged, historical extraction bookkeeping would be
149 delivered / 83 remaining of 232 moved paths, plus the separate RoadRash
proposal. Those are proposal-delivery counts, not current global port coverage or
Public beta completion. #2510 and #2926 remain open until their full substantive
acceptance is satisfied.
