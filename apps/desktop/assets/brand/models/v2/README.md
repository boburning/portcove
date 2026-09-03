# Portcove Mascot V2 model

This directory contains the first editable geometry authority for Mascot V2. The approved raster turnaround remains the visual authority for surface finish and the current desktop runtime asset. The model fixes anatomy, proportions, color ownership, lid controls, and camera conventions so later material and lighting work can improve without redrawing the character.

## Files

- `portcove-mascot-v2.blend` is the editable Blender source.
- `portcove-mascot-v2.glb` is the portable exchange copy with named materials, hierarchy, extras, and five cameras.
- `build_portcove_mascot_v2.py` reconstructs the model and renders the five transparent reference views from reproducible geometry.
- `validate_portcove_mascot_v2.py` checks the Blender hierarchy, anatomy counts, materials, cameras, triangle budget, and GLB structure.
- `create_portcove_mascot_v2_proofs.py` checks alpha coverage and creates dark, light, and runtime-size proofs.
- `model-manifest.json` freezes the source files, declared geometry, and material set by SHA-256 and byte size.

Generated model renders live under `../../generated/v2/model/`. They are reference and QA outputs; the desktop continues to use the polished approved raster at `public/brand/mascot/portcove-mascot-v2-front.png`.

## Rebuild and validate

The source was produced with Blender 5.2.1 LTS. From the repository root:

```powershell
blender --background --factory-startup --python apps/desktop/assets/brand/models/v2/build_portcove_mascot_v2.py
blender --background apps/desktop/assets/brand/models/v2/portcove-mascot-v2.blend --python apps/desktop/assets/brand/models/v2/validate_portcove_mascot_v2.py
python apps/desktop/assets/brand/models/v2/create_portcove_mascot_v2_proofs.py
```

The proof builder requires Pillow. It also strips Blender's volatile render-time PNG metadata so unchanged pixels produce byte-stable PNGs. The GLB and normalized PNGs are reproducible byte-for-byte. Blender embeds session metadata in `.blend`, so an unchanged rebuild can still change that source file's hash; `model-manifest.json` freezes the approved source instance. After a reviewed rebuild, update both brand manifests with the resulting hashes and byte sizes.

## Editing contract

- Keep exactly two eyes, two claws, four short walking legs, four side spikes, and two lid hinges.
- Preserve the front-only gold belly and deterministic six-material color ownership.
- Move each attached red-and-graphite lid through its `LidHinge.L` or `LidHinge.R` control. Do not deform the eye globe to make expressions.
- Keep the front, both three-quarter, left-side, and back cameras as the canonical turnaround views.
- Treat the model as a structural base. Match the approved raster before promoting a future model render into the product UI.
