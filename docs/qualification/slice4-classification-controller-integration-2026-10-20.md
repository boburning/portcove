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

Focused validation: 39 tests passed with no skips across existing identity,
source-admission, classification-request and role-controller suites. An initial
probe test expected duplicate/conflicting review to return a routing hold; the
existing stricter matcher refused it. The test now verifies that refusal and zero
writes. Independent review found that the actual identity verifier had not
received the original classification deadline. The call now forwards that same
deadline; the added signed-identity test proves an expired original clock refuses
before provider reads. No production source or acceptance check was weakened.

This is the adapter portion of the complete workflow connection. Final DAG and
closed locator serialization, actual worker/App configuration, public-key/custody
and protection observation, eligible reservation and protected execution remain
pending. No role, credential or workflow is activated by this change. Capacity
remains bounded-attempt eligibility with Unknown availability/headroom and no
capacity reservation; #254 remains Done, #315/#534/#246 acceptance remains pending,
Chameleon protected acceptance stays unset and slice 5 is excluded.

## Building admission continuation

The fixed `acquire-release-admission --building` entry now receives the actual
attested tools, invokes the existing qualifying collector for its genuine native,
compiler/SPDX, independent control and source proofs, and passes that same-process
receipt to the existing durable candidate-building phase writer. Only after phase
and remote reservation readback does it emit the aggregate descriptor. A copied
zero-hold object cannot enter that path; the legacy read-only CLI stays held.

The original seven-minute provider job budget includes tool acquisition and
retains a fifteen-second cleanup reserve. Its deadline is passed through the
existing acquisition handshake and phase writer. Thirty connected admission and
role-clock tests pass with no skips, including wrong-source, imported-proof,
expired-clock and unrelated-hold preservation cases. These are engineering
validation; no actual provider candidate was admitted. Final workflow joins remain
under construction and protected execution remains held.

The building-to-assembly handoff additionally projects the collected API
observation into the existing exact `ReleaseEvidenceRequest` wire schema. A
cross-contract regression collects the fixture through the actual API collector,
shows that its full observation is rejected as an assembly request, and confirms
the projected run/source/tree/workflow tuple passes the maintained consumer.
Malformed run IDs, tree/workflow digests and imported report kinds refuse. The
full API observation remains retained separately; projection grants no authority.
