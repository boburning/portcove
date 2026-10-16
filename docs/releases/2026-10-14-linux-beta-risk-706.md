# Ordinary Linux beta: scoped GLib risk acceptance

The canonical [#706 approval](https://github.com/boburning/portcove/issues/706#issuecomment-6182222682)
accepts a known defect for ordinary Linux Public beta. It does not establish that
GLib is fixed, safe or universally unreachable. #706 and consuming #49 remain
open for actual remediation; Project commitment Planned is not release eligibility.

## Scope and expiry

Only RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g, registry GLib 0.18.5,
`x86_64-unknown-linux-gnu`, Desktop defaults plus `tauri/custom-protocol` and
reconfirmed production native inputs are covered. @boburning owns acceptance and
remediation. Qualification/webdriver features, Deck and other platform support
are outside this acceptance. Unaffected-platform validation remains separate.

The acceptance expires November 14, 2026 at 23:59 America/New_York
(`2026-11-15T04:59:00Z`), or before publication of the second ordinary Linux beta
after approval, whichever is first. No automatic renewal is allowed.

The original assessment at `3b25e32d9eb776790790b128f18d8d6ea4e37e52` used lock
SHA256 `4d545b6a71c3c285c7e55f6b84dd1fd3ebcd4d389b1012b8d66dfd3f5339eea6`.
Its bounded source trace found no production constructor/consumer of the affected
iterator. Upstream demonstrated optimized-build crashes from undefined behavior,
not Portcove exploitation. An overlooked call could terminate Desktop and
interrupt in-process mutation workers; data loss and attacker-controlled effects
remain unproven, and effects cannot be limited to crashes.

## Relevant candidate reconfirmation

The implementation baseline `8fb708d32a427e5a9c728e9e260cdd3d6e8b29ac` has lock
SHA256 `4307115323c5f4c9edb97ca8c1877f21f9a85ef27292b366d012d4013669837c`.
It changed Tauri to 2.12.3, runtime/runtime-wry to 2.12.1, Wry to 0.57.0,
Tao to 0.37.1, Muda to 0.20.0, dialog to 2.8.2 and build/codegen/macros to 2.7.2.
GLib 0.18.5, GTK 0.18.2, GIO 0.18.4 and WebKit2GTK 2.0.2 remain unchanged.
The constructor/trait analysis is reused for unchanged GLib. A bounded refresh of
the affected ancestor and generator source (1,579 files, including the changed
native application source) again found no production constructor consumer;
published-source files matched lock-bound crate archives. This is source evidence,
not native execution, complete macro expansion or universal unreachability.
The owning issue records independent review and any limits of this reconfirmation.

Target integration at `103015efe1d03632044878cf188d5511164f5729` was examined
separately: the native delta adds qualification-feature-only navigation controls
and Windows test diagnostics. Ordinary default-feature behavior and resolved
native dependencies are unchanged; no affected iterator constructor is introduced.
The protected fingerprint was refreshed for those conservatively tracked bytes,
reusing the prior production dependency and constructor analysis.

PR #1997's qualification repairs through `f6a37948249600fee2597b48ccd42b475424076c` were
also examined as a bounded native delta.
They box the private error context, preserve the existing public failure report,
apply mechanical control-flow lint fixes, and correct test fixtures and test-only
callback lifetimes. Host-platform, native filename and partial-copy fixture
corrections retain the underlying preservation/refusal assertions. They add no
GLib API, iterator constructor, dependency,
production feature or code generator. The unchanged lock and resolved dependency
evidence is reused; the protected native-input fingerprint is refreshed for the
reviewed source bytes. This is a source assessment, not a universal reachability
or native runtime safety claim.

The accompanying qualification repairs retain analyzer thresholds and test
assertions. Nine exact platform-node/tool/switch values receive documented,
value-wide rscheck portability allowances; unrelated absolute paths still fail.
An actual pinned-scanner control reproduces eleven denies with the original
policy, two unrelated denies with the amended policy, and zero denies for only
the nine reviewed values. The compatibility test's `.mjs` to `.js` rename lets
Fallow recognize an already executed Vitest test; it removes no test or assertion.
The frontend native harness uses Ubuntu 22.04, matching the maintained Linux
native target, with an executing namespace preflight and no host privilege or
security-policy change. Success there does not qualify Ubuntu 24.04 or expand
platform support. Startup refusals now retain bounded original stderr.

The protected `.github/linux-beta-risk-706.json` pins native-source and resolved
dependency/code-generator fingerprints. `candidate706` recomputes them for the
actual source head and lock. Release version metadata and unrelated documentation
or frontend edits do not invalidate that evidence. Changed relevant inputs block
until their delta has been reassessed and the protected record reviewed; no new
permission is required merely to reuse unchanged evidence under this approval.

## Protected qualification recheck

The [fresh audit at `22e303a`](https://github.com/boburning/portcove/actions/runs/38687345604)
executed all independent stages and retained a failed diagnostic-only bundle:
Rust Clippy and the original GLib scan failed. The separate disposition refused
because the unrelated Rust failure remained. The [full qualification attempt](https://github.com/boburning/portcove/actions/runs/38687343859)
also retained all native results: Linux, Mac ARM and all four doctest platforms
passed; Linux Clippy, the dependency-free Windows contract job and Intel native
cases failed. Neither workflow is passing qualification evidence.

Reconfirmation at `cd7b99e11728c03b59a71c6af882b2394d0688b8` changes only
four Rust test inventories, including the `library.rs` test module. Production
Rust behavior, the lockfile, resolved native dependencies, enabled features and
code-generation inputs are unchanged. The protected record updates the
conservative native-source hash; the unchanged application-risk trace is reused.

The bounded follow-up removes three fixture-only Clippy causes and one needless
borrow, and evaluates the actual field-presentation helper in the dependency-free
unit contract without loading desktop-driver packages. Intel cache, retained
rollback/launch and admitted-scope failures receive phase diagnostics. Their
five-second latch and thirty-second test bounds, real signed full-catalog work,
restart, child-start, trust and persistence assertions stay intact. Diagnostics
are not a repair or permission to waive those failures. The owning PR records
subsequent exact-head review and qualification results.

## Owner-approved qualification timing calibration

The [instrumented qualification at `a1ed49b`](https://github.com/boburning/portcove/actions/runs/38694081625)
completed all jobs but failed two Intel copy-observation latches and the retained
rollback-withdrawal test. Download began 4.778 and 4.628 seconds into the two
five-second latches without observing first copy. The rollback test completed
its first rollback/preservation but reached thirty seconds during the second
rollback. Later Conflict results and forward progress do not qualify the missing
observations. The [fresh audit](https://github.com/boburning/portcove/actions/runs/38694084246)
was canceled by its thirty-minute outer job limit during Rust tests, after 1,761
recorded passes. Later stages and the scanner were not reached; that audit is
incomplete and cannot be substituted by a separate scanner run.

The owner [separately approved the reviewed finite calibration](https://github.com/boburning/portcove/issues/706#issuecomment-6190196270)
on October 15. Only Intel macOS's retention-revocation/withdrawal during-copy
latches receive ten seconds from the unchanged whole-install starting point.
Only Intel's exact retained rollback-withdrawal case receives a 45-second nextest
budget with its five-second slow alert. Both actual rollbacks, restart, trust,
preservation, partial/incomplete-copy, drain, conflict and journal assertions
remain. Two-slot reservations and zero retries remain; other cases and targets
keep existing limits. Existing contract tests reject a broad filter, wrong or
absent target, or an enlarged override.

Only Deep audit's outer audit job receives 45 minutes; local-check stays at
30 minutes. No independent stage or internal acceptance condition is omitted.
The final reviewed source must complete fresh audit, exhaustive maintained-platform
qualification and distinct Windows qualification. Proposed longer bounds were
not passing evidence; subsequent failures remain blocking. This timing decision
does not amend the GLib approval's scope, expiry or publication identity and is
not permission to accept unrelated qualification failures. Original failed
attempts remain retained. Final exact-head results belong to PR #1997.

The timing-only source reconfirmation is `71619ab12c3cc0bfe10ce5b667f575a519195fb7`,
with conservative native input fingerprint
`d768e94fd232c5950177bd4565e123e3771084b703adf3f54a7357cdcc750aa0`.
Only the publisher-policy test source inventory changed from the prior
reconfirmation; production inputs, lockfile, resolved native dependencies,
enabled features and code-generation fingerprint remain identical. Reuse the
unchanged bounded application-risk evidence; this is not universal
unreachability or remediation.

## Approved exact cancellation-latch addendum and target reconciliation

At `6de10f891bf364aac6cb3541f9844e02f11e39b8`, the two approved Intel copy
cases passed and retained rollback completed in 35.602 seconds. A different
cancellation-retention test failed its unchanged five-second latch: no first
copy was observed. The later cancellation is not during-copy evidence. The
owner [approved the exact additional Intel case](https://github.com/boburning/portcove/issues/706#issuecomment-6191752545)
on October 15. Only `CacheIntervention::CancelRetain` is added to the existing
ten-second branch. Timer origin, actual partial/incomplete copy, cancellation,
worker drain, journal/preservation, overall thirty-second limit, two-slot
reservation and zero retries remain intact. Other cases/targets are unchanged.

The [complete fresh audit on 6de10f8](https://github.com/boburning/portcove/actions/runs/38726012175)
ran all ten stages within the approved 45-minute limit. Nine passed; dependency
policy retained original exit 1 and raw aggregate success:false, with the exact
separate approved qualification decision and scanPassed:false. Downloaded
original inputs/receipts, manifest hashes, source/run/attempt binding and scanner
output verified using production validators. Its bundle remains diagnostic-only,
not a reusable green audit receipt. A single controlled Windows storage rerun
passed all 25 integration cases, 388 diagnostic cases with 27 existing platform
skips and PowerShell lint, under unchanged budgets. Its earlier PowerShell child
timeout remains unexplained and is not described as causally fixed. All failures
remain retained. These observations stay bound to their original source/attempts.

Main advanced to `5b498cf68fea2dba194044766ff4cce13c5a51b7` during qualification.
The only overlapping test file retains both independent helper/test insertions,
external retained fixtures, the reviewed positive publication deadline parameter
and explicit negative expiry controls. The separate combined tree passed all
36 focused controls and received independent review before actual reconciliation.
The reconciled implementation requires its own final review, native fingerprint
reconfirmation and all applicable exact-head qualification before delivery. No
production native dependency, feature or affected iterator path changed.

The actual guarded composition check exposed four newly added retained-store
fixtures under disposable temp ancestry and an unregistered Linux-stop test file.
The fixtures now use the existing owned external retained-fixture helper, keeping
every mutation/refusal assertion. The new inert Linux-stop contracts are included
in both maintained CI consumers and the local development-tools inventory.
The failing observations are retained; all 168 focused workflow/policy/audit,
retention and Linux-stop controls pass after these exact setup repairs. No custody
guard, scanner scope, test deadline or production behavior is relaxed.

The approved cancellation-latch source reconfirmation is `3f370fd75a0cc16e37a8262b36577949809b86e9`
with native input fingerprint
`06508d140e42471d8a0818293eb50ebfc6cc5331d61225afe70b2270e3fa426d`.
Only publisher-policy test source differs from the preceding reconfirmation;
lockfile, resolved native dependencies/code generation, production inputs and
enabled features remain identical. The unchanged bounded application-risk trace
is reused. Final reviewed source and all qualification results are recorded on
PR #1997; this does not establish remediation or universal unreachability.

The [ordinary c8af954 CI attempt](https://github.com/boburning/portcove/actions/runs/38733757002)
retains a ten-second timeout in the unchanged PowerShell field-projection
fixture, with empty child stdout/stderr. Its phase is unknown; a local pass does
not establish a causal fix. The same fixture now emits seven short fixed phase
markers and elapsed times inside its existing bounded diagnostic capture.
Actual PowerShell AST extraction/call/guards, positive/adverse assertions,
stdout success marker, ten-second child limit and thirty-second outer limit
remain unchanged. Local original and instrumented controls pass; all 184
selected workflow, policy, audit, retained-evidence, Linux-stop and native-helper
controls pass with zero skips. This qualifies the diagnostics only. A later
hosted pass is an observation under the unchanged contract, not a claimed repair
of the original timeout; a repeat failure requires its phase evidence.

## Execution and separate decision

`just deny` preserves the scanner's original exit status and full structured
stdout/stderr in `work/linux-beta-risk-706/`. The same all-target/default-feature,
workspace advisory/bans/licenses/sources coverage is retained, with the approved
`unsound = "all"` correction applied to a retained execution copy if #1993's
declarative setting is not yet delivered. Both original and execution configuration
bytes/hashes are retained; no maintained `deny.toml` rewrite occurs. The matcher requires
the pinned scanner, the exact reviewed full-unsoundness policy, complete summaries,
one matching GLib error, and no additional advisory/error or execution failure.
The pre-existing configured duplicate and proc-macro-error unmaintained warnings
remain warnings. Missing/partial output, wrong candidate, wrong coverage and
unexpected findings fail closed. No ignore, dismissal or generic continue-on-error
is used. A failed scan remains failed, including in audit receipts and summaries.

Qualification's dependency consumer and `just audit --fresh --linux-beta-706`
can record a separate `accepted-risk` qualification decision for that finding.
Every other stage must satisfy its existing contract. Raw failed audits never
become successful reusable receipts. Attempt-bound bundles retain approved
raw failures as diagnostic-only evidence, including original exit 1 and the
separate policy-operation status. Reuse admission still refuses those bundles. The protected transition requires the
existing complete fresh pre-change audit and exhaustive exact-head qualification
on all maintained platforms, plus independent review; acceptance is not a shortcut.

The qualification recheck found tauri-build 2.7.2 CRT search paths leaking
into sibling-package Windows doctests without their matching link arguments.
Maintained doctest callers now separately select the non-Desktop workspace and
Desktop package, retaining every member, default features, platform matrix and
original failure status. Production CRT configuration is unchanged. The
upstream-observer test fixture is initialized before test registration to avoid
its demonstrated temporal initialization error; its assertions are unchanged.

Release validation invokes `just audit --fresh --profile release --linux-beta-706`.
It refuses an affected graph with a green direct-only scan. It also refuses release
reliance while `firstPublicationTag` is unallocated. At the actual first candidate:

1. Reconfirm relevant native source/dependencies/features, current advisory/impact
   evidence and absence of a compatible fix; reuse unchanged source evidence.
2. Record that candidate's exact first publication tag in the protected approval
   record through ordinary review/qualification. Never reallocate it to another
   tag under this approval. It remains the budget identity after deletion or a rerun.
3. Run required checks and retain the original scan, exact source/lock, separate
   decision and complete paginated release/asset inventory. A matching decision
   is not signing or publication authority. Recheck expiry/triggers immediately
   before any separately authorized publication; release workflows only stage drafts.

Relevant crashes, new exploitation/impact evidence or a compatible fix require
reassessment even when byte fingerprints are unchanged. They cannot be detected
by source matching alone; @boburning must withdraw/revise reliance in #706 and
the protected record before proceeding. Do not treat a Planned field as approval.
Expiry or unmet conditions restore the Linux hold regardless of Project fields.

Roadmap doctor recognizes the exact canonical #49/#706 Planned, Blocked, Security,
Linux remediation records under this dated approval without forcing them back to
Required. Ordinary readiness and immutable snapshots still show a pending scoped
disposition and remain NOT READY. For the actual ordinary Linux candidate,
`node scripts/roadmap.mjs readiness --release "Public beta" --linux-beta-706`
executes the full scan and the same release evaluator using the reviewed
`GITHUB_REF_NAME`; it retains the raw result and separate decision. Only a valid
candidate decision conditionally satisfies these two open remediation nodes.
All other blockers, dependency coverage/cycles and #215's later qualification
remain enforced. Candidate implementation scope, 1.0 and Deck receive no exception.

#1993's scanner coverage candidate retains its own review and applicable protected
qualification. Once this path is reviewed and delivered, its resume condition is
complete qualification with the exact finding separately accounted for, not an
accidental requirement that GLib first be fixed. Actual graph remediation,
undismissed alert resolution and affected Linux qualification remain issue-closure
criteria. Later #215/#217/#535 Deck qualification remains unchanged.

## Package 2 scanner follow-up reconfirmation

The native-source delta in `40e850fcb38d01233535734825b3ebf28401fbf0` adds only
test diagnostics above the delivered baseline. The Core delta adds elapsed phase output to
existing publisher-policy fixtures; the entire module is included through
`definition_repository.rs`'s `#[cfg(test)]` module. The Windows delta adds wrapper
stderr markers and bounded failure context to the existing picker-refusal test.
It changes no native helper, production call path, assertion, fixture input,
permission, timeout, retry, resource reservation, dependency, enabled feature or
code generator. Separate non-writing review cleared both deltas. No GLib API or
affected iterator constructor is introduced.

The conservative native-input fingerprint changes to
`d934c863b768d00961fd23ee169f19c7ae8c336227813af3e08481d22427f902` for
those tracked test bytes. The resolved dependency/code-generation fingerprint
`80bab63cf9f86838b1517c42767894bdc5151e09dafd41e22bbf97e220a365f2`,
lock SHA256 `4307115323c5f4c9edb97ca8c1877f21f9a85ef27292b366d012d4013669837c`
and scanner policy remain unchanged. Reuse the existing bounded production
application-risk analysis under the same owner approval, scope, expiry and
unallocated publication identity. This reconfirmation is not remediation,
universal unreachability, runtime safety or passing qualification evidence.

The prior scanner-only source38 audit and both failed qualification attempts
remain original-source evidence on PR #1993. Its single fresh-Intel comparison
reproduced the policy-loss copy latch and cache-reuse cutoff failures; no further
unchanged rerun followed. Diagnostic source983 retains all existing limits. The
changed observation and this conservative binding refresh do not authorize a new
timing exception or accept any failed/incomplete required stage. Final exact-head
review, complete protected qualification and normal guarded delivery remain due.

## Delivered frontend toolchain reconfirmation

The package 2 candidate consumes independently delivered [#2002](https://github.com/boburning/portcove/pull/2002),
source `2b39b06fc92a6bbd6961d434d5d15be60863b6c5`, merge
`34e433feaf5e5db4817cdc692c13dac1b715d5d4`. Its Vite+ 1.2.0 and coordinated
Vitest/provider 5.0.4 replace the previous frontend build tooling. The integrated
reconfirmation source is `34cb48c1dc2cf5e3e8461acd64bdf0e712bb9d22`.

All 192 normalized native inputs were compared independently. Only Tauri's
`beforeBuildCommand` changes: `pnpm build` becomes
`node scripts/build-frontend.mjs`, invoking the delivered wrapper and Vite+ build.
Production Rust source, Cargo manifests/lock, native features, native generator
dependency closure and assessed GLib call paths are unchanged. The additional
Node test reporter retains four bounded worker-exit fields. It removes no existing
test or assertion and changes no execution deadline, worker isolation or native
input. Its added real exit7 control preserves the failed outer run. It does not explain the
earlier hosted worker failure.

Actual integrated recomputation gives native-input fingerprint
`888c31cd0294b4ed8752ac410896bc620e2d76ab289aac7cf999a3be8f8064ad`.
The resolved dependency/code-generation fingerprint remains
`80bab63cf9f86838b1517c42767894bdc5151e09dafd41e22bbf97e220a365f2`,
and lock SHA256 remains
`4307115323c5f4c9edb97ca8c1877f21f9a85ef27292b366d012d4013669837c`.
Separate non-writing review cleared this bounded reconfirmation under the
existing approval. Owner, advisory/version, scope, expiry, scanner policy and
unallocated publication identity remain unchanged.

Source746's audit and failed qualification remain historical evidence. They do
not qualify this integrated frontend/build stack. Fresh exact-head ordinary
checks, complete audit and maintained qualification, final independent review
and guarded delivery remain required. GLib remediation and minimum-environment
acceptance remain outstanding; this reconfirmation supplies neither.

## Vite+ consolidation input reconfirmation

The bounded reassessment at `fd5e8b499ed764f6edb398fcf79064992b14b459`
accounts for exactly two fingerprinted-file changes since `3f370fd7`:
Oxfmt's meaning-preserving Cargo workspace array formatting, and #2002's
already-delivered Tauri frontend build command (`pnpm build` to
`node scripts/build-frontend.mjs`). The launcher reaches the declared installed
Vite+ executable, preserves signing isolation and production fixture exclusion,
and does not change native GLib iteration or code generation. No Rust source,
native manifest, toolchain, `.cargo` input or Cargo lock changes occur in that
range. Replacing those two fingerprint entries with the approved preimages
reproduces the previous input digest exactly.

The reconfirmed conservative input digest is
`eec15b842f4f8bf6474e99fd6448715f9b3843a63a963d9fc76569d46b6b3fb1`.
The resolved dependency/code-generator digest remains
`80bab63cf9f86838b1517c42767894bdc5151e09dafd41e22bbf97e220a365f2`;
native build-environment overrides remain unset. Reuse of the unchanged bounded
application-risk evidence follows the existing approval's reassessment procedure.
This reconfirmation changes no advisory, severity, scanner policy, acceptance
scope, expiry or publication identity. PR #2005 must still obtain separate
review and complete exact-head protected qualification; failed scans and earlier
qualification attempts remain retained with their original outcomes.

The subsequent bounded test-only reassessment at
`2b88684c1c1169eb9b6b300533fee6ffc4dcd310` changes exactly one further fingerprint
entry: `crates/portcove-core/src/definition_publisher_policy_tests.rs`. Its fixture
reuses one observation service around live launch-assessment updates, removing
two redundant selected-catalog loads. Both actual launch attempts still reopen
independently, and every assertion, timeout and reservation remains unchanged.
Four affected Windows launch/status cases passed; current-head Intel macOS
qualification remains separately required. Replacing this one entry with its
`fd5e8b4` Git preimage reproduces the preceding conservative digest exactly.
The resulting input digest is
`fcb3a6fa61fabc22d15abc1e97d8976c7d0071082744106fbe9c6b0a551f9d28`.
The full resolved native inventory, Cargo lock, feature set and build-environment
entry match the preceding candidate. Production source and APIs are unchanged.
Only `reconfirmedHead` and `inputsSha256` change in the protected record; the
original finding, failed scans, expiry, scope and publication hold remain intact.

## October 15 consolidation timing continuation

The owner [approved exactly two further Intel copy-latch cases](https://github.com/boburning/portcove/issues/706#issuecomment-6205805576)
during #2004 delivery: `PolicyLoss` and `ArtifactRevocationRestore`. Their
whole-install-to-copy latch joins the existing Intel macOS ten-second branch.
Other cases and platforms retain their existing limits. Timer origin, every
actual partial/incomplete-copy, intervention, unfinished-worker, drain, journal,
byte-preservation and cleanup assertion, the thirty-second whole-test budget,
two-slot reservation and zero retries remain unchanged. The complete embedded
catalog and authenticated selected-definition binding remain in the fixture.

Run `38830800384`, attempt 1, retains both failures at five seconds: PolicyLoss
first reached the actual 64 KiB copy 5.756 seconds after installer start;
ArtifactRevocationRestore timed out without reaching the copy latch. A later
refusal does not establish intervention during copying. Ten seconds remains a
bounded trial requiring successful affected tests, independent review and full
current-head qualification. This timing authority changes no advisory, expiry,
scanner outcome, product deadline or publication hold.

The two separate whole-test installer failures receive no time extension. Their
unchanged catalog/platform qualification is captured once and cloned per request;
each request still performs its live acquisition-resolution and installer checks.
All actual metadata reads, refusals, installs, corruption/capacity checks and
preservation assertions remain. Eight affected Windows cases passed before the
copy-latch continuation; Intel completion remains a separate hosted obligation.

The final conservative-input reconfirmation at
`432d122573289f67cf2ef65e6cce7565ac4f236d` accounts for the immutable test
qualification reuse and the explicitly approved two-case Intel calibration.
Exactly the same test-only Rust file differs from `2b88684c`; substituting its
previous Git preimage reconstructs the preceding `fcb3a6fa` digest exactly.
The new input digest is
`7503ce74813293718abb92b2214d405ecdaf773e1c6b732b2fcd0467e21694cb`.
Input names, complete native dependency/code-generator inventory, features,
Cargo lock and build-environment entry remain identical. Fifteen affected
Windows installer/copy-worker cases passed with their original platform limits.
Only the protected record's head/input digest change; Intel completion and
all required current-head gates remain separate obligations.

## October 16 installer contract separation

Run `38835270649`, attempt 1, retains an Intel cache-lifecycle timeout at
30.020 seconds. Its phase diagnostics reached immutable qualification at 4.813
seconds and completed the preliminary refusal sequence at 26.483 seconds.
The approved PolicyLoss copy-latch case passed; that does not qualify the
separate whole-test failure or permit another timing extension.

The repair at `bbe5759ce5a735599d2dce1e4bdabcddaf235a41` gives stale-resolution
and changed-artifact-byte refusals their own named, real Installer tests.
Both controls previously ran identically before each of two unrelated lifecycle
tests. Their original refusal, request-count and zero-install assertions remain,
with explicit empty-response-queue checks. The cache lifecycle still performs
the actual interrupted installer, subsequent verified cache hit without an
artifact response, corruption, lock and capacity-preservation checks together.
The admitted-scope lifecycle downloads its actual payload, checks four requests
instead of the cache hit's three, then retains both live metadata resolutions
and every identity, repin and incomplete-history refusal. Complete authenticated
catalog setup, all causal sequences, thirty-second per-test limits, two-slot
reservation and zero retries remain. Ten affected Windows cases passed; Intel
and complete exact-head hosted qualification remain separate obligations.

Only the same test-only Rust fingerprint entry changes. Substitution of its
`432d1225` Git preimage reconstructs `7503ce74` exactly. The new input digest is
`ecdc7f34e22409da462ce4cbba6505083ec4270e9fbb527cd589905cf8e7a3d2`.
All 192 input names, resolved native dependency/code-generator inventory,
features, Cargo lock and build environment remain identical. The protected
record changes only `reconfirmedHead` and `inputsSha256`; no advisory, scope,
expiry, scanner outcome, publication or timing authority changes.

## October 16 Package 2 final-toolchain integration

The normal integration candidate `4ee4f5043887d32237da3478b1ec70d1ef85fd39` consumes delivered
#2005 (merge `d74bae3fa6e3ad1058702fc0779689acf5f4505d`) and #2010
(merge `9a9ca222d28df8ffd089f551c2f0393fc60e1a53`). It preserves their production build/task ownership,
picker preflight, split installer refusals, immutable qualification reuse and
exact owner-approved timing branches. Superseded Corepack/task and projection
fixture repairs are removed; no new limit or exception is introduced.

The 192-entry native-input inventory differs from the delivered target only in
`crates/portcove-core/src/definition_publisher_policy_tests.rs`: existing test-only elapsed-phase diagnostics
are composed around the surviving operations. Its module remains cfg(test);
no production GLib API, constructor or affected call path changes. Substituting
that one file's delivered Git preimage reconstructs the preceding
`ecdc7f34e22409da462ce4cbba6505083ec4270e9fbb527cd589905cf8e7a3d2` digest exactly.
The composed digest is `e7b4862dd177411eb7fadceedfc2173ee18fac1e21bf930140a6e5538e8f3ce6`.

The complete 237-entry native dependency/code-generator inventory, features,
Cargo lock and build-environment entry remain unchanged, with dependency digest
`80bab63cf9f86838b1517c42767894bdc5151e09dafd41e22bbf97e220a365f2`. Scanner policy remains
`7cbe77e7ef591e476797956f7bf3e79a0fc659a646505f079580c16d51499525`. Only the record's
reconfirmed head/input digest changes. The original finding, failed raw scans,
approval owner/scope/expiry and unallocated publication identity remain intact.
This is bounded unchanged-production-risk reconfirmation, not remediation,
universal unreachability, publication authority or passing final qualification.
Independent final-source review, current-head checks and complete maintained
audit/qualification admission remain required.

## Delivered framework reassessment — October 16, 2026

Candidate `b83a805221b7c2edbdfba1ba622a6f7cacf9f55b` normally consumes
[#1972](https://github.com/boburning/portcove/pull/1972) and
[#2016](https://github.com/boburning/portcove/pull/2016), delivered through
`88845323c34e93ccf291eda53572728dddeda546`. The lock SHA256 is
`bef9a28c344f28b26e4d2315edd8bd47a42a0bb922fd8eb043f33a6147ccf416`.
Tauri/API 2.12.4, runtime/runtime-wry 2.12.2, build/codegen/macros 2.7.3,
utils 2.10.2, dialog 2.8.3 and transitive FS 2.7.1 replace the preceding
family. The generator closure adds static_vcruntime 3.0.0. GLib 0.18.5,
GTK 0.18.2, GIO 0.18.4, Wry 0.57.0, Tao 0.37.1 and their relevant features
remain unchanged. Ordinary Desktop still uses defaults plus custom-protocol,
without qualification features; no plugin or permission is newly enabled.

The bounded material-source refresh examined 1,606 Rust/build files across
32 relevant application, ancestor and generator packages. All 1,426 examined
published files matched lock-checksummed archives; 180 local files were hashed.
Independent review also verified the 30 published archives and 60 manifests.
The review covers the ten changed/one removed files in the prior ancestor scope,
three changed/added tauri-utils files and the new MSVC runtime-linking module.
Path handling, FS/ACL generation and runtime linking introduce no found
production constructor consumer of VariantStrIter. The prior constructor/trait
analysis is retained: the iterator needs an instance from array_iter_str;
VariantIter and Vec<T>::FromVariant use separate paths. This is bounded source
evidence, not complete generated/linked-code proof, runtime safety or remediation.

The independently verified 192-entry input digest is
`7f0ba1d9f92a3d16601038f3819b74efe212c67c0dfeaa8b9c9cf234d59f5fe5`;
the 238-entry native dependency/generator digest is
`4e56c5fb5572bcfd8846b2ded5d05c5bafc42962222c661172fde19a2ce72b11`.
Only reconfirmedHead and these two fingerprints change in the protected record.
Approval, accountable owner, advisory/version, policy, expiry and unallocated
publication identity remain unchanged. Original scans and failures remain intact.
The owning PR retains the independent source review and exact artifacts. Fresh
current-head checks, complete scan/audit, maintained qualification and affected
native/package/updater observations remain required before admission. The
existing approval does not cover additional findings or unrelated failures.
