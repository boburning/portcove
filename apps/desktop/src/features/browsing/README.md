# Catalog and Library declared filters

`CatalogFilters` presents explicit declared platforms, release channels, selected
Library membership, observed installation attention and update candidates using `evaluateCatalogQuery`. Alternatives within a group are
OR; groups are AND. It makes no device, route, setup-method, eligibility or
qualification inference. Machine `beta` is displayed as Preview.

App supplies one accepted generation-bound workspace status snapshot and canonical
selected library identity consistently to result filtering and option counts.
In my library means an active managed installation or registered external runtime;
previous or staged-only records do not establish membership. Membership does not
assert readiness or installed-platform compatibility. Missing library context is
unavailable, never Not in my library; a confirmed empty snapshot is distinct.
Restored membership selections remain visible/removable while context is absent.
Library keeps its existing view narrowing: Not in my library can legitimately
have zero matches there without switching sections or relaxing the query.

App supplies cached candidates after search and the current view's membership,
before editable groups. Library additionally narrows results using the existing
`filterPorts` All/Ready/Needs attention semantics, independent of the declared
query. Ready includes staged installations; Needs attention retains unknown,
repair, source, BIOS, runtime and blocked readiness. Ready plus Linux means
current Library readiness and a declared Linux target, not a ready Linux
installation. Core remains the installation/readiness authority.

PortBrowser applies the session Favorites predicate before option counts.
Platform/channel/membership counts exclude their own choices and retain readiness plus
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

Contextual device selection, setup-method controls and coherent
route/build/installation/source-set matching remain with #1550. These delivered
frontend composition components do not complete that owner or establish native,
physical-controller, human or game execution qualification.

## Observed installation attention

The Installation attention group exposes exact Core reasons for identity-matched
active managed or registered external installations from the same accepted
selected-library snapshot. Missing game files, Missing BIOS and Missing runtime
consume `missing_source`, `missing_bios` and `missing_runtime`; Repair needed
consumes `invalid_installation`. Finish setup consumes `pending_setup` or
`preparation_required` independently of `launchable`. Changed and unreadable
observations never become missing-file matches. Stage-only, absent or malformed
readiness and inconsistent port/installation identities establish no positive
reason; unfiltered browsing retains them.

Attention alternatives are OR, other groups and existing Library readiness are
AND. Distinct counts exclude the attention group's own selections; selected zero
and unavailable choices remain removable. Version-1 queries without attention
keep their semantics; unknown restored reasons remain unresolved for reset.
These observations do not describe complete compatible source sets, install
eligibility or a ready installation for a declared platform. They perform no I/O
or lifecycle authorization. Whole #1551 remains open for route-bound game-file
states and identity-matched available/staged update predicates.

## Observed update candidates

Available at last check and Matching update staged consume Core's saved
`update_available` decision in the accepted selected-library snapshot. The shared
`observedUpdateCandidate` helper also supplies the card's available-update badge.
It validates the expected port/status/active/check, selected channel, installed
version/full artifact and field-wise runtime before the recorded candidate's
channel/version/artifact/required runtime. A verified staged record must match
that candidate; zero candidate size retains Core's unspecified-size convention.
Available excludes its matching staged candidate. Other downloaded versions do
not satisfy Matching update staged. The existing generic downloaded badge still
reports a retained download independently of this exact candidate predicate.

Readiness remains independent: a playable installation can have a staged update,
and a runtime-only candidate can retain the same game version/artifact. These
are observations at the last matching check, not a newly checked/latest release,
installation eligibility or execution authorization. Missing, malformed or
obsolete observations establish neither positive choice nor up-to-date. Unknown
entries stay unfiltered; absent library context is unavailable, confirmed empty
is zero. Query version 1 keeps compatible legacy/absent-group semantics; unknown
restored choices remain actionable through existing reset/correction. The local
predicates carry no private path or installation identity in the persisted query.
No check, scan, hash, network, plan or mutation occurs while matching. Complete
route-bound game-file acceptance remains with #1551.
