# Sonic 2 and Sonic 3 & Knuckles prepared Windows routes

Captured 2026-10-18, fixed slice 6B-Prepared-reuse-2, owners #136/#153/#154.
The fixed batch also retains #155; its official package refused the unchanged NES2
cartridge metadata. That consumer needs an original-driven cycle build and remains
unfinished engineering. It is not admitted by this candidate or excluded from slice 6.

## Exact package and source binding

| Fact                     | Sonic 2 (#153)                                                   | Sonic 3 & Knuckles (#154)                                        |
| ------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Project                  | mstan/SonicTheHedgehog2Recomp                                    | mstan/Sonic3AndKnucklesRecomp                                    |
| Release/source           | v0.8.3, e1451eee49cf2238164e282d0c1a8f79ce8a76aa                 | v0.5.3, 74e8aeadb5b8b8da7e776beb0d28f915e3efeb85                 |
| Windows asset            | 653678623, SonicTheHedgehog2Recomp-windows-x64-v0.8.3.zip        | 653676522, Sonic3KRecomp-windows-x64-v0.5.3.zip                  |
| Archive bytes            | 7204657                                                          | 16694619                                                         |
| Archive SHA256           | c526ad6fbdbcc83619e0daf8711a7c09699d63541003be4cc4bbdef11877901f | 42ada10579a00d266aa08a833054ea5fea87b64eef67d268b054525fd0f6be99 |
| Executable SHA256        | 6ca4655174534f656bdae413303dc2fef26b835d264cc8c4e7962ff23a7b7910 | 24dbb020f94b819b2e9e4c7eabbfdc9b7f1a04decd8dabfd5c6d1ea024881517 |
| Engine                   | 64d9c1459850ebe739a33b5116ee7c2cffb5d47e                         | 53c9add7382ecae8b7750d593fc7bbc70f9cf7b0                         |
| UI                       | 7e884a227accea91ddb378671bd49aaeeea13371                         | b9ef2f539be3622eeb0e7d4a2ff33c8edf129667                         |
| Exact original           | World Rev A, 1048576 bytes, raw big-endian                       | USA combined Lock-On, 4194304 bytes, raw big-endian              |
| Original SHA1            | 8bca5dcef1af3e00098666fd892dc1c2a76333f9                         | cfbf98c36c776677290a872547ac47c53d2761d6                         |
| Observed original SHA256 | 193bc4064ce0daf27ea9e908ed246d87ec576cc294833badebb590b6ad8e8f6b | fba0677fde9f76df93f3e98d6310d8af68b9847bde16e253d73cd4dd8134ed23 |
| Immutable inventory      | 44 files including game.bin                                      | 49 files including game.bin                                      |
| Immutable tree SHA256    | f48f6ca9b1c1068d4438f23cc4c6101ca7a3c134ec497bd59eb21780f833ff0e | c25d601197f0abefb362275df0d3248cde2991c09d0358e70390bf18a17b24b1 |

[Sonic 2 source contract](https://github.com/mstan/SonicTheHedgehog2Recomp/blob/e1451eee49cf2238164e282d0c1a8f79ce8a76aa/game/game.toml)
and [Sonic3K source contract](https://github.com/mstan/Sonic3AndKnucklesRecomp/blob/74e8aeadb5b8b8da7e776beb0d28f915e3efeb85/game/sonic3k/sonic3k_spec.c)
are separate from executable authenticity and runtime acceptance. Exact full-file
identities consume the pinned [No-Intro database](https://github.com/libretro/libretro-database/blob/12c21cf79f1e20eff6ac68b80875816c717d0a7a/metadat/no-intro/Sega%20-%20Mega%20Drive%20-%20Genesis.dat).
Ordinary admission enforces observed SHA1, without AND-ing unobserved CRC. Sonic 2's
compatibility CRC is 7b905383. Sonic3K disables its expected CRC (0u), enforcing only
4 MiB upstream; Core's stronger original identity and immutable game.bin supply
the exact binding. Do not claim upstream enforces CRC63522553.

#154 retains its original canonical issue. Its old framework pointer is resolved
through the [pinned engine README](https://github.com/mstan/segagenesisrecomp/blob/64d9c1459850ebe739a33b5116ee7c2cffb5d47e/README.md)
to the game project. Only the combined Sonic3K artifact is selected; standalone
Sonic3 and Sonic & Knuckles assets are outside this route. Packaged README says
0.5.2 while release/build-info says 0.5.3; the discrepancy and native dirty build
labels remain visible. No reproducible-build or clean-source attestation follows.
Authenticode status is Unknown. Preserve complete packages and PolyForm
Noncommercial/third-party notices; project terms grant no original-ROM rights
or redistribution authority.

## Preparation, ownership and writes

Extract the complete exact package into a fresh short Windows-code-page compatible
folder outside the Portcove library. Copy the exact lawful raw original unchanged
to game.bin in that root and register game.bin separately. A .md input becomes a
byte-identical .bin working copy, without header or byte-order conversion. Core
passes literal --no-launcher game.bin, with no dynamic source argument. The whole
immutable inventory independently binds that launch target; no temporary basename
assumption is made. All original NAS archives and external working sources were
unchanged. Materialization bounded raw ZIP central-directory records and expanded
sizes before ZipFile parsing, checked every hash/CRC and used exclusive writes.

Both roots preserve settings.ini and their exact rom-Sonic2.cfg/rom-Sonic3K.cfg.
Sonic 2 initializes four diagnostic TOMLs (dispatch_misses, floor_coverage,
interior_label_misses, floor_unsafe) with exact .toml.tmp and .prev.toml counterparts.
It optionally preserves sonic2-party.ini and .tmp, and literal local-state slots
native_save_1.bin through native_save_9.bin with .bin.thumb sidecars. Campaign
stores/configurable destinations and PID-named temporaries are outside this route;
do not enable campaign modifications. Foreign-game parked reports require a mixed
runtime and remain outside this fresh single-title preparation.

Sonic3K uses literal game.srm (derived from the stable ROM basename), two root
TOMLs, fixed yield_log_native.log, floor_unsafe.log and interior_label_misses.log.
Optional sonic3k-mods.ini/.tmp and nine fixed state files are preserved without
operation acceptance. Donor/mod assets remain immutable. Neither route exempts
legacy interp_fallbacks.log, which the engine would delete; an existing extra file
therefore refuses verification before launch. Runtime menus use software pixels,
so no imgui.ini/log blanket exemption exists. Exact paths are declared in catalog.

Sequential checks do not sandbox either runtime. Qualification cleared named
developer output/network opt-ins, including case aliases for GENESIS_AUDIO_PREDRC,
GENESIS_FRAME_LOG, screenshot output controls, GENESIS_NETPLAY and the lobby
selftest master gate. Other environment values were neither logged nor rewritten.
This is a recorded child environment, not a product environment-clearing policy.
Netplay initialization messages are retained; no networking acceptance is inferred.

## Actual offered-operation evidence

Both routes used retained qualification CLI source
8a98cbe8b9370f3f91a5a21edc863514925fe464, executable SHA256
0c92fc17f3438491d8471f7727c960505a108634c511f8019beef6cd88dafc6a,
and private catalog SHA256
5009dbe732e71d0f017ac0d38f0cf68fc48a1b2c1067fb683750d4c8466094b4.
This is actual Windows execution through existing Core, with no Core or adapter
change. It is not installed Desktop/current-main replay or production delivery.

- Exact source admission passed; a one-byte changed original refused with
  source_invalid/known_mismatch and the exact profile. Unknown root files refused
  through the expected immutable-tree verification, then identity/hash-bound
  cleanup removed only the owned negative-control file.
- Fresh preview/consent-bound registration reported launchable readiness;
  revalidation passed. Neither original nor executable changed.
- Each route completed two distinct Core exec sessions, responsive identity-bound
  windows, ordinary RequestClose, captured positive process Wait and Core/CLI exit
  zero. Post-cycle immutable inventories and originals matched exactly. The window
  observation found no owned TCP listener at that point; no broader network claim.
- Registration-only removal preserved all 49 Sonic 2 and 54 Sonic3K external files,
  including a preservation sentinel. Independent Core status and read-only SQLite
  found each registration absent and not launchable. The shared diagnostic library
  still retained the separate failed #155 registration; no whole-library zero-row
  claim is made. Sentinels are not game saves or save/load proof.

Two preliminary #153 requests failed before game payload admission through Windows
identity-probe timeouts, first at the closed-gate supervisor and then at capacity
acquisition. Their failed logs and exact reservations remain retained. Fresh
process absence, preimages and separately reviewed unchanged-hash archives settled
them. An intervening isolated healthy probe was insufficient evidence of sustained
reliability. After the long local Rust workload ended and its exact reservations
were settled, a full inert admission/supervisor/settlement passed. The unchanged
bounded third packet then completed; no timing or identity safeguards were relaxed.

Repository admission, actual production-client/definition delivery, offered-operation
acceptance and optional observations remain distinct. These routes offer
register/revalidate/Play/restart/remove-registration with user-managed updates.
They offer no managed acquisition/update/rollback/backup or external deletion.
Gameplay, in-game save/load, optional states/mods/party/campaign functions, visual
correctness, audio, controllers and other platforms are unqualified. Protected
delivery/signing/publication remains under #246/#534; no Supported/beta claim.

Unsigned preparation selected separately attributable original-game covers for
both titles, validated by the recorded Core image validator. Existing accepted
mappings were preserved. Provider evidence and image hashes do not grant rights,
executable trust, support promotion or runtime acceptance.
