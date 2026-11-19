# Private library Favorites

Desktop `get_favorite_ports(generation)` returns canonical independent port IDs
as `Vec<String>`; `set_port_favorite(generation, port_id, favorite)` acknowledges
one committed choice as `()`. The typed API uses `string[]`, scalar arguments
and `void`, following the existing primitive IPC boundary. It does not reuse a
Steam semantic schema or add a snapshot to generated transport contracts.
Headless exact-source contract generation must remain unchanged for this slice.

The host holds its initialization mutex while validating the generation,
resolving `Library::identity_record().id`, and accessing the existing Core
`HostPreferenceStore`. The renderer cannot select a preference namespace.
Handoffs and stale generations refuse before preference writes. Success means
that choice committed; no follow-up read can convert success into a failed write.

Core's delivered format-1 extension retains absent or retired IDs, library moves,
unknown compatible preferences, process/cross-process locking and atomic bounded
publication. Reload reads the original port store;
no catalog metadata, share URL, scan, network or installation/source mutation is
performed. The Library view still requires real library membership.

Discover, Library and details use one Favorite control for each authored game.
Entries without authored game identity keep their own identity. The
[organization contract](../organization/README.md) defines the two-store removal
and readback rule.

Favorites resolve across the full catalog before search, channel, readiness and
collection filters narrow the displayed set. The view counts each matching game
once. The Library view still requires membership. Clear search and filters
also clears the view selection, without changing stored choices.

Unavailable reads are distinct from an empty set. Browsing and launch remain
usable; errors preserve confirmed state and offer Retry favorites. A rejected
write retains the last confirmed choice and reports uncertainty: publication
may have preceded a durability or response failure. A successful read reconciles
the durable choice; an unrelated successful toggle cannot clear that uncertainty. Mutation requests serialize;
old generation/unmounted completions are discarded. Details/back retains the
hook. Switching libraries remounts or clears it before accepting new results.
Toggles are independent buttons outside Catalog card buttons. When removing the
last visible favorite removes its focused card, focus returns to the filter.

Renderer/browser fixtures qualify these interactions; hosted Windows tests
qualify the actual host adapter. They do not establish native GUI, gameplay,
physical-device, release-readiness or broader portability acceptance.
