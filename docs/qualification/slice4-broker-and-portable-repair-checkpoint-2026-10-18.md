# Slice 4 broker and portable-default repair checkpoint

The owner selected the semantic transport role proposed at merged #2128
(`6c43cb2e6fd0ba2e3a8060befc7b851fbae2af33`). D1/D2/D3 remain selected. This
checkpoint adds implementation and native repair evidence; it grants no protected
execution, credential provisioning, upstream communication, signing or publication.
The [authorization packet](slice4-production-authorization-packet-2026-10-18.md)
remains canonical. Exact native identities, artifact hashes and retained log hashes
are in the [evidence record](slice4-broker-and-portable-repair-evidence-2026-10-18.json).

## Implemented held broker

`release-semantic-inputs.mts` establishes the latest published release and exact
tag through fixed-repository provider reads and repeated identity readback. The
expected classification baseline must agree. It reuses the existing complete
provider comparison and reconstructed Git trees, verifies local trees against
those identities, disables Git replacements and lazy fetch, preflights object
types/sizes, and materializes complete baseline/source snapshots under inert blob
names. Bounds: 16 publication pages, 24 publication requests/120 seconds, 20,000
objects, 16 MiB per blob/manifest and 192 MiB aggregate blob framing. Oversize or
incomplete history refuses. Caller-supplied classification/compatibility evidence
is review input. It cannot appoint authority or establish acceptance.

`release-semantic-runtime.mts` accepts only builder-branded, integrity-checked
inputs. It copies the complete manifest/files before any await and validates the
exact object bijection, lengths, SHA-256, Git blob OIDs and snapshot references.
The trusted prompt requests accumulated-change, classification and compatibility
judgment. Actual parent-captured invocation/session/completion/report must explicitly
accept the exact full opportunity. Imported streams, normal exit alone, incomplete
coverage, changed input, rejected outcomes and command/mutation/tool events refuse.
Parsing synthetic events establishes integrity only. No actual producer report
has been observed.

`release-semantic-broker.mts` accepts only direct branded capture and unchanged
persisted handoff. Issuer authentication follows successful review/tree teardown
and the explicit provisioning guard. The broker checks distinct App/installation,
owner 43177418, exact selected repository 1354613114 and exactly Checks-write /
Metadata-read. Repository, check name, source and report are fixed. It records a
durable exclusive attempt before POST, retains response status/body digest and
validates the actual provider result through the existing consumer. A possibly
effective POST never retries. GET-only recovery requires complete bounded inventory
and exact detailed report comparison, including list/detail drift. This audit
receipt is not a replacement coordinator or execution lease. No POST occurred.

## Observed host boundary and precise remaining engineering blocker

The native primitive creates a fresh AppContainer SID, creates the reviewer
suspended, assigns its Job Object before resume, and checks the actual process
token/SID. Limits are eight processes, 1 GiB aggregate job memory, finite runtime,
16 MiB stdout and 4 MiB stderr through parent-owned bounded pipes. Owned input and
ancestor handles protect custody; reparse/hard-linked inputs refuse before ACL
mutation. Only the fresh task-owned tree receives ACL changes. Credential/capture
paths are unavailable to the child. Job teardown confirms zero remaining processes.

The inert Windows observations establish:

- Normal probe: distinct broker/reviewer SIDs; input readable; issuer sentinel,
  input writes and capture writes denied; issuer environment absent; empty tree.
- Hard-link probe: refused before ACL changes; task-owned external canary ACL
  unchanged.
- Flood probe: exactly 16,777,216 stdout bytes retained; incomplete capture,
  forced termination, empty tree, profile deleted, refusal.
- Detached descendant: root exited normally but a remaining child forced owned
  tree termination; empty-tree readback, profile deleted, refusal.

