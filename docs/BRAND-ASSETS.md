# Portcove brand assets

Portcove's brand system uses the crab mascot and dimensional `PortCove` wordmark supplied by the project owner on 2026-09-01. The original JPEGs remain unchanged under `apps/desktop/assets/brand/masters/` as provenance. Approved production masters live under `apps/desktop/assets/brand/generated/`, and optimized runtime copies live under the matching `apps/desktop/public/brand/` logo, mascot, and icon directories.

## Asset roles

| Asset | Role | Usage |
| --- | --- | --- |
| `masters/portcove-mascot-master.jpg` · 1280 × 981 | Preserved owner-supplied Mascot V1 source | Provenance only. Do not replace or edit. |
| `masters/portcove-logo-master.jpg` · 1280 × 720 | Preserved owner-supplied Logo V1 source | Provenance only. Do not replace, edit, or use as the production wordmark. |
| `generated/v2/portcove-mascot-v2-front.png` · 1254 × 1254 RGB | Canonical Mascot V2 front master | Authoritative full-character geometry, anatomy, color placement, and expression reference. |
| `generated/v2/portcove-mascot-v2-front-left-three-quarter.png` · 1254 × 1254 RGB | Approved Mascot V2 front-left three-quarter master | First depth and attachment reference for the turnaround. |
| `generated/v2/portcove-mascot-v2-front-right-three-quarter.png` · 1254 × 1254 RGB | Approved Mascot V2 front-right three-quarter master | Opposite-camera depth reference with the canonical grin direction preserved. |
| `generated/v2/portcove-mascot-v2-left-side.png` · 1254 × 1254 RGB | Approved Mascot V2 left-side master | Strict profile reference for shell depth, leg occlusion, and localized chest placement. |
| `generated/v2/portcove-mascot-v2-back.png` · 1254 × 1254 RGB | Approved Mascot V2 back master | Strict rear reference for shell thickness, rear eye construction, appendage attachments, and front-only feature occlusion. |
| `models/v2/portcove-mascot-v2.blend` | Editable Mascot V2 geometry authority | Named six-material hierarchy with mirrored anatomy, two pivoting lid controls, and five fixed turnaround cameras. |
| `models/v2/portcove-mascot-v2.glb` | Portable Mascot V2 exchange model | Carries the model hierarchy, materials, metadata, and cameras for non-Blender workflows. |
| `generated/v2/model/*.png` · 1254 × 1254 RGBA | Transparent model turnaround renders | Front, both three-quarter, strict left-side, and strict back geometry references. These do not replace the approved raster surface treatment. |
| `generated/v2/model/proofs/*.png` | Model compositing and scale proofs | Graphite, warm-light, 512 px, 256 px, and 128 px QA outputs. They are not product UI assets. |
| `public/brand/mascot/portcove-mascot-v2-front.png` · 1254 × 962 RGB | Crop-only Mascot V2 runtime derivative | Empty-library and About artwork. It removes unused black clear space without rescaling or changing the character. |
| `generated/v2/portcove-logo-v2-transparent.png` · 1868 × 743 RGBA | Canonical full-color Logo V2 master with required clear space | Source for future approved derivatives and the README display identity. |
| `generated/v2/portcove-logo-v2-tight-transparent.png` · 1646 × 521 RGBA | Tight full-color derivative | Controlled placements whose container supplies the required clear space. The optimized 1024 × 324 runtime copy is used at startup and in About. |
| `generated/v2/portcove-logo-v2-graphite-stage.png` / `portcove-logo-v2-light-stage.png` · 1868 × 743 | Intentional staged derivatives | Fixed graphite or warm-light presentation where a transparent asset cannot be composited deliberately. |
| `generated/v2/portcove-logo-v2-monochrome-white.png` / `portcove-logo-v2-monochrome-graphite.png` · 1868 × 743 RGBA | Tonally separated monochrome derivatives | Exceptional one-color contexts only; retain the dimensional face hierarchy. |
| `generated/portcove-mascot-head-icon-master.png` · 1254 × 1254 | AI-assisted compact mascot portrait | Native application icon and sidebar avatar. Tauri-generated platform sizes live under `src-tauri/icons/`. |

`apps/desktop/assets/brand/manifest.json` is the machine-readable integrity contract for approved masters, model renders, QA proofs, and runtime derivatives. The release check verifies every listed PNG's SHA-256, dimensions, 8-bit color mode, unique identity, and repository-contained path. `models/v2/model-manifest.json` separately freezes the editable model, GLB exchange file, reproducible tools, anatomy counts, material set, and triangle budget. Update either manifest only after the project owner approves the changed asset set.

