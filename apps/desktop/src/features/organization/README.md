# Library organization

`useOrganization(generation)` reads private host choices for Core's canonical
library identity. Its snapshot contains collections, hidden independent port IDs,
Saved authored game IDs, update notice choices and installation-scoped user setup
statements. Missing catalog identities remain stored. These choices never create
an installation, authorize a task, change Core readiness or establish gameplay
testing. Favorites retain their existing owner.

`preferred_port_by_game` remembers a deliberate implementation choice by explicit
`original_game.id` and stable port ID. The default empty map may be omitted from
the response. `set_preferred_implementation` sets one choice or clears it with a
null port ID through the same revision-checked Core store. Unknown/absent IDs stay
stored; a catalog correction never migrates saved data, changes a release or
removes an installation. Source editions and source-registration choices remain
independent.

Discover and Library group only authored game identities. A saved choice outside
the current group asks for deliberate reselection; a filtered-out choice stays
saved while the actual matching implementations remain reachable. Without an
explicit choice, one installed implementation has a direct normal action; several
installed alternatives ask. Unreadable preferences never hide that established
single-installed offline path. Existing Core readiness and exact port/install
references still govern every setup, launch, update and recovery action.

The shared implementation control waits for acknowledged persistence. Failed or
stale writes keep the prior choice and offer refresh. Async completion can restore
focus or navigate only while its stable group/dialog still owns that interaction;
dismissing the dialog or moving focus elsewhere cancels the UI continuation.

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
