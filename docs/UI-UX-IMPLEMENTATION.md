# Portcove UI/UX implementation history

The owner’s 21 October integrated redesign supersedes the staged delivery and new-brand proposal below for the current candidate. [Integrated UI design](INTEGRATED-UI-DESIGN.md) is the current product contract; [#2362](https://github.com/boburning/portcove/issues/2362) owns its implementation. Deliver one integrated candidate and final integration PR, retaining the approved crab identity. The remaining text preserves dated context for the broader programme; it does not authorize an asset pack or intermediate product releases.

Live ownership and completion remain in [#2222](https://github.com/boburning/portcove/issues/2222) and its finite work packages. This document records the owner-approved target, not live status. Audit report SHA256: 8ba197e72918cfa3550fcdb94da1b136c3aed2af066eda90a700ed14a4c76b23.

## Historical October 19 plan

## 1. Outcome and fixed decisions

Implement the full target from the consolidated audit retained at E:/Portcove-UI-UX-Audit-20261019/UI_UX_AUDIT_AND_ROADMAP.md, preserving its 12 UX and 10 UI finding IDs.

The agreed experience is:

- Cover-first Library with optional compact rows, whole-image 2:3 artwork and separate game/port identity.
- Library / Find games / Activity / Settings navigation, with Updates inside Activity.
- Both themes, accessible state cues, context search and profile-persistent 100–400% whole-interface enlargement.
- Guided Add games, clear preparation/recovery consequences and one native approval for removing a saved game-file location.
- Guided use of existing recovery capabilities, without promising an automatic portable backup.
- A complete original 2D identity family, followed by owner production approval and coordinated integration.

Plan against current remote main, observed at `e648c6c8cfd384508492608746dcca0ef5fa4ea7`. The two commits after the audited revision do not close the presentation findings. Refresh this comparison at implementation pickup.

Delivery is incremental and Windows-first. Preserve experimental-platform compatibility; report their native qualification separately.

## 2. Shared implementation contracts

### Navigation and preferences

- Retain internal `catalog` and `updates` route IDs. Display **Find games** and **Activity**, preserving existing browsing preferences, focus origins and scroll positions.
- Activity opens to **Tasks & history** and provides a clearly labeled **Updates** section. Existing update links select that section directly; application-update preferences remain in Settings.
- Retain Ctrl/Command+1–4 navigation and Ctrl/Command+K. Remove unmodified slash.
- Ctrl/Command+F focuses search in the current searchable view. It does not redirect Settings or interfere with dialogs, composition or editable content. Palette commands explicitly offer Library and Find games searches.
- Add `CollectionLayout = "covers" | "rows"` as a profile-local preference scoped to the active library. Default to covers; do not migrate durable library data or discard existing browsing preferences.

### Enlargement and adaptive layout

- Add one Interface size controller with presets **100, 125, 150, 175, 200, 250, 300 and 400%**.
- Use Tauri’s existing WebView zoom API and narrowly add its required capability. Keep independent native zoom hotkeys disabled to prevent competing state.
- The controller owns the Appearance picker, Ctrl/Command+plus/minus and Ctrl/Command+0 reset. Serialize/coalesce updates, persist only successfully applied values and retain usable controls after failures.
- Store the preference per profile, independently of the active library. Missing or invalid values start at 100%; storage failure must not prevent session-only enlargement.
- Below 48rem effective width, use in-flow wrapping navigation and one vertical reading flow. Remove fixed side-pane requirements and sticky task footers in this layout.
- Preserve the native minimum window size. Test actual effective widths down to 320px, including the smaller viewport produced by 400% zoom at the minimum window.

### Action eligibility and task feedback

Extend the existing frontend `Perform` options with invocation context: action, target, originating library generation and exclusion scope. Keep this presentation state ephemeral.

- Replace name-only pending entries and the single foreground error with context-bound records.
- Use one action-presentation selector across cards, details, rows and Activity. Combine existing Core assessments with known local pending conflicts.
- Same-target operations and library/application-wide maintenance retain exclusion. Permit unrelated work only after focused overlap tests establish that it is safe.
- Core locks, freshness checks and execution-time refusal remain authoritative. An enabled control never proves that another process holds no lock.
- Preserve operation IDs, parent relationships, sequence handling and exact-ID retirement against durable Activity records.
- Attribute early failures using invocation context. Provide an exact Activity link only when its identity is actually known; otherwise provide a general Activity link.
- Ordinary managed installation forwards its owned event channel to the invocation; global events cannot assign that identity. Batch update checks remain indeterminate until Core returns the completed collection.
- Classify declined nullable removal, restore and backup-deletion consent before invocation settlement. Other null results keep their command-specific meaning. Declined shared-preferences install/update returns cancellation before authorization; committed outcomes and independent readback failures remain distinct.
- Never correlate requests and events by “latest,” timestamp or matching names. Add no scheduler, durable queue or parallel job database.

### Source removal and recovery authority

Keep the existing `previewSourceRemoval` and `removeSource` interfaces.

- Replace the renderer confirmation modal with an inline impact preview and **Remove saved location…** action.
- Obtain a fresh preview on explicit intent, exclude duplicate submissions and retain the native dialog as the sole final approval.
- Resolve names in the host. Show the exact location, affected-entry summary and preserved originals/installations/saves/backups. Keep the full human-readable affected set available inline.
- Preserve generation checks, preimage validation, dependent locks and one-use authorization. Cancellation is neutral; changed plans require renewed intent.
- Limit this restructuring to saved-location removal. Other destructive operations retain their existing consent contracts.

## 3. Work packages and dependency order

### P0 — Establish finite ownership and traceability · Small

- Create a finite implementation parent for this audit, with independently deliverable child work packages.
- Map every UX/UI ID to one canonical owner. Preserve report identity alongside IDs.
- Link overlap with #2177 without silently expanding its different October 18 audit or closing its unfinished acceptance.
- Reuse #227 for the 2D brand work. Do not reopen completed foundation issues.
- Capture this approved plan and its acceptance boundaries when implementation begins.

### P1 — Immediate corrections · Four independently deliverable slices

| Slice                                                | Findings           | Implementation and acceptance                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1A — Shortcuts, focus and truthful labels** · S/M | UX-001/003/012     | Replace slash; update palette/help/hints together. Give filter reset a stable focus destination and result announcement. Distinguish known failed checks from unavailable results and unchecked paths. Verify field, modal and IME noninterference.                                          |
| **P1B — Shared visual states and cascade** · S/M     | UI-001/002/006/009 | Repair actual hovered metadata contrast; add persistent non-color current/pressed cues; unify channel and update-notice mappings. Establish reproducible CSS layer order across normal, fixture and emitted/native entries. Preserve whole-image fitting and avoid global suppression rules. |
| **P1C — Enlargement and adaptive shell** · M/L       | UX-002, UI-003/004 | Implement the size controller and adaptive navigation/workspace/overlay rules. Preserve drafts, focus and browsing context. Complete native enlargement tasks and narrow-width checks; root-font simulation alone is insufficient.                                                           |
| **P1D — Preparation and recovery hierarchy** · S/M   | UX-004, UI-007     | Put enabled review/preparation actions before disabled placeholders. Prioritize valid specific recovery over generic retry. Name task identity and consequences. After success, focus Play when available or the next-step heading otherwise.                                                |

P1A/B can ship independently. P1C owns shared shell changes; coordinate overlapping writers. P1D uses existing feature and review contracts without waiting for the later Add games journey.

### P2 — Consistent operations and unified Activity · Medium

**Findings:** UX-008/011, UI-010.

- Implement the shared eligibility and invocation-context contracts above.
- Make Activity the primary composition of the existing updates/activity destination.
- Present task identity, target, phase, progress, outcome and valid recovery together.
- Keep foreground feedback near its origin, with consistent Activity access.
- Preserve committed-operation versus failed-refresh distinctions, unfinished children, uncertain outcomes and restart reconciliation.
- Announce starts, meaningful phase changes and terminal outcomes without announcing every progress tick.

Acceptance includes an unrelated permitted operation, same-target exclusion, cross-process refusal and two independently attributable outcomes. Navigation or a missing event must never imply completion.

### P3 — Library, details and compact rows · Medium

**Findings:** UX-005/007, UI-005/006/008.

Depends on P1 visual/access contracts and P2 action presentation.

- Translate the chosen reference into the existing component stack, retaining Geist and one semantic token authority.
- Use 15px-equivalent body text, 13px secondary text and approximately 28px page headings as initial production targets. Use 36px compact and 40px ordinary controls, allowing content-driven growth.
- Preserve 2:3 contained artwork and neutral padding. Bound covers at 220 CSS pixels normally and 160 pixels in short windows; derive columns from usable space. Text enlargement reflows identity around these bounds; native WebView zoom still enlarges the whole interface.
- Keep frame geometry independent of title/status length and align action baselines within rows.
- Use one details link for artwork/title, with Play and other controls outside it. Avoid nested interactive cards.
- Remove routine Stable repetition and maintenance facts from ordinary cards. Retain meaningful project, variant, readiness and exception information.
- Move Steam/bulk operations into explicit selection or integration contexts.
- Count library entries accurately. Separate ports for one game remain separate entries.
- In details, order identity/readiness/action before current update decisions, then advanced maintenance and future preferences.
- Implement rows using the same identity, status and action mappings—not a separate behavior model.

Acceptance uses duplicate game titles, long names, mixed artwork, missing art, updates while playable, errors, no-results and scrolling in both themes.

### P4 — Add games and saved-location interaction · Medium/Large

**Findings:** UX-004/006/009, UI-007/008.

- Provide a contextual Add games entry from Library and empty states.
- Offer game-file selection, folder scanning and catalog browsing; retain existing installation-copy/external routes where supported.
- Reuse existing recognition, saved-folder scanning, selection limits, route checks, planning and review APIs.
- Preserve the existing bounded multi-game review capability. Do not turn it into a durable queue.
- Use explicit stages: choose inputs → recognize/select port → check route → review consequences → prepare → completion/Play.
- Review the original source, managed/external destination, release/channel, requirements and saved-data knowledge. Unknown facts remain unknown.
- Keep drafts and return context while the workspace exists. Navigation does not automatically cancel Core work; library replacement invalidates outgoing UI continuations.
- “Cancel requested” remains pending until authoritative settlement. Offer resume only when Core provides a valid resumable plan.
- Implement the saved-location confirmation changes as a separable slice.

Acceptance includes valid, invalid, ambiguous and unsupported inputs; stale plans; cancellation; library switching; interrupted preparation; one native saved-location approval; and unchanged original bytes.

### P5 — Guided library recovery · Medium

**Finding:** UX-010.

- Add a coherent Library recovery entry in storage settings, separating recovery-copy preparation, restore and Move.
- Explain the actual metadata export, required content trees, owned-save backups and external-original exclusions.
- Guide users to resolve active work, create applicable save backups, export metadata and copy the required content under documented quiescent conditions.
- Make manual-copy status explicit. A checked box does not establish a verified backup.
- Reuse checked import into a new/empty destination, including existing plan binding, interruption, resume and retaining abort behavior.
- Keep Move separate because it switches library authority.
- Call an outcome verified only after the corresponding checks or restore observations succeed.

Acceptance requires a nonempty disposable recovery round trip, including saves, disconnected originals, missing content and interrupted import. Add no portable-bundle format or automatic copy API.

### P6 — Complete 2D identity family · Large; parallel workstream

**Finding:** UI-005; canonical owner #227.

Start studies alongside P1. Integrate after the family is approved and primary layouts stabilize.

- Create original editable vector work for the wordmark, horizontal lockup, full mascot and independently simplified compact crab.
- Follow the approved flat, outlined, mischievous character direction and established color ownership. Use **Portcove** lettering; do not trace V2 geometry or reuse unapproved studies as approved masters.
- Record AI-assisted authorship honestly. This explicitly departs from the preference for human-made finals; it does not authorize claims of human authorship.
- Compare two small family studies, conduct one fresh-context critique, recommend one and finish its complete production proofs.
- Deliver full-color and genuine single-ink variants, transparency, clear-space/minimum-size guidance and compact proofs at 16/24/32/48/64px.
- Add build-only `@resvg/resvg-js` pinned to stable `2.6.2` for natural-aspect SVG-to-PNG exports; disable system-font loading and use outlined lettering. Reuse the pinned Tauri CLI for platform icons. This adds no runtime renderer dependency. [Renderer documentation](https://github.com/thx/resvg-js/blob/v2.6.2/README.md).
- Extend the manifest/validator deliberately for vector masters and deterministic derivatives while retaining historical V2 integrity coverage.
- Complete provenance, permissions and visual review before the final owner production approval.
- Then migrate shared brand consumers, startup/About/empty states, browser/native/package icons and README together.

No animation, pose pack, custom UI-icon set, social publication or signing is included.

## 4. Verification and delivery

Each work package receives matching acceptance evidence and its applicable independent review.

- **Component/browser:** meaningful behavior tests for shortcuts, reset focus, state mappings, invocation attribution, stale generations, confirmation cancellation and preference restoration. Reuse maintained tests and scenarios.
- **Visual:** both themes; hover/focus/selected/pressed/disabled/pending/error combinations; long/localized content; missing/mixed artwork; spacing overrides; forced colors and reduced motion.
- **Resize:** actual 320px authored-content width; 960×640, 1280×800, 1366×768, 1600×1000 and 1920×1080; native zoom through 400%, including dialogs and recovery.
- **Native:** discoverable enlargement/reset, actual Windows contrast-theme behavior, setup/cancellation, one native saved-location confirmation, known conflict/refusal cases and nonempty recovery.
- **Assistive technology:** actual screen-reader navigation and announcements, not AX inspection alone. Retain the observed output and distinguish it from human-participant evidence.
- **Controller/platform:** preserve synthetic navigation coverage; obtain physical/controller and experimental-platform observations for their explicit acceptance claims. Keep unavailable qualification separate and unclaimed.
- **Brand:** inspect final files and actual app/package placements, transparency, small sizes, both themes and repeatable exports.

Keep tests proportional to the change. Preserve failures and repeat only invalidated work.

Deliver coherent PRs through the existing five exact-head contexts, guarded merge, remote readback and targeted Roadmap reconciliation. Packaging checks apply where host/resources/icons require them. No release, signing or publication is implied.

## 5. Documentation, assumptions and completion

During implementation:

- Extend [GLOSSARY.md](../GLOSSARY.md) with concise definitions for game, port, library entry, game-file location, saved folder, game saves and library folder. Keep implementation details out.
- Record two concise ADRs: ephemeral desktop orchestration over Core authority, and the original-vector/deterministic-export brand transition.
- Update design-system, theme, localization, architecture and brand contracts with each implemented slice. Retain dated audit evidence; remove superseded conventions only when their replacement ships.
- Preserve one canonical owner for each audit finding. Resolve it only against verified acceptance—not because its screen was restyled.

Defaults are fixed: existing framework, English support with localization readiness, existing game artwork, profile-local presentation preferences, and no new paid service.

Intentional exclusions remain: universal saved-uninstalled membership, grouped-game identity migration, durable installation queues, automated portable backups, permanent inspector/fullscreen modes, speculative virtualization and advanced animation.

Quick corrections do not wait for these larger capabilities or participant recruitment. Research uses the audit’s neutral tasks and measured outcomes; no fabricated baseline or participant result is permitted. Missing acceptance evidence remains a precise open qualification item rather than a claimed pass.
