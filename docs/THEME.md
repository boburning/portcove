# N64-inspired theme system

Portcove's default theme borrows its structure from Nintendo 64-era industrial hardware and its punctuation from late-1990s Nintendo color. It is not a replica console UI: charcoal plastic, graphite panels, controller gray, and warm white carry the interface, while softened red, blue, green, and yellow communicate specific roles.

## Token layers

`apps/desktop/src/styles.css` has four token layers:

1. `--n64-*-50` through `--n64-*-950` are palette primitives. The provided 100, 300, 500, and 700 stops remain fixed. Components must not reference these primitives.
2. `--color-*` aliases describe interface intent. Components consume these aliases exclusively, so a theme decision changes in one place instead of becoming a component exception.
3. Typography, spacing, radius, motion, shadow, control, icon, and layout tokens define reusable product foundations.
4. Component selectors consume semantic and foundation tokens. A component-only token is appropriate only when a reusable component has a stable need that no semantic alias expresses.

Dark is the default hardware-like graphite theme. Light uses warm controller-plastic gray and off-white surfaces with graphite text; it is a first-class semantic remap, not an inverted afterthought. System preference follows `prefers-color-scheme`, while explicit Dark and Light choices persist locally.

The automated theme contract fails if a component introduces a raw hex/RGB/HSL color, references an N64 primitive directly, adds a gradient, removes a required semantic alias, changes a fixed primitive, or drops a reviewed foreground/background pair below its WCAG threshold. It also inventories the checked-in Button, Dialog, Select, and runtime owner, rejects dynamic or raw-color utility fragments, and checks required selectors in available production CSS. A source-only run reports that narrower coverage when no production build exists; `just local-check` builds first and therefore exercises both.

Run it directly with:

```powershell
corepack pnpm --dir apps/desktop test:theme
```

It also runs as part of the desktop test suite.

## Approved styling architecture

[#917](https://github.com/boburning/portcove/issues/917) owns the finite Public
beta migration from the current global stylesheet and bespoke controls to the
checked-in shadcn 4.21.0 Base Nova source using Base UI 1.8.0, Tailwind 4.3.3,
semantic CSS variables, and a custom Portcove theme. React/Vite/Tauri and Lucide
remain in place. `components.json` records the generated aliases and direction-ready
configuration; [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) records exact versions and the
bounded regeneration procedure. That foundation is installed and several journeys
are migrating; legacy stylesheet rules and controls remain shipped behavior only
where their owners have not yet converted them. Nova is a compact starting scaffold
rather than the finished Portcove look; reference compositions deliberately establish
Portcove typography, spacing, radii, depth, surface, and artwork decisions.

CSS custom properties in `styles.css` are the canonical runtime authority for
semantic colors, dark/light mappings, typography foundations, spacing, radii,
controls, icons, focus, resets, shared motion, and cross-component layout.
Tailwind exposes approved aliases and variants rather than maintaining a second
theme. Tailwind utilities and approved component variants are the normal
feature-facing styling mechanism. Limited custom CSS remains valid for specialized
layout, artwork, interaction, and native boundaries where it materially improves
clarity. Do not translate official components into CSS Modules, keep competing
global/module/utility versions of the same rule, or add Sass, CSS-in-JS, another
framework, or a custom component registry.

Runtime theme selection uses the root `data-theme` contract. Tailwind dark
variants, checked-in controls, and portaled content must respond to that same
marker rather than an unrelated `.dark` class. Migrated controls own their
ordinary styling directly; an unlayered legacy override must not be the hidden
reason a checked-in component looks correct. Convert one owner, verify it, remove
the competing rule, and document only real temporary exceptions with a removal
condition.

The foundation starts with the smallest useful semantic vocabulary: surfaces,
text, borders, selection, focus, labeled statuses, typography, spacing, radii,
and motion. Add a role only when a real screen demonstrates that the existing
vocabulary cannot express it without bypassing semantics. Do not mechanically
translate every legacy value into a permanent token.

Geist is the bundled, offline default interface typeface. Technical content uses
an intentional monospace stack, and script fallbacks are coordinated with the
internationalization owner. Do not maintain a parallel TypeScript or JSON token
authority. A DTCG-compatible interchange format is conditional on a demonstrated
second consumer and review of the then-current community specification; it is not
a present requirement or a W3C Recommendation.

`check-theme.mjs` reads the semantic CSS authority, checked-in control source, and
available production CSS. It retains raw-color, primitive-token, dark/light,
focus-versus-selection, declared-token, contrast, discoverability, and required
production-variant protection. Third-party directives and variables receive
narrow handling rather than a blanket exemption. Advisory checks for unused
tokens, duplicated ownership, or arbitrary geometry must allow justified
exceptions rather than turning taste into a brittle parser.

## Semantic hierarchy

| Role        | Color family                                    | Uses                                                                          |
| ----------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Neutral     | charcoal, graphite, controller gray, warm white | app background, panels, typography, borders, disabled states                  |
| Interactive | cobalt blue                                     | navigation selection, filters, links, staged/running state, controls, loading |
| Signature   | Nintendo-like red                               | Portcove mark, page punctuation, primary play/install/apply actions           |
| Highlight   | golden yellow                                   | focus rings, update badges, counters, setup/warning state                     |
| Success     | emerald green                                   | connected, verified, installed/current, completed, healthy state              |

Ordinary buttons are neutral. Signature red is explicit primary emphasis for
Play, Install, or Apply. Destructive actions use separate semantics, wording,
placement, and confirmation even when they share a red palette family. Focus is
gold and remains distinct from selection and destructive intent in combined
states. Release metadata is quieter than operational readiness; generic controls
never infer qualification or eligibility from a label or color.

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
- The shared Button's `default` variant is deliberately neutral. `primary` is an explicit signature action, `selected` is blue state, and `destructive` communicates risk without replacing the shared gold focus ring.
- Keyboard and controller focus uses a three-pixel yellow ring with offset, remaining distinct from blue selection.
- Success, warning, danger, and loading each have explicit foreground, surface, subtle, and border roles where needed.
- Disabled controls use neutral tokens and retain their shape without implying availability.
- Reduced-motion preference removes interactive and progress transitions.
- Forced-colors behavior preserves useful system outlines, borders, and color adaptation; focus cannot depend on box shadow alone.

The shared 30/36/42 pixel control scale exceeds WCAG 2.2's 24-by-24 CSS pixel
minimum target size. Icon controls use the same assigned dimensions; compact
placement must not shrink their interactive box below that scale.

The runtime theme authority is `html[data-theme]`; Tailwind's `dark:` variant is
bound to that marker rather than a parallel `.dark` class. The document `dir`
attribute and Base UI `DirectionProvider` are the shared direction authority so
portaled Dialog and Select content inherit the same direction. Portcove currently
starts in `ltr`; locale selection and translated copy remain owned by #203/#1027.
Bundled Geist Variable leads the offline UI stack, with script-aware system
fallbacks and the intentional technical monospace stack retained in tokens.

Depth is limited to small highlights, shadows, inset pressed states, and simple geometric card art. Gradients, neon glow, copyrighted assets, and generic pixel-retro styling are deliberately excluded.

The wider component, typography, copy, vocabulary, navigation, and review contracts live in [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).
