# Compare build and execution dependencies separately

Build-input fingerprints, product-artifact identities, harness identities and execution/qualification bindings remain distinct fields in existing tooling. Source-head provenance is retained separately, so documentation changes need not force an unnecessary product rebuild. An unchanged product still needs affected scenarios rerun when harness, runtime, fixtures, initial state, requirements or criteria change; ambiguity requires fresh qualification.

Vite Task alone decides frontend execution or output restoration. The native
harness inventories the resulting output and binds observations to its inputs;
that observation cannot skip a frontend task or establish fresh native execution.
The build adapter first clears its ordinary, physically confined `dist` directory:
Vite Task restores tracked output files but leaves unrelated extra files in place.
This matches Vite's ordinary empty-output behavior without a second cache engine.
Current Windows/Linux compiler observations do not seal mutable SDK/system-provider inputs, so native product build skipping remains unavailable: matching versions, paths or a caller's completeness assertion cannot authorize it. The normal Cargo invocation and supported incremental behavior remain. This package adds no universal dependency engine or provider attestation system.

Frontend fingerprints include the actual build launcher and its two direct local
environment/command helpers. Unrelated assertion scripts and documentation remain
outside product inputs. This finite inventory is not a general dependency engine.

Acceptance uses preflight and completed stages of one packet format. Preflight
freezes prospective bindings before execution; completed records actual retained
outcomes, process closure, exact-image inspection, independent review and final
delivery bindings. Packets live outside source and record evidence without
changing acceptance, verifier or merge authority. Reused observations retain
original execution provenance; source-head and composed-tree delivery checks
remain separate from content comparisons.
