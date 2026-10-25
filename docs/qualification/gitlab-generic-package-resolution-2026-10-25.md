# GitLab generic package resolution — October 25, 2026

Shared provider work for [#2926](https://github.com/boburning/portcove/issues/2926)
and [#2510](https://github.com/boburning/portcove/issues/2510), following the
four-guide delivery in PR #3645. The source base is
`b2898038408196353668fa90b6c51dae178e8f17`; the intervening PR #3644 changes
Node validation ownership/reporting, preserving the delivered catalog and Core.

## Concrete missing capability

The existing GitLab provider resolves independently published package-file IDs
and release-description checksums. Digimon World's official Windows setup
release instead links to its versioned generic-package endpoint. Two registry
files share its package/version/filename, so choosing the first or newest
metadata row would invent an artifact-selection rule.

Core extends that existing provider. It reconstructs the generic endpoint from
the current official project and observed package metadata, consumes complete
bounded relevant registry pages and requires unique published expected identity.
Only duplicate candidates need a HEAD request. This uses the existing bounded,
redirect-free client and compares the returned checksum and optional size with
independently published registry records. No artifact body is read to invent
expected integrity. Duplicate identities or multiple matching uploads remain
held; a failed join is not cached or replaced with weaker evidence.

The new route uses the exact official URL it validated, including when the
release's convenience `direct_asset_url` names something else. It validates the
real registry filename against native archive, platform and authored variant
rules before caching. The prior explicit-file-ID and already-published
description-checksum paths remain unchanged. No new authored per-release field,
registry, lifecycle implementation, installed-contract migration or publication
authority is added.

## Primary observation

The official Digimon World v0.3.5 generic endpoint is:

`https://gitlab.com/api/v4/projects/ethan4love%2Fpsx-recomp-port/packages/generic/digimon-world/0.3.5/digimon-world-0.3.5-win-x64.zip`

A bounded HEAD at 22:01 UTC, with redirects explicitly disabled and no body read,
returned HTTP 200 from that same endpoint, size 29,195,790 and published SHA-256
`b5ac8a122bd57fa34004922db0455a74454f5688925bbedd4fd951774af8b3f1`.
That joins independently observed registry file 345027966, distinct from older
same-name file 344936397, whose size and SHA-256 differ. The earlier immutable
archive acquisition and bounded source inspection are recorded in the
[GitLab handoff assessment](gitlab-upstream-handoffs-2026-10-25.md).

This is a primary upstream metadata observation, not a claim of live native
execution or a fully managed Digimon installation. Its bundled CLI accepts the
current Core generation/rebuild options; actual pinned-toolchain, setup/data and
replacement fit remain separate assessment work. The existing useful upstream
setup and non-owning player route remains delivered.

## Verification boundary

Production-resolver fixtures exercise an unchanged definition through a release
successor with changed filenames and checksums, fresh resolution after the
successor, normal cache retention/expiry, duplicate upload selection and refusal,
actual filenames and official project scope. Boundary coverage also checks
pagination completion, malformed/duplicate integrity and interrupted HEAD work.
All 25 GitLab cases passed in focused Linux verification, including the nine
new provider regressions. Two initial async-borrowing compile failures were
retained; owning each bounded lookup future resolved the Send/lifetime error
without changing assertions, coverage or deadlines.

Exact executed results, independent final review and hosted checks belong to the
delivery PR and canonical records; a fixture does not establish native runtime,
gameplay, packaged Desktop or real-save acceptance.

The existing Core artifact verification, source checks, consent, stale-plan
protection, retention, data preservation and recovery remain authoritative.
Full #2510/#2926 acceptance stays open, including all original inventory,
maintenance and fit decisions. No port is marked Supported or Reviewed merely
because this provider can resolve its metadata. #534/#246 publication authority
and #2225/#47/#48 acceptance remain independent.
