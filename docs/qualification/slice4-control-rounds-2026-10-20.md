# Slice 4 bounded fresh-control rounds — October 20, 2026

Owner: #534. Implementation contract; no protected execution or setting change.

An upload or signature may take longer than the existing 60-second protection
freshness window. The next protected operation needs another actual observation;
extending that window or replaying an earlier successful report is insufficient.

The existing fixed reader and isolated observer now support optional rounds
1 through 12. Each reader creates a fresh 256-bit nonce, publishes its prepared
facts digest and waits in the same process. The immutable ready/observation
artifact name appends `-rN` to the existing phase/run/attempt name. Both bodies
carry `round: {index, nonce}`. The observer discovers the nonce only from the
exact ready artifact; the reader requires its own private nonce in the returned
actual artifact. Wrong round, nonce, run, phase or producer refuses. Legacy
single-round callers keep their original names and formats.

`authenticateReleaseControlRound(directory, factsSha256, phase, index)` creates
one new private directory, writes `ready-PHASE.json`, collects the actual
observation and returns runtime-branded controls. It has no injected-provider
option or credential input. Only actual collected observer artifacts may satisfy
round authentication. A previously used directory or artifact is never replaced.

The fixed observer uses `release-control-ready PHASE N` before releasing its App
credential, then `release-reviewed-inputs observe-production-PHASE N`. Admission's
legacy observer command remains `observe-production`; a round may append `N`.
Readiness evidence and `observation-PHASE.json` are retained under
`RUNNER_TEMP/release-control-ready-PHASE-rN`. Upload only that exact JSON member
under the round-specific immutable artifact name; archive member names stay
unchanged. Each fixed workflow enumerates its finite rounds and stops when its
reader stops. Additional rounds do not appoint another writer or confer signing
authority. The observer keeps Administration-write authority isolated while its
code executes only reads. Its complete job budget and every receipt remain part
of the existing 100-minute resource ceiling.

Focused verification passes 33 cases across the existing handshake, live input,
hosted-process contract and control-input files. It includes round discovery,
wrong nonce/ordinal refusal, live-observer consumption, unavailable and changed
providers, and dependency-free early CLI refusal. The first two focused attempts
exposed an unnecessary early handshake import before the existing refusal
receipt; lazy loading only for explicit round operations repaired that boundary.
All three logs remain in `work/slice4/control-round-focused*.log`. These are local
contract tests with injected providers, not actual hosted round or production
evidence. The earlier actual hosted single-phase proof retains its original scope.

Final fixed job composition, exact resource ratification, independent review,
custody/protections and protected execution remain pending. #254 stays Done;
#315/#534/#246 and Chameleon protected acceptance retain their existing holds.
Slice 5 remains excluded.
