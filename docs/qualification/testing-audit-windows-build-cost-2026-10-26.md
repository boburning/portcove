# Windows test-target build cost, 2026-10-26 UTC

Audit15 of [#2420](https://github.com/boburning/portcove/issues/2420) required comparable cold/warm phase evidence before changing selection or caches. This controlled observation separates target construction from discovery, packet transfer, selected execution and live serialization. It introduces no maintained optimization or cache policy.

The [machine-readable record](testing-audit-windows-build-cost-2026-10-26.json) retains original phase records, full compiler identity, commands, environment, metadata hashes, provider parents and the measured partition counts.

## Source and method

[CI40252630121/a1](https://github.com/boburning/portcove/actions/runs/40252630121) executed experiment candidate `1eb5210bfb3993d61b30b035585ac5e26ce583f8` through provider checkout `fb0f8e24608122fbf0655f4dfd79a2d49e02039a`. Its verified parents are target `ba55e9a06357d0230ad9c65a48c96fe93f226a56` and that candidate. The source label and provider checkout are distinct.

The Windows producer used Rust1.99.1, Cargo1.99.1 and pinned Nextest0.9.100 on one hosted Windows job. Its normal Rust cache restore/save action was intentionally skipped for the experiment. The legacy cache observation therefore remains `unknown`; the separate probe and actual skipped step establish the disabled policy, not a cache miss. Shared repository caches were not deleted or saved by that action.

Dependency fetching was measured first, with Cargo's target metadata directed to an owned separate directory. A retained observation then proved the actual measured target absent immediately before construction. The pair is **target-cold with dependency sources present versus immediate same-job warm**, not a wholly cold machine or dependency-cold comparison.

Both timed operations ran the same commands under the same source, toolchain and environment:

```text
cargo-nextest nextest list --locked --workspace --all-targets --list-type binaries-only --message-format json
cargo metadata --locked --format-version 1
```

Original and warm outputs were retained independently. Parsed official binary and Cargo metadata matched; all four raw-file hashes were verified. Cargo's actual target matched the observed target, and tracked source remained unchanged. Metadata equality does not claim bit-identical executable bytes.

## Observed wall-clock phases

| Operation                                       |      Observation | Scope                                                                                                                                |
| ----------------------------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------ |
| Dependency-source fetch                         |          50.507s | Separate from the timed pair                                                                                                         |
| Target-cold construction plus Cargo metadata    |         375.743s | First full workspace/all-target operation                                                                                            |
| Immediate warm construction plus Cargo metadata |           2.053s | Identical operation in the same job                                                                                                  |
| Post-warm producer work                         |           2.589s | Derived interval covering metadata comparison, discovery, union/partition validation and config generation; not isolated enumeration |
| Test archive construction                       |           2.568s | Existing measured archive operation                                                                                                  |
| Archive upload                                  |               4s | GitHub step timestamps, one-second resolution                                                                                        |
| Worker archive download                         |             2–9s | Same coarse timestamp resolution                                                                                                     |
| Worker extraction and inventory                 |     1.916–2.689s | Existing combined phase                                                                                                              |
| Selected worker execution                       | 179.534–309.863s | Eight separate workers; these are not cold/warm pairs                                                                                |
| Worker host reservation wait                    |     0.374–0.530s | Separate from execution; not GitHub runner queue time                                                                                |
| Live transport target construction              |         134.431s | Sequential Core/headless and native Desktop builds in their separate Windows job                                                     |
| Live transport invocation/comparison            |           0.495s | Actual Core input/output, Desktop headless/native and parity phases                                                                  |

Target construction dominates the target-cold producer observation. Once those outputs exist, selected execution is much larger than the warm construction, inventory and transfer operations. Live serialization also spends substantially more time constructing its targets than comparing their output. The transport and partition phases occur in other jobs; their values are accounting observations, not controlled comparisons of identical hardware states.

All eight test workers passed. Official runnable discovery and selection were2,686, and the structured execution union contains2,686 distinct passing identities, each observed once. The partitions contain335 or336 cases; an initial collector's stale335-per-shard assumption was rejected and corrected against current official counts. These are runnable/executed case counts, not source files, lines or an ignored-case count. Full workspace/all-target compilation and real transport checks remained required; no test identities, assertions, retries, threads or deadlines were reduced.

## Failure evidence and final disposition

The experiment's producer, metadata comparisons, eight workers and actual transport job succeeded. The overall experiment run **failed** because actionlint rejected the temporary constant `if: false` cache-step condition. Repository formatting and typed lint passed. That failure is retained and is not presented as a qualified PR head.

The experiment's raw [profile inputs](https://github.com/boburning/portcove/actions/runs/40252630121/artifacts/12620988153) and [producer timings](https://github.com/boburning/portcove/actions/runs/40252630121/artifacts/12621392668) identify the original outputs; the record retains their local ZIP hashes and original metadata hashes. Hosted artifacts have finite retention. Original ZIPs, metadata, job logs and the complete structured case union are also retained in the task evidence directory. The committed record preserves the phase values and identities independently of artifact retention.

All temporary instrumentation, the cache condition and the extra upload step were removed before the final report-only head. Normal required CI qualifies that final head separately. The existing cache, complete compilation, archive/inventory checks, worker policy and live transport route remain in force.

This single pair does not establish repeatable end-to-end savings, compiler CPU/disk causality, an available warm state on fresh jobs, a new cache policy or a safe reduction in compilation. Shard balancing and reservation refinements retain their own evidence requirements.
