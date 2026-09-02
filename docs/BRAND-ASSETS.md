# Portcove brand assets

Portcove's brand system uses the crab mascot and dimensional `PortCove` wordmark supplied by the project owner on 2026-09-01. The originals are preserved without modification under `apps/desktop/assets/brand/masters/`, generated production masters live under `apps/desktop/assets/brand/generated/`, and optimized runtime copies live under the matching `apps/desktop/public/brand/` logo, mascot, and icon directories.

## Asset roles

| Asset | Role | Usage |
| --- | --- | --- |
| `masters/portcove-mascot-master.jpg` · 1280 × 981 | Owner-supplied mascot master | Empty-library personality moment and future approved brand derivatives. |
| `masters/portcove-logo-master.jpg` · 1280 × 720 | Owner-supplied wordmark master | Startup/loading identity and About. Do not use as ordinary working-page decoration. |
| `generated/portcove-mascot-head-icon-master.png` · 1254 × 1254 | AI-assisted compact mascot portrait | Native application icon and sidebar avatar. Tauri-generated platform sizes live under `src-tauri/icons/`. |

The JPEG references intentionally retain their black presentation field. The UI places them only on the semantic `--color-brand-stage`, so the dark field reads as a deliberate alternate-universe console-studio identity plate in both themes rather than as an accidental rectangle. Failed transparent-background experiments were not admitted into the project because inspection showed a checkerboard baked into RGB pixels instead of real alpha.

## Generated icon prompt

The compact application icon was produced with the built-in image-generation workflow in `stylized-concept` mode. The owner-supplied mascot remained the identity reference. The [Rust project's archived Ferris artwork](https://github.com/rust-lang/rust-artwork/tree/main/mascot) informed only the broad, tucked-under crab silhouette; no Ferris asset, face, color, or logo is included in Portcove.

> Revise the existing square Portcove icon without changing its angular eyebrows, blue eyes, grin, red/orange shell, tan chest, green/yellow spikes, blue-and-yellow claws, low-poly N64 rendering, centered scale, graphite field, or confident expression. Remove the two small dangling lower-body protrusions completely. Do not replace them with paired bulbs, toes, feet, teardrops, or hanging limbs. Use one clean, wide, low red/orange shell base behind and beneath the tan chest, with a shallow continuous polygonal bottom edge, structurally inspired by Ferris's compact crab silhouette while remaining unmistakably the same Portcove character. Keep the claws as the only visible lower-side appendages. Exact 1:1 square; safe margin for OS masks; no Rust logo, text, wordmark, extra limbs, modern glossy rendering, photorealism, or watermark.

## Core palette

Brand artwork should harmonize with the semantic UI system rather than create a parallel palette.

| Role | Reference | UI meaning |
| --- | --- | --- |
| Graphite | `#191A1D` / `#24252A` | Hardware-like presentation field and neutral shell. |
| Cobalt blue | `#2D5DA8` | Interaction and the mascot/logo dimensional blue. |
| Signature red | `#E23B32` | Mascot shell, wordmark edge punctuation, and rare product emphasis. |
| Emerald green | `#27995B` | Shell/logo facets and semantic success. |
| Golden yellow | `#F2C94C` | Letter faces, claw tips, and rare UI focus/highlight. |
| Warm white | `#F5F3EE` | Crisp UI typography and mascot eyes/grin. |

Artwork may retain source texture variation; UI components must continue to use semantic tokens rather than sampling arbitrary colors from the JPEGs.

## Scale and clear space

- Use the full wordmark at 180 CSS pixels wide or larger. Below that, use readable text plus the mascot-head mark.
- Keep clear space around the wordmark equal to at least one quarter of the capital `P` height. Do not let controls, headings, or borders overlap the extruded letter edges or underline.
- Use the mascot-head mark at 24 pixels or larger in product UI. The generated platform set includes 16-pixel assets for operating-system surfaces, where it must be inspected rather than assumed legible.
- Keep the full mascot large enough that the eyes, grin, spikes, and mirrored claw colors remain distinct. It is not a toolbar glyph.
- Preserve aspect ratio for every asset. Use `object-fit: contain` for the full mascot and wordmark and a purpose-built square crop for app icons.

## Correct and incorrect usage

Correct:

- full wordmark on a quiet graphite stage at startup, in About, or at the top of the README;
- mascot in an empty library or meaningful onboarding/milestone surface with actionable copy beside it;
- mascot-head icon in application chrome and operating-system launch surfaces;
- crisp modern typography, controls, borders, and icons around intentionally soft N64-like artwork.

Incorrect:

- full wordmark in every page header or narrow toolbar;
- mascot beside compiler errors, stack traces, source-integrity failures, or routine confirmation dialogs;
- recoloring limbs, swapping the mirrored blue/yellow placement, smoothing the character into modern CGI, or auto-tracing it into vector art;
- fake transparency grids, black/white edge halos, stretching, face crops, text overlays, glow, scanlines, or CRT treatment;
- using the logo image as the only accessible product name.

## Mascot and pose guidance

The default supplied pose and generated head portrait are the only current production poses. Do not generate a pose without a named product surface. Future welcome, inspecting, building, milestone-success, or high-level recovery poses may be added when the corresponding state exists in the product.

Every derivative must depict the same character: red/orange shell, blue eyes beneath angular red eyebrows, white grin, yellow chest, mirrored green/yellow spikes, and symmetrical blue/yellow claws and feet. Preserve the same body proportions, recognizable silhouette, confident attitude, low-poly geometry, low-resolution textures, soft bilinear sampling, simple lighting, and limited material detail. The compact head/app icon is the one crop-specific exception: it omits the full mascot's feet and uses a single broad, continuous lower shell so no paired lower protrusions become ambiguous at small sizes. Exclude realistic crab anatomy, Pixar/DreamWorks-like CGI, anime, flat corporate vector art, pixel art, PBR, ray tracing, glossy modern rendering, or hyper-detail.

## Usage contract

- The mascot remains special: sidebar avatar, empty library, About, major onboarding, or a meaningful first-build success are appropriate. Routine errors, dialogs, tables, and toolbars are not.
- The dimensional wordmark is display branding. Ordinary navigation and technical views continue to use readable UI typography.
- Do not recolor, stretch, crop through the face, place copy over the mascot, or use the wordmark below a legible size.
- UI image elements require deliberate alternative text. Repeated art beside a visible `Portcove` label is decorative and uses an empty alternative.
- New derivatives must preserve the mascot's core silhouette, palette, low-poly construction, and confident mischievous expression.

## Voice

Portcove sounds confident, concise, technically knowledgeable, slightly playful, and mildly rebellious. It is never corporate, childish, or obnoxious. Technical output stays literal: `Build completed in 4.8s.` A rare milestone may carry more character: `It lives. Your first native build completed successfully.` Do not write ordinary system messages as mascot dialogue, and never weaken recovery guidance for a joke.

## Generated-art workflow

1. Name the product surface and prove an existing asset cannot serve it.
2. Use the relevant master as the identity reference and describe every invariant explicitly.
3. Generate into a review area, inspect dimensions, alpha, edge halos, color placement, silhouette, and small-size behavior, and reject near misses.
4. Keep only the selected production master under `assets/brand/generated/`; publish optimized runtime derivatives separately.
5. Record the intended use, reference, final dimensions, and reproducible prompt here. Do not commit experiments.

Transparent output must be verified by inspecting the PNG pixel format and corner alpha. A visible checkerboard is not evidence of transparency. The current JPEG masters intentionally use the brand stage because the attempted extraction rendered the checkerboard into opaque RGB pixels and was therefore rejected.
