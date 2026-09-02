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
pnpm --dir apps/desktop test:theme
```

It also runs as part of the desktop test suite.

## Semantic hierarchy

| Role | Color family | Uses |
| --- | --- | --- |
| Neutral | charcoal, graphite, controller gray, warm white | app background, panels, typography, borders, disabled states |
| Interactive | cobalt blue | navigation selection, filters, links, staged/running state, controls, loading |
| Signature | Nintendo-like red | Portcove mark, page punctuation, primary play/install/apply actions |
| Highlight | golden yellow | focus rings, update badges, counters, setup/warning state |
| Success | emerald green | connected, verified, installed/current, completed, healthy state |

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
