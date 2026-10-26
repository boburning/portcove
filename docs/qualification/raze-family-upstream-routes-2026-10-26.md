# Raze family upstream routes — October 26, 2026

This seven-identity candidate continues #2510/#2926 from main
`8e7c37ea13fe21a5e507f7dfcdf89b1a3009c836`. The
[source-bound packet](raze-family-upstream-routes-2026-10-26.json) records
platform, original-input, ownership, evidence and remaining managed-fit scope.
This dated evidence is not a live backlog. Complete Public beta acceptance
remains false; every canonical owner keeps its substantive acceptance.

| Identity / owner               | Original PC data boundary                                                                                                                        | Useful route                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Duke Nukem 3D #2666            | Recognized DUKE3D.GRP with its complete original data; retail/Atomic and specific World Tour identities remain distinct.                         | Upstream Raze player and detected-game selection; optional explicit archive argument.           |
| Blood #2667                    | BLOOD.RFF, SOUNDS.RFF, BLOOD.INI and companion data. Specific 1.0/1.1/One Unit Whole Blood identities and optional Cryptic Passage dependencies. | Same player; keep complete original folders rather than substituting another game's group file. |
| Shadow Warrior #2668           | Original 1997 SW.GRP and companions, not the 2013 reboot.                                                                                        | Same player, retaining separately owned expansion requirements.                                 |
| Redneck Rampage #2670          | Original REDNECK.GRP and companions.                                                                                                             | Base-game identity stays separate from Rides Again and Route 66 requirements.                   |
| PowerSlave / Exhumed DOS #2671 | Recognized DOS STUFF.DAT identities and companion data.                                                                                          | Distinct from the console implementations and 2022 remaster; artwork uses the DOS original.     |
| NAM #2672                      | NAM.GRP and original companions; NAPALM.GRP is a separate recognized edition.                                                                    | Use the actual owned edition; do not rename foreign data to satisfy a filename.                 |
| WWII GI #2673                  | WW2GI.GRP and original companions.                                                                                                               | Base game; optional Platoon Leader retains its own dependency.                                  |

All seven existing IDs and canonical issues remain distinct despite their shared
opaque upstream repository `230432175`. No second engine, managed adapter,
identity or per-game Rust/React implementation is introduced. Earlier lineage
and existing artwork remain preserved; missing artwork gains reviewed DOS-game
identities. In particular, PowerSlave uses IGDB 188071 (`powerslave--1`, DOS),
not the console game's 8338 identity or the later remaster.

## Package and platform evidence

Current traversal is terminally complete: 44 releases and a non-truncated tagged
tree. Tag 1.11.0 resolves to `19e5f308de065fb432beb9d11070ece12da3ea3c`;
the separately observed default branch is
`76fe82f5eb318fdeb30ba9fb27093a9a10bc3821`. Neither is a reproducible package
build attestation. Bounded actual archive inspection found:

- `Raze-1.11.0b-windows.zip`: 18,364,194 bytes, eight entries,
  28,786,995 expanded bytes. Sole AMD64 player: `raze.exe`, with DLLs,
  `raze.pk3` and soundfont content. Computed SHA-256:
  `16718c28d8d6853b418d467af0354b8c2a21f6c1bebb1686ef2da9896caac2e5`.
- `raze-macos-1.11.0.zip`: 31,930,373 bytes, 15 entries,
  68,131,016 expanded bytes. `Raze.app/Contents/MacOS/raze` is a universal
  Mach-O containing x86-64 and ARM64. No link was followed or executable run.
  Computed SHA-256:
  `b7980849a507cfcfeaf8f76298c032bfe4415b2f246f41e3c0c9a6291770c70c`.

Neither metadata response supplied a publisher digest. Computed hashes are
observations, not independently expected identities. The official downloads
site returned an Anubis access denial; no bypass was attempted and no checksum
was inferred. Existing Core unverified-artifact disclosure/consent remains
intact. Source licensing distinguishes Build/component terms from non-Build GPL;
a root label does not establish every packaged component grant.

