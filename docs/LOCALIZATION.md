# Desktop localization

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

`ar-XB` remains an offline right-to-left engineering locale for Arabic plural categories, interpolation, safe rich text, logical layout, accessibility text, and direction changes. It is not a supported Arabic product language and cannot be newly selected in the production picker. A previously saved `ar-XB` choice remains visible only as a labeled preview so the current choice and direction are not hidden; the panel explains that the rest of Portcove remains in English. Development and native fixtures may still load `ar-XB` directly.

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

Unused-key removal is deliberately conservative. The extractor does not delete catalog entries automatically; remove a key only after searching runtime, tests, retained scenarios, and documentation examples. Broad screen migration and catalog expansion belong to [#203](https://github.com/boburning/portcove/issues/203), not this foundation.

## Qualification boundary

Unit and contract tests cover exact and fallback resolution, malformed and empty catalogs, missing-key presentation, plural selection, durable success and failure, live RTL direction, focus retention, and generated key checks. The selected `native-localization-foundation` scenario exercises the real Tauri Settings journey, host persistence, renderer reload, accessibility scan, RTL presentation, focus restoration, and absence of external network resources. Tauri's internal `tauri.localhost` asset origin and `ipc.localhost` bridge are explicitly local and remain allowed.

A current Windows or Linux native pass is evidence only for its recorded revision, artifact, OS, architecture, and embedded webview. It is not historical-minimum, packaged-build, Steam Deck, macOS, or publication qualification. Missing beta-critical platform evidence remains owned by [#993](https://github.com/boburning/portcove/issues/993); broader 1.0 qualification remains with [#45](https://github.com/boburning/portcove/issues/45). Development and merge of this non-publishing foundation do not authorize publication to an unqualified platform.
