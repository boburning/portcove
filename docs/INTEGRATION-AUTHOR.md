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
required command names, JSON/JSONL formats and raw `exec`. The reference's initial
window is API 42–43/event 2; tolerate additive object fields within it and reject
unknown consequential enum values or a different schema with a migration message.
Future client revisions should extend that window only after matching fixtures
and package tests. The product version is descriptive, never a substitute for
these checks. Export authoritative schemas with `schema export`.

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
envelopes. A final root record has `type: "result"` and API schema 42. Some
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

## Troubleshooting and conformance

| Observation | Client response |
|---|---|
| CLI missing or path relative | Ask for an existing verified executable and explicit library; do not search for a game executable instead. |
| Unsupported schema/capability | Select a compatible package/client pair. Never continue by ignoring the version. |
| Missing source/tool or bad checksum | Present core's requirement/error. Preserve the original file and admission rules. |
| Busy port/library | Wait for the other operation and refresh; do not compete or force-unlock. |
| Interrupted output/cancellation | Read retained activity and current state; no blind retry or assumed cleanup. |
| Changed library/stale review | Refresh identity/plan and obtain fresh action intent. |
| Package/sandbox failure | Confirm the package, native executable, mount and permission scope on that exact host; do not infer another platform works. |

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
