# RFD GTK compatibility backport

This is the intact published RFD 0.17.2 crate with one modified source file: the
upstream GTK format-string fix and its percent-text regression. Publisher URL,
SHA256, revision and every original file hash are in `rfd-provenance.json`; the
complete modification is in `rfd-portcove.patch`. The original MIT license is retained.

Dialog 2.8.4 requires RFD 0.17, but registry 0.17.2 drops the format fix already
present in Portcove’s 0.16.1. Official fix
[9eb59f27](https://github.com/PolyMeilex/rfd/commit/9eb59f2716738ebf44ff6e9524450c8e703957a8)
uses a literal `%s` and a separate description argument. Selecting that whole
revision would also introduce GTK 0.19 / GLib 0.22.9, incompatible with Tauri’s
existing GTK 0.18 graph. This backport preserves published dependencies/features.

The selected Linux package rehearsal runs `scripts/qualify-dialog-gtk.mts`
under Xvfb. It checks the actual constructor’s rendered secondary text, and
requires the otherwise identical unpatched control to fail on `100%%`.
This establishes a GTK fixture, not an installed product or physical dialog observation.
Each invocation has a fresh evidence directory and source/run/attempt intent;
an intent without a matching result remains incomplete. Failed controls and
logs are retained; successful controls are removed after both outcomes verify.

Retire the path patch, vendored crate/provenance, dedicated probe and prerequisite
flag together when a compatible published RFD version includes the fix. Verify
the upstream source, native graph, percent-text reproducer and active file-picker
consumers before removal. Keep existing release-age and native acceptance rules.
