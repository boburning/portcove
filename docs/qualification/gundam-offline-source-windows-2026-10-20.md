# Gundam Wing Endless Duel: pinned offline Windows source route

Owner: #330; narrow capability owner: #136. Fixed slice 6B builder pair.

## Current evidence boundary

Authenticated private generation, configuration, compilation, linking and import
inventory passed. The resulting game has **not been executed**. This snapshot
does not establish actual Core installation, native startup/ordinary close,
runtime write inventory, maintenance, removal, catalog admission or user delivery.
Those remain necessary engineering and acceptance, not exclusions.

## Exact inputs

- Game source `TechnicallyComputers/GundamWingEndlessDuelSNESRecomp` commit
  `c7aaaa152192db5d750db3fb190e8f93b6240c19`, tree
  `9dedda7d4e931d21453717d3e8a06bb5d5d5e333`; ZIP 3,363,589 bytes,
  SHA256 `bfe295943d83d144def7f355ac47f04fd90fb5bd2000ca0217e7874dfc33c2ee`.
- Its pinned `RetroPortingToolKit/snesrecomp` commit
  `f68aa0fe8edae75cbc7d4b9473c71687b45ce702`, tree
  `567b739d3592264c7b34214b28c7d4c8538cf808`; ZIP 6,052,919 bytes,
  SHA256 `c30639794a0c713bfcbdf2abeb10576fe8c532201b481af02bd3eab42904026f`.
- Pinned `RetroPortingToolKit/recomp-ui` commit
  `0546fbcb0126bb14bf88d2128b4fe8a4229570a3`, tree
  `6b083ae3398ba5e2dacfe2c28756fb37de39b85b`; ZIP 5,075,056 bytes,
  SHA256 `829bf3f3863030a690f33084530024cec6411cc8c5ddfa6a514e89519ced3a68`.
  Only the two real frame-blend/flash-guard C implementations and their headers
  enter the derived project. The GUI launcher is absent.
- SDL2 2.32.10 MinGW SDK: 14,260,563 bytes,
  SHA256 `f15cff5fca62ec9381a016ef1d42a95c638cd72d2f226ba5781c76fe43dbd1ac`.
- RetroPorting Toolchains v1.0.14 Windows x64 archive: 209,497,009 bytes,
  SHA256 `28da9742385e7ff875b3d9311e8ed89dbdc84f27b6ecba2bc0d0acc11f6d2b4d`.
- Official game setup kit v0.1.11, release416704600/asset654451677:
  225,468,722 bytes,
  SHA256 `03f470fb6585db9cba174548257b643430efba51fe0964b65ce108c50e50424a`.
  Bounded metadata preflight saw17,918 entries/861,214,509 expanded bytes before
  ZIP construction. The selected analyzer directory contains one file:
  `snesrecomp-analyze.exe`, 1,306,624 bytes, AMD64,
  SHA256 `bc1d908cfcf4199d5cb9001ba6be9d18059ef5291788705bf34fadfb3f4f2414`.
  Its exact imports are bcryptprimitives.dll, api-ms-win-core-synch-l1-2-0.dll,
  KERNEL32.dll and ntdll.dll. No setup executable was run.
- Owned raw Japanese original: 2,097,152 bytes, CRC32 C0AECDCA,
  SHA256 `dd94308d822636c6ddf73c5e2644c84f2eb8fb4d9201150fc5f37d44d6f423f1`.
  No copier-header removal or different revision is accepted.

Source archives were authenticated against complete Git trees and every selected
regular blob. Four declared launcher/network/rollback gitlinks were not fetched.
The separate UI tree contains no links or gitlinks. These identities establish
the selected private build, not a binary redistribution permission.

## Closed offline build

The original root CMake enables network/mod features forcibly. The fixed project
instead disables launcher/setup, netplay, Lua, optional mods, trace/co-simulation
and dependency fetching. It explicitly declares the framework's `NONE` mod
catalog. Optional mod-only presentation/diagnostic hooks are inert; ROM checking,
emulation, save handling and lifecycle functions remain real. The real
state-digest implementation is linked without its optional network transport.
The host's parent-directory configuration fallback is removed by an exact
preimage-bound patch. Its optional mod/network identity logger is replaced with
an accurate stock-offline build message.

The pinned generation recipe has `cfg_roots=true` and no prepare/postprocess
hooks. The package-authenticated analyzer completed native analysis in0.004s;
the generator emitted8 C files. The final configured graph contains86 objects:
78 independently counted fixed inputs plus8 generated inputs. Compiler groups
contain at most8 objects with2 workers; graph identities and input inventories
are checked before/after compilation. The existing finite20-minute builder,
worker drain, locking, activation and recovery mechanisms remain unchanged.

Private compileA3 passed with an876,032-byte AMD64 PE, SHA256
`dabc9ca09369c6e9b12ce2bf0509f4783a232920c0146d29573f1e28793454f2`.
Its observed imports fit the existing runtime allowlist. It was not executed.
Evidence root: `H:/pc6-qualification-20261019-a3`; source, configuration,
compilation, request, log, graph and input manifests remain there.

## Preserved failures and focused checks

- GenerationA1 passed; configuration failed because its private harness supplied
  a forward-slash `cmd.exe` path. Inert OS-shell controls isolated that cause.
- ConfigureA2 stopped at a collector assertion that expected a completion marker
  on stdout; the authentic marker was on stderr. No generation was replayed.
- A3 corrected the shell path and exposed an incorrect private SDL2 root; A4
  corrected that root and exposed the framework's explicit mod-catalog guard.
- A5 declared `NONE`. CompileA1 then exposed an unconditional optional-mod identity
  call. A6 applied the exact offline log patch; all85 objects compiled, but link
  failed for the missing real state digest. A7 added that source; compileA3 passed.
  Each changed project/build uses a fresh copy; earlier failed trees remain.
- The independently frozen pre-change four-input storage oracle passed before
  and after the Vec refactor. The Advance Wars hash uses an explicitly inert
  source digest; it does not establish an owned original or title acceptance.
- Focused Core checks passed28 cartridge,16 capability,17 entry,15 projection
  and4 path-policy tests;4 actual CLI capability-contract tests passed. Rust
  transport generation passed. TypeScript generation first refused the fresh
  worktree's missing dependency; pinned frontend bootstrap and a collector-only
  resume completed TypeScript generation and catalog checking without replaying
  the successful tests.

Capability14 at API75 distinguishes the new closed recipe. Render13, TFE12,
Windows-path11 and older fixed-source9 meanings remain intact. Configuration
may include other data files; no OS sandbox or ownership of external data is
claimed. Optional gameplay, audio quality, controller/save-load observations,
minimum Windows, installed Desktop and protected #246/#534 delivery stay separate.