These probes use inert credentials. AppContainer work/profile storage remains
writable without a hard quota, and a safe source-reading mechanism that cannot
execute candidate bytes is unassembled. Inert filenames/instructions and event
refusal do not enforce either property. **Codex mode therefore unconditionally
refuses before effects.** This is the precise integration blocker; no credential
provisioning request is ready yet. Finish those enforcement mechanisms and qualify
the actual existing Codex authentication/network route before removing the hold.
WindowsSandbox.exe and the Hyper-V New-VHD/Mount-VHD cmdlets were unavailable in
the observed host session; vmcompute.exe presence does not establish a provisioned
bounded VM. No owner approval alone supplies that environment. The old Job I/O
rate API is [unsupported on modern Windows](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-setioratecontrolinformationjobobject)
and is not proposed as storage enforcement. The
[AppContainer boundary](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
is distinct from a filesystem quota and application execution policy.

## #144 upstream repair

The [prepared patch](patches/slice4-144-portable-generated-defaults.patch) targets
`RetroPortingToolKit/psxrecomp`, default branch `master`. The real .35/.36 packages
both use reviewed framework `6af3a69dd35a17b411f3e04e229aba76203fa600`; they retain
their failed full-default-persistence status and useful previous native evidence.
No source or native host request is needed.

The fix introduces an ephemeral runtime-generated default rooted at the manager's
current mods directory: `texture-packs/<sanitized-game-id>`. Registration captures
an absolute resolution base in memory, so later cwd changes do not alter it.
`set_root` clears derived defaults. They are never serialized as player selections.
Explicit user paths take precedence, including missing legacy absolute paths.
Manifest-relative defaults keep existing containment checks. No migration guesses
whether an old absolute string was generated or deliberately selected.

The pre-change oracle reproduces the disabled-default relocation failure with
old A unavailable. Patched native framework builds exercise exact B-root live
launcher getter, enabled commit/plugin activation, cwd change, getter/resolver
agreement, rooted/traversal refusal and preservation of an unavailable external
absolute selection. The UI-enabled build uses exact recomp-ui
`b964eabe5a3438b8ed121064354ba27c1accef3f`, immutable local clang/CMake toolchain
1.0.14 and the hash-verified vendored CHD dependency, offline, two compile jobs.
The package suite passes; the runtime suite retains its unrelated existing
`file identity rejects same-size restored-mtime replacement` failure. This is
focused repair evidence, not a wholly passing upstream suite or a game build.

The patch applies to observed upstream master
`53a057f548cd1f93f1b4d8300caaeded72f4160d`. A separate UI-enabled patched master
build also passes the repair assertions and package suite while retaining the
same file-identity runtime failure. The first master runtime launch was refused
by source-change admission after compilation; it is retained separately from
the later stable-source execution. The
[prepared submission](slice4-144-upstream-submission-2026-10-18.md) states the exact
target, title, body and evidence. Current access is pull-only. Submitting that
specific upstream patch requires communication authorization; none was exercised.
Actual upstream incorporation and two eligible real game artifacts remain absent.
Local test executables have retained identities but cannot substitute for release
asset identities. Core materialization, launcher/install/update/rollback and the
combined #246 protected journey remain pending. #144 stays outside the compiled
catalog until a suitable pair and unchanged capable-client baseline/initial absence
exist. Existing Gen2 entries and component evidence retain their scope.

## Integration and next dependencies

D2 remains bounded-attempt eligibility inside the ratified account-wide $0 Actions
stop-usage boundary, standard public runners and existing resource policy.
Availability/headroom are Unknown and there is no capacity reservation. This pass
adds no hosted AI/input job or billing App and does not change held workflow bytes,
concurrency, timeouts, archives/cache or seven-day retention. Existing authenticated
capacity configuration and local pending/recovery adapters remain applicable.

Remote pending-before-effect durability and exclusive executor/readback ownership
must still be assembled under the existing coordinator and fixed protected job.
Identical CAS readback does not grant executor ownership. No eligible candidate or
reservation is asserted. Refusal/ambiguity must retain actual phase/completed effects
and use explicit existing bounded recovery before a later attempt.

Before any protected execution request: resolve the runtime enforcement blocker;
finish actual producer binding after separate credential authority; complete exact
operator spending/protection observations and applicable custody/public-key evidence;
assemble remote pending/executor readback; then freeze and review the runnable
controller revision/digest, full protected ref, actual eligible candidate/reservation,
operator, namespace, permissions, destinations and bounded proof sequence. The
current held source is not that activation candidate. Assembly/attestation is one
stage; #534 signing, publication, feed, custody and recovery obligations remain.
#254 stays Done; #315/#534/#246 acceptance stays pending; Chameleon acquisition and
independent review are retained while protected_acceptance stays unset. Slice 5 is
excluded. No general curated policy or selected transport decision is reopened.
