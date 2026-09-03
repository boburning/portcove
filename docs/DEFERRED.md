# Deferred work

This file is the authoritative queue for work Portcove intentionally postpones because it needs an interactive account, physical validation, external infrastructure, or product-polish time. A deferred item must not be represented as completed elsewhere. Remove an item only after its completion evidence is recorded in the repository.

Statuses:

- `waiting`: progress requires a person, account, device, or external decision.
- `ready`: it can be resumed without resolving another product decision.
- `later`: deliberately outside the current functionality-first slice.
- `optional-tooling`: an advisory capability is unavailable on one host but required release gates still run.

Completed campaign items, including `PCV-DEF-001` public GitHub App registration and live CLI/GUI device login, have evidence in [DEFERRED-CAMPAIGN.md](DEFERRED-CAMPAIGN.md). The four reopened audit Phase 5 capabilities are implemented: verified library portability/relinking, bounded opt-in source discovery, phase-aware cancellation, and signed catalog delivery with embedded fallback. Platform and human qualification remain separate.

## PCV-DEF-002 — Decide and deploy an optional update relay

- Status: `waiting`
- Needs: a hosting destination, public origin, and signing-key ownership/rotation decision.
- Purpose: reduce redundant client polling and shorten update discovery latency.
- Boundary: GitHub authentication alone cannot subscribe Portcove to webhooks from arbitrary upstream repositories.
- Proposed shape: cooperative upstream webhooks plus one centralized conditional poller, producing signed advisory catalog events. The local GitHub resolver remains authoritative and anonymous/offline-friendly operation remains supported.
- Campaign progress: explicit signed catalog delivery, public-key trust, replay/expiry protection, rollback and embedded fallback are now implemented independently. This does not deploy a relay or define an advisory-event feed. Reuse the core trust/verification boundary when a hosting/custody decision and versioned event contract exist.

Resume checklist:

1. Select the hosting and domain model.
2. Define signing-key custody, rotation, expiry, replay protection, and outage behavior.
3. Version the advisory feed contract and add signature verification to `portcove-core`.
4. Make relay use explicitly optional and fall back to existing conditional GitHub requests.
5. Test forged, expired, duplicated, reordered, and unavailable events before enabling it by default.

## PCV-DEF-003 — Hands-on port qualification

- Status: `waiting`
- Needs: a Windows desktop, the exact user-owned source for each port, and observation of gameplay, audio, controls, and save/load behavior.
- Automated Windows qualification is already recorded for the ports below, but hands-on qualification is still absent:

  - AeroGauge: Recompiled
  - Automobili Lamborghini: Recompiled
  - Beetle Adventure Racing: Recompiled
  - Dusklight
  - Donkey Kong 64: Recompiled
  - Gen1Recomp
  - Harvest Moon 64: Recompiled
  - Mega Man 64 Recompiled
  - Quest 64: Recompiled
  - WCW vs. nWo World Tour: Recompiled
  - WCW/nWo Revenge: Recompiled
  - WWF No Mercy: Recompiled
  - Perfect Dark (`rolling`)
  - Bomberman Hero (`beta`)
  - Snowboard Kids 2 (`beta`)
  - Goemon 64 (`beta`)
  - Twisted Metal 4: Recompiled
  - Mortal Kombat 4: Recompiled
  - Bomberman Fantasy Race: Recompiled
  - Bomberman Party Edition: Recompiled
  - Bomberman World: Recompiled
  - Klonoa: Door to Phantomile Recompiled
  - Legend of Mana: Recompiled
  - Marvel vs. Capcom: Recompiled
  - Masters of Teräs Käsi: Recompiled
  - Metal Slug X: Recompiled
  - Rampage Through Time: Recompiled
  - Jedi Power Battles: Recompiled
  - Street Fighter Alpha 3: Recompiled
  - Tomba!: Recompiled (`beta`)
  - Animal Crossing PC Port (`beta`)
  - Project Picori (`beta` support tier)
  - BattleShip

The embedded catalog's `automated_tested_platforms` and `manually_validated_platforms` fields are the machine-readable authority. Update those fields only after the matching evidence exists. The earlier baseline Portcove desktop/controller smoke was reported as passing on Windows; this item concerns the listed games, not that completed baseline.

## PCV-DEF-004 — Validate the new GitHub settings experience

- Status: `waiting`
- Needs: a person at the Windows desktop for the remaining edge-case observations. Public App registration and live device login are complete.
- Purpose: verify the newly added Settings card, device code presentation, browser handoff, connected-account state, rate-limit display, restart persistence, error recovery, and logout with real GitHub responses.
- Automated component and backend tests already pass; that is not a substitute for this interaction check.
- Live 2026-09-03 evidence: the user confirms Settings displays the connected account/rate limit, "opening links also works," and "Logging out and back in worked." A fresh CLI process afterward confirms the saved OS credential authenticates as `boburning`. After the next native rebuild/restart, the user also confirmed Settings still displayed `boburning` connected. Remaining: a readable error/recovery observation for an interrupted, denied, or expired device flow.

