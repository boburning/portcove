# DKR-R pre-contract compatibility

Read-only interpretation for verified schema-2-to-5 managed installations with
the exact official 1.0.2/1.0.4 Windows/Linux artifact identities in `artifacts.json`.
`catalog.json` freezes DKR's last managed launch, source and persistence contract
from main `43980db13626379bb070eca895e778690ee66fd3`; its schema-1 source profile
preserves the published historical ROM identities. The 1.0.2 Linux executable
name comes from its exact recorded AppImage, independently of the current host.

These files are production compatibility data, separate from test fixtures and
current catalog authoring. `install` consumes them only after manifest identity
verification and only when no captured installed contract exists. Captured
contracts keep precedence. Unknown legacy identities refuse. This reader never
creates an install, rewrites a manifest, offers an update or grants authority to
the upstream updater in a managed tree.

See [the dated qualification](../../../../docs/qualification/dkr-upstream-launcher-2026-10-22.md)
and [#54](https://github.com/boburning/portcove/issues/54). Retire only after an
explicit supported transition or owner-confirmed retirement accounts for these
installed, backup, export and recovery consumers. Catalog absence and retirement
of new managed acquisition are insufficient.
