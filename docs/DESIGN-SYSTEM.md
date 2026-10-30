# Portcove frontend design system

The current whole-product composition and coverage contract is [Integrated UI design](INTEGRATED-UI-DESIGN.md). Reuse the existing control, token, preference and domain-projection owners throughout; task-specific layouts do not introduce a second authority.

## Saved-location impact

Saved-location removal uses an inline impact region within Game files. Its
explicit review trigger loads fresh consequences; Remove saved location… opens
the sole final native approval. The full affected game/port set remains available
inline. Keep location dismisses the inline region and returns focus to its
trigger. Cancellation is neutral and changed impact requires renewed intent.
Other destructive reviews retain their own consent contracts.

## Library and Discover covers and compact rows

Library and Discover default independently to Covers; Compact rows uses the same entries and authoritative
local actions. Their profile-local preferences are separate and retain read/write failure feedback. Library defaults to Title A–Z only when no saved sort exists and also offers Catalog order, Title Z–A and Recently played using recorded launch history; Discover offers Catalog order, Title A–Z, Title Z–A and In library first. With an observed device target, Catalog order is labeled Library & device to describe the existing deterministic library/device ranking; its explanation remains visible. No subjective recommendation or quality score is implied. Library counts entries, including separate ports for one game; Discover names reviewed game groups and matching independent ports separately.
Search, named Readiness, independent Favorites and declared filters share the
retrieval area. On narrow layouts Favorites and Filters can share a wrapped row;
no hidden duplicate controls or second query owner are introduced. Active filter
chips, counts and reset stay with the existing browsing projection. First use
omits retrieval controls. Add games sits beside the Library heading; scoped
Collection commands accompany collection navigation; Covers/Compact rows share the retrieval toolbar. At
compact widths the visible Rows label retains its full Compact rows accessible
name. Readiness keeps its accessible label when its decorative prefix is omitted
above 20rem through 32rem of query width. Collection commands retains its explicit
selection scope, including filtered-out entries in supported Steam commands.

Covers use content-driven columns with a preferred minimum of 12rem, giving
five columns at the matched 1440px desktop viewport with the normal interface
size and full sidebar. Available width and interface size change the count.
Whole-image 2:3 artwork caps at 260 CSS pixels; below 28em of collection width
it caps at 160px. Compact widths and short desktop windows use a 10rem preferred column minimum; artwork remains capped at 260px even when supporting text grows. Supporting text
scales and wraps without growing artwork beyond its CSS bound; native interface
zoom still enlarges the physical rendering. Cover cards reserve two readable lines for both title and project, aligning chips and actions across mixed-length identities. Both expand on keyboard focus. Full identity wraps below
40em. Footer actions stay beside the dominant status without overlapping it. Repeated Play controls pair a triangle with a quiet bordered, labeled button, including hover and keyboard focus; the selected game's detail and Continue actions retain signature red emphasis. Setup and review actions include a right arrow. A subtle divider separates the status/action footer from identity chips.
The quick views read as underlined navigation above the search/filter toolbar.
Artwork remains contained; neither a crop nor a provider mapping is inferred.

Library entries have separate identity, Play/review and More actions controls.
Library cards expose a heart favorite toggle at the artwork’s upper right, beside More actions. More retains existing organization, update/activity and saved-data destinations. The direct toggle uses the same preference owner, failure handling and focus return when a filtered entry disappears. Discover places its grouped-game bookmark Save action over the cover and retains the independent Favorite control for singleton projects. Overlay controls are sibling buttons outside the identity control, always visible for touch, at least 32px square, and bounded by the actual artwork. Compact rows place them inline. Discover’s full-width arrow action opens the exact project or comparison; it does not bypass setup review. Checked Ready to play uses semantic success green in both
themes; selection remains blue and focus retains its distinct indicator. A
playable current installation keeps Play when a downloaded candidate is present.
The candidate has a concise update review link. Healthy update entries omit the redundant green readiness summary while retaining Play. Mandatory setup/repair/unknown states and concurrent blockers remain visible. Acquisition work or attention precedes prepared/available update copy; secondary update/channel facts use an explicit disclosure. Active invocations lead to their existing task destination.

Compact rows keep 32x48px contained thumbnails (up to 40x60px with text enlargement),
10px block padding, full wrapping identity and a bounded action span. The list
uses the available workspace width. Below 36em readiness stacks beneath identity with
thumbnail alignment indentation; its separate column has no indentation. Below
28em actions follow readiness. Artwork loading, stale/failed notices and user
precedence remain with the existing artwork owner.

Discover groups only explicitly authored original-game IDs. Unknown identities
remain separate projects; result labels distinguish reviewed game groups,
ungrouped projects and matching independent ports. All accepted definitions,
listings and pending setups remain searchable, including Library-hidden ports.
A group with one matching port opens that exact port; comparison retains all
separate projects and marks those outside current filters. Library entries,
installations, favorites and operation targets keep their independent port IDs.

One expandable Filters panel owns original system, target OS, all offered
channels, total Single/Multiple port options and library membership. Advanced
setup, attention, updates and observed file controls retain their existing query
owners and unavailable states. OR within facets and AND across facets must match
one eligible port/context. Clear filters preserves search; Escape and Done return
focus to Filters. Source systems without reviewed metadata say Not specified.
Each workspace composes collection/navigation choices, one search/filter/sort/view toolbar, then a wrapping result and active-filter summary. Chips name their categories and share the choices’ canonical identity icons/colors; target labels retain architecture. Clear filters preserves search and returns focus to Filters.

Comparisons use balanced project cards, side by side where space allows and stacked in compact windows, with aligned setup, file, target, ownership and observation sections. Filtered-out projects retain their own actions and explicit qualification. Unresearched gameplay differences remain unclaimed.

Identity chips use the v58 decorative Lucide/palette mappings; semantic readiness,
warning, failure, selection and focus retain their own tokens.
Facet choices wrap at their natural width and align to the start of each group;
neighboring groups do not stretch them into equal-height tiles.

Geist, semantic tokens, the existing controls and the one persisted/native sizing
authority remain shared. Enlarged text may wrap and scroll; it never authorizes
shrinking essential text, hiding consequences or replacing the domain projections.

Collection titles use scalable 14px-equivalent type with 1.45 leading; project text
uses a 12px-equivalent role with 1.5 leading. The cover-to-identity gap is 24px at
normal scale, columns are separated by 20px, and card actions use a 32px-equivalent
height. Shared general-purpose buttons retain their larger hit targets. Saved and
hidden collection views, Favorites, and Not in library share existing query owners;
the latter is selected only for that exact singleton membership, not an OR selection
that also includes installed games. Selecting a quick view preserves search and
unrelated facets.

## Game details

Managed games, registered external installations and catalog/self-service entries
use one responsive detail composition, bounded at 87.5rem. The complete game title uses the existing large
heading token. Project and variant, observed readiness, a natural-width primary
action and adjacent overflow follow it. Green readiness and direct red Play retain
their existing authoritative projections. The installation fact is independently
observed: managed version, registered external installation, downloaded setup or
not installed. Readiness never establishes ownership.

Details and the single Continue strip share one foreground identity system:
a suitable admitted game logo, then the appropriate existing Cover,
then the typeset title. Prefer the exact port within each role, then an accurately
matched applicable original game/edition. A missing logo never skips the Cover.
Keep project/variant identity visible beside original-game branding. Foreground,
atmospheric landscape background and gallery resolve independently through the
existing media authority, with provenance, user customization, bounded cached
assets and quiet failure. Never stretch a portrait cover into a landscape header.

