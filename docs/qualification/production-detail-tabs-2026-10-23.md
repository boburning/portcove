# Production detail tabs capability and evidence checklist

Implementation owner: [#2454](https://github.com/boburning/portcove/issues/2454).
Pickup baseline: `474dd973`, containing planning baseline `6d614974`.
Catalog/tooling target reconciled at `64354072`; code reviewed at `91ff174e`.
The final PR records the final reviewed head, five exact-head hosted contexts,
target interaction check and guarded delivery result.

The inventory below was built from both production detail owners and their
imported workflow owners before redistribution. Verification means a production
home was reconciled by source review and the named browser contracts. It does
not mean a real installation, backup, native picker or executable was exercised.

## Capability reconciliation

| Existing production capability / owner                                           | Final home                      | Verified by                                                               |
| -------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| Full identity, variant, portrait cover, observed readiness and ownership fact    | Shared header                   | DetailPanel, detail-composition, launch-readiness                         |
| Direct managed Play, trial/setup launch and authoritative operation exclusion    | Header / Files                  | launch-readiness, library-composition, preparation-journey                |
| Game/BIOS file, folder and ZIP selection, selected overrides and source health   | Files                           | DetailPanel, launch-readiness, Preparation, interactive scenarios         |
| Source identity/evidence, profile checks and required host-tool links            | Files                           | DetailPanel and retained source controls; independent source review       |
| Browsing match, file filter, query and observation controls                      | Files disclosure                | DetailPanel and independent source review                                 |
| Reviewed installation plan, cancellation, picker and library-storage handoff     | Files                           | Preparation/interactive journeys and retained InstallAction owner         |
| Preparation review, exact plan identity, completion focus and leave/revisit      | Files                           | Preparation, preparation-journey, preparation-completion-focus            |
| External registration, relink, forgetting and shared-directory instructions      | Files                           | ExternalRuntime, DetailPanel, detail-composition                          |
| Catalog download, pending setup, recovery, attach, launch details and launch     | Files / header                  | CatalogDownload, ExternalRuntime, interactive scenarios                   |
| Managed/external paths and ownership, future output and supported relocation     | Files                           | DetailPanel, OutputLocation and independent source review                 |
| Both artwork slots, overrides, provenance, loading/cache and quiet fallback      | Files / overflow                | Artwork, detail-composition and interactive scenarios                     |
| Steam shortcut, CLI continuity and technical check identities                    | Files / overflow                | SteamEntry and independent source review; maintained native entry points  |
| Verification and reviewed uninstall                                              | Files / technical disclosure    | RemovalReview, retained maintenance owner and source review               |
| Description, platform, method, channel and catalog designation                   | Overview facts                  | DetailPanel, library-composition, detail-composition                      |
| Project status, compatibility qualifications and recorded checks                 | Named Overview disclosures      | DetailPanel and library-composition                                       |
| Retained installed saved-data contract, coverage unknowns and data folder        | Saved data                      | BackupHistory interactions and detail-composition                         |
| Backup loading/failure/retry, assessment, create/history/restore/delete/recovery | Saved data                      | BackupHistory interactions and retained review owners                     |
| External/self-service saved-data exclusions and upstream instructions            | Saved data                      | CatalogDownload, detail-composition and source review                     |
| Installed, checked, staged, previous version and channel facts                   | Versions                        | GameUpdates, DetailPanel, interactive scenarios                           |
| Check, explicit install/download-for-later, changed disposition and re-plan      | Versions                        | GameUpdates, including retained selection and exact reviewed apply target |
| Activation, rollback, supported reinstall and future channel/update preferences  | Versions                        | GameUpdates, ReleaseChannel owner and source review                       |
| Upstream-managed update limitations and upstream links                           | Versions                        | detail-composition and source review                                      |
| Exact Back origin, entry, search/filter/view/scroll and stale-close rejection    | Navigation owner                | detail-workspace-navigation and library-composition                       |
| Explicit destination, once-per-opening selection and mounted hidden/inert panels | Shared layout/navigation        | detail-sections and DetailLayout                                          |
| Retained drafts, hidden focus/controller exclusion and obsolete completions      | Shared layout + existing owners | DetailLayout, preparation-completion-focus, ExternalRuntime, GameUpdates  |
| Operation identity, cancellation settlement and leave/revisit                    | Existing operation owners       | Preparation, preparation-journey, interactive scenarios and GameUpdates   |

There is one stateful setup/update/external-runtime/review owner for each task.
Header setup controls reveal that owner; they do not create another plan or
consent path. Unsupported managed backup/update controls are absent from listing
routes, with their ownership limitations explained in the relevant panels.

## Behavioral and visual evidence

Focused runs retained under `E:/Codex-Evidence/production-detail-tabs-20261023`:

- `integration-second.log`: seven files, 105 cases passed.
- `integration-third.log`: 137 passed, two obsolete layout expectations failed;
  the failures and traces remain retained.
- `integration-fifth.log`: four corrected/extended files, 51 cases passed.
- `reconciled-static.log`: formatting, lint and types passed for all changed code.
- `reconciled-visual-and-tools.log`: six files, 79 cases passed after target merge.
- `final-owner-regression.log`: update and external-runtime owners, 81 cases passed.
- `native-harness-contract.log`: 13 serialized harness contract cases passed.
  These are harness tests, not native application observations.
- `final-visual-qualification.log`: 15 maintained production App visual cases,
  including both-theme staged/external/downloaded/backup-error/preparation states.
- `final-layout-and-owner.log`: three files, 97 cases passed, including duplicate
  refusal suppression, exact update application and retained external drafts.
- `final-static-second.log`: final changed-code formatting/lint/types passed.
- `static-layout-regressions-second.log`: 172 static detail/qualification cases
  passed. CI run `39998112787` retained 26 failures from old page-order and
  heading-markup expectations; the repair scopes those checks to their new tab
  homes without changing production code or qualification/eligibility assertions.
  `static-regression-check.log` passed formatting, lint and types for the repair.

The maintained `browser/detail-composition.browser.test.tsx` uses the actual App
and disposable interactive transport. It checks both themes at 1366×768,
1600×1000 and 960×640, 240×360 / 160×240 / 144×216 fixed artwork frames, portrait,
landscape, square, transparent and missing artwork, long/duplicate identities,
injected 200% root text, 320 CSS-pixel reflow and text-spacing overrides. It
checks page/workspace containment and tab contrast/ARIA rules in all four panels.
Keyboard activation and controller inventory are covered by DetailLayout tests.
This follows the [APG manual tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
and [WCAG reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

In the production development render, a future-install folder draft survived
Files → Versions → Files and resizing to 960×640. A downloaded setup's working
directory draft survived tab changes and resizing to 320 CSS pixels. The inactive
panel could not take focus. Overflow → Change artwork revealed the existing
two-slot disclosure. Forced-colors/reduced-motion browser emulation retained a
visible focused tab and a separately selected tab; arrows moved focus without
activation. No physical controller or native-host zoom observation is inferred.

## Matched captures

All three views use Harbor Adventure, Harbor desktop port, version 1.2 and the
same portrait PNG from the comparison fixture at 1366×768 in dark theme:

- [Production before](assets/production-detail-tabs-2026-10-23/before-dark-1366.png).
- [Production after](assets/production-detail-tabs-2026-10-23/after-dark-1366.png).
- [Matched prototype](assets/production-detail-tabs-2026-10-23/prototype-dark-1366.png).

The baseline render is `9362d58f`; its detail owners and comparison content/artwork
are identical to pickup baseline `474dd973`. The prototype's existing comparison
scene uses the same PNG. For the matched image only, its browser DOM prose and
fact values were replaced with the production fixture's exact description,
installation, platform, method, channel and catalog-designation values. Prototype
CSS/composition was unchanged. This adaptation is comparison evidence, not
production behavior. The original prototype files were not edited.

Additional inspected images and SHA-256 inventory are retained in the evidence
directory's `final-captures` and `capture-manifest.json`. Browser captures use
Chromium headless 156.0.8078.4 and the in-app Chromium browser. Every selected
final image was inspected. Earlier failed/padded captures remain separate.

## Native and delivery boundaries

`node scripts/desktop-verify.mts --plan` succeeded and reported missing native
WebDriver prerequisites. No native application, packaged/installed application,
OS text enlargement, physical controller, hardware or gameplay observation was
performed. Maintained native harnesses were updated to reveal their intended
tabs, and their source/type/serialized-contract validation remains distinct.
No real game-file, installation or saved-data mutation was used for presentation
acceptance. Native/hardware observations remain unavailable as allowed by the
owning request; browser fixtures do not establish them.

Independent non-writing review found no blocking defects at `91ff174e` against
`64354072`. It confirmed capability homes, workflow authority, focus/navigation,
native harness entry points and the catalog target interaction. Final review
and hosted/merge receipts belong to the integrated PR and owning issue.
