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

## October 21 source and release refresh

The contribution was merged on October 19 at `18:44:01Z` as
`ac71aec441b9fa6382e687dd412fc228d9ef7f3f`. The earlier OPEN readback above is
historical. Two subsequent real game releases are available:

| Game tag                  | Tag commit                                 | Release / Windows ZIP asset | Provider ZIP SHA-256                                               |
| ------------------------- | ------------------------------------------ | --------------------------- | ------------------------------------------------------------------ |
| `v0.1.1-coop-playtest.42` | `a4696a361f6d94fa7a124500d84e03c712893266` | `417876410` / `657799559`   | `410793f986ea5adafd3d079a584a39ec49c6102acd3e9914fb69063bf69a4b91` |
| `v0.1.1-coop-playtest.43` | `e14700432ffefcfb878a4449be9dfe4e394de844` | `418864404` / `660522956`   | `6bca843492a6e03cc53767553e1559a36a74493ad50477b88b08a5573c7d36e7` |

Exact tag-object and complete, non-truncated Git-tree reads bind both sources to
framework submodule `psxrecomp-v4` at
`6f0ccbc6b67fee626de6a7b0945ca3abb26332aa`, with recomp-ui unchanged at
`b964eabe5a3438b8ed121064354ba27c1accef3f`. The framework comparison against the
merged repair diverges at `68425a4add89acd0a6ca325bf90e3f8a69d6377f`; the game pin
does not descend from the repair merge. Direct inspection also establishes the
relevant behavior, rather than treating ancestry alone as decisive:

- [Pinned runtime initialization](https://github.com/RetroPortingToolKit/psxrecomp/blob/6f0ccbc6b67fee626de6a7b0945ca3abb26332aa/runtime/src/mod_runtime.cpp#L1539) still preserves a nonempty selection and otherwise generates an absolute texture-pack path, passing it to `set_feature_resource_path` without requiring the feature to be enabled.
- [Pinned setter](https://github.com/RetroPortingToolKit/psxrecomp/blob/6f0ccbc6b67fee626de6a7b0945ca3abb26332aa/runtime/src/mod_packages.cpp#L3254) still places that path in persistent feature selections. The pinned header lacks the repaired ephemeral generated-default map.

Read source blob identities: runtime `a4f11a09987d5d5fa011d8491713bbc0f32c419a`,
packages `35979a737e6890d2501b74aaaf80a2e1e3962af6`, header
`d989083eb96ce58b77c4bb8603d16cc5b8767718`. Their retained UTF-8 SHA-256 values are,
respectively, `bd820cbe413241b1430959fce85319c526394962b16c5810c2c91ca4de661667`,
`13cb36b6949a41dbbf8d7b8a4057574fce4e3749e2bf6cb948561c2983fd2cf4` and
`00b5b63da6a78573ae00bbf7cbdc323167c60adf7a1389c575b135768dbedc90`.

This refresh establishes published asset metadata and tagged source behavior;
it does not authenticate either ZIP's runtime provenance, download or execute
either package, or claim a new native failure. It does not qualify `.42`/`.43` as
repaired artifacts. The `.35`/`.36` observed failures remain unchanged. The exact
resume condition is two real releases with source/runtime binding to this repair
or a reviewed equivalent, followed by the ordinary Core materialization,
launcher, update/rollback and retained-state observations. #144 stays outside
the compiled catalog; #246's combined protected journey remains pending and is
independent of application publisher delivery.
