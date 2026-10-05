# DKC3Recomp Windows prepared-runtime evidence — October 5, 2026

This receipt concerns the bounded non-owning route for canonical [#723](https://github.com/boburning/portcove/issues/723), consuming the existing positional-source capability under [#136](https://github.com/boburning/portcove/issues/136). It does not complete the broader generic adapter or the [#1422](https://github.com/boburning/portcove/issues/1422) cohort. Runtime, startup, save/load and gameplay remain **Unknown / Not tested**. No upstream executable, setup, game ROM, generator or proprietary materialization was executed.

## Exact inputs and source audit

The direct upstream `elliotttate/DKC3Recomp` tag `v0.0.6` resolves to `3a033f19801a2bd3abf784d4b29c4462495d19de`. Its release inventory separately contains the older macOS arm64 v0.0.4 artifact; that platform receives no Windows evidence or offered route here.

| Input | Identity |
| --- | --- |
| Windows archive | `DKC3Recomp-v0.0.6-windows-x64.zip`, 6,009,000 bytes |
| Publisher GitHub archive SHA-256, freshly matched locally | `b4965c2cb6d13ce972bc72796e15840d1c1c50e9cb28c748ff213ae145f75e11` |
| `DKC3Recomp.exe` SHA-256 | `259c2acbac636f298c502b2ef562fd427332c7d0c657c0c5bfb20eac6c54fe48` |
| Production Core immutable extracted-tree SHA-256 | `3b8e1a483ada9a544a084717eba4eeb5c8f4b7168cda85b3697776f1a0dacdee` |
| Required original source | Headerless North American En/Fr Donkey Kong Country 3, 4 MiB, `.sfc` |
| Required original-source SHA-256 | `2277a2d8dddb01fe5cb0ae9a0fa225d42b3a11adccaeafa18e3c339b3794a32b` |
| `snesrecomp` submodule | `3b24b9daae623cd66a14e1ecf8483f0b0d2be91b` |
| `recomp-ui` submodule | `ad2f3e293c6641c93ee69963dd669661f3e40290` |
| Nested `recomp-net` submodule | `6d848d6f9a7269d511e6e97d943c2ef0774779b0` |

Fresh ZIP inspection found 21 regular members, with no rooted/traversal/symlink member. The extracted package contains the unsigned EXE, SDL2.dll, assets, README and license notices; no ROM or saves. Neither this inspection nor a local hash creates arbitrary-download authority: the archive digest matches the direct publisher release metadata.

The exact [Windows host](https://github.com/elliotttate/DKC3Recomp/blob/3a033f19801a2bd3abf784d4b29c4462495d19de/runner/desktop_main.c) reads its optional positional source before anchoring state beside the EXE. The ordinary upstream launcher can replace that source selection. The definition therefore uses upstream's supported `SNESRECOMP_NO_LAUNCHER=1` switch; the in-game settings interface remains available. The [source verifier](https://github.com/elliotttate/DKC3Recomp/blob/3a033f19801a2bd3abf784d4b29c4462495d19de/runner/verified_rom.c) verifies the exact 4 MiB payload after optional upstream header stripping. Portcove deliberately admits only the exact headerless original; it does not strip headers, copy, normalize, generate or stage ROM bytes. The Windows host uses `MAX_PATH` and system-code-page conversion, so preparation guidance asks for short paths representable in that code page. This is a scoped upstream path limitation, not a promise of arbitrary Windows Unicode-path compatibility.

## Ownership and output coordinates

Core's existing `UserPreparedRuntimeSpec.source_argument_extension` and `prepare_launch_for_external` pass the admitted original path positionally after use-time revalidation. No new adapter, schema, permission or lifecycle framework is needed. The September assessment that adapters could not pass this positional source applied to the managed route; the October 5 canonical correction preserves the formal #723→#136 relationship and broader managed/private-state scope.

The prepared folder remains outside the Portcove library. Both launch working directory and upstream executable anchoring resolve to that player-owned folder. Its seven mutable roots are exact inspected default outputs, not blanket permission to alter arbitrary package content:

| Relative path | Pinned source responsibility / classification |
| --- | --- |
| `saves/` | `desktop_main.c`, `desktop_paths.h`, `headless_host.c`, and snesrecomp `common_rtl.c`: SRAM `save.srm`, backup rotation `save.srm.bak`, legacy/slot states including `dkc3sN.sav`; player-owned persistent data |
| `launcher.cfg` | `desktop_launcher.c`: launcher/in-game settings; player-owned configuration |
| `rom.cfg` | `desktop_launcher.c` and WinMain: external original-source path reference, never ROM bytes; player-owned configuration |
| `performance.log` | `desktop_main.c`: optional performance logging in the same working directory; player-owned diagnostic data |
| `diagnostics/` | `diagnostics.c` sets snesrecomp `host_report.c` output directory: report, temporary report, crash minidumps and bounded diagnostic bundles; player-owned diagnostic data |
| `keybinds.ini` | pinned recomp-ui SNES binding store; player-owned configuration |
| `.snesrecomp_write_probe` | pinned snesrecomp `host_paths.c`: normally removed writable-directory probe; possible interrupted residue, reviewed disposable game output |

EXE, SDL2.dll, assets and notices remain immutable. The Windows ImGui overlay disables its `.ini` file. Setup/codegen, mod-management and non-Windows/headless writers are outside this offered route. Upstream path-configurable diagnostic, recording, frame and trace switches are not added to the definition. Core's existing child-process policy clears the ambient environment and retains only reviewed session variables; those `DKC3_*`/`SNESRECOMP_*` output switches are excluded. The only declared launch environment is the launcher suppression switch.

Inspection refuses symlink/redirection/nonregular mutable entries before omitting their contents from immutable hashing. It is a bounded point-in-time validation of player-owned data, not an atomic filesystem freeze or a runtime sandbox. Unknown files refuse later verification and remain preserved. Registration removal does not inspect, replace, back up or delete external files, including unknown saves or a changed package.

Offered operations are exact prepared-folder review/registration, source registration, launch through the existing supervisor and removal of the registration. Maintenance is **user-managed-update**. Managed acquisition, installation/setup, update, replacement, backup, rollback, relocation and external deletion are unavailable. No N/N+1 or managed preservation claim is made. Future managed-compatible progression remains with #246 and requires immutable accepted release pins and compatible ownership evidence.

## Rights boundary

The root project is MIT; the pinned snesrecomp runtime is **PolyForm Noncommercial**, recomp-ui and nested recomp-net are MIT, SDL2 is zlib, ImGui is MIT, and package notices identify OpenMoji CC-BY-SA 4.0 and Noto OFL 1.1. The archive includes Lato font files; its font notice does not separately identify their license, so this receipt does not assert complete font licensing beyond the inspected notices. Keep all package notices and applicable upstream license conditions, including snesrecomp's noncommercial restriction. This definition does not redistribute, modify or sublicense the runtime/assets or supply original-game rights. The user's lawful original ROM remains external. No known source/rights conflict is excused by missing optional gameplay evidence.

## Observed checks and limits

The replacement cloud host was isolated with one clean checkout at `6cb3b9e3a1cdbb82f4189dc2b53f38396c11b521`, no other build/runtime processes, and the normal 20 GiB storage guard. Activation verified Node 24.21.0, Rust 1.98.1, pnpm 12.8.1, just 1.58.0 and nextest 0.9.100. Host doctor retained Ruff/actionlint probe timeouts; no denied bootstrap/attestation retry, floor override or cache/evidence deletion occurred. Native desktop prerequisites and Windows execution are not available in this Linux environment.

Fresh production inspector execution used a temporary first-party Core unit-test harness, retained under ignored `work/723-dkc3-evidence/production-inspector-harness.rs`, then removed from candidate source. The unmodified production inspector accepted the exact tree and eight inert mutable-path probes (`saves/save.srm`, `saves/dkc3s0.sav`, all five mutable files, and `diagnostics/last_run_report.json`), refused an undeclared file and changed EXE, and accepted the restored package. One actual test passed; the original log remains `production-inspector.log`. This is package inspection only, not runtime qualification. Earlier environment evidence was not inherited or claimed.

The declaration test first failed with `unknown port id: dkc3-recomp`, then the definition was added and `just test-rust -p portcove-core embedded_catalog_is_valid_and_contains_lighthouse` passed immediately. Inert catalog/service fixtures use redistributable substitute source/runtime bytes with explicitly substituted fixture digests/platform, preserving the actual definition's operation contract. They exercise exact positional binding, literal argument boundaries, original use-time revalidation, wrong/headered/changed/missing source refusals, stale package consent, executable/dependency/unknown-file refusal, containment, restart and ownership-safe removal preserving original/package/settings/unknown saves. Both new DKC3 fixtures passed (two executed tests) after admission. No fixture is a game or executable qualification record.

Final independent source/evidence review, full diff-selected validation, hosted exact-head CI/provenance and guarded Local integration remain separately required. Live Project field writes are outside this lane's allowed API route; canonical catalog identity and stage handoff must use Local's existing guarded readback/doctor path after admission. The issue remains open until its delivered minimum and governance acceptance have matching evidence. The ordinary `generate-catalog.mjs --prepare-proposal` workflow validated accepted/input/output declarations using the freshly built first-party CLI and the unchanged accepted baseline. Its keyed diff contains exactly one added port and the three accompanying source records. All 80 entries were processed: 77 reused mappings, three generated fallbacks, zero selected images; no provider authentication, metadata, image request or image byte was consumed. DKC3 has a functioning generated/text cover with `identity-provider-unavailable` (private provider credentials absent) and `identity-not-declared` for a separately attributable original-game provider identity. Resume cover enrichment when that provider capability and exact identity facts are available; the fallback does not hold this route. Detailed unsigned proposal/artwork receipts remain under ignored `work/723-dkc3-evidence/prepared-proposal/`. Final exact-head results are recorded in the candidate handoff; no Supported or publication claim follows from this receipt.