## PCV-DEF-005 — Controller-navigation polish

- Status: `waiting`
- Purpose: improve discoverability and consistency of controller controls in the desktop UI.
- Revalidated 2026-09-03: the user tested an Xbox controller and reported invisible focus, unreliable actions, no dependable return to the sidebar, and confusing A-button hints. This is a failed current qualification, irrespective of the historical baseline smoke.
- Second Xbox observation: improved, but vertical navigation skipped filter rows, the first catalog card, and GitHub actions; search focus covered only the input, the header controls differed in height, and project links did nothing. These reports reopened concrete engineering fixes; they are not a manual pass.
- Engineering: one shared control inventory; explicit controller focus outlines; button-edge state survives dialog renders; modal-local navigation and nested Back; focus restoration; selected-item scrolling; sidebar/content boundaries; B to menu; LB/RB section navigation; consistent A-to-select choice lists; context-specific hints. Keyboard editing remains native.
- Evidence: integration fixtures cover held A/B across modal renders, sidebar return, bumper edges, Tab including summaries, native field arrows, and nested choice cancellation. Browser interaction verified visible gold focus, choice visibility, and one-level Escape/return focus. These checks do not establish controller feel.
- Follow-up engineering and evidence: nearest-row navigation with explicit control groups; a full-field search outline and matching 42-pixel header heights; plain "Color theme" copy; and a reviewed-URL native browser bridge shared by all external links. Browser fixtures verified Library/Catalog filters, Ship of Harkinian first, GitHub Log out/Refresh status, and Updates actions before its first port. Regression tests exercise skipped rows and controller link activation.
- Third Xbox observation, on desktop SHA-256 `5eac1238fefbcf8a36648891452050d5bdf8eadd86be58369b4313c7c55b1366`: the user reports "The controller feels much better" and then "opening links also works." This confirms improved physical controller behavior and functioning browser handoff. It does not yet individually certify every nested-dialog/minimum-size case or the complete authentication checks under `PCV-DEF-004`.
- Fourth Xbox observation, on desktop SHA-256 `3d054c91b78249b9a0672d6a716a67413a9e8d3d719670ffb79bd78a4e08a7c1`: the user confirmed controller focus stayed inside Move library and pressing B closed it and restored visible focus to Move library. This is a passed physical modal containment/return check.
- Import browser follow-up: dialogs are bounded to the viewport and preserve room for focus outlines. The shared modal hook reveals the focused action when asynchronous review content expands; Tab scope and Escape focus return were checked at 1280×720. This does not substitute for the remaining physical compact/nested-choice check.
- Cancellation browser follow-up: removing the temporary Cancel control had left focus on the document body. The shared dialog hook now keeps focus on the modal while all controls are disabled and returns it to an enabled control after completion. A deterministic navigation regression and browser interaction verified this transition and Escape return to the opener. This is additional engineering evidence, not a new physical controller result.
- Resume: repeat Catalog → game → Advanced controls → Update policy with the Xbox controller; verify visible selection, one action per press, B cancelling just the choice, B closing details to the same card, B returning to the sidebar, LB/RB sections, and selected-card visibility at the 960-pixel minimum window size. Record the user's actual result before closing this item.

## PCV-DEF-006 — Broader operating-system qualification

- Status: `later`
- Purpose: qualify declared Linux and macOS releases where hardware and upstream artifacts make that useful.
- Boundary: universal platform coverage is not a release requirement. A high-quality Windows-only port remains eligible, and support must be represented per port rather than implied globally.
- Resume by choosing one platform/port pair, running the catalog qualification procedure in `docs/CATALOG.md`, and recording automated and manual evidence independently.

## PCV-DEF-007 — Game-specific implementation and qualification blockers

- Status: `waiting`
- Purpose: retain every known case where a candidate could not be implemented or qualified because the exact source was unavailable, the upstream artifact was unsuitable, or the game itself was not ready.
- Evidence refresh: 2026-09-01. RomM authority was confirmed as version 5.2.0 with host `/volume1/media/roms` mounted read-only at `/romm/library`. GitHub release checks used Portcove's normal resolver and fail-closed checksum rules.

Cataloged but not automation-qualified:

