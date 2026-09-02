# GUI competitive review

This review captures the 2026-09-01 product baseline for Portcove's desktop experience. It uses the direct upstreams at the following inspected commits rather than screenshots or claims copied through a third-party catalog:

- [GithubLauncher](https://github.com/SirDiabo/GithubLauncher) at `6e62a967cb37a2106b0420dc47375ee83cac41d3`
- [Quiver Launcher](https://github.com/tgeorgiadis/quiver-launcher) at `ff1c4efd72c15c9de39007acc8169fbdec5dbc43`
- [RetComM Launcher](https://github.com/TechnicallyComputers/RetComM-Launcher) at `4a30d0615ddbf71c9c62c3bce1e3b6163e42a1bd`

The goal is not visual imitation. Each competitor solves a different part of the launcher problem well; Portcove should combine the best interaction lessons with its stricter release, source, rollback, and automation contracts.

## What the competitors establish

| Product | Strongest interaction ideas | Product pressure on Portcove |
|---|---|---|
| GithubLauncher | Immediate cover-led library, a prominent Continue action, direct download/play affordances, installed filtering, multiple layout presets, and a deliberately short first-run path. | A launcher must answer “what can I play?” before explaining how it manages releases. |
| Quiver Launcher | Search and tag filtering, a community catalog review flow, manual app adoption, visible update badges, mods, top-bar utilities, and explicit keyboard/controller hints. | A larger catalog needs fast retrieval and power features that do not bury the basic play loop. |
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

## Follow-on slices

These are intentionally separate from this pass because they require new product data or backend contracts:

- A provenance-recorded artwork model with deterministic local fallback art. Do not scrape or redistribute box art without a reviewed license/source field.
- Resumable background jobs, pause/cancel semantics, and crash recovery if a later workflow needs work that must survive process exit; the current durable ledger records truthfully completed, failed, and still-running operations without pretending they are resumable.
- Optional install-root selection after multi-root placement and free-space policy are defined in the core.
- Mod discovery only after package integrity, ownership, conflict, and update semantics are modeled; it is not a decorative GUI feature.
