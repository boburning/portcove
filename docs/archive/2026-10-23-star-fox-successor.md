# Star Fox Enhanced successor decision — 2026-10-23

This record implements the finite transition in
[#2440](https://github.com/boburning/portcove/issues/2440) under the
[existing lineage policy](../CATALOG.md#upstream-lineage-and-alternative-implementations).
The [earlier October 23 unresolved decision](2026-10-23-upstream-lineage-policy.md)
remains an unchanged historical event. New attributable evidence supports an
appended decision; it does not rewrite what the earlier investigation established.

## Decision and exact scope

**Accept `kandowontu2/starfox-enhanced` as the successor implementation.**

Retain Portcove ID `star-fox-enhanced`, canonical issue
[#124](https://github.com/boburning/portcove/issues/124), target key
`star-fox-snes`, and the original upstream identity in history. The current
project URL becomes `https://github.com/kandowontu2/starfox-enhanced`.
The observed successor repository ID is `1393981305`, owned by
`kandowontu2` / provider account ID `335174380`. This is acceptance of a continued
implementation under its observed identity, not a claim that GitHub transferred
the old repository object.

The complete integration remains unchanged, including the release repository
`kandowontu/starfox-enhanced`, asset selectors, source requirements, executable,
persistent and mutable paths, support tier, channels and qualification fields.
This decision does not admit a newer release, add an acquisition location,
authorize redistribution, clear an operation hold or migrate existing installs,
pins, saves or settings.

## Evidence that resolves the earlier uncertainty

Primary pages were directly retrieved on October 23, 2026 and independently
reviewed. Reddit rendered the move replies as approximately 24 days old; that
relative display is not an exact publication timestamp.

| Evidence | What it establishes and its limit |
| --- | --- |
| [Historical developer reply](https://www.reddit.com/r/romhacking/comments/1w0paj5/comment/p6vyh9b/) | The established `u/kandowontu` account identifies itself as the developer in a thread linking the old `kandowontu/starfox-enhanced` repository. This connects the account to the historical project. |
| [Explicit successor designation](https://www.reddit.com/r/PSVitaHomebrew/comments/1wak915/comment/pcpuamz/) | The same account names `kandowontu2/starfox-enhanced` as the new repository. Together with the historical connection, this is the decisive attributable bridge. |
| [Move explanation](https://www.reddit.com/r/PSVitaHomebrew/comments/1wak915/comment/pcpu8k2/) | The same account says it moved while appealing an account suspension. The explanation is a self-report; GitHub's reason for the suspension is not independently established. |
| [Migration commit `755eb27b`](https://api.github.com/repos/kandowontu2/starfox-enhanced/commits/755eb27bb95ad40ae7d7430c1c08aef8e096821b) | The September 28 commit updates old-owner links to the new repository and describes preparing assets for GitHub republishing. GitHub associates the unsigned commit with old account `kandowontu`, ID `95717282`. It corroborates the explicit designation rather than authenticating the move by itself. |
| [Successor repository metadata](https://api.github.com/repos/kandowontu2/starfox-enhanced) | Records repository ID `1393981305`, creation time `2026-09-29T00:03:05Z`, public visibility and the observed owner. No unknown historical provider ID is invented. |
| [Retained historical source](https://github.com/kandowontu2/starfox-enhanced/commit/2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273) | The old accepted source commit and restored `v0.0.6.7` tag corroborate code ancestry. They cannot establish the bytes of a release ZIP. |

The review found sufficient attributable project continuity and no contradictory
continuity evidence in this bounded set. The unavailable X post from the earlier
record is not needed to reach the decision and is not treated as verified proof.

### Bounded source and notice comparison

The comparison used historical commit
`2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273` and observed current commit
`0f889bdc3d605cdb2cb28abb008fd9d7ea2a8f8e`.
The [historical credits](https://github.com/kandowontu2/starfox-enhanced/blob/2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273/CREDITS.md)
and [current credits](https://github.com/kandowontu2/starfox-enhanced/blob/0f889bdc3d605cdb2cb28abb008fd9d7ea2a8f8e/CREDITS.md)
retain KandoWontU's creator attribution.
The [current third-party notices](https://github.com/kandowontu2/starfox-enhanced/blob/0f889bdc3d605cdb2cb28abb008fd9d7ea2a8f8e/THIRD_PARTY_NOTICES.md)
retain the eight top-level sections from the
[historical notices](https://github.com/kandowontu2/starfox-enhanced/blob/2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273/THIRD_PARTY_NOTICES.md)
and add notices for later components. `LICENSE-XBRZ.txt` retains the identical
Git blob `94a045322262546cfb9d72561e1d587b5c2ffb1e`.

These observations support provenance continuity; they do not constitute a
complete source, dependency or package rights audit. The account's
[older Star Fox EX discussion](https://www.reddit.com/r/emulation/comments/ysrtmp/comment/iw558ty/)
acknowledges use of leaked source for that historical mod. This decision does not
clear that provenance concern, turn attribution or praise into a license, or
grant rights to game data, optional music or redistributed packages.

## Accepted artifact and unresolved acquisition

The historically accepted Windows package remains:

| Fact | Retained value |
| --- | --- |
| Version | `v0.0.6.7` |
| Asset | `StarFoxEnhanced-0.0.6.7-windows-x64.zip` |
| Size | `8891375` bytes |
| SHA-256 | `e1b8569fe5712b4e2cb99effa50b8527d86311ede55f3570ae1537d414f29abe` |
| Source | `2455f8cc7a2f71a0dcd4b9d6f0c80e0ef2d83273` |

The [old repository endpoint](https://api.github.com/repos/kandowontu/starfox-enhanced)
and [successor's historical release lookup](https://api.github.com/repos/kandowontu2/starfox-enhanced/releases/tags/v0.0.6.7)
still returned HTTP 404 in this review. No release package was recovered,
downloaded or executed.

The [v0.0.8.8 release](https://github.com/kandowontu2/starfox-enhanced/releases/tag/v0.0.8.8)
explicitly leaves antivirus detections against earlier Windows downloads under
investigation; [issue 53](https://github.com/kandowontu2/starfox-enhanced/issues/53)
remains a report of those detections. These are unresolved artifact concerns,
not an independently confirmed malware finding or a contradiction of the
maintainer's successor designation. No new Windows artifact is approved here.

The observer continues to probe the old release repository. Its existing
original-location 404 accounting is bound to the old semantic port contract
and original-location membership; changing the project URL invalidates that
match. The remaining acquisition failure can therefore become unclassified and
actionable. This change does not refresh that exception, weaken the observer or
claim a green upstream-health run. #247 retains health-classification ownership;
#251 owns consumption of the shared lineage contract.

## Independent review and preservation checks

The [independent decision review on #2440](https://github.com/boburning/portcove/issues/2440#issue-6000086700)
records the non-writing review of the exact appended payload. Its bound decision
SHA-256 is:

```text
61d2db169c62955c7dd282ff4c3e47d71721ec3c582cf8ccbbbed64cf07ad87c
```

The digest includes the canonical port, issue, target and complete decision facts;
it excludes the review reference and is not a reviewer signature. Independent
implementation review and exact-head CI are recorded in the delivery PR.

Git comparison against base `2f9ad89dcc2b6c4acb8903f543b8b401233c593a` must
preserve the first decision, origin and complete integration. Regeneration must
change only the Star Fox `project_url` in the three current catalog/listing
projections. The focused real-record regression checks the unresolved-to-accepted
history, successor provider identity, canonical issue and historical release
selector, while the existing complete-projection test confirms that lineage
metadata remains absent from runtime and listing output.

The direct authored-file route uses that baseline review and ordinary hosted
Core validation. It does not bypass or weaken `preparePort`'s requirement for a
matching Core inspector when an integrated operational projection changes.

Reconsider by appending a separately reviewed decision if new contradictory
maintainer, provider identity, takeover or source-provenance evidence appears.
Artifact recovery, release admission, antivirus findings, distribution authority
and runtime qualification remain separately evidenced obligations.