| Port | Current blocker | Resume condition |
|---|---|---|
| Ghostship | The official 2.0.0 Windows build and supported US source were hash-verified, but the process exited with `0xC0000005` before generating `sm64.o2r`; its documented OpenGL fallback did not persist. | Re-test a corrected upstream build or a narrowly reviewed runtime workaround, then complete the full lifecycle. |
| Starship | The exact supported US 1.0 source is available and its SHA-1 matches `d8b1088520f7c5f81433292a9258c1184afa1457`, but the current Windows release does not publish a SHA-256 digest or checksum sidecar. | Upstream publishes verifiable release integrity, after which the existing source can be used for lifecycle qualification. |
| Dinosaur Planet: Recompiled | The current Windows release resolves with a SHA-256 digest, but the required unpatched December 2000 prototype source was not found in RomM. | Obtain the exact legally owned prototype and define a precise source identity before lifecycle testing. |
| DKR-R | Upstream has no Windows artifact, and the available RomM Diddy Kong Racing dump is not the required USA Rev 1 source. | Test on a supported Linux x64/Steam Deck or Apple-silicon Mac with the exact Rev 1 source. |
| Virtual Pro Wrestling 64: Recompiled | Only a translated local dump was available; the strict upstream SHA-1 allowlist correctly rejected it. | Obtain an unmodified Japanese source matching the existing allowlist. |
| WWF WrestleMania 2000: Recompiled | The available US dump is the wrong revision; upstream requires USA v1.2. | Obtain the exact v1.2 source matching the existing allowlist. |
| Virtual Pro Wrestling 2: Recompiled | Only a translated local dump was available; the strict upstream SHA-1 allowlist correctly rejected it. | Obtain an unmodified Japanese source matching the existing allowlist. |
| Dr. Mario 64 Recompiled | A US source is present in RomM, but the repository has no published stable release for Portcove to install. | Upstream publishes a portable checksum-qualified release, or an explicit beta channel is reviewed once such a prerelease exists. |
| re:Blue | All three user-owned Blue Dragon ISOs are now located under `D:\Downloads`, and a checksum-qualified Windows v1.0.0 release resolves. Source availability is no longer the blocker. Upstream requires an interactive three-disc wizard that validates each image, copies about 15 GB of game data, copies/restarts its executable in a chosen install root, and records that root outside Portcove. The current single-source `generated-cache` catalog contract cannot safely automate or preserve that lifecycle. | Design a narrowly scoped multi-disc/upstream-setup contract, or wait for upstream to expose deterministic disc and install-root arguments. It must preserve `profiles`, `game`, `mods`, and installer-owned state across Portcove updates without racing the replacement process; then run lifecycle and hands-on tests. |
| Trouble Makers Recompiled | The available RomM Mischief Makers dump is not the required US 1.1 revision, so the strict source contract rejects it. | Obtain the exact US 1.1 source matching the existing allowlist. |
| Final Fantasy VII: Recompiled | The managed three-disc CHD contract and exact per-disc Track 01 identities are implemented, and the GUI accepts a folder source. No matching three-disc user-owned source set was found locally or in RomM, so source validation and the managed lifecycle remain untested. | Provide three matching CHDs in one folder with filenames sorting as Disc 1, Disc 2, and Disc 3, then run source, lifecycle, launch, and hands-on validation. |
| Space Station Silicon Valley: Recompiled | The checksum-qualified v0.2.0 Windows release installed and remained responsive, and the exact USA 1.0 source was registered. The upstream runtime exposes only a first-run GUI picker, so Portcove cannot yet prove source loading or generated-data persistence without interaction. | Select the registered source in the first-run picker, observe gameplay/audio/controls/save behavior, then inspect and record the generated paths before claiming Windows automation or manual evidence. |
| F-Zero X G-Diffuser | The stable v1.1.0 Windows artifact resolves with GitHub's SHA-256, and Portcove's exact three-member file-set contract is cataloged. The RomM USA Rev 0 cartridge and Japanese retail 64DD IPL match upstream identities. The available translated Expansion Kit ZIP expands to a 66,551,504-byte converted `.z64` with SHA-1 `5d46e6ba0abcccfb84f73c31e00dff9864218b28`; upstream requires the 64,931,840-byte translated NDD with SHA-1 `fde9fa6f29a52be0144bda74caf8583c036c20ce`, so registration correctly fails. | Supply the exact translated `.ndd` under `baserom.translated.ek.ndd`, then run source registration, install, first-boot extraction, responsive launch, lifecycle, and hands-on validation. |
| WipeOut Phantom Edition | The exact USA CHD is available in RomM. Portcove's new transactional `psx-bin-cue` materialization was exercised on it with local `chdman` 0.287 and produced the required one MODE2/2352 data track plus eight audio tracks. The active upstream's v1.2.256 Windows asset has neither a GitHub digest nor a checksum sidecar, and upstream does not publish an exact disc-content identity Portcove can cite for its source allowlist. | Upstream publishes a SHA-256 for the release and a stable USA disc identity, or a maintainer-reviewed equivalent provenance is added. Then catalog the port, stage the registered CHD into `wipeout/diskimages`, and run extraction, lifecycle, launch, and hands-on validation. |
| Cannonball / OutRun | Portcove now validates exact arcade file sets from a folder or ZIP using upstream-published per-member CRC32 values and can transactionally stage each declared member. The RomM `outrun.zip` was copied to `E:\Portcove-V1-Sources`, remote/local SHA-256 matched `a6ca0fe457238103b05bbdf0a244439c23d7381a3a96d1eacc4f36ab8df70228`, and all 31 Revision B filenames and CRC32 values exactly match Cannonball's loader contract. The active upstream's latest Windows release remains v0.34 and publishes neither a GitHub digest nor a checksum sidecar, so the application artifact fails Portcove's release-integrity admission rule. | Upstream publishes a SHA-256 for the v0.34 Windows artifact or a newer runnable release. Then add the 31-member source profile and Windows port, install from the checksum-qualified artifact, stage the registered ZIP into `roms`, and run lifecycle, launch, and hands-on validation. |
| ProjectR / San Francisco Rush: The Rock | The direct upstream's current v0.7.1 packages cover Windows, Linux, and universal macOS, and `--rtr` is a documented fixed launch argument. The download page and response headers publish sizes, modification dates, and opaque ETags but no SHA-256 or checksum sidecar. Upstream setup is interactive and requires an arcade `sfrushrk` CHD/raw disk plus four named audio ROMs (optionally zipped); no arcade source set was found in the local or RomM library. | Upstream publishes immutable SHA-256 values and either exposes a deterministic setup interface or its generated data/config contract is narrowly reverse-engineered and preserved. Obtain the exact legally owned arcade hard disk and audio ROM set, then implement source validation, application-package handling, lifecycle, launch, and hands-on validation. |
| ProjectR / San Francisco Rush 2049 | The same direct v0.7.1 application documents `--2049`, but its packages have no published SHA-256 or sidecar. Setup remains interactive and accepts only the arcade Special Edition or Tournament Edition CHD/raw disk (plus an optional matching MAME delta CHD); the RomM search found only unrelated console releases and no supported arcade source. | Meet the shared ProjectR artifact/setup conditions and obtain a supported `sf2049se`, `sf2049te`, or `sf2049tea` arcade disk. Then define its independent source and persistent-data contract and qualify each platform separately. |
| R.E.L.I.V.E. / Oddworld: Abe's Oddysee | The active direct repository's latest stable release is v1.0.9. Its Windows packages are debug ZIPs and its Linux package is a zipped debug DEB; none of the five runnable/symbol assets has a GitHub digest or checksum sidecar. Upstream requires copying the engine into the original PC game's complete installed-data directory. No Steam/GOG Oddysee installation was found in the checked C:, D:, or E: library paths, and console disc images are not a substitute. | Upstream publishes checksum-qualified runnable artifacts and a stable release layout. Install a legally owned PC copy, then define the exact adopt/copy and persistent-file contract, qualify the selected platform, and complete hands-on validation. |
| R.E.L.I.V.E. / Oddworld: Abe's Exoddus | The same active v1.0.9 release and copy-into-original-folder model applies independently to Exoddus. Its artifacts likewise lack published SHA-256 integrity, and no original PC installation was found locally. | Meet the shared R.E.L.I.V.E. artifact condition, install the legally owned PC version of Exoddus, and independently qualify its data, save, configuration, lifecycle, and launch contract. |
| Severed Chains / The Legend of Dragoon | Portcove cataloged the active `devbuild` rolling release on Windows, Linux, Intel macOS, and Apple Silicon, with mutable-tag versions bound to the verified artifact digest. The Windows artifact installed and verified at `devbuild.ba4bde80df28`. All four USA CHDs from RomM were remote/local SHA-256 checked, registered by the upstream `SCUS94491`, `SCUS94584`, `SCUS94585`, and `SCUS94586` disc identities, and accepted as one managed source set. The upstream Windows launcher does not bundle Java: on first run it downloads a pinned Amazon Corretto 25 ZIP itself without giving Portcove a checksum to verify, which crosses the managed-download trust boundary. The raw-disc staging and actual game boot therefore remain unclaimed. | Add a generic checksum-pinned runtime-dependency installer or upstream bundles the runtime/publishes a verifiable dependency manifest. Then stage the four registered CHDs into `isos`, exercise first boot, complete the lifecycle, and perform hands-on gameplay/audio/controls/save validation. |
| OpenPete / Spyro the Dragon | Portcove cataloged the official Windows v0.1.4 ZIP as an active direct upstream release, pinning its observed 122,163,057-byte size and the upstream-published SHA-256 `7ba215834c6a1e23d0642b6c749c6335853a18cc566805c0a39bcf2cd5ab1359`. The package contents and README confirm `openpete-spyro1.exe`, the idempotent `--ingest` interface, and the portable `openpete.toml`, `cards`, `states`, and `library` paths. Portcove's generic CHD-to-BIN/CUE staging is wired to that interface. RomM's `Spyro the Dragon (USA).chd` was copied to `E:\Portcove-V1-Sources`; remote/local storage SHA-256 matched `8fe0a6e735ee399a8251f2173cf61c6e20fa565611b934fa3d90788beab9d6cb`. Its extracted 661,547,040-byte Redump track hashes as SHA-1 `cf3ce6bedeb89dfbc40990336180f3b9b0f40d9f`, while OpenPete explicitly requires SHA-1 `1e08ae8df01acf7ee5d9cb6931b5f8c1bc905fcb` or SHA-256 `95f03abf97c9ff0b2a64888ed7dbbb4b59a7b4363cf188cd0a562b95cfd4809f`. Source registration rejected it, and OpenPete likewise produced no library entry when asked to ingest it. | Supply a legally owned CHD whose extracted Track 01 matches OpenPete's exact published identity, or upstream adds the available Redump identity. Then run managed install, idempotent ingest, headless/process smoke, lifecycle, and hands-on validation. |
| OpenGOAL / Jak and Daxter | The direct `open-goal/jak-project` v0.3.6 Windows package resolved with GitHub SHA-256 `98aa727f10414faa0d60c233827f472d057150f56baf85506858592d39656cb0`, installed, and verified at 4,509 files. Portcove cataloged a two-stage ISO/CHD contract and invoked the pinned extractor with fixed `jak1` validation arguments. RomM's No Debug-patched CHD was remote/local checked at SHA-256 `b34c9bf104326b1e10edfa273bc1ab1d236cfb3ad66852ba8738478448fc7d23`; the extractor identified serial `SCUS-97124` but rejected ELF hash `17454923923531751281`. Failed-attempt output is recoverably quarantined under `E:\Portcove-V1-Qualification\rejected\opengoal-jak1-2026-09-01`. | Supply a legally owned unmodified retail disc accepted by OpenGOAL, then rerun setup, lifecycle, responsive launch, and hands-on validation. |
| OpenGOAL / Jak II | The distinct beta-tier catalog entry uses the same checksum-qualified v0.3.6 package and verified 4,509-file install. The local No Debug CHD matched remote/local SHA-256 `846471f6035ee97af1c0b189b03a12748c45f6c57582f76ca1cc58f69d0cd454`; after transactional CHD-to-ISO conversion, the pinned extractor identified serial `SCUS-97265` and rejected ELF hash `11898914783837968685`. No successful-launch marker was written, and attempt output is quarantined under `E:\Portcove-V1-Qualification\rejected\opengoal-jak2-2026-09-01`. | Supply a legally owned unmodified retail disc accepted by OpenGOAL, then rerun setup, lifecycle, responsive launch, and hands-on validation. |
| OpenGOAL / Jak 3 | The distinct beta-tier catalog entry likewise installed and verified the direct v0.3.6 package at 4,509 files. The local No Debug CHD matched remote/local SHA-256 `529eb2e74b5a09478ddc220471f06175f074543a987dfb7782e8f89938409eb4`; the pinned extractor identified serial `SCUS-97330` and rejected ELF hash `16630420417664869519`. No successful-launch marker was written, and attempt output is quarantined under `E:\Portcove-V1-Qualification\rejected\opengoal-jak3-2026-09-01`. | Supply a legally owned unmodified retail disc accepted by OpenGOAL, then rerun setup, lifecycle, responsive launch, and hands-on validation. |
| Mega Man X6 Recompiled | The active direct `mstan/MegaManX6Recomp` v1.0.9 Windows package resolved with GitHub SHA-256 `0b296521d8c212e7539cd9410bec15dabbda7dff7bd9042393384ce6433db344`, installed, and verified at 560 files. RomM's Rev 1 CHD was copied with matching remote/local container SHA-256 `a4bc113d7df1cb5c7ccd8bdb5240efa72a587a63c98973eebde2adb56b185d64`; its normalized 599,985,792-byte Track 01 matched upstream SHA-1 `d4f7e08371027a87a3bf13311db5a4c56733f4ea` and SHA-256 `91ef53c12c3a3eb3362d51d524d3f83cd4ff8e68bf2d2ad6c5c8ea4e0310d318`. Fixed CHD-to-BIN/CUE launch arguments reached a responsive `Mega Man X6 Recompiled` window, graceful exit collected 300 cache/mod/save/config files, and remove/reinstall restored them before a second responsive launch while preserving the original CHD. A fresh 560-file application tree was then adopted into an isolated library, verified, launched through the same registered CHD contract, removed while retaining 299 generated mutable files, and its aggregate original-tree SHA-256 remained unchanged. Shared failed-download cleanup is covered by the installer regression test. | Qualify update/rollback when a second compatible release exists; then perform hands-on gameplay, audio, controls, and save/load validation. |
| Paper Mario ReCut | The active, non-archived direct upstream's v0.1.2 prerelease is cataloged as opt-in beta. Its 88,065,512-byte Windows ZIP resolved with GitHub SHA-256 `4734bc2e11886a327dda9ecedf25258298f3c5ddfc1820e8eeba1b6683ebad2a`. The RomM ZIP matched remote/local storage SHA-256 `96b7073561ff8ac5ed5168df91fe480352d5de07b738422309e95936bd4c5c64`, and its 40 MiB ROM passed the upstream Paper Mario US SHA-1 `3837f44cda784b466c9a2d99df70d77c322b97a0`. Portcove installed and verified 75 application files, pre-staged `user/pm.n64.us.z64`, skipped the picker, reached a responsive `Paper Mario ReCut` window, collected all 59 release-local user files, preserved the original source, and restored those files across remove/reinstall and a second launch. A fresh 75-file release tree was then adopted into an isolated library, verified, launched with the registered ROM without showing the picker, removed while retaining all 59 user files, and its aggregate original-tree SHA-256 remained unchanged. Shared failed-download cleanup is covered by the installer regression test. | Qualify update/rollback when a second compatible beta exists; then perform hands-on gameplay, audio, controls, texture tooling, and save/load validation. |

