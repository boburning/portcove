# Windows connected-launch failure and measured resources, 2026-10-28

[Run 40757208872/1](https://github.com/boburning/portcove/actions/runs/40757208872)
used exact source `c54067f939d6ea37f89eab19614893968e831806`, tree
`b3bfda78ca7b33723050b93d4aba603898e1de65`, and job 123059209017. Both independent
source reviews, all five exact-head CI contexts in 40753465129/1, and all 12 actual
Windows account-file controls passed before the single workflow POST. The job
failed after 3995 seconds within its unchanged 90-minute limit. The
[structured receipt](slice4-connected-windows-launch-2026-10-28.json) preserves
exact artifacts, phases, bytes, hashes and scope.

The maintained runtime/driver step passed in 109 seconds; runtime preparation
itself took 55113ms and changed 131.0.2903.86 to 156.0.4314.50 above floor 155.0.4283.62.
The driver version check reported 156.0.4314.50. Its binary hash was not retained
publicly in this attempt; no older run's driver hash is attributed to it. The
feature compile passed in 252 seconds and ordinary two-version installed updater
rehearsal passed in 3556 seconds. The same-job producer retained its bounded 8128-byte
fixture-derivation record after restoring the original tracked metadata and
removing disposable private signing inputs. That record observes producer
execution; it does not independently reproduce or authenticate the private NSIS
bytes. The retained screenshot shows a verified 1.0 download with Preview/Manual
settings and the already-recorded interface-size confirmation warning. No global
UI-health claim follows.

The connected launch failed at launcher line 33. Application discovery returned
both the setup-node 24.22.1 executable and the image's Program Files Node executable.
The array became a space-joined command when invoked. Source ordering places this
after shared Setup assembly/control-directory ACL preparation and before the
original controller's CreateProcess call at line 81. Consequently this start did
not reach the original C/A/B, account, station or candidate path. No independent
post-VM OS account inventory was performed. All private upload/ACK, recovery and
terminal-controller steps were skipped; neither controller-ready nor settlement
files existed, as the retained upload warning reports. Ordinary runtime/install
prerequisite effects are separate from that unreached private path.

The repair resolves one PATH-first Application, requires the original scalar,
regular node.exe and exact 24.22.1 version before creating the control directory,
and refuses a wrong first version instead of selecting a later executable. A
Windows-helper-route control constructs two actual Node paths and checks both
normal priority and wrong-first-version refusal. Its actual hosted Windows
execution remains required; a Linux skip is not qualification. The source-held
launch and all production gates stay false in main. This failure does not grant
automatic retry, standalone S1 execution, a production grant, key use, signing or
publication.

Both artifacts and all 20 members passed bounded ZIP preflight, CRC, hash and
stable before/after provider readback. Independent raw-resource closure verified
796 complete rows/424733 bytes with terminal counts, final newline, source,
original observer PID 8072/birth and exact sampler LF/CRLF source binding. The
observed span is 3975015ms with maximum gap 5123ms; no counter/parse errors, missed
intervals or forced stop occurred. Maximum sampled machine memory used is
6604443648 bytes; minimum free space is 146111258624 on D: and 84738412544 on C:.
These are sampled machine counters, without job/process attribution, continuous
peaks, provider setup before the first sample or work after the last sample.
They are not protected graph fit or a billing limit. The repository's effective
100 aggregate-job-minute policy remains unchanged.

Original public raw evidence is retained independently of the managed source
worktree at `work/qualification-534/windows-connected-native-c54067f9-40757208872-1`:
299 initial regular files/3865348 bytes, with a verified manifest; later owner and
independent readbacks remain separately identified. Seven-day provider retention
is not the durable store. Only after terminal status and independent complete
readback, the exact temporary remote branch was deleted using a lease against
c540; API404 and empty exact git ls-remote verified absence. Local source, PR 3913
(closed/unmerged), failed inputs and raw receipts remain preserved. No source,
artifact or prior failure was relabeled, overwritten or rerun. Connected private
acceptance, production publication, #315 managed acquisition and the #246 unchanged
installed-client journey remain unestablished.
