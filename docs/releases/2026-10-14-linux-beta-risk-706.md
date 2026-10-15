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
