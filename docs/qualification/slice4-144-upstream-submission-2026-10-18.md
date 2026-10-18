# #144 upstream portable-default contribution

Status: submitted under the owner's subsequent explicit communication grant:
[upstream PR #685](https://github.com/RetroPortingToolKit/psxrecomp/pull/685).
Destination: `RetroPortingToolKit/psxrecomp`, `master`, observed target
`53a057f548cd1f93f1b4d8300caaeded72f4160d`, repository ID 1172059725.
Source: `boburning/psxrecomp:fix/portable-generated-texture-defaults`, commit
`572558394b5b737690138f8374c80b032c3d84ba`, tree
`1704defaba8ad291579cdd44460026fcb1e49f97`. The fork is repository ID 1424617258.
Target refresh and the 21-entry open contribution inventory found no equivalent
fix before submission. The target was unchanged; only patch indexes/hunk positions
were adjusted to master. The reviewed five-file repair and assertions are unchanged.
Ordinary discussion/revisions on this contribution are authorized; release and
game-artifact publication are separate.

Title: **Keep runtime-generated texture-pack defaults portable across installs**

Submitted repair and validation scope:

> Runtime initialization currently persists the generated absolute texture-pack
> directory as a user selection, including when HD textures are disabled. Moving
> the installation and retaining mods/state.toml leaves that selection pointing at
> the unavailable old installation.
>
> Keep generated defaults in an ephemeral manager map rooted at the current mods
> directory. Capture that base at registration, preserve explicit selections and
> existing manifest-default containment, and use the same fallback in the launcher
> getter and committed resource resolver. No legacy absolute-path migration is
> included because the persisted format does not distinguish generated strings
> from deliberate user choices.
>
> Native Windows regression: relocate A to B with A unavailable and the feature
> disabled; check the live launcher getter and enabled committed HD plugin resolve
> B; change cwd; preserve an unavailable explicitly selected external path; reject
> traversal/rooted generated defaults and shared-source registration. The original
> disabled-default oracle fails the pinned source and passes the patched build.
> The package suite passes. The runtime suite still fails the pre-existing
> file-identity same-size/restored-mtime replacement assertion on this host; it is
> not represented as wholly passing. These are framework tests, not two repaired
> game release assets or a full Portcove lifecycle qualification.

Patch: [exact diff](patches/slice4-144-portable-generated-defaults.patch).
Source/artifact/log identities and limitations:
[checkpoint](slice4-broker-and-portable-repair-checkpoint-2026-10-18.md),
[evidence](slice4-broker-and-portable-repair-evidence-2026-10-18.json).

The retained master-build CMake cache identifies the same physical source clone
subsequently committed as the submitted source. Repair assertions and the package
suite passed there; the file-identity runtime failure remains. This reuses the
recorded source-bound native tests, rather than claiming a new post-commit run.
PR #685 was OPEN with no reviews, comments or checks at the last readback.
[Portcove #144 receipt](https://github.com/boburning/portcove/issues/144#issuecomment-6253442412)
records the submission without changing its acceptance.

Authorization enables upstream communication only. Upstream adoption, releases
incorporating the fix and two suitable real source/release/asset identities are
external dependencies. Approval cannot manufacture them or complete #246.
