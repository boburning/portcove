# Runtime diagnostics qualification

Shared Desktop and CLI host diagnostics under
[#1923](https://github.com/boburning/portcove/issues/1923) use the best-effort
bounded writer introduced for [#1922](https://github.com/boburning/portcove/issues/1922)
and the typed correlation and frontend policy from
[#1924](https://github.com/boburning/portcove/issues/1924).
The [architecture contract](../ARCHITECTURE.md#runtime-diagnostic-writer)
owns current behavior. This document describes reproducible synthetic evidence;
it does not claim installed-app, gameplay, physical-device or crash-proof delivery.

## Ownership and bounds

The `portcove-diagnostics` crate owns host location selection, session allocation,
file policy, approved formatting and bounded writing. Its `events.rs` applies
nonblocking formatting admission, field/record bounds and Core's existing
redaction before handing serialized JSONL to `writer.rs`. `sessions.rs` owns the
fixed slot inventory and lease-protected retention. The executable owns its
subscriber and exit flush; Core owns instrumentation and classification without
installing a subscriber. The shared crate has no Tauri dependency. CLI installs
the shared file layer alongside its existing stderr formatting and verbosity.

| Resource              | Limit and overload behavior                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Bootstrap             | One preparation thread and one-result channel; caller waits at most 250 ms, then logging is unavailable.         |
| Concurrent formatting | Eight producer permits, one compare/exchange attempt; contention drops the event.                                |
| Event fields          | At most 16; larger metadata sets are rejected before visiting values.                                            |
| Field names           | Closed approved vocabulary, at most 64 bytes; other names are omitted.                                           |
| String values         | At most 1,024 bytes before and after redaction; oversize values are omitted whole.                               |
| Aggregate values      | At most 4,096 bytes; later fields that exceed the budget are omitted.                                            |
| Target                | At most 256 ASCII module-path bytes.                                                                             |
| Correlation IDs       | At most 128 ASCII identifier bytes; unrecognized values are omitted, not normalized.                             |
| Stored spans          | At most 256 active contexts, eight approved fields and 512 value bytes each.                                     |
| Projected ancestry    | Nearest four contexts; missing or invalidated context is explicitly incomplete.                                  |
| Frontend reports      | Four distinct reports per 60-second monotonic process window; contention drops.                                  |
| Frontend text         | No text crosses IPC; bounded byte inspection is 1,024 message and 4,096 stack bytes.                             |
| Encoded record        | At most 32,768 bytes including newline; oversized records are dropped whole.                                     |
| Queue                 | 256 records, at most 8 MiB payload plus one worker record; full queues drop new records.                         |
| Session inventory     | Eight fixed independently leased slots; active or unavailable slots cannot be reclaimed.                         |
| Runtime files         | Six files of at most 4 MiB per slot; 24 MiB per session and 192 MiB of managed runtime payload across all slots. |
| Inactive retention    | Seven-day session expiry and a 64 MiB observed inactive-byte target, checked at startup.                         |
| Running-file expiry   | Seven days for exact owned runtime names; checked at writer startup and at most once per minute during writes.   |
| Support log input     | 48 fixed session names plus six legacy names; at most 4 MiB per file and 24 MiB aggregate raw input.             |
| Support output        | At most 16 MiB of exported payload, with a separate 64 KiB manifest cap and fixed ZIP metadata.                  |
| Synchronization       | Worker idle flush at one second; explicit normal-exit flush waits at most two seconds.                           |

The budget covers logger-owned payloads. Bounded maps, JSON serialization,
redaction expansion, allocator overhead and the eight active producer buffers
add bounded scratch. The logger cannot bound allocations or work a caller
performs before emitting an event. It therefore never invokes an arbitrary
Debug/Display/error formatter, even when the formatter appears inside tracing's
message arguments. Omitted formatting is counted, not silently claimed as a
complete diagnostic record.

Schema 1 preserves approved numeric and boolean values, bounded nested span/error
context, and independently useful session/process/build metadata. Producer and
export use the same scalar budget; the final encoded record has a separate cap.
A dropped span update invalidates its stored context instead of publishing a
stale ID as complete. Unknown versions remain uninterpreted; legacy unversioned
records retain their established support-export policy. Neither context
completeness nor monotonic elapsed time establishes durable operation success.

## Early startup and session behavior

Location selection uses the `diagnostics` sibling of the absolute
`PORTCOVE_PREFERENCES` location before a preference store is constructed or read.
An absent, invalid or unavailable configured location falls back to the safe OS
per-user configuration location when available. Once a root is selected, full
session capacity or later writer failure does not switch roots. A library switch
preserves the host location, session
UUID and monotonic clock.

All bootstrap directory, inventory, retention and session-marker I/O runs on
the preparation thread. The 250 ms deadline bounds caller waiting, not OS work.
A blocked operation may continue after timeout, holding any acquired lease until
it finishes. An abandoned result cannot start a late writer, install a subscriber
or claim a completed close; there is no automatic retry. Unavailable logging
does not change the application startup result.

Slots `session-00` through `session-07` each retain the existing
`portcove-desktop.jsonl` basename and five rotations. The schema records the actual
Desktop or CLI surface. Nonblocking OS leases protect concurrent writers; PID
metadata is never used to infer liveness. Retention visits only the fixed slots
and exact owned names, rechecks ownership before deletion, prefers empty slots,
then reuses the oldest eligible inactive slot. Seven-day session age is measured
from its recorded start. Active, inaccessible, malformed,
unsafe or unmarked populated slots are preserved, as are unknown files. The
192 MiB managed-payload bound and 64 MiB inactive target do not promise cleanup of
foreign or inaccessible bytes. Large child output remains in Core's independent
captures.

A valid inactive session marker without completed-close evidence is observed
with an unknown cause. Missing metadata does not prove a crash. A completed
marker requires successful final drain and synchronization; a timed-out worker
keeps its lease until actual completion. Neither marker state nor runtime logs
grant operation, library or recovery authority.

Files default to application INFO and dependency WARN. Exactly
`PORTCOVE_DIAGNOSTICS_DEBUG=1`, or CLI `-vv`, enables application DEBUG only for
that process and never writes preferences. A later process returns to defaults
unless opted in again. CLI stderr remains WARN by default, INFO with `-v`, and
DEBUG with `-vv`; the new host-stage observations are file-only. Machine output,
raw child-stream bytes and child exit codes keep their existing contracts.

## Focused evidence

The ordinary Linux Rust-quality lane runs the shared crate's unit tests, the CLI
`runtime_diagnostics`, `host_diagnostics` and `desktop_host_diagnostics` integration
binaries, and Core's `support_bundle_export` tests. Windows compiles workspace
targets and selects affected test families, including the shared crate and those
integration binaries when their owning sources change. Both lanes prepare the
owned native helper through the existing Rust setup action. These routes provide
platform filesystem, thread and subprocess evidence without requiring a desktop
window, proprietary game data, paid capacity or a separate qualification runner.
The configured route is distinct from a successful run; issue/PR receipts record
the exact source and observed results.

Shared unit fixtures cover bounded saturation, explicit drop/error readback,
blocked writer shutdown, record/UTF-8 limits, redaction canaries, real file
rotation and retention, safe-file refusal and injected permission, disk-full,
write, rotation and flush failures. Session fixtures cover simultaneous Desktop
and CLI identities, inactive age/byte pruning, active-lease preservation,
unavailable slots, unclean-session observations with unknown causes, fallback
selection and DEBUG reset. A controlled bootstrap gate holds preparation past
the deadline: the caller returns unavailable, the lease stays held until release,
and late preparation starts no writer and records no completed close.

`host_diagnostics` launches the actual CLI in owned subprocesses. Its fault
matrix covers preference read/decode, library opening, database opening and
migration failures with their actual typed stage observations and private-text
canaries. Occupying all eight leases compares exact human, JSON, JSONL and help
output with successful logging and retains valid-library startup behavior.
Additional controls check `-v`/`-vv`, exact environment opt-in, reset without
preference persistence, and owned child stdout/stderr bytes plus exit codes under
DEBUG and unavailable logging.

`desktop_host_diagnostics` runs the production Desktop `host_startup.rs`
constructors and shared host layer in owned subprocesses. It covers preference
location/read/decode, runtime-lease contention/access, library, database and
migration failures; fixed safe stderr; valid startup with all slots busy;
simultaneous Desktop/CLI sessions; and saved-library switching with one host
session and location. It does not start a native Tauri window or qualify an
installed application, detached helper dispatch, or protected application-update
helper modes.

Core support-export fixtures collect typed Desktop/CLI session records before
legacy root logs, verify the fixed 54-candidate inventory and provenance, exclude
markers and unrelated files, and enforce the aggregate raw-input cap even for
invalid records. Existing partial-section, trailing-record, safe-file and privacy
controls remain in that suite. Export reads do not rewrite retained source logs.

The `runtime_diagnostics` integration fixture also executes an owned Core mutation
under the production shared diagnostic layer with failed diagnostic writes. The
actual CLI reads the same library, preserving successful machine output, durable
state and existing activity/recovery observations.

The lifecycle fixture adopts two distinct owned native-helper packages, activates
one through the retained install route, applies a reviewed retained update, runs
reviewed preparation and supervises real helper processes. It compares actual
operation IDs with durable activities, exact release/install observations,
preparation extraction/setup phases, terminal capture metadata, and reopened
launch outcomes. A separate exit-code-7 child proves that `Ok` supervision can
record a failed launch. Original package/source bytes are preserved. These are
synthetic production-API observations; no proprietary source, real gameplay,
installed UI or universal game-output capture is claimed.

Golden/schema tests cover primitive types, null error codes, bounded nested
context, legacy compatibility, unknown versions and malformed identities.
Overlapping operation/span lifetimes check parent/child identity and monotonic
elapsed values. Saturation is tested separately; identity assertions serialize
fixture emissions so intentional admission loss cannot conceal a correlation
defect. Privacy canaries cover unknown event/span fields and their names,
credential-bearing messages, nested errors, paths, URLs and frontend inputs
before persistence and again at export. Bounded human messages retain the
existing redaction policy and are not an anonymity guarantee.

Frontend fixtures cover multibyte/oversized inputs, duplicate and burst reports,
exact rate-window expiry, recursive and contended admission, a closed runtime
writer, and synchronous/rejected IPC callbacks. The renderer's original text
remains in its recovery screen; only closed descriptive metadata reaches the
host. No report can supply an operation/activity ID or authorize a mutation.

The representative-event comparison retains the old synchronous sequence:
clone, redact, serialize, check metadata, open, append and `sync_data` for each
event. The candidate measures producer work separately from final flush and
reports drops. Measurements describe the named fixture, source, compiler and
platform. Its historical numeric strings and schema-1 numbers are compared through
their established support-export projections; the old measured producer is
unchanged. Queueing time is not durability, a shorter producer call is not an
application-wide speedup, and no causal explanation for earlier timeout
incidents follows from this comparison. CI retains the measurement and fixture
artifacts; the issue/PR completion receipt links the exact run and source.

CI retains `runtime-diagnostics-windows-<run>-<attempt>` and
`runtime-diagnostics-linux-<run>-<attempt>` artifacts for seven days. They include
the source revision, relevant source hashes, compiler/build/platform identity,
fixture outcomes, failure-injection health, explicit limits and measurements.
The Linux artifact also includes shared-host, integration and Core export harness
output. Source manifests cover the shared crate, Desktop startup functions, CLI
entry/startup code, the fixture sources and Core policy/export code. The nextest
cross-package selector names all three integration binaries and retains the
shared crate's unit coverage when shared host sources change. Artifacts describe
the configured synthetic scope; they do not themselves establish native UI or
installed-app acceptance.

With repository tools and the prepared `PORTCOVE_HOST_TOOL_FIXTURE` available,
the focused Linux route is:

```sh
node scripts/run-rust-tests.mts --guard-command cargo test --locked -p portcove-diagnostics -- --test-threads=1
node scripts/run-rust-tests.mts --guard-command cargo test --locked -p portcove-cli --test runtime_diagnostics --test host_diagnostics --test desktop_host_diagnostics -- --test-threads=1
node scripts/run-rust-tests.mts --guard-command cargo test --locked -p portcove-core support_bundle_export -- --test-threads=1
node scripts/run-ui-tests.mts exact src/frontend-diagnostics.test.ts src/ErrorBoundary.test.tsx
```

Set `PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR` to retain fixture JSON and
`PORTCOVE_DIAGNOSTICS_SOURCE_REVISION` to the exact candidate revision. A local
result does not replace required current-head hosted checks or independent review.

## Health and limitations

Contributors can query the registered read-only desktop command
`get_runtime_diagnostic_health` through `desktopApi.runtimeDiagnosticHealth()`.
The fixed text uses atomic counts and closed states, works independently of
library readiness, and contains no raw OS error or filesystem path. It includes
bootstrap timeout/fallback and the bounded startup session-retention snapshot
separately from live queue, drop, write and flush counters. The query does not
itself emit a log event. A snapshot is not a transactionally consistent accounting
ledger and never decides whether an operation committed.

Normal exit invokes the flush from Tauri's actual exit callback, because Tauri
can terminate the process without dropping ordinary local guards. CLI and ordinary
Desktop supervision/recovery helpers use explicit bounded guard shutdown. After
the deadline, no unbounded join is attempted. A blocked OS operation can remain
until the process exits; abrupt exit can lose records. Bootstrap and shutdown
deadlines bound caller waiting and do not promise cancellation or durable delivery.
Existing activity-capture durability, recovery authority and protected updater
helper behavior are unchanged. A comprehensive runtime-log viewer remains outside
this qualification scope.
