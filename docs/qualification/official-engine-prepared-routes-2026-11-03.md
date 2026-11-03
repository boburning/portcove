# Official engine and prepared-player routes — November 3, 2026

This candidate changes nine canonical ports under #1422/#2510/#2926. The
[dated evidence packet](official-engine-prepared-routes-2026-11-03.json) binds
authored records, upstream revisions, artifact evidence, operation controls and
limits. Issues and the live Project retain acceptance and planning authority.
The PR owns final review, executed qualification, delivery and remote readback.
No outcome is completed by this evidence-preparation checkpoint.

## Per-port scope

| Canonical port / issue                                                               | Actual route and change                                                                                                     | Evidence and validation                                                                                                                                                                           | Remaining limits                                                                                                                                                                                | Full finite closure after delivery                                                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| EarthBound / [#173](https://github.com/boburning/portcove/issues/173)                | Completed upstream `build/EarthBoundRecomp.exe`, project-root CWD and one original-path argument.                           | Pinned README/CMake/runtime source; individual `prepared_guide_adoption_173_project_working_directory` control.                                                                                   | LLE-first prototype; no complete static-recompilation or gameplay claim. Preserve historical failed/private managed evidence and configured data.                                               | Conditional on the owner's complete selected-route acceptance and actual qualification.                              |
| Gundam Wing: Endless Duel / [#330](https://github.com/boburning/portcove/issues/330) | Completed game executable; `--no-launcher` and the matching Japanese original path; upstream generation/build stays manual. | Pinned setup/game dispatch and configuration source; individual `prepared_guide_adoption_330_completed_game` control.                                                                             | Setup host is a different operation. Preserve original identity, full project/config/keybinds/state paths, historical failures and retained managed readers.                                    | Conditional on complete prepared-game operation evidence and accepted delivery.                                      |
| OpenCE / [#1849](https://github.com/boburning/portcove/issues/1849)                  | Existing `halo.exe`; current build337 setup, updater and Windows profile guidance.                                          | Current source binds updater successor behavior and Windows AppData default; individual `prepared_guide_adoption_1849` control.                                                                   | Own Xbox data required. Updates run outside selected Play; relink changed bytes. Old build276 package evidence stays historical.                                                                | Conditional for the bounded upstream-owned route; no managed-lifecycle claim.                                        |
| SDLPal / [#1878](https://github.com/boburning/portcove/issues/1878)                  | New managed official MinGW runtime; explicit relative `sdlpal.cfg`, `data` and `saves` preparation.                         | Refreshed seven-asset release metadata; unchanged authenticated ZIP observation; exact writer source; individual Native lifecycle, provider/refusal and external-registration controls.           | Runtime install does not authenticate originals or enforce readiness. Match DOS/Win95 resources and save formats; custom external paths retain external ownership.                              | Conditional on full managed-operation qualification, review and accepted delivery.                                   |
| Warcraft II / [#1904](https://github.com/boburning/portcove/issues/1904)             | Installed `wargus.exe`, not NSIS setup or extractors; actual local/Documents data and engine profile roots.                 | Pinned Wargus and Stratagus launcher/profile source; individual `prepared_guide_adoption_1904` control.                                                                                           | Original DOS/BNE/GOG and expansion preparation remain distinct. Upstream launcher waits for the engine; arbitrary user binaries are not thereby attested.                                       | Conditional for the bounded upstream-owned route.                                                                    |
| Warcraft I / [#1905](https://github.com/boburning/portcove/issues/1905)              | Installed `war1gus.exe`; exact DOS/GOG preparation and actual data/profile roots.                                           | Pinned War1gus and Stratagus source; individual `prepared_guide_adoption_1905` control.                                                                                                           | Demo/shareware/Mac and prior failed variants do not inherit the DOS route. Preserve shared engine profiles and overrides.                                                                       | Conditional for the bounded upstream-owned route.                                                                    |
| Jedi Academy SP/MP / [#2612](https://github.com/boburning/portcove/issues/2612)      | External MP `openjk.x86_64.exe` with three literal arguments `+set`, `s_UseOpenAL`, `0`; managed SP stays unchanged.        | Retained authenticated package, fresh exact MP source, static imports of nine named MP/dependency components, individual `prepared_guide_adoption_2612_multiplayer_preserves_managed_sp` control. | VC++v14 x64 prerequisite; legacy EAX/OpenAL DLLs are x86. Preserve actual MP homepath/downloads/mods. One installation/registration per canonical ID/library; no MP inside the managed SP tree. | Conditional on completing the full MP assessment and qualification; no managed-MP or network/gameplay certification. |
| Space Cadet / [#2553](https://github.com/boburning/portcove/issues/2553)             | Existing `SpaceCadetPinball.exe`; distinguish working-folder/resource preference and complete shared score/settings file.   | Exact Release2.1.0 source, resource-selection and score writers; individual `prepared_guide_adoption_2553` control.                                                                               | Original resources remain user-owned; runtime folders do not isolate the shared SDL profile or import original registry scores.                                                                 | Conditional for the bounded existing-copy outcome.                                                                   |
| RVGL / [#2705](https://github.com/boburning/portcove/issues/2705)                    | Existing launcher or completed player; precise base/preferences/preset preservation and selected-process lifetime.          | Official launcher/setup/profile documentation; individual `prepared_guide_adoption_2705_launcher` control.                                                                                        | Launcher must remain open during its game session. Upstream repair/uninstall has separate effects; content presets grant no asset rights.                                                       | Conditional for the bounded upstream-owned route.                                                                    |

All named controls are authored at this checkpoint; execution is pending. The
owned native probes exercise Portcove consent, launch intent, supervision,
relink/restart and preserving removal. They never execute upstream players,
original games, installers, extractors, compilers or downloaded mods. Actual
upstream/gameplay, populated-save compatibility and protected/installed Desktop
observations remain distinct and unclaimed.

RVGL's dated primary-document receipts bind the official
[launcher lifetime](https://re-volt.gitlab.io/rvgl-launcher/playing.html),
[base/preferences/profile contracts](https://re-volt.gitlab.io/rvgl-docs/general.html),
[installation and replacement actions](https://re-volt.gitlab.io/rvgl-launcher/installing.html)
and the launcher's source for its Open Data Folder / Open Config Folder actions.
The packet records exact observed content hashes; documentation readback is
separate from a built-launcher or game observation.

## SDLPal: replace the rejected coordinate proposal

The earlier cfg-only proposal and its two independent rejection findings remain
in the [October 26 evidence](classic-engine-managed-and-upstream-routes-2026-10-26.md).
That proposal allowed first-session and later saves to use different roots.
The new manual preparation requires both `GamePath=./data/` and
`SavePath=./saves/` before the first session. Both remain relative across settings
changes, restart and runtime relocation. The player must not browse to an
absolute path belonging to an old runtime. This is supported preparation using
existing Native behavior, without a fabricated completion marker or new
original-input authority.

Configuration stays beside the runtime. Saves and timestamped screenshots use
`saves`. Optional `LogFileName=sdlpal.log` and the generated shader intermediate
resolve under `GamePath`, so `data` includes them; experimental GLSL is disabled
in the documented initial configuration. Other log, shader, mod or absolute-path
layouts retain the existing non-owning route. The pinned Windows implementation
keeps settings and play in the same process. The writer audit covers the 83
selected root C/C++/header files, excluding four generated glyph tables, plus the
selected Windows implementation/configuration/MIDI sources. It is not a complete
third-party codec, OS or binary build attestation.

The official asset `264188556`, `sdlpal-win32-mingw.zip`, still has publisher
SHA-256 `375f04ebe1f3c68080dc3827254b41bc85d9475b4f3b38c3e913fcfaddabed0d`.
Its earlier actual authenticated inspection observed one PE32 `sdlpal.exe` and
no original data. Current metadata is refreshed; that archive observation is
reused at its exact unchanged identity. Selection fixtures exercise the observed
release, a controlled synthetic successor, ambiguity, wrong platform/CPU and
missing-integrity refusals. Lifecycle fixtures use inert runtime bytes and
synthetic originals, including a literal relative configuration before first
Play, backup/consent-bound restore, compatible replacement, staged activation,
rollback, restart and preserving removal. They do not certify real save formats.
The existing Native6 SourceOnly/verified-file-set policy is unchanged.

## Ownership and maintenance

The eight existing-copy changes leave runtime replacement, originals and player
data with the user/upstream (`user-managed-update`). Academy's already managed
SP offer retains its existing contract. Wargus/War1gus installers and extraction
remain upstream operations; OpenCE's replacing updater runs outside the selected
Play session. External registration removal preserves external files. A catalog
change does not adopt or rewrite an existing registration.

SDLPal's separate fresh Native offer uses the existing compatible-release,
backup/recovery and immutable-runtime contracts. Its declared local data can be
collected before first Play. Runtime rollback carries current declared data;
it neither rewinds progress nor establishes older-runtime/save compatibility.
No qualification arrays are promoted. All previous identities, source contracts,
retained readers and acquisition conditions remain intact. The independent
compatibility fixture gains only SDLPal's explicit additive operational ID.

## Bounded selection and held records

The working target was 15–25 operational integrations, with approximately forty
as the ordinary target for homogeneous routine changes. This smaller candidate
is an exception after an exact retained eighty-record reserve assessment: five
were already closed, nine became authored proposals, and sixty-six retain
mandatory unfinished conditions. Many already have delivered non-owning
components and explicitly require stronger managed-fitting work. Repeating
those guides would not finish their finite outcomes. No catalog-wide recrawl,
research workers, padding or new Core mechanism was used to increase membership.

Held Required/client observations, private originals, historical retained-state
evidence, original-data preparation, artifact authenticity and per-title
permission/runtime conditions remain on their existing owners. In particular,
[Gen1's ordinary-restart hold](https://github.com/boburning/portcove/issues/2866#issuecomment-6592945529)
still applies to the seven assessed identities. A new complete first-party
uHexen2 writer assessment and authenticated package inspection found a viable
base-game layout, but its independent review retains the exact
[ten-library component-evidence hold](https://github.com/boburning/portcove/issues/2747#issuecomment-6595153769).
That held research is not a substantive port change or completed outcome here.
CatacombGL and Omnispeak's existing-copy components remain delivered; their
canonical owners now retain the refreshed missing expected-digest condition and
the still-required title-specific managed-fitting work.

This candidate concerns six original524 and three affected312 identities, with
two historical1422 overlaps that are not additive. It resolves no direct
Required-beta outcome or whole parent/cohort at this checkpoint. All858 frozen
identities remain in scope. #1422, #2510 and #2926 remain open; this packet does
not move or waive any unfinished mandatory acceptance. No speedup is claimed.