Logo V2 has genuine alpha transparency. Its corners are fully transparent, its visible silhouette includes antialiased partial alpha, and its two-pixel edge fringe is reconstructed from adjacent solid artwork so no black-field pixels remain. Minute enclosed apertures around the `r` and `t` use deep-cobalt backing planes so they read as depth rather than light-background damage; the counters and the larger openings around the `C` and `v` remain transparent. It was inspected at native size over black, `#191A1D` graphite, white, and warm light gray, then again at the 192-pixel application display size. All staged and monochrome outputs derive from that one transparent master; they are not independent AI generations. The desktop composites a premultiplied-alpha resized derivative on the semantic `--color-brand-stage`.

## Logo V2 construction

The canonical geometry is the approved conservative refinement of the supplied mark. It retains the oversized `P`, enlarged `C`, playful uneven rhythm, current `tC` overlap, low-poly extrusion, and red-over-blue geometric underline. The `C` remains nearly the height of the `P`; reducing it further weakened the identity. The wordmark must not be redrawn as ordinary type or normalized into mechanically equal spacing.

Face color follows the geometry:

- golden yellow owns the readable front faces;
- cobalt blue owns the primary depth and extrusion mass;
- emerald green appears only on secondary side-facing planes;
- signature red is limited to narrow top or edge faces and the underline's upper plane.

One polygonal face has one color role. A presentation render may add modest diffuse lighting, soft filtering, and restrained late-1990s texture variation, but it must not move a color across a geometric edge, add random facets, or redistribute colors by letter. Red is punctuation rather than a competing letter color. The underline keeps a distinct red upper plane and blue lower plane aligned to the wordmark's perspective.

### Normalized proportions

Measurements are approximate and use the tight visible wordmark width as `1.000`. Coordinates begin at the upper-left of the tight visible bounds.

| Measure | Normalized value |
| --- | ---: |
| Total wordmark height, excluding the underline's extra depth | `0.290` |
| Capital `P` height | `0.270` |
| Typical lowercase body height | `0.158` |
| Capital `C` height | `0.263` |
| Capital `C` width | `0.211` |
| Underline width | `0.826` |
| Underline depth | `0.091` |
| Average extrusion depth | `0.023` |
| Approximate optical baseline from the top bound | `0.228` |
| Alpha-weighted visual center `(x, y)` | `(0.490, 0.176)` |

The tight visible bounds are 1646 × 521 pixels. The canonical transparent canvas adds 111 pixels on every side, equal to one quarter of the approximately 444-pixel capital `P` height.

### Name and identity hierarchy

Use **Portcove** as the written product name in prose, UI, package descriptions, and CLI discussion. **PortCove** is the stylized capitalization embodied by the display artwork; do not reproduce it as routine camel-case text. The full wordmark is the display identity, the full crab is the character identity, and the mascot head is the compact identity. Do not create a separate `PC` monogram.

## Approved Logo V2 render prompt

The owner-supplied `masters/portcove-logo-master.jpg` established the identity. Logo V2 was refined through owner-reviewed conservative edits, then rerendered once as a complete object so its yellow, blue, green, and red surfaces shared one material and lighting system. A final 117-pixel cleanup replaced the stray blue strip on the `C`'s upper-left green edge. Canonicalization removed the black presentation field with a cleaned silhouette and neighboring-color edge reconstruction; it did not repaint the approved interior artwork. The approved black-field render had SHA-256 `7374505552ad6a9644f1505a776c357d04273787b7624a28bb24a5170f9ed775`; the canonical transparent master has SHA-256 `63bcfdd2d01764e1ce0f3fd9afd6413e4bc47f487797b7b5ffd1d1402cd2e69c`.

> Create one final-quality, cohesive full rerender of the supplied PortCove wordmark. Treat the reference as locked art direction and exact composition, not an invitation to redesign. Rerender the entire logo in a single unified pass so every colored surface shares the same material, lighting, softness, edge treatment, and late-1990s low-poly game-box aesthetic. Preserve the custom chunky italic letterforms, oversized `P`, enlarged `C`, current `tC` relationship, spacing, counters, extrusion, perspective, red-over-blue underline, wide composition, and black presentation field. Keep golden-yellow fronts, cobalt-blue primary depth, selective emerald-green side planes, and restrained signature-red cap faces in their established locations. Keep the approved blue first-`o` shoulder and blue upper-right `C` return. Do not introduce extra red. Use one cohesive surface language with softly modeled low-poly planes, modest tonal variation, slightly imperfect late-1990s raster character, and comparable texture density across all four colors. Do not add or remove elements, change the spelling, redesign the letterforms, introduce modern gloss or photorealism, or let colors leak across geometric face boundaries.

