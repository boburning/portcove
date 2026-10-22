# Runtime diagnostics qualification

The desktop writer introduced for
[#1922](https://github.com/boburning/portcove/issues/1922) keeps runtime logs
best-effort. Typed correlation and bounded frontend reporting extend that writer
for [#1924](https://github.com/boburning/portcove/issues/1924).
The [architecture contract](../ARCHITECTURE.md#runtime-diagnostic-writer)
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
| Field names           | Closed approved vocabulary, at most 64 bytes; other names are omitted.                   |
| String values         | At most 1,024 bytes before and after redaction; oversize values are omitted whole.       |
| Aggregate values      | At most 4,096 bytes; later fields that exceed the budget are omitted.                    |
| Target                | At most 256 ASCII module-path bytes.                                                     |
| Correlation IDs       | At most 128 ASCII identifier bytes; unrecognized values are omitted, not normalized.     |
| Stored spans          | At most 256 active contexts, eight approved fields and 512 value bytes each.             |
| Projected ancestry    | Nearest four contexts; missing or invalidated context is explicitly incomplete.          |
| Frontend reports      | Four distinct reports per 60-second monotonic process window; contention drops.          |
| Frontend text         | No text crosses IPC; bounded byte inspection is 1,024 message and 4,096 stack bytes.     |
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

Schema 1 preserves approved numeric and boolean values, bounded nested span/error
context, and independently useful session/process/build metadata. Producer and
export use the same scalar budget; the final encoded record has a separate cap.
A dropped span update invalidates its stored context instead of publishing a
stale ID as complete. Unknown versions remain uninterpreted; legacy unversioned
records retain their established support-export policy. Neither context
completeness nor monotonic elapsed time establishes durable operation success.

A namespace lease prevents two current writers from rotating the same files.
Another desktop process can continue normally with unavailable runtime logging;
per-session isolation remains owned by #1923. Inaccessible, unsafe or oversized
legacy files may remain after a refused operation. The policy describes
successful owned writes and observable failure, not unconditional cleanup of
every existing byte. Large child output remains in Core's independent captures.

## Focused evidence

The existing ordinary Linux Rust-quality lane executes the complete CLI
`runtime_diagnostics` integration binary, which includes the exact desktop writer,
event layer and frontend-report admission modules. Windows workspace tests also
compile and execute the production Tauri adapter. Both lanes prepare the owned
native helper through the existing Rust setup action. This provides
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
The Linux artifact also includes the complete harness output. The nextest
cross-package selector names the integration binary, so its nested module tests
are included when these shared sources change.

With repository tools and the prepared `PORTCOVE_HOST_TOOL_FIXTURE` available,
the focused Linux route is:

```sh
node scripts/run-rust-tests.mts --guard-command cargo test --locked -p portcove-cli --test runtime_diagnostics -- --test-threads=1
node scripts/run-ui-tests.mts exact src/frontend-diagnostics.test.ts src/ErrorBoundary.test.tsx
```

Set `PORTCOVE_DIAGNOSTICS_EVIDENCE_DIR` to retain fixture JSON and
`PORTCOVE_DIAGNOSTICS_SOURCE_REVISION` to the exact candidate revision. A local
result does not replace required current-head hosted checks or independent review.

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
durability is unchanged. Shared CLI host logging, isolated session files and a
comprehensive viewer remain separate work. A schema-1 session identifier does
not itself change the existing single-writer file namespace or retention policy.
