# Runtime diagnostic writer qualification

The desktop writer introduced for
[#1922](https://github.com/boburning/portcove/issues/1922) keeps runtime logs
best-effort. The [architecture contract](../ARCHITECTURE.md#runtime-diagnostic-writer)
owns current behavior. This document describes reproducible synthetic evidence;
it does not claim installed-app, gameplay, physical-device or crash-proof delivery.

## Ownership and bounds

`diagnostics_events.rs` applies nonblocking formatting admission, field/record
bounds and Core's existing redaction before handing serialized JSONL to
`diagnostics_writer.rs`. The latter is a standard-library-only worker, queue,
health, file-retention and shutdown implementation. The application owns its
subscriber and actual exit callback. Core only emits instrumentation, and the
shipping CLI continues to use its existing stderr subscriber.

| Resource              | Limit and overload behavior                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Concurrent formatting | Eight producer permits, one compare/exchange attempt; contention drops the event.        |
| Event fields          | At most 16; larger metadata sets are rejected before visiting values.                    |
| Field names           | At most 64 ASCII identifier bytes; other names are omitted.                              |
| String values         | At most 1,024 bytes before and after redaction; oversize values are omitted whole.       |
| Aggregate values      | At most 4,096 bytes; later fields that exceed the budget are omitted.                    |
| Target                | At most 256 bytes before and after redaction.                                            |
| Encoded record        | At most 32,768 bytes including newline; oversized records are dropped whole.             |
| Queue                 | 256 records, at most 8 MiB payload plus one worker record; full queues drop new records. |
| Runtime files         | Active file plus five 4 MiB rotations; 24 MiB of conforming runtime files.               |
| Age                   | Seven days for the exact owned runtime names; failures remain explicit in health.        |
| Synchronization       | Worker idle flush at one second; explicit normal-exit flush waits at most two seconds.   |

The budget covers logger-owned payloads. Bounded maps, JSON serialization,
redaction expansion, allocator overhead and the eight active producer buffers
add bounded scratch. The logger cannot bound allocations or work a caller
performs before emitting an event. It therefore never invokes an arbitrary
Debug/Display/error formatter, even when the formatter appears inside tracing's
message arguments. Omitted formatting is counted, not silently claimed as a
complete diagnostic record.

A namespace lease prevents two current writers from rotating the same files.
Another desktop process can continue normally with unavailable runtime logging;
per-session isolation remains owned by #1923. Inaccessible, unsafe or oversized
legacy files may remain after a refused operation. The policy describes
successful owned writes and observable failure, not unconditional cleanup of
every existing byte. Large child output remains in Core's independent captures.

## Focused evidence

The production worker is compiled directly as a Rust test on Linux by the
existing ordinary Rust-quality lane. Windows workspace tests compile and execute
the production desktop adapter and the CLI integration fixture. This provides
real platform filesystem/thread evidence without requiring a desktop window,
proprietary game data, paid capacity or a separate qualification runner.

The fixtures cover bounded saturation, explicit drop/error readback, blocked
writer shutdown, record/UTF-8 limits, redaction canaries, real file rotation and
retention, safe-file refusal and injected permission, disk-full, write, rotation
and flush failures. An owned Core mutation executes under the production
desktop subscriber with failed diagnostic writes. The actual CLI reads the same
library, preserving successful machine output, durable state and existing
activity/recovery observations. This does not claim that the CLI adopted the
desktop file writer.

The representative-event comparison retains the old synchronous sequence:
clone, redact, serialize, check metadata, open, append and `sync_data` for each
event. The candidate measures producer work separately from final flush and
reports drops. Measurements describe the named fixture, source, compiler and
platform. Queueing time is not durability, a shorter producer call is not an
application-wide speedup, and no causal explanation for earlier timeout
incidents follows from this comparison. CI retains the measurement and fixture
artifacts; the issue/PR completion receipt links the exact run and source.

## Health and limitations

Contributors can query the registered read-only desktop command
`get_runtime_diagnostic_health` through `desktopApi.runtimeDiagnosticHealth()`.
The fixed text uses atomic counts and closed states, works independently of
library readiness, and contains no raw OS error or filesystem path. The query
does not itself emit a log event. A snapshot is not a transactionally consistent
accounting ledger and never decides whether an operation committed.

Normal exit invokes the flush from Tauri's actual exit callback, because Tauri
can terminate the process without dropping ordinary local guards. After the
deadline, no unbounded join is attempted. A blocked OS operation can remain until
the process exits; abrupt exit can lose records. Existing activity capture
durability is unchanged. Typed span enrichment, shared CLI host logging,
isolated sessions and a comprehensive viewer are separate work.