## Mascot V2 canonical design

The project owner approved `generated/v2/portcove-mascot-v2-front.png` as Mascot V2 on 2026-09-03. The 1254 × 1254 RGB master has SHA-256 `86e915214e0bfa5fe7f29409abdca14719af96da5c09faa60f515d08d927bf63`. It is the authority for future mascot work; do not regenerate the character from prose when the master can be transformed directly.

The approved master retains its intentional black presentation field. The 1254 × 962 runtime derivative removes source rows `0–111` and `1074–1253`, leaving equal 116-pixel clear space above and below the visible character. It does not rescale, repaint, or alter the retained pixel values and has SHA-256 `c20b79b0c36ea4a72fccd06d567c544155a95f4f014f1c729609d09bf104298e`.

The editable model under `assets/brand/models/v2/` is the geometry authority for future controlled refinement. Its initial renders deliberately establish construction rather than supersede the approved raster's richer material and lighting treatment. The desktop therefore continues to display the approved raster derivative. A future model render may replace it only after matching the raster at the front view, passing the five-view anatomy checks, and receiving owner approval.

### Character and anatomy layer

The canonical character is a broad, squat red crab with a shallow continuous gold belly, two tall eyes, two oversized claws, four short walking legs, and four side spikes. Its front silhouette is bilateral. Small facet and lighting variation may remain inside a surface, but the geometry and color ownership do not drift.

| Feature | Canonical rule |
| --- | --- |
| Eyes | Exactly 2 tall, mirror-matched eye globes with warm-white sclera, cobalt irises, dark pupils, and red housings. |
| Upper lids | Exactly 2 attached angular hoods. Each hood has a red exterior and graphite underside and moves as one rigid part around its outer attachment. |
| Eye expression | The canonical front pose uses equal mirrored lid pivots. Expression poses may rotate a lid, but must not stretch, resize, crease, or misalign the eye globe, iris, pupil, or sclera. |
| Claws | Exactly 2 oversized claws. From the body outward, color order is red arm and inner geometry, cobalt primary mass, then golden-yellow outer tip. |
| Walking legs | Exactly 4 total: 2 per side, all red, short, tapered, crab-like, and tucked beneath the shell. Never add shoes, feet, or blue/yellow leg sections. |
| Side spikes | Exactly 4 visible in front view: 2 per side. Each has an emerald body and golden-yellow tip. |
| Belly | One broad, shallow, continuous gold form. Do not introduce a tail, long center point, armor plates, or deep seams. |
| Mouth | One narrow asymmetric warm-white wedge grin with a dark border. It carries the mischievous attitude without becoming a large smile. |

The attached red-and-graphite upper lids are the facial control. The eye globes, stalks, lower housings, irises, and pupils remain fixed. This separation allows controlled confident, skeptical, or mischievous expressions without creating sleepy eyes or detached eyebrows.

### Normalized mascot proportions

Measurements use the visible shell width of 673 pixels as `1.000`. They describe the approved front raster and are practical guardrails rather than replacement geometry. Paired values are averaged where the low-poly lighting changes an edge by a few pixels.

| Measure | Pixels | Normalized value |
| --- | ---: | ---: |
| Shell width | `673` | `1.000` |
| Shell/body height, including the belly envelope | `353` | `0.525` |
| Total character width, including claws | `1199` | `1.782` |
| Total character height, including eyes and legs | `730` | `1.085` |
| Eye assembly height, lid through lower housing | `242` | `0.360` |
| Eye center-to-center spacing | `205` | `0.305` |
| Visible eye-stalk length | `68` | `0.101` |
| Belly width | `352` | `0.523` |
| Belly height | `140` | `0.208` |
| Individual claw width | `290` | `0.431` |
| Individual claw height | `325` | `0.483` |
| Individual claw width / shell width | `290 / 673` | `0.431` |
| Walking-leg visible root-to-tip length | `121` | `0.180` |
| Walking-leg average thickness | `48` | `0.071` |
| Side-spike average base-to-tip length | `184` | `0.273` |
| Same-side spike tip spacing | `95` | `0.141` |
| Mouth width, including border | `224` | `0.333` |
| Mouth height, including border | `67` | `0.100` |