The remaining approved expansion candidates are tracked in `V1-CUTOFF.md`. Add a row here as soon as work on an individual candidate encounters a concrete blocker; queue position alone is not a blocker.

Researched but not cataloged:

| Candidate | Why it was not implemented | Resume condition |
|---|---|---|
| Conker64: Recompiled | Upstream explicitly describes itself as a work-in-progress reverse-engineering toolkit that does not play the game; recompiled MIPS execution and game logic are not implemented. The local RomM library also contains only a European dump while its build instructions require a US dump. It does not meet the V1 runnable-port admission rule. | Reconsider only after upstream produces a playable portable release with a deterministic US source contract and verifiable artifact. |
| Star Fox Enhanced | The active, non-archived direct upstream publishes checksum-qualified v0.0.3 prerelease packages for Windows x64/x86, Linux x64, universal macOS, Android, iOS, Switch, and Xbox UWP. RomM's clean USA 1.0 ZIP was copied with storage SHA-256 `47b44284f5730e418b37b77a54a156c16cac725269b6e323800a7f5e4c84f674`; its 1 MiB member has upstream-accepted CRC32 `0BAE0941`. The desktop runtime can build `Starfox-Assets.BIN` beside the executable, but input bindings use SDL's global preference path while pregame settings, HUD layouts, and Star Fox EX SRAM use the user's global `Documents/Star Fox Enhanced` directory. Upstream exposes no portable/user-data override, so Portcove cannot own, collect, restore, or isolate that mutable state safely. | Upstream adds one deterministic portable data-root argument/environment variable covering the asset companion, input bindings, pregame settings, HUD layouts, and SRAM. Then define exact multi-platform source validation, decide whether the optional 226 MiB checksum-qualified MSU-1 pack is a managed add-on, and run full lifecycle and hands-on validation. |
| Chameleon Twist: Recompiled | The active, non-archived direct upstream's v0.1 Windows ZIP is runnable but its 23,929,489-byte artifact publishes neither a GitHub digest nor checksum sidecar. The game accepts only the clean Japanese ROM (`baserom.jp.z64`, upstream XXH3 `0x0ff1b3a34ee3fb82`). The copied local Japanese file is the Zoinkity translation (CRC32 `6DEF366B`, ZIP SHA-256 `cc2a5847c85585d2e0727b81d01ff41fef0a28c4130a95647ada070f5068fa43`), while the other local cartridge is USA (CRC32 `7FE024C9`); neither is the required clean Japanese revision. | Upstream publishes release SHA-256 integrity and the user supplies an unmodified Japanese ROM accepted by the direct runtime. Then catalog only supported platforms and qualify its external save/config boundary before lifecycle and hands-on testing. |
| Sonic Unleashed Recompiled | The active, non-archived direct `hedge-dev/UnleashedRecomp` v1.0.3 release provides 53,386,467-byte Windows and 36,827,696-byte Flatpak ZIPs, but neither asset has a GitHub digest or checksum sidecar. The source shortage is resolved: RomM contains the exact Xbox 360 USA ISO at `/volume1/media/roms/roms/win/Sonic Unleashed/Sonic Unleashed (USA) (En,Ja,Fr,De,Es,It)-001.iso`, and upstream documents file/folder installation plus portable mode. | Upstream publishes SHA-256 integrity for the runnable artifacts. Then pin the supported installed-data identity, implement the narrow portable install contract, and run lifecycle and hands-on validation on Windows and Flatpak/Linux independently. |
| NocturneRecomp | The active, non-archived direct `birabittoh/NocturneRecomp` v1.4.5 release has checksum-qualified Windows, Linux x64, and Linux arm64 vanilla/TU variants; the vanilla Windows SHA-256 is `f975efd495998ecd7a6f39fd4d61a3d2254868549c729e0f2a604c6565c2acac`. The runtime expects an Xbox Live Arcade LIVE/STFS package extracted into `assets`. No matching local source was found, the direct game repository does not publish the exact package/default-XEX identity, and the public Goopie catalog used only for identity research returned quota exhaustion. Portcove does not depend on Goopie or ReXGlue launchers. | Obtain the legally owned XBLA package and a maintainer-verifiable package/default-XEX identity from the direct game ecosystem, then implement a narrow STFS extraction contract and independently qualify the chosen vanilla/TU platforms. |
| Kameo RePowered | The active, non-archived direct `birabittoh/KameoRePowered` v0.2.1 release has checksum-qualified Windows and Linux vanilla/TU artifacts; the vanilla Windows SHA-256 is `0b5728f05db7b18aa0cbe49f0dea01229a8a5ea94d935d2b49b6935ead6eedac`. The runtime requires assets extracted from an Xbox 360 disc, but no matching local source or direct upstream exact disc/default-XEX identity was available. | Obtain the legally owned supported Xbox 360 disc and a direct-upstream-verifiable source identity, then implement deterministic XDVDFS extraction into the declared assets boundary and qualify each platform/variant independently. |
| reDAHM / Destroy All Humans! Path of the Furon | The active, non-archived direct `masterspike52/reDAHM` `new` Windows release is checksum-qualified at SHA-256 `ae2d24a652fb171ade84040dce36c7d168cb1c51c52ff5d870b3ebfc9a7093f6`. No supported local Xbox 360 source or direct exact source identity was found, and first run uses an interactive path wizard rather than a deterministic assets argument. | Obtain and identify the legally owned supported disc, and wait for or implement a narrowly reviewed deterministic first-run data-path contract that keeps all mutable state under Portcove before lifecycle and hands-on testing. |
| SVR07 Recomp / WWE SmackDown vs. Raw 2007 | The active, non-archived direct `HollywoodAkeem/SVR07-Recomp` v1.0 Windows release is checksum-qualified at SHA-256 `a798e9becc1002f285a9dbd70c5eeecc1fd1e49a206e0b2bc685f4fc86479fc9`. Its runtime expects an extracted assets folder, but no matching local Xbox 360 source or direct upstream exact disc/default-XEX identity was available. | Obtain the legally owned supported disc and a direct-upstream-verifiable identity, then implement only the deterministic extraction/layout contract and complete lifecycle and hands-on validation. |

