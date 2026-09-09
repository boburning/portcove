# Public beta scope expansion — 2026-09-08

This is the dated migration evidence for [#537](https://github.com/boburning/portcove/issues/537),
not a live work ledger. The owner approved completing the seven full scoped
outcomes below before Public beta and authorized implementation. The live
[Project](https://github.com/users/boburning/projects/1) remains authoritative.

The starting repository revision was `b2401e55c3e1e1e2ab19dd2b1377e4beadc49c73`.
Before mutation, a complete count-checked traversal returned 421 unique Project
items. Targeted issue reads checked complete dependency and Project membership
connections before and after the scoped migration. Readback verified each
original body was retained verbatim beneath a dated scope banner.

## Exact migration

Only Target release changed, from **1.0** to **Public beta**. Every row retained
**Required**, its Project identity, issue state, parent, priority, horizon,
status, work type, workstream, platform, effort and blocking dependencies.

| Issue | Preserved Project item identity | Preserved parent | Preserved blockers |
|---|---|---|---|
| #31 | `PVTI_lAHOApLVys4BiZPjzg5Ws9U` | #14 | None |
| #208 | `PVTI_lAHOApLVys4BiZPjzg5ZJ9w` | #200 | None |
| #243 | `PVTI_lAHOApLVys4BiZPjzg5iCrI` | #14 | #21, #30 |
| #245 | `PVTI_lAHOApLVys4BiZPjzg5iCvw` | None | None |
| #246 | `PVTI_lAHOApLVys4BiZPjzg5iCyo` | None | #184, #243, #245, #265, #397, #398 |
| #397 | `PVTI_lAHOApLVys4BiZPjzg5tYDU` | #246 | #245 |
| #398 | `PVTI_lAHOApLVys4BiZPjzg5tYEU` | #177 | None |

No acceptance or qualification claim changed. Historical scheduling in the
preserved bodies is explicitly superseded by the new dated scope banner.
Production requalification #46 retains its 1.0 target. No signing, publication,
credential, protected acceptance or repository-rule authority changed.

## Complete readback

After migration and creation of the finite reconciliation issue #537, a second
complete traversal returned **422 items and 422 unique identities**. Reversing
only the seven target changes in memory and excluding newly created #537
reproduced the original Public beta gate: **77 effective Required identities,
32 unfinished, 26 Opportunistic**. The current read returned **85 Required,
40 unfinished, 26 Opportunistic**, including #537. Thus the product scope added
exactly seven Required identities and now has 39 unfinished product outcomes;
the eighth addition is the reconciliation issue itself.

The cumulative 1.0 identity comparison preserved all **97** existing Required
identities and added only #537, giving **98**. Unfinished counts were 51 and 52
respectively; 29 Opportunistic identities remained unchanged. Both gates had
zero classification/status conflicts, missing or truncated dependencies,
migration conflicts, unassigned requirements or dependency cycles. Neither
gate was ready. This migration does not complete product acceptance.

The seven promoted identities are the complete difference in product beta
scope. Documentation in Delivery, Roadmap, Project governance and Integrations
now reflects the expanded commitment. Test, independent final-diff review, CI
and merge evidence belong to the linked issue and pull request.
