# Automatic classification controller integration

Owner: [#534](https://github.com/boburning/portcove/issues/534).

The fixed complete controller now has named classification-writer and protection-
observer source/identity profiles. They keep the existing distinct environments,
App roles, independently authenticated semantic Check and exact outstanding
journal request. They do not add a generic release-input or signing executor role.

The `release-reviewed-inputs` CLI adds read-only production request probes before
App release, a named production observer, and production persistence through the
existing classification CAS. A unique accepted whole-opportunity Check is required;
missing review holds, conflicting/changed inventories refuse, and already persisted
acceptance is skipped. Probe output is routing data with no authority. App-authored
persistence does not establish semantic acceptance.

Both jobs derive their original two-minute provider job clock before token release
and retain the five-second cleanup reserve. Re-running another CLI step cannot
restart that clock. The production writer uses ratified semantic/writer App IDs;
the legacy producer-configuration consistency check remains intact.

Focused validation: 38 tests passed with no skips across existing identity,
source-admission, classification-request and role-controller suites. An initial
probe test expected duplicate/conflicting review to return a routing hold; the
existing stricter matcher refused it. The test now verifies that refusal and zero
writes. No production source or acceptance check was weakened.

This is the adapter portion of the complete workflow connection. Final DAG and
closed locator serialization, actual worker/App configuration, public-key/custody
and protection observation, eligible reservation and protected execution remain
pending. No role, credential or workflow is activated by this change. Capacity
remains bounded-attempt eligibility with Unknown availability/headroom and no
capacity reservation; #254 remains Done, #315/#534/#246 acceptance remains pending,
Chameleon protected acceptance stays unset and slice 5 is excluded.
