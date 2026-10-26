# Library organization

`useOrganization(generation)` reads private host choices for Core's canonical
library identity. Its snapshot contains collections, hidden independent port IDs,
Saved authored game IDs, update notice choices and installation-scoped user setup
statements. Missing catalog identities remain stored. These choices never create
an installation, authorize a task, change Core readiness or establish gameplay
testing. Favorites retain their existing owner.

`commit(change)` sends one typed change with the last acknowledged revision.
HostPreferenceStore compares that revision under its existing process/file lock
and publishes atomically within the existing 64 KiB host preference limit.
Unknown host/library/collection/notice fields and other library records survive.
Concurrent stale writes fail; the UI keeps acknowledged choices and offers
`refresh()` before retrying. Unreadable choices are not treated as an empty list.
Library generation changes invalidate delayed hook responses and are checked
through the native preference operation.

Setup statements bind port ID, managed/external ownership and exact installation
ID. The host checks the selected installation before recording a statement.
These records are independent of required Core manual-setup completion markers.
Skipping a release requires its version and exact artifact SHA-256, so a different
artifact with the same upstream tag remains visible. Paused notices do not pause
downloads, change update policy or suppress an existing staged activation.