Recommend the actual Windows ZIP through stable version-independent hints;
exclude the PDB/symbol archive. Completing downloaded setup identifies Raze,
while Play remains explicit. On macOS use the ordinary OS application entry;
Core does not register a private binary inside its bundle. There is no Linux
archive in this selected GitHub release. Linux still has a useful already
prepared/system-package native route and upstream build handoff, so its
listing facet remains available without inventing a Linux download hint or
Portcove build capability. No platform execution qualification is inferred.

## Original files, selection and shared data

Pinned `grpinfo.txt` identifies individual game/edition groups, sizes, CRCs and
expansion dependencies. The player searches configured folders and Steam/GOG
installations. Reuse recognized data; manual copying is conditional. A main
archive is an identification anchor, not a claim that every required original
file is contained in it. Optional `-gamegrp` plus a local Windows drive-letter absolute archive path
selects an already recognized/scanned entry through the reviewed parser. UNC
paths can fall back to the picker; no POSIX/macOS fixed-path rule is inferred. Registration otherwise
may open the shared detected-game selector; it does not promise a forced game.
Core discovery never executes Raze or an original-game helper automatically.

Pinned platform source establishes different default roots:

- Windows settings: the actual Documents known folder's `My Games/raze/raze.ini`;
  saves: the system Saved Games folder's `Raze`; screenshots: the system
  Screenshots folder's `Raze`. Redirection can change absolute locations.
- A writable `raze_portable.ini` outside Program Files selects the player folder,
  `Save` and `Screenshots`. Presence alone is insufficient when it is unwritable.
- Linux: `~/.config/raze`, with its `raze.ini` and `savegames`; this tagged
  implementation does not derive that root from `XDG_CONFIG_HOME`. First use can
  rename an older `~/.raze` directory.
- macOS: `~/Library/Preferences/raze.ini`, and normally
  `~/Documents/raze/Savegames` plus `Screenshots`.

Normal save roots contain game/edition subfolders; explicit `-savedir` disables
that partition, so custom directories must remain distinct between games.
Changing portable mode redirects paths without moving normal-profile saves.
Keep actual overrides, original files, selected mods and all relevant game
subfolders backed up with every copy closed. Windows can migrate older
configuration on first Play, including a deliberate global/portable choice;
registration itself does not perform that migration. Preserve the old location
before trying a newer upstream copy. These seven entries may share a player and
profile; no per-card private storage or cross-version save guarantee is claimed.

## Delivery and remaining scope

The candidate changes seven existing per-ID records and generated listings.
All 1,424 identities, all 166 operational definitions, other 1,417 per-ID blobs,
source contracts and lineage stay intact. It adds useful package defaults,
setup/registration instructions and profile boundaries, not Core runtime/data
ownership. Managed fits for these seven remain explicitly unresolved pending
independent expected artifact identity and full compatible persistence/writer/
component interpretation. Unknown is not Unsupported; these useful operations
remain available.

Maintained per-record preparation, production Core authoring, reviewed artwork
and generated-output checks precede complete-candidate review and exact-head
hosted delivery. Final executed inventories, guarded merge and canonical readback
belong to the PR/issues; this candidate packet does not manufacture future passes.
All 26 focused Node cases across two requested files passed, with zero skips.
The seven original-game artwork mappings were validated in the first maintained
preparation and retained unchanged through the review corrections. A later
transient image-provider fallback was preserved as a failed preparation
assertion, rather than accepted as artwork loss.

No game, installer, helper, native player, packaged Desktop or populated real-save
restore ran. #2225/#47/#48 and #534/#246 retain independent acceptance/authority.

Original 524 identities/312 affected additions/22 roadmap joins remain preserved.
The original joins stay 17 authored/five unlisted; six Direct/legacy decisions and
broader rollout/reconciliation remain unfinished. This is partial delivery.
