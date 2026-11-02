# Native engine managed adoption — November 2, 2026

This packet binds nine existing affected-312 identities to the existing Windows
`native-portable` mechanism. It adds no engine, builder, source authenticator or
runtime authority. A fresh managed copy owns replacement of its official package
and preservation of its explicitly declared local inputs. Existing external
registrations retain their creating contracts, literal arguments, original files,
profiles and user/upstream runtime owner. They are not automatically adopted.

All five official archives matched the expected SHA-256 published by GitHub.
Bounded physical ZIP inspection preceded logical parsing; complete member names
and selected executable/DLL CRC, SHA-256 and PE headers were inspected without
extracting or running upstream code. The [per-title packet](native-engine-managed-adoption-2026-11-02.json)
records exact tags, source commits, archive hashes, working coordinates and limits.
The [observed metadata/layout fixture](../../crates/portcove-core/src/testdata/native-engine-adoption-2026-11-02.json)
retains every selected release asset and immutable package member name. Test
member bytes, originals, successor releases and refusal mutations are synthetic.

## Per-port review

Every row has its own existing-registration case, new lifecycle case
`native_engine_adoption_<issue>` and provider case `native_engine_selection_<issue>`.
These exercise Core with inert fixtures. They do not run these games or supply
originals, first-setup, gameplay, save compatibility or protected acceptance.
Required check results and delivery/completion evidence belong on the PR and
canonical owner; declaring a case here does not assert it has passed.