Foreground art preserves its natural aspect ratio in a reserved, responsive
frame. Cover fallback stays deliberately portrait, including narrow layouts;
logos use wider bounded frames where useful. Compact details stack
the foreground above complete identity/actions. The directional background mask
protects text, while a solid narrow text stage and sufficient heading leading
keep the complete glyph bounds over a readable surface. Logo ink/contrast and
minimum rendered size are checked; unsuitable or failed assets advance to the
next fallback without arbitrary pixel recoloring. Continue uses recorded launch
history and relaunches that installation; it does not load a save automatically.
Loaded galleries use three columns for exactly three images in wide containers,
two for other multi-image sets and medium widths, and one in compact containers; per-slot attribution,
errors and lightbox focus remain with the media owner. Forced colors suppress
decorative backdrop images. Change artwork in Manage retains the existing user
artwork choices. No title-based identity or edition mapping is inferred.

Five permanent sections use Base UI manual-activation tabs. Arrow keys and
Home/End move focus; Enter/Space select. Narrow tab lists retain visible labels in one horizontally scrollable row.
Panels stay mounted to preserve drafts and reviews; inactive panels are hidden and
inert, so they cannot receive keyboard, accessibility or controller traversal.
Overview pairs the actual description with a narrower facts column; project status,
compatibility qualifications and recorded checks have named disclosures. Game files owns setup, source/BIOS/tool and file observations. Saves owns
coverage, unknowns, backup history, recovery and reviews. Versions & updates owns
checks, candidate decisions, staged activation, rollback, future preferences and
private notice choices. Manage owns installation/location/artwork/Steam/CLI,
verification/removal and the existing reviewed managed-route transition. Unsupported routes state their actual limits and keep upstream links.

A concise attention strip exposes relevant exceptions and running work; its action
opens the owning section. An available update does not change the current playable
installation into a readiness failure. Header and overflow shortcuts reveal the
section before invoking its existing control; destructive reviews and native consent
remain with their production owners.

### Detail opening, focus and return contract

The navigation owner carries the requested destination and a unique opening token.
An explicit update destination opens Versions and an explicit backup destination
opens Saved data. Otherwise setup, absent/changed/unreadable inputs, unknown readiness,
invalid installation or incomplete external setup open Files; an observed update or
staged candidate opens Versions; ready entries normally open Overview. Choose this
once per opening. Refresh, task completion and new observations update content and
notices without changing a manual selection or reclaiming focus. A new opening
reevaluates the destination.

Ordinary entry focuses the game heading. Explicit section links activate their panel
before focusing its heading. Menu/dialog dismissal returns to a connected visible
trigger or a section fallback. Completion intent is bound to operation identity,
generation and the current opening; obsolete or inactive-panel continuations do not
reclaim focus. Back restores the exact entry and originating control together with
search, filters, cover/row view and workspace/document scroll. The existing navigation,
operation and review owners retain those responsibilities; presentation adds no
durable state or parallel workflow authority.

Settings uses plain headings, retaining quiet context labels where device/current
library scope matters. Add games says Review before continuing across routes.

## Activity and contextual task feedback

Pending launch controls in Library covers/rows, Continue, details and Activity retain
focusability through Base UI's focusable-disabled behavior and expose `aria-busy`.
They refuse pointer and keyboard activation while excluded. This preserves the
origin during native foreground re-entry without moving focus back after a player
has navigated elsewhere. Unavailable launch requirements retain ordinary disabled
behavior; focusability never supplies launch authority.

Changing task or workspace feedback preserves the current visible reading anchor.
The workspace reflow owner coordinates feedback-height and window changes using
the remaining measured displacement, not a saved launch scroll offset. New user
input, navigation, library/detail changes and modal interaction take precedence;
feedback changes never take focus or reveal a control the player left behind.

Primary destinations display Library, Discover, Activity and Settings; internal `catalog`/`updates` route identities stay compatible. Ordinary Activity entry selects Tasks. Explicit game-update links select Game updates; terminal records remain in History. Application-update preferences remain in Settings. Section controls retain a non-color selected cue and keep their content mounted, hidden from interaction when inactive. The same exact-ID record tree serves Tasks and History, preserving disclosures and a focused settling record.

Cards, details and Activity use the same action-presentation selector. Core readiness remains distinct from a temporary local exclusion. Feedback names the action and game/port or library target. Independent failures remain individually dismissible; a successful mutation followed by failed refresh is presented as finished work with unavailable current state, not an instruction to repeat the mutation. Link a specific task only when its exact owned identity exists. Shared progress announces phase changes separately from numeric ticks. Cancellation requested stays pending until authoritative settlement.

Portcove should feel like development software from an alternate 1997 console studio, rebuilt with current desktop UX and accessibility standards. Nostalgia never outranks clarity. The working interface stays compact, neutral, and technical; personality appears through tactile geometry, restrained color, direct copy, and quick interaction feedback.