## PCV-DEF-009 — Production installer signing and install/uninstall validation

- Status: `waiting`
- Needs: a code-signing identity and hands-on validation at each target desktop.
- Already implemented: the Tauri 2 Windows production build emits an NSIS installer, the release workflow emits native desktop bundles plus separate CLI archives, and every platform job uploads a SHA-256 manifest covering both artifact families. On 2026-09-01 the current 61-port Windows bundle passed an automated isolated silent install, reached a responsive named `Portcove` window, exited cleanly, silently uninstalled, removed its HKCU uninstall registration and managed application files, and preserved its expected `NotSigned` status. The revised branded installer passed that isolated install, responsive-window, clean-exit, and uninstall lifecycle again after the compact crab silhouette, icon, and package-metadata integration. `scripts/test-windows-installer.ps1` makes that lifecycle repeatable. Local packaging now refreshes `outputs/SHA256SUMS.txt`, which is the authority for the current local artifact hashes, instead of leaving stale values in prose. The finalized compact crab portrait has also been visually checked at 32, 128, and 256 pixels, and Tauri regenerates the complete Windows, macOS, Linux, iOS, and Android icon set from its preserved production master.
- Remaining boundary: choose certificate custody and CI secret handling, sign release artifacts, qualify in-place upgrade, then observe interactive installer choices, SmartScreen/Gatekeeper behavior, shortcuts/PATH integration, icon appearance in the Windows taskbar/Start menu and supported macOS/Linux shells, and clean uninstall on each target operating system. Do not represent image-level icon inspection or the current unsigned automated Windows smoke test as signed production installer and OS-shell validation.

