# Catalog and Library declared filters

`CatalogFilters` presents explicit declared platforms and release channels using
the unchanged `evaluateCatalogQuery` contract. Alternatives within a group are
OR; groups are AND. It makes no device, route, setup-method, eligibility or
qualification inference. Machine `beta` is displayed as Preview.

App supplies cached candidates after search and the current view's membership,
before editable groups. Library additionally narrows results using the existing
`filterPorts` All/Ready/Needs attention semantics, independent of the declared
query. Ready includes staged installations; Needs attention retains unknown,
repair, source, BIOS, runtime and blocked readiness. Ready plus Linux means
current Library readiness and a declared Linux target, not a ready Linux
installation. Core remains the installation/readiness authority.

PortBrowser applies the session Favorites predicate before option counts.
Platform/channel counts exclude their own choices and retain readiness plus
all other groups. Readiness counts retain the declared query and exclude the
readiness selection. Counts are distinct ports, may overlap and need not sum.
Selected zero-count options remain removable. Missing candidate snapshots or
active Favorites without confirmed choices show unavailable, not numeric zero.
Accepted cached snapshots remain usable during refresh failure under the
existing refresh notice. App remounts the workspace by library generation and
its existing snapshot hook discards obsolete async results.

Filtering performs no I/O, scanning, planning or lifecycle mutation. Unfiltered
lists keep unknown declared facts. Launch/install revalidation is unchanged.

The existing per-library browsing preference key is retained. Wrapper version 2
adds an independent Library readiness string; compatible version 1 inputs are
migrated on read. Legacy ready/setup move to readiness with an unrestricted
declared query; legacy channels retain the same evaluator meaning. Structured
queries retain their version and values. Unknown readiness stays visible and
constrains Library results until explicit correction. Unsupported or unavailable
queries stay held for explicit reset, including malformed values. Established
extra predicates are preserved on edits and visibly called out for reset.
Future/unreadable preference records retain their bytes and the existing explicit
retry/reset guards; no second store, Core or generated contract is introduced.

Reset Library filters resets only the declared query. All resets only readiness.
Clear search and filters clears search, query, readiness and session Favorites.
Catalog resets retain their prior behavior. Section/root isolation, details/back,
restart, existing sort and in-session scroll/selection context are retained.
The shared dialog/button controls provide keyboard dismissal and trigger focus
return; removing a focused chip returns focus to Filters. Repeated selections use
functional updates. Closing a panel keeps its already-applied selections.

Contextual device selection, membership/setup-method controls and coherent
route/build/installation/source-set matching remain with #1550. These delivered
frontend composition components do not complete that owner or establish native,
physical-controller, human or game execution qualification.
