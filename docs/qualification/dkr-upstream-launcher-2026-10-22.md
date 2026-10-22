# DKR-R upstream-owned Windows launcher — October 22, 2026

Owning port: [#54](https://github.com/boburning/portcove/issues/54), selected
from the live queue under [#1422](https://github.com/boburning/portcove/issues/1422).
This is a bounded existing-installation integration. It establishes registration,
actual Windows launch/relaunch and non-destructive registration removal. It does
not promote Cataloged to Supported or establish gameplay, controller use, audio
quality, in-game save/load, packaged Portcove acceptance or Linux launch success.

## Upstream and ownership

The authenticated GitHub release API reported
[Version1.0.8](https://github.com/ThatGuyMcd/DKR-R/releases/tag/Version1.0.8),
published October 20. Its tag resolves to
`34ed57ae97ef46759e5b23aa8d7a1e7ec89f3f56`.
`DKR-R-1.0.8-Windows-x64.zip` is 58,511,488 bytes, publisher SHA-256
`215a46d06376a5dc04ae55435ac58a82708783b2981d2f4d9ef3cb0445d98ed9`.
The actual authenticated download matched both. Public web-page rendering was
unavailable during investigation; that absence was not used as distribution evidence.

The pinned upstream [update guide](https://github.com/ThatGuyMcd/DKR-R/blob/34ed57ae97ef46759e5b23aa8d7a1e7ec89f3f56/docs/UPDATES.md)
and [save guide](https://github.com/ThatGuyMcd/DKR-R/blob/34ed57ae97ef46759e5b23aa8d7a1e7ec89f3f56/docs/SAVES.md)
describe upstream's updater, recovery and profile ownership. On Windows, the
top-level `DKR-R.exe` bootstraps `libexec/dkr-r/DKR-R-Runtime.exe` and retains
upstream update recovery. Leave the complete extracted package together. Choosing
the inner runtime would bypass that entry point. Upstream's mutable replacement
and backups cannot share a Portcove-owned immutable managed version.

The current definition consequently uses the existing user-selected capability:
explicit executable, working directory and arguments. User selection supplies
execution intent, not curated authentication. Portcove offers register, launch
and forget registration. Upstream/the player owns runtime updates, profiles,
saves, settings and their backups. New Portcove managed installation/update,
rollback, backup and external-file deletion are unoffered.

## Actual Windows case

Private retained evidence is under
`E:\Codex-Evidence\1422-next-upstream-port-20261022`.
The development CLI was built from main
`43980db13626379bb070eca895e778690ee66fd3` plus the candidate catalog, before the
legacy-compatibility repair. Its SHA-256 is
`10754599b9ed48da1fabc65ee86bd56055cffba410a59730f3737cb379873e2c`,
API80, version `0.1.0-alpha.2`. This exact executable and catalog identity are
retained in `cli-development-identity.json`. It is not a published or final-source
artifact. The later legacy repair affects managed historical state; the selected
route and observed catalog facts remain unchanged.

The authorized original was read from the owner's existing read-only NAS copy,
copied to private evidence and verified at 12,582,912 bytes, SHA-256
`7de1a8fb2a9558cfc3d9ad4497df698c1e89cf7095ac1531557df2af40ba8bcf`
(US Rev A/v1.1). Neither NAS source nor copied original was changed. No ROM or
derived game data is committed or redistributed.

The ZIP was preflighted before directory parsing and extracted into a new private
external folder with bounded metadata, entries, streamed bytes and safe paths.
It contains 57 entries, 5,992 central-directory bytes and 139,521,798 expanded
bytes. The initial flat-root assertion failed after safe extraction because the
package has a wrapper folder. That failed receipt remains. A separate read-only
stream/hash comparison verified every extracted member against the authenticated
ZIP and selected its actual wrapped root; extraction was not repeated.

With an isolated explicit library, the actual selected executable was the package's
top-level `DKR-R.exe`, working directory the complete release folder. Arguments:

```text
--rom <private authorized original> --config <private fresh profile> --timeout 8
```

`--timeout` is upstream's normal runtime option, not a patched engine or experimental
bootstrap path. The owned native session and each process tree used the maintained
host admission/supervision tools. Registration preview, explicit fingerprint-bound
registration and status succeeded. Two launch sessions
`0e94257c-2b78-4a1a-9bf8-4ab8631653e3` and
`56639c0e-374a-4884-bd71-8664e95f0f58` completed with public `succeeded` outcomes
and exit code 0. Both upstream logs report validated ROM, renderer/VI initialization,
first successful presentation, the eight-second stop and clean runtime shutdown.
The fresh save-path diagnostic is retained; no checksum-valid Adventure progress
or successful in-game save/load is inferred. Device-open logs do not prove audio
quality or physical-controller operation.

Unregistering through the public API left every external runtime/profile file
byte-identical: 58 runtime files (139,521,847 bytes, including a synthetic
preservation witness) and 15 profile files (12,713,840 bytes). The witness is not
an in-game save. The explicit library reported registration absent afterwards.
`native-case.json`, both launch records, both runtime logs and before/after hashed
inventories preserve these results. An initial capabilities probe omitted the
explicit library and refused unrelated default-library migration; its error is
retained, that library was not repaired, and all subsequent commands used the
isolated explicit library.

## Historical managed installations

Previous Windows 1.0.4 acceptance and Linux 1.0.2-to-1.0.4 install/update/rollback
and data-preservation evidence retain their original scope. The
[September 15 Linux launch failure](https://github.com/boburning/portcove/issues/54#issuecomment-5687086160)
remains an environment-blocked WSLg/display-0x0 observation. It was not rerun,
erased, reclassified as success or expanded into gameplay qualification.

Captured installed contracts remain authoritative for historical launch, source,
mutability, data collection, rollback and recovery. Review also identified the
published pre-contract schema-2-to-5 reader population. A small read-only fallback
recognizes only the recorded official 1.0.2/1.0.4 Windows and Linux artifact
identities, safe selected executable and recorded platform consistency. It uses
a dedicated frozen historical DKR catalog/source contract; an exact artifact
mapping supplies the platform where old manifests omit it. It never rewrites
the manifest or derives history from the host/current launcher route. Unknown
legacy identities refuse while preserving bytes. Captured contracts take
precedence over that fence. Acquisition continues through the current definition,
so this local interpretation cannot install a managed 1.0.8 updater.

Fixture tests prove these reader and refusal contracts, not actual legacy gameplay
or new Linux runtime acceptance. Retire the frozen reader only after its installed,
backup, export and recovery consumers have an explicit supported transition or
owner-confirmed retirement. No custom builder or deferred engine repair is reopened.

## Verification and limits

Final source review, focused contract tests and hosted checks are recorded in the
delivery PR and canonical issue. The original fixture-schema failure and three
30-second harness timeouts remain in `focused-core-settled.log`; the schema repair
keeps proposal inspection schema 2, and only the three exact Windows fixtures
receive finite 90-second harness headroom. Product/child timing, assertions,
cleanup, two workers and zero retries remain unchanged.

New Linux registration is unoffered by this definition. A future useful Linux
route requires its own scoped upstream/package/launch evidence. No signing,
publication, protected acceptance or broad platform authority is inferred from
this integration, and #1422's wider cohort remains separate.
