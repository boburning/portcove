# Hosted resource observer: interrupted Windows lifetime

Owner: #534. The ordinary Windows rehearsal
[40667643496/1](https://github.com/boburning/portcove/actions/runs/40667643496)
ran source `73a8d0764e81a236949d4c070b2a888e519a32bd`, tree
`ece708689f998c07c69e866359c0b835d2f8698b`, job `122746103796`.
Its complete one-job provider inventory reports 3,416 seconds (56m56s),
including 110 seconds for supported runtime/driver preparation, 240 seconds
for qualification-feature compilation and 2,999 seconds for the actual
installed updater rehearsal. The disposable-key preview-final UI journey
passed on the same machine; this is not protected candidate, catalog
unchanged-client or production publication acceptance.

Resource artifact `12809199878` is 4,681 bytes, SHA-256
`257b0132d413d39a32960c12f8c5becb00bda4824c17979de1b77a8dacd1e2d4`.
The bounded ZIP inventory contains five files. Its original JSONL has only two
samples, 1,056 bytes, SHA-256
`ea8c36b8a9ef7295c922faea3ac721c8df8d5f2a6f80aa6d948b767dfab4094e`.
They span elapsed 13–5,055ms, with the last sample at
`2026-10-28T09:52:39.0347195Z`, matching the first step's completion second.
There is no terminal observer record. Readback correctly reports
`partial-or-interrupted`; whole-job memory/disk usage remains unestablished.
The actual CRLF observer bytes match the exact frozen workflow projection.
Native artifact `12810236126` is 95,781 bytes, SHA-256
`626791386b8e6fdbaeb7686256d25aa51af2800184dc215412292cb16d43bb36`.
Both artifacts' provider identities, full ZIP preflight, CRC, member hashes,
source joins and before/after inventories were retained locally before expiry.

The runner's [process-exit handler](https://github.com/actions/runner/blob/main/src/Runner.Sdk/ProcessInvoker.cs)
kills a step's remaining process tree after five seconds when inherited
output streams prevent EOF. The observed timing is consistent with this path;
the receipt does not independently establish the termination cause.

The repair launches only the current PowerShell executable and exact generated
observer script. On Windows, fixed `CreateProcessW` arguments disable handle
inheritance and set `CREATE_NO_WINDOW`. No breakaway, scheduler, account,
credential or cleanup exemption is added. The inherited environment retains
normal provider tracking. Original creation time and process handles control
startup failure cleanup; later checks and stop still require the same PID and
birth identity.

The same workflow's optional `resource_observer_only` input defaults to false.
Its three-minute mode runs checkout, cross-step heartbeat checks and the
original observer finalizer/public artifact only. It skips runtime, driver,
dependency, build and installation work. The canonical observer is bounded to
36 samples in this mode; the ordinary 90-minute route retains 1,080 samples.
Both retain the 8MiB output ceiling and explicit sampled-counter limitations.
Actual Windows cross-step qualification is required before another full native
measurement. No automatic repeat or production gate activation is authorized
by these receipts.
