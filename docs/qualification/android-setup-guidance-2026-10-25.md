# Android upstream setup guidance — October 25, 2026

This dated packet improves seventeen existing Android listings within #2510/#2926.
It makes the published package, original-input setup and actual save/update owner
clear. It adds no Desktop installer, APK runner or managed Android lifecycle.
Canonical issues and Project fields retain ownership; full Public beta acceptance
remains incomplete.

## Offered route and ownership

Use the selected upstream Android APK and its title-specific setup guide on the
Android device. Original-file import, on-device extraction/build, app signing,
updates, storage and save import/export belong to that app and the player.
Portcove does not execute an APK/helper, request Steam credentials, replace an
Android runtime or promise managed Backup, Restore or Rollback for its profile.
Native Desktop integrations and plugins are separate contracts.

Published package availability is established for every entry; native Desktop or
device gameplay qualification is not inferred. Existing discovery identities,
artwork, offered platforms and acquisition conditions are preserved. Uninstalling
or clearing Android app storage can remove data; use the actual supported export
or separately preserved data before a signing transition. Unknown export paths
remain explicitly unknown rather than inheriting an unrelated desktop path.

## Per-port assessment

Every row selects the upstream Android setup/data handoff and external update
owner. The companion JSON records the exact guide, original/data requirements,
package metadata, current owner state and validation for each identity.

| Identity / canonical issue                          | Concrete setup and retained boundary                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `andreyvelsk-com-mobilerpgpack-phone` / #1848       | This fork's AYN Thor dual-screen APK uses UZDoom; inherited parent-engine names do not establish Doom RPG or Wolfenstein RPG support. Own compatible IWAD/content; exact save/export location remains unknown.                                                                        |
| `aureliob-banjorecomp-android` / #1794              | Android ARM64 app imports own North American 1.0 Banjo-Kazooie original. App-private profile under `com.aure.banjorecomp`; keep identity/signature and data when updating.                                                                                                            |
| `edwin2929-sma3-recomp-android` / #1885             | Published APK is 0.10.6 beta while its pinned source guide describes 0.4. That guide identifies exact USA ROM/retail BIOS and chooser flow; actual APK-specific input/save-transfer facts remain to reconcile. Package visibility is useful without declaring that mismatch resolved. |
| `greennaugahyde-zeldawwhdrecompandroid` / #1896     | This fork's Android 11+/ARM64/Vulkan 1.1 app extracts/compiles on-device from supported Wii U regions and original WUD/WUX plus own keys, or decrypted WUA. Keep actual save exports; state compatibility depends on build. Optional graphics add-ons are separate.                   |
| `igawa6-dualsouls` / #1829                          | Conditional permitted-copy flow uses exact Hollow Knight 1.5.12620 input and matching patch; app exports/imports slots and retains `.bak`. Keep the same signed app and preserve exports before changes. Core enforces the precise acquisition condition described below.             |
| `izzy2lost-lighthouse` / #1841                      | App generates Banjo-Kazooie O2R on-device from its supported originals; US 1.0 is recommended for ROM hacks. No separate PC extractor. Exact Android save/export path is not established.                                                                                             |
| `izzy2lost-perfect-dark` / #1867                    | Recommended US 1.1 original, app verification/copy and exact EEPROM path. The old signing key was lost: preserve and verify a separate EEPROM/app-data copy before the required uninstall/reinstall for 2.0.0. No automatic restore is promised.                                      |
| `izzy2lost-spaghettikart` / #1889                   | App verifies the exact Mario Kart 64 US original and generates O2R on-device. Preserve `Android/data/com.izzy.kart/files`, including actual saves/mods; OTR is not a supported mod substitute.                                                                                        |
| `izzy2lost-starship` / #1890                        | File-picker import and conversion of supported US Star Fox 64 originals on-device. Optional Japanese/European voice data does not replace the US base. Use upstream save/mod managers.                                                                                                |
| `jakobkhansen-silksongandroid` / #1884              | Own complete Linux depot folder must remain available every Play/rebuild; Windows/macOS depots do not substitute. PC folder transfer needs no sign-in; optional Steam credentials and Cloud operations stay in the app. Toolchain/build and saves remain external.                    |
| `linkzenic-2ship2harkinian-android` / #1787         | App creates O2R on-device from supported Majora's Mask original. Preserve the actual user-selected settings/data folder, including SD-card choices, saves/mods/presets; no desktop extractor/plugin package is required.                                                              |
| `linkzenic-zelda64recomp-android` / #1915           | Choose App APK rather than randomizer-mod ZIP. ARM64/Vulkan and `/sdcard/Zelda64` profile; Android ARM64 native mods are distinct from desktop plugins. Preserve data before any debug-signature transition.                                                                          |
| `ogdanimal-goemon64recomp-android` / #1823          | System-picker verified import into app-scoped storage. Compatible save imports preserve `.pre-import.bak`; this is an upstream safeguard, not arbitrary emulator-save compatibility or a verified backup.                                                                             |
| `simon358-ctr-native-android` / #1808               | Missing Assets picker imports own NTSC-U raw BIN or supported BIGFILE.BIG and requires restart. Its 32-bit Android memory model and app-private picker path are separate from parent desktop/manual-root layouts.                                                                     |
| `ssunnking-zeldawwhdrecompandroid-enhanced` / #1907 | Distinct Enhanced fork: supported region-specific Wii U inputs, Android on-device extraction/compilation and app save/state export. Build-bound states remain distinct from game saves; no PC recompiler is required.                                                                 |
| `wootbeer-jillandroid` / #1834                      | First-launch folder selection for complete licensed Jill of the Jungle episode data. Keep that folder; exact Android save/export and transferable-save contract remain unknown.                                                                                                       |
| `zinexda-sonic-r-android` / #1888                   | Guided asset setup from own complete retail Sonic R PC folder into this Android wrapper. Exact save/export path is unknown; multiplayer is planned. Retain upstream custom free-use/no-sale terms.                                                                                    |

