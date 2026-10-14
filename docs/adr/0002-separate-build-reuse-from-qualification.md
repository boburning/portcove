# Compare build and execution dependencies separately

Build-input fingerprints, product-artifact identities, harness identities and execution/qualification bindings remain distinct fields in existing tooling. Source-head provenance is retained separately, so documentation changes need not force an unnecessary product rebuild. An unchanged product still needs affected scenarios rerun when harness, runtime, fixtures, initial state, requirements or criteria change; ambiguity requires fresh qualification.

The existing frontend cache can establish reuse. Current Windows/Linux compiler observations do not seal mutable SDK/system-provider inputs, so native product build skipping remains unavailable: matching versions, paths or a caller's completeness assertion cannot authorize it. The normal Cargo invocation and supported incremental behavior remain. This package adds no universal dependency engine or provider attestation system.

Acceptance packets use preflight and completed stages of one format. They retain actual outcomes, exact-image inspection, independent review and source/current-target/composed-tree bindings through existing trusted delivery; they cannot waive required acceptance, grant merge authority or authorize changes to their own verifier.

Acceptance uses preflight and completed stages of one packet format. Preflight
freezes prospective bindings before execution; completed records actual retained
outcomes, process closure, exact-image inspection, independent review and final
delivery bindings. Packets live outside source and record evidence without
changing acceptance, verifier or merge authority. Reused observations retain
original execution provenance; source-head and composed-tree delivery checks
remain separate from content comparisons.
