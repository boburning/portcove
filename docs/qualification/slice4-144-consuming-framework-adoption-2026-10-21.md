# #144 consuming-game framework adoption — 2026-10-21

This is an unpublished source contribution and local framework-test receipt. It does not qualify a game package, grant upstream submission, or admit the title to the compiled catalog.

## Frozen sources and contribution target

- Game: `mstan/MegaManX4Recomp`, base `60acc03e862c2cd75d72a4a7605faa546cc4c0c2` (public annotated `v1.0.0`), prepared commit `92ab0848c9dda3a23180bbc90a6f5afcacff1c9e`, tree `7f39672d146a7e4f421735c9ce3fac3a1d8444c4`.
- Consumed framework: `00f484fee6ace3f7f73420f0d60b0235d23af176`; prepared fork-lineage commit `8c65e235a1473f01410da18a1bd872800289a925`, tree `4f9a1ad91042f309be23f68de66bbffe371ade4c`.
- Framework patch is the exact conflict-free cherry of `572558394b5b737690138f8374c80b032c3d84ba`, merged upstream via psxrecomp#685 as `ac71aec441b9fa6382e687dd412fc228d9ef7f3f`. Stable patch ID matches: `132bcc399628b3368dec7c612d7fb29eb918584d`.
- Replacing the game fork wholesale with ac71 would cross a divergence (241 upstream-only and 22 game-fork-only commits). This focused cherry preserves the consumed fork; recomp-ui remains exact `b964eabe5a3438b8ed121064354ba27c1accef3f`.
- Framework contribution target is the declared `mstan/psxrecomp` submodule upstream (currently canonical RetroPortingToolKit/psxrecomp); game contribution target is `mstan/MegaManX4Recomp`. Both patches remain local. The framework commit must become available through the declared submodule source before the game gitlink is publicly reproducible. No arbitrary alternate URL is introduced.

Game patch changes only the gitlink, both next-build version inputs (proposed v1.0.1), release notes and the concrete rebuild checklist. The five-file framework repair keeps generated defaults ephemeral, preserves explicit selections and includes no legacy absolute-path migration. The current exported contributions are [framework patch](patches/slice4-144-consuming-framework-portable-defaults.patch) and [complete game series](patches/slice4-144-consuming-game-portable-defaults.patch); exact sizes, hashes and tested-versus-final source identities are in the [public manifest](slice4-144-consuming-framework-adoption-2026-10-21.json).

## Executed checks

- Existing `tests/test_release_config.py`: 6 PASS, 0 failures, 0.030s child; admitted analysis total 53,674ms. Exact game commit as above.
- Fresh own C++ proof build uses exact framework8c65 and actual game's recomp-ui b964 launcher header; maintained package/runtime target source lists, Release, Clang22.1.8, vendored libchdr with offline dependency mode, at most two jobs. Both targets compiled successfully: 42 build steps, admitted total45,404ms.
- Actual `mod_packages_test.exe`: PASS, SHA256 `a5fdf98780a40f632dfb9889e74d2607e225855878c6e394f06436c18280c681`.
- Actual `mod_runtime_test.exe`: PASS, SHA256 `550f94dc3f43bd829374748f589e6c955140c348c9ca1f49d0c9de566d10a5b0`. Includes the original portable relocation/disabled-default/getter/resolver/cwd/explicit-selection/containment assertions and launcher integration.
- Both tests ran in a new isolated TEMP under the existing resource supervisor; combined admitted total15,039ms, exit0. Raw stdout/stderr and identities are retained locally under `E:/Codex-Worktrees/534-metadata-recovery/Portcove-Development/work/slice4/144-consuming-adoption-2026-10-21/`; they are not public artifacts or game packages.
- Initial configuration failed because unquoted PowerShell -D drive paths were split; original `cpp-configure.log` retained. Quoted argv configuration succeeded in `cpp-configure-2.log`; no product/source workaround.
- Both repositories clean; diff whitespace checks passed. Beta's independent nonwriting review CLEAR applies to game92ab084 and framework8c65, with no reviewer execution.

The earlier same-size/restored-mtime file-identity failure at a different framework source remains in its original retained logs. Passing this current fork suite does not erase or relabel that result. Pure explicit-missing-path getter/resolver assertions do not by themselves prove the full real game initialization behavior; the two real-artifact/native path case must observe that behavior.

