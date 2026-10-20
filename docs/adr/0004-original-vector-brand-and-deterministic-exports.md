# Original vector identity with deterministic build exports

The October 19 owner-approved implementation authorizes an original AI-assisted
2D family: custom outlined Portcove lettering, horizontal lockup, full crab and
independently simplified compact symbols. This explicitly departs from the earlier
preference for human-made final branding. It grants no production approval to a
study and permits no claim of human authorship or V2 tracing.

Editable SVG masters contain geometry, local masks and literal fills. Build-only
`@resvg/resvg-js` 2.6.2 renders transparent PNGs at natural aspect ratio with system
fonts disabled. The pinned Tauri CLI derives platform icons. There is no renderer
dependency in the application. Repeated exports must match; unchanged export
commands write nothing.

Platform packaging receives a transparent 1024px PNG from the font-independent
renderer, rather than Tauri's SVG loader (which loads system fonts). The pinned
CLI's ICNS HashMap iteration changes element order across runs. A bounded
canonical ordering retains every encoded image/mask payload byte and rejects
unknown, duplicate or incomplete element sets. Two independent exports must match
after this ordering; raw CLI outputs remain in `work/brand-icons` for diagnosis.
This preserves the Tauri packager without adding another platform-icon library.

Verified upstream explanation: [Tauri 2.12.2 ICNS writer](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.2/crates/tauri-cli/src/icon.rs#L384)
and [ICNS family serialization](https://docs.rs/icns/latest/src/icns/family.rs.html#154-162),
accessed October 20, 2026. These are implementation facts, not native qualification.

The existing V2 raster/model manifests and byte checks remain intact. An optional
vector-family reference extends the brand manifest; its independent manifest binds
masters, deterministic derivatives, provenance and candidate identity. Candidate
status never implies production approval. Final owner approval must identify the
exact family before a separate coordinated runtime/icon/README promotion. Changing
a master invalidates the recorded candidate identity and approval binding.

This keeps editable illustration separate from application placement and retained
historical evidence. It costs build tooling and optical-size review, while avoiding
font availability, raster tracing and repeated independent image generation.
