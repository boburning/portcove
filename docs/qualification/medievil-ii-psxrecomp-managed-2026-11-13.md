# MediEvil II: a managed setup-kit route beside the prebuilt player

Dated evidence from November 13, 2026, under #459 and #2926. The repository
owner chose to keep the existing prebuilt-player route and add a separate
managed PS1 route for the v0.2.6 setup kits, so players can choose either. No
upstream program was executed, and no original disc or BIOS was used.

## Two routes from one repository

`alexbeavs-ps1-ports/medievil-ii-recomp` publishes two different products:

| Route                                         | Tags                           | What the player gets                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alexbeav-medievil-ii-recomp` (existing)      | `v0.2.4-alpha`, `v0.2.5-alpha` | A precompiled Windows player, `MediEvilIIRecomp.exe`, with bundled OpenBIOS and six `medievil2.*` title mods (widescreen, frame rate, modern controls, seamless loading and others). |
| `alexbeav-medievil-ii-recomp-setup-kit` (new) | `v0.2.6`                       | A PSXRecomp setup kit. Portcove builds `MediEvil_II__Recompiled` from the player's own disc and retail SCPH-1001 BIOS. The kit has none of the title mods.                           |

The existing route stays `native-portable` on the `beta` channel with its
`medieviliirecomp-` selector, executable and persistent paths. Its only change
is a summary that names the prebuilt player, OpenBIOS and the title mods, so
the two listings read differently. A same-ID conversion was rejected:
existing native-portable installations would keep their retained definition
and every update would be refused with `PortableDataContractChanged`, with no
migration of the saves beside the executable.

The selectors do not overlap. `medieviliirecomp-` does not match
`medievil-ii-recomp-0.2.6-*`, and `medievil-ii-recomp-` does not match the
`MediEvilIIRecomp-v0.2.x-alpha-*` assets. The new route uses the `stable`
channel; `beta` would select `v0.2.5-alpha`, whose assets do not match its
selector.

### Naming and issue

The new listing is named "MediEvil II (setup kit) / Alexbeav PSXRecomp",
following the catalog's parenthesised qualifier for a second listing of the
same title. Both records keep `original_game_title` "MediEvil II" and reuse
the accepted cover. Catalog generation refuses two port identities with one
canonical issue (`checkLineageIdentities`), so the new record cannot carry
#459. Its own canonical issue is #5299.

## v0.2.6 kits

Tag `v0.2.6` (tag object `15ffaebf`, commit `8eac316b`) publishes four kits.
All four match the release's `SHA256SUMS.txt`. Provider release digests,
asset IDs and the prerelease flag were not read, because this session's proxy
blocks the release API.

| Kit                                        | Bytes      | SHA-256     | Route              |
| ------------------------------------------ | ---------- | ----------- | ------------------ |
| `medievil-ii-recomp-0.2.6-windows-x64.zip` | 47,782,043 | `15b93ecc…` | managed            |
| `medievil-ii-recomp-0.2.6-linux-x64.zip`   | 45,589,438 | `54a7351f…` | managed            |
| `medievil-ii-recomp-0.2.6-macos-arm64.zip` | 42,867,879 | `4056d6a4…` | upstream-owned Mac |
| `medievil-ii-recomp-0.2.6-macos-x64.zip`   | 43,376,798 | `9e5f3bad…` | upstream-owned Mac |

Static inspection of every kit found:

- **Framework:** `framework_pins.txt` pins PSXRecomp `031868cc`, whose runtime,
  recompiler, setup host and build CLI are byte-identical to the reviewed
  `7192402` ([builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md)).
- **Disc:** `game.toml` is identical in all four kits and to the tagged file
  (SHA-256 `04288170…`): serial SCUS-94564, `required_tracks = 2`, first data
  track 450,885,456 bytes, SHA-1 `017b8553…`. Its second `known_sha1`
  (`15d13c5a…`, 483,874,608 bytes) is a merged single-BIN image; the route
  binds only the first data track and track count, as for other routes.
  [Redump disc 2503](https://redump.info/disc/2503) lists MediEvil II (USA),
  SCUS-94564, with two tracks; track 1 size, SHA-1, MD5 and CRC32 agree with
  the kit. It is the only MediEvil II entry the Redump search returns.
- **BIOS:** `bios_config = "psxrecomp/bios/SCPH1001.toml"`, `openbios = false`,
  `bios_hle = false`. `CMakeLists.txt` accepts only the SCPH1001 stem, and the
  README requires the player's own SCPH-1001 dump with SHA-256 `71af94d1…`,
  the existing `psx-scph-1001-bios` profile.
- **Player:** no `EXE_NAME`; the window title "MediEvil II Recompiled" (two
  spaces) gives `MediEvil_II__Recompiled`, with `.exe` on Windows.
- **Layout:** `mods/bundled` holds 11 generic `psx.*` packages and no
  `medievil2.*` title mod; `mods/preloaded/packages` is empty;
  `mods/texture-packs/SCUS-94564/{dumps,replacements}` are empty. There is no
  flat `mods/packages`, no OpenBIOS selection, no link, no unsafe or
  case-colliding name. The Windows kit also has an empty
  `cache/SCUS-94564/datashards` folder at the kit root, outside the
  `build-portcove` runtime.
- **Diagnostics:** no bundled package enables the framework's playtest
  diagnostics, so the explicit MediEvil (#461) diagnostic paths are not needed.

This is the layout the `"split-mods"` form of `psx_managed_windows_v1`
describes, so the route uses that form with selectors `medievil-ii-recomp-`
plus `-windows-x64.zip` or `-linux-x64.zip`. It declares
`mods/texture-packs`, so delivered definitions need managed PS1 capability 3
([texture-pack record](psxrecomp-texture-pack-scope-2026-11-13.md)).

## Catalog changes

- **New source profile** `alexbeav-medievil-ii-recomp-usa-psx`: no MediEvil II
  disc identity existed. USA variant, SCUS-94564, two-track CHD, first data
  track SHA-1 `017b855353abd86c22aa516690e852b641e4fa71`.
- **Evidence:** `alexbeav-medievil-ii-recomp-v026-static-contract` (the kits)
  and `alexbeav-medievil-ii-recomp-redump-2503` (the disc).
- **Source contracts:** game and BIOS contracts for the new port, both bound
  to the Windows and Linux v0.2.6 kit SHA-256s.
- **Player copy:** the summary, setup steps and preparation text ask for the
  player's own disc and retail SCPH-1001 BIOS, say that Portcove builds the
  player, that the prebuilt route's title mods are not included, that saves
  from the prebuilt route stay with that installation, and that Mac uses the
  upstream kit.
- **Reviewed additions:** the new port and profile join the legacy-additions
  fixture.

## Not changed here

- **Release-selection corpus:** not enrolled. The corpus records provider
  release and asset IDs, publication times and digests, and none of them could
  be observed in this session. Resume with a configured-upstream observation
  and `node scripts/catalog-selection-enrollment.mts`.
- **Prebuilt route requalification:** it still points at `v0.2.4-alpha`.
  Moving it to `v0.2.5-alpha` needs only its URLs and a dated record.
- **Linux AppImage of the prebuilt player:** stays outside the catalog.

## Uncertain

If GitHub flags `v0.2.6` as a prerelease, the `stable` channel would select
an older stable tag such as `v0.1.2`, whose assets were not checked against
the selector. The flag is unknown.

## Not observed

Nothing was built or run. No disc, BIOS, gameplay, save, texture pack, update,
rollback or backup was observed. Mac kits were inspected only for their file
lists and checksums.
