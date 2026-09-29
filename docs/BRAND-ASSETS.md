# Portcove brand assets

Portcove is the same crab-led identity, illustrated in 2D. The approved direction replaces low-poly 3D construction as the requirement for **future** artwork; it does not approve a new production asset set. Until separately approved standalone artwork is delivered and integrated, the V2 images, app icons, runtime references, manifests, and their integrity checks remain the shipped identity. The [historical V1/V2 construction record](archive/2026-09-29-brand-assets-v2-historical.md) preserves earlier approvals, prompts, measurements, hashes, and provenance as evidence for those assets, not instructions to build the 2D successor.

## Approved 2D direction

The crab should read as expressive, friendly, slightly mischievous, and self-assured: a compact body, substantial claws, a clear silhouette, and confident dark outlines. Use bold flat fills, limited internal detail, and intentional hand-drawn irregularity. The result should feel like an independent comic or small game studio. Draw for 2D rather than tracing or flattening the 3D model. Avoid corporate flat illustration, preschool styling, seafood-restaurant cues, aggressive esports badges, extrusion, modeled lighting, bevels, gloss, gradients, faceted shading, obligatory noise, and simulated low-resolution filtering.

Keep the established character color ownership as a continuity reference, allowing illustrative proportion and expression changes:

- Red shell, eye housings, arms, and walking legs.
- Cobalt-blue primary claw masses and useful eye detail.
- Golden-yellow belly, outer claw accents, and spike tips.
- Emerald-green side-spike accents.
- Warm white and dark neutrals for eyes, grin, and outlines.

Keep paired features coherent. A raised claw or asymmetric expression is welcome when it remains anatomically clear. The historical V2 front and turnaround images are visual references for identity and color placement, not geometry, camera, lid-control, limb-ratio, or pose requirements for the illustrator. No hats, controllers, cartridges, scenery, seaweed, starfish, or other props belong in the core identity. Do not imitate Nintendo lettering or imply affiliation.

Use the exact product name **Portcove** in new artwork as well as prose. Develop custom illustrated lettering and crab art as one family, while making each usable independently. The wordmark can be playful and confident without inheriting V2 extrusion, face-plane colors, an oversized internal `C`, or a perspective underline. The historical `PortCove` spelling belongs only to retained V1/V2 records and files.

The identity has three roles: a standalone wordmark, a full-character mascot, and a deliberately simplified compact crab symbol. The compact symbol must remain readable at small sizes rather than shrinking the full-body pose. Do not add a `PC` monogram. Supply a genuinely single-ink version with one solid color, not multiple tonal shades labeled monochrome.

## Palette and interface relationship

The canonical N64-inspired 500-stop anchors in [`apps/desktop/src/styles.css`](../apps/desktop/src/styles.css) are red `#E23B32`, cobalt blue `#2D5DA8`, emerald green `#27995B`, and golden yellow `#F2C94C`. Retain their existing scales, neutrals, and semantic mappings; historical shaded raster pixels need not equal these anchors. The four colors may appear across the family without equal area or all four in every file. Do not sample replacements from concept images or recolor interface tokens to match an illustration.

The desktop remains a restrained, functional workspace on graphite and warm-light neutral surfaces. Blue signals selection, gold keyboard/controller focus, green success, and red signature or destructive meanings through distinct semantics and labels. [Design system](DESIGN-SYSTEM.md) and [theme](THEME.md) govern UI styling. Brand art is selective: the full mascot belongs at appropriate welcome, empty-library, and About placements; the compact symbol belongs in small identity placements; the wordmark belongs where it has room. Keep technical failures and ordinary dialogs clear of decorative mascot art. Game-cover and catalog artwork have separate ownership.

The established functional description remains `Install, update, and play native game ports.` Do not invent a slogan or import concept-board navigation, controls, sample games, serif headings, macOS window chrome, or decorative marks into normal controls. Concept images establish direction only; they are not production masters, creator attribution, or asset approval. A directional board was described in the 2026-09-29 brief, but no inspectable board image was attached to this checkout.

## Artist handoff and production gate

**Audience and personality.** Players of native game ports should recognize Portcove immediately. Aim for a bold, personable small-studio identity that feels capable and a little mischievous, while keeping the working application clear and trustworthy.

