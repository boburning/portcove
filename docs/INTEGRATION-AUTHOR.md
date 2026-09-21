# Build an external Portcove client

Start with a verified standalone CLI and an explicit library. The
[public releases](https://github.com/boburning/portcove/releases) provide separate
CLI packages; follow their checksum instructions. This guide's schema-42 launch
and identity examples require a matching candidate until that contract is in a
published release. Identify a candidate by source commit, package and executable
SHA-256. Do not silently substitute an old preview or label a local build released.

The [Playnite reference](../integrations/playnite/README.md) is one external
consumer. Its protocol and process files are examples, not a general SDK or
permission to copy core lifecycle rules. See [integration ownership](INTEGRATIONS.md)
and the complete [CLI contract](CLI.md).

Choose only the capability level the client needs. A launch-only client binds
identity, readiness and supervised launch; library integration adds stable entry
discovery/refresh; lifecycle integration adds explicit management, progress and
recovery. A basic launcher is not required to implement every management command.
Negotiate the operations and schemas actually used, and keep unsupported higher
levels unavailable rather than accepting consequential data the client cannot
interpret.

## Discover and bind

Use the runtime's argument-array API with shell execution disabled. These are
program/argument objects, not shell command strings:

```json
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","capabilities"]}
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","library","identity"]}
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","catalog","list"]}
{"program":"H:/candidate/portcove.exe","args":["--library","H:/fixtures/library","--non-interactive","--json","status"]}
```

Check the envelope's schema, command, `ok`, data/error and exit status. Negotiate
only the required command names and formats: launch-only needs JSON plus raw
`exec`, read-only library integration needs JSON, and lifecycle operations add
JSONL. The reference's current window is API 42–53/event 2; schema 50 advertises
the event authority as `operation_event_schema_version`, while the historical
42–49 window retains its documented event-2 contract. Schema 51 replaces the
activity array with a feed whose protected ID sets and completeness fields must
be consumed by lifecycle clients; absence from bounded terminal history is not
evidence that work is absent. A visual preview may bound ordinary terminal rows
only after unioning every protected ID. A client that does not use
lifecycle events does not reject a runtime solely because it cannot interpret an
unused event channel. Tolerate additive object fields within the supported window
and reject unknown consequential enum values or a different used schema with a
migration message. Future client revisions should extend that window only after
matching fixtures and package tests. The product version is descriptive, never a
substitute for these checks. Export authoritative schemas with `schema export`.

Runtime discovery is a trust boundary, not permission to execute the first file
with a matching name. Ask the user to select or approve a verified compatible
package, validate its documented identity/checksum before negotiation, and show
the effective library before any mutation. Reuse an intentionally selected
library; never silently create or fall back to another one. Separate libraries
remain separate identities. Desktop, CLI and plugins may be at different versions,
so each consumer must reject an incompatible shared-library protocol or required
operation without weakening core locking or migration authority.

`library identity` may initialize an empty library. Its opaque ID plus catalog
port ID forms the game key. Encode both components without delimiter collisions.
Use the active installation only as current display state. Update/rollback and
managed moves retain the game key; a supported import destination has its own
library ID. Recheck selection before operations, and reject keys belonging to
another library. Do not identify games by name, executable path or version.

## Launch and reconnect

Generate a new UUID for an explicit launch decision and retain it before starting
the process. Invoke the same program with these argument arrays:

```json
["--library","H:/fixtures/library","--non-interactive","exec","shipwright","--request-id","19c66cf0-656f-4a02-9c0b-dba89767ab4e"]
["--library","H:/fixtures/library","--non-interactive","--json","launch","show","19c66cf0-656f-4a02-9c0b-dba89767ab4e"]
["--library","H:/fixtures/library","--non-interactive","--json","launch","recover","19c66cf0-656f-4a02-9c0b-dba89767ab4e"]
```

The UUID above is illustrative; never reuse it for separate real attempts. Read
core readiness before offering Play. Unknown gameplay evidence is not a client
launch blocker. `exec` launches the current installed version without network
installation and owns process supervision and exact-install save collection.
Its streams and exit code belong to the game: never request JSON for `exec` or
parse game stdout as management events.

Poll `launch show` at a bounded frequency. Null means absent/expired, not success.
Validate returned request and port identities. Distinguish observed child start,
last phase, terminal outcome and post-exit collection. `started_at` is request
acceptance time, not a precise child-start clock. Returned PIDs are observations,
not authority to terminate a process. A lost wrapper or reader cannot establish
successful gameplay or saved data. Core's retained request and activity are the
reconnect authority; the client need only retain a reference pointer.

Do not call `launch recover` while the recorded supervisor is live. After a
lost supervisor leaves an unfinished request, the explicit command delegates to
core's exact-identity recovery and returns the retained failed terminal record.
It may wait for the exact recorded child to exit. A spawning-phase ambiguity,
missing process-start identity, changed install, or live supervisor remains a
conflict requiring review. Recovery does not prove that a hard-killed game flushed
its own saves; it only performs the collection that core can verify afterward.

## Optional management

Read `status <port>`, `catalog show <port>`, `catalog export` and `doctor` for
core requirements, source contracts and local tools. Keep eligibility, integrity,
publisher trust and scoped gameplay/platform evidence distinct. Unknown evidence
must not be promoted to passed or translated into a blanket refusal.

Use `--non-interactive --jsonl` for explicit `ensure`, `update` and preparation.
`ensure` can return an existing active installation; it is not a general setup
repair. Review `preparation plan`, then apply its fingerprint with
`preparation run --expected-plan <hash> --yes` only after showing the copy/source,
tool and preservation consequences. A stale plan needs renewed review. Source
registration and install/update are separate observable mutations; a later
failure does not imply earlier registration was undone.

Event records have **event schema 2 at the root**; they are not nested in API
envelopes. A final root record has `type: "result"` and a negotiated API
schema within the client's 42–53 window. Some
commands emit only the result. Track sequences per operation ID and parent IDs;
do not fabricate progress when a phase or event is missing. A valid terminal
result and matching exit status establish the command response; refresh core
state before claiming the requested installed state. Missing/reordered events,
malformed output, a missing final result or exit disagreement require readback,
never automatic mutation replay.

`cancel <operation-id>` requests cancellation of a known operation. Wait for the
core result; a request acknowledgment is not completion. Use `activity --limit
200` and `activity log <id>` for retained results and redacted diagnostics. Reads
are bounded and retention may remove old records. On reconnect inspect exact
IDs and current state, then present the specific supported recovery action.
An error does not imply unchanged files or a completed rollback.

Schema 47 status may include `definition_operations`. Consume each core-owned
install, preparation and launch outcome with its stable reason and `retained`
scope. An `eligible` result can be offered, while `hold` and `escalate` require
the recovery or trust action Portcove reports. Treat an unknown operation,
outcome or reason as a compatibility failure. Do not reduce publisher trust,
artifact integrity, source compatibility, scoped evidence or missing gameplay to
one client-maintained support flag, and do not cache a decision as authorization;
core revalidates current state when execution begins.

Schema 48 adds reviewed cleanup for a retained private preparation. Negotiate
the `preparation.cleanup` capability, read the current `retained_preparation`
repair from `doctor`, and validate its stable port and operation identities
before requesting `preparation cleanup-plan`. Show the complete affected
inventory and the installation, source, saved data, backups and logs that remain
outside the action. Submit `preparation cleanup` only with the exact reviewed
`preview_sha256` and explicit confirmation. Changed, missing, duplicated,
unknown or cross-port repair values require a fresh read and review; never reuse
an earlier fingerprint or infer cleanup from an interrupted preparation.

Schema 49 adds `launch.recover`. Negotiate the capability before offering an
explicit recovery action, bind it to the retained request ID already observed
through `launch.show`, and read the returned terminal record. Never substitute
client-side PID checks, direct SQLite changes, automatic relaunch, or a success
claim for the core result.

## Planned destination-artwork handoff

Public beta planning requires a small additive/versioned artwork handoff for an
operating-system destination adapter such as #292. This is a future contract, not
a shipped command or schema. Audit the existing public surface before adding any
field. Reuse #208's core-owned asset identity, selection revision, provenance,
accepted bytes and availability rather than exposing provider internals or teaching
the adapter to search SteamGridDB.

The initial semantic roles are static portrait cover, landscape cover and
hero/banner. They are not provider dimensions or destination filenames, and a role
may be unavailable. A consumer negotiates only the handoff it uses, treats unknown
roles or consequential availability/provenance values according to the declared
compatibility window, and never stretches or destructively crops one role into
another. Existing cover/detail clients remain compatible and do not need to render
every destination role.

The adapter binds a preview to the exact library/port, choice revision, selected
asset identity, destination installation/profile/entry, existing destination
identity and write preconditions. It rereads destination state before mutation;
changed or ambiguous state requires a fresh preview. Per-game/per-role results
distinguish written, preserved, skipped, unavailable and failed. Missing provider
credentials, offline access, no match or one unavailable role cannot turn a safe
entry or prepared launch into failure.

Provider credentials never cross this handoff. Provider configuration and enabled
automatic fetching are separate from permission to reuse a suitable local asset.
Destination writes use validated durable local copies, not disposable thumbnails
or remote URLs. Repair preserves customization, artwork refresh fills missing roles
by default, replacement requires deliberate consent, and cleanup is limited to
demonstrably integration-owned unchanged bytes. No public contract field grants
filesystem ownership, provider permission or mutation consent by itself.

## Responsiveness

Measure responsiveness against representative library sizes before setting a
budget. Record process invocation counts, refresh and launch latency, bounded
polling/concurrency, cancellation and prepared offline behavior. Prefer existing
batch reads over one CLI process per game, and refresh incrementally where the
public contract supports it. These measurements may expose a contract gap; they
do not by themselves justify a daemon, hidden cache authority or invented command.

## Troubleshooting and conformance

| Observation                         | Client response                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| CLI missing or path relative        | Ask for an existing verified executable and explicit library; do not search for a game executable instead.                  |
| Unsupported schema/capability       | Select a compatible package/client pair. Never continue by ignoring the version.                                            |
| Missing source/tool or bad checksum | Present core's requirement/error. Preserve the original file and admission rules.                                           |
| Busy port/library                   | Wait for the other operation and refresh; do not compete or force-unlock.                                                   |
| Interrupted output/cancellation     | Read retained activity and current state; no blind retry or assumed cleanup.                                                |
| Changed library/stale review        | Refresh identity/plan and obtain fresh action intent.                                                                       |
| Package/sandbox failure             | Confirm the package, native executable, mount and permission scope on that exact host; do not infer another platform works. |

Run `just playnite-check` for the reference's synthetic protocol/process cases.
The fixtures are freely redistributable repository code and need no original
game bytes. A passing fixture is not catalog admission or a real two-adapter
lifecycle qualification. Reports should include exact versions, schema, platform,
operation, expected/observed result and redacted reproduction instructions.

A fresh independent-consumer exercise must use only this public guide, examples,
schemas and an identified released package or explicitly labeled candidate.
Record private knowledge, workarounds, per-port branches and maintainer help; do
not retroactively describe implementation work as an independent exercise.
Agent-driven evidence is distinct from community adoption and human play.
