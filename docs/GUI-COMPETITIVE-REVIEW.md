# GUI competitive review

This review captures the 2026-09-01 product baseline for Portcove's desktop experience. It uses the direct upstreams at the following inspected commits rather than screenshots or claims copied through a third-party catalog:

- [GithubLauncher](https://github.com/SirDiabo/GithubLauncher) at `6e62a967cb37a2106b0420dc47375ee83cac41d3`
- [Quiver Launcher](https://github.com/tgeorgiadis/quiver-launcher) at `ff1c4efd72c15c9de39007acc8169fbdec5dbc43`
- [RetComM Launcher](https://github.com/TechnicallyComputers/RetComM-Launcher) at `4a30d0615ddbf71c9c62c3bce1e3b6163e42a1bd`

The goal is not visual imitation. Each competitor solves a different part of the launcher problem well; Portcove should combine the best interaction lessons with its stricter release, source, rollback, and automation contracts.

## What the competitors establish

| Product          | Strongest interaction ideas                                                                                                                                                                    | Product pressure on Portcove                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GithubLauncher   | Immediate cover-led library, a prominent Continue action, direct download/play affordances, installed filtering, multiple layout presets, and a deliberately short first-run path.             | A launcher must answer “what can I play?” before explaining how it manages releases.                                                       |
| Quiver Launcher  | Search and tag filtering, a community catalog review flow, manual app adoption, visible update badges, mods, top-bar utilities, and explicit keyboard/controller hints.                        | A larger catalog needs fast retrieval and power features that do not bury the basic play loop.                                             |
| RetComM Launcher | Persistent build/queue state, background work, platform shelves, selected-game readiness, ROM/BIOS import, storage-root selection, save/controller management, and detailed disc verification. | Long-running or source-heavy workflows need visible progress, precise readiness, and a useful next action instead of generic failure text. |

The common weakness is density: as catalog, mod, source, build, and settings features accumulate, repository-shaped controls can compete with the game the user intended to launch. Portcove should keep advanced controls available without making them the default reading order.

## Portcove's differentiator

Portcove's GUI should be the clearest view of a stronger underlying contract:

1. **Readiness first.** Every installed card distinguishes a launch-ready port, a missing original source or BIOS, one-time upstream setup, and a staged update.
2. **One primary action.** Play or Install owns the detail surface. Release channels, policies, verification, rollback, and removal remain one deliberate disclosure away.
3. **Trust is visible.** Checksum-qualified releases, local-only source handling, retained rollback, automated qualification, and hands-on evidence are product information rather than hidden implementation details.
4. **Background work is legible.** The Update Center and operation layer own progress and failures; cards stay scannable.
5. **Controller navigation follows space.** D-pad, stick, and arrow input move in the direction the interface is laid out instead of following source order.
6. **The CLI remains the engine.** Playnite, LaunchBox, RetroBat, Batocera, EmuDeck, scripts, and future frontends receive the same lifecycle behavior without scraping GUI state.

## Implemented polish slices

- Library readiness summary for launch-ready, setup-pending, source-blocked, and staged installs.
- Library-specific Ready and Needs setup filters; catalog-specific release-channel filters.
- Art-directed deterministic cards with clearer title, channel, platform, version, and next-action hierarchy while a provenance-safe artwork pipeline remains pending.
- A readiness banner and dominant Play/Install action in the detail drawer.
- Advanced disclosure for release channels, update policy, source replacement, qualification evidence, verification, rollback, and removal.
- Spatial D-pad, analog-stick, and keyboard-arrow focus movement.
- Controller B and keyboard Escape share the same predictable Back behavior.
- Search expanded to project names, summaries, IDs, adapters, and platform identifiers.
- A service-owned readiness contract keeps cards and third-party consumers from inferring launchability from install presence alone.
- Continue is driven by successful process exits shared by the CLI and desktop app; failed starts and non-zero exits never become recent-play history.
- The Update Center includes a durable recent-activity ledger for update checks, installs, updates, policy runs, verification, activation, rollback, adoption, removal, source registration, and failures. It reads the same typed core records exposed to external CLI frontends instead of maintaining a GUI-only queue. Long desktop operations refresh the ledger after they begin; port activity opens the relevant detail panel, source activity opens source recovery, and a record still marked running after 24 hours is presented as unfinished without rewriting shared history.
- Successful update checks persist through the Rust core, so CLI checks, desktop restarts, the sidebar badge, catalog cards, and the Update Center share one timestamped view. Version and channel guards suppress stale badges after activation or channel changes.
- Settings groups every missing game source and BIOS required by installed ports, identifies each dependent game and role, and launches the profile-correct file, folder, or ZIP picker. Registration still passes through the same exact core validation and local-only source contract.
- Source-dependent installs remain disabled until every required game source and BIOS has a selected or registered path, replacing a predictable core rejection with an explicit prerequisite. Ports without source requirements stay one-click installable.
- Installation now has an explicit on-demand review step instead of resolving every catalog card in the background. It shows the selected release, verified local reuse or upstream download size, and available volume capacity; a download that cannot fit even its compressed asset is blocked before work starts. The core uses the same plan states and reuses matching staged or retained verified releases instead of downloading them again.
- Settings reads the core storage summary and shows the selected library path plus available containing-volume capacity. The same raw byte counts are available to external frontends through `storage`.
- Port details show the canonical persistent-data root supplied by core status and can open that exact root through a port-ID-scoped desktop command, while `paths` exposes the root and every managed version root to external launchers and backup tools. The GUI does not imply that a particular filename is always the save; backing up the whole root preserves each upstream's reviewed saves, configuration, bindings, mods, and generated state.
- Installed-port maintenance lists recent verified persistent-data snapshots and can create, restore, or delete one through the same core contract as the CLI. Restore and deletion require explicit native confirmation; restore verifies the snapshot before mutation and creates a safety backup of current data. Every outcome appears in shared activity.
- The application shell now uses one semantic N64-inspired dark/light design system, compact typography and geometry, a coherent Lucide icon language, tactile state transitions, a gold focus vocabulary, and a restrained four-color brand motif.
- A searchable `Ctrl/Cmd+K` command palette bridges GUI navigation and operational actions. `Ctrl/Cmd+1–4` navigates the stable shell and `/` focuses catalog search without interfering with fields or dialogs.
- Port details expose the canonical install or launch CLI invocation for copy, keeping terminology and behavior continuous for scripts and external frontends.
- Errors lead with a human explanation and offer copyable details; operations present honest determinate counts when known and descriptive indeterminate stages when not.
- Empty, loading, settings, update, source-health, and detail states now explain context and next action instead of displaying generic placeholders.
- Shared focus trapping, Escape behavior, focus restoration, reduced motion, semantic status labels, and responsive desktop breakpoints make the Tauri interface resilient without turning it into a mobile layout.
- The long-term design, component, and product-vocabulary contract is recorded in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

## Superseded Public beta implementation choice — 2026-09-17

This is a planning decision, not an implemented-polish claim. Reinspection at
main `ad7ed2f2bc1a3f6c86eb6f74c87b02a4c008e159` found a strong semantic theme
and mature interaction surfaces, but presentation still concentrated in a
3,765-nonblank-line global stylesheet and theme validation limited to that file. No newer
issue already owned visual-polish or styling-architecture modernization.

The finite [#917](https://github.com/boburning/portcove/issues/917) outcome keeps
the established alternate-1997-console-studio direction while making the
desktop calmer and more launcher-like: artwork/title/readiness/action lead;
cards shed equal-weight badge noise; sidebar and recurring headers become quieter;
ordinary spacing and depth follow one hierarchy; detail emphasizes one action;
Settings gains scalable logical groups; motion stays tactile and reduced-motion
safe; typography becomes deterministic and offline; and static loading geometry
prevents layout jumps without shimmer.

The 2026-09-17 choice of native CSS plus incremental CSS Modules and no CSS
framework is historical. The owner superseded it on 2026-09-19 with the finite
[#917](https://github.com/boburning/portcove/issues/917) official shadcn/ui Base
UI, Tailwind, semantic-variable, and custom Portcove theme direction. The visual
findings and restrained artwork-first direction remain useful; the former stack
comparison is not an active instruction and should not be reopened absent a
concrete compatibility blocker.

The approved migration checks in only the needed official component source,
starts from the compact Nova style, retains Lucide and React/Vite/Tauri, and uses
a small hierarchy of shared controls, reusable interface patterns, and
feature-owned product components. It still excludes Sass, CSS-in-JS, gradients,
glow, blur-heavy surfaces, ornamental retro effects, Steam imitation, brand
redesign, a second cache/policy backend, and a custom component registry.

#917 is the Required Public beta child; its organizational parent relationship
does not make #200 closure a beta prerequisite. #206 continues to own information
architecture and interaction behavior; #203 owns wording/formatting/safe unknowns;
#208/#527 own artwork/provider facts; semantic domain owners own readiness,
updates, storage, source, recovery, and support state; #29/#44/#47 retain their
input, minimum-width, physical, and intrinsic human qualification. Visual code
renders those authorities and does not become another source of truth.

## Follow-on slices at the 2026-09-01 baseline

These are intentionally separate from this pass because they require new product data or backend contracts:

- A provenance-recorded artwork model with deterministic local fallback art. Do not scrape or redistribute box art without a reviewed license/source field.
- Resumable background jobs, pause/cancel semantics, and crash recovery if a later workflow needs work that must survive process exit; the current durable ledger records truthfully completed, failed, and still-running operations without pretending they are resumable.
- Optional install-root selection after multi-root placement and free-space policy are defined in the core.
- Mod discovery only after package integrity, ownership, conflict, and update semantics are modeled; it is not a decorative GUI feature.

## PortForge evidence — 2026-09-08

This bounded source and release review informs player workflows, not code or
artwork reuse. Inspected revisions:

- [PortForge app](https://github.com/zamiba/portforge-app/tree/a91f2ed5879753ef2b61d36d12b07477a7ca9ea7)
  at `a91f2ed5879753ef2b61d36d12b07477a7ca9ea7`.
- [MediaItems catalog](https://github.com/zamiba/portforge-mediaitems/tree/a721d8abd27552a38513bcc21eebfa6ff6ab8121)
  at `a721d8abd27552a38513bcc21eebfa6ff6ab8121`.
- [Forge engine](https://github.com/zamiba/forge/tree/5030b6d49e60aed79dfa56fa9b9622717932bd54)
  at `5030b6d49e60aed79dfa56fa9b9622717932bd54`; the inspected app declares
  Forge `v0.0.3-alpha`, so current engine source is not automatically evidence
  for every shipped app behavior.

The app's [v0.2.0-alpha release](https://github.com/zamiba/portforge-app/releases/tag/v0.2.0-alpha)
was published on September 7 with Windows, Linux and macOS assets. Its tag
resolves to `fd489ca2bb6a5acea6d1d60dc1aca06d45977b00`, distinct from inspected
main. Release notes and assets establish publication, not tested functionality
on those platforms. No application, recipe or game was run in this review.

| Finding                                       | Inspected implementation evidence                                                                                                                                            | Portcove disposition                                                                                                                                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separately refreshed catalog                  | `app.go::SyncMediaItems` fetches the MediaItems archive, updates local metadata and rebuilds the index.                                                                      | Reinforces #245/#397/#398/#246. Metadata refresh does not prove autonomous upstream observation, protected acceptance or exact publication. Format 1 still cannot deliver new Portcove definitions. |
| File-first and catalog-relevant ROM discovery | `SelectROMFiles`, `GetROMLibrary`, ROM indexing and the ROMs surface expose multiple files, requirements and owned inputs.                                                   | #244 extends completed #36/#180 inspection and #37 intake. Keep source compatibility separate from operation readiness and preserve explicit registration/import.                                   |
| Covers and detail imagery                     | `thumbs.go` creates display-sized cached images; cards and details separate artwork from titles/status.                                                                      | #208/#206 own reviewed/local artwork, bounded decoding/cache behavior, attribution, accessible fallbacks and stable geometry. Competitor cache behavior is not a Portcove resource-safety proof.    |
| Configurable preparation                      | Forge argument/dependency checks and MediaItems build specifications describe options, ordered preparation and declared targets.                                             | #31 proves one useful typed preparation choice through shared core contracts. No unrestricted recipe runner, engine rewrite or cross-compilation claim follows.                                     |
| Defaults and named executables                | `app.go` resolves a declared default version; `GameDetail.vue` presents versions and additional executables.                                                                 | #206/#208 clarify current/default/recommended/installed states. #31 covers validated alternatives when needed by its bounded proof; #40 historical selection and #250 profiles remain separate.     |
| Storage and failed work                       | Storage source/tests expose unavailable locations; `App.vue` retains a bounded visible log and install banner, while `GameDetail.vue` points to `install.log` after failure. | Preserve #38 storage evidence; #206/#202/#203/#204 own visibility, phase wording, diagnostics and accurate recovery actions. No full #248 scheduler prerequisite.                                   |
| Local duration                                | `LaunchVersion` measures elapsed time around the child and adds it to `TotalPlaySeconds`; details display that counter.                                                      | #521 is an optional shared-session follow-on to completed #21. Observed process duration is not active gameplay; unknown/crashed/suspended accounting needs explicit semantics.                     |

The inspected PortForge catalog contains nine `VideoGameFanPort` records. Exact recipe
upstreams reconcile seven to existing owners: Ghostship #53, re:Blue #56, Ship
of Harkinian #58, SpaghettiKart #60, Starship #61, Banjo: Recompiled #65 and
Gen1Recomp #98. Different display names do not establish missing ports.
Only the following two independent implementations needed new intake:

- **Render96 (#519):** the recipe uses Render96ex
  `cd02b8886e0a0498c23b0c1f1e58f0b7c70ccc66`, a Linux source build, optional
  SM64-Reloaded textures and ModelPack 3.25. Direct
  [Render96ex source](https://github.com/Render96/Render96ex/tree/48da5c491c8abfb2f5192b59278c1c269411e533)
  exposes build/backend choices and `--savepath`. Toolchain acquisition,
  generated versus persistent data, content rights and update behavior remain
  research. The ModelPack asset API returned no digest; computing one locally
  would not establish its initial trust. This is a candidate proof, not #31's
  required title or a new support claim.
- **Super Mario Bros. Remastered (#520):** exact upstream is
  [JHDev2006/Super-Mario-Bros.-Remastered-Public](https://github.com/JHDev2006/Super-Mario-Bros.-Remastered-Public/tree/f379a3257ef1cf89cf4bf911f40c9262447da2c6).
  The recipe offers 1.0.2/1.1 RC4, while direct releases already include
  [1.1-stable](https://github.com/JHDev2006/Super-Mario-Bros.-Remastered-Public/releases/tag/1.1-stable).
  RC4/RC5 API records have `prerelease=false`, requiring a deliberate channel
  policy. Current source expects `portable.txt` beside the executable and
  otherwise may fall back to `user://`; the Windows recipe puts it in `config/`.
  The ROM validator hashes Base64 text of a header-stripped bounded input,
  not the whole ROM bytes. Selected-release layout, identity, portable fallback
  and persistent-data behavior need proof before admission.

For **re:Blue (#56)**, the catalog names three required discs with per-disc
alternatives and Windows normal/Vulkan executables. That does not prove safe
region/revision mixing, isolated setup, shared registration, self-copy/relaunch
or save ownership. Preserve existing operational holds while investigating a
finite isolated or partial-management route; a safe local route need not await
a special upstream release, and partial management is not full support.

PortForge's MediaItems catalog is a future bounded discovery source under #177,
with exact source revisions, canonical deduplication and explicit access gaps.
It receives no admission or publication authority. Its artwork rights notice
does not authorize redistribution by Portcove. The applied planning decisions
and review belong to [#518](https://github.com/boburning/portcove/issues/518);
current scheduling remains solely in the live Project. Alpha 2's package handoff
and existing Required commitments are preserved. These observations add no
product implementation, catalog admission or qualification evidence.

## Quiver evidence refresh — 2026-09-21

This refresh is a bounded official-source, release, and catalog review. No
Quiver build was installed or executed, and no runtime, gameplay, save-load,
controller, platform-qualification, or comparative-usability result is claimed.

- [Quiver Launcher v3.4.5](https://github.com/tgeorgiadis/quiver-launcher/releases/tag/v3.4.5)
  was published on September 21 and resolves to
  `425506283e453fcea2e1c8176d6aa965e4b16177`. Its release notes provide Windows
  portable, Linux x64/ARM64 AppImage, and Android packages while describing
  macOS signing as work in progress. They also document local-library loading
  without waiting for network refresh, saved version information, shared
  platform indexing, and prioritized foreground release actions.
- The current [launcher source at that tag](https://github.com/tgeorgiadis/quiver-launcher/tree/425506283e453fcea2e1c8176d6aa965e4b16177)
  documents catalog review/subscription, manual entries, GitHub/GitLab release
  selection and updates, portable library data and backups, provider-backed mod
  workflows, and controller-oriented interaction tests. Source and test presence
  establish implemented intent, not successful operation on every package or
  device.
- The official [community catalog at
  `4d944bed`](https://github.com/tgeorgiadis/quiver-community-app-catalog/tree/4d944bed5181aee6f822d5cbdb2707cb37fc8728)
  contains 165 entries across Nintendo (82), PlayStation (47), Xbox (26), and
  Other Platforms (10), representing 162 distinct repository values. These
  counts describe that pinned catalog snapshot; they do not establish distinct
  original games, independent implementations, supported platforms, integrity,
  readiness, qualification, or gameplay parity.

The overlap is broader than release downloading: catalog discovery and
freshness, local-library continuity, version selection, mods, migration,
controller use, and platform availability all require explicit comparison.
Portcove's response remains outcome-owned rather than competitor-owned:
connected-folder discovery and selected setup stay in #244; ongoing intent and
automation in #965/#966; catalog delivery in #246; adoption in #249; managed
profiles and provider-backed mods in #250/#262; player-ready Playnite and Steam
integration in #910/#292; and reproducible comparative measurement in #255 and
its finite [engineering-protocol child #1042](https://github.com/boburning/portcove/issues/1042).

The comparison protocol must report distinct games and implementations, exact
OS/architecture/channel scope, task effort and waiting, preservation/recovery
outcomes, and end-to-end availability phases. Catalog entries, source tests, and
completed internal issues are evidence inputs, not proof that a new player can
get a game running or preserve progress more easily. Claims remain bounded to
the exact builds, tasks, environments, and evidence categories observed.
