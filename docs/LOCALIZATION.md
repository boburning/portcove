# Desktop localization

Saved-location impact distinguishes entry counts from game titles and includes
game/port identity for affected entries. The host resolves its own native-dialog
names. Full Unicode paths remain visible and wrap inline. A bounded native
summary points to the complete inline set instead of silently omitting entries.

Library distinguishes game title, port project/variant and library entry count.
Separate ports for one game remain separate entries. Search labels identify
Library or Discover. Covers/Compact rows preserve full identity; expanding
strings wrap without changing artwork proportions. Current update decisions stay
distinct from Future update preferences. These English labels add no supported
locale; engineering pseudo-locales remain tests.

Navigation copy is Library / Discover / Activity / Settings. Activity sections are Tasks, Game updates and History, as specified by the [current composition contract](INTEGRATED-UI-DESIGN.md) and [design system](DESIGN-SYSTEM.md#activity-and-contextual-task-feedback). These display labels do not rename serialized route IDs. Contextual task messages must retain complete action and target identity; an operation ID is not translated or inferred from a display name. English remains the supported product language; engineering locales do not become release commitments through this presentation change. Preserve the existing bounded namespace-migration scope below.

Game-port release channels display as **Stable / Preview / Rolling**. Current game-port CLI inputs prefer `stable` / `preview` / `rolling`; `beta` remains a compatibility alias for `preview`. Both Preview spellings select the same existing stream. Canonical JSON, catalog, installation and preference values remain `stable` / `beta` / `rolling`; no serialized `preview` value or saved-choice migration is introduced. Copied commands and integrations may retain `beta` when the intended CLI's Preview input support is unverified, preserving supported older consumers. Changing the spelling does not select a different release. Offered channels, the selected stream and the actual upstream release are separate facts. Preview prefers eligible prereleases and can fall back to an eligible stable release; that fallback does not acquire an upstream Beta/Alpha designation. Original upstream tags/names, application Public beta milestones, qualification evidence and compatibility limitations retain their own meaning.

Portcove's desktop localization foundation is an offline presentation concern. React owns translated copy and live direction; the Tauri adapter persists the user's optional locale choice through `HostPreferenceStore`. Core and CLI machine-readable output remain English and unchanged unless their owning contracts are revised separately.

## Selected stack and boundary

The foundation was implemented on 2026-09-22 with the exact registry packages below. All three are MIT licensed.

| Package         | Version | Runtime role                                                                         |
| --------------- | ------: | ------------------------------------------------------------------------------------ |
| `i18next`       |  26.4.2 | Offline resource lookup, fallback, interpolation, plural rules, and language changes |
| `react-i18next` | 17.0.15 | React provider, hooks, and safe rich-text composition                                |
| `i18next-cli`   |  1.74.1 | Development-only extraction, status, lint, and generated TypeScript contracts        |

The official CLI requires Node 22 or newer. It is a development dependency and is absent from production bundles. A bounded Lingui comparison confirmed that it also met the current React and Node floor, but its additional compile and macro layer did not improve this small offline foundation enough to reverse the approved i18next direction. This is not an invitation to repeat the framework comparison during screen migration.

Using Vite's production report from the unchanged pre-foundation checkpoint, JavaScript moved from 734.78 kB raw / 221.61 kB gzip to 801.27 kB raw / 243.94 kB gzip after the runtime, catalogs, and representative setting were added. CSS remained 108.27 kB raw / 18.72 kB gzip. The reported JavaScript delta is 66.49 kB raw / 22.33 kB gzip; it is a bundle effect, not a startup, memory, or responsiveness claim.

`apps/desktop/src/locales/en` is the canonical source catalog. English is the supported Public beta display language. The production picker offers System default and English; System default resolves to English when the system language has no supported match. The panel reports the resolved display language rather than repeating the saved choice. A failed preference read uses the resolved fallback and reports a load failure separately from a rejected save.

`ar-XB` remains an offline right-to-left engineering locale for Arabic plural categories, interpolation, safe rich text, logical layout, accessibility text, and direction changes. It is not a supported Arabic product language and cannot be newly selected in the production picker. A previously saved `ar-XB` choice remains visible only as a labeled preview so the current choice and direction are not hidden; the panel explains that only the screens prepared for translation so far change and other screens remain in English. Development and native fixtures may still load `ar-XB` directly.

The bounded `counts` namespace also contains library-move, recovery, discovery,
output-relocation, navigation-update and determinate-progress messages. It is
bundled in English and falls back to that catalog in the engineering preview.
The existing i18next instance owns pluralization, zero overrides, named
interpolation and number formatting, including view-model calls outside React.
`countMessage` validates count availability only: missing, negative, fractional
and unsafe counts select explicit unavailable phrases. It accepts resource keys,
not inline message dictionaries. This adds no supported product language.

## Runtime ownership

- A saved `null` locale means `System default`; explicit supported values are canonical BCP 47 tags. Core validates bounded tag syntax but does not decide which product locales exist.
- The React resolver accepts an explicitly saved `ar-XB` preference and the English language family. Unsupported, malformed, missing, or removed locales safely resolve to English. System locales, including `ar-XB`, do not select the engineering preview.
- The provider updates i18next, `html[lang]`, `html[dir]`, and Base UI's `DirectionProvider` together. It does not key or remount the application, so a live change retains screen state and focus.
- A selection becomes active only after the host preference write succeeds. A rejected write leaves the previous locale active and reports failure rather than showing false success.
- Resources are static imports. No locale path, remote service, dynamic script, CSP exception, permission, or network access is added.

## Catalog authoring

Use feature-owned namespaces and semantic keys: `settings:language.saveFailed`, not English sentences as identifiers. Keep technical identifiers, paths, checksums, commands, and product names in logical-direction containers when they appear inside translated copy.

Write complete messages. Do not concatenate translated fragments or attach punctuation outside a translation. Use named interpolation for values, i18next plural forms for counts, and `Trans` only with an explicit component map for limited semantic markup. Never insert translated HTML or use `dangerouslySetInnerHTML`.

Context and glossary rules:

- `library` means the Portcove-managed root, not a storefront collection.
- `source` means user-selected original game files; it is not an install or download.
- `release` is a port release; `version` is an installed or available version.
- `remove` and `delete` must retain their existing data-safety distinction.
- Prefer a context variant when grammar changes by role or gender; do not encode presentation position in a key.

Add English first, add every engineering-locale form needed by that message, then run `pnpm --dir apps/desktop i18n:check`. The gate uses the official CLI to reject catalog drift, missing translations, hardcoded copy in the migrated component, unknown keys, and missing or extra interpolation arguments. Generated declarations are checked in so TypeScript also rejects unknown keys. The negative fixture runs against disposable catalog copies because `i18next-cli extract --ci` reports drift after writing its configured output.

## Spanish pilot draft

The owner selected Spanish as the [#1028](https://github.com/boburning/portcove/issues/1028)
pilot. `apps/desktop/src/locales/es` holds an **unreviewed agent draft** for
every migrated namespace. Its tag is region-neutral `es` until the reviewer
confirms or narrows the region. The draft is bundled offline for review and
engineering fixtures only. `resolveLocale` never selects it, the picker does not
offer it, and no supported or partial Spanish language is claimed.

Spanish plurals use the CLDR `one`, `many` and `other` categories. The draft
reuses `other` text for `many`. Draft glossary for the reviewer:

| English             | Draft Spanish                  | Note                                                   |
| ------------------- | ------------------------------ | ------------------------------------------------------ |
| port                | adaptación                     | product noun; game and project names stay untranslated |
| library             | biblioteca                     | the Portcove-managed root                              |
| saved file location | ubicación de archivos guardada | user-selected original files                           |
| listing             | ficha                          | catalog listing                                        |
| publisher           | editor                         | signed-catalog publisher                               |
| Stable / Preview    | Estable / Vista previa         | channel display names                                  |
| Settings / Activity | Ajustes / Actividad            | navigation names                                       |

Review destructive, trust, update, credential and recovery wording first
(`removal`, `catalogUpdates.custom`, `applicationUpdate`). Record the reviewer,
their competence, the reviewed catalog revision and the scope on #1028.
Changing the meaning of a reviewed message invalidates that review. The locale
becomes selectable only after linguistic sign-off and critical-journey evidence,
and only at the then-current migrated coverage, with visible English fallback
for unmigrated screens.

## Migration inventory

`extract.input` in `apps/desktop/i18next.config.ts` is the enforced inventory of
migrated first-party surfaces. Listing a file there makes `i18n:check` reject new
hardcoded copy, catalog drift and unknown keys in it; there is no second registry.
`localization.tsx` is the exception: it is in `lint.ignore` because it owns
locale names and fallback plumbing, so it receives extraction and key checks only.
Migrate a complete surface before listing it, and keep English output identical
unless the copy change is intended and reviewed.

| Surface                                  | Files                                                      | Namespace           |
| ---------------------------------------- | ---------------------------------------------------------- | ------------------- |
| Language settings                        | `components/LanguageSettings.tsx`, `localization.tsx`      | `settings`          |
| Startup render recovery                  | `ErrorBoundary.tsx`                                        | `shell`             |
| Interface size                           | `InterfaceSize.tsx`                                        | `shell`             |
| Application-update notices               | `features/application-update/ApplicationUpdateNotices.tsx` | `applicationUpdate` |
| Application-update settings              | `features/application-update/ApplicationUpdates.tsx`       | `applicationUpdate` |
| Official setup information               | `components/OfficialDefinitionUpdates.tsx`                 | `catalogUpdates`    |
| Official catalog updates                 | `components/OfficialCatalogUpdates.tsx`                    | `catalogUpdates`    |
| Custom catalog sources and game listings | `components/CatalogUpdates.tsx`                            | `catalogUpdates`    |
| Uninstall review                         | `components/RemovalReview.tsx`                             | `removal`           |
| Saved file location removal              | `components/SourceRemoval.tsx`                             | `removal`           |

Remaining scope is measured with the same linter over every non-test source file
(temporarily setting `extract.input` to `src/**/*.{ts,tsx}`). On 2026-11-11 it
reported 1,628 findings in 79 of 208 analyzed files, measured after the
migrations listed above and with the attribute exclusions below. That count covers JSX text
and attributes only; English strings produced by `.ts` view models are additional
and are migrated with the surface that renders them. The count is a work
inventory, not a coverage claim.

Narrow technical-literal exclusions: the lint ignores the `aria-live`,
`aria-atomic`, `aria-describedby`, `aria-labelledby`, `data-settings-control`,
`data-slot`, `dir`, `intent`, `reviewSize`, `size`, `triggerId` and `variant`
attributes, which carry design-system tokens, element ids or ARIA references,
never player copy.
Thrown `Error` messages that are caught and never displayed, stable state codes,
keyboard key names and product names remain literals.

Migrated components call `useAppTranslation(namespace)` from `localization.tsx`.
It binds the hook to the module-initialized i18next instance, so a surface rendered
outside the provider, such as render recovery, shows complete English instead of
raw keys. The global instance is the only runtime i18next instance; a test or
fixture that mounts a separate instance does not reach these surfaces. Domain or controller state stores stable codes (for example the interface
size `unconfirmed` error), never translated text.

Component state stores message identities (busy, notice and failure kinds),
not English, so a live language change re-renders current copy. A Core or
upstream diagnostic stays verbatim as `text`. App-owned check failures throw a
typed error whose stable code drives presentation; its message serves
diagnostics only. Focus and test selectors use stable ids, never translated
`aria-label` text.

Copy helpers outside components take a parameter typed literally as
`TFunction<"namespace">`; the extractor does not resolve a type alias and would
file those keys under the default namespace.

Known limitation: Core reports catalog fallback reasons as English diagnostics
without stable codes, so `CatalogUpdates.tsx` still classifies their text to
choose a localized summary. The original diagnostic stays visible verbatim and
unknown reasons use a generic summary. Replacing this needs stable Core codes.

Operation names passed to the shared Activity owner and app-owned diagnostic
messages stay English for now, like Core diagnostics. Activity records a name
when an operation starts, so translating it there would freeze one language.
Those names will be localized when the Activity surface resolves them at render.

Channel-dependent messages use static i18next contexts (`readyBody_preview`,
`readyBody_stable`) at explicit call sites. A dynamic context would make the
extractor add a base key whose value is the raw key, and inserting a translated
channel name into a fixed sentence is not allowed.

Every migrated namespace has complete `ar-XB` engineering drafts so the gate's
status check stays at 100%. These drafts are engineering aids for direction,
formatting and plural evidence; they are not reviewed Arabic and add no supported
language. Percentages use `number(style: percent)` formatting, so digit shape and
sign placement follow the resolved locale.

Unused-key removal is deliberately conservative. The extractor does not delete catalog entries automatically; remove a key only after searching runtime, tests, retained scenarios, and documentation examples. Broad screen migration and catalog expansion belong to [#203](https://github.com/boburning/portcove/issues/203), not this foundation.

## Qualification boundary

Interface enlargement remains independent of language and library selection.
Its whole-WebView scale changes controls and text together; shared narrow layouts
must tolerate long labels and user text-spacing overrides without dropping
actions. English remains the supported language. A narrow layout or an engineering
pseudo-locale is not a phone-platform or translated-product commitment. Native
zoom, actual authored-content widths and enlarged-text/spacing checks retain
their separate evidence identities.

Unit and contract tests cover exact and fallback resolution, malformed and empty catalogs, missing-key presentation, plural selection, durable success and failure, live RTL direction, focus retention, and generated key checks. The selected `native-localization-foundation` scenario exercises the real Tauri Settings journey, host persistence, renderer reload, accessibility scan, RTL presentation, focus restoration, and absence of external network resources. Tauri's internal `tauri.localhost` asset origin and `ipc.localhost` bridge are explicitly local and remain allowed.

A current Windows or Linux native pass is evidence only for its recorded revision, artifact, OS, architecture, and embedded webview. It is not historical-minimum, packaged-build, Steam Deck, macOS, or publication qualification. [#993](https://github.com/boburning/portcove/issues/993) completed its amended initial-beta Windows/Linux stack and minimum acceptance on October 19, 2026; reuse its evidence only at the recorded source, artifact and environment scope. New candidates follow the [release qualification boundary](DELIVERY.md#first-public-beta-host-boundary). Full macOS qualification belongs to #45/#226 during beta before 1.0; Deck proof remains with #51/#217. Keep practical macOS build health and portable architecture without making absent Mac/device observations a beta gate. Development and merge of this non-publishing foundation do not authorize publication to an unqualified platform.

Guided library recovery strings distinguish metadata export, manually copied
content, verified restore and authority-changing Move. Content-root filenames are
literal code; surrounding explanations and entry labels are localizable. Unicode
paths retain their exact bytes with LTR isolation. No supported language is added.

Add games displays game and port identity independently of stable IDs. File-check
copy distinguishes a selected-port check from folder recognition; do not translate
an unknown or preliminary match into compatibility. Step labels describe phases,
not automatically completed milestones. Keep cancellation-request versus terminal
cancellation wording distinct. No supported language is added.