The React/Vite/Tauri desktop is migrating incrementally under [#917](https://github.com/boburning/portcove/issues/917). Its checked-in foundation uses official shadcn/ui component source with Base UI, Tailwind, semantic CSS variables, and a Portcove theme; several journeys already consume that foundation while legacy controls and rules remain on unmigrated surfaces. This is a decided architecture and an active migration, not another framework comparison or a claim that the complete redesign or its platform qualification has shipped.

## Checked-in foundation

`apps/desktop/components.json` records Base UI, Base Nova (`style: base-nova`), React Server Components off, Lucide, the Tailwind entry, and the app-local aliases. The initial checked-in controls are Button, Dialog, and Select. They exist to prove the difficult installation-review nesting; they do not authorize broad screen migration by themselves. Portcove retained the generated internal implementations but removed the unused generated helper and unused public exports after static analysis; future regeneration must preserve that deliberately smaller maintained surface.

The following table preserves the initial generation inputs. Current runtime inputs are Base UI 1.9.0, cn 0.5.0 and Tailwind 4.3.3 under Vite+ 1.3.0. The finite [CSS architecture cutover](reference/css-architecture.md) uses Preflight, explicit layers and Base UI transitions; tw-animate-css is removed. The wider #917 acceptance remains open.

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

For an upstream component update, invoke the exact CLI on demand with `pnpm dlx shadcn@4.21.0`, inspect `shadcn view` and `shadcn add <component> --dry-run`, compare the generated source with the app-owned file, and apply only reviewed changes. Ordinary builds do not carry the CLI dependency graph. Adapt generated output to native Base UI starting/ending and state attributes, the shared outline/motion conventions, and the CSS entry at `src/styles/index.css`; do not restore copied animation helpers or reset overrides. Never overwrite Portcove token mappings or behavior fixes wholesale. Dependency upgrades and copied-component updates remain separate review decisions.

## Compatibility and qualification boundary

The dependency requirement, Portcove support promise, and observed environment are different facts:

| Platform            | Upstream dependency requirement                                                                                       | Portcove Public beta baseline                                                                                   | Executable evidence owner                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows x64         | Tailwind/Base UI need a Chromium-family engine at least Chrome/Edge 111                                               | Windows 11 26H2 with security updates; serviced WebView2 Evergreen production Runtime, initially 155.0.4283.62+ | #993 retains exact 26H2 native/installed evidence; 25H2 is an unqualified follow-up, not an initial-beta gate                                 |
| Linux x64           | Tauri runtime 2.12.2 with Wry 0.57.0 enables WebKitGTK 2.40+; Tailwind does not publish a WebKitGTK minimum guarantee | Updated Ubuntu 24.04 LTS with maintained WebKitGTK 2.52.6+ (initial package 2.52.6-0ubuntu0.24.04.1)            | #993 must qualify Ubuntu 24.04 native and installed packages, including the AppImage's actual bundled/loaded engine                           |
| Steam Deck          | Must satisfy the proven Linux engine requirement in the actual SteamOS runtime                                        | Unqualified at initial beta; follow-up required before 1.0                                                      | #51/#217 run the retained fixture on actual Deck and record SteamOS/WebKitGTK identity; #993 beta closure does not wait for this device proof |
| macOS Intel         | Tailwind/Base UI require Safari/WebKit 16.4-era features                                                              | Unqualified initial beta; qualify before 1.0 during beta                                                        | #45/#226 use the existing qualification route on an exact Intel WKWebView host                                                                |
| macOS Apple silicon | Tailwind/Base UI require Safari/WebKit 16.4-era features                                                              | Unqualified initial beta; qualify before 1.0 during beta                                                        | #45/#226 use the existing qualification route on an exact Apple-silicon WKWebView host                                                        |

The owner approved the Linux support pair in the October 18 #993 follow-up and amended the initial-beta Windows target to 26H2 on October 19. Windows 25H2 remains an explicit unqualified follow-up compatibility target; missing media is not evidence of incompatibility. This support amendment adds no installer or startup OS rejection. Approval selects the support policy; it does not establish a qualification pass. Evergreen automatic updates remain enabled. The exact tested OS builds, package revisions, loaded engines and artifact identities belong to #993's evidence. Other Linux distributions and older engines acquire no support claim. Ubuntu 22.04 compilation remains useful CI feedback, separately from the Ubuntu 24.04 package producer and supported runtime.

Vite's `chrome111` and `safari16.4` transform targets match the selected Tailwind engine features and are not an operating-system support declaration. Until #993 records the required native-family and claimed-minimum evidence, an affected platform remains unqualified for redesign publication even though this non-publishing foundation may be developed and merged. #993 retains the bounded selected-stack architecture/portability decision and
Windows/Linux native/minimum proof required by #917. Keep practical macOS CI/build
health; full Intel/Apple Silicon native/package qualification belongs to #45/#226
during beta before 1.0, without holding the initial Windows/Linux foundation.

The [versioned runtime manifest](https://github.com/tauri-apps/tauri/blob/tauri-runtime-wry-v2.12.2/crates/tauri-runtime-wry/Cargo.toml)
selects Wry 0.57.0's `linux-body` feature and WebKitGTK `v2_40`; the
[versioned Wry manifest](https://github.com/tauri-apps/wry/blob/wry-v0.57.0/Cargo.toml)
maps that feature to `webkit2gtk/v2_40`. This dependency requirement does not
establish Portcove's supported distro or selected design system's proven engine floor.

The compatible baseline delivered by [#1972](https://github.com/boburning/portcove/pull/1972)
uses Tauri/API 2.12.4, runtime/runtime-wry 2.12.2, build/codegen/macros 2.7.3
and dialog 2.8.3. It includes the upstream IPC/asset empty-path panic repair.
CLI 2.12.1 remains qualified; [#2014](https://github.com/boburning/portcove/issues/2014)
owns CLI 2.12.3's canonical prerelease RPM regression. These pairings do not change
build targets, operating-system minima or publication qualification.

## Foundations

- CSS custom properties in `apps/desktop/src/styles/tokens.css` are the canonical runtime token authority. Tailwind exposes approved aliases and variants rather than maintaining a second independently valued theme. Components consume semantic roles, never raw palette primitives or arbitrary utility colors. The standard theme/base/components/utilities cascade and Tailwind Preflight replace the old global stylesheet. Shared controls own appearance; actual shared row/notice patterns and local artwork geometry replace broad feature selectors. A legacy layer or override sheet is not a final destination. Shared game-hero geometry belongs to `styles/heroes.css`; Settings rows, field compositions and theme previews belong to `styles/settings.css`. Keep their control semantics in the existing UI primitives and their colors in the canonical tokens, rather than reintroducing feature-wide utility overrides.
- The migration checks official shadcn/ui component source into Portcove; it then becomes Portcove-owned control code. Initialization explicitly selects Base UI and the compact Nova style, records React/Vite rather than Next.js assumptions, keeps React Server Components disabled, retains Lucide, and uses semantic CSS variables. Nova is initial density and composition scaffolding, not the visual acceptance target: the reference compositions must deliberately establish Portcove typography, spacing, radii, surfaces, and artwork hierarchy. Exact compatible stable versions and generated configuration are verified at implementation time instead of relying on CLI defaults.
- Tailwind utilities and variants are the primary component styling approach. Limited custom CSS remains appropriate for specialized artwork, layout, input, or native-integration behavior where it is clearer than utilities. CSS Modules may survive only for justified specialized ownership; they are no longer the default migration destination.
- `html[data-theme]` is the runtime theme marker and activates Tailwind `dark:` variants. `html[lang]`, `html[dir]`, and Base UI's `DirectionProvider` are now driven together by the [desktop localization owner](LOCALIZATION.md), including for portaled controls. New layout rules use logical properties and mixed-direction technical values keep an explicit direction.
- Shared Button intent is explicit: neutral `default`, signature-red `primary` for the dominant Play/Install/Apply action, blue `selected`, and danger-semantic `destructive`. All retain the shared gold focus signal and 36px compact and 40px ordinary/large minimum heights. Dialog owns the semantic scrim without backdrop blur; Dialog and Select use logical positioning and spacing where direction matters.
- Graphite and warm controller-gray surfaces carry most of the interface. In the light theme, navigation is darker than the warm workspace and elevated surfaces are brighter. Blue means selected or interactive, yellow means keyboard/controller focus or rare emphasis, green means healthy or complete, and red is reserved for Portcove's signature and dangerous or critical action.
- Selected state and focus are deliberately different: shared selected buttons use blue fill and a bottom-line marker with a transparent border; destination and Settings category navigation use the fill and current-page semantics. A gold outline communicates the current keyboard or controller target independently. Selecting an ordinary control preserves its regular font weight and geometry; forced colors retain a visible state cue.
- Depth comes from borders, tonal steps, restrained inset treatment, and small shadows. Portcove does not use decorative gradients, glass, blur, neon glow, scanlines, or pixel-interface typography. Hero artwork uses the shared directional opacity mask solely to protect foreground readability.
- The bundled Geist variable font is the intended default interface typeface, with an intentional monospace stack for technical content and offline system/script fallbacks coordinated with #203. The desktop must not make a network request to render its interface.
- A second token interchange format is unnecessary while CSS has one runtime consumer. If a demonstrated second consumer later needs exchange, evaluate the then-current Design Tokens Community Group format without treating a community-group specification as a W3C Recommendation or manually maintaining competing CSS and JSON authorities.

## Component rules

Interface size is one profile-local whole-interface control in Appearance with
100/125/150/175/200/250/300/400 percent presets and Ctrl/Command plus/minus/zero.
It preserves the active library, drafts and browsing context. Below 42rem
effective width, a compact current-destination header and navigation sheet precede
the workspace in one vertical reading flow. The existing Commands trigger shares
that header without a second toolbar row or duplicate trigger. Keep task controls
in the workspace flow. [Theme ownership](THEME.md#whole-interface-enlargement-and-reflow) owns
the controller, persistence and native/browser evidence boundaries.

Game-port release channels display as **Stable / Preview / Rolling**. Current game-port CLI inputs prefer `stable` / `preview` / `rolling`; `beta` remains a compatibility alias for `preview`. Both Preview spellings select the same existing stream. Canonical JSON, catalog, installation and preference values remain `stable` / `beta` / `rolling`; no serialized `preview` value or saved-choice migration is introduced. Copied commands and integrations may retain `beta` when the intended CLI's Preview input support is unverified, preserving supported older consumers. Changing the spelling does not select a different release. Offered channels, the selected stream and the actual upstream release are separate facts. Preview prefers eligible prereleases and can fall back to an eligible stable release; that fallback does not acquire an upstream Beta/Alpha designation. Original upstream tags/names, application Public beta milestones, qualification evidence and compatibility limitations retain their own meaning.

- Import only controls demonstrated by current product needs. Checked-in controls should stay close to official composition, refs, events, and accessibility behavior; do not put a near-identical Portcove wrapper around every shadcn control.
- A specific Base UI control may be replaced when a reproducible Tauri, controller, accessibility, or supported-platform failure remains after bounded repair. Preserve the shared API, semantics, and theme where practical, record the evidence, and review the replacement independently; one incompatible control does not reopen the selected system.
- Controls use shared 36-pixel-equivalent compact and 40-pixel-equivalent ordinary/large minimum-height tokens and modest radius scale. Shared selects use these as minimum heights: option labels and selected decision text wrap within the available width, including long unbroken values, rather than clipping source requirements or relying on hover. Pills are reserved for compact status badges.
- Ordinary buttons are neutral by default. Signature-red Play, Install, or Apply emphasis is an explicit variant; destructive actions have distinct semantics, wording, placement, and confirmation behavior. Focus remains gold and visibly distinct from both selection and destructive intent, including the combined selected-and-focused state.
- Buttons name the action or review: `Review installation`, `Play`, `Check game files`, and `Remove managed files`. Avoid `Submit`, `Proceed`, `Execute`, `Yes`, and `No` when the action can be named.
- Setup and launch controls consume the current core action availability and supplied reason. A scoped hold or unoffered managed setup route has a readable explanation instead of an enabled installation review; source and BIOS input keep their existing selection/review flow. Installed launch still requires positive core readiness, and a retained-definition hold explains its exact reason. Missing legacy action projections keep the existing readiness behavior; malformed or incomplete current projections do not enable an action. An existing review can still be dismissed during a hold, and owned-operation cancellation stays reachable. A later allowed snapshot can restore the control, but preview and presentation never authorize execution: core rechecks current inputs under its existing guards.
- Every control needs deliberate default, hover, focus, pressed, selected, disabled, and loading treatment where those states apply. Geometry must remain stable across those states, transitions must name intentional properties rather than use `transition-all`, and forced-colors presentation must retain visible system-compatible outlines, borders, and meaning.
- Icons come from Lucide through the shared `Icon` wrapper. An icon-only control must have an accessible name. Status never relies on icon or color alone.
- Dialogs trap focus, close with Escape, restore the initiating focus target, use a named heading, and reserve confirmations for destructive or difficult-to-reverse actions.
- External-installation folder choices and open reviews belong to the selected game, library generation, and registration; a context change discards them, and late or superseded picker results cannot open a new review.
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
- Browsing query/search/sort inputs also survive restart through versioned optional local view preferences, keyed by the supplied canonical library root with the existing Windows namespace aliases. They contain no selected detail, source/BIOS/adoption inputs, review authorization or DOM focus/scroll. Runtime position continuity retains its existing owner. Unsupported query predicates and legacy identifiers remain unresolved for explicit filter correction; unreadable, future-format or oversized preference documents are retained until the player explicitly saves current choices. Storage failure is visible and does not block ordinary browsing or library switching. This persistence does not provide coherent route/build matching or additional filter controls.
- Reserve artwork and card geometry; retain useful existing content during refresh; keep loading, missing-artwork, failure, pending, and inline-confirmation states from shifting important controls. First paint uses the selected theme, application/window background, and offline typography without a bright flash or disruptive reflow.
- When late artwork feedback grows a Library card, retain focus on its current action and reveal it within the actual scrolling pane. Keyboard return from an overflow menu also reveals that exact action. The workspace reflow owner observes the focused card; it does not move focus, override an open overlay, or pull back an action the player intentionally scrolled away from. Leading-workspace feedback keeps its existing continuity behavior.
- Acknowledge an action promptly without inventing its outcome. Copy confirmation is local; launch distinguishes accepted, starting, running when authoritative, and failure; install/update uses real stages or an honest indeterminate state; cancellation distinguishes requested from stopped; integration results distinguish core success from optional partial failure. The existing operation/event authority owns progress and durable outcomes, while toasts remain supplemental.
- Catalog completion identifies the applied update, restored catalog, selected source or publisher trust change. Relocation results display the supplied retained and pending-cleanup folder paths without deletion advice. Retained logs explain available saved output independently of the operation outcome. Digest copy announces success or failure and offers the exact selectable value on failure; an older attempt cannot replace current feedback. Zero-total progress retains the concrete action and indeterminate state without an absent-telemetry sentence or fabricated percentage.
- Command-palette query changes choose the best eligible result predictably, background refresh preserves the active command by stable identity where possible, and Enter during IME composition never executes a command.
- Command-palette pointer movement, option focus and direct clicks remain usable alongside keyboard selection. A popup appearing beneath a stationary pointer must not replace the command selected with the arrow keys.
- Artwork remains legible and stable across bright, dark, white, missing, unusual-aspect, and long-title cases. Optional artwork failure does not become launch failure, and essential actions never depend on imagery.
- Optical review covers icon/label alignment, tabular numerals where values change or align in columns, consistent dialog geometry, subordinate shortcut hints, long-path identification and exact copying, and reduced nested-card emphasis. Essential instructions and warnings never exist only in a tooltip or browser title.
- Shared review dialogs permit long path and identifier text to wrap anywhere when space requires it, including inline values in consequence paragraphs. Preserve the complete selectable value; do not hide horizontal overflow. Check real Windows paths spanning several directory names at 240px and 320px effective widths as well as ordinary windows: hyphenated or Unicode-only samples can introduce break opportunities that mask failures.
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

The [glossary](../GLOSSARY.md) owns domain meanings and the
[content-design contract](CONTENT-DESIGN.md) owns task wording, verification
claims, state distinctions, actions, errors and formatting. This table maps
those meanings to interface contexts; the specific compositions below retain
their existing behavior.

| Term                         | Meaning                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port                         | One independently identified native implementation or catalog integration; several ports can implement the same game.                                                                                                                    |
| Library                      | The selected library's records and managed content, including installed, external and retained unfinished-setup entries.                                                                                                                 |
| Port catalog                 | Available port definitions; inclusion alone does not establish qualification, current readiness or permission to operate.                                                                                                                |
| Game files / source          | Original inputs required by a route. Name the ROM, disc image or file set when relevant. A remembered external location, managed copy and authorized Move have different consequences; a file check does not establish legal provenance. |
| BIOS                         | A separately modeled firmware requirement. It is not called a game source in recovery copy.                                                                                                                                              |
| Release channel              | Stable, Preview (`beta`), or Rolling stream selected per port; separate from catalog designation and test evidence.                                                                                                                      |
| Update policy                | Notify, stage, or automatically install for one managed port. A saved preference is not a completed update.                                                                                                                              |
| Staged release               | A downloaded/checked release retained locally for later activation. Activation still needs the current Core checks.                                                                                                                      |
| Active version               | The managed version currently selected for launch, subject to current launch checks.                                                                                                                                                     |
| Saved data / persistent data | The port's declared saves, settings and other persistent files. Describe the actual catalog and operation scope rather than promising all player files.                                                                                  |
| Backup                       | A recorded snapshot of the selected managed saved-data scope. Name the content checks actually performed; a snapshot alone is not an exercised restore.                                                                                  |
| Build or setup               | Use the precise upstream operation. Do not call every install a build or every first launch a compile.                                                                                                                                   |

GUI labels should match the CLI concepts. A GUI action that external tools may automate should expose its canonical `portcove` command where practical.

### Public beta writing and terminology

Show Portcove's name without a promotional sidebar subtitle. Use **About Portcove**
for the About heading. When a functional description helps, use “Install, update,
and play native game ports.” Do not use harbor-themed slogans for Portcove.
Describe individual installation routes and limitations at their own controls;
the product description does not promise every port automatic installation,
updates, or backups.

The [glossary](../GLOSSARY.md) defines concepts and preferred player wording;
[content design](CONTENT-DESIGN.md) owns shared communication and evidence rules.
This section records actual interface labels and compositions rather than a
second glossary. Use **game** for play-oriented tasks, **port / port project**
for implementations and **installation** for a particular local copy, including
an existing registered runtime. Counts follow the actual result unit.

| Surface / next action                | Interface wording                                                     | Condition                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main navigation                      | Library / Discover / Activity / Settings                              | Activity contains Tasks / Game updates / History.                                                                                                                  |
| Game-detail navigation               | Overview / Game files / Saves & backups / Versions & updates / Manage | Preserve the destination's actual contents and existing focus/navigation owner.                                                                                    |
| Return from details                  | Back to Library / Back to Discover / Back to Add games                | Use the captured destination; unknown destinations use Back.                                                                                                       |
| Original-input location              | Saved file location                                                   | A remembered path is not Files connected or a fresh check.                                                                                                         |
| Required setup                       | Needs game files / Setup needed / the supplied precise setup state    | Never override assessments or hard-code a port's permanent status.                                                                                                 |
| Launch into first-run configuration  | Launch to finish setup                                                | This action invokes launch; actual preparation execution can retain Start setup.                                                                                   |
| Installed-file check                 | Check installed files                                                 | Keep the actual full-immutable or launch-critical result scope.                                                                                                    |
| Immediate eligible saved-data backup | Back up now                                                           | The existing create assessment enables it; unknown/empty coverage does not.                                                                                        |
| Declared saved-data folder           | Open saved data folder                                                | The current scope can include saves, settings, bindings and applicable mods.                                                                                       |
| Activate a retained checked update   | Apply update · {version}                                              | Calls the existing activation owner; no new review step.                                                                                                           |
| Retained checked game update         | Update saved for later                                                | A checked staged record is present; it can reuse local bytes without a new download. Partial download/recovery and failed-check states remain distinct.            |
| Update notices                       | Pause update notices / Resume update notices / Skip this version      | Current scope is the selected Library and port; skip binds the exact version and artifact digest. It changes notices, not installed/staged files or update policy. |
| Library filtered empty state         | No matching library entries                                           | A Library result counts entries, including separate implementations of one game. Discover can use No matching games for its grouped results.                       |

**Saves and settings** names that data scope; **Saved data** covers broader declared
files. **Saves & backups** is the destination. **Steam shortcut** is the integration
object. **File details**, **Technical details** and **Test results** are distinct
supporting information, as defined by content design. Use ordinary “and” in prose
and retain approved compound destination labels.

Name a concrete action and object; say “Review” when review is actually next.
Place consequences before implementation detail and keep essential warnings
visible. Errors state the known cause, outcome, and realistic next action. Use
neutral activity names for running, failed, and completed tasks; the separate
status states the outcome. Activity summaries count the finished rows actually
shown and distinguish that preview from the history loaded by core. Put
interruption guidance inline, and describe older diagnostic availability as
possible when retention is not known.

Use **Activity** for the combined workspace, opening to **Tasks** with
separate **Game updates** and **History** sections. An available or saved update opens the existing
fresh Core review directly from its row.
Play is independent and uses the current version when Core permits launch.
Reviewing an immediate update defaults to installation; keeping it for later
requires a new download-only plan and confirmation. Neither choice changes the
saved update policy. A successful launch activity says **Process exited**, with
an explicit explanation that successful process termination does not establish
tested gameplay. Keep update and activity statuses in readable sentence case.

Details first offers Review game update without a disposition selector for an
unidentified candidate. Its first review retains the saved policy's current
default (automatic installs; other policies keep for later). Once Core supplies
the release, show its consequences and offer the alternate action through a new
reviewed plan. Switching action never reuses the previous plan's fingerprint.
Details labels matching saved checks as earlier observations, shows their update
version when available, and makes Check for updates primary when no available or
saved candidate is known. Manual review remains available as a secondary action.
The optional application-update choice notice uses a secondary review action;
ordinary first-use Add games remains the primary task.

Use **Check method** for a configured way to inspect game files; say whether a check
actually ran and what it found separately. Show the planned output folder with
version and download size when the installation plan downloads a release; a plan
that reuses a local release must not present the configured future output folder
as that release's existing path. File-health summaries describe the saved files'
current comparison state in plain language; keep saved checksums in File details
and do not equate unchanged bytes with a supported edition or launch readiness.
Game-file inspection reports lead with the identified game, current result, and
next action. Source-import reviews show the file requirement matched to the Core plan's profile,
its actual admission basis and limits, the selected/destination/currently saved
paths, checked-copy reuse when planned, and additional file-data bytes. Structural,
informational and upstream-validator admission do not imply an exact edition;
source admission is not installation or gameplay proof. Use-current-location is
not Portcove-copy reuse, and move may remove the original after verification and
registration even when an existing checked copy is reused. Planned bytes are not
a free-space guarantee. Unknown checks remain explicit and need a new review or
supported client before confirmation. Core plan binding and native consent remain
authoritative.
Admission, source authority, and test coverage stay in named
disclosures; assistive announcements report the actual result without claiming
that every check completed.
When a game-file search reaches a safety limit, name the limit and give a next
step that fits it. Show the submitted size and verification-work caps, and state when the
report does not identify the affected file.
In Game files settings, distinguish a library with no installed ports from
installed ports with no missing game-file requirements; neither state proves a
fresh file verification or launch readiness.
Use the saved update-policy choice verbatim in summaries. Separate an unchecked
port, a successful last check with no update, an available update, an update
saved for later whose activation still needs core checks, and a failed or
unavailable check result.
Checking for updates does not install them.
An operation's cancellation code or neutral tone does not prove a safe outcome.
The operation notice retains Core's committed, recovery-required or unknown
consequence, including unfamiliar or missing outcome values, through subsequent
readback failures. Only an explicitly not-started or no-change cancellation stays
quiet after successful readback. Dismissing a consequence repeats no operation
and grants no cleanup, restart or resume authority.
Use sentence case and neutral task names beside authoritative status. Complete
localized messages use named interpolation and correct plurals; human formatting
may follow locale while machine contracts remain stable. Keep technical detail
for the audience that needs it. The [content-design contract](CONTENT-DESIGN.md)
applies these rules across the documentation, CLI and interface.

When a general product explanation is useful, prefer: “Portcove handles
installation, updates, and saves for native game ports. Use its desktop app, or
connect another launcher through the command-line interface.” Use named projects
only where instructions and scoped status make the name useful.

The game-detail command card describes the command it actually generated.
`CliContinuity` uses **Launch from another app** and **Copy launch command** for
an active or registered external installation. The CLI checks that installation
before launch; the command does not install or update it. An uninstalled port
uses **Set up from the command line** and **Copy setup command** for managed
setup, which can download and install the selected release after checking its
required files. A user-prepared route instead uses **Copy folder-check command**:
the player prepares the required version, checks its folder, then reviews and
saves its location. Portcove does not download, copy, update, back up or delete
those external files.

The card shows the effective library and the command's PowerShell 7 or sh/bash
format. Missing inputs or an unresolved CLI executable produce **Copy command
template**, with the placeholders and executable prerequisite explained; this
is not a ready-to-run command. Separate program-path and argument-array fields
serve integrations that do not accept a shell string. Generation-bound command
details, retry, spaces, Unicode, escaping and invalid-path refusal retain their
existing component and command-builder contracts. These presentation boundaries
do not establish executable availability, platform qualification or successful
gameplay; [#206](https://github.com/boburning/portcove/issues/206) retains the
complete contextual-handoff acceptance.

## Shell and navigation

The stable desktop shell consists of primary port navigation, a scrollable workspace, contextual port details, and a predictable operation/error layer. Pages do not invent unrelated chrome. `Ctrl/Cmd+1–4` changes primary views, `Ctrl/Cmd+F` focuses the current searchable view, and `Ctrl/Cmd+K` opens the command palette. Unmodified slash has no application action. Context search does not redirect Settings or capture editable/IME input; explicit palette commands open Library or catalog search. Workspace shortcuts stay inactive behind a dialog.

When a game-file check identifies a specific host disc tool that needs attention,
its detail result links to that tool in Settings > Game Files. The route focuses
the available tool action, or the Disc tools heading if the named tool is no
longer listed. Other source problems stay with their local guidance.

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

Library and Catalog use responsive portrait grids. Each artwork frame is 2:3;
metadata adds height below the frame and never participates in its aspect ratio.
Whole-image fitting and Core fallback colors remain owned by `Artwork.module.css`.
Titles, status, descriptions, Favorites and supporting actions sit below artwork.
Directional navigation must reach the separate Favorite even when its hit region
sits within the larger Catalog card's bounds, and return to the card normally.
Long words wrap, filters can wrap, and the collection scrolls rather than shrinking
covers to fit a row count. The grid chooses columns from available width; a
reference composition's fixed frame width or column count is not a window rule.

The scrolling workspace fills the available window width. Library and Catalog
grids use that width to add columns as the window grows; the 1600x1000 reference
does not impose a maximum collection width or column count. Artwork is
bounded at 220 CSS pixels, or 160 pixels when the viewport is at most 680 pixels high;
tracks can shrink below their 180px preferred minimum (160px in short windows)
when the available width requires it. Library and Catalog share artwork geometry
independent of title/status height. Text enlargement reflows text around the bounds;
native WebView zoom enlarges the whole interface. Text-heavy workspaces retain a readable inner
content width; that content limit must not constrain the scrolling viewport or
leave an inactive scrolling area at the right of a wide window.
Catalog titles use the same two-line typography as Library, expanding at narrow reading widths;
the recognizable original-game title leads. A separate wrapping project row
follows it and precedes status. Relevant variants remain visible as wrapping
labels in the state area, with the full identity in the accessible card name
and details. Named collection-container queries expand text when its available
width is below 60rem, including enlarged root text, without changing
the artwork frame. Search matches the game, project, variant and stable port ID;
name sorting uses the game title. Matching game titles never combine cards.

Library uses Title A–Z only when no sort preference exists; explicit legacy Catalog
order and saved sorts remain available. Unreadable stored preferences retain Catalog
order for explicit recovery and are not replaced without an explicit save. Discover
retains Suggested order. Everyday
Library quick views compose existing query and favorites state; collection editing
and Hidden stay in the collection menu. Clear filters retains search; Reset view
states that it also clears search, quick views and collection selection. At compact
widths search occupies its own toolbar row.

Common filters use compact labeled checkbox popovers. Selection stays multi-select,
with OR within a category and AND across categories; route-dependent predicates
must still match the same observed route. Advanced filters and per-field help retain
technical semantics. Escape closes the active popover before the containing panel.

Repeated collection Play controls use neutral secondary emphasis. The selected-game
hero and Continue keep primary emphasis. Detail Back labels follow the captured
Library, Discover or active Add games origin; unknown origins use generic wording.
Card metadata supports two lines without
reserving blank lines on every short title. Detail uses current-state summaries and
compact management rows around existing operation/review owners. File paths never
establish file validation. Saves & backups distinguishes unknown/error history from
known empty history; Manage distinguishes installed paths from future defaults.
Update coverage, errors and unchecked state precede secondary statistics; version
arrows require both known installed and offered versions. Task records retain their
operation identity and diagnostics, with exact-operation recovery cross-links; no
records are grouped by game name or inferred installation identity.

Comparison separates original system, runtime targets and release channels, and
reports observed ownership. Feature comparison remains unavailable until the shared
catalog contract carries revalidated, sourced and dated claims. Presentation code
must not supply project-specific feature maps.

At enlarged text sizes the full application shell must reflow as well as the
cards. Header search and command controls may wrap onto separate rows; neither
may force horizontal workspace scrolling. The sidebar scrolls independently so
its lower actions remain reachable. Check the workspace's own overflow, not
only document overflow, because the workspace is a separate scroll container.
The maintained full-App browser fixture checks doubled root text at960×640 in
both themes, including About settings and preparation-dialog action reachability.
This is browser text-enlargement evidence, not an OS-scaling observation.

Long titles retain their complete accessible name and detail destination, and
expand at narrower viewports. Library titles open details. The footer keeps the
current Play/trial action or Review game alongside Favorite and the bounded menu;
it does not repeat a separate Details action. Detailed input reasons remain
available to assistive technology and on the game page rather than stretching a
card into a setup runbook.

Game details place title, readiness and the primary action in one compact summary.
Routine installed Play sits beside the title when space permits; setup and repair
keep the space required for their controls. File and filter diagnostics are an
optional disclosure below the primary action. Discover filters start with original
system, target OS, channel, port options and membership; advanced groups are disclosed on
request. Expansion is independent of filter selection, so clearing the last
advanced choice does not hide the focused control. Back restores the exact opener,
or the same game's stable title when successful repair replaces that opener.

The current account-free fallback is a core-owned style with a stable identity,
initials and palette per port and slot. Desktop renders a reviewed IGDB catalog
cover when mapped and no local image is chosen; other slots use the generated style.
Unavailable images render that style without inferring another title-based asset.
The source disclosure identifies
the Portcove generator and exact fallback identity without claiming third-party
artwork rights. If thumbnail transport or browser decoding fails after core resolves
a local import, the shared display cache switches every visible consumer and its source
disclosure to this generated fallback without changing the durable local choice.
Catalog-mapped covers keep imagery clear of provider labels. The existing details
source disclosure shows IGDB attribution and the reviewed source link.

Game details and Continue share a foreground identity composition: suitable verified
IGDB game logo, existing Cover choice, then a real text heading. Each role
prefers the exact port and only then an applicable original/edition; project identity
remains visible. Atmospheric landscape art and screenshots resolve independently.
Keep full natural proportions, reserve space while loading, constrain logo dimensions
and preserve headings/actions across failures. A cover fallback is a deliberate
portrait element, never a manufactured landscape or cropped logo. Read decoded
foreground suitability rather than trusting a non-null URL or alpha hint. Reassess
logo legibility on resize and advance the same fallback chain when necessary. Use a
deliberate contrasting logo stage when necessary without recoloring brand pixels. Expose image
provenance and rights through the shared credits disclosure.

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

The approved brand direction is an expressive 2D illustrated crab, custom `Portcove` wordmark, and simplified compact symbol using the original N64-inspired red, cobalt blue, emerald green, and golden yellow. [BRAND-ASSETS.md](BRAND-ASSETS.md) separates that target from the V2 raster assets still shipped. Brand art is deliberately rarer and more expressive than the restrained working interface: use it to establish identity at startup, in an empty library, or in About, not as wallpaper for operational controls. Game artwork remains separate and visually important.

## Approved Public beta redesign contract

[#917](https://github.com/boburning/portcove/issues/917) is the finite desktop
redesign, shared-control, visual-system, style-enforcement, and visual-acceptance
owner. It is an organizational child of #200; that parentage does not retarget
the broader workstream or make #200 closure a Public beta prerequisite. #917 itself remains a Required
Public beta outcome. #206 retains information
architecture, navigation, interaction, focus, content ordering, and domain-driven
presentation. #203 retains labels, localization, formatting, and safe unknowns.
#208 retains shared artwork selection/provenance/fallback/ingestion/cache, and
#527 retains SteamGridDB provider behavior before 1.0 during beta, not an initial
beta gate. #29 retains shared controller performance/navigation/focus/accessibility
for initial beta; #44 owns later actual Xbox qualification before 1.0. #47
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
The Library readiness rollup appears only when installations exist. It stays a
compact count and state line, shows setup and downloaded-update counts only when
actionable, and leaves game cards and their Play or Details actions as the main
visual targets.

Keep the sidebar stable and quiet: identity plus Library, Discover, Activity,
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
disclosure without becoming hidden safety state. Settings uses Appearance,
Library and storage, Game files, Updates, Integrations, Advanced, and About
categories. Wide layouts use an 11.875rem category column beside a reading column
bounded at 47.5rem. Below 65rem, navigation becomes one horizontally scrollable
category strip above the panel. Settings rows use open surfaces and dividing
rules rather than a surrounding card for every group. Category changes hide rather
than unmount panels, preserving unsaved drafts and pending operations; they do
not persist settings or cancel work. Focus the selected heading and reveal its
outline below any sticky category strip, using the existing workspace scroll owner
only as far as needed. Direct
recovery links select the owning category before focusing its relevant control.
The sidebar About entry opens About directly. Updates explains application/game
updates and the bundled game catalog; optional custom catalog trust controls
belong under Advanced. Category selection is ephemeral presentation state.
Recovery items expose read-only navigation beside their collapsed recorded
locations: setup opens the game, missing installations and backup problems open
Saves and storage, and unfinished operations reveal their exact loaded activity
or game details when its activity is not loaded. A selected older activity stays visible beyond the
short history and receives focus. Orphaned folders and unavailable game identities
lead to Library and storage; they do not infer ownership or enable deletion.
Unknown recovery kinds retain details without an action. Navigation never resumes,
removes or retries work; retained setup cleanup keeps its fresh Core preview and
explicit confirmation.
In GitHub settings, lead with connection purpose and signed-in state; keep
credential provenance and request accounting in Connection details. Token entry
has a persistent visible label, while environment-controlled credentials keep
their outside-Portcove recovery instructions. An unavailable connection-status
read must not appear as an anonymous sign-in result.
Disc-tool recovery leads with the tool name, missing or invalid state, and a
working Locate or retry action. Keep executable paths, configuration variables,
and discovery provenance in Tool details; an environment override cannot be
replaced by a saved path inside Portcove.

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

Preparation presents game/port identity, the next step and existing Core-reviewed
consequences beside the enabled review action. A managed setup does not lead with
a disabled Play placeholder. Requirement fields remain in their dedicated group;
missing-file recovery stays ahead of preparation when inputs are unavailable.
After confirmed preparation, the current detail owner returns focus to enabled
confirmed Play or its next-step heading. Unconfirmed compatibility keeps Try launch
available but returns completion focus to the heading; Start setup is not a confirmed
Play target either. Library-generation/owner replacement and deliberate
focus elsewhere suppress that deferred handoff.

Startup recovery places a specific interrupted Move or restore before generic
retry/library choices, naming the original or destination folder and preserved
copies. Only host/Core-supported recovery actions appear. While recovery or a
library choice is settling, competing recovery, reload and selection controls are
disabled; failure restores usable choices. This changes presentation and local
exclusion, never transfer authority or resume eligibility.

Run the focused frontend tests, applicable theme/style contracts and production
build before accepting a design-system change. The style gates must cover the
actual Tailwind CSS and JSX utility sources, reject raw status colors and direct
primitive consumption, preserve dark/light, focus/selection, contrast,
reduced-motion and production-variant coverage, and handle third-party directives
narrowly rather than with blanket exemptions. Acceptance records intentional
reference changes and verifies that each migrated surface has one remaining
control/style owner.

For substantial styling changes, use advisory `just fallow-css` to investigate
token drift, duplicate declarations, selector complexity and unused-style
candidates. Check static candidates against runtime semantic variables, Tailwind
theme/utility generation, conditional classes, CSS Modules and Base UI states.
Verify consumers before deleting styles; a score cannot establish appearance or
interaction correctness. Use `just fallow-review BASE` when the change also needs
JS/TS ownership or complexity review. Neither route adds a mandatory ordinary
PR stage. When explicit whole-Desktop qualification is selected, Fallow retains
its check-finding and critical-complexity protections; aggregate duplication is
advisory under #1105, with duplicate groups available for responsibility review.
See [the scope and policy mapping](reference/quality-operations.md#fallow-scopes-and-policy).

The three early finished reference compositions are Library, the game-details workspace, and a complex installation-review dialog with nested selection and errors. Their real-component scenarios cover empty, loading, long-title, missing-artwork, disabled, error, interrupted, and narrow-layout states. Completion requires both themes, current minimum/default/large sizes, 1280×800 where relevant, supported scaling, long text, keyboard/mouse/controller behavior, nested overlays, focus return, async changes, navigation during work, reduced motion, and capability parity. Browser fixtures and screenshots do not replace native or intrinsically human evidence.

Keep scenario evidence attached to its actual consumer boundary. The development
previews in `dev-scenarios/entry.ts` render inert component markup for shape and
copy; they do not exercise interaction, focus, controller input, IPC or packaged
behavior. Interactive browser tests such as `browser/adoption.browser.test.tsx`
exercise real React controls with mocked transport, not Core installation or
persistence. Native scenarios registered in `scripts/desktop-scenarios.mts`
require their guarded execution and retained receipt: registration alone is not
a pass. A selected-setup Tauri/Core fixture can establish its observed review,
cancel, result and return sequence only for the recorded source, platform and
inputs. It does not establish Play, gameplay, other platforms or human/device
observations. Keep changing journey gaps and their canonical owners in #206 and
the owning issues rather than maintaining a second backlog here.

### Library recovery composition

Storage capacity, recovery and startup library selection are separate Settings
rows. Recovery has a disclosed three-step manual-copy guide, then independently
labeled Restore and Change library location actions. Preserve exact LTR-isolated paths and six
current export content categories. Export success acknowledges metadata only;
manual copy remains unverified until corresponding restore observations succeed.
Use existing reviewed backup/import controls and native restore consent. Do not
introduce a progress bar, checkbox, success badge or automatic-copy implication
for work the application did not perform.

### Add games composition

The genuine first-use Library omits collection layout, sorting and filter tools
until there is content or a browsing constraint to operate on. Keep its mascot
compact (4rem) and Add games visible at the supported minimum window, including
the initial application-update choice notice. Filtered no-results retains its
reset and filtering controls; hiding first-use tools must not clear preferences.

Library's heading Add games action and empty-state primary action open the
same in-flow workspace. Keep source choice, current port identity and the next
review action together. Start with three intentions: choose a game or port,
find games in a folder, or use an existing installation. Show only the selected
route's actual inputs and requirements. Files are checked against an explicitly
selected port; folder search supplies bounded recognition. Retain ambiguous/unsupported and
unknown evidence in existing review treatments. Detail/setup completion uses the
shared primary/recovery and focus contracts. Save drafts during normal navigation;
opening another destination must not imply cancellation or task completion.

### Discover artwork and identity

Catalog cards retain their own browsing filters, sort and route semantics. Whole
cover images use Library's centered 2:3 frame and semantic neutral padding.
Artwork size is independent of title/status height, with the shared short-window bound. Missing artwork uses the same
quiet game symbol as Library and Detail. Do not infer crop bounds or replace
provider/user-selected artwork. Titles and project/variant identity follow the
frame without reserving three empty title lines. The existing card activation
and keyboard return still target the exact port, not its shared original title.
Neighboring Discover cards share identity, metadata, observation and action bands
through a row subgrid; long identity or status text does not shift one card's
actions into another card's metadata band. Artwork remains contained and bounded
independently of that text.

### Game-data preparation review

The preparation review names the selected game/port and presents the installed
version, exact installed folder and selected original-file path as labeled facts
from the returned plan. Keep space, activation, preserved-data, interruption and
external setup-window consequences in the same scrolling review before its
explicit confirmation. Initial focus belongs to the review heading so compact
and enlarged windows begin with identity and inputs; keyboard navigation reaches
the confirmation and cancellation controls in document order. Cancellation and
completion keep the existing context-bound return-focus owner.

Preparation completion reports that game data is prepared. It does not grant
launch availability: the refreshed Core readiness and existing current-action
projection determine Play or the next required step. Package installation,
preparation and external-folder registration remain separate operations.

### Review and retained-operation identity

A source-import review belongs to its source profile, current inputs and returned
plan fingerprint. Cancelling Move grants no approval to a later review and does
not affect another game's preparation eligibility. Production Move obtains its
own native confirmation; the reference prototype's checkbox is not a second
production consent owner.

Activity recovery reads the retained operation ID and paths from the current
Core repair report and cleanup preview. Opening or completing another game's
preparation must not relabel the retained port or substitute its source, working
folder, installation, saved-data, backup or log locations. Keep files dismisses
the cleanup review without changing that retained item. Cleanup remains bound
to its own operation, generation and accepted preview fingerprint.

### Library identity and artwork feedback

The details control contains the game title and Port: project label with an explicit text boundary. Its accessible name includes both visible labels. Missing Library artwork uses a non-text game symbol; artwork availability/staleness messages sit outside the button in entry feedback. Decorative monograms and changing artwork notices must not become omitted or unstable words in a control's visible label. Other artwork consumers retain their existing presentation. ArtworkFrame owns fitting/fallback rendering; the collection retains the same visibility-gated artwork request and one cache subscription.

Restore review inventories the supplied content and destination; an existing empty folder can be planned. Review does not verify a complete recovery copy. Execution verifies recorded installed payloads before publication; manual copying and unrecorded external content remain independently unverified.

## Task composition and navigation

The four persistent destinations are Library, Discover, Activity and Settings.
Add games owns the game/port, folder-search and existing-installation intentions;
copy is an explicit action inside the last route. About remains a Settings
category. Commands and its shortcut remain a quiet secondary control. Navigation
help is a disclosure, expanded for a connected controller. Category panels stay
mounted to preserve drafts; tighter shared Settings rows reduce repeated hierarchy.

Detail starts with compact identity, state and its current action, followed by
the installation and requirements. Current update decisions and saves/storage
precede project background and diagnostics. Catalog identity wraps in full and
installation version labels explicitly say Installed or External installation.

Preparation groups Files used, What changes and During setup. Running preparation,
managed installation and game-update observation can be left with Continue browsing;
this is distinct from task cancellation. Focus returns to a connected contextual
action region when the review trigger is disabled. The application invocation
owner survives navigation. Only its owned API channel may bind an operation ID;
global events cannot assign that identity. Exact terminal Activity readback retires
late progress, even when it precedes the first channel event.

Game updates expose direct Update now and Download for later entry actions;
Prepare for later remains an advanced choice. Each action requests the existing
Core plan before confirmation or execution. Compact mode and future update policy
do not choose the current action. Initial controls remain mounted while review
hides them, so cancellation restores the actual initiating control when available;
a connected contextual region is the fallback. Changing disposition inside review
re-plans before confirmation; a downloaded update remains
separate from the current playable installation. Without an observed candidate,
Check for updates is the entry point. Shared invocation feedback owns execution
failures; a quiet, unchanged cancellation can remain local without duplicating an
error banner.

Activity groups authoritative attention IDs, running records and recent outcomes.
Target identity leads each row. Unfinished setup opens a read-only file account;
Review cleanup opens a separate, freshly loaded operation/generation-bound plan.
Only that review offers deletion or record removal and its native final approval.
Full locations, exclusions and interruption consequences remain readable.

Consequential game reviews repeat the full game/project/variant identity from
`port-identity.ts` inside the dialog. This presentation does not replace stable
IDs, reviewed fingerprints, generations or native consent. Backup reviews also
retain the snapshot date and Core-provided port name.

A current healthy backup read has a quiet refresh action, without a warning box.
Pending reads are neutral; failed reads preserve the earlier list and describe
its uncertainty. Saved-data scope sits beside backup controls; creation checks
the managed folder. Installed saved-data paths are not exposed
in this projection: every installed version follows its recorded rules, so
current catalog paths must not substitute for its installed contract. There is
no backup-creation review; restore and deletion have their own reviews. External
saved data remains outside managed backups.

Retained-setup inspection leads with the working object, completeness uncertainty
and supported next step. Secondary installation/source/saves/backup/log locations
are disclosed on demand. The separate cleanup review exposes all preserved
locations before confirmation and obtains a fresh operation-bound preview.
Routine no-results and secondary Settings sections use their ordinary headings,
reserving warning treatments for actual problems.

Change library location means copy, verify and switch, with the old copy retained.
Its confirmation is Copy and switch. Save backups, metadata export, manual recovery
copy and checked restore remain distinct. The full manual-copy and credential
instructions stay available. Startup recovery has its own viewport scroll owner,
including at enlargement, because the ordinary application shell may be unavailable.

## Read-only diagnostics

`components/ui/read-only-text-field.tsx` owns the shared read-only field used by
error-detail manual-copy fallback and Activity's retained output, error and
manual-copy fields. Its label and exact value come from the feature. Technical values use isolated left-to-right direction and the existing monospace role, including inside an RTL workspace. The field
uses semantic inset/input/text roles and the shared focus treatment, wraps long
content within the available width, and allows vertical resize and scrolling.
Its 80–384px equivalent height bounds preserve access to long output without
expanding the whole task; text remains selectable with keyboard or pointer.

Features retain lazy capture, redaction, request/generation guards, clipboard
outcomes and announcements. The primitive does not fetch, redact, copy or store
diagnostics. Existing failure and Activity semantics remain authoritative.

Saved-file verification failures use a contextual check message. Keep Core error code, mutation metadata and diagnostic context in collapsed technical details, but do not project generic preparation or mutation-outcome claims into the ordinary saved-file check. Current inspection results and reconnect/relink guidance remain separately visible; pending, cancelled and unavailable inspection states retain their own contracts. This presentation rule does not change Core error authority or claim database-byte immutability.

Setup review facts and startup recovery share `styles/journeys.css`. File inputs,
computed space, activation consequences and retained work stay visible; diagnostic
and external-window guidance remains secondary. Startup recovery groups only the
actual unfinished library operation, preserves its unknown outcome and keeps
retry, library selection and support-bundle paths available.

Game files lead with the current file state and next action, followed by the
existing requirements/input controls. File-matching evidence is one inline
advanced disclosure. Saves lead with the authoritative backup-coverage result,
known location and backup actions; exclusions and history stay visible. Manage
keeps one ownership/path summary and puts future-install choices after its
regular action rows.

Activity recovery uses flat linked rows with recorded paths and guidance behind
each row's disclosure. Recovery observations remain separate from task records;
links use a real operation reference when one is available. Failed/unfinished
outcomes and cancellation settlement remain visible on task rows. Operation IDs
and retained preparation logs share Task details; they do not compete with the
next action or hide mutation/uncertainty summaries.

Port comparison shares `styles/comparison.css`: a concise evidence status, one
optional settings disclosure and aligned project facts/actions. Exact artifact,
freshness, file health and evidence provenance remain in each project's existing
explanation. Advisory context remains distinct from setup/launch checks, and
shared compatibility cautions are stated once rather than repeated on every card.

## Prototype presentation alignment

The October 29 pass retains the v58-based prototype’s graphite hierarchy: quiet
canvas, slightly raised panels, restrained dividers, readable secondary text and
a blue selected navigation edge. The shared control and typography tokens apply
to Library, Discover, details, Activity, Settings and dialogs; light theme remains
an independently readable palette, not an inverted screenshot.

Game detail identity prefers an admitted exact-port logo, then an applicable
original-game logo, then the existing cover and text fallback. Key art does not
precede that identity chain. Header and screenshot selection remain independent.
A logo sits above the game identity/actions; a cover retains its portrait column.
Supporting detail and settings text scales with interface size. No artwork or
prototype fixture creates readiness, launch history or operation eligibility.

### Prototype composition and production state

Overview uses a primary information column and a narrower Requirements/Project &
support column. Files and Versions follow the same responsive rhythm. Current
and downloaded/available versions are separate prominent values; retained update
observations never become current facts after a generation or installation change.
Backup journey counts require a current healthy inventory, and unavailable data
never becomes a zero count. Manage uses ruled rows and a separate destructive zone.

Activity embeds progress within task rows and uses open empty states while keeping
history completeness visible. Supplemental update explanations are disclosed;
current check coverage remains visible. Command groups are registry metadata, with
original keyboard order, disabled skipping and command dispatch unchanged.

Shared dialogs reserve heading and description space for Close. Shared empty
states use an open icon/title/body composition; informational notices use a quiet
surface and leading accent while warning/error semantics remain independent.
