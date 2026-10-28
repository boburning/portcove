# Host I/O coordination evidence - 2026-10-28

## Scope and contributor portability

This is a bounded observation on one maintainer Windows/WSL host. Repository
behavior remains opt-in: unconfigured contributors retain existing paths,
two-slot defaults and ordinary Node execution. Drives, usernames, distribution
registrations, workspace scopes and physical identities remain in private
configuration and machine evidence. No contributor needs this host's layout.

The runtime comparison used frozen source
`d16b87f0b5112d84d3d4174d50e88f09edc877bb` and tree
`6ab93476b6aa124da6317fb8fd31e8b91c88259f`. A native Windows fixture checkout
was created from a checksum-bound archive of that tree. Its independent Git
identity and full command arguments are retained privately. Later CI repairs add
skip ownership and complete fixture copying; they do not change measured runtime
behavior. See [the implementation issue](https://github.com/boburning/portcove/issues/3805)
and [PR #3819](https://github.com/boburning/portcove/pull/3819) for final delivery.

## Matched workloads

Each phase ran three rounds of the same Linux static recipe plus the same Node
contract file on Linux and native Windows. Static execution retained browser
package compatibility, formatting, lint/types and CSS checks. Each Node invocation
ran all 15 named cases with no skipped, failed, cancelled or todo case. Full
per-platform case identities/outcomes and reporter source hashes match across all
six rounds; original timestamped reporter outputs are retained separately.
there are 30 platform-qualified Node cases per round. No measured payload had a
startup or assertion timeout.

Before adoption, Linux and Windows used their separate default pools and the
ordinary unwrapped Node route. After adoption, maintained Node selection opted
into admission and both platforms used one host slot. Source and dependency
locations were preserved. The private reporter records payload start/end events;
queue, setup/cache work and total command time are retained separately.

| Phase    | Round | Maximum observed payloads | Node cases | Linux Git-status p95 (ms) | Kernel CPU busy (%) | Kernel full I/O stall (%) |
| -------- | ----- | ------------------------- | ---------- | ------------------------- | ------------------- | ------------------------- |
| baseline | 1     | 2                         | 30 passed  | 16.00                     | 13.38               | 6.40                      |
| baseline | 2     | 2                         | 30 passed  | 22.09                     | 27.34               | 9.68                      |
| baseline | 3     | 2                         | 30 passed  | 25.86                     | 27.03               | 6.14                      |
| adopted  | 1     | 1                         | 30 passed  | 16.60                     | 13.41               | 8.35                      |
| adopted  | 2     | 1                         | 30 passed  | 19.76                     | 14.64               | 7.55                      |
| adopted  | 3     | 1                         | 30 passed  | 16.37                     | 15.34               | 5.19                      |

Git samples use the nearest-rank 95th percentile of successful repeated status
calls in the same warm Linux source checkout. Every observed p95 was below five
seconds. CPU and pressure deltas cover the shared WSL kernel, including unrelated
work; they do not attribute a physical disk or establish a causal speedup.

All adopted rounds observed at most one measured payload. Baseline rounds observed
two. Serialization increases waiting by design; this record does not claim shorter
total completion time or a universal throughput improvement. The first baseline
static command waited about 40 seconds behind pre-existing admitted work. The
first native Windows guarded run also incurred cold source/setup work; cache
build/hit messages and payload times remain separate from its total duration.

## Scratch, custody and recovery

- The dedicated owned scratch distribution passed checksum-pinned cold setup,
  physical backing-path and ext4 UUID verification, warm reuse, and guarded restart
  followed by the maintained automatic preparation path. Existing source and user
  distributions were preserved.
- Initial adoption applied under both full predecessor inventories. Repeating the
  unchanged adoption wrote no configuration. The maintained Linux Node route
  executed its real supervisor and host admission. Native Windows admission and
  its job supervisor were exercised in the matched adopted rounds.
- A live Windows identity probe exceeded the earlier five-second budget after test
  success. Custody was retained. Recovery through the original immutable verifier
  proved cleanup, then queued rollback restored all four exact preimages. This
  failure is retained; it is not counted as a successful initial cleanup.
- The reviewed repair gives Windows identity inspection a finite 15-second budget
  and bridge release a 65-second wait. Identity format, unknown/refusal behavior
  and payload deadlines are unchanged. All three repaired adopted rounds exited
  successfully.
- Fixture controls cover wrong/missing mounts, changed backing paths, explicit
  overrides, foreign edits, lost ACKs, uncertain cleanup, interrupted transactions,
  repeated recovery and live/unknown surplus predecessor slots. These controls
  supplement the bounded live observations; they are not whole-machine safety or
  product-native acceptance.

## Coverage and retained evidence

Raw reports, timestamps, source/cache records, case identities, configuration
preimages, rollback/recovery journals and failure logs are retained privately
under the task's `work/host-io` evidence. No cache or retained evidence was evicted.
The current source/runner inventory and immutable controller snapshots remain
machine-local. Only participating maintained commands are coordinated; older raw
Node commands, inaccessible processes and third-party work remain outside the
claim until updated or retired. Remaining HDD source/dependency reads are not
relocated by scratch allocation. Machine-global idle/health is not evaluated.

This record does not establish product runtime, protected release, signing or
publication acceptance. Required hosted checks and final merge/readback are
recorded on the PR, separately from these machine observations.
