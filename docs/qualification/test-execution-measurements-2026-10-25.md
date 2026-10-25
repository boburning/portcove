# Bounded Node execution measurements, October 25, 2026

Audit19 in #2420 investigated explicit file concurrency on Windows x64 with the
pinned Node 24.22.1 at source `8ac0a9c1dfd906ef98798a8b5e3e9bc52fdc59e8`.
The maintained analysis admission and Windows process-tree supervisor contained
the commands. Payload wall clocks start after admission; warm shared caches and
sequential runs do not establish cold or hosted Linux performance. Case identities,
outcomes, selected input hashes and raw logs are retained separately.

| Workload                              | File concurrency | Payload seconds, in execution order | Outcomes per invocation                                     |
| ------------------------------------- | ---------------- | ----------------------------------- | ----------------------------------------------------------- |
| Three pure contract files             | 1                | 0.550, 0.540, 1.004                 | 19 passes                                                   |
| Same pure files                       | 2                | 0.399, 0.555, 0.386                 | 19 passes                                                   |
| Two Git/hook fixture files            | 1                | 67.940                              | 24 passes, 1 skip                                           |
| Same Git/hook files                   | 2                | 68.623, 203.523                     | first: 24 passes/1 skip; second: 23 passes/1 failure/1 skip |
| Two Node child/reporter control files | 1                | 13.241, 6.735, 7.236                | 25 passes, 1 skip                                           |
| Windows driver fixture controls       | 1                | 11.723, 9.950, 6.095                | 9 passes                                                    |

Pure pairs used orders 1/2, 2/1, 1/2. The Git comparison stopped at its first
failure: an actual `spawnSync git ETIMEDOUT` during disposable-repository setup in
`indexed additions, renames and removals change one ownership record before
generation`. No retry, assertion removal or timeout increase followed. Its cause
is unclassified; the experiment does not prove concurrency caused it. The intended
three successful Git pairs were not completed. Original failed fixture evidence
remains retained. Child and Windows controls then ran separately, always serial.
The Windows tests exercise inert fixtures and child streams, not an installed app
or account journey.

Across 15 invocations there are 287 passes, 6 skips and 1 failure. Case identity
sets match within each workload. Required execution inventories are complete,
including the failed invocation; completeness is separate from success. Each Node
runner PID was absent after exit, and both admitted supervisors returned after
their owned-tree cleanup. These observations do not establish cleanup after an
outer CI job kill.

The experiment provides no basis for changing global file concurrency or the
required serial families. The small pure sample's median improves, but one paired
run is slower and the Git candidate fails its verification criterion. Existing
limits remain. The source-bound evidence is retained under
`E:/Codex-Evidence/testing-suite-improvements-20261022/`, particularly
`node-concurrency-disposition-v4.json`, its two hashed measurement files and raw
per-invocation logs. The initial private launcher failed before execution because
Windows imports need file URLs; that failure is retained separately from the
measured payloads.
