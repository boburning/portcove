# Conker and Body Harvest installation routes — October 26, 2026

Source-bound assessment from `522cf9cf0e6e872a07fc873073ae1e8a3d172cb7`, after
PR #3730. [Companion evidence](conker-bodyharvest-installation-routes-2026-10-26.json)
records complete release pagination, opaque repository identities, expected API
artifact identities and separate selected-tag/current-source pins. This is dated
evidence for #2510/#2926, not a live registry or completed all-port rollout.

| Existing identity / canonical owner                                                   | Selected route and platform boundary                                                                                                                                              | Precise remaining condition                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body Harvest / [#1448](https://github.com/boburning/portcove/issues/1448)             | Permitted complete Windows/Linux x64 player; own North American ROM selected on first explicit Play. macOS bundles, Flatpak and Linux ARM64 retain separate upstream preparation. | Linked RecompFrontend grant remains unestablished. Native archive shape/API hash does not settle permission or lifecycle fit.                                                                     |
| sciaschi CBFD-Recompiled / [#1216](https://github.com/boburning/portcove/issues/1216) | Permitted Windows/Linux player; own USA ROM selected by upstream. Separate Apple Silicon/macOS 15+ bundle.                                                                        | Same exact frontend dependency grant; parent MIT/GPL and licensed nested libraries do not establish it. Mods.zip is not a runtime.                                                                |
| Conker64 / [#123](https://github.com/boburning/portcove/issues/123)                   | Preserve source/prototype discovery and already registered permitted development copies.                                                                                          | Existing useful-output hold remains: same scene-only Windows ZIP, no recompiled game execution or packaged extraction tools. Reconsider a useful player or separately evidenced useful operation. |
| ConkerBFDReloaded / [#1806](https://github.com/boburning/portcove/issues/1806)        | Distinct permitted Windows/Linux player; own USA ROM selected by upstream; explicit Linux `--rom` fallback when needed.                                                           | Package recipe expressly notes the missing frontend license. Optional texture packs and upstream WSL observations do not establish a new runtime or Portcove native acceptance.                   |

## Setup and preservation

The three released players provide their own original-file selection. Registration
records launch intent; only explicit Play starts the player. No compiler, installer
or discovered helper is needed for these existing complete copies. Keep companions
and the actual working folder together. Reloaded's Linux fallback uses two launch
arguments on separate lines (`--rom`, then the absolute path without shell quotes),
matching Desktop's maintained argument editor. It remains deliberate Play.

Body Harvest normally uses its `BodyHarvestRecompiled` profile, sciaschi uses
`ConkerRecompiled`, and Reloaded uses `ConkerBFDReloaded`. Keep complete actual
profiles and working copies, including stored originals, saves, settings, mods,
achievements/save states where present and Reloaded's `Photos` and generated
`key_prompts`. Custom/test/portable roots can differ. These are external files;
Portcove gains no replacement, backup, rollback, restoration or deletion rights.
No save conversion between the distinct Conker implementations is promised.

The pinned frontend uses `HOME/.config` on native Linux, without consulting
`XDG_CONFIG_HOME`; preserve any actual `APP_FOLDER_PATH` or portable location.
Windows/native-Linux portable detection uses the working folder, while macOS
checks beside its app bundle. Body Harvest Flatpak also changes cwd to its writable
app data area: preserve the complete
`~/.var/app/io.github.bodyharvestrecomp.bodyharvestrecomp` alongside the actual
profile. A README's broad portable description is not a replacement for this
source-bound distinction. Linux ARM64 package metadata does not create a Core host
platform enum; Mac bundle claims are separate from inspected native executables.

## Evidence and fit limits

- [Body Harvest v1.0.0 source](https://github.com/mcsoderh/BodyHarvestRecomp/tree/e90747cd09fd732340443c73ed0657eb9bee0fdf): README, launcher, namespace header, dependency pin, packaging and Flatpak manifest.
- [sciaschi V0.1.6 source](https://github.com/sciaschi/CBFD-Recompiled/tree/85d8c3bc617e2d8311f5f978b832006797bc8ac7): release recipe/notices, launcher, actual profile resolver, original-input and save-state code. Current source is recorded separately.
- [Conker64 current status](https://github.com/Conker64Recomp/conker64-recompiled/blob/0a9dbbf409accdcc0bebd676455de4f5a192f7e5/README.md): explicitly missing game execution. The only release still resolves to `6e58a2a6ff5501cfa9a4380b8522d5a1119d4839`, with the same expected digest/size recorded in the earlier canonical archive assessment. No new package download or separate useful tool is inferred.
- [Reloaded v1.4.6 source](https://github.com/DahSidiAbdallah/ConkerBFDReloaded/tree/d8ea30f220d7c1464997e6cdd013c16b204f81d8): setup scripts pin the frontend; package recipe names its missing license; source places photos/prompts in the actual profile. Retain sciaschi attribution and distinct identity.
- [Pinned RecompFrontend](https://github.com/N64Recomp/RecompFrontend/tree/b1a1477c6556aeb7ed45defbfb5924f721efebc1): complete source tree and linked profile code reviewed. Nested library grants do not settle separately authored frontend permission. Reconsider fresh acquisition with an attributable compatible grant or a released replacement, then complete applicable component/package and operation validation.

No new game package, original ROM, game, compiler, helper or installer was acquired
or executed. Maintained per-ID preparation, combined Core listing validation,
generation, separate review and hosted exact-head checks cover this metadata
candidate; the PR owns its actual delivery evidence. There is no new managed
integration, empty persistence declaration, Core/UI engine or alternate registry.
All 167 operational definitions, 1,424 authored identities and existing
artwork/lineage are retained.

The previous complete identity refresh at 2026-10-26T20:51:12.867Z accounted for
1,510 distinct identities (1,424 authored, 86 roadmap-only); these four existing
IDs change no membership. It is not a new global retrieval or all-fit count.
Original 524/312/22 cohorts, six unfinished Direct/legacy decisions
(#152/#164/#165/#113/#154/#1113), explicit deferrals and independent canonical
owners remain preserved. #2510/#2926 remain open with full Public beta acceptance
false. #1422's historical cohort, #2225 recovery, #47 packaged Desktop, #48
real-save and #534/#246 publication retain their independent acceptance.
