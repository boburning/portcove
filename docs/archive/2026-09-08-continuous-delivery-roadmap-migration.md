# Delivery roadmap migration — 2026-09-08

Immutable dated migration evidence for [#531](https://github.com/boburning/portcove/issues/531), not a live roadmap, support
registry or maintained backlog. The [Project](https://github.com/users/boburning/projects/1)
remains authoritative after this observation. This records planning changes only.

## Before-state and authority

- Base: e87b2db4c726ca1af61853d68f8c4825206ebe20.
- Captured 2026-09-08T23:49:51.642Z: 416 unique Project items and 416 unique repository issues, with complete pagination and stable totals.
- 91 non-port relevant/affected issue bodies, comments, parents, children and blockers were read completely. Original issue bodies and all dated evidence are retained on their canonical identities; 16 active port forecasts changed vocabulary only.
- Raw before capture SHA-256: d238c790e89a3a518e22e24d3c5d0d8da979d31d6d9864cb55e2b10a19fdd12a; relationship/comment capture SHA-256: 3a24183bba7dff8c76fbb47be9711b22f2051a1a749008e97fa294f574d017c6. Read-only source captures and mutation readbacks are local execution evidence; the tables below preserve the portable affected-state record.
- Project identity: PVT_kwHOApLVys4BiZPj; 22 fields and 10 existing view identities preserved. Before Current Release filter selected Alpha 2. Added Public beta, 1.0 and Post-1.0 options without deleting/renaming historical options.
- Published inventory: v0.1.0-alpha.1 (2026-09-05) and v0.1.0-alpha.2 (2026-09-08), both GitHub prerelease and immutable. Tags/assets/versions and historical release evidence unchanged.
- Framework 2.11.5, Tauri CLI 2.11.4; no updater plugin, createUpdaterArtifacts=false. Existing production workflow creates/reconciles drafts, classifies by suffix; download selection uses publication time. #532 blocks suffix-free beta until corrected. Release workflows/configuration/dependencies remain unchanged.
- Effective main ruleset 22155633 retains strict catalog/dependency-review/frontend/rust/rust-quality, PR/resolved-thread rules, zero required approvals and no routine bypass. Tag ruleset 22334556 remains active. No authority change.

## Verified original Windows commitment

| Identity | Original target | Original commitment | Original state |
|---|---|---|---|
| [#219](https://github.com/boburning/portcove/issues/219) | Alpha 3 | Required | Ready |
| [#220](https://github.com/boburning/portcove/issues/220) | Alpha 3 | Required | Ready |
| [#221](https://github.com/boburning/portcove/issues/221) | Alpha 3 | Required | Ready |
| [#222](https://github.com/boburning/portcove/issues/222) | Alpha 3 | Required | Ready |
| [#223](https://github.com/boburning/portcove/issues/223) | Alpha 3 | Required | Ready |
| [#224](https://github.com/boburning/portcove/issues/224) | Beta 2 | Required | Ready |
| [#52](https://github.com/boburning/portcove/issues/52) | Beta 2 | Required | Ready |
| [#225](https://github.com/boburning/portcove/issues/225) | Post-V1 | Opportunistic | Deferred |
| [#226](https://github.com/boburning/portcove/issues/226) | Post-V1 | Opportunistic | Deferred |
| [#46](https://github.com/boburning/portcove/issues/46) | RC | Required | Blocked |

#219–#223 feature implementation was Required for Alpha 3; #224 and #52 Windows
qualification/parent closure were Required for Beta 2. Linux/macOS were explicitly
Post-V1 Opportunistic. The new decision promotes them and adds bounded Deck proof
to Public beta, while #46 remains later production qualification at 1.0.

## Mapping rationale

Every active changed identity appears below. Safety-critical interaction,
controller/Steam baseline, shared transport used by Steam, checksum conflict
prevention and the open GLib safety issue retain early commitment at Public beta.
The complete updater is explicitly promoted. Catalog successor and finite
reference/preparation/scale outcomes stay Required for 1.0 and prioritized during
beta; removing mandatory feature-complete Beta 1 permits broader testing before
all of them finish. Broader operating-system/usability/exact production
qualification moves from Beta 2/RC to 1.0; beta-specific fundamental updater
safety remains on #224/#225/#535/#226, not deferred to #46.

Post-V1 to Post-1.0 and active port/optional forecasts are vocabulary changes;
they do not promote optional work, change priorities/horizons, expand support or
change port scope. #225/#226 move Deferred to Ready because their baseline
implementation/feasibility is now required; their original priorities/horizons
remain. Shared updater Platform changes Windows to Multi-platform. All other
statuses/priority/horizon/effort/platform/port-stage values remain unchanged.

## Complete affected active mapping

| Issue | Original target / commitment | New target / commitment | Status before → after | Priority / horizon | Parent before | Blocked by before | Reason |
|---|---|---|---|---|---|---|---|
| [#14](https://github.com/boburning/portcove/issues/14) [Workstream] Alpha 3 integration and scale audit work | Alpha 3 / Required | 1.0 / Required | Ready → Ready | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#245](https://github.com/boburning/portcove/issues/245) Design independently delivered definitions and their trust boundary | Alpha 3 / Required | 1.0 / Required | Ready → Ready | Urgent / Now | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#206](https://github.com/boburning/portcove/issues/206) [UX] Reorganize desktop information architecture and primary copy | Beta 1 / Required | Public beta / Required | In progress → In progress | High / Now | [#200](https://github.com/boburning/portcove/issues/200) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#24](https://github.com/boburning/portcove/issues/24) [Audit] Scoped reads, N+1 removal, and redundant hashing | Alpha 3 / Required | 1.0 / Required | Ready → Ready | High / Next | [#14](https://github.com/boburning/portcove/issues/14) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#29](https://github.com/boburning/portcove/issues/29) [Audit] Controller-navigation performance | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#14](https://github.com/boburning/portcove/issues/14) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#30](https://github.com/boburning/portcove/issues/30) [Audit] Complete Rust/TypeScript transport authority | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#14](https://github.com/boburning/portcove/issues/14) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#31](https://github.com/boburning/portcove/issues/31) [Audit] Decompose PortcoveService along proven transaction boundaries | Alpha 3 / Required | 1.0 / Required | Ready → Ready | Medium / Next | [#14](https://github.com/boburning/portcove/issues/14) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#32](https://github.com/boburning/portcove/issues/32) [Audit] Bound frontend operation-event state | Alpha 3 / Required | Public beta / Required | Ready → Ready | Medium / Next | [#14](https://github.com/boburning/portcove/issues/14) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#33](https://github.com/boburning/portcove/issues/33) [Audit] Profile diagnostic durability cost before changing it | Beta 1 / Opportunistic | Public beta / Opportunistic | Ready → Ready | Low / Later | [#14](https://github.com/boburning/portcove/issues/14) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#34](https://github.com/boburning/portcove/issues/34) [Audit] Typed support-bundle data classification | Beta 2 / Opportunistic | 1.0 / Opportunistic | Ready → Ready | Medium / Later | [#14](https://github.com/boburning/portcove/issues/14) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#35](https://github.com/boburning/portcove/issues/35) [Audit] Bounded migration-lock diagnostics | Beta 2 / Opportunistic | 1.0 / Opportunistic | Ready → Ready | Low / Later | [#14](https://github.com/boburning/portcove/issues/14) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#265](https://github.com/boburning/portcove/issues/265) Reject conflicting checksum authorities for the same release asset | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | None | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#397](https://github.com/boburning/portcove/issues/397) Load compatible definitions and retain exact installed contracts | Alpha 3 / Required | 1.0 / Required | Blocked → Blocked | High / Next | [#246](https://github.com/boburning/portcove/issues/246) | [#245](https://github.com/boburning/portcove/issues/245) | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#398](https://github.com/boburning/portcove/issues/398) Observe configured upstream releases for the bounded freshness path | Beta 1 / Required | 1.0 / Required | Ready → Ready | High / Next | [#177](https://github.com/boburning/portcove/issues/177) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#246](https://github.com/boburning/portcove/issues/246) Automatically accept and deliver compatible definitions to existing clients | Beta 1 / Required | 1.0 / Required | Blocked → Blocked | High / Next | None | [#243](https://github.com/boburning/portcove/issues/243), [#398](https://github.com/boburning/portcove/issues/398), [#397](https://github.com/boburning/portcove/issues/397), [#265](https://github.com/boburning/portcove/issues/265), [#184](https://github.com/boburning/portcove/issues/184), [#245](https://github.com/boburning/portcove/issues/245) | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#177](https://github.com/boburning/portcove/issues/177) Automate read-only port discovery and durable issue intake | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Triage → Triage | High / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#247](https://github.com/boburning/portcove/issues/247) Classify release health with selective checks and scoped exceptions | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Blocked → Blocked | High / Later | None | [#245](https://github.com/boburning/portcove/issues/245), [#184](https://github.com/boburning/portcove/issues/184) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#254](https://github.com/boburning/portcove/issues/254) Extend catalog tooling with bounded proposals and automatic completion | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | High / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#268](https://github.com/boburning/portcove/issues/268) Import local definitions with explicit origin and conservative partial management | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Blocked → Blocked | High / Later | None | [#246](https://github.com/boburning/portcove/issues/246), [#245](https://github.com/boburning/portcove/issues/245) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#251](https://github.com/boburning/portcove/issues/251) Add game-centered discovery while preserving independent port identities | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | High / Later | None | [#139](https://github.com/boburning/portcove/issues/139) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#291](https://github.com/boburning/portcove/issues/291) Prove repeatable external-frontend export with an ES-DE profile | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Later | [#14](https://github.com/boburning/portcove/issues/14) | [#30](https://github.com/boburning/portcove/issues/30) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#292](https://github.com/boburning/portcove/issues/292) Evaluate safe optional Steam entry management | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Later | [#14](https://github.com/boburning/portcove/issues/14) | [#290](https://github.com/boburning/portcove/issues/290) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#249](https://github.com/boburning/portcove/issues/249) Import selected GitHub Launcher and Quiver libraries through reviewed adoption | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Later | None | [#27](https://github.com/boburning/portcove/issues/27) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#252](https://github.com/boburning/portcove/issues/252) Classify persistent data and add explicit portable-save export/import | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#253](https://github.com/boburning/portcove/issues/253) Synchronize classified portable saves through an optional user-selected transport | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Someday | None | [#252](https://github.com/boburning/portcove/issues/252) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#40](https://github.com/boburning/portcove/issues/40) Exact historical release selection with persistent pin/follow-latest semantics | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Low / Later | None | [#23](https://github.com/boburning/portcove/issues/23) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#250](https://github.com/boburning/portcove/issues/250) Add clean and customized profiles for one reviewed mod family | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Low / Later | None | [#40](https://github.com/boburning/portcove/issues/40) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#248](https://github.com/boburning/portcove/issues/248) Add durable resumable job foundations with stage-safe recovery | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Low / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#244](https://github.com/boburning/portcove/issues/244) Discover compatible games from explicitly selected game files | Alpha 3 / Opportunistic | Public beta / Opportunistic | Ready → Ready | High / Next | None | [#37](https://github.com/boburning/portcove/issues/37), [#180](https://github.com/boburning/portcove/issues/180) | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#255](https://github.com/boburning/portcove/issues/255) Measure comparative first-play, upgrade and migration usability through voluntary sessions | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#41](https://github.com/boburning/portcove/issues/41) Optional update relay | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Medium / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#42](https://github.com/boburning/portcove/issues/42) Hands-on port qualification | Beta 2 / Required | 1.0 / Required | Ready → Ready | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#43](https://github.com/boburning/portcove/issues/43) Real GitHub settings UX validation | Beta 2 / Required | 1.0 / Required | Ready → Ready | Medium / Later | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#44](https://github.com/boburning/portcove/issues/44) Controller-navigation polish and compact-layout qualification | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | None | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#45](https://github.com/boburning/portcove/issues/45) Broader operating-system qualification | Beta 2 / Required | 1.0 / Required | Ready → Ready | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#46](https://github.com/boburning/portcove/issues/46) Production signing and installer/upgrade validation | RC / Required | 1.0 / Required | Blocked → Blocked | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#47](https://github.com/boburning/portcove/issues/47) Activity, update, and source-readiness GUI validation | Beta 2 / Required | 1.0 / Required | Ready → Ready | Medium / Later | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#48](https://github.com/boburning/portcove/issues/48) Real-save backup and restore validation | Beta 2 / Required | 1.0 / Required | Ready → Ready | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#49](https://github.com/boburning/portcove/issues/49) Upstream-blocked Tauri GLib advisory | Beta 1 / Required | Public beta / Required | Blocked → Blocked | Medium / Later | None | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#200](https://github.com/boburning/portcove/issues/200) [Beta 1] Product language, content architecture, and interaction clarity | Beta 1 / Required | 1.0 / Required | Ready → Ready | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#51](https://github.com/boburning/portcove/issues/51) SteamOS/Steam Deck deployment profile and qualification | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | [#45](https://github.com/boburning/portcove/issues/45) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#199](https://github.com/boburning/portcove/issues/199) [Desktop] Make port release-channel controls truthful and functional | Beta 1 / Required | Public beta / Required | Ready → Ready | Medium / Next | None | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#227](https://github.com/boburning/portcove/issues/227) [Brand] Deterministic external-asset exporter and GitHub social preview | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Low / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#53](https://github.com/boburning/portcove/issues/53) [Port] Ghostship | Alpha 2 / Opportunistic | Public beta / Opportunistic | Validating → Validating | Medium / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#54](https://github.com/boburning/portcove/issues/54) [Port] DKR-R | Alpha 2 / Opportunistic | Public beta / Opportunistic | Validating → Validating | High / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#56](https://github.com/boburning/portcove/issues/56) [Port] re:Blue | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | Medium / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#97](https://github.com/boburning/portcove/issues/97) [Port] Dr. Mario 64 Recompiled | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#124](https://github.com/boburning/portcove/issues/124) [Port] Star Fox Enhanced | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | Low / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#135](https://github.com/boburning/portcove/issues/135) Extend managed PS1 recompilation for current PSXRecomp/RetComM manifests | Alpha 3 / Opportunistic | Public beta / Opportunistic | Ready → Ready | High / Later | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#136](https://github.com/boburning/portcove/issues/136) Add a generic ROM-first NES/SNES/Genesis recomp adapter | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Later | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#137](https://github.com/boburning/portcove/issues/137) Add a managed GameCube/Wii static-recompilation build contract | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Later | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#138](https://github.com/boburning/portcove/issues/138) Add an Xbox 360 ISO/STFS/title-update source and setup contract | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Later | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#139](https://github.com/boburning/portcove/issues/139) Define upstream successor and alternative-port policy | Alpha 3 / Opportunistic | Public beta / Opportunistic | Ready → Ready | High / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#141](https://github.com/boburning/portcove/issues/141) [Port] Yu-Gi-Oh! Forbidden Memories Recompiled | Alpha 2 / Opportunistic | Public beta / Opportunistic | Validating → Validating | High / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#143](https://github.com/boburning/portcove/issues/143) [Port] Revelations: Persona Recompiled | Alpha 2 / Opportunistic | Public beta / Opportunistic | Validating → Validating | High / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#148](https://github.com/boburning/portcove/issues/148) [Port] Soulcalibur II / Ring Out | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#149](https://github.com/boburning/portcove/issues/149) [Port] Mario Kart Wii / WiiCompiled | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#150](https://github.com/boburning/portcove/issues/150) [Port] Skate 3 Recomp | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | High / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#162](https://github.com/boburning/portcove/issues/162) [Port] Lollipop Chainsaw / Re-Cherry | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | Medium / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#202](https://github.com/boburning/portcove/issues/202) [UX] Add structured human errors, recovery actions, and mutation outcomes | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#203](https://github.com/boburning/portcove/issues/203) [UX] Add shared display mappings, formatting, localization primitives, and safe unknown fallbacks | Beta 1 / Required | 1.0 / Required | Ready → Ready | High / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#204](https://github.com/boburning/portcove/issues/204) [UX] Redesign safety-critical reviews and confirmations | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#205](https://github.com/boburning/portcove/issues/205) [UX] Separate saving game-update settings from executing updates | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#207](https://github.com/boburning/portcove/issues/207) [UX] Make CLI help and human rendering self-explanatory | Beta 1 / Required | 1.0 / Required | Ready → Ready | High / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#208](https://github.com/boburning/portcove/issues/208) [UX] Add structured catalog presentation fields and normalize summaries | Beta 1 / Required | 1.0 / Required | Ready → Ready | High / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#209](https://github.com/boburning/portcove/issues/209) [UX] Restructure player and maintainer documentation and add the content-design contract | Beta 1 / Required | 1.0 / Required | Ready → Ready | Medium / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#210](https://github.com/boburning/portcove/issues/210) [UX] Add accessibility, localization, responsive-copy, and terminology safeguards | Beta 1 / Required | Public beta / Required | Ready → Ready | Medium / Next | [#200](https://github.com/boburning/portcove/issues/200) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#211](https://github.com/boburning/portcove/issues/211) [UX] Polish issue forms, application metadata, and maintainer tools | Beta 2 / Opportunistic | 1.0 / Opportunistic | Ready → Ready | Low / Later | [#200](https://github.com/boburning/portcove/issues/200) | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#213](https://github.com/boburning/portcove/issues/213) [Steam Deck] Decide packaging and rootless home-install lifecycle | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | [#51](https://github.com/boburning/portcove/issues/51) | [#18](https://github.com/boburning/portcove/issues/18) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#214](https://github.com/boburning/portcove/issues/214) [Steam Deck] Add controller-first desktop mode and Desktop Mode handoff | Beta 1 / Required | Public beta / Required | Blocked → Blocked | High / Next | [#51](https://github.com/boburning/portcove/issues/51) | [#44](https://github.com/boburning/portcove/issues/44) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#215](https://github.com/boburning/portcove/issues/215) [Steam Deck] Qualify Gamescope environment, process tree, focus, suspend, and recovery | Beta 1 / Required | Public beta / Required | Blocked → Blocked | High / Next | [#51](https://github.com/boburning/portcove/issues/51) | [#49](https://github.com/boburning/portcove/issues/49), [#21](https://github.com/boburning/portcove/issues/21) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#216](https://github.com/boburning/portcove/issues/216) [Steam Deck] Qualify internal and removable storage behavior | Beta 1 / Required | Public beta / Required | Blocked → Blocked | High / Next | [#51](https://github.com/boburning/portcove/issues/51) | [#192](https://github.com/boburning/portcove/issues/192) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#290](https://github.com/boburning/portcove/issues/290) Document and qualify plugin-free Steam launch routes | Beta 1 / Required | Public beta / Required | Ready → Ready | High / Next | [#14](https://github.com/boburning/portcove/issues/14) | [#216](https://github.com/boburning/portcove/issues/216), [#215](https://github.com/boburning/portcove/issues/215), [#214](https://github.com/boburning/portcove/issues/214), [#213](https://github.com/boburning/portcove/issues/213), [#30](https://github.com/boburning/portcove/issues/30) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#217](https://github.com/boburning/portcove/issues/217) [Steam Deck] Complete hardware and representative-port lifecycle qualification | Beta 1 / Required | Public beta / Required | Blocked → Blocked | High / Next | [#51](https://github.com/boburning/portcove/issues/51) | [#290](https://github.com/boburning/portcove/issues/290), [#216](https://github.com/boburning/portcove/issues/216), [#215](https://github.com/boburning/portcove/issues/215), [#214](https://github.com/boburning/portcove/issues/214), [#213](https://github.com/boburning/portcove/issues/213) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#223](https://github.com/boburning/portcove/issues/223) [Windows updater] Define rollback, key custody, rotation, compromise, loss, and bridge release | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#52](https://github.com/boburning/portcove/issues/52) | None | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#219](https://github.com/boburning/portcove/issues/219) [Windows updater] Produce signed Tauri updater artifacts and release-only configuration | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#52](https://github.com/boburning/portcove/issues/52) | [#223](https://github.com/boburning/portcove/issues/223), [#23](https://github.com/boburning/portcove/issues/23) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#220](https://github.com/boburning/portcove/issues/220) [Windows updater] Generate and reconcile stable, beta, and versioned feeds | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#52](https://github.com/boburning/portcove/issues/52) | [#23](https://github.com/boburning/portcove/issues/23), [#219](https://github.com/boburning/portcove/issues/219) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#221](https://github.com/boburning/portcove/issues/221) [Windows updater] Implement host API, persistence, scheduling, URL restrictions, and busy exclusion | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#52](https://github.com/boburning/portcove/issues/52) | [#21](https://github.com/boburning/portcove/issues/21), [#220](https://github.com/boburning/portcove/issues/220) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#222](https://github.com/boburning/portcove/issues/222) [Windows updater] Build update banner, settings, progress, release notes, errors, and approval | Alpha 3 / Required | Public beta / Required | Ready → Ready | High / Next | [#52](https://github.com/boburning/portcove/issues/52) | [#221](https://github.com/boburning/portcove/issues/221) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#224](https://github.com/boburning/portcove/issues/224) [Windows updater] Qualify upgrade, rollback, tamper, and failure on clean Windows VMs | Beta 2 / Required | Public beta / Required | Ready → Ready | High / Next | [#52](https://github.com/boburning/portcove/issues/52) | [#223](https://github.com/boburning/portcove/issues/223), [#222](https://github.com/boburning/portcove/issues/222) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#52](https://github.com/boburning/portcove/issues/52) Windows desktop signed in-app updates | Beta 2 / Required | Public beta / Required | Ready → Ready | High / Next | None | [#21](https://github.com/boburning/portcove/issues/21), [#23](https://github.com/boburning/portcove/issues/23) | Preserve early safety/Deck outcomes or explicitly require complete updater at Public beta. |
| [#218](https://github.com/boburning/portcove/issues/218) Steam Machine / living-room SteamOS qualification | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Low / Later | [#45](https://github.com/boburning/portcove/issues/45) | [#51](https://github.com/boburning/portcove/issues/51) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#225](https://github.com/boburning/portcove/issues/225) Linux desktop signed in-app updates and qualification | Post-V1 / Opportunistic | Public beta / Required | Deferred → Ready | Low / Later | None | None | Explicitly promoted baseline updater path; prior Post-V1 deferral superseded. |
| [#226](https://github.com/boburning/portcove/issues/226) macOS desktop signed in-app updates and qualification | Post-V1 / Opportunistic | Public beta / Required | Deferred → Ready | Low / Later | None | None | Explicitly promoted baseline updater path; prior Post-V1 deferral superseded. |
| [#233](https://github.com/boburning/portcove/issues/233) Harden the lifecycle and governance of retired-project direct manifests | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | None / Someday | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#243](https://github.com/boburning/portcove/issues/243) Prove the shared lifecycle contract with a local Playnite reference client | Alpha 3 / Required | 1.0 / Required | Ready → Ready | High / Next | [#14](https://github.com/boburning/portcove/issues/14) | [#21](https://github.com/boburning/portcove/issues/21), [#30](https://github.com/boburning/portcove/issues/30) | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#262](https://github.com/boburning/portcove/issues/262) Browse, install, and update mods from one reviewed provider using managed profiles | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Triage → Triage | Medium / Later | None | [#250](https://github.com/boburning/portcove/issues/250) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#263](https://github.com/boburning/portcove/issues/263) Provide a persistent multi-game install/update queue in the desktop client | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Blocked → Blocked | Medium / Later | None | [#248](https://github.com/boburning/portcove/issues/248) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#269](https://github.com/boburning/portcove/issues/269) Collect opt-in scoped community evidence through existing report channels | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Blocked → Blocked | Medium / Later | None | [#184](https://github.com/boburning/portcove/issues/184) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#284](https://github.com/boburning/portcove/issues/284) Run preauthorized Ready work through a trusted resumable engineering controller | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Medium / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#293](https://github.com/boburning/portcove/issues/293) Evaluate an optional Decky client over the public CLI | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Ready → Ready | Low / Later | [#14](https://github.com/boburning/portcove/issues/14) | [#30](https://github.com/boburning/portcove/issues/30) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#314](https://github.com/boburning/portcove/issues/314) Add read-only audit regressions for stale blockers and partial discovery coverage | Alpha 2 / Opportunistic | Public beta / Opportunistic | Ready → Ready | Medium / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#315](https://github.com/boburning/portcove/issues/315) Implement optional legacy artifact verification only within an accepted trust design | Alpha 3 / Opportunistic | Public beta / Opportunistic | Blocked → Blocked | Medium / Later | None | [#245](https://github.com/boburning/portcove/issues/245) | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |
| [#316](https://github.com/boburning/portcove/issues/316) Evaluate a user-selected read-only RomM source provider | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Triage → Triage | Low / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#317](https://github.com/boburning/portcove/issues/317) [Port] Driver 2 / REDRIVER2 | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | Medium / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#319](https://github.com/boburning/portcove/issues/319) [Port] Castlevania: Symphony of the Night — PS1 / SymphonyRecomp | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | Medium / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#320](https://github.com/boburning/portcove/issues/320) [Port] Castlevania: Legacy of Darkness / Legacy of Darkness Recompiled | Alpha 3 / Opportunistic | Public beta / Opportunistic | Triage → Triage | Medium / Next | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#410](https://github.com/boburning/portcove/issues/410) Add a sideloaded Android client for qualified native ports | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Medium / Later | None | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#411](https://github.com/boburning/portcove/issues/411) Qualify the Android native-port candidate pool | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Medium / Later | [#410](https://github.com/boburning/portcove/issues/410) | None | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#412](https://github.com/boburning/portcove/issues/412) Prove Android package and document integration over the shared core | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Medium / Later | [#410](https://github.com/boburning/portcove/issues/410) | [#397](https://github.com/boburning/portcove/issues/397) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#413](https://github.com/boburning/portcove/issues/413) Build capability-aware Android discovery, setup, updates and launch | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Medium / Later | [#410](https://github.com/boburning/portcove/issues/410) | [#411](https://github.com/boburning/portcove/issues/411), [#412](https://github.com/boburning/portcove/issues/412) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#414](https://github.com/boburning/portcove/issues/414) Qualify Android devices, signed APK upgrades and Obtainium distribution | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Medium / Later | [#410](https://github.com/boburning/portcove/issues/410) | [#413](https://github.com/boburning/portcove/issues/413), [#412](https://github.com/boburning/portcove/issues/412), [#411](https://github.com/boburning/portcove/issues/411) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#519](https://github.com/boburning/portcove/issues/519) [Port] Super Mario 64 Render96 | Beta 1 / Opportunistic | Public beta / Opportunistic | Inbox → Inbox | Medium / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#520](https://github.com/boburning/portcove/issues/520) [Port] Super Mario Bros. Remastered | Beta 1 / Opportunistic | Public beta / Opportunistic | Inbox → Inbox | Medium / Later | Preserved; no parent mutation | None | Vocabulary migration only; independent port scope/priority and Opportunistic commitment preserved. |
| [#521](https://github.com/boburning/portcove/issues/521) Show optional local observed session duration across clients | Post-V1 / Opportunistic | Post-1.0 / Opportunistic | Deferred → Deferred | Low / Later | None | [#21](https://github.com/boburning/portcove/issues/21) | Vocabulary only; optional/deferred scope, status and priority preserved. |
| [#527](https://github.com/boburning/portcove/issues/527) Add optional SteamGridDB artwork inside Portcove | Beta 1 / Opportunistic | Public beta / Opportunistic | Blocked → Blocked | Medium / Next | None | None | Finite integration, catalog, polish or broader qualification remains Required for 1.0; no mandatory numbered feature freeze. Prioritize implementation during beta. |

## Required coverage by identity

All 91 original Required identities remain Required. No original
Required outcome was closed by this task. Completed items retain historical
targets; active Required items map explicitly above. New Required identities
are #225/#226 promotion and #532/#533/#534/#535; none replaces or erases old scope.

| Original Required identity | Original target | Original status | Retained/new target |
|---|---|---|---|
| [#13](https://github.com/boburning/portcove/issues/13) | Alpha 1 | Done | Alpha 1 |
| [#14](https://github.com/boburning/portcove/issues/14) | Alpha 3 | Ready | 1.0 |
| [#15](https://github.com/boburning/portcove/issues/15) | Alpha 2 | Done | Alpha 2 |
| [#17](https://github.com/boburning/portcove/issues/17) | Alpha 1 | Done | Alpha 1 |
| [#18](https://github.com/boburning/portcove/issues/18) | Alpha 1 | Done | Alpha 1 |
| [#19](https://github.com/boburning/portcove/issues/19) | Alpha 1 | Done | Alpha 1 |
| [#20](https://github.com/boburning/portcove/issues/20) | Alpha 1 | Done | Alpha 1 |
| [#22](https://github.com/boburning/portcove/issues/22) | Alpha 1 | Done | Alpha 1 |
| [#23](https://github.com/boburning/portcove/issues/23) | Alpha 1 | Done | Alpha 1 |
| [#212](https://github.com/boburning/portcove/issues/212) | Alpha 1 | Done | Alpha 1 |
| [#21](https://github.com/boburning/portcove/issues/21) | Alpha 1 | Done | Alpha 1 |
| [#178](https://github.com/boburning/portcove/issues/178) | Alpha 2 | Done | Alpha 2 |
| [#245](https://github.com/boburning/portcove/issues/245) | Alpha 3 | Ready | 1.0 |
| [#190](https://github.com/boburning/portcove/issues/190) | Alpha 2 | Done | Alpha 2 |
| [#201](https://github.com/boburning/portcove/issues/201) | Alpha 2 | Done | Alpha 2 |
| [#27](https://github.com/boburning/portcove/issues/27) | Alpha 2 | Done | Alpha 2 |
| [#191](https://github.com/boburning/portcove/issues/191) | Alpha 2 | Done | Alpha 2 |
| [#183](https://github.com/boburning/portcove/issues/183) | Alpha 2 | Done | Alpha 2 |
| [#206](https://github.com/boburning/portcove/issues/206) | Beta 1 | In progress | Public beta |
| [#36](https://github.com/boburning/portcove/issues/36) | Alpha 2 | Done | Alpha 2 |
| [#37](https://github.com/boburning/portcove/issues/37) | Alpha 2 | Done | Alpha 2 |
| [#38](https://github.com/boburning/portcove/issues/38) | Alpha 2 | Done | Alpha 2 |
| [#39](https://github.com/boburning/portcove/issues/39) | Alpha 2 | Done | Alpha 2 |
| [#24](https://github.com/boburning/portcove/issues/24) | Alpha 3 | Ready | 1.0 |
| [#25](https://github.com/boburning/portcove/issues/25) | Alpha 1 | Done | Alpha 1 |
| [#26](https://github.com/boburning/portcove/issues/26) | Alpha 1 | Done | Alpha 1 |
| [#28](https://github.com/boburning/portcove/issues/28) | Alpha 1 | Done | Alpha 1 |
| [#29](https://github.com/boburning/portcove/issues/29) | Alpha 3 | Ready | Public beta |
| [#30](https://github.com/boburning/portcove/issues/30) | Alpha 3 | Ready | Public beta |
| [#31](https://github.com/boburning/portcove/issues/31) | Alpha 3 | Ready | 1.0 |
| [#32](https://github.com/boburning/portcove/issues/32) | Alpha 3 | Ready | Public beta |
| [#265](https://github.com/boburning/portcove/issues/265) | Beta 1 | Ready | Public beta |
| [#397](https://github.com/boburning/portcove/issues/397) | Alpha 3 | Blocked | 1.0 |
| [#398](https://github.com/boburning/portcove/issues/398) | Beta 1 | Ready | 1.0 |
| [#246](https://github.com/boburning/portcove/issues/246) | Beta 1 | Blocked | 1.0 |
| [#42](https://github.com/boburning/portcove/issues/42) | Beta 2 | Ready | 1.0 |
| [#43](https://github.com/boburning/portcove/issues/43) | Beta 2 | Ready | 1.0 |
| [#44](https://github.com/boburning/portcove/issues/44) | Alpha 3 | Ready | Public beta |
| [#45](https://github.com/boburning/portcove/issues/45) | Beta 2 | Ready | 1.0 |
| [#46](https://github.com/boburning/portcove/issues/46) | RC | Blocked | 1.0 |
| [#47](https://github.com/boburning/portcove/issues/47) | Beta 2 | Ready | 1.0 |
| [#48](https://github.com/boburning/portcove/issues/48) | Beta 2 | Ready | 1.0 |
| [#49](https://github.com/boburning/portcove/issues/49) | Beta 1 | Blocked | Public beta |
| [#50](https://github.com/boburning/portcove/issues/50) | Alpha 1 | Done | Alpha 1 |
| [#200](https://github.com/boburning/portcove/issues/200) | Beta 1 | Ready | 1.0 |
| [#51](https://github.com/boburning/portcove/issues/51) | Beta 1 | Ready | Public beta |
| [#199](https://github.com/boburning/portcove/issues/199) | Beta 1 | Ready | Public beta |
| [#175](https://github.com/boburning/portcove/issues/175) | Alpha 1 | Done | Alpha 1 |
| [#179](https://github.com/boburning/portcove/issues/179) | Alpha 2 | Done | Alpha 2 |
| [#180](https://github.com/boburning/portcove/issues/180) | Alpha 2 | Done | Alpha 2 |
| [#181](https://github.com/boburning/portcove/issues/181) | Alpha 2 | Done | Alpha 2 |
| [#182](https://github.com/boburning/portcove/issues/182) | Alpha 2 | Done | Alpha 2 |
| [#184](https://github.com/boburning/portcove/issues/184) | Alpha 2 | Done | Alpha 2 |
| [#185](https://github.com/boburning/portcove/issues/185) | Alpha 2 | Done | Alpha 2 |
| [#186](https://github.com/boburning/portcove/issues/186) | Alpha 2 | Done | Alpha 2 |
| [#187](https://github.com/boburning/portcove/issues/187) | Alpha 2 | Done | Alpha 2 |
| [#188](https://github.com/boburning/portcove/issues/188) | Alpha 2 | Done | Alpha 2 |
| [#189](https://github.com/boburning/portcove/issues/189) | Alpha 2 | Done | Alpha 2 |
| [#192](https://github.com/boburning/portcove/issues/192) | Alpha 2 | Done | Alpha 2 |
| [#193](https://github.com/boburning/portcove/issues/193) | Alpha 2 | Done | Alpha 2 |
| [#194](https://github.com/boburning/portcove/issues/194) | Alpha 2 | Done | Alpha 2 |
| [#195](https://github.com/boburning/portcove/issues/195) | Alpha 2 | Done | Alpha 2 |
| [#196](https://github.com/boburning/portcove/issues/196) | Alpha 2 | Done | Alpha 2 |
| [#197](https://github.com/boburning/portcove/issues/197) | Alpha 2 | Done | Alpha 2 |
| [#198](https://github.com/boburning/portcove/issues/198) | Alpha 2 | Done | Alpha 2 |
| [#202](https://github.com/boburning/portcove/issues/202) | Beta 1 | Ready | Public beta |
| [#203](https://github.com/boburning/portcove/issues/203) | Beta 1 | Ready | 1.0 |
| [#204](https://github.com/boburning/portcove/issues/204) | Beta 1 | Ready | Public beta |
| [#205](https://github.com/boburning/portcove/issues/205) | Beta 1 | Ready | Public beta |
| [#207](https://github.com/boburning/portcove/issues/207) | Beta 1 | Ready | 1.0 |
| [#208](https://github.com/boburning/portcove/issues/208) | Beta 1 | Ready | 1.0 |
| [#209](https://github.com/boburning/portcove/issues/209) | Beta 1 | Ready | 1.0 |
| [#210](https://github.com/boburning/portcove/issues/210) | Beta 1 | Ready | Public beta |
| [#213](https://github.com/boburning/portcove/issues/213) | Beta 1 | Ready | Public beta |
| [#214](https://github.com/boburning/portcove/issues/214) | Beta 1 | Blocked | Public beta |
| [#215](https://github.com/boburning/portcove/issues/215) | Beta 1 | Blocked | Public beta |
| [#216](https://github.com/boburning/portcove/issues/216) | Beta 1 | Blocked | Public beta |
| [#290](https://github.com/boburning/portcove/issues/290) | Beta 1 | Ready | Public beta |
| [#217](https://github.com/boburning/portcove/issues/217) | Beta 1 | Blocked | Public beta |
| [#223](https://github.com/boburning/portcove/issues/223) | Alpha 3 | Ready | Public beta |
| [#219](https://github.com/boburning/portcove/issues/219) | Alpha 3 | Ready | Public beta |
| [#220](https://github.com/boburning/portcove/issues/220) | Alpha 3 | Ready | Public beta |
| [#221](https://github.com/boburning/portcove/issues/221) | Alpha 3 | Ready | Public beta |
| [#222](https://github.com/boburning/portcove/issues/222) | Alpha 3 | Ready | Public beta |
| [#224](https://github.com/boburning/portcove/issues/224) | Beta 2 | Ready | Public beta |
| [#52](https://github.com/boburning/portcove/issues/52) | Beta 2 | Ready | Public beta |
| [#242](https://github.com/boburning/portcove/issues/242) | Alpha 2 | Done | Alpha 2 |
| [#243](https://github.com/boburning/portcove/issues/243) | Alpha 3 | Ready | 1.0 |
| [#499](https://github.com/boburning/portcove/issues/499) | Alpha 2 | Done | Alpha 2 |
| [#506](https://github.com/boburning/portcove/issues/506) | Alpha 2 | Done | Alpha 2 |
| [#524](https://github.com/boburning/portcove/issues/524) | Alpha 3 | Done | Alpha 3 |

## Genuine relationship additions

| Outcome | Added blocking prerequisites |
|---|---|
| [#14](https://github.com/boburning/portcove/issues/14) | [#24](https://github.com/boburning/portcove/issues/24), [#29](https://github.com/boburning/portcove/issues/29), [#30](https://github.com/boburning/portcove/issues/30), [#31](https://github.com/boburning/portcove/issues/31), [#32](https://github.com/boburning/portcove/issues/32), [#44](https://github.com/boburning/portcove/issues/44), [#243](https://github.com/boburning/portcove/issues/243) |
| [#46](https://github.com/boburning/portcove/issues/46) | [#52](https://github.com/boburning/portcove/issues/52) |
| [#51](https://github.com/boburning/portcove/issues/51) | [#217](https://github.com/boburning/portcove/issues/217) |
| [#52](https://github.com/boburning/portcove/issues/52) | [#224](https://github.com/boburning/portcove/issues/224), [#225](https://github.com/boburning/portcove/issues/225), [#226](https://github.com/boburning/portcove/issues/226), [#535](https://github.com/boburning/portcove/issues/535), [#533](https://github.com/boburning/portcove/issues/533), [#534](https://github.com/boburning/portcove/issues/534) |
| [#220](https://github.com/boburning/portcove/issues/220) | [#532](https://github.com/boburning/portcove/issues/532) |
| [#225](https://github.com/boburning/portcove/issues/225) | [#222](https://github.com/boburning/portcove/issues/222), [#223](https://github.com/boburning/portcove/issues/223) |
| [#226](https://github.com/boburning/portcove/issues/226) | [#222](https://github.com/boburning/portcove/issues/222), [#223](https://github.com/boburning/portcove/issues/223) |
| [#533](https://github.com/boburning/portcove/issues/533) | [#223](https://github.com/boburning/portcove/issues/223), [#219](https://github.com/boburning/portcove/issues/219), [#220](https://github.com/boburning/portcove/issues/220), [#532](https://github.com/boburning/portcove/issues/532) |
| [#534](https://github.com/boburning/portcove/issues/534) | [#223](https://github.com/boburning/portcove/issues/223), [#533](https://github.com/boburning/portcove/issues/533), [#532](https://github.com/boburning/portcove/issues/532) |
| [#535](https://github.com/boburning/portcove/issues/535) | [#225](https://github.com/boburning/portcove/issues/225), [#213](https://github.com/boburning/portcove/issues/213), [#214](https://github.com/boburning/portcove/issues/214), [#215](https://github.com/boburning/portcove/issues/215), [#216](https://github.com/boburning/portcove/issues/216), [#290](https://github.com/boburning/portcove/issues/290) |

#225, #226 and #535 are added beneath #52; all existing parents/children are
preserved. #51 and its package/controller/Gamescope/storage/device children are
not reparented. #14 final integration depends only on its finite required slices,
not all optional children. #51 final baseline depends on #217. #46's later
production closure depends on #52; there is no reverse edge. The graph is acyclic.
The preferred Windows/Linux/Deck/macOS execution order creates no artificial
Windows-before-Linux or Linux-before-macOS blocker. #223 design/test-key fixtures
remain the next independently runnable updater slice, alongside early platform
feasibility. Existing urgent #245 catalog design remains independently runnable.

## Resulting readiness and view evidence

| Readiness | Effective Required | Unfinished | Result |
|---|---|---|---|
| Before Alpha 1 | 14 | 0 | READY |
| Before Alpha 2 | 45 | 0 | READY |
| Before Alpha 3 | 61 | 15 | NOT READY |
| Before Beta 1 | 83 | 37 | NOT READY |
| Before Beta 2 | 90 | 44 | NOT READY |
| Before RC | 91 | 45 | NOT READY |
| Before V1 | 91 | 45 | NOT READY |
| After Public beta | 77 | 32 | NOT READY |
| After 1.0 | 97 | 51 | NOT READY |

Readback retains all 416 original items; 421 total
items include planning #531 and four new implementation/provisioning owners.
Both new milestones have zero migration, classification, target, status,
missing-Project, truncated-dependency or cycle conflicts. NOT READY correctly
reflects unfinished implementation/evidence rather than an incomplete migration.

The same 10 view identities are reused. Current Release selects Public beta;
V1 Readiness retains its name/identity and includes historical stages plus Public
beta and 1.0. In-app browser inspection confirmed Priority Stack none/manual;
Now Board Status/manual; Port Pipeline Port stage/Priority ascending;
Product Roadmap Target release/manual; Current Release, Blocked & Deferred,
Steam Deck and Active Port Work Status/Priority ascending; Inbox & Triage
Status/manual; V1 Readiness Target release/Priority ascending. No grouping,
sorting, built-in workflow, priority or manual ordering change was needed.

The migration survived a TLS handshake timeout by rereading current state and
resuming idempotent edits. Unexpected concurrent body/title/state/field changes
abort rather than overwrite; each applied field/body has exact readback. A full
identity comparison verifies unchanged port bodies/titles, original Required
coverage and all preserved field values. Legacy stage invocations remain usable
for history; candidate-scope evaluates explicit implementation outcomes without
pretending to grant publication or milestone readiness.

## Subsequent implementation and activation

[Delivery policy](../DELIVERY.md) defines forward versions, Stable/Preview,
zero additional service/certificate fees, consent/safe exit/restart behavior,
platform paths, trust/compatibility/recovery, cadence and evidence applicability.
Paid publisher signing stays optional. #532 classification must precede
suffix-free beta; #533 implements automation using fixtures/test keys; #534
requires separately authorized real custody/backup, least privilege, Pages/free
limit verification and end-to-end activation proof. Pages returned 404 during
inspection; no site availability or provisioning is claimed. Routine success
should require zero owner actions only after that implementation/provisioning.

No application release, version/tag, production updater, signing key/secret,
production packaging/publication workflow, paid service, billing, security
protection/permission or user/Steam installation was changed. Product and
qualification issues remain open. Check, review, PR/merge and final live doctor
evidence are recorded on #531 against the exact reviewed revision.
