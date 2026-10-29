# Linux rootless skipped installed updater — October 28, 2026

Owners: [#225](https://github.com/boburning/portcove/issues/225) and
[#52](https://github.com/boburning/portcove/issues/52). These owners remain open.

The [actual Linux run](https://github.com/boburning/portcove/actions/runs/40753693767),
attempt 1, job 123046815932, completed a signed Preview 0.1.0 → 0.3.0 skipped
AppImage upgrade on Ubuntu 24.04.5 x86-64 as UID/GID 1001. The stable file was
owned by UID 1001 and restored to mode 755. Both update packages contain
qualification instrumentation; the separate ordinary package startup is a
separate observation.

The [machine-readable receipt](linux-updater-rootless-skipped-observation-2026-10-28.json)
retains exact source/tree, payload/signature/public-key identities, trusted Root,
28 signed role envelopes across positive/recovery/rejected-payload feeds, native
renderer and lifecycle results, preserved paths and archive custody. The actual
qualified predecessor is `fcd54e5b…` (98486776 bytes); the candidate is
`077f2049…` (98241016 bytes). Both payload signatures freshly verified through
the unchanged maintained release verifier.

The native receipt records owner-write refusal, truncated/missing/wrong-signature
payload refusal, interrupted staging recovery, incompatible journal refusal,
read-only state, zero-free-byte state and AppImage filesystem controls, runtime
contention, post-exchange backup/reconciliation and candidate restart. Synthetic
library/game/save/backup/log markers and the desktop entry persisted. Uninstall
removed the managed executable and desktop entry while retaining those markers.
Tmpfs setup used bounded sudo; the application remained rootless. Capabilities
were not separately captured. Process exit controls do not prove OS reboot.

This adds a rootless installed skipped-upgrade observation to the
[initial beta matrix](application-updater-beta-acceptance-2026-10-28.md).
It does not establish genuine historical bootstrap, a default-feature updater
journey, real player-data/preferences/credentials continuity, all channel and
transport cases, another declared Linux environment or Steam Deck acceptance.
Production Root/feed/key/publication remains gated by
[#534](https://github.com/boburning/portcove/issues/534).

The separate [#706](https://github.com/boburning/portcove/issues/706)/
[#49](https://github.com/boburning/portcove/issues/49) GLib disposition is scoped,
non-remediating and expires November 14, 2026, or earlier before the relevant
second ordinary Linux beta publication. Reconfirm the exact candidate, policy
and publication count at actual release; this rehearsal grants no renewal.
