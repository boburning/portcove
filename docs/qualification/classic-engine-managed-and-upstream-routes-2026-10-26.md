# Classic-engine managed and upstream routes — October 26, 2026

This six-port batch continues #2926 and Public beta / Required parent #2510
from main `5b6a003aec3e23abec8640296c0278c375835c65`. It uses the existing
native-portable lifecycle and generic downloaded/external setup; no new engine,
installer, registry or game-specific Rust/React implementation is introduced.
The [source-bound packet](classic-engine-managed-and-upstream-routes-2026-10-26.json)
retains exact sources, artifacts, ownership, preparation, hashes and unfinished work.

| Identity / canonical owner            | Selected Windows route                                                                                            | Ownership and remaining boundary                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nicholas-ochoa-opensc2k` / #1858     | Add managed OpenSC2K Windows x64 portable ZIP; upstream first Play imports SimCity 2000 Special Edition files.    | Portcove replaces runtime and preserves only executable-relative `data/`. Keep originals for future upstream pack re-import. Temporary autosaves, custom paths, Godot logs/profile and original installation remain external.            |
| `andyvand-opentyrian2000` / #1861     | Recommend the MinGW x64 ZIP with its included data folder and `opentyrian2000.exe`.                               | Player/upstream owns this copy. Computed SHA is not independent authentication; managed artifact/writer fit remains unfinished.                                                                                                          |
| `lostartefacts-trx` / #1898           | Recommend the official combined Windows installer, select corresponding originals there, then register `TRX.exe`. | Preserve full I–III setup. Portable manual input placement and mixed version-owned game/config trees lack a reviewed managed contract; that adoption remains unfinished.                                                                 |
| `opencommunityedition-opence` / #1849 | Recommend Windows release ZIP, then first-Play Xbox ISO/XISO selection.                                           | Preserve OpenCE’s own self-replacing updater. Maps/settings/default or custom saves remain player/upstream-owned; generic managed replacement would conflict with that owner.                                                            |
| `sdlpal-sdlpal` / #1878               | Put the Windows MinGW player in a separate working copy of original game data; register that same working folder. | Keep `.rpg` and `sdlpal.cfg` there. A cfg-only managed proposal was rejected after independent reviewers established first-session/restart save-coordinate divergence. A stable supported coordinate remains required before management. |
| `cannonball-outrun` / #120            | Retain the existing fresh-acquisition hold; offer a permitted existing installation.                              | No held payload acquired. The source has explicit non-commercial license conditions; accepted package-integrity, ROM-set and grant applicability remain with the existing Blocked owner.                                                 |

OpenSC2K's historical and current repository endpoints resolve to opaque repository
ID `120053075`. The separately reviewed [relocation decision](https://github.com/boburning/portcove/issues/1858#issuecomment-6408463469)
retains the stable ID, canonical issue, name and exact accepted SimCity 2000 artwork.
The current Godot/Rust implementation is assessed separately from historical code;
no old runtime ABI or save compatibility is inferred. The authoring tool reused
that accepted original-game artwork through explicit reviewed game identity.

Both authenticated v0.2.0 and v0.3.0 portable Windows archives have one AMD64
player and an adjacent empty `data/` marker; their source rebases portable data
references. The current source writer audit separates ordinary settings, imported
packs, cities, scenarios, scripts, SCURK and recorded audio from external/custom
locations. Its update action opens a release URL rather than replacing itself.
MIT project, six separately licensed SIL OFL font families and packaged
LGPL/MIT/Apache/0BSD notices were reviewed. Original commercial game files are
not bundled. Runtime rollback carries current declared data; it does not rewind
cities or guarantee that an older runtime can read them. Existing external
copies keep their files, profiles and ownership.

The SDLPAL finding is source-bound, not missing optional gameplay evidence:
[`PAL_LoadConfig`](https://github.com/sdlpal/sdlpal/blob/366bc366cbfa0b34c66b0c19171ab05d1643adfd/palcfg.c#L562)
initializes SavePath before the Windows dialog changes only GamePath. First-session
saves therefore use the original working directory; the next launch may instead
use GamePath because default `./` SavePath is omitted from the saved configuration.
The guide keeps both coordinates at the same working copy. A separate runtime
needs an explicit absolute SavePath before the first session. Widening backup
wording would not fix an incomplete persistence contract. No upstream executable
was run, and this is not a claim that every possible managed contract is unsupported.

Complete release pagination and recursive pinned source trees cover all six
identities; five actual ZIPs were inspected without executing a game or helper.
TRX exceeded original private download/raw ZIP budgets: both refusals are retained,
then a deliberate 512 MiB compressed / 2 GiB expanded bounded inspection succeeded.
Entry-count, central-directory and metadata-string bounds remained intact. No
product extraction limit changed. The actual TRX installer was not run; its
handoff uses pinned official installer documentation and release metadata.

Maintained per-ID preparation, the current Core authoring inspector for the
managed addition, and regenerated outputs validate this candidate. The independent
compatibility additions fixture adds exactly OpenSC2K; frozen legacy definitions,
source identities and qualification are retained. Required exact-head selected
CI, final non-writing review and guarded remote delivery are recorded on the PR
and canonical owners. Native gameplay, physical input, real-save acceptance,
packaged Desktop and whole-Public-beta acceptance are not established here.

All original 524 identities, 312 affected authored additions and 22 roadmap joins
remain in scope. These six were reconciled against current main before authoring;
this dated packet is not a new live backlog, global remaining count, completed
all-port inventory or new product deferral. #2510 and #2926 remain open, and
#1422's frozen cohort and #2225/#47/#48/#534/#246 keep their independent scope.
