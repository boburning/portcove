# Authenticated compiler-source tool asset preparation

Owner: [#534](https://github.com/boburning/portcove/issues/534).

The existing unprivileged controller bootstrap now generates a bounded
`compiler-source-closure.json` from its exact clean source commit/tree, with the
complete fixed producer-path inventory and explicit absent entries. Its bytes
join the existing immutable tool artifact and custom-predicate attestation; no
second signing scheme or trust report is introduced. The receiver requires the
closure's commit/tree to match the independently expected tool source before
materialization. `verifiedControllerToolPaths` returns its owned path only after
the existing actual-provider brand and complete retained-byte readback pass.
Injected and imported receipts cannot acquire that boundary.

The privileged receiver uses the pure closure inspector. Git traversal and
generation stay in bootstrap preparation. Fourteen focused tests pass, including
actual pinned bundle smoke, isolated receiver loading without `node_modules`,
generation from a real temporary Git repository, dirty-source and overwrite
refusals, and rehashed but wrong-source/incomplete closure refusals. The original
isolated-loading failure is retained as
`work/slice4/authenticated-compiler-tool-asset-tests-1.log`; the repaired result is
`work/slice4/authenticated-compiler-tool-asset-tests-2.log`. The eleven-file
inventory still needs its own ordinary hosted build evidence. This preparation
does not itself establish that a candidate compiler used the source or bytes.

The shared native wire contract separately names `payload-signing` and
`release-publication`. Pre-sign captures require exact-package, install, launch,
minimum-platform, runtime-protocol and persistent-state observations. Post-sign
captures require compatible-update, rollback, journal-recovery and
persistent-state observations, with the exact predecessor/source/build tuple and
signed context/signature digests. Both carry separate candidate-build and native
producer identities, actual host/account/loaded-engine observations, process
creation identity and positive process-tree teardown. Four focused inert tests
pass, including missing/failed scenarios, wrong stage, mutable-input separation,
invalid process/account identities and incomplete signed-journey refusals.

That native inspector establishes schema integrity only. It neither authenticates
the host nor mints an accepted native receipt. The genuine native Check consumer,
fixed parent producer, private stage eligibility and exact record/context joins
remain independent engineering. No real native observation, key use, environment,
credential, publication route or production authority is activated here.
