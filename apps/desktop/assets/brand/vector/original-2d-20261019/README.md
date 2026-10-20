# Original 2D family candidate

**Unapproved candidate. Current application and package assets remain V2.**

Created in this authorized chat by Codex using original AI-assisted SVG geometry
and custom outlined `Portcove` lettering. No font, stock illustration, external
image, V2 tracing or prior unapproved master is embedded. This is not human-made
artwork, a trademark-clearance opinion, or owner production approval. The manifest
records provenance and the exact candidate identity; approval remains null.

Two independent family studies were compared under the same role requirements.
Fresh-context critique favored A's rounded, self-assured character over B's more
aggressive angular treatment. The refined A family exposes arm/pincer connections,
uses related round eyes and grins, separates the gold belly from the mouth, improves
lettering rhythm and adds a graphite keyline. Optical 16/24px marks omit the belly
and extra walking-leg detail. The full character retains all established color
ownership; compact identity deliberately uses fewer accents.

## Roles and use

| Role              | Proposed minimum | Placement and fallback                                                                                |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Wordmark          | 180 CSS px wide  | Startup/About and README where space permits; plain `Portcove` text remains accessible                |
| Horizontal lockup | 240 CSS px wide  | Spacious identity/header references; do not squeeze it into ordinary controls                         |
| Full mascot       | 96 CSS px wide   | Welcome, empty Library and About; omit decorative art when space is limited or for technical failures |
| Compact           | 24 CSS px        | Sidebar and identity placements; use simplified optical source for 16/24px OS derivatives             |

Keep external clear space at least one quarter of the capital P height around
lettering and at least one eye-housing width around the compact symbol. Preserve
aspect ratio. These are candidate rules requiring final placement inspection.
The `color-dark` keyline variant separates graphite from the dark outline; ordinary
`color` serves warm-light surfaces. `ink` and `ink-inverse` are genuine single-ink
silhouettes with alpha negative space, not tonal grayscale versions. Transparent
pixels belong to the artwork; proof-sheet backgrounds are separate CSS surfaces.

## Export and verification

Run `node scripts/export-vector-brand.mts` from the repository root, then
`node scripts/export-vector-brand.mts --check`. The pinned build renderer loads no
system fonts and resolves no external image. Width-only rendering preserves each
viewBox's natural aspect ratio. Every PNG records byte identity, dimensions and
transparent/opaque pixel counts. Single-ink renders admit one opaque painted RGB
color. Two renders are compared before publication to this candidate directory;
unchanged outputs are not rewritten.

The generated `manifest.generated.json` owns export hashes; edit the vector
masters and deliberately refresh their reviewed identities rather than hand-edit
derivatives. Run `node scripts/resource-command.mts analysis -- node
scripts/export-vector-brand-icons.mts [--check]` for the 17 desktop icon candidates.
The pinned Tauri CLI consumes a font-independent 1024px PNG from the optical
compact master. ICNS element order is canonicalized without changing encoded
payloads, addressing observed HashMap ordering variation. Two fresh CLI exports
must agree. Raw outputs remain under `work/brand-icons`; mobile derivatives are
incidental CLI outputs and are not promoted into this desktop family.

The main release-metadata validator verifies this family alongside the unchanged
historical V2 assets/model files. No runtime consumer points here. Platform-icon
proofs, actual-size rasters, transparent light/dark composites and app-placement
references must be inspected before asking the owner to approve this exact family.
Asset creation does not qualify native behavior on any platform. No animation,
pose pack, custom control icons, social preview/publication or signing is included.
