# Prepared upstream GLib 0.18 security backport

Prepared October 18, 2026 for [#706](https://github.com/boburning/portcove/issues/706).
[#49](https://github.com/boburning/portcove/issues/49) consumes that owner. This is
review material; no upstream submission, maintainer commitment, private fork,
release or advisory change has occurred. A human must review and take
responsibility under the [upstream contribution policy](https://github.com/gtk-rs/gtk-rs-core#ai-contribution-policy)
before separately authorized submission.

## Exact proposed submission

Title: **Security-only 0.18.x backport of VariantStrIter out-pointer fix**

This proposal was prepared with LLM assistance. It requests a narrow official
security release for GTK3 consumers still using the GLib 0.18 Rust bindings.

Could the gtk-rs-core maintainers accept the existing correction from
[#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343) on the official 0.18
release branch and designate its maintenance/release owner? The registry's GLib
publish owners currently include the `gtk-rs:crates-io` team, Guillaume Gomez,
Sebastian Dröge and Bilal Elmoussaoui. Publishing permission does not establish
that anyone has agreed to maintain this branch. We request confirmation of that
limited supported route, rather than presuming general continued 0.18 support.

The attached [minimal backport patch](glib-018-variant-str-iter.patch) changes
only the local out-pointer's mutability and the reference passed to the variadic
GLib call. An immutable Rust reference cannot permit the foreign function to
write the pointer. Making the pointer mutable and passing a mutable reference
preserves that write before constructing the returned string. There is no API,
ABI, system-GLib minimum, dependency-family, feature or license change. Its blank
context line is omitted to keep the patch artifact whitespace-clean; the applied
source bytes are identical to the upstream correction.

Provenance: Fabio Valentini's commit
`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`, merged as
`05dff0ee696f9bcd8617cd48c4b812d046d440cb`. The patch applies cleanly to
`glib/src/variant_iter.rs` at official tag `0.18.5`, commit
`42b9caf98e03ded086362d9653ca58fe94dc8658`. With LF preserved, its original SHA256
is `1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e` and
the patched SHA256 is
`a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc`.
The October 18 preparation verified application and both hashes; it did not
repeat the unchanged runtime experiment.

The [existing optimized reproduction](https://github.com/boburning/portcove/issues/49#issuecomment-5594620382)
used Rust/Cargo 1.88.0, Linux x86-64, system GLib 2.88.0, an unchanged published
GLib 0.18.5 version and pinned lockfile. Separate bounded processes for `next`,
`next_back`, `nth`, `nth_back`, `last` and mixed iteration exited 139 before
the correction and 0 after it; the empty control exited 0 in both trees. Only
the two upstream changes differed. The original and patched source hashes above
match that experiment. This is retained historical regression evidence, not
a newly run current-toolchain test or package qualification. An accepted release
must run the upstream branch's maintained tests and optimized regression cases
on its supported toolchains before publication.

The actual Portcove production graph at
`5ce2833b6f23700620e639d26523a795e11dd0af` still includes GLib 0.18.5 through GTK
0.18.2, WebKit2GTK 2.0.2, Tao 0.37.1, Wry 0.57.0 and Tauri 2.12.4/runtime-wry
2.12.2. A fresh locked Linux-target normal-dependency tree confirms the path.
These are the current stable Tauri/Wry/Tao versions; registry GLib 0.18 still
ends at 0.18.5. GTK 0.19.0 instead selects GLib 0.22 and Rust 1.92, outside
this GTK3 family's compatible minor constraints. A separately resolved fixed
GLib 0.21.5 does not remove the vulnerable 0.18.5 path.

An official security patch in the 0.18 family can remain compatible with the
existing consumers' `0.18` constraints and unchanged sys crates. The maintainers
must choose and publish its real version; `0.18.6` is only the next hypothetical
patch number, not an available artifact or a locally relabeled dependency.

After such a release, please coordinate the official
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) /
GHSA-wrw7-89jp-8q8g record. It currently recognizes patched `>=0.20.0` and
unaffected `<0.15.0`. If the official fixed release is 0.18.6, the additional
patched interval would be `>=0.18.6, <0.19.0`, retaining `>=0.20.0`; it must not
accidentally mark the still-affected 0.19 family fixed. The actual chosen release
and source provenance must determine the final advisory edit.

## Portcove consumption after upstream delivery

Resume #706 only when an accountable official maintenance/release route and
compatible published artifact exist. Then update the real resolved graph,
independently review it, retain complete raw scanner results, and qualify the
affected ordinary Linux package/startup/updater/native boundaries. Natural,
undismissed alert closure remains required. A corrected source file, this
proposal, the development-policy decision and temporary Linux-beta risk
acceptance each fall short of that remediation acceptance.

No actual release candidate or publication tag was selected for this preparation.
The delivered development disposition stays separate from candidate-specific,
time-limited release authorization; see the
[existing procedure](../releases/2026-10-14-linux-beta-risk-706.md).
