# Portcove Playnite reference client

A small Windows library extension consuming the standalone CLI. It uses the
public Playnite SDK and Portcove JSON/JSONL commands. Core owns catalog, sources,
readiness, downloads, trust, installation, persistence and recovery. The client
has no per-port branches, SQLite access, Rust dependency or private Playnite
assembly reference.

This is a developer-loaded reference, not a marketplace release or a claim of
completed Public beta qualification. [#243](https://github.com/boburning/portcove/issues/243)
retains the exact frontend, lifecycle, independent-consumer and human evidence.

## Build and load

Use Windows with Visual Studio 2022 Build Tools/MSBuild. The locked build-only
NuGet reference-assembly package supplies .NET Framework 4.6.2 targeting files;
a separate modern .NET SDK is unnecessary. Run from the repository root:

```powershell
just playnite-check
# Optional real CLI checks: select a disposable test library.
just playnite-check -Cli H:/candidate/portcove.exe -Library H:/fixtures/library
```

Restore uses committed `packages.lock.json` files in locked mode. Runtime output
is exactly `bin/Release/Portcove.Playnite.dll` and `extension.yaml`; do not copy
Playnite SDK or private application assemblies into it. The reference builds
against Playnite SDK 6.15.0. Playnite documents compatibility within one SDK
major version; this is not qualification of every Playnite release.

For a local session, follow Playnite's supported
[external-extension loading instructions](https://api.playnite.link/docs/tutorials/extensions/plugins.html):
add that build-output directory in Settings → For developers → External
extensions, then restart Playnite. In the extension settings select the absolute
path of a verified standalone `portcove.exe` and an explicit library folder.
Selecting an executable grants it your ordinary account permissions; file
discovery and capability negotiation do not attest its authenticity.

For isolated qualification, start Playnite with its documented
[`--userdatadir` option](https://api.playnite.link/docs/manual/advanced/cmdlineArguments.html)
and a fresh owned directory. Do not share another running Playnite profile or
overwrite its extension binary during a session. The tests never load into the
user's ordinary Playnite library.

## Compatibility and use

This revision supports **Portcove API schemas 42–43 and event schema 2**. Additional
object fields are tolerated; incompatible schema versions and missing required
capabilities produce an upgrade message before management. A product version
string is not used as a compatibility guess. Use an exactly identified schema-42 or schema-43
candidate until a matching public standalone release exists; the older published
technical previews must not be described as supporting these new commands.
See the [author guide](../../docs/INTEGRATION-AUTHOR.md).

Refresh imports Windows catalog entries with the key `(opaque library ID, port
ID)`. Version/path changes do not alter it. Installation state comes from core;
gameplay qualification is distinct from launch readiness. Right-click one
Portcove game → Portcove → Manage and review activity opens the optional
management view. Original file and BIOS inputs follow catalog source profiles.
Registration leaves original files in place. Install uses an existing active
version or installs one; Check and update explicitly resolves the channel at
execution time. Preparation uses core's reviewed fingerprint and original
registered inputs. Nothing installs or updates as a side effect of Play.

Progress is best-effort and a single final response must agree with the process
exit status. The view reads the latest 200 durable activities and displays up to
eight for the selected port; absence from this bounded view does not prove that
an operation never happened. Cancellation requests target the observed operation
ID and wait for core's terminal result. Closing during work offers explicit
disconnect without cancelling or claiming success. No automatic mutation replay, process-tree
kill, rollback, library recovery or credential setup is performed.

Play uses raw supervised `exec` with a fresh known UUID and polls `launch show`.
The last game's library/port key and UUID are saved only as a reconnect pointer;
all outcomes are read from core after restart. It is not a second job ledger and
does not restore Playnite's old playtime tracking. The client drains raw game
streams without storing or exporting them. On an observation failure, it warns
that tracking/outcome is unconfirmed; ending Playnite tracking does not assert
that the child exited or saves were collected. Core continues to enforce its
launch lock. Refresh retained activity before deciding on another launch.

## Validation and support boundaries

The tested host is Playnite **10.56.0.23531** with runtime SDK **6.16.0.0** on
Windows x64. The [dated native evidence](../../docs/archive/2026-09-09-playnite-reference-validation.md)
covers isolated import/refresh, reviewed synthetic preparation, supervised
launch and retained results after restart. Other Playnite versions, real-game
playability and the full management failure matrix are not qualified by it.

`tests/ContractTests.cs` is a redistributable synthetic CLI/process fixture, not
a retail source, game artifact or port-admission bypass. It checks literal argv,
opaque identities, schema/capability drift, structured errors, stream termination,
gaps, reconnect reads and two synthetic port identities through the same generic
transport. Optional real CLI checks exercise discovery and nullable launch
readback. These do not substitute for two real adapter lifecycle scenarios,
frontend interaction, packaged execution, gameplay or a fresh independent author.

The client deliberately omits artwork acquisition, shortcuts, uninstall,
destructive backup actions, catalog trust changes, application updates, automatic
recovery and broad launcher feature parity. Use Portcove's supported UI/CLI for
the specific recovery action it reports. Shutdown during management may leave
durable incomplete work; never infer safe cleanup from a closed window.

Portcove maintains this bounded reference and its public-contract regressions.
Report the client commit, CLI capability/schema versions, Playnite/SDK version,
operation, platform and a redacted reproducer on #243 or a linked bug. Do not
attach original game files, credentials, raw tool output or unreviewed library
paths. A public-contract failure belongs to Portcove; launcher presentation belongs
to this extension; upstream game/source qualification keeps its catalog owner.
