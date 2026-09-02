# Portcove frontend design system

Portcove should feel like development software from an alternate 1997 console studio, rebuilt with current desktop UX and accessibility standards. Nostalgia never outranks clarity. The working interface stays compact, neutral, and technical; personality appears through tactile geometry, restrained color, direct copy, and quick interaction feedback.

## Foundations

- Components consume semantic tokens from `apps/desktop/src/styles.css`, never raw N64 palette primitives. Primitive color, type, spacing, radius, motion, control, icon, shadow, and layout values are implementation details of the theme.
- Graphite and warm controller-gray surfaces carry most of the interface. Blue means selected or interactive, yellow means keyboard/controller focus or rare emphasis, green means healthy or complete, and red is reserved for Portcove's signature and dangerous or critical action.
- Selected state and focus are deliberately different: blue communicates state; a gold outline communicates the current keyboard or controller target.
- Depth comes from borders, tonal steps, restrained inset treatment, and small shadows. Portcove does not use gradients, glass, blur, neon glow, scanlines, or pixel-interface typography.
- Space Grotesk and JetBrains Mono are optional local enhancements. Offline system fallbacks are required; the desktop must not make a network request to render its interface.

## Component rules

- Controls use the shared 30, 36, and 42-pixel-equivalent height tokens and 3, 6, or 8-pixel-equivalent radii. Pills are reserved for compact status badges.
- Buttons name the result: `Review install`, `Play now`, `Verify sources`, and `Remove managed files`. Avoid `Submit`, `Proceed`, `Execute`, `Yes`, and `No` when the action can be named.
- Every control needs deliberate default, hover, focus, pressed, selected, disabled, and loading treatment where those states apply.
- Icons come from Lucide through the shared `Icon` wrapper. An icon-only control must have an accessible name. Status never relies on icon or color alone.
- Dialogs trap focus, close with Escape, restore the initiating focus target, use a named heading, and reserve confirmations for destructive or difficult-to-reverse actions.
- Empty states explain what the area is, why it is empty, and the best next action. Loading copy names real work and does not invent percentages.
- Logs use monospace type, severity text plus icon and color, concise primary explanations, expandable technical details, and copy affordances.

## Product vocabulary

| Term | Meaning |
| --- | --- |
| Port | One cataloged native decompilation, recompilation, or source-port integration. |
| Library | Ports installed or adopted into the selected Portcove library root. |
| Port catalog | Every reviewed Portcove definition, including ports not installed locally. |
| Source | A legally obtained original game file or reviewed file set referenced in place. |
| BIOS | A separately modeled firmware requirement. It is not called a game source in recovery copy. |
| Release channel | Stable, beta, or rolling upstream stream selected per port. |
| Update policy | Notify, stage, or automatically install for one installed port. |
| Staged release | A verified release retained locally but not yet active. |
| Active version | The managed version currently selected for launch. |
| Persistent data | Saves, settings, bindings, mods, and other mutable upstream-owned files kept outside managed versions. |
| Backup | A verified snapshot of persistent data. |
| Build or setup | Use the precise upstream operation. Do not call every install a build or every first launch a compile. |

GUI labels should match the CLI concepts. A GUI action that external tools may automate should expose its canonical `portcove` command where practical.

## Shell and navigation

The stable desktop shell consists of primary port navigation, a scrollable workspace, contextual port details, and a predictable operation/error layer. Pages do not invent unrelated chrome. `Ctrl/Cmd+1–4` changes primary views, `/` focuses port search, and `Ctrl/Cmd+K` opens the command palette. Arrow keys and gamepad direction follow visual position; Enter, Space, and controller A activate; Escape and controller B move back.

Portcove targets dense desktop use and a minimum 960-pixel-wide Tauri window. At narrower supported widths, the shell reduces nonessential labels and column count before hiding technical data. Reduced-motion preference removes nonessential transitions and progress animation.

## Brand art

The crab mascot and dimensional display wordmark follow the provenance, placement, accessibility, and derivative rules in [BRAND-ASSETS.md](BRAND-ASSETS.md). Brand art is deliberately rarer and more expressive than the working interface: use it to establish identity at startup, in an empty library, in About, or at a meaningful milestone—not as wallpaper for operational controls.

## Review gates

Run the frontend tests and theme contract, the production build, and Fallow before accepting a design-system change. The theme contract rejects raw component colors, direct primitive consumption, gradients, missing semantic roles, and reviewed contrast regressions. Fallow should remain free of dead files, unused dependencies, duplication, circular dependencies, unused theme tokens, and above-threshold functions.
