# Gen1 shared managed fitting — October 28, 2026

This dated observation belongs to [#2926](https://github.com/boburning/portcove/issues/2926)
and parent [#2510](https://github.com/boburning/portcove/issues/2510). Its
[machine-readable packet](gen1-managed-fitting-2026-10-28.json) records seven
existing affected-312 identities, their actual common runtime contract and precise
resume conditions. It adds no frozen identity, operational definition, Supported
claim or live status authority.

| Canonical owner | Identity          |
| --------------- | ----------------- |
| #2866           | Pokémon Blue      |
| #2867           | Pokémon Yellow    |
| #2871           | Pokémon FireRed   |
| #2872           | Pokémon LeafGreen |
| #2873           | Pokémon Ruby      |
| #2874           | Pokémon Sapphire  |
| #2875           | Pokémon Emerald   |

The delivered upstream guides and #3888 non-owning Windows definitions remain
components of these canonical issues. The player owns replacement and all
external files. Registration and registration-only removal do not grant managed
backup, restore, update, rollback, deletion or complete-session qualification.
The remaining managed fit has a concrete shared upstream dependency.

## Published runtime and evidence boundary

The official [Gen1 Recompilation Project release](https://github.com/bryanthaboi/gen1recomp/releases/tag/v0.3.97) was reread as v0.3.97, source
`1eba2cf5821e770ba21ef409682f834a38ff5c01`. Windows asset 678789547 is
39,650,119 bytes with publisher/computed SHA256
`e05472b4fd5fd1a2fb56343990f1ec57fc88f0d424baafbda8f50dc5e1cbea01`.
Bounded ZIP/AMD64/fused-ZIP inspection binds eleven selected Lua modules to their
Git-blob-verified tagged sources. This covers the restart implementations,
ordinary callers, portable helpers, configuration and main loop. It does not
establish whole-package source-to-binary equivalence or execute the player.

Six isolated checks execute the embedded HostShell Lua with controlled platform,
environment and fused probes and mocked spawn/quit calls. Managed Windows still
dispatches spawn followed by plain quit, including with the main-loop flag true.
Unmanaged, failed-spawn, non-fused and Android controls distinguish the branches.
These are source/mock observations, not native process or gameplay observations.
The retained failed extraction/path attempts and capacity timeout are not passes;
the final module binding and dispatch check have separate receipts.

## Full session is a separate contract

The delivered [updater ownership guard](gen1-updater-ownership-2026-10-28.md)
correctly suppresses Boot/Check/Prelaunch updater payload replacement through
`POKEPORT_PORTMASTER_MANAGED=1`. It does not guard ordinary restart callers.

At the pinned source, ManagerState's ordinary **Apply & Restart** reaches the
real `Game.restartWithMods` or `Game3.restartWithMods`; both call
`HostShell.restart`. GBA's explicit exit also reaches main's `returnToLauncher`.
For fused Windows, HostShell calls `WinApi.spawn` and then quits the original
process. Spawn uses `CreateProcessW` with detached/new-process-group flags, closes
the returned handles and returns without waiting. The separately implemented
`WinApi.run` wait does not apply to this call.

`--game` prevents the ordinary window-close return path; it does not fence those
other controls. HostShell checks the loop-restart flag for Android, while its
fused-Windows branch still spawns. Core's game supervisor waits the original
child before collecting managed data and completing its session. Preparation
tool process-tree supervision is separate and cannot supply game-session proof.

Resume through an upstream supported process-preserving or waiting restart
contract, or a separately qualified shared successor-session authority. Verify
ordinary mod restart and GBA return, interruption, recovery and final drain;
normal Quit alone cannot qualify that boundary. Do not add per-title supervisors.

## Portable helpers do not relocate every writer

SaveData explicitly distinguishes LÖVE's OS user-profile save directory from its
own executable-adjacent portable filesystem. CacheFs also offers supported
portable cache coordinates to its callers. Main's `relaunch_to_launcher.txt`
still uses `love.filesystem` directly, with the identity selected by conf.lua.
That is a specific external writer; a portable marker alone does not establish
one private root for every writer.

Current source also adds versioned save-slot namespaces and options backup/staged
files beyond Red's earlier declared paths. The packet names evidenced deltas,
not a completed writer inventory. Extending a path list cannot relocate an
external writer, transfer populated ownership or establish successor closure.
For the proposed Core-owned private-profile route, require a supported contract
covering every promised writer. Alternatively assess the existing NativePortable
external-user-owned profile contract, with exact compatibility, ownership,
separate consent and unavailable managed-data operations. The external marker
does not rule out that alternative. Finish the chosen writer and per-title
original/source coordinates and qualify the offered preservation and maintenance;
both choices still need the full-session lifetime prerequisite.

## Preserved scope

Historical Red [#98](https://github.com/boburning/portcove/issues/98) retains its
actual September Windows acceptance and creating contracts. This investigation
does not reopen that historical completion or move existing data. Current
v0.3.97 maintenance remains separately unfinished under #2926/#2510.

Gold, Silver and Crystal remain separately owned research; this seven-title
decision grants them no completion or inherited Red qualification. No ROM,
original game, helper, native player, populated profile or gameplay was executed
in this inspection. No populated adoption, persistence shrinking, save conversion,
Supported promotion or resolution of the six retained Direct decisions follows.

After the shared prerequisites are satisfied, each canonical owner still needs
its exact original identity, executable selection, private setup and offered
operation evidence, independent review, required exact-head checks, guarded
delivery and individual reconciliation. Later discoveries do not enlarge the
frozen cohort.
