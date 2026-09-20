# Portcove Playnite reference client

A small Windows library extension consuming the standalone CLI. It uses the
public Playnite SDK and Portcove JSON/JSONL commands. Core owns catalog, sources,
readiness, downloads, trust, installation, persistence and recovery. The client
has no per-port branches, SQLite access, Rust dependency or private Playnite
assembly reference.

This is a developer-loaded reference, not a marketplace release or a claim of
completed Public beta qualification. [#243](https://github.com/boburning/portcove/issues/243)
retains the exact frontend, lifecycle, independent-consumer and human evidence.
[Issue #910](https://github.com/boburning/portcove/issues/910) separately owns the
planned normally installable `.pext` product, guided runtime/library onboarding,
personal-library import, state-driven setup, ordinary lifecycle operations,
fullscreen/controller use, and user-facing support boundaries. Those capabilities
are a Required Public beta commitment, but they are not shipped by this developer
loading procedure or established by the reference evidence below.

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

This revision supports **Portcove API schemas 42–51 and event schema 2**. Schema
50 advertises the independently versioned operation-event contract through
`operation_event_schema_version`; the client consumes and rejects an unsupported
value before lifecycle management. Launch-only and read-only library negotiation
prove their narrower command/format sets without requiring unused management or
raw-stream contracts. Additional object fields are tolerated; incompatible schema
versions and missing required capabilities produce an upgrade message before
management. A product version string is not used as a compatibility guess.
Schema 51 consumes the activity feed's complete current/actionable sets and
bounded terminal-history meaning; contradictory or incomplete classification is
rejected before lifecycle management. The management view always includes
protected current, attention, and recovery rows even when they fall beyond its
ordinary eight-row preview. Use an exactly identified schema-42,
schema-43, schema-44, schema-45, schema-46, schema-47, schema-48, schema-49,
schema-50 or schema-51 candidate until a matching public
standalone release exists; the older published technical previews must not be
described as supporting these new commands.
See the [author guide](../../docs/INTEGRATION-AUTHOR.md).

Schema 47 status can include core-owned definition decisions for install,
preparation and launch. The client shows the exact stable reason and whether the
decision applies to the selected definition or a retained installed contract. A
hold or escalation is not converted into client consent, and unknown operation,
outcome or reason values require a compatible client update. Core revalidates the
decision when an operation starts.

Schema 48 adds reviewed cleanup for a retained private preparation. The management
window reads the current doctor repair plan, accepts only the known
`retained_preparation` kind for the selected stable port identity, validates the
complete cleanup preview and exact affected inventory, and shows the original
installation, registered source, saved data, backups, and logs that core preserves.
Schema-48 negotiation also requires the advertised `preparation.cleanup`
capability before this management contract is accepted.
Cleanup is submitted only with the exact reviewed fingerprint and explicit
confirmation. Changed, missing, duplicated, unknown, or cross-port repair values
fail closed; the compiled CLI remains authoritative and revalidates under its
operation locks.

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
transport. It also emits a representative 256-port offline measurement with exact
connection, refresh, bounded-concurrency, launch-observation and cancellation process
counts and elapsed times. The
[dated audit](../../docs/archive/2026-09-20-public-cli-consumer-audit.md) records the
measured budgets and their limits. The normal `just playnite-check` also builds the
qualification-enabled standalone CLI and runs the compiled client against the
existing isolated, checksum-pinned install fixture. That real-core check correlates each durable
activity row to its exact streamed operation identity and drives install, update,
progress, readiness and failures through both `n64-recomp-portable` and
`libultraship-portable` fixture shapes without a client branch. It also covers a
busy port, cancellation, bad checksum and missing-artifact preservation, positive
recovery, and a real selected-definition publisher revocation that the client
consumes as a core-owned retained launch hold and launch refusal. After lifecycle
qualification it stops the fixture artifact server and records a
real-CLI batched catalog/status refresh, proving that prepared discovery and installed
state do not acquire a hidden online dependency. Owned command timeouts terminate
the descendant process tree within a second bound before
fixture cleanup. Qualification-only catalog and definition inputs cannot be used
by a production build. Optional `-Cli` and
`-Library` arguments additionally exercise discovery and nullable launch readback
for exactly identified external candidate bytes. None of these headless checks
substitutes for Playnite frontend interaction, packaged execution, gameplay,
intrinsic human observation or a fresh independent author.

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
