# Ring Out direct player — October 30, 2026

This finishes the independently permitted prepared-runtime route in canonical [#148](https://github.com/boburning/portcove/issues/148) under #2510/#2926/#1422. Its existing `soulcalibur-ii-ring-out` identity belongs to original-524/frozen-858 and the overlapping historical 316 identities. One useful route is selected. A strict user-selected definition reuses existing Core operations; no family primitive or production Core behavior changes.

## Exact user handoff

Finish supported upstream preparation outside Portcove with your own permitted Soulcalibur II USA `GRSEAF`, NTSC-U revision 0 original, and establish a working prepared copy. Select `<root>/bin/moderngekko-run.exe`, the complete package root as CWD, and six **literal argument tokens**:

```text
--user-dir
<absolute root>/userdata
--game
<absolute root>/game
--module
<absolute root>/bin/gGRSEAF_recomp.dll
```

Substitute actual absolute paths; preserve spaces inside each token. These are explanation placeholders, not expansion syntax. The generated DLL is executable code loaded into the selected runner. The user's consent covers the permitted prepared runtime/module and chosen coordinates. Core validates the selected execution intent; it does not authenticate that DLL, original disc revision, build provenance or every component.

Do not select `RingOut.exe`, PowerShell, setup, compiler or `--extract` tool mode. The wrapper invokes setup if the game/module is absent; the selected direct runtime does not invoke that preparation path. Explicit paths also bypass `default-game.txt`, `STATICRECOMP_MODULE` and fallback module discovery. Re-review and re-consent to changed paths when relinking or moving a prepared copy.

Registration/relink and retained intent across restart, separate Play with selected-process observation, and registration-only removal preserving every external file are the offered operations. Upstream/player own preparation, repair and runtime replacement (`user-managed-update`). Close all actual players and preserve working runtime and data before upstream changes. Managed acquisition, Install, Update, Backup, Rollback, migration and external deletion remain unoffered. Stable denotes this registration contract, not a pinned stable game package; beta does not mean Supported.

## Current source and artifact evidence

The [machine-readable companion](ringout-selected-player-2026-10-30.json) binds the complete, untruncated 32,904-entry tag tree and 15 inspected source blobs with recomputed Git object and content hashes. Reviewed tag `v1.7` is commit `ec464ef01c6f6872a72090cc5541700e6c71158a`.

[ModernGekko's runner](https://github.com/jackpoison-prog/RingOut/blob/ec464ef01c6f6872a72090cc5541700e6c71158a/ModernGekko/tools/moderngekko_run.cpp) parses the explicit user/game/module paths, inspects game metadata and loads the requested generated module. The normal runtime runs until shutdown; replay sessions rebuild in the same process. [Runtime shutdown](https://github.com/jackpoison-prog/RingOut/blob/ec464ef01c6f6872a72090cc5541700e6c71158a/ModernGekko/src/runtime/dolphin_runtime.cpp) stops/joins its title thread and shuts down the Core session. This is source fitting, not actual game execution or proof for every netplay/replay/tool mode.

Distinct v1.7 asset 683234794, `RingOut-1.7-windows-x64.zip`, is 242,240,570 bytes. Its published SHA-256 `23ab7008a492c87830ef0459e54bbe1106c1989059659e82b34dcf0ef1254ae6` matches the actual October 30 read-only download. Static ZIP inventory has 11,630 entries and 812,907,062 expanded bytes. `RingOut-1.7/RingOut.exe` (17,920 bytes) and `RingOut-1.7/bin/moderngekko-run.exe` (13,273,600 bytes) have AMD64/PE32+ headers. No executable, setup, extraction or original-game preparation was run. Filename inventory is not an exhaustive original-content or component-rights certification.

The historical v1.6.1 same-name asset changed from 235,915,548 bytes/SHA `9754bf46f44be90c0912adef2f48c70e1b24cd615e23077ee4fb2c30ba548f2a` to 235,916,579 bytes/SHA `51ddeac206c2f0e7810cd4a2b848ad184341c4556c1b7b3d878da949de16d801`. This gap stays historical; v1.7 is a different publication, not continuity manufactured by rehashing/reinstalling old bytes. No old prepared-module/state compatibility is inferred.

The current tagged README positively states GPL-2.0-or-later engine licensing and vendors matching-source trees; preserve upstream and component attribution/notices. DolRecomp is a separate GPL-3.0-or-later build tool, not an original-game license. The package's CREDITS identifies itself as Ver 1.0 and refers to absent `source/` archives; its README identifies Ver 1.1 and gives Linux commands. These stale files are not fresh source/binary attestation. This route uses an already permitted prepared copy and grants no blanket package, component, original or generated-code redistribution permission.

The canonical retained original observation identifies a 1,459,978,240-byte normalized ISO, SHA-1 `49f281fbe7086a4eb400a03c869fcac5f90df55a`, SHA-256 `484013b0347d63e44efe4583105f08a533653314ecd081451ebc45100546b758`. This is the prior traceable source observation, not a fresh source acquisition, preparation or native run in this batch. Core offers no disc normalization/authentication here. Unknown other variants/platforms are not Unsupported claims.

## Data and ownership

Preserve the complete tree: `game`, `bin` and the generated DLL, `art`, `module-src`, `work`, `userdata`, originals and all actual custom locations/unknown files. The explicitly selected userdata directory owns frontend config, Dolphin Config/GC memory-card data, StateSaves, Screenshots, Logs, shaders/cache, Replays and Load/Textures/Mods. Runtime startup creates profile directories and can update configuration. Default profiles vary with build/platform/environment if `--user-dir` is omitted; preserve any prior LOCALAPPDATA, XDG/HOME or working-directory profile too. Choosing a different location does not migrate old data.

Configured paths, mods, texture packs, replay paths and other custom outputs remain external/player-owned. This route is not a sandbox, exhaustive write inventory, backup/retention guarantee or state-compatibility claim. Upstream setup can write generated game/work/art/bin/userdata and external shortcuts; it stays outside Portcove's execution path. No automatic preparation, compilation, source conversion or publisher-side writes are added.

## Selected acceptance and evidence limits

The existing operative issue minimum allows independently permitted prepared registration/launch through current Core without waiting for #137. The five selected acceptance rows are exact useful handoff; applicable non-owning admission/consent checks; retained selection/relink and Play; preservation and one replacement owner with truthful operation availability; independent qualification/guarded delivery/canonical reconciliation. Full managed preparation and its broader lifecycle tests remain conditional on offering those operations; their historical wording does not authorize an unimplemented managed route.

`ringout_route_148` runs the existing production registration/relink/restart/Play/preserving-removal contract against the actual catalog identity using a repository-owned inert native probe. Six path-bearing literal arguments, including spaces, are retained without interpolation; the probe observes those bindings. It does not load a generated DLL or prove an actual game run. Existing adversarial coverage checks token/intent drift, executable changes, old-reader refusal, preservation and unoffered operations. Actual game execution/gameplay, generated-module ABI, save/load, netplay, installed Desktop/protected delivery and other platforms are not evaluated by these fixtures.

Selected denominator remains one route until independent review, exact-head required CI, guarded merge, remote readback and individual canonical/Project reconciliation complete. Zero new listing/frozen identities are added. The historical 317 rows/316 identities overlap frozen858; these inventories are never added.

The earlier exact-head run 41076336853/a1 passed the named Ring Out operation
case, but Windows partition7 cut the unrelated
`service::tests::publication_recovery_retains_conflicting_source_import_intent`
fixture at60.295 seconds. Its first seven scenarios completed; final
Adopt/CleanupPending began at54.365 seconds. The exact Windows case receives
the existing finite90-second harness allowance ahead of its60-second family
rule. All eight scenarios, product deadlines, resource slots, cleanup and zero
automatic retries remain unchanged. Existing configuration regression coverage
checks exact platform/identity/budget/precedence. This establishes completion
under that budget when freshly qualified, not a performance improvement or
causal product repair. The failed producer and prior invalid-hint record
failure remain retained.

The same run's Windows partition3 also retained a30.126-second whole-case
timeout in `runtime_path_policy::tests::move_previews_check_retained_policy_before_creating_destinations`.
The identical two-case assertions passed21.846 seconds in41069532772/a1.
Only that Windows fixture receives finite60-second diagnostic room and
per-case registration/library-preview/output-preview/assertion timings. Its
assertions, filesystem refusal/preservation checks and product limits remain
unchanged. The configuration oracle explicitly retains both new scoped rules
without broadening defaults or dropping any prior override expectations.
