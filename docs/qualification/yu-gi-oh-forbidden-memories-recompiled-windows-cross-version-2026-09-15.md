# Yu-Gi-Oh! Forbidden Memories Recompiled Windows cross-version qualification — 2026-09-15

This record adds exact Windows x86-64 cross-version lifecycle evidence for
Yu-Gi-Oh! Forbidden Memories Recompiled. It covers a fresh v0.5.7 installation,
the v0.5.7-to-v0.6.1 update, rollback to the retained v0.5.7 installation, and
reactivation of the retained v0.6.1 installation. It does not replace the
separate v0.6.1 native-launch and backup/restore qualification record, promote
the port to Supported, or manufacture hands-on evidence.

## Scope

| Identity                 | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Portcove commit          | `6bf60b6e0f24a1eef7a7efcfdb181a6cc2692cef`                         |
| Portcove version         | `0.1.0-alpha.2`                                                    |
| Platform                 | `windows-x86-64`                                                   |
| Historical upstream ref  | `v0.5.7`                                                           |
| Historical commit        | `9ea5c50a3c3f3d7d05fa4e287554c98ae74b5127`                         |
| Historical release asset | `ygofm-0.5.7-win-x64.zip`                                          |
| Historical artifact size | `32,200,494` bytes                                                 |
| Historical SHA-256       | `6a75a0da4e3a2cf51debe0d88bb441693afebde8ffcf4b6b4b07864fa3c115b8` |
| Current upstream ref     | `v0.6.1`                                                           |
| Current commit           | `6b3579c6032fc59479a127824a27fc1f810e4f14`                         |
| Current release asset    | `ygofm-0.6.1-win-x64.zip`                                          |
| Current artifact size    | `34,799,128` bytes                                                 |
| Current SHA-256          | `4eed315000952dee7a751a05de4413a88777cf49609d29ab77ee3765a44d0f53` |
| Source contract          | `yu-gi-oh-forbidden-memories-recompiled-game-source`               |
| Source variant           | `legacy-accepted`                                                  |
| Source representation    | `normalized-track-set`                                             |
| Check contract           | `ygofm-windows-qualification-v1`                                   |

The isolated library was rooted at
`H:\Portcove-Worktrees\ygofm-v0.5.7-to-v0.6.1-20260915\library-main-6bf60b6`.
The release provider selected the exact historical tag and checksum-qualified
artifact; current-release resolution still selected v0.6.1 at qualification
time. Both annotated upstream tags are unsigned, so this evidence relies on the
reviewed checksum-qualified release identities rather than signed provenance.

The authorized BoburNAS CHD was copied into isolated test storage before use.
Proprietary source and generated game data remained outside Git. The source
identity matched the existing contract:

| Observation              | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| CHD size                 | `151,881,565` bytes                                                |
| CHD SHA-256              | `3447677c2313417e285abed0b18bd9c24c0a2efb095ede61b9b0b1edecdc8ff4` |
| Normalized Track 01 size | `517,872,768` bytes                                                |
| Normalized SHA-1         | `d5785a41900a10968d4a28a390666c4b9879b796`                         |
| Normalized SHA-256       | `6e22494a45bf50fa2d239cd3819a57163a5f9b91e0365babc3e101509b5c3a7c` |

## Historical install and update selection

Fresh historical install `cc513a2e-1806-4c31-a14b-d917ee3aef53` completed the
checksum-pinned 209,497,009-byte PSX toolchain acquisition, exact v0.5.7 asset
verification, source-bound generation, compilation, publication, and
activation. It selected
`build-portcove/Yu_Gi_Oh_Forbidden_Memories_Recompiled.exe`; manifest SHA-256
was `73c1b03235793a437a374f891c34928b8cc21498a9ab5698d898b982f31c5b8e`.
Independent verification operation `ddd846c3-d9c9-4aa7-b1aa-2ed23168d322`
checked 2,436 immutable files with no failures.