### Mascot color map

The palette references below define material roles; the raster master contains darker and lighter facet values produced by simple lighting.

| Material region | Canonical color role |
| --- | --- |
| Shell, eye housings, eye stalks, claw arms, claw inner/lower geometry, all four walking legs | Signature red/orange |
| Claw primary mass and irises | Cobalt blue |
| Belly, claw outer tips, spike tips | Golden yellow |
| Spike bodies only | Emerald green |
| Sclera and grin | Warm white |
| Lid undersides, pupils, mouth border | Graphite/black |

Color ownership is symmetric and deterministic. Green remains exclusive to the spikes, and blue must not spread onto walking legs or unrelated shell geometry.

### Render-treatment layer

Derivatives retain the late-1990s low-poly language through simple polygonal lighting, modest texture resolution, slight bilinear softness, restrained antialiasing, and limited material detail. Texture character must come from stable low-resolution filtering rather than changing procedural noise. Do not add modern gloss, PBR, ray tracing, hyper-detail, random mottling, or new facets that alter the model layer.

The final eye adjustment was a deterministic geometry cleanup of the approved near-final raster. One canonical eye globe was mirrored across the centerline, and the two attached lids received equal mirrored pivots. The transformation changed only the eye band; the shell, mouth, spikes, claws, belly, arms, and four legs remained unchanged.

## Generated icon prompt

