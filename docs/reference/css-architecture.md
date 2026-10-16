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

## Validation and recovery

Oxfmt, Stylelint, the existing Oxlint plugin, token invariants, actual Browser
Mode controls and the current-build output guard retain distinct jobs. The
cutover reuses #2005's owners rather than resurrecting the removed scanner.
Native execution, browser observations, restored builds and screenshots are
reported separately on #2009. #993 retains minimum/platform qualification.

Rollback is a normal reviewed Git revert of the delivered CSS cutover commits
(or its squash merge), followed by the pinned frozen dependency install and
fresh frontend build. Do not reset another checkout, clear caches, remove
libraries/preferences, alter credentials or revert #2005's unrelated tooling.