## Real artifact status and next path

Fresh public release v1.0.0 is release420007858 at game60acc, annotated tag object3821a7ba5ad657dff009bda54dfe5ce4c0d09d8b. Its Windows asset663658987 is `MegaManX4Recomp-v1.0.0-windows-x64.zip`, 36,291,201bytes, provider SHA256 `2d6863b02a0baf32900b257d65b4607b580e0f9cb17e2964b3217582e541b68c`. Its consumed framework00f still lacks the portable-default repair. This is source/provider metadata inspection only; that ZIP was not downloaded or run.

The prepared rebuild path is documented in the game patch: retain the patched framework, use the owned USA SLUS-00561 source and ordinary regeneration, fresh production Release build at jobs2, then the existing non-destructive `tools/package_coop_playtest.py` with version/executable/manifest/mod/private-data gates. Proposed first genuine artifact is v1.0.1 from game92ab084 (or its actual maintainer-adopted exact successor); proposed second is a genuinely rebuilt ordinary v1.0.2 from its own future exact source. The second source/tag/asset does not exist in this preparation and is not invented. Record each actual source/tree/framework, full build log, executable/execution manifest, package digest and immutable provider asset identity. No test executable or renamed ZIP can substitute.

After the two fixed real packages exist, observe ordinary Core materialization/install/update/rollback plus complete retained state and moved-install default behavior with old installation unavailable, disabled HD, committed enabled HD, changed cwd, and explicit unavailable external selections. The earlier real .35/.36 full-default-persistence failures remain failures; .42/.43 and newv1.0 retain unpatched source scope. Gameplay/audio/controller/in-game save/load and protected acceptance remain separate.

## Exact submission route resolved before proposal freeze

Declared submodule URL `https://github.com/mstan/psxrecomp.git` redirects to `RetroPortingToolKit/psxrecomp`. The live `commits/00f484fee6ace3f7f73420f0d60b0235d23af176/branches-where-head` response names `feat/native-font-localization-20261020`, and `git ls-remote` through the declared URL reports that exact branch at00f. Raw branch evidence is retained beside this receipt.

The precise framework proposal is existing fork `boburning/psxrecomp`, topic `feature/portable-generated-default-adoption` at local8c65, PR base `RetroPortingToolKit/psxrecomp:feat/native-font-localization-20261020`. It is a consumed-branch backport, not a duplicate proposal to master (where685 is merged). No wholesale branch replacement or claim that all fork functionality exists in master is needed.

The game proposal is future fork `boburning/MegaManX4Recomp`, topic `feature/portable-generated-default-adoption`, PR base `mstan/MegaManX4Recomp:master` exact60acc. The contributor game fork currently returns404; creation and all pushes/PRs remain unperformed. First land/publish the backport in the declared framework repository, read back its actual accepted reachable SHA, and then pin that exact SHA in the game proposal. A squash may change8c65's commit ID; matching source/patch identity must be checked before reusing results.

Doc-only follow-up `afed1cb717f51b5b6fc15a92cbace0f7cdeeae11` (tree `9594c961112d54175e642a905fb2cd926edb8684`) records this route atop tested92ab084. All production and test bytes remain identical to tested92ab084/8c65. Separate nonwriting reviewer `beta_profile_review` cleared both the original source and this subsequent documentation-only delta. The exported complete game series contains both game commits, 12,282bytes, SHA256 `9b876a37b65771859f5b1d48eb7c541ff59d133b104886343256ca1d4cb69ba3`. The original private game.patch/patches.json remain the earlier snapshot; the linked public manifest identifies the current complete proposal.

## Exact outstanding external action

Authorize submission and ordinary follow-up of these two focused contributions: push the framework patch through the existing `boburning/psxrecomp` fork to `RetroPortingToolKit/psxrecomp:feat/native-font-localization-20261020`; once that patch is reachable through the declared framework source, create the `boburning/MegaManX4Recomp` fork and submit its consuming gitlink/rebuild contribution to `mstan/MegaManX4Recomp:master`. Both topic branches are `feature/portable-generated-default-adoption`. Reconcile changed upstream heads and the actual landed framework SHA before posting the dependent game patch. This is new external communication; the earlier psxrecomp#685 submission grant does not itself grant these contributions. No new catalog or curated-policy decision is requested.