Update-check operation `10cca1b9-cd68-4791-927d-393559fca608` compared the
installed v0.5.7 release with v0.6.1 and reported the exact v0.6.1 artifact as
available.

## Persistent-state preservation probe

The exercise used a 767-byte synthetic persistence probe at `saves/input.ini`.
Its SHA-256 was
`a03b43075302081d3c13f513e7d415ac3dc57a35513d36df402a6de7570d52bc`.
The bytes came from a previously qualified valid v0.6.1 configuration but were
explicitly treated as a cross-version probe, not as state produced or restored
by this run.

Backup operation `c4ae693a-0bd0-4a0c-b5db-689759e73834` created healthy backup
`66dfee73-a810-4d82-9c17-6733ae486961`: one file, 767 bytes, tree SHA-256
`81459ae7b5d53d31d068e35afb230e2d9e7a63ad1f9f2d862ac5d798fa3263c0`.
The canonical probe and backup remained byte-identical through update, rollback,
and retained-version reactivation.

## Forward update, rollback, and retained reactivation

Update operation `897d0084-c3db-4663-9be0-629008fc9c91` installed and activated
the exact v0.6.1 release while retaining the original v0.5.7 installation.
The new manifest SHA-256 was
`be9fcf3d1354d8d706c7b0a217b5505975312b97486c78503d8fa1fcb7b22898`.
Verification operation `84e0acc2-c109-4c6d-af25-a3332063d385` checked 2,516
immutable files with no failures.

Rollback operation `64d95846-6521-464a-ad85-10740a91d96d` returned the active
installation to the exact original v0.5.7 installation
`cc513a2e-1806-4c31-a14b-d917ee3aef53`, retained the exact v0.6.1 installation
as the previous version, and completed successfully. Verification operation
`52f40a5e-d91e-45ff-9654-2338fbf3f5ba` again checked the 2,436 v0.5.7 immutable
files with no failures.

The ordinary update path then reactivated the retained v0.6.1 installation in
operation `2c4b9c0a-eba6-4314-bc80-24b83dfe2e5a`. It returned the same
installation identity `897d0084-c3db-4663-9be0-629008fc9c91` in about 7.97
seconds and kept the exact v0.5.7 installation as the previous version. Final
verification operation `049f630d-d588-4566-98b7-7b17dbd0b12f` checked all
2,516 v0.6.1 immutable files with no failures. No replacement installation was
manufactured during retained-version reactivation.

## Interrupted launch observation

This run did not establish native v0.5.7 launch behavior. Launch session
`50286393-7557-4e43-bee0-1ad4f8714683` lost its supervisor while still in
`preparing`; no child PID or child identity was recorded and its output files
were empty. Backup correctly refused to proceed while that launch session was
unfinished. After cancellation was requested, the public recovery path closed
the durable activity as `cancelled` with the message `launch preparation was
cancelled and recovered after supervisor exit`.

The cancelled preparation did not change immutable installation verification,
the canonical persistence probe, or the healthy backup. It is retained here as
an interrupted-setup recovery observation, not counted as successful native
launch, gameplay, persistence collection, or restore evidence.

## Result and limits

The bounded automated lifecycle evidence passed for exact v0.5.7-to-v0.6.1
update, exact retained-version rollback/reactivation, immutable verification,
and canonical persistent-state and backup preservation. The final isolated
state had v0.6.1 active, v0.5.7 retained as the previous installation, no staged
installation, a current verified source, and no game process running.

The following remain explicitly not run or unclaimed:

- native v0.5.7 launch success;
- runtime projection, collection, or backup restore during this cross-version run;
- hands-on gameplay, controls, audio, and in-game save/load;
- physical-device behavior;
- Linux and macOS installation or native execution; and
- signed upstream provenance or production signing/publication.

The earlier v0.6.1 qualification record remains the authority for its exact
responsive native launches, collection, backup/restore, removal, and reinstall
observations. Neither record broadens support or compatibility badges.