Dual Souls' unchanged README and redistribution audit explicitly identify compiled
game code in its APK and content-bearing patch. The preserved proposal's exact
fresh-acquisition hold is now carried through Core's `download_block_reason`;
permitted-copy setup and save-export guidance remain available. Resume fresh
Portcove acquisition when an attributable grant or a package that creates those
materials from the player's inputs resolves that named condition. This is not a
blanket statement that all existing-copy operations are unsupported.

## Evidence and delivery scope

All seventeen release histories and selected-release asset inventories are
completely paginated. Their latest selected stable tags match the reviewed guides;
all twenty-four pinned primary guide/source blobs are unchanged and verified
against Git blob identity and content SHA-256. Each actual proposed record passed
maintained Core listing preparation with unchanged operational projection. Dual
Souls' repaired held proposal has its own input/output/receipt, preserving the
unheld proposal as rejected evidence. SMA3's active guide and packet name the
actual 0.10.6 beta APK; 0.9 remains historical evidence only.

No APK/archive was acquired, extracted, installed or executed for these seventeen.
No device, gameplay, native Desktop, managed replacement, packaged Desktop or
real-save acceptance is claimed. No prose-mirroring per-game tests are introduced.
Existing shared acquisition/hold and setup/Play contracts remain applicable.
Complete-candidate independent review, required exact-head CI, guarded merge and
remote/canonical readback remain delivery obligations at this source checkpoint.

## Inventory reconciliation

The historical private handoff group had eighteen rows. Its Need for Speed
identity now has a Windows v1.0.1 package and is actively assessed separately;
it is not included as Android. Its actual archive/source review identifies a
process-handoff incompatibility with the existing managed launch contract. No
fitting route or unresolved operation is silently discarded by that regrouping.

These seventeen selected records belong to the preserved 232-path extraction.
After delivery its path accounting becomes 184 delivered / 48 remaining, plus
separate RoadRash. Path delivery is not a global fit-completion count. The six
original Direct decisions, GoldenEye managed acquisition condition, other fitting
capability work, individual maintenance and original/current joins remain owned
by #2510/#2926 and their canonical ports. The original 524 identities, 312 affected
additions and 22 original roadmap-only joins remain preserved. Catalog presence
does not promote a port to Reviewed/Supported or override an approved deferral.

Whole-inventory reads and a full Roadmap doctor that detected concurrent Project
changes are retained as inconclusive; scoped checks do not establish global
health. #2510/#2926 remain open / Public beta / Required. #1422's historical
cohort and #2225/#47/#48/#534/#246's independent acceptance/publication authority
remain separate.
