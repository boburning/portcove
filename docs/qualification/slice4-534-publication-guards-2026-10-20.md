# Slice 4 publication guards and bounded recovery

Owner: [#534](https://github.com/boburning/portcove/issues/534). This increment
connects existing release preparation and executor contracts. It activates no
workflow, App, key, protected setting or production effect.

## Implemented behavior

The release-publication phase asks the isolated Administration observer to read
the repository immutable-release setting before and after its protection
inventory. The observer remains GET-only. Other input phases retain their
existing narrower coverage. Actual publisher admission requires fresh,
authenticated complete observation with immutable releases enabled; a copied
policy object or available publisher token supplies no authority.

The actual owned Release wrapper requires the private publication-stage
admission, its exact assembly, archive identities, namespace and initial
checkpoint, and the same authenticated reader/executor job. It checks controls
again immediately before each provider effect. Signing-stage contexts cannot
enter publication. Distinct logical effects get fresh nonce-bound control
rounds; refusal or ambiguity stops the attempt rather than retrying it.

The journal transport uses only `PORTCOVE_COORDINATOR_JOURNAL_TOKEN`, with an
attempt-private GitHub configuration and scrubbed environment. Provider readback
and the separate Release publication credential do not supply journal write
authority. Actual recovery may record one exact observed completed effect after
the original executor is terminal. It cannot overwrite an existing receipt,
erase partial progress, change the candidate or retry an unresolved operation.

Release preparation now stages all six selected beta packages and their
checksum directly from the opaque aggregate retained by actual provider and
Sigstore verification. It checks the archive digest, complete fixed inventory,
raw ZIP bounds, each member length, CRC and SHA before a nonreplacing write.
There is no caller-selected package directory or generic extraction step.
Earlier verified files survive a later failure. Independent SPDX, compiler,
native, semantic and signer-output acceptance remain separate requirements.

A fresh metadata worker can also materialize the journal-pinned public
application component with exact generation/root/repository digests, bounded
credential-free HTTP and a bracketed marker. This supplies inert bytes only;
the existing independently pinned Tough verifier still authenticates renewal.

## Evidence and limits

At `2026-10-20T19:29:09Z`, the existing authorized repository read returned HTTP
200 for `GET /repos/boburning/portcove/immutable-releases`, with `enabled: true`
and `enforced_by_owner: false`. This establishes the setting at that observation,
not a new authority, guaranteed future setting or publication acceptance.

The actual-Git executor/recovery fixture passed both cases after correcting an
obsolete schema-1 fixture boundary to the current schema-2 single-receipt
contract. Retained logs are `work/slice4/executor-separated-journal-recovery.log`
(initial failure) and `executor-separated-journal-recovery-2.log` (two passing
cases, 49.416 seconds execution). The fixtures use simulated provider/OIDC
responses and distinct inert credentials. They establish durable intent,
credential separation, observed-effect recovery and refusal behavior; they do
not establish live publisher authentication or production effects.

The focused aggregate/publication contracts pass 24 cases, including complete
six-package staging, wrong archive refusal, retained partial files, fixed
one-effect provider transport and refusal of fabricated stage contexts. Seven
public-component materialization cases and the existing protection/control
contracts retain their applicable component evidence. Independent non-writing
review cleared the materializer, observer, journal separation, owned wrapper
and recovery integration. Exact-head hosted CI remains the delivery record.

The installed native qualification, authentic semantic report, immutable signer
handoff, first feed bootstrap and final coherent controller graph remain
integration work. Initial setup must subsequently bind the actual runnable
revision/digest, scoped authorities, custody, protections, resource policy and
eligible coordinator state before protected execution. Availability and headroom
remain Unknown; the spending boundary is not a capacity reservation. #254 stays
Done; #315/#534/#246 acceptance stays pending, Chameleon protected acceptance
stays unset, production stays held and Slice 5 is excluded.
