# Prepared #144 upstream submission

Status: prepared, not submitted; upstream communication authority is outstanding.
Destination: `RetroPortingToolKit/psxrecomp`, `master`, observed target
`53a057f548cd1f93f1b4d8300caaeded72f4160d`, repository ID 1172059725.
The current authenticated account has pull access and no push authority. Proposed
action after authorization: submit the exact reviewed patch through an ordinary
topic-branch pull request; refresh target interactions before posting. Do not
publish game artifacts, change releases or request a merge bypass.

Title: **Keep runtime-generated texture-pack defaults portable across installs**

Proposed body:

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

Authorization enables upstream communication only. Upstream adoption, releases
incorporating the fix and two suitable real source/release/asset identities are
external dependencies. Approval cannot manufacture them or complete #246.