## PCV-DEF-011 — Validate the shared activity, update-awareness, and source-readiness GUI

- Status: `waiting`
- Needs: a person at the Windows desktop and a disposable or qualification library with at least one installed port, one current update check, and one missing or replaceable source profile.
- Already implemented: SQLite-backed typed activity shared by CLI and Tauri, the bounded `activity` CLI command and schema, persisted successful update snapshots with version/channel freshness guards, restart-safe sidebar and card badges, Update Center recent activity, grouped missing source/BIOS registration in Settings, source-aware install gating, and core-backed library volume capacity. Automated Rust, component, production-build, and Fallow checks pass.
- Purpose: validate the actual visual density, timestamps, controller focus movement, native file/folder/ZIP pickers, restart persistence, failure recovery, and badge clearing after activation or channel change. This is polish evidence, not a blocker for continuing unrelated implementation.

Resume checklist:

1. Run the desktop against an isolated library and complete one successful and one failed management operation from both CLI and GUI.
2. Confirm newest-first activity, failure copy, port/source recovery links, and running/unfinished/success/failed visual states remain readable at normal and compact window sizes. A running record older than 24 hours is presented as unfinished without changing the core API record.
3. Restart Portcove and confirm a current update badge remains visible without a new request; activate/update or change channel and confirm the stale badge disappears.
4. Select a source-dependent port without its source and confirm Install remains gated, then add the required game source or BIOS from Settings using the profile-correct picker and confirm the requirement clears only after core validation succeeds.
5. Review one fresh install and one staged or retained release. Confirm version, action, asset size, and available-capacity copy are legible and that only the fresh release downloads.
6. Confirm Settings shows the isolated library path and plausible available/total capacity for its containing volume.
7. From an installed port's advanced controls, confirm Open data folder creates or opens only the displayed persistent-data root in the OS file manager.
8. Create a persistent-data backup, confirm the successful activity appears, and compare the reported snapshot with the displayed data root without editing either copy. Restore it after making a disposable change, confirm the native warning clearly promises a safety backup, and verify both restored content and the new safety snapshot.
9. Repeat the relevant paths with a controller and record any focus-order or selected-row visibility issues under `PCV-DEF-005`.

