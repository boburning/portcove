# Ordinary Windows native job: sampled resource observation

Owner: #534. Actual [40686760408/1](https://github.com/boburning/portcove/actions/runs/40686760408),
job `122810994530`, ran source `0013a9d2454c55a85e0f00b469fa2ed4d8ae7bb9`,
tree `dca11c485fe0a148a0d47f688fc3b9b2b07084b6`. Its one complete provider job
passed in **4,494 seconds (74m54s)**, from `12:18:47Z` to `13:33:41Z`.
Runtime/driver preparation took 116 seconds, qualification-feature compilation
284 seconds, and the two-version build/installed-updater rehearsal 4,004 seconds.
This ordinary job builds both fixture versions. It does not measure the protected
controller's prebuilt-candidate graph or prove that graph fits its resource policy.

The [structured receipt](slice4-hosted-resource-observation-2026-10-28.json)
retains exact artifact, package, process, observer and cleanup identities.
The earlier [two-sample interruption](slice4-hosted-resource-observer-2026-10-28.md)
remains a failed resource observation; this later source and run do not rewrite it.
The separate 34-second counter-only canary `40684148477/1` qualified the repaired
cross-step observer before this single full measurement was dispatched.

## Counter coverage and limits

All 896 original JSONL rows and 478,138 bytes independently match SHA-256
`642429b567710dfb81100b7457fd1b6ee88efa31f999afdbea94e8959e2ad693`.
They span elapsed 16–4,475,047ms, from `12:18:57.0649453Z` to
`13:33:32.0907855Z`; the largest monotonic sample gap is 5,129ms.
The original observer wrote its terminal record at 4,477,499ms with
`stop-requested`, matching row/byte counts and final newline, zero parse errors,
zero counter-error samples, zero missed intervals and no forced stop.
Its context identifies this exact source, run, attempt, workflow ref and job.
The actual script hash matches the exact reviewed Windows CRLF projection,
`9c8b28c423ddb47b41bf2ea9e44df1e45f1d59c76c7cd2eb45d2e45068333d48`.

| Sampled machine counter                              |       Observed value |
| ---------------------------------------------------- | -------------------: |
| Visible physical memory                              | 17,174,360,064 bytes |
| Maximum sampled machine used memory                  |  6,560,124,928 bytes |
| D: minimum sampled free bytes                        |      146,124,566,528 |
| D: largest sampled free-space fall from first sample | 11,720,794,112 bytes |
| C: minimum sampled free bytes                        |       84,750,331,904 |
| C: largest sampled free-space fall from first sample |  2,509,504,512 bytes |

These are machine counters during this job, **not process/job attribution or
continuous peaks**. Provider setup before the first sample, changes between
samples, and work after the last sample remain unobserved. Both relevant fixed
volumes and memory are available in every row. `sampled-through-finalizer` means
the bounded sampler stopped and reconciled its complete output, not continuous
coverage through artifact upload or provider teardown.

## Artifact and native readback

Resource artifact `12820052270` is 482,567 bytes, SHA-256
`03f5dc01d129406c5eb9786e84e800c1f312896f3f960921d73a0b44ce4e058b`.
Native artifact `12818954985` is 95,753 bytes, SHA-256
`98fe33d701b9f6e164a4b206f1239553c758dc3db419cb7ad205d25c95855042`.
Complete attempt/job and artifact inventories, full job logs, before/after
provider metadata, bounded ZIP preflight, CRC, member hashes and independently
recomputed raw-counter statistics passed. Public artifact retention is seven
days. Original raw files are also retained under the canonical checkout's ignored
`work/qualification-534/windows-native-usage-0013a9d2-40686760408-1`, independently
of the managed source worktree and private-run cleanup, with a verified retention
manifest. These are public diagnostic observations, not secrets or a trust root.
The independent owner recomputation and its corrected verification precondition
are retained alongside the original raw files. Available-to-caller and total-free
space are distinct non-atomic counters: one row differs by256KiB, so equality
between them was an invalid verifier assumption. Both were independently bounded;
their recorded minima agree here. The original and final verifier receipts and
correction are preserved separately, with no raw sample rewritten or rerun.

The ordinary installed/UI rehearsal observed `1.0.0-rc.2` → `1.0.0` on one host.
Candidate NSIS bytes are 13,732,330, SHA-256
`7e5953d4b0148e72769a05d44a2dc25ede9454b961b946b0852bebdcc6fc7568`;
its installed executable is
`c861a0c96959bac539a40824a36ad20e0c7901d4f29c1c31b5a2fd0fb2ab75aa`.
The same-job disposable payload/TUF signing inputs were absent before consumption;
the NSIS signature status is `NotSigned`. No production signer or feed was used.
The actual registered WebView runtime changed from `131.0.2903.86` to
`156.0.4314.50`, above shipping floor `155.0.4283.62`. Runtime preparation itself
reported 53,028ms; the complete runtime/driver provider step took 116 seconds.
Actual Microsoft EdgeDriver reported `156.0.4314.50`, SHA-256
`dd728c934e491abe7e8a07fa366aad135ea15d934cbba99192ad872da59c39d3`.
Tauri-driver bytes are
`0a31766ad09238e0fe32f962d02330e4bd9f983b50beb89093562a6b090c8457`;
its unsupported `--version` returned 1, so this is not independent version or
publisher authentication. Direct application child paths observed WebView
`156.0.4314.50`; paths alone do not authenticate engine bytes or publisher.

Truncated and changed-byte staging refused, recovery repair completed, and the
renderer reported download/verification, restart and reconciliation. The retained
pre-restart screenshot was inspected: it shows the verified `1.0.0` download and
Preview/Manual settings, with an interface-size confirmation warning also visible.
That warning was not investigated; no global UI-health claim is made. The harness
reported managed files and registration removed and fixture data preserved.
Current-installed/private-account boundaries and package rollback remain null.
This establishes ordinary qualification and sampled resources only: no protected
candidate/private-session proof, production publication, #315 managed acquisition,
or #246 unchanged-client catalog journey is claimed. No automatic retry occurred.
