# Catalog declared filters

`CatalogFilters` presents explicit declared platforms and release channels using
the existing `evaluateCatalogQuery` contract. Alternatives within a group are OR;
groups are AND. It makes no device, route, setup, eligibility or qualification
inference. Machine `beta` is displayed as Preview.

App supplies cached Catalog candidates after search, before editable groups.
PortBrowser applies the session Favorites predicate before evaluating option
counts. Each group excludes its own choices while retaining every other group;
counts are distinct ports, may overlap and need not sum. Selected zero-count
options remain removable. Filter selection performs no I/O, scanning, planning
or lifecycle mutation. Unfiltered lists keep unknown declared facts.

The existing per-library browsing context stores versioned query/search/sort.
Known legacy channels convert without changing intent. Unsupported or unavailable
restored queries stay held for explicit reset, including malformed predicate
values. Other established predicates are preserved on edits and visibly called
out for reset. Reset catalog filters preserves search and Favorites; the existing
Clear search and filters action clears those session constraints as well.

The shared dialog/button controls provide keyboard dismissal and trigger focus
return; removing a focused chip returns focus to Filters. Repeated selections
use functional updates against current query state. Closing a panel does not undo
its already-applied selections. Library readiness shortcuts remain unchanged.
Library composition, contextual device selection and coherent setup/route
matching remain with #1550; this component does not finish that owner.
