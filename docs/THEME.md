# Portcove theme and CSS ownership

The inline saved-location impact uses the ordinary text, border and destructive
button roles. It introduces no overlay, palette or fixed footer. Long locations
and affected-entry names wrap in document flow, including enlargement.

`collection.css` owns Library geometry in the components layer after adaptive
shell rules. It consumes shared tokens and adds no palette. Fixed 2:3 contained
artwork frames remain independent of identity/status height. Covers and compact
rows share status, focus, selection and action variants. The 36/40px controls
are content-driven minima; 15px body, 13px secondary and 28px heading roles all
enlarge through the native controller.

Activity sections reuse shared button variants and their persistent pressed cue. Contextual task records reuse existing info, neutral, warning and failure roles; temporary exclusion does not recolor or reinterpret Core readiness. Foreground progress and exact-ID Activity progress share one component and bounded numeric presentation. No separate Activity palette or progress implementation is introduced.

Portcove keeps its graphite dark and warm controller-gray light identity, with
red, blue, green and yellow families carrying explicit meaning. Illustration
remains owned by [BRAND-ASSETS](BRAND-ASSETS.md); this CSS cutover does not change
the mascot or product navigation. [#2009](https://github.com/boburning/portcove/issues/2009)
is the finite architecture delivery under the continuing #917 design-system owner.

## One authority and cascade

`apps/desktop/src/styles/index.css` assembles Tailwind Preflight, offline Geist,
tokens, document defaults and shared motion. The standard order is `theme, base,
components, utilities`. Runtime variables live in the theme layer on `:root` and
`:root[data-theme="light"]`. Document defaults and the minimal focus fallback
belong to base. Specialized CSS belongs to components; utilities can deliberately
adjust a component. Normal unlayered product CSS and a permanent legacy layer are
not part of this architecture.

`styles/tokens.css` is the single runtime token authority:

1. Palette primitives describe the graphite/warm-neutral and color families.
2. Semantic roles describe surfaces, content, interaction, signature actions,
   selection, focus, destructive intent, statuses and artwork.
3. `@theme inline` exposes these roles to Tailwind without independently valued
   theme aliases resolving on the wrong ancestor.

The `pc-` utility namespace identifies Portcove semantics. Primary consistently
means signature red; interactive and selection are blue. Shared action foreground
is intentionally usable by filled primary and destructive treatments. Components
consume semantic roles, never palette primitives. Keep shared type, control,
radius, elevation and motion decisions in CSS. One-off artwork/layout geometry
may be local; it does not automatically earn another public token.

Palette values, reset choices, exact class strings and historical token names
are editable design decisions. Preserve identity, accessible contrast and domain
meaning while changing them. No separately maintained JSON/TypeScript token
registry or immutable numeric palette test is required.

## Semantic roles and interaction

| Role                        | Treatment and meaning                                                          |
| --------------------------- | ------------------------------------------------------------------------------ |
| Background/surfaces/content | Graphite or warm light neutrals; readable primary, secondary and muted content |
| Ordinary action             | Neutral default Button                                                         |
| Primary action              | Explicit signature-red Play, Install or Apply                                  |
| Selection                   | Blue state, distinct from hover/highlight and focus                            |
| Keyboard/controller focus   | One gold outline; forced colors retain system-visible geometry                 |
| Destructive/failure         | Red semantics with clear wording and confirmation where required               |
| Success                     | Green healthy/completed/connected facts                                        |
| Warning                     | Gold attention, setup or available-update facts                                |
| Information                 | Blue informational/staged/running facts                                        |
| Unknown/disabled            | Neutral; never inferred success                                                |
| Artwork                     | Separate surfaces suitable for letterboxing and fallback lettering             |

Stable game-port channels are green, Preview (`beta`) blue and Rolling attention
gold. A channel does not establish support, readiness, qualification or upstream
health. Current/completed application updates are green, availability gold,
verified/staged blue, and failure/recovery red. Source support, informational,
unreviewed and incompatible facts remain separate labeled states. Core owns
those facts; controls do not invent eligibility or storage thresholds.

Shared Button, Input, Dialog and Select own ordinary colors, borders, typography,
minimum dimensions, focus, disabled/invalid states and motion. Button text can
wrap above the 30/36/42 px minimum scale. Pending actions remain inert. Features
choose an intent and arrange the control; repeated ordinary restyling belongs at
the shared owner. `controlClassName` preserves Base UI's state-dependent callbacks
alongside ordinary class composition, refs, event handlers and render props.

Selected Select items retain an indicator and semantic selection treatment;
highlighting uses its own state treatment. Focus uses an outline independently of
selection or invalid/destructive borders. The base focus fallback handles other
focusable elements without adding a second ring to shared controls.

## Theme, direction, first paint and motion

The one runtime marker is `html[data-theme]`; Tailwind dark variants and portals
use it. A small self-hosted blocking bootstrap chooses the saved/system marker
before rendering, including blocked-storage fallback. Theme-color metadata reads
the resolved CSS background rather than another TypeScript color table. Offline
Geist and script-aware system fallbacks remain bundled. The existing WebKit
repaint invalidation and native theme synchronization remain in place; CSS
compiler targets do not certify native first paint or window chrome.

Document `dir` and Base UI DirectionProvider stay coordinated through the
localization owner. Use logical spacing/alignment; paths and other technical
values retain their own bidi isolation rather than indiscriminate mirroring.
The isolated application root sits below a small shared floating level. Base UI
owns focus containment, dismissal and mount/unmount; nested portals use their DOM
order without treating descendant counts as modal depth.

Floating controls use Base UI `data-starting-style`/`data-ending-style`
transitions. Reduced motion removes the effective transition; a nonzero computed
duration with `transition-property:none` does not animate. Progress retains its
status text without decorative movement. Business logic never waits on a
stylesheet animation. `tw-animate-css` and cross-framework state aliases are
retired.

## Whole-interface enlargement and reflow

Appearance offers 100, 125, 150, 175, 200, 250, 300 and 400 percent interface sizes.
`InterfaceSizeProvider` owns the picker, Ctrl/Command plus/minus and zero reset,
including while a dialog is open. It changes the whole WebView through Tauri's
existing zoom API, rather than changing root font size or maintaining a second
CSS scale. Independent native zoom hotkeys stay disabled. OS display scaling is
a separate input and is not inferred from this preference.

`InterfaceSizeController` serializes calls and coalesces waiting intent. The
profile-local `portcove.appearance.interface-size` preference is independent of
the active library; only acknowledged native applications are saved. Missing,
invalid or unreadable preferences start at 100 percent. A write failure keeps
the applied size for the session. A native failure retains the last confirmed
preference and exposes retry/reset without asserting an unobserved actual size.

`styles/adaptive.css`, assembled by the existing stylesheet entry, owns the
shared below-48rem reading flow. Navigation wraps in the document, the workspace
does not require a side pane, Settings navigation stops sticking, and shared
dialog footers remain in their scrolling flow. The native 960 by 640 minimum
stays intact. Actual 320 CSS-pixel and 240 by 160 authored-content checks are
distinct from observing native 400-percent zoom and other platforms. These
layouts do not announce phone-platform support.

## Composition and validation

Settings rows and notices are real reusable patterns. Grid/flex and size container
queries respond to available component space; viewport queries own shell changes.
Artwork fitting/lettering has a local layered CSS Module beside Artwork.tsx.
Do not recreate a global feature stylesheet through imported fragments.

Vite+ 1.2.0 owns the toolchain. Tailwind 4.3.3 generates utilities with optimization
disabled; Vite performs full Lightning CSS transformation and minification.
Processing CSS, minifier CSS and JavaScript targets explicitly match Chrome 111
and Safari 16.4. Production scan exclusions are independent of module tree shaking.
[The decision record](reference/css-architecture.md) explains the upstream basis,
measurements, evidence boundaries and rollback.

Oxfmt owns formatting and supported class sorting against the actual stylesheet.
Stylelint owns CSS correctness, semantic-color policy and ordinary important
prohibition. The existing Oxlint plugin owns its focused source rules. Deterministic
tests check references/theme completeness/contrast, Browser Mode checks actual
controls, and the build guard inspects CSS from that build. Native Windows/Linux
observations and #993's minimum/platform qualification remain separate. No source
check opportunistically treats stale dist output as a current build.

Use the canonical root `pnpm check`, `pnpm test`, `pnpm test:browser` and `pnpm build`
routes; focused tests use the existing exact-file runner. Never regenerate copied
controls over these theme, state, accessibility and composition decisions without
review. [DESIGN-SYSTEM](DESIGN-SYSTEM.md) retains the wider product acceptance.

Add games uses shared semantic action, selected, focus, status and error roles in
both themes. In-flow stages and wrapping controls remain readable at effective
240px widths. Native HTML port selection retains OS/forced-color behavior; it
adds no independent palette, panel surface or durable selection authority.
