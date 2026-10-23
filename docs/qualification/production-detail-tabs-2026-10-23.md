# Production detail tabs capability and evidence checklist

Implementation owner: [#2454](https://github.com/boburning/portcove/issues/2454).
Baseline: `474dd973`, containing approved planning baseline `6d614974`.
Source inventory: `DetailPanel.tsx`, `ListingDetailPanel.tsx`, `SelfServiceSetup.tsx`
and their imported production workflow owners. This inventory was captured during
the first redistribution pass; validation below remains pending until recorded.

| Production capability / owner                                                          | New home                          | Verification |
| -------------------------------------------------------------------------------------- | --------------------------------- | ------------ |
| Identity, portrait cover, full project/variant, observed readiness                     | Shared header                     | Pending      |
| Managed Play, trial launch, setup launch, authoritative operation exclusion            | Header / Files setup              | Pending      |
| Source/BIOS file, folder and ZIP pickers, selected overrides, source health            | Files                             | Pending      |
| SourceIdentity evidence, profile checks, host-tool links                               | Files                             | Pending      |
| Browsing match / file filter / observation / query controls                            | Files disclosure                  | Pending      |
| Reviewed InstallAction plan, cancellation, native pickers and library storage handoff  | Files                             | Pending      |
| PreparationControl review, completion focus, retained operation identity               | Files                             | Pending      |
| ExternalRuntimeControl registration, relink, forgetting, shared-directory instructions | Files                             | Pending      |
| SelfServiceSetup download, pending setup, recovery, attach, launch details, launch     | Files / header                    | Pending      |
| Managed/external path and ownership, future output / supported relocation control      | Files                             | Pending      |
| ArtworkControls both slots, override/provenance/cache/fallback, DetailArtwork          | Files / overflow shortcut         | Pending      |
| SteamEntryControl, CliContinuity, technical check identities                           | Files / overflow shortcut         | Pending      |
| Verify, RemovalControl reviewed uninstall                                              | Files                             | Pending      |
| Description, platform, method, channel, catalog designation, project status            | Overview                          | Pending      |
| Compatibility qualifications, recorded checks                                          | Overview disclosures              | Pending      |
| Retained saved-data contract, unknowns, user-data folder                               | Saved data                        | Pending      |
| Backup assessment, loading/failure/retry, create/history/restore/delete/recovery       | Saved data                        | Pending      |
| External/self-service saved-data exclusions and upstream instructions                  | Saved data                        | Pending      |
| Installed/checked/staged/previous versions and channels                                | Versions                          | Pending      |
| Update check, GameUpdateControl review/replan/install/download-for-later               | Versions                          | Pending      |
| Staged activation, rollback, future channel/policy preferences                         | Versions                          | Pending      |
| Upstream-managed update limitations and existing upstream links                        | Versions                          | Pending      |
| Exact Back context/origin/scroll, stale close rejection                                | Navigation owner                  | Pending      |
| Explicit destination, once-per-opening selection, mounted inactive/inert panels        | Shared layout/navigation          | Pending      |
| Leave/revisit, operation cancellation/settlement, obsolete completion suppression      | Existing operation owner + layout | Pending      |

## Required observations

Pending: behavioral suites, independent review, exact-head hosted checks,
both-theme 1366x768 / 1600x1000 / 960x640, injected 200% text, 320 CSS-pixel
reflow, active form resize, varied artwork and long/duplicate identities,
setup/external/staged/backup-error states, keyboard/controller/focus,
forced colors, reduced motion, text spacing, changed contrast pairs.

Matched production before/after and prototype comparison must use identical
content/artwork. Every selected final image must be inspected. Browser fixtures,
injected enlargement and native-host observations are separate evidence scopes.
No real game-file mutation is needed for presentation acceptance. Native-host
acceptance is not established by browser renders or fixture tasks.
