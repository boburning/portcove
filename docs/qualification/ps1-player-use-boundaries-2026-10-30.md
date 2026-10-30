# Three PS1 player/use boundaries — October 30, 2026

This bounded [#2926](https://github.com/boburning/portcove/issues/2926) batch
reviews existing frozen members [ReChan #348](https://github.com/boburning/portcove/issues/348),
[Rage Racer #349](https://github.com/boburning/portcove/issues/349) and
[X-Men: Mutant Academy 2 #356](https://github.com/boburning/portcove/issues/356).
All three belong to original 524 and the overlapping #1422 subset; #554 remains
an alias of canonical #356. No new identity or population is introduced.

The shared cause is making existing Core player/download operations agree with
attributable current use, preparation and runtime-replacement facts. One useful
upstream-owned prepared-player route fits; two selected acquisition conditions
remain unresolved. Neither a generic family implementation nor a new engine,
extractor, updater or wrapper is needed. The 272 strict definitions, source
contracts and accepted artwork remain unchanged. Full #2510/#2926/#1422
acceptance remains open.

## Source and historical evidence

The [dated source packet](ps1-player-use-boundaries-2026-10-30.json) records
50 distinct repository/commit/path/blob bindings and four complete pinned trees.
Decoded bytes were independently checked against Git blob identity and SHA-256;
raw tree response hashes and nontruncation/entry totals were verified. Repeated
content across selected revisions is not counted as unique content or accepted
operations. Release/tag/publisher metadata are observations, not acquired-byte,
permission, source-to-binary or gameplay qualification.

| Owner       | Exact inspected source                                                                                                 | Selected decision                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ReChan #348 | Current `ecd39935559d024992b2049576ea0ecc3b204b8c`; official v1.0.1 tag `0e8f26a5ce9c00108867b1cbf63a001198b0b8d0`     | MIT project code; original/media/component rights remain separate. Versioned prepared-copy handoff fits existing registration.                                                                   |
| Rage #349   | Current `e05387dce87164a9aec9df76c2624ee2727da067`; latest 0.6.13-alpha tag `e6b6de9a157094848074c8979c32a33a4f980c2a` | Both inspected LICENSE.md files expressly leave project-authored source under default author copyright without a selected project license. Selected release/package grant remains unestablished. |
| X-Men #356  | Current/latest v1.1 `fccfbd2f7a6db28900402b26a911187e5e349b95`                                                         | Exact package/media permission remains unresolved; missing root LICENSE alone is not a prohibition.                                                                                              |

The September 13 artifact receipts remain credited only for their recorded
versions: ReChan v1.0.1, Rage 0.6.5-alpha and X-Men v1.1. Their matching published
digests and safe ZIP inspection did not establish source/use permission,
current executable/setup/persistence behavior, actual lifecycle or gameplay.
No previous failure, actual observation or qualification is erased or expanded.

## ReChan: official completed-copy handoff

Both selected source revisions have the same MIT project LICENSE and README.
The project expressly requires an owned NTSC-U Jackie Chan Stuntmaster disc,
serial **SLUS-00684**, and separates original assets from newly authored support
files and third-party components. This is a code/source declaration, not blanket
certification of arbitrary current or historical package contents.

Latest official v1.0.1 `rechan-win64.zip` remains asset 482233888, 7,908,907 bytes,
publisher SHA-256
`b8cd8ebf2d3b38469e809cf51bf0e50b77a963b3e8d4a6c21d24e68a19e2a026`.
This agrees with the prior integrity receipt; no package was downloaded in this
batch. The selected Windows x86-64 product is completed `rechan.exe`, with
**zero arguments**. Upstream/player completes permitted preparation outside
Portcove before registration; no source build is newly required when an already
prepared permitted official copy is available.

Use one own BIN or ISO in upstream `discimage/`; the built-in first-launch
extractor checks `SYSTEM.CNF` for SLUS-00684. It is not an independently accepted
full-image digest or a generic CUE/CHD, PAL, BIOS or PSXRecomp source contract.
The game does not emulate PS1 hardware. Preserve the original even where
upstream says the disc image folder may be removed after extraction.

Set an **explicit actual prepared runtime-root CWD** containing shipped `pc/`
support and the extracted original roots. Official v1.0.1 has no executable-folder
fallback. Current source first accepts `pc/` in the working directory and only
otherwise switches to executable-parent `pc/`. This newer fallback must not be
backdated onto the official package. Preserve a correctly working custom data
CWD; registration does not relocate or change its profile. Export, verification,
autotest and crash-report test flags are outside ordinary zero-argument Play.

Preserve the entire creating runtime and original, including shipped `pc/`,
extracted `fe`, `rchars`, `rtarget`, `scr`, `sound`, `tim`, `xc`, root
`license.tim`, `license_data.dat`, `loadanim.con`, `postdemo.tim`, `predemo.tim`,
`runfirst.tim` and every other extracted/custom file. Both source revisions use
`userfiles/jcsSAVE*.sav`, `userfiles/jcsAUTOSAVE.sav`, `userfiles/game.ini` and
`~mods`/`mods.ini`/exported assets. Matching names and source structs do not
establish save/mod compatibility; retain each creating copy separately.
Preserve logs and `minidumps` when present. Current source retains rare
`LOG_ALWAYS` events even in release configurations; README's broader statement
that release logging is compiled out is not used to discard those files.

### One runtime-replacement owner

The desktop source enables its upstream self-updater. `InstallAndRelaunch`
writes an updater script, replaces executable-directory files using upstream's
archive extraction, schedules delayed replacement/relaunch and requests the
current game end. The inspected Windows script delays for three seconds; it does
not positively wait for the original process to exit. That is
a concrete conflict with simultaneously promising Core-owned immutable
replacement. It supports a non-owning existing-player route without requiring
Portcove to repair the engine or suppress its useful updater.

Ordinary main-loop/shutdown source joins extractor/updater worker threads, but
updater successor processes are outside Core's selected-child observation.
Explicit registration/consent/relink/restart/Play and metadata-only preserving
removal are offered through existing Core. No exclusive full-process-family,
network sandbox, upstream-update safety, source/build authentication or managed
Install/Update/Backup/Rollback/migration/deletion is promised. Let upstream finish
its operation and close all actual players before changing or relinking the
copy. Retain upstream-owned external update/recovery evidence separately.

## Rage: exact grant condition remains

Current and latest-tag LICENSE.md explicitly identify a source-only public-review
tree with no selected open-source license and default copyright for its authors.
This is a concrete applicable grant gap, not a conclusion drawn merely from
missing optional metadata. Current latest 0.6.13-alpha Windows player metadata
names asset 690245237, 2,517,410 bytes, publisher SHA-256
`059e87c4cf1b841e990314bb9c7c6fded8e7a64e955419c22511871d7f136fea`.
The much larger editor is a different product. Neither the new publisher digest
nor old 0.6.5 integrity establishes use/distribution permission for a selected
source or package. No payload was acquired or executed.

The authored condition refuses new Portcove acquisition before provider options,
preview or download. Research/discovery and independently lawful existing copies
retain their ownership. Resume on an attributable applicable grant for the exact
selected release/package and supported original/executable/data handoff; do not
silently relabel old bytes or infer a grant from public hosting. #349 stays open.
This is no new permanent product deferral or removal from Required umbrella work.

## X-Men: package and original-derived media remain separate

Latest v1.1 `XMenMA2-portable.zip` is the same selected asset described by its
retained September 13 receipt: 195,403,142 bytes, publisher SHA-256
`547ac5204095dd546234d2e4fc4b9ce29c3fde41ec15dabaa3e5f6e30313747f`.
Its release explicitly bundles 1,434 original-derived upscaled textures and a
splash; pinned `port/README.md` describes extraction/upscaling from the original
disc and `package.sh` stages the pack. The source tree's exclusion of disc,
generated code and texture pack does not clear the distributed package's grant.
The project/code/runtime grant also remains unestablished in the inspected
complete source bindings; an unpinned external runtime reference cannot grant
whole-port permission. Missing LICENSE alone is not called illegal.

Refuse the selected unresolved package acquisition through the existing guard.
Resume on exact attributable permitted or asset-clean package evidence, or a
separately reviewed lawful owned-input alternative with actual supported launch
and write coordinates. Preserve optional media versus required player input,
SLUS-01382 identity, old artifact qualification and #554 canonical alias. No
payload acquisition/execution, new permanent deferral or issue closure follows.

## Validation and remaining acceptance

Maintained per-record preparation completed with unchanged operational projection.
Accepted artwork/lineage are preserved and derived listings are generated.
One actual-ID inert native-probe case binds ReChan to existing consent,
stale-intent/relink/restart, retained listing, selected-process Play and preserving
metadata-removal behavior, with no invented acquisition hold. A two-ID case
binds Rage/X-Men to zero provider requests, no destination publication and no
pending setup when their authored conditions apply. Shared implementation is
reused; no production Core lifecycle behavior is added.

Final separate complete-diff review, exact-head hosted execution inventories,
guarded merge/tree readback and canonical disposition belong to the delivery
PR/owners. Source tests and inert probes do not qualify actual games, originals,
full-image authenticity, game builds, gameplay/save/load/mod compatibility,
installed apps, other platforms or protected delivery. No upstream package,
ROM/disc, game/helper/compiler/installer was acquired or executed in this batch.
Those observations remain Not run/Not evaluated. All other fitting rollout,
retained transitions, retail evidence and integrity holds retain their owners.