The compact application icon was produced with the built-in image-generation workflow in `stylized-concept` mode. The owner-supplied mascot remained the identity reference. The [Rust project's archived Ferris artwork](https://github.com/rust-lang/rust-artwork/tree/main/mascot) informed only the broad, tucked-under crab silhouette; no Ferris asset, face, color, or logo is included in Portcove.

> Revise the existing square Portcove icon without changing its angular eyebrows, blue eyes, grin, red/orange shell, tan chest, green/yellow spikes, blue-and-yellow claws, low-poly N64 rendering, centered scale, graphite field, or confident expression. Remove the two small dangling lower-body protrusions completely. Do not replace them with paired bulbs, toes, feet, teardrops, or hanging limbs. Use one clean, wide, low red/orange shell base behind and beneath the tan chest, with a shallow continuous polygonal bottom edge, structurally inspired by Ferris's compact crab silhouette while remaining unmistakably the same Portcove character. Keep the claws as the only visible lower-side appendages. Exact 1:1 square; safe margin for OS masks; no Rust logo, text, wordmark, extra limbs, modern glossy rendering, photorealism, or watermark.

## Core palette

Brand artwork should harmonize with the semantic UI system rather than create a parallel palette.

| Role | Reference | UI meaning |
| --- | --- | --- |
| Graphite | `#191A1D` / `#24252A` | Hardware-like presentation field and neutral shell. |
| Cobalt blue | `#2D5DA8` | Interaction, mascot claws and irises, and logo depth. |
| Signature red | `#E23B32` | Mascot shell, wordmark edge punctuation, and rare product emphasis. |
| Emerald green | `#27995B` | Mascot spike bodies, logo side planes, and semantic success. |
| Golden yellow | `#F2C94C` | Logo faces, mascot belly and outer tips, and rare UI focus/highlight. |
| Warm white | `#F5F3EE` | Crisp UI typography and mascot eyes/grin. |

Artwork may retain source texture variation; UI components must continue to use semantic tokens rather than sampling arbitrary colors from the raster masters.

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

## Mascot turnaround and pose guidance

Mascot V2 front, the approved front-left and front-right three-quarter views, the approved left-side profile and back view, and the compact head portrait are the only current production views. Do not create a pose without a named product surface. Future welcome, inspecting, building, milestone-success, or high-level recovery poses may be added when the corresponding state exists in the product.

The 2026-09-03 desktop surface audit found only two full-mascot placements: the empty library and About. Both use the neutral front asset appropriately. Loading uses the wordmark, application chrome uses the compact head, and the current product has no dedicated onboarding or persistent milestone-success surface. No additional expression or pose is justified until one of those product states is designed.

The project owner approved `generated/v2/portcove-mascot-v2-front-left-three-quarter.png` on 2026-09-03. The 1254 × 1254 RGB master has SHA-256 `bb53442feb2a4e9852252efa63bbd58ee2c0d8f763080c48a5c10028cfbe7929`. It establishes the shallow shell lip, broad continuous belly depth, four tucked leg attachments, and one shoulder-joint-plus-arm connection per claw for subsequent turnaround views.

The project owner approved `generated/v2/portcove-mascot-v2-front-right-three-quarter.png` on 2026-09-03. The 1254 × 1254 RGB master has SHA-256 `909abae4d0e331c498d7af6fa50b0a09104e8ebb981e5589396a9d176ded215a`. It establishes the opposite camera direction with the viewer-right claw nearer and larger while preserving the canonical grin, broad on the viewer-left and tapering to the viewer-right.

The project owner approved `generated/v2/portcove-mascot-v2-left-side.png` on 2026-09-03. The 1254 × 1254 RGB master has SHA-256 `376ba97db527180a0da05c7fb3089f07a490e11d4a66465af24f9a42a0370dda`. It establishes a strict side-profile convention: the two near-side legs remain visible while the far-side pair is directly occluded, preserving four legs total without creating an insect-like row. The gold chest occupies only the front third of the lower body; the middle and rear underside remain red/orange shell material.

The project owner approved `generated/v2/portcove-mascot-v2-back.png` on 2026-09-03. The 1254 × 1254 RGB master has SHA-256 `946b048af22e7d1c1fd0e6c537190a949a55b5bb0a7f36c86a2d36fe9aeea849`. It establishes the strict rear convention: the red/orange shell hides the front-only mouth and gold belly; the backs of both eye assemblies remain visible; four green-and-yellow spikes, two claw assemblies, and exactly four substantial walking legs retain bilateral placement. Shoulder joints and arms remain lateral and do not introduce additional downward leg silhouettes.

The required raster turnaround is complete. A right-side profile remains optional because the paired three-quarter views already constrain the opposite direction and the underlying body construction is bilateral. The approved views are the anatomy proof for the four walking-leg attachments, claw-arm joints, eye-stalk placement, dorsal-spike depth, belly depth, and shell thickness. Every view uses the same scale, orthographic camera family, proportions, anatomy counts, material boundaries, and neutral lid construction.

### Approved Mascot V2 back-view render prompt

> Generate a strict orthographic rear view of the approved Portcove Mascot V2, using the canonical front, both approved three-quarter views, and the approved left-side profile as locked geometry, anatomy, depth, scale, palette, and material references. Preserve the same centered 1254 × 1254 RGB composition on a pure black field, broad squat red/orange shell, low-poly late-1990s faceting, simple diffuse lighting, two rear eye housings and attached lid backs, two symmetrical claw assemblies with red joints and arms, cobalt-blue mass and golden-yellow tips, exactly four green-and-yellow side spikes, and exactly four short red walking legs. From behind, do not show the mouth, irises, pupils, sclera, or gold belly. Keep the shoulder joints and arms lateral with no extra downward nubs. Do not add a tail, shell plates, extra appendages, realistic anatomy, modern glossy rendering, text, logos, watermarks, or transparency.

The owner approved the first editable geometry checkpoint on 2026-09-03. `models/v2/portcove-mascot-v2.blend` and its GLB export implement the turnaround as separate low-complexity shell, face, eye, lid, claw, leg, and spike objects. Six named materials own the canonical colors, two outer hinges control the attached lids, and five fixed cameras reproduce the required views. The 1,564-triangle model is intentionally a structural base without a full production rig. The approved front raster remains the proportion and surface-treatment reference while later model work improves material richness and lighting.

Every derivative must depict the same character: red/orange shell, blue eyes beneath attached red-and-graphite angular lids, white grin, gold belly, mirrored green/yellow spikes, symmetrical blue/yellow claws, and exactly four short red walking legs. Preserve the proportions, silhouette, confident mischievous attitude, low-poly geometry, low-resolution textures, soft bilinear sampling, simple lighting, and limited material detail. The compact head/app icon is the crop-specific exception: it omits the walking legs and uses a single broad lower shell so paired protrusions do not become ambiguous at small sizes. Exclude realistic crab anatomy, Pixar/DreamWorks-like CGI, anime, flat corporate vector art, pixel art, PBR, ray tracing, glossy modern rendering, or hyper-detail.

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

Transparent output must be verified by inspecting the PNG pixel format, corner alpha, translucent edge pixels, and composites over dark and light stages. A visible checkerboard is not evidence of transparency. Preserve the owner-supplied JPEGs as historical sources; production wordmark usage comes from the verified Logo V2 PNG derivatives. Mascot V2 intentionally remains an opaque RGB master on black until a separately reviewed alpha derivative passes the same edge checks.