## PCV-DEF-012 — Validate transactional persistent-data restore with a real save

- Status: `waiting`
- Already implemented: core/CLI/Tauri backup creation, listing, restore, and deletion; deterministic tree SHA-256; per-port locking; pre-copy active-data collection; fail-closed symlink handling; same-volume process-atomic publication; file/manifest flushing plus supported Linux directory syncing without a false cross-platform power-loss guarantee; explicit CLI and native GUI confirmation; automatic safety backup; typed results and activity; tamper, empty-root, independence, replacement, and targeted-deletion regression tests.
- Why deferred: automated filesystem tests cannot prove that an upstream port accepts the restored files or that the GUI's warning and snapshot history remain clear during a real save/load recovery.
- Resume condition: choose one installed port with a disposable real save, create a backup, advance or alter the save, restore from CLI and then GUI, verify the game loads the restored state, verify the automatic safety backup can recover the newer state, and record visual/controller behavior under `PCV-DEF-011`/`PCV-DEF-005`.

## PCV-DEF-013 — Enable semdup on the Windows development host

- Status: `optional-tooling`
- Evidence: semdup 0.2.0 builds through its Rust dependencies but fails while linking ONNX Runtime with the installed Visual Studio 2019 linker because required newer C++ standard-library symbols are unavailable. The pinned bootstrap now reports this optional failure without preventing required quality tools or cargo-mutants from being installed.
- Host update attempt: on 2026-09-02 the pinned Visual Studio Build Tools 2022 version 17.14.39 bootstrapper was launched with only `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`. Windows required administrator elevation; the non-administrator Codex process could not accept it, and setup exited with `0x80070642` without installing a Visual Studio 2022 instance.
- Impact: none on the blocking `just check` or `just audit` definitions. Rust duplication remains visible through rscheck, and TypeScript duplication remains covered by Fallow. `just deep` still attempts semdup and reports its absence as advisory. The manual Ubuntu 24.04 fallback is fully operational: [deep-quality run 33651741470](https://github.com/boburning/portcove/actions/runs/33651741470) completed the pinned Hawk and semdup analyzers, produced the recorded baseline in `QUALITY.md`, and saved both the versioned model and incremental corpus caches. Deep repository analysis therefore does not depend on changing this Windows host.
- Resume condition: while present at the Windows desktop, rerun the focused Visual Studio Build Tools 2022 installer and approve its UAC elevation prompt, then rerun `scripts/bootstrap-quality-tools.ps1 -IncludeDeep`; alternatively, run `just deep` from a supported Linux/macOS environment.

## PCV-DEF-014 — Resolve the Tauri Linux GLib unsoundness advisory

- Status: `upstream-blocked`
- Evidence: GitHub Dependabot alert 1 reports GHSA-wrw7-89jp-8q8g against Linux-only `glib 0.18.5`. `cargo tree --workspace --target x86_64-unknown-linux-gnu -i glib@0.18.5` traces it to Tauri 2.11.5's GTK3/webkit2gtk stack. Two security-update attempts confirmed that `0.18.5` is the latest resolvable version while the advisory marks `0.20.0` as the first fixed release. The current Portcove code does not directly use `glib` or `VariantStrIter`.
- Impact: the alert remains open and visible. Windows and macOS do not compile this GTK dependency path; a Linux build inherits the upstream unsound iterator implementation if that API is reached. The normal cargo-deny gate does not classify this RustSec informational unsoundness record as a blocking vulnerability.
- Resume condition: upgrade when Tauri's Linux runtime adopts a maintained GTK binding stack compatible with `glib >=0.20`, or evaluate a narrowly maintained and independently verified backport if Portcove must ship Linux before that upstream migration. Do not dismiss the alert or add a broad policy exception merely to obtain a green dashboard.

When another game cannot be completed, add it to this section even if it never enters `catalog.json`. Record the attempted upstream version/channel, platform, exact class of source mismatch or artifact failure, and the least ambiguous resume condition. Do not record or commit source game data.

## Adding an item

Give each new item the next `PCV-DEF-NNN` identifier and record:

1. why it is deferred;
2. what evidence already exists;
3. what is still required;
4. the exact condition that allows work to resume.
