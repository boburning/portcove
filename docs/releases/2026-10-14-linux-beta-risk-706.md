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
become successful reusable receipts. The protected transition requires the
existing complete fresh pre-change audit and exhaustive exact-head qualification
on all maintained platforms, plus independent review; acceptance is not a shortcut.

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
