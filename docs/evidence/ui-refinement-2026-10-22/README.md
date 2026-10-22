# Library, detail and demo refinement — 22 October 2026

Owns evidence for #2395. Production baseline: `43980db13626379bb070eca895e778690ee66fd3` (fresh origin/main at pickup). Changes retain Core/Tauri authority and the existing production workflows. The source file hashes in `capture-source.json` identify the presentation used for the revised captures; this is browser renderer evidence, not native qualification.

## Matched comparisons

Both conditions use the actual production App, the same maintained interactive fixtures, 12 entries in identical order, diagnostic artwork, dark theme, 1366×768 CSS viewport and 100% text (16px root). The baseline presentation was read from that exact Git revision into the disposable candidate checkout, captured, then the candidate files were restored. The corrected demo wrapper is shared by both conditions; the baseline is therefore a production-presentation comparison in a corrected harness, not a reproduction of the old broken demo wrapper. No production source or user files were used as demo data.

| Surface     | Before                                     | After                                    | Observed difference                                                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library     | [Before](before-library-dark-1366.png)     | [After](after-library-dark-1366.png)     | One Readiness picker, independent quiet Favorites, grouped collection commands/view. Checked Ready is green. 220×330 artwork becomes 180×270 in this short window. Four complete entries with actions fit, versus zero fully complete entries in the baseline (the action row was partly cut off). |
| Detail      | [Before](before-detail-dark-1366.png)      | [After](after-detail-dark-1366.png)      | Compact header retained; matching channels share one fact, update checking is secondary. Future-folder editing and large artwork are disclosed. Default fixture scroll extent reduced from 3513 to 2402px; all maintenance families remain available.                                              |
| Preparation | [Before](before-preparation-dark-1366.png) | [After](after-preparation-dark-1366.png) | Full paths, space uncertainty, activation/rollback and retained-work consequences remain before confirmation. Short lists bring both actions into the initial desktop review.                                                                                                                      |

The two Super Mario 64 ports and the long Harbor title are deliberately retained. Different port IDs, launch targets, readiness and artwork precedence are unchanged. Counts describe entries. Geometry is composition evidence, not proof of faster task performance.

## Individually inspected revised renders

- [Warm-light Library, 1366×768](after-library-light-1366.png); [compact 960×640](after-library-light-960.png): three complete ordinary entries including actions. The normal-ready slot no longer reserves an unnecessary three lines of empty space; exceptions can grow.
- [Dark Library, 1600×1000](after-library-dark-1600.png): five complete first-row entries; portrait, landscape, square and missing artwork retain their existing whole-image treatment.
- [Compact rows, 1366×768](after-rows-dark-1366.png): seven complete entries. Representative ordinary rows are 69px; long identity and a downloaded update grow to about 91px and 83px. The list cap keeps actions associated with identity.
- [60-entry rows, 1920×1080](after-large-rows-dark-1920.png): the list stays bounded while the real workspace and scrollbar expand to the window.
- [Narrow Library](after-library-light-320.png) and [narrow preparation](after-preparation-narrow-320.png): 320px viewport, full controls and readable paths, vertical scrolling. Native production layout uses document scrolling here, versus workspace scrolling at desktop widths. Cancellation was exercised after scrolling the review footer into view.
- [Normal demo desk](after-demo-desk-light-1366.png): collapsed 41px review desk, correct simulation language; actual App receives the remaining 727px. `embed=1` removes reviewer chrome in a separately labeled comparison.

Fonts and local images settled before Library captures. Changed green text pairs were read from the browser: dark `rgb(115,189,145)` on `rgb(25,26,29)` = 7.80:1; light `rgb(29,112,68)` on `rgb(245,243,238)` = 5.48:1. Selection, primary action and focus retain separate semantic roles.

`resize-session.json` records one browser session: filtered 60-entry rows → last matching entry → detail/back → focused Play → 1920×1080 → 960×640 → 1366×768. Query, the exact port and 14 matching rows remained; workspace widths changed and focused actions stayed in view. The browser scroll offset adapted to keep the action reachable. `after-library-geometry.json` retains representative final geometry.

## Scope of verification