| Canonical port / issue                                                                                                                                                                                                                                                                            | Actual route and authored change                                                                                                                                                                                                                                 | Evidence and per-title validation                                                                                                    | Remaining limitation / hold                                                                                                                                                                          | Full finite outcome after delivery                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [Doom 3 / dhewm3 #2567](https://github.com/boburning/portcove/issues/2567) / [`doom-3-classic-dhewm3`](../../crates/portcove-core/catalog/ports/doom-3-classic-dhewm3.json)                                                                                                                       | stable official package; `dhewm3.exe`; preserve `base/pak000.pk4`, `base/pak001.pk4`, `base/pak002.pk4`, `base/pak003.pk4`, `base/pak004.pk4`, `base/pak005.pk4`, `base/pak006.pk4`, `base/pak007.pk4`, `base/pak008.pk4`.                                       | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external dhewm3 profile; populated saves/gameplay unqualified.                                                                                                                | Eligible only after whole-boundary final review and required checks. |
| [Resurrection of Evil / dhewm3 #2568](https://github.com/boburning/portcove/issues/2568) / [`doom-3-resurrection-of-evil-classic-dhewm3`](../../crates/portcove-core/catalog/ports/doom-3-resurrection-of-evil-classic-dhewm3.json)                                                               | stable official package; `dhewm3.exe`; preserve `base/pak000.pk4`, `base/pak001.pk4`, `base/pak002.pk4`, `base/pak003.pk4`, `base/pak004.pk4`, `base/pak005.pk4`, `base/pak006.pk4`, `base/pak007.pk4`, `base/pak008.pk4`, `d3xp/pak000.pk4`, `d3xp/pak001.pk4`. | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external dhewm3 profile; populated saves/gameplay unqualified.                                                                                                                | Eligible only after whole-boundary final review and required checks. |
| [Doom 3 / DUDE #2565](https://github.com/boburning/portcove/issues/2565) / [`doom-3-classic-dude-doom-3-unified-development-engine`](../../crates/portcove-core/catalog/ports/doom-3-classic-dude-doom-3-unified-development-engine.json)                                                         | stable official package; `dude.exe`; preserve `base/pak000.pk4`, `base/pak001.pk4`, `base/pak002.pk4`, `base/pak003.pk4`, `base/pak004.pk4`, `base/pak005.pk4`, `base/pak006.pk4`, `base/pak007.pk4`, `base/pak008.pk4`.                                         | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external dude profile; populated saves/gameplay unqualified. First Play can copy dhewm3 profile.                                                                              | Eligible only after whole-boundary final review and required checks. |
| [Resurrection of Evil / DUDE #2566](https://github.com/boburning/portcove/issues/2566) / [`doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine`](../../crates/portcove-core/catalog/ports/doom-3-resurrection-of-evil-classic-dude-doom-3-unified-development-engine.json) | stable official package; `dude.exe`; preserve `base/pak000.pk4`, `base/pak001.pk4`, `base/pak002.pk4`, `base/pak003.pk4`, `base/pak004.pk4`, `base/pak005.pk4`, `base/pak006.pk4`, `base/pak007.pk4`, `base/pak008.pk4`, `d3xp/pak000.pk4`, `d3xp/pak001.pk4`.   | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external dude profile; populated saves/gameplay unqualified. First Play can copy dhewm3 profile.                                                                              | Eligible only after whole-boundary final review and required checks. |
| [Allied Assault #2592](https://github.com/boburning/portcove/issues/2592) / [`medal-of-honor-allied-assault-openmohaa`](../../crates/portcove-core/catalog/ports/medal-of-honor-allied-assault-openmohaa.json)                                                                                    | stable official package; `launch_openmohaa_base.exe`; preserve `main`.                                                                                                                                                                                           | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external Roaming/openmohaa profile; populated saves/gameplay unqualified.                                                                                                     | Eligible only after whole-boundary final review and required checks. |
| [Spearhead #2593](https://github.com/boburning/portcove/issues/2593) / [`medal-of-honor-allied-assault-spearhead-openmohaa`](../../crates/portcove-core/catalog/ports/medal-of-honor-allied-assault-spearhead-openmohaa.json)                                                                     | stable official package; `launch_openmohaa_spearhead.exe`; preserve `main`, `mainta`.                                                                                                                                                                            | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external Roaming/openmohaa profile; populated saves/gameplay unqualified.                                                                                                     | Eligible only after whole-boundary final review and required checks. |
| [Breakthrough #2594](https://github.com/boburning/portcove/issues/2594) / [`medal-of-honor-allied-assault-breakthrough-openmohaa`](../../crates/portcove-core/catalog/ports/medal-of-honor-allied-assault-breakthrough-openmohaa.json)                                                            | stable official package; `launch_openmohaa_breakthrough.exe`; preserve `main`, `maintt`.                                                                                                                                                                         | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external Roaming/openmohaa profile; populated saves/gameplay unqualified.                                                                                                     | Eligible only after whole-boundary final review and required checks. |
| [Jedi Outcast SP #2611](https://github.com/boburning/portcove/issues/2611) / [`star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo`](../../crates/portcove-core/catalog/ports/star-wars-jedi-knight-ii-jedi-outcast-single-player-openjk-openjo.json)                               | rolling official package; `openjo_sp.x86_64.exe`; preserve `base`.                                                                                                                                                                                               | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Already prepared matching working original data only; new first setup remains held; external OpenJO profile; populated saves/gameplay unqualified. Upstream SP needs attention; no Outcast MP offer. | Remains OPEN (#2611).                                                |
| [Jedi Academy #2612](https://github.com/boburning/portcove/issues/2612) / [`star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo`](../../crates/portcove-core/catalog/ports/star-wars-jedi-knight-jedi-academy-single-player-and-multiplayer-openjk-openjo.json)        | rolling official package; `openjk_sp.x86_64.exe`; preserve `base/assets0.pk3`, `base/assets1.pk3`, `base/assets2.pk3`, `base/assets3.pk3`.                                                                                                                       | Exact source/package row; authenticated index has no preservation overlap; independent real-ID retained/lifecycle/provider controls. | Manual original setup; external OpenJK profile; populated saves/gameplay unqualified. Whole managed-fitting acceptance remains open; MP stays separately prepared/external.                          | Remains OPEN (#2612).                                                |

## Shared behavior and title-specific exceptions

Original preparation is the player's supported upstream copy of owned PC files.
No synthetic completion marker, FileSet identity, Native6 preparation receipt,
conversion or private-input acquisition is claimed. Core preserves the named
local inputs, including copies made before first Play. Backups do not cover the
external user profiles. Rollback carries current declared local inputs and does
not rewind saves. Unexpected runtime additions remain review holds and are not
silently classified as disposable or deleted. Fresh managed Windows paths use
the existing printable-ASCII/MAX_PATH policy; retained installations keep their
creating path contract. External profile resolvers retain their own limits.

- **dhewm3:** source `455b88e8…`, official 1.5.5 Win32 package; PE headers confirm
  x86, offered on Windows x64 through compatibility support, not as a native x64
  player. Base PK4s000–008 are distinct from RoE's additional d3xp PK4s000–001.
  Both exclude BFG. Gamepad/configuration/notice resources and the package DLLs
  stay immutable. Optional mods and widescreen-GUI archives are separate.
- **DUDE:** source `e703ab27…`, official v0.9.7 x64 package. Preserve the exact
  base/d3xp original PK4s while keeping the shipped menu PK4s, definitions and
  renderer resources immutable. The inspected profile resolver silently copies
  a preexisting dhewm3 tree when dude is absent; both profiles and their creating
  runtimes must be preserved before choosing Play. Vulkan pipeline cache,
  diagnostic output and ImGui settings resolve through fs_savepath/fs_configpath.
  Quake 4's in-development null-game route is outside these two titles.
- **dhewm3/DUDE maintenance:** explicit version checking can accept a master-server
  response, download into fs_savepath after user consent and possibly start the
  downloaded program while quitting. This is a real legacy path. Inspected code
  does not establish that the downloaded program replaces this managed runtime
  or continues the game session. Neither updater absence nor a demonstrated
  competing runtime-replacement owner is claimed. In-process reloadEngine mod
  switching is not a detached game successor. Unexpected replacement/output
  observations require a new assessment on the title owner.
- **OpenMoHAA:** source `a72bc153…`, v0.82.1 Windows x64 package contains only ten
  executables/DLLs at the root. Original main/mainta/maintt folders are absent,
  allowing the separately declared title-specific folders without immutable
  overlap. The official launcher selects target0/1/2 and waits for its child on
  Windows. Its game restart remains in process. Original PK3/sound/video and
  language-specific patches/GOG Warchest instructions are distinct from engine
  DLLs. Normal user writes resolve to the roaming openmohaa profile; unavailable
  home lookup can fall back to runtime data folders. Generic Steam/GOG helpers
  are macro-guarded and are not claimed as automatic data discovery here.
  The active update checker announces availability; the separate autoupdater
  source is guarded by USE_AUTOUPDATER/AUTOUPDATER_BIN, which the selected
  publisher CMake/Windows build inputs do not enable. No universal updater-free
  claim follows from that bounded build inspection.
- **OpenJK/OpenJO:** source `260c59c2…`, distinct current `latest` archives. New
  managed routes explicitly use Rolling; retained user-selected contracts remain
  Stable. An unchanged latest tag with a different accepted archive digest is a
  new artifact. The selected player bytes contain the non-portable home branch,
  with distinct OpenJK/OpenJO profiles; this is static evidence, not execution.
  The archives include legacy x86 EaxMan/OpenAL DLLs alongside x64 players. The
  inspected Windows x64 build excludes that OpenAL linkage; their presence alone
  does not establish player incompatibility or certify complete ABI resolution.
  Game-library lookup includes the OpenJK subdirectory. OpenJO's package leaves
  base vacant, while Academy ships immutable DLLs in base: Academy preserves only
  four original asset PK3s, never the whole base folder. OpenJO accepts only an
  already prepared matching working data copy; its named original-data/patch/layout
  first-setup hold remains unresolved and #2611 stays open. Managed Academy selects
  SP; a separately prepared external MP copy retains its own owner and scope.

Primary setup and source authorities are the exact source-commit links in the
JSON rows and their per-ID setup URLs, [dhewm3 setup](https://dhewm3.org/#how-to-install),
[DUDE running](https://github.com/Inkub0/dude/blob/e703ab270064eef8ead6ae3abbb4b0762bddecd8/README.md),
[OpenMoHAA installation](https://github.com/openmoh/openmohaa/blob/a72bc153db1e6ced6e30431b5217e1a53576712c/docs/markdown/01-intro/01-installation.md),
[OpenJK player instructions](https://github.com/JACoders/OpenJK/blob/260c59c2907187af555a676fe0cc798893bf7757/README.md)
and the historical [upstream Academy four-archive observation](https://github.com/JACoders/OpenJK/issues/631).
The historical report is source evidence for the file layout, not current native
or platform acceptance. Each original game's complete matching installation
remains the player's responsibility.

## Batch boundary and accounting

A bounded79 existing OPEN source/setup pool and56 full primary owner contexts
provided the reserve;24 selected upstreams received bounded release inspection.
Nine actual operational changes emerged. This is below the usual15–25
operational target because title-specific original layouts, profile behavior,
launcher lifetime, package integrity and retained contracts needed separate
assessment. Other observed candidates retained missing-integrity, archive-shape,
upstream-lifetime, source/native/client or unfinished-fitting conditions; no
unrelated addition or new Core capability filled the count. Routine metadata and
prepared-guide batches retain the owner's30–50/approximately40 target.

These nine are existing affected-312 identities. They add no listings or members
to frozen858 and are not historical1422 members. There is no direct Required-beta
resolution, whole parent/cohort completion or measured speedup claim. Canonical
completion remains conditional on actual whole-scope final review and delivery;
#2611 and #2612 specifically remain open. Support arrays and every native/protected hold
remain unchanged. No game, original, upstream helper/compiler, credential,
protected publication or destructive action is authorized by this packet.
