# Bounded reviewer diagnostic: home metadata access denied

Owner: #534. The exact #2153 completion, single conditional diagnostic and
matching recovery grant is fulfilled. No further operator command is pending
under that grant. Both retained images and all failed evidence are preserved.
No additional fixture, fill probe, authentication transfer or permission change
is authorized by this result.

## Actual result

The owner completed the existing second image at
`2026-10-19T00:35:38.1240014Z` (October 18, 20:35 EDT). The result reached
`storage-receipt-written`, with no provider/readback error and positive attachment
readback. Independent readback confirmed the exact NTFS volume, size, configuration
and helper identities. No image creation, initialization, partitioning or
formatting occurred. This proves completion of the prepared storage operation;
it does not prove access by the restricted reviewer token.

Exactly one credential-free `codex-fixture --bounded-storage` invocation ran
non-elevated after resource admission. It waited 72,345 ms for admission and
finished with exit 1. Its run root is
`work/slice4/semantic-isolation-ttTNEZ`. The installed Codex executable retained
SHA-256 `dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f`.

The captured stderr reports that it could not read the bounded `CODEX_HOME`
ending in `data\semantic-isolation-ttTNEZ\home`, with access denied / OS error 5,
followed by a fatal access-denied error. Stdout has zero bytes; stderr has 581.
No review events, fixed-reader invocation, authentication error or semantic
report was observed. The fixture remains **failed**. Neither the warning nor
stack symbols identify the later fatal OS call.

The actual isolation receipt confirms the expected AppContainer/profile SID,
complete capture, empty process tree, no forced termination, deleted temporary
profile and no cleanup errors. `bounded_grants_removed` is false. The owner
therefore used the reviewed **RecoverDetach**, with this attempt's new receipt,
rather than normal Detach or a prior receipt. Independent readback at
`2026-10-19T01:13:59.4321015Z` (October 18, 21:13 EDT) confirms the exact image
detached, logical size 536,870,912 bytes, retained backing size 536,871,424 bytes
and retained active marker. No fixture retry occurred. The full owner output
also confirms `grants_removed: false`; grants remain in the detached image.

## Retained identities

The following are task-owned local evidence beneath
`E:\Codex-Worktrees\slice4-admission-delivery\work\slice4`; none is a protected
acceptance record or proof of current provider capacity.

| Record                                                                     | SHA-256                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `semantic-storage-2fda9f572e3843b5b16190a100b5275c/completion-result.json` | `257e7ce199c1d89b7f24e325bc8479793c36578a08f56c29337ae17e73350015` |
| Same root, `storage.json`                                                  | `e460767ea301dc5e8e7ac515d0e52a40622b10de031f63cdd3cd696174acaaec` |
| Same root, `reviewer-active.json`                                          | `0ab15171c42aa3ce88e410a58768fb329af24e516afb938fcb29da8dc56dc52a` |
| `semantic-isolation-ttTNEZ/capture/isolation.json`                         | `6e0df90d8548beab992da4b03fcebac791ba71497be3fd9eacfaa70f180f4ce8` |
| Same capture, `stderr.txt`                                                 | `c9b1d900aed816eb6bedd0029715d52cbdaa84933d22134e5bb805db9857293f` |
| `semantic-bounded-storage-single-diagnostic-evidence.json`                 | `3ce02e126f7b873a350b79bb2e614408f94df6bab57690b40d960c94936b65b1` |

Invocation intent, resource/admission output and exit are retained separately in
`semantic-bounded-storage-single-diagnostic-intent.json`,
`semantic-bounded-storage-single-diagnostic.log` and
`semantic-bounded-storage-single-diagnostic-exit.json`. Post-recovery provider
observation is `semantic-bounded-storage-recovery-readback.json`.
The original read-only-home access-denied result and both earlier partial
Provision/recovery outcomes remain unchanged; this attempt does not replace them.

## Source-level localization and next boundary

Pinned Codex `rust-v0.162.0` source commit
`c1382380de69521303b416720a52f42d51af6248`,
`codex-rs/utils/home-dir/src/lib.rs:26-34`, wraps `std::fs::metadata(CODEX_HOME)`
with the exact `failed to read CODEX_HOME` message. Its later canonicalization
has a different message. Thus this captured warning maps to the directory
metadata stage, before canonicalization, installation-ID creation, SQLite/log
writes or authentication. The local source copy is
`work/slice4/codex-0162-utils-home-dir.rs`, SHA-256
`1338259489ade54b01caa1468b6d25fc5a183657fa94cca0add8b91865635ef5`.
This is source analysis, not a trace of the exact denied Win32 operation or a
reproducible-build binding of the installed executable to that source commit.

The launcher granted the per-attempt data directory and created home/work/temp
inside the private volume. Its retained ACL command logs report successful
commands, but do not include full security-descriptor readback or restricted-token
metadata checks for the volume/mount ancestry and those directories. Successful
owner access does not prove reviewer access. The missing observation is the
actual restricted-token metadata/access result along that exact path, with
corresponding retained ACL/integrity descriptors. Do not infer a specific missing
ACE, remove the isolation boundary or widen ancestor permissions from this result.

The next bounded engineering action is to localize that access check before
choosing a repair. Any new native observation must have a concrete reviewed
scope and applicable authority; this consumed grant permits no reattach or
fixture repeat. No new diagnostic execution decision is requested by this
receipt. No usable authenticated runtime, whole-opportunity report, producer
App/installation/CheckRun binding or protected execution is established.

#254 stays Done; #315/#534/#246 acceptance remains pending. Chameleon protected
acceptance stays unset. D1/D2/D3 and bounded-attempt capacity with Unknown
availability/headroom and no reservation remain unchanged. Production remains
held and slice 5 excluded. Upstream repair adoption and two real repaired game
artifacts remain separate dependencies; framework test binaries do not supply
that pair.