Visual judgment and browser interaction establish the observations above. Focused maintained tests cover filter intersections/counts/reset, inline picker keyboard behavior, view/return context, operation targets, disclosed drafts/channel differences, preparation consequences, static/demo isolation, layout resizing, forced colors and reduced motion. Test-produced enlarged-text captures use injected 200% browser text, explicitly separate from native whole-interface zoom. Results are recorded with the final delivery evidence after execution.

The ordinary browser demo correctly refuses native WebView zoom; it retains 100% and exposes a reset/dismiss path. No native, packaged, actual screen-reader, physical-controller or real-game/file acceptance is claimed for this refinement. Existing native harness entry points were reconciled to the new picker, combined channel fact and disclosed folder editor; they were not run against the owner's real library.

During editing, the first local typecheck and browser-bootstrap requests were refused by source-bound admission because files changed while queued. Neither ran or passed. Their terminal evidence remains in the task transcript. Subsequent frozen-source runs are reported separately.

The live app/prototype comparison intentionally has different entries/artwork. It is an interaction/reference comparison with full-size links and simulation labels, not the matched production A/B above. No artwork remapping, automatic cropping, new operation authority or production fixture import was introduced.

## Final focused results

All 17 requested files exist and have passing results across scoped runs (308 unique tests). This is combined coverage, not a claim that the earlier full runs passed. The first run failed 19 tests; the next failed nine. Repairs retained target, action-ordering, draft, filter/count and focus assertions while updating the changed labels/disclosures and making the artwork mock retain each slot's committed selection. A diagnostic capture assertion also incorrectly assumed pure white instead of the actual warm-white token; it was removed.

- 13 unchanged suites passed in the 17-file repair run, including preparation/operation journeys, selection, detail/back, forced colors, layout, transport isolation and static scenario guards.
- The four remaining suites then passed: **4 requested / 4 discovered / 4 executed, 190 tests**, no skips.
- The final capture/focus refinement passed: **1 requested / 1 discovered / 1 executed, 8 tests**, no skips. Both enlarged themes use the actual appearance preference owner; fonts, images, deferred layout/theme paint and finite transitions settle before capture. Tagged axe checks returned no violations in these tested Library states.
- Typecheck passed on `ca17090` (1,106 files). Production presentation/demo source hashes remain unchanged from that reviewed revision; later changes are tests and this evidence. Final exact-head hosted results are recorded on PR #2399.

[Enlarged dark rows](rows-text-200-dark.png) and [light rows](rows-text-200-light.png) use 200% injected browser text at 1366×768. Vertical scrolling is deliberate; the small thumbnail does not grow with the heading. At [1920×1080 dark](rows-text-200-wide-dark.png) and [light](rows-text-200-wide-light.png), readiness occupies its own column without an extra inset or unnecessary wrapping. Long game/port identity and downloaded-update actions remain readable. [Enlarged preparation](preparation-text-200.png) retains full paths and scrollable consequences; its test resizes the open review to 320px, cancels, and checks focus returns to preparation.

Each of these final images was inspected individually at original resolution. [Live comparison](after-live-comparison.png) shows the corrected, labeled side-by-side viewer; its 635×545 panes intentionally exercise compact layouts. Full-size links avoid mistaking a small embedded pane for an ordinary desktop viewport.

Independent Standards and Spec reviews cleared the presentation and test repairs. Target interaction was inspected against subsequent main changes: retained-build authority/contracts and hosted-continuity qualification do not overlap these UI owners or change their consumed status/preparation contracts. Execution on later main remains the responsibility of the final hosted qualification and guarded merge, not an inference from these browser captures.

The broader hosted run on `88c0124` passed 821 unit tests (one intentional skip) and 1,357 browser tests, but failed two browser checks: an old Library-button selector in the Catalog-to-Library journey, and an optional detail-image assertion made before its lazy preview entered view. The repaired checks use the named Readiness picker and scroll the independent detail preview into view before awaiting its image. Their focused rerun passed **2 requested / 2 discovered / 2 executed files, 40 tests**. This adds the 15-test Catalog channel suite to local coverage (18 distinct files, 323 unique tests). Production source and final captures are unchanged; the failed hosted run remains failed, with its superseded unfinished Windows producer recorded separately.
