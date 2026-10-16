# CSS architecture cutover

Owner: [#2009](https://github.com/boburning/portcove/issues/2009), a finite child
of [#917](https://github.com/boburning/portcove/issues/917). The baseline is the
delivered Vite+ consolidation `d74bae3fa6e3ad1058702fc0779689acf5f4505d`.
This record explains implementation decisions; the issues retain completion status.

## Foundation and ownership

`styles/index.css` assembles the standard `theme, base, components, utilities`
layers. Tailwind Preflight owns the reset. `base.css` deliberately defines document
typography, technical content, lists/tables, background and fallback focus.
Ordinary controls and feature compositions use utilities; utility adjustments
therefore participate in the intended cascade. There is no legacy override sheet.

`tokens.css` is the runtime authority: palette → semantic roles → `@theme inline`
utility exposure. Primary consistently means signature red, interactive/selection
means blue, focus means gold, and destructive/status roles remain explicit.
The `pc-` utility namespace identifies Portcove roles. It is an exposure of CSS
variables, not another token database. Root `data-theme` and document direction
also cover portals. The existing WebKit repaint invalidation remains intact.

Shared controls preserve Base UI behavior and its state-dependent className API.
They own ordinary appearance, dimensions, invalid/disabled states and focus.
Button labels wrap above a minimum height. Dialog/Select transitions use Base
UI's starting/ending attributes and reduced motion; no animation package or
decorative completion timer owns popup lifetime. One floating stacking level
uses portal DOM order, above the isolated application root.

Settings rows and notices are demonstrated shared patterns. Feature layout uses
grid/flex and available-space queries; shell changes remain viewport decisions.
Artwork fitting and fallback lettering use a local CSS Module because those
geometry rules belong to the artwork renderer. Local CSS remains layered.

## Compiler decision

Pinned inputs are Vite+ 1.2.0 (Vite 8.3.4), Tailwind/Vite plugin 4.3.3 and Base UI
1.9.0. Tailwind generates utilities with `optimize:false`; Vite's full
`css.transformer: "lightningcss"` processes CSS and Lightning CSS minifies it.
Processing targets and `build.cssTarget` both specify Chrome 111/Safari 16.4;
JavaScript retains those targets. Development CSS maps are enabled independently
of production source maps. Production discovery explicitly excludes test/browser/
scenario sources; JavaScript tree shaking is not the CSS exclusion mechanism.

This division follows the installed [Tailwind plugin implementation](https://github.com/tailwindlabs/tailwindcss/blob/v4.3.3/packages/@tailwindcss-vite/src/index.ts),
[Vite Lightning CSS integration](https://vite.dev/guide/features.html#lightning-css),
[CSS targets](https://vite.dev/config/build-options#build-csstarget),
[theme references](https://tailwindcss.com/docs/theme#referencing-other-variables),
[Preflight](https://tailwindcss.com/docs/preflight), and
[Base UI transitions](https://base-ui.com/react/handbook/animation).
Compiler targets do not polyfill every runtime feature or qualify a WebView.
Size container queries fit this floor; newer style queries are not used.

The explicit compatibility build has its own utility source entry. It references
the shared tokens/variants without inheriting the production source exclusions,
and emits its utilities in the same `utilities` layer. Ordinary production still
excludes that fixture. The development toolbar has a small layered native-control
recipe because it is a DOM-built harness outside the React application.

## Observed size and feedback

October 15/16, 2026, Windows x64, pinned frozen dependencies. The baseline is
`d74bae3`; the candidate includes the subsequently delivered Tauri updates from
`4f7ea46`. Sizes below are bytes from the actual output; gzip uses the same Node
default for both retained baseline and candidate assets.

| Output                 | Baseline raw / gzip | Candidate raw / gzip |
| ---------------------- | ------------------: | -------------------: |
| CSS                    |     88,201 / 16,996 |      72,161 / 14,372 |
| JavaScript             | 1,000,724 / 298,051 |  1,037,753 / 304,330 |
| Five local WOFF2 fonts |          76,420 raw |           76,420 raw |

Moving recipes into component utilities reduces emitted CSS and increases source
strings in JavaScript. This is a custody/maintenance choice, not an overall
bundle-size improvement claim. The font bytes remain identical.

The baseline's first uncached build in the new checkout took 3.65 seconds wall
(Vite 1.26 seconds). A later candidate fresh build took 1.49 seconds wall (Vite
0.97 seconds), with warm OS/dependency caches. Cache histories and host load differ,
so this is not a controlled speedup claim. Candidate cached replay took 0.34
seconds; changing a real CSS input forced execution, restoring it reproduced the
original bundle hash, and a subsequent restored build replayed. These runs removed
global `vp` from PATH and used the declared local CLI.

A bounded development probe observed a CSS update in about 30 milliseconds,
an embedded development source map, a source-named HTTP 500 for malformed CSS,
and the restored computed color after a corrected-source request and fresh
navigation. Failed probe attempts remain retained; no automatic error-recovery
latency guarantee follows. The build integration separately covers imports,
nesting, emitted local assets/fonts, source-map output and malformed-input refusal.

## Validation and recovery

Oxfmt, Stylelint, the existing Oxlint plugin, token invariants, actual Browser
Mode controls and the current-build output guard retain distinct jobs. The
cutover reuses #2005's owners rather than resurrecting the removed scanner.
Native execution, browser observations, restored builds and screenshots are
reported separately on #2009. #993 retains minimum/platform qualification.

Necessary exceptions are finite: document defaults remain in `base`; artwork
geometry stays in its local component-layer module; generated Tailwind property
registrations are compiler output; explicit development/compatibility fixtures
remain excluded from ordinary shipping. Inert static previews still use the
documented nonportaled path and do not establish popup interaction evidence.

Rollback is a normal reviewed Git revert of the delivered CSS cutover commits
(or its squash merge), followed by the pinned frozen dependency install and
fresh frontend build. Do not reset another checkout, clear caches, remove
libraries/preferences, alter credentials or revert #2005's unrelated tooling.
