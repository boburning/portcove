# Managed PS1 disc sets with audio tracks: Alone in the Dark: The New Nightmare

Dated evidence from November 13, 2026, under #426. It lets Core install a
managed PSXRecomp disc set whose discs have more than one track, and adds
managed Windows and Linux x86-64 routes for Alone in the Dark: The New
Nightmare, which the
[six-title record](psx-multi-disc-7192402-six-titles-2026-11-13.md) left
listed only because both of its discs have two tracks. The route follows that
record's five titles and the
[launch disc choice precedent](psx-multi-disc-launch-choice-2026-11-12.md).
No upstream program was executed and no original disc or BIOS was used.

## What Core does with a multi-track set

Verification keeps the single-track precedent. Each disc binds its data-track
SHA-1 and one exact track count; source registration already refuses a disc
whose extracted cue has another count. Audio tracks are not hash-bound. The
CHD storage identity is checked before and after extraction, and the
installation manifest covers every file under `runtime-discs`, so a changed
or missing track file after installation fails verification before launch.

Catalog validation now admits a managed `psx-raw-set` profile when each disc
has exactly one positive track count. A disc whose count may vary (`[1, 2]`)
is still refused, because installation needs one count to check against.

`chdman extractcd -sb` writes one file per track. Installation keeps the data
track as `disc-NN.bin`, the name the launch roster pairs with `disc-NN.cue` and
the only file hashed against the registered source record. Each other track
becomes `disc-NN-tTT.bin`. The cue sheet is rewritten in order through that
name map, keeping every INDEX, PREGAP and POSTGAP line. Installation refuses
the set when the cue's TRACK count differs from the disc's catalog count, when
a FILE entry does not carry exactly one TRACK, or when a FILE name is unsafe,
repeated or missing. The rewrite is a pure function, and the staged set is
activated with the existing transactional directory replacement, so a refusal
leaves the previous set unchanged. Single-track sets produce the same files and
cue bytes as before. The staged `psx-raw-set` route, which keeps only data
tracks, is unchanged.

An older Portcove reads a catalog with a two-track managed set as invalid, and
the refusal does not say why. Managed PS1 capability version 4 names the new
reader. The track counts live in the source profile, so the definition
projection checks them after it has the whole catalog: an indexed entry whose
set has a disc with more than one track requires minimum version 4.

The tests are Linux-runnable and cover the cue rewrite (one and two tracks,
FILE and TRACK mismatches, unsafe and repeated names), staging with a missing
track file, the launch roster with audio track files present, the catalog rule
and the capability floor. The host-tool probe was not changed: Windows CI runs
a prebuilt copy, and the end-to-end `chdman` path for two tracks is therefore
exercised only through those pure and staging functions.

## Inputs

The kits are the newest tag by `git ls-remote`, `v0.3.7` at commit
`673a0d5f2598ee7d08d2f828cf61854f10e698ca`, fetched from the release download
URLs. Each gave the same SHA-256 on both downloads. The release API is blocked
by this session's proxy, so the provider digest and asset list were not read.
Core package-layout inspection was not run on these bytes; their listings show
no link, absolute or `..` entry, and the Linux kit has no case-colliding paths.

| Kit         | Bytes      | SHA-256                                                            |
| ----------- | ---------- | ------------------------------------------------------------------ |
| Windows x64 | 47,935,917 | `c4567cc8a293c07fd91ae604c94bb4afd030b01ad2dc1795a496df3e366ab666` |
| Linux x64   | 45,743,277 | `3ab2be5cbd868184a10cd090f8489565f4b6be25f083e968e2a975d39a5f40a2` |

Both kits pin PSXRecomp `7192402c283880e318c97732c9b733c4d1b144d0`, as the
five titles do, and ship `mods/bundled`, `mods/preloaded` and an empty
`mods/texture-packs/<serial>` folder. Their `game.toml` and `CMakeLists.txt`
equal the repository files at the tag commit, the Windows copies with CRLF line
endings. The build sets no `EXE_NAME`, so the player is named
`Alone_in_the_Dark__The_New_Nightmare` from the CMake `WINDOW_TITLE`, the name
the kit's setup host and `README-SETUP.txt` use. `README-SETUP.txt` requires a
retail SCPH-5552 (Europe) BIOS (SHA-256 `1faaa18f…`), `[recompiler]
bios_config` names `SCPH5552.toml`, and `[runtime] openbios` is `false`.

## Discs

| Disc | Serial     | Redump                              | Data track bytes | Data SHA-1                                 | Audio track                                    |
| ---- | ---------- | ----------------------------------- | ---------------- | ------------------------------------------ | ---------------------------------------------- |
| 1    | SLES-02801 | [892](https://redump.info/disc/892) | 605,317,776      | `270c9d9977a859e0f59e82cf9f3acd9de457f453` | 2-second pregap, 39,701,760 bytes, `16772899…` |
| 2    | SLES-12801 | [893](https://redump.info/disc/893) | 638,403,360      | `ab2cadfb095ee5980d99740ca584487e469668ba` | 2-second pregap, 39,701,760 bytes, `16772899…` |

Each data track's size, CRC32, MD5 and SHA-1 agree with the kit's
`[prepare_disc]` lists, and a Redump search for each SHA-1 returned only that
disc. The audio track is the same on both discs. The kit also lists a third
`known_sha1` (`77bf47a7…`, 645,019,536 bytes, CRC32 `81fd5df0`). It equals
Redump's total for Disc 1 as one merged image and matches no Redump track, so
the catalog binds only the two data tracks.

## What Core binds

The route uses the five titles' explicit integration form: the split-mods
persistent paths including `mods/texture-packs`, `runtime_source_filename:
"runtime-discs"`, the `psx-raw-set` materialization bound to a
`multi-disc-set` identity with each disc's data-track SHA-1 and a track count
of 2, `launch_disc_choice: "psx-settings-selected"` and the retail
`psx-scph-5552-bios` profile. The game and BIOS source contracts apply to the
exact Windows and Linux kit digests above. The Mac kits stay upstream-owned
with the upstream guide; they were not downloaded.

## Not observed

The kit's `[netplay]` gate requires both tracks and a TOC fingerprint of the
mounted disc. Whether `chdman`'s pregap layout for Track 2 (a `PREGAP` line or
an `INDEX 00` with stored pregap sectors) matches Redump's two-file layout, and
so whether that fingerprint matches a set Portcove installs, was not observed.
The kit's `game.toml` describes the gate as the online mount check. Native generation, gameplay, music
playback, in-game or Play-time disc changes, saves, save states, texture packs,
and update or rollback with real data were not observed. The provider digests
and the Mac kits were not checked.