**Continuity references.** Use the preserved V1/V2 sources and approved V2 front/wordmark/compact-head assets to understand silhouette, expression, paired color logic, and recognizable rhythm. The [historical record](archive/2026-09-29-brand-assets-v2-historical.md) explains their provenance. It does not prescribe 3D construction. The red/blue/green/yellow concept board, if supplied to the artist, is directional; inconsistent claw or leg colors and a cream replacement for the gold belly are not approved.

**Minimum deliverables.**

1. One primary horizontal lockup, standalone `Portcove` wordmark, and full-character pose, designed as one family.
2. One intentionally simplified compact crab symbol, checked at 16, 24, 32, 48, and 64 pixels.
3. Full-color and true single-color variants that work on both light and dark surfaces.
4. Editable original source files, genuine vector wordmark and compact-icon files, and suitable transparent raster exports. A raster embedded in an SVG is not an editable vector master.
5. A small reference sheet defining palette, clear space, minimum sizes, and permitted simplifications.
6. Recorded creator and source, actual usage permissions, attribution requirements, and explicit production approval. Unknown terms remain unknown; neither this direction nor an AI concept grants production approval.

No 3D model, animation, pose pack, merchandise system, or complete custom UI-icon set is required. Human-made final branding is preferred; AI images may support concept exploration but must not be presented as human-made or cropped, traced, or independently regenerated into final files.

Before promotion, inspect the standalone files for spelling, provenance, rights, palette, transparency, edge quality, consistent anatomy, and small-size readability. Derive platform and runtime exports deterministically from approved masters through the existing structure. Update actual manifests, checksums, browser/native icons, package resources, README identity, and shared brand consumers together. Preserve accessible names, decorative-image behavior, aspect ratios, offline use, and layout stability. Review the affected surfaces in both themes and at relevant scale. Asset-owner approval is a separate creative and provenance decision.

## Currently shipped V2 set and transition

| Role                          | Current source and runtime use                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wordmark                      | `assets/brand/generated/v2/portcove-logo-v2-transparent.png` is the approved raster master and README image; `public/brand/logo/portcove-logo-v2-transparent.png` serves startup and About. |
| Full mascot                   | `assets/brand/generated/v2/portcove-mascot-v2-front.png` is the approved opaque front; `public/brand/mascot/portcove-mascot-v2-front.png` is its crop-only empty-library/About derivative.  |
| Compact identity              | `assets/brand/generated/portcove-mascot-head-icon-master.png` feeds `public/brand/icons/portcove-mascot-head-256.png`, the browser icon, sidebar avatar, and Tauri platform icons.          |
| Historical sources and proofs | Original V1 JPEGs, V2 turnarounds, Blender/GLB files, render tools, and proofs remain preserved under `assets/brand/`. They are not a new-artwork brief or additional app placements.       |

Paths in the table are relative to `apps/desktop/`. `assets/brand/manifest.json` and `assets/brand/models/v2/model-manifest.json` continue to protect the shipped bytes. `scripts/check-release-metadata.mjs` verifies current sources, runtime derivatives, models, and platform icons. These V2-specific checks remain valid during transition; a future migration must update them under the existing protected transition policy, not exempt the new art or silently remove integrity coverage.

For the currently shipped V2 files, retain the existing placement limits: display the full wordmark at 180 CSS pixels wide or larger with clear space of at least one quarter of its capital `P` height; use the compact head at 24 pixels or larger in product UI and inspect the generated 16-pixel OS icon rather than assuming it reads. Preserve aspect ratios and accessible naming. V2's so-called monochrome derivatives contain tonal separation and do not satisfy the true single-ink deliverable for the new identity.

The existing app uses `Brand.tsx` for mascot, wordmark, and compact avatar, `index.html` for the browser icon, `src-tauri/tauri.conf.json` for native icons, and the README for display identity. V2 staging backgrounds and size rules in `styles.css` still serve shipped art. Do not remove them until approved replacements are integrated and their remaining consumers are checked. Keep identifiers, catalog/game artwork, installation behavior, stored preferences, and updater trust unchanged. [Issue #227](https://github.com/boburning/portcove/issues/227) owns the remaining standalone artwork approval and coordinated integration follow-up; its older V2-specific proposals are historical wherever they conflict with this approved direction.

## Voice

Portcove sounds confident, concise, technically knowledgeable, slightly playful, and mildly rebellious. Technical and recovery text stays literal and useful; mascot dialogue, jokes, and marketing slogans do not replace clear status or instructions.
