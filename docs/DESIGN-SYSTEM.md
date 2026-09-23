# Portcove frontend design system

Portcove should feel like development software from an alternate 1997 console studio, rebuilt with current desktop UX and accessibility standards. Nostalgia never outranks clarity. The working interface stays compact, neutral, and technical; personality appears through tactile geometry, restrained color, direct copy, and quick interaction feedback.

The React/Vite/Tauri desktop is migrating incrementally under [#917](https://github.com/boburning/portcove/issues/917). Its checked-in foundation uses official shadcn/ui component source with Base UI, Tailwind, semantic CSS variables, and a Portcove theme; several journeys already consume that foundation while legacy controls and rules remain on unmigrated surfaces. This is a decided architecture and an active migration, not another framework comparison or a claim that the complete redesign or its platform qualification has shipped.

## Checked-in foundation

`apps/desktop/components.json` records Base UI, Base Nova (`style: base-nova`), React Server Components off, Lucide, the Tailwind entry, and the app-local aliases. The initial checked-in controls are Button, Dialog, and Select. They exist to prove the difficult installation-review nesting; they do not authorize broad screen migration by themselves. Portcove retained the generated internal implementations but removed the unused generated helper and unused public exports after static analysis; future regeneration must preserve that deliberately smaller maintained surface.

The foundation was generated and reviewed with these exact direct inputs:

| Input                             | Version | License    | Demonstrated purpose                                              |
| --------------------------------- | ------- | ---------- | ----------------------------------------------------------------- |
| shadcn CLI                        | 4.21.0  | MIT        | Base/Nova project configuration and checked-in control source     |
| Tailwind CSS and Vite integration | 4.3.3   | MIT        | generated component utilities and production CSS compilation      |
| Base UI React                     | 1.8.0   | MIT        | dialog, select, portal, dismissal, and focus primitives           |
| class-variance-authority          | 0.7.1   | Apache-2.0 | generated Button variants                                         |
| cn                                | 0.3.0   | MIT        | generated class composition utility                               |
| tw-animate-css                    | 1.4.0   | MIT        | generated state animations with Portcove reduced-motion overrides |
| Geist variable font               | 5.3.0   | OFL-1.1    | bundled, offline heading and interface typography                 |
| Tauri WDIO WebDriver plugin       | 1.4.0   | MIT        | feature-gated driver server, absent from production builds        |

The production build from base `52e81bd` emitted 560,643 bytes of JavaScript and 76,142 bytes of CSS. The same build after the foundation emitted 560,908 bytes of JavaScript, 111,551 bytes of CSS, and 76,416 bytes of local font files: a measured 112,094-byte raw asset increase excluding source maps (about 82,990 bytes using Vite's gzip figures for CSS/JavaScript and the already-compressed font files). This measurement is a bundle effect, not a performance claim.

For an upstream component update, invoke the exact CLI on demand with `pnpm dlx shadcn@4.21.0`, inspect `shadcn view` and `shadcn add <component> --dry-run`, compare the generated source with the app-owned file, and apply only reviewed changes. The app vendors only the generated `data-open`, `data-closed`, and `data-disabled` variants it uses, so ordinary installs and production builds do not carry the CLI dependency graph. Never overwrite Portcove token mappings or behavior fixes wholesale. Dependency upgrades and copied-component updates remain separate review decisions.

## Compatibility and qualification boundary

The dependency requirement, Portcove support promise, and observed environment are different facts:

| Platform            | Upstream dependency requirement                                                              | Portcove Public beta baseline                                  | Executable evidence owner                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64         | Tailwind/Base UI need a Chromium-family engine at least Chrome/Edge 111                      | Unchanged while #993 establishes an explicit WebView2/OS floor | Run `native-design-system-compatibility` in the actual Tauri app and record the exact WebView2 runtime; a current runtime pass is not minimum proof |
| Linux x64           | Wry 0.55.1 requires WebKitGTK 2.40+; Tailwind does not publish a WebKitGTK minimum guarantee | Unchanged while #993 proves an explicit Linux/WebKitGTK floor  | Use the existing Linux Tauri/WebKitWebDriver harness on the exact environment                                                                       |
| Steam Deck          | Must satisfy the proven Linux engine requirement in the actual SteamOS runtime               | Unchanged and not inferred from Ubuntu                         | Run the same retained fixture artifact/procedure on a Deck and record SteamOS/WebKitGTK identity                                                    |
| macOS Intel         | Tailwind/Base UI require Safari/WebKit 16.4-era features                                     | Unchanged; no macOS minimum is raised by this foundation       | Use the qualification-only embedded WebdriverIO route on an exact Intel WKWebView host                                                              |
| macOS Apple silicon | Tailwind/Base UI require Safari/WebKit 16.4-era features                                     | Unchanged; architecture does not itself establish an OS floor  | Use the qualification-only embedded WebdriverIO route on an exact Apple-silicon WKWebView host                                                      |

Vite's `es2021`, `chrome105`, and `safari13` transform targets remain unchanged and are not an operating-system support declaration. A support-policy reduction requires a separate reviewed change reconciling build targets, packages, updater behavior, and stable support documentation. Until #993 records the required native-family and claimed-minimum evidence, an affected platform remains unqualified for redesign publication even though this non-publishing foundation may be developed and merged. #45 retains broader 1.0 qualification.

## Foundations

- CSS custom properties in `apps/desktop/src/styles.css` are the canonical runtime token authority. Tailwind exposes approved aliases and variants rather than maintaining a second independently valued theme. Components consume semantic roles, never raw palette primitives or arbitrary utility colors. Legacy unlayered rules are temporary migration inputs, not hidden final authority: each converted control or journey establishes styling in its real owner, verifies the result, removes the competing rule, and records any retained exception with an owner and removal condition.
- The migration checks official shadcn/ui component source into Portcove; it then becomes Portcove-owned control code. Initialization explicitly selects Base UI and the compact Nova style, records React/Vite rather than Next.js assumptions, keeps React Server Components disabled, retains Lucide, and uses semantic CSS variables. Nova is initial density and composition scaffolding, not the visual acceptance target: the reference compositions must deliberately establish Portcove typography, spacing, radii, surfaces, and artwork hierarchy. Exact compatible stable versions and generated configuration are verified at implementation time instead of relying on CLI defaults.
- Tailwind utilities and variants are the primary component styling approach. Limited custom CSS remains appropriate for specialized artwork, layout, input, or native-integration behavior where it is clearer than utilities. CSS Modules may survive only for justified specialized ownership; they are no longer the default migration destination.
- `html[data-theme]` is the runtime theme marker and activates Tailwind `dark:` variants. `html[lang]`, `html[dir]`, and Base UI's `DirectionProvider` are now driven together by the [desktop localization owner](LOCALIZATION.md), including for portaled controls. New layout rules use logical properties and mixed-direction technical values keep an explicit direction.
- Shared Button intent is explicit: neutral `default`, signature-red `primary` for the dominant Play/Install/Apply action, blue `selected`, and danger-semantic `destructive`. All retain the shared gold focus signal and the 30/36/42 control scale. Dialog owns the semantic scrim without backdrop blur; Dialog and Select use logical positioning and spacing where direction matters.
- Graphite and warm controller-gray surfaces carry most of the interface. Blue means selected or interactive, yellow means keyboard/controller focus or rare emphasis, green means healthy or complete, and red is reserved for Portcove's signature and dangerous or critical action.
- Selected state and focus are deliberately different: blue communicates state; a gold outline communicates the current keyboard or controller target.
- Depth comes from borders, tonal steps, restrained inset treatment, and small shadows. Portcove does not use gradients, glass, blur, neon glow, scanlines, or pixel-interface typography.
- The bundled Geist variable font is the intended default interface typeface, with an intentional monospace stack for technical content and offline system/script fallbacks coordinated with #203. The desktop must not make a network request to render its interface.
- A second token interchange format is unnecessary while CSS has one runtime consumer. If a demonstrated second consumer later needs exchange, evaluate the then-current Design Tokens Community Group format without treating a community-group specification as a W3C Recommendation or manually maintaining competing CSS and JSON authorities.

## Component rules

- Import only controls demonstrated by current product needs. Checked-in controls should stay close to official composition, refs, events, and accessibility behavior; do not put a near-identical Portcove wrapper around every shadcn control.
- A specific Base UI control may be replaced when a reproducible Tauri, controller, accessibility, or supported-platform failure remains after bounded repair. Preserve the shared API, semantics, and theme where practical, record the evidence, and review the replacement independently; one incompatible control does not reopen the selected system.
- Controls use the shared 30, 36, and 42-pixel-equivalent height tokens and modest radius scale. Pills are reserved for compact status badges.
- Ordinary buttons are neutral by default. Signature-red Play, Install, or Apply emphasis is an explicit variant; destructive actions have distinct semantics, wording, placement, and confirmation behavior. Focus remains gold and visibly distinct from both selection and destructive intent, including the combined selected-and-focused state.
- Buttons name the result: `Review install`, `Play now`, `Verify sources`, and `Remove managed files`. Avoid `Submit`, `Proceed`, `Execute`, `Yes`, and `No` when the action can be named.
- Every control needs deliberate default, hover, focus, pressed, selected, disabled, and loading treatment where those states apply. Geometry must remain stable across those states, transitions must name intentional properties rather than use `transition-all`, and forced-colors presentation must retain visible system-compatible outlines, borders, and meaning.
- Icons come from Lucide through the shared `Icon` wrapper. An icon-only control must have an accessible name. Status never relies on icon or color alone.
- Dialogs trap focus, close with Escape, restore the initiating focus target, use a named heading, and reserve confirmations for destructive or difficult-to-reverse actions.
- Empty states explain what the area is, why it is empty, and the best next action. Loading copy names real work and does not invent percentages.
- Logs use monospace type, severity text plus icon and color, concise primary explanations, expandable technical details, and copy affordances.

## Implementation levels

Build five deliberately different levels:

1. **Tokens and foundations:** themes, surfaces, typography, spacing, control dimensions, radii, elevation, motion, focus, selection, and semantic state roles.
2. **Tailwind integration:** approved utilities and variants exposing those roles without becoming a second theme authority.
3. **Shared controls:** the needed shadcn/Base UI buttons, fields, selects or comboboxes, menus, dialogs, tabs, tooltips, and status elements checked into the shared UI directory recorded by `components.json`.
4. **Reusable interface patterns:** settings rows and sections, primary action with supporting status, review-and-confirm tasks, recoverable errors with diagnostics, operation progress and retained activity, and empty/loading/unavailable presentation. Extract these from reference screens rather than prebuilding a catalogue. Promote a composition only after a second real surface reuses it without feature-specific policy or parallel ordinary styling.
5. **Product components:** game cards, detail headers, source requirements, readiness summaries, update rows, and other feature-owned Portcove compositions. Domain readiness, authorization, lifecycle, and durable state remain outside generic controls and patterns.

Shared UI cannot import feature implementations. Features normally select an approved control or pattern variant and supply authoritative data and actions instead of independently choosing ordinary colors, borders, spacing, focus treatment, disabled appearance, typography, and control arrangements. A feature may arrange a control; repeated ordinary restyling signals a missing justified variant or an ownership violation.

## Finishing-quality contract

Finishing is acceptance within the owning journeys, not a separate perpetual polish program:

- Preserve query, filters, sort, scroll anchor, stable item selection, and sensible browsing focus per section and library. Restore context after navigation, picker cancellation, and returning from a launched game without reviving dismissed dialogs, stale review plans, cached authorization, another library's selection, or destructive confirmations.
- Reserve artwork and card geometry; retain useful existing content during refresh; keep loading, missing-artwork, failure, pending, and inline-confirmation states from shifting important controls. First paint uses the selected theme, application/window background, and offline typography without a bright flash or disruptive reflow.
- Acknowledge an action promptly without inventing its outcome. Copy confirmation is local; launch distinguishes accepted, starting, running when authoritative, and failure; install/update uses real stages or an honest indeterminate state; cancellation distinguishes requested from stopped; integration results distinguish core success from optional partial failure. The existing operation/event authority owns progress and durable outcomes, while toasts remain supplemental.
- Command-palette query changes choose the best eligible result predictably, background refresh preserves the active command by stable identity where possible, and Enter during IME composition never executes a command.
- Artwork remains legible and stable across bright, dark, white, missing, unusual-aspect, and long-title cases. Optional artwork failure does not become launch failure, and essential actions never depend on imagery.
- Optical review covers icon/label alignment, tabular numerals where values change or align in columns, consistent dialog geometry, subordinate shortcut hints, long-path identification and exact copying, and reduced nested-card emphasis. Essential instructions and warnings never exist only in a tooltip or browser title.
- Motion is small, interruptible, reduced-motion safe, and independent of business logic. Approximately 100–140 ms for ordinary visual transitions and 160–220 ms for small floating surfaces are evaluation ranges, not standards or global release gates.
- First use, no filtered matches, unavailable storage, refresh failure with retained data, operation failure, partial success, and cancellation remain distinct. Settings either persist immediately and report persistence truthfully or use an explicit Apply/Cancel transaction.

## Accessibility and international layout

WCAG 2.2 AA is the engineering target, not a certification claim. [Ordinary text](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) must reach 4.5:1 contrast and qualifying large text 3:1; [meaningful non-text controls and state indicators](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) need 3:1 where the criterion applies. Pointer targets meet the [AA 24×24 CSS-pixel minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) or a valid criterion exception documented in the evidence, with larger targets where task and input mode benefit. Focus is visible and [not entirely obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html). The detailed [Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html) criterion is AAA and may guide stronger treatment without being mislabeled as an AA requirement. Acceptance also covers text scaling, reflow, both themes, combined opacity/overlay/disabled/selected/focused states, and task usability.

Direction-aware layout uses logical properties and synchronizes document direction, Base UI direction, and portaled content. Only direction-dependent presentation mirrors; paths, hashes, numbers, artwork, media controls, and controller glyphs retain their intended meaning and receive appropriate mixed-direction isolation. Expanded and pseudo-localized text, long titles, CJK/complex-script fallbacks, combining characters, IME composition, and RTL focus/navigation are representative engineering fixtures coordinated with #203, not claims that every fixture language is supported.

## Agent implementation workflow

For each cohesive slice:

1. Read the relevant checked-in control, pattern, reference composition, and owning feature contract. Use official shadcn documentation and the project-aware shadcn skill only after its provenance, permissions, and current project configuration are reviewed.
2. Inspect registry or CLI output before writing, import only the needed components, review every supporting dependency and license, record its demonstrated need and measured bundle effect, and preserve local behavior fixes. Treat copied-component updates separately from dependency upgrades. Never blanket-overwrite customized controls during an upstream update.
3. Run focused tests and render the affected real-component scenarios at relevant themes, sizes, and states. Inspect the output for clipping, hierarchy, spacing, inconsistent controls, hidden actions, unreadable text, and missing states; screenshot generation alone is not inspection.
4. Repair identifiable defects or violated contracts. Repeated defects in an approved control or pattern are fixed at the shared owner rather than hidden by another feature override.
5. For an intentional reference change, record the reason, affected semantic or interaction contract, and inspected before/after evidence. Unexplained screenshot churn does not replace an accepted reference.
6. Hand the exact candidate head, acceptance criteria, scenario IDs, screenshots, checks, and limitations to the separate non-writing reviewer. Complete the normal exact-head validation and merge path.

The first foundation slice records the actual `components.json` paths, aliases, Base UI selection, Nova preset, Tailwind entry, semantic token mapping, icon choice, and component-update procedure, then imports only the controls needed to prove the complex installation-review dialog's nested selector, controller, portal, focus, and dismissal behavior in Tauri. Library and broad screen migration start only after that foundation is reviewed. Until the configuration lands, later sessions must not guess it. The existing development-only renderer remains the ordinary presentation loop, while the native harness remains required for Tauri, WebView, IPC, portal, focus, controller, native-dialog, restart, platform, and packaged obligations.

## Product vocabulary

| Term            | Meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Port            | One cataloged native decompilation, recompilation, or source-port integration.                         |
| Library         | Ports installed or adopted into the selected Portcove library root.                                    |
| Port catalog    | Every reviewed Portcove definition, including ports not installed locally.                             |
| Source          | A legally obtained original game file or reviewed file set referenced in place.                        |
| BIOS            | A separately modeled firmware requirement. It is not called a game source in recovery copy.            |
| Release channel | Stable, beta, or rolling upstream stream selected per port.                                            |
| Update policy   | Notify, stage, or automatically install for one installed port.                                        |
| Staged release  | A verified release retained locally but not yet active.                                                |
| Active version  | The managed version currently selected for launch.                                                     |
| Persistent data | Saves, settings, bindings, mods, and other mutable upstream-owned files kept outside managed versions. |
| Backup          | A verified snapshot of persistent data.                                                                |
| Build or setup  | Use the precise upstream operation. Do not call every install a build or every first launch a compile. |

GUI labels should match the CLI concepts. A GUI action that external tools may automate should expose its canonical `portcove` command where practical.

### Public beta writing and terminology

Use **original game files** for user-supplied input; name a ROM, disc image,
or BIOS when its format matters. A **saved game-file location** is a remembered
external reference, the **Portcove library** holds managed content, and an
**install folder** is future placement for installed versions. Use **saved data**
for the port's managed saves, settings, and other persistent files, with that
scope explained. A **Steam shortcut** is the integration object. **File details**,
**Technical details**, and **Test results** name different supporting information.
Use “port” for an implementation, catalog entry, or channel and “game” for
playing or managing saved data. Apply these terms to the affected copy rather
than replacing words globally.

Name a concrete action and object; say “Review” when review is actually next.
Place consequences before implementation detail and keep essential warnings
visible. Errors state the known cause, outcome, and realistic next action. Use
**Check method** for a configured way to inspect game files; say whether a check
actually ran and what it found separately. Show the planned output folder with
version and download size when the installation plan downloads a release; a plan
that reuses a local release must not present the configured future output folder
as that release's existing path. File-health summaries describe the saved files'
current comparison state in plain language; keep saved checksums in File details
and do not equate unchanged bytes with a supported edition or launch readiness.
Game-file inspection reports lead with the identified game, current result, and
next action. Admission, source authority, and test coverage stay in named
disclosures; assistive announcements report the actual result without claiming
that every check completed.
When a game-file search reaches a safety limit, name the limit and give a next
step that fits it. Show the submitted size and verification-work caps, and state when the
report does not identify the affected file.
Use sentence case and neutral task names beside authoritative status. Complete
localized messages use named interpolation and correct plurals; human formatting
may follow locale while machine contracts remain stable. Keep technical detail
for the audience that needs it. [#209](https://github.com/boburning/portcove/issues/209)
owns the broader 1.0 documentation architecture.

When a general product explanation is useful, prefer: “Portcove handles
installation, updates, and saves for native game ports. Use its desktop app, or
connect another launcher through the command-line interface.” Use named projects
only where instructions and scoped status make the name useful.

The game-detail command card must describe the command it actually generated,
not advertise a list of launchers. For an installed game, the planned copy is
heading **Launch from another app**, help “Use this command in a launcher that
supports custom commands. Portcove will start this game without opening the
desktop app.”, and action/accessibility label **Copy launch command**. For an
uninstalled game, it is heading **Set up from the command line**, help “Use this
command to set up this port from a terminal or script.”, and
action/accessibility label **Copy setup command**.

[#206](https://github.com/boburning/portcove/issues/206) owns that planned
runtime change. Use the wording only when the generated command and its
prerequisites make it truthful. A command containing placeholders is a template,
not ready-to-run. The implementation must also cover executable discovery,
explicit effective-library selection, spaces, Unicode, escaping, unavailable
tooling, and the distinction between a shell command and separate launcher
executable/argument fields. This documentation does not claim the current UI has
already changed.

## Shell and navigation

The stable desktop shell consists of primary port navigation, a scrollable workspace, contextual port details, and a predictable operation/error layer. Pages do not invent unrelated chrome. `Ctrl/Cmd+1–4` changes primary views, `/` focuses port search, and `Ctrl/Cmd+K` opens the command palette. Workspace shortcuts stay inactive behind a dialog.

Keyboard, controller, and dialog focus share one inventory of visible, enabled controls, including summaries and links. Arrow keys, the D-pad, and the left stick follow visual position within the current region. Left from the content edge returns to the sidebar; Right returns to the remembered content control. LB/RB selects the previous/next primary section when no dialog is open. A, Enter, and Space select. B/Escape closes only the top dialog and restores its initiating control; from the workspace it returns focus to the sidebar. A held button counts once even when opening a dialog rerenders the app. Directional repeat starts after 350 ms, then repeats every 140 ms.

Controller input explicitly enables the gold focus outline; browser keyboard heuristics alone cannot identify controller focus. Focused controls and selected commands scroll into view. Text fields retain native keyboard editing. Choice controls open a focused list where A selects and B cancels, without cycling values implicitly. Hints reflect the current surface: section shortcuts appear only in the workspace.

Vertical navigation visits the nearest visual row before considering horizontal alignment. Entering a new control group starts at its first control, so headers cannot skip filters, the first port card, or account actions. Within a card grid, vertical movement preserves the column. Search and Commands share the 42-pixel control height; search focus outlines the complete field including its icon and shortcut. External links use the desktop's system-browser bridge, which accepts only reviewed HTTPS project and GitHub device-login destinations and preserves the shared child-process environment policy.

Portcove targets dense desktop use and a minimum 960-pixel-wide Tauri window. At narrower supported widths, the shell reduces nonessential labels and column count before hiding technical data. Reduced-motion preference removes nonessential transitions and progress animation.

## Game artwork

[#208](https://github.com/boburning/portcove/issues/208) owns the shared artwork
contract; [#206](https://github.com/boburning/portcove/issues/206) owns its desktop
presentation. Start with consistent 2:3 portrait library/catalog covers unless
current design evidence supports another established layout. Letterbox other
ratios instead of silently cropping important content. Wide detail imagery is
optional; titles, status and actions remain readable outside images, including
generated fallback states. Logos, icons, animation and a crop editor are not
required for this slice.

The current account-free fallback is a core-owned style with a stable identity,
initials and palette per port and slot. Desktop renders that exact result before an
explicit local image is chosen and whenever retained local bytes are unavailable;
it does not infer another title-based fallback. The source disclosure identifies
the Portcove generator and exact fallback identity without claiming third-party
artwork rights. If thumbnail transport or browser decoding fails after core resolves
a local import, the shared display cache switches every visible consumer and its source
disclosure to this generated fallback without changing the durable local choice.
Catalog-selected and provider assets remain separate planned sources.

Provide **Change artwork**, **Choose local image**, **Browse SteamGridDB** when
configured, **Reset to default**, and source/author information. Reset affects
only the selected slot's explicit choice; unavailable preferred art retains its
selection with a fallback or actionable explanation. Keep provider configuration
in Appearance or Integrations with contextual picker guidance, never first-play
API-key onboarding. Keyboard/controller navigation, focus restoration, long
titles, scaled layouts and text status must remain usable.

The selected-game Steam flow also presents **Include artwork**, any existing
destination customization, per-role planned source and a truthful partial result.
Its destination roles are static portrait cover, landscape cover and hero/banner;
they do not force every role to become a new first-class Desktop display slot.
Preserve existing Steam art by default. **Repair Steam entry** does not write art;
**Update Steam artwork** fills missing roles by default and requires a deliberate
choice before replacing existing art. Never stretch or destructively crop one role
to impersonate another. Missing provider setup, network access or a match stays an
actionable artwork limitation, not a failed shortcut or launch.

Render cached display-sized thumbnails immediately and fetch asynchronously.
Reject stale picker/library results and reconnect to shared selections after a
frontend restart. Import local images by safe managed copy without moving or
deleting originals; clearing cache cannot erase imports or preferences. The
initial ingestion set is small, static and raster-only, with bounded decoding
and no active content. Optional online access discloses requested game IDs or
search terms and normal network metadata; it must not disclose ROMs, hashes,
local paths, credentials or unrelated library data. Provider tags are not a
content-safety guarantee. These requirements are prospective; exact scope and
future evidence remain in the issues.

## Brand art

The crab mascot and dimensional display wordmark follow the provenance, placement, accessibility, and derivative rules in [BRAND-ASSETS.md](BRAND-ASSETS.md). Brand art is deliberately rarer and more expressive than the working interface: use it to establish identity at startup, in an empty library, in About, or at a meaningful milestone—not as wallpaper for operational controls.

## Approved Public beta redesign contract

[#917](https://github.com/boburning/portcove/issues/917) is the finite desktop
redesign, shared-control, visual-system, style-enforcement, and visual-acceptance
owner. It is an organizational child of #200; that parentage does not retarget
the broader workstream or make #200 closure a Public beta prerequisite. #917 itself remains a Required
Public beta outcome. #206 retains information
architecture, navigation, interaction, focus, content ordering, and domain-driven
presentation. #203 retains labels, localization, formatting, and safe unknowns.
#208 retains shared artwork selection/provenance/fallback/ingestion/cache, and
#527 retains SteamGridDB provider behavior. #29/#44 retain controller performance,
physical-Xbox, controller-navigation, and minimum-width qualification; #47
retains intrinsically packaged human comprehension/controller observations.

Use three levels when reviewing every surface:

1. **Primary:** what game or surface is this, and what should the player do?
2. **Secondary:** what relevant state is it currently in?
3. **Tertiary:** how does Portcove technically manage it?

Technical detail remains available, but it does not routinely compete with the
game and primary action. Catalog and library cards lead with artwork, title,
readiness, and the next action; secondary facts are quiet metadata rather than
equal-weight chips. Consistent 2:3 artwork may gain modest weight where responsive
space permits, while cards stay compact desktop controls rather than storefront
tiles. Important attention such as an available update remains visible.

Keep the sidebar stable and quiet: identity plus Library, Port Catalog, Updates,
and Settings are primary. Contextual Library actions such as copying an existing
installation need not occupy permanent navigation chrome. Shortcut hints remain
discoverable without dominating every visit. Repeated page headers should be
compact application chrome; explanatory prose and the red eyebrow are used when
they add meaning rather than consuming every workspace.

Ordinary geometry follows the spacing, radius, control, and layout scales;
one-off measurements need an actual layout reason. Tonal differences or subtle
borders group ordinary content, cards use restrained borders, hover strengthens
the affordance, blue marks selection, gold marks focus, and dialogs/floating
surfaces receive the strongest depth. Do not give every nested surface equal
weight. No glass, blur, glow, gradients, neon, scanlines, CRT effects, pixel-font
UI, giant SaaS radii, ornamental motion, Steam imitation, or generic Material
restyling belongs in this contract.

Preserve the existing detail order while strengthening its cover/title/readiness
hero and one dominant Play, Install, or Review action. Evidence may justify a
roughly 36–40rem surface on large displays or a restrained sticky primary action,
but focus, controller navigation, compact layouts, and safety information must
remain intact. Infrequent maintenance and technical controls use progressive
disclosure without becoming hidden safety state. Settings grows through clear
Appearance, Library & Storage, Game Files, Updates, Integrations, and Advanced
grouping using the smallest scalable structure, not an automatic second sidebar.

Motion remains short, tactile, and functional for press, selection, panel,
palette, notice, disclosure, and artwork transitions. Reduced motion removes
nonessential motion. Typography must become deterministic and offline across
supported desktop platforms: package reviewed fonts only after license and
package-impact acceptance, otherwise use an intentional supported fallback.
Loading placeholders must preserve expected geometry without shimmer or
gradients; accessible loading text remains authoritative.

Implementation establishes official shadcn/Base UI controls, Tailwind, semantic
CSS variables, reusable interface patterns, and the custom Portcove theme. Each
converted surface removes the controls, traps, and style ownership it replaces or
records the retained exception and removal condition; migration cannot leave two
permanent design systems. It must preserve mouse,
keyboard and controller use, focus restoration, dialog trapping, accessible
names, semantic HTML, status text, long titles, compact/scaled layouts, minimum
width, and the distinction between blue selection and gold focus. Native evidence
covers dark/light, standard/minimum/large widths, 1280×800 where applicable,
scaling, long titles, fallback and local artwork, ready/setup/staged/error/update
states, and Catalog, Library, Detail, Settings, and Update Center. Deterministic
screenshots supplement rather than replace accessibility and input checks; no
broad fragile pixel-perfect suite is required.

## Review gates

Run the focused frontend tests, applicable theme/style contracts, production build, and Fallow before accepting a design-system change. The style gates must cover the actual Tailwind CSS and JSX utility sources, reject raw status colors and direct primitive consumption, preserve dark/light, focus/selection, contrast, reduced-motion, and production-variant coverage, and handle third-party directives narrowly rather than with blanket exemptions. Fallow should remain free of dead files, unused dependencies, duplication, circular dependencies, unused theme tokens, and above-threshold functions. Acceptance records intentional reference changes and verifies that each migrated surface has one remaining control/style owner.

The three early finished reference compositions are Library, the game-details workspace, and a complex installation-review dialog with nested selection and errors. Their real-component scenarios cover empty, loading, long-title, missing-artwork, disabled, error, interrupted, and narrow-layout states. Completion requires both themes, current minimum/default/large sizes, 1280×800 where relevant, supported scaling, long text, keyboard/mouse/controller behavior, nested overlays, focus return, async changes, navigation during work, reduced motion, and capability parity. Browser fixtures and screenshots do not replace native or intrinsically human evidence.
