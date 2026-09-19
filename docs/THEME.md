# N64-inspired theme system

Portcove's default theme borrows its structure from Nintendo 64-era industrial hardware and its punctuation from late-1990s Nintendo color. It is not a replica console UI: charcoal plastic, graphite panels, controller gray, and warm white carry the interface, while softened red, blue, green, and yellow communicate specific roles.

## Token layers

`apps/desktop/src/styles.css` has four token layers:

1. `--n64-*-50` through `--n64-*-950` are palette primitives. The provided 100, 300, 500, and 700 stops remain fixed. Components must not reference these primitives.
2. `--color-*` aliases describe interface intent. Components consume these aliases exclusively, so a theme decision changes in one place instead of becoming a component exception.
3. Typography, spacing, radius, motion, shadow, control, icon, and layout tokens define reusable product foundations.
4. Component selectors consume semantic and foundation tokens. A component-only token is appropriate only when a reusable component has a stable need that no semantic alias expresses.

Dark is the default hardware-like graphite theme. Light uses warm controller-plastic gray and off-white surfaces with graphite text; it is a first-class semantic remap, not an inverted afterthought. System preference follows `prefers-color-scheme`, while explicit Dark and Light choices persist locally.

The automated theme contract fails if a component introduces a raw hex/RGB/HSL color, references an N64 primitive directly, adds a gradient, removes a required semantic alias, changes a fixed primitive, or drops a reviewed foreground/background pair below its WCAG threshold.

Run it directly with:

```powershell
corepack pnpm --dir apps/desktop test:theme
```

It also runs as part of the desktop test suite.

## Approved styling architecture

[#917](https://github.com/boburning/portcove/issues/917) owns the finite Public
beta migration from the current global stylesheet and bespoke controls to
official checked-in shadcn/ui controls using Base UI, Tailwind, semantic CSS
variables, and a custom Portcove theme. The implementation explicitly selects
Base UI and the compact Nova style instead of relying on CLI defaults, retains
React/Vite/Tauri and Lucide, and records the actual aliases, paths, versions, and
configuration when the foundation lands. The current stylesheet remains shipped
behavior until that migration is reviewed; this contract does not claim Tailwind
or shadcn is already installed.

Semantic colors, dark/light mappings, typography foundations, spacing, radii,
controls, icons, focus, resets, shared motion, and cross-component layout have
one authority. Tailwind utilities and approved component variants are the normal
feature-facing styling mechanism. Limited custom CSS remains valid for specialized
layout, artwork, interaction, and native boundaries where it materially improves
clarity. Do not translate official components into CSS Modules, keep competing
global/module/utility versions of the same rule, or add Sass, CSS-in-JS, another
framework, or a custom component registry.

The current `check-theme.mjs` reads `styles.css`. The migration must extend or
replace that gate so applicable Tailwind CSS, checked-in control source, and JSX
utility usage retain raw-color, primitive-token, dark/light, focus-versus-selection,
declared-token, contrast, reduced-motion, and production-variant protection.
Third-party directives and variables receive narrow documented handling, not a
blanket exemption. Advisory checks for unused tokens, duplicated ownership, or
arbitrary geometry must allow justified exceptions rather than turning taste into
a brittle parser.

## Semantic hierarchy

| Role        | Color family                                    | Uses                                                                          |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Neutral     | charcoal, graphite, controller gray, warm white | app background, panels, typography, borders, disabled states                  |
| Interactive | cobalt blue                                     | navigation selection, filters, links, staged/running state, controls, loading |
| Signature   | Nintendo-like red                               | Portcove mark, page punctuation, primary play/install/apply actions           |
| Highlight   | golden yellow                                   | focus rings, update badges, counters, setup/warning state                     |
| Success     | emerald green                                   | connected, verified, installed/current, completed, healthy state              |

Release channels and other product states use these same semantic families
without collapsing distinct facts:

| Fact or state                                                             | Semantic treatment |
| ------------------------------------------------------------------------- | ------------------ |
| Stable channel; healthy, verified, complete, current                      | green              |
| Beta channel; informational, selected, loading, staged or in progress     | blue               |
| Rolling channel; attention, setup, available update or caution            | gold/yellow        |
| Genuine failure, incompatibility, destructive action or required recovery | red                |
| Unknown, not evaluated, neutral, inactive or disabled                     | gray               |

Release channel, Portcove support tier, readiness, qualification, update state,
and upstream status remain separate labeled contracts even when their colors
currently resolve to the same family. Stable does not imply fully qualified.
Rolling is attention, not danger. A retired upstream uses restrained attention
unless a separate known failure exists.

Application-update availability is gold; a downloaded, verified or staged
candidate awaiting installation is blue; current/completed is green; failure or
required recovery is red. Supported or verified source state is green,
informational is blue, recognized-but-not-listed or unreviewed-for-release is
gold, known incompatible is red, and unevaluated is gray. Ordinary backup
warnings use the warning family while failed or required recovery uses danger.
Storage changes color only when an existing domain contract provides meaningful,
actionable thresholds; presentation must not invent thresholds for decoration.

Dedicated aliases such as `--color-channel-stable-*`,
`--color-channel-beta-*`, and `--color-channel-rolling-*` may initially resolve
to the shared success, interactive, and warning families. Components still use
semantic aliases only, never raw `--n64-*` primitives or literal colors.

Red is intentionally not the general interaction color. Yellow is intentionally sparse. Status text uses lighter tonal stops on dark surfaces while filled controls use darker stops when warm-white text needs at least 4.5:1 contrast.

## Interaction states

- Standard controls move through neutral raised, hover, and pressed surfaces; selected controls use the blue scale.
- Primary calls to action use accessible red 700/600/800 surfaces for default, hover, and active states.
- Keyboard and controller focus uses a three-pixel yellow ring with offset, remaining distinct from blue selection.
- Success, warning, danger, and loading each have explicit foreground, surface, subtle, and border roles where needed.
- Disabled controls use neutral tokens and retain their shape without implying availability.
- Reduced-motion preference removes interactive and progress transitions.

Depth is limited to small highlights, shadows, inset pressed states, and simple geometric card art. Gradients, neon glow, copyrighted assets, and generic pixel-retro styling are deliberately excluded.

The wider component, typography, copy, vocabulary, navigation, and review contracts live in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).
