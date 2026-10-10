# Managed CHD preparation and Windows process exit — October 10, 2026

Component owner: [#135](https://github.com/boburning/portcove/issues/135).
Prepared consumer: [Forbidden Memories #141](https://github.com/boburning/portcove/issues/141).

Initial managed PS1 CHD materialization now forwards its operation checkpoint to
the existing host-tool supervisor and combines positive helper quiescence with
the prior preparation state. Successful later builders cannot erase uncertainty.
This component does not qualify multi-disc runtime extraction, an actual upstream
producer, installed gameplay, the complete installer cancellation lifecycle, or a
historical 0.6.1 to 0.6.2 update.

## Discriminating failure and repair

Windows job termination is asynchronous. A native descendant handle test disproved
the first accounting-only implementation: run
`ac10cd02-199b-4ad2-b5bf-348f8fb2685a` had five passes and one failure; its callback
observed `WAIT_TIMEOUT` (258) on the retained live descendant handle. Instrumented
run `fad3309a-f838-4a8b-8101-406d91882927` reproduced that failure even with lifetime
accounting of two processes and an empty current process list. Neither zero active
accounting nor closing a kill-on-close job is sufficient positive exit evidence.
See Microsoft's [termination contract](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)
and [job information query contract](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject).

The repaired supervisor retains the leader handle before resuming it and captures
handles for verified members during execution. It requests termination, waits for
all retained handles within one shared two-second deadline, then requires zero
active processes and lifetime accounting equal to complete handle coverage.
Queries and lifetime storage are bounded to 512 processes. Missing, truncated,
failed or expired evidence holds preparation and keeps the callback unavailable.
Short-lived children missed between snapshots therefore cause a safe refusal;
actual upstream builds still require their own evidence.

## Focused observations

Run `185323d0-9590-4368-823a-c9fb01d6cd35` passed all 18 selected Windows tests in
23.163 seconds, with 1,212 tests skipped. It includes:

- Actual descendant handles signaled before the callback on natural completion
  and cancellation.
- A real child completed entirely between membership snapshots; successful
  leader exit returned a held State error without a quiescence callback.
- Failed job observation, fixed host-tool probe outcomes, probe timeout, managed
  builder descendants, diagnostic failure, output bounds and native cancellation.
- Initial CHD pre-spawn cancellation, prior uncertainty, nonzero exit 29, and a
  durable request while generated private cue/track files already existed.
  The registered source and private partial files remained present.

Earlier timing failures remain distinguished from the repaired exit proof.
Run `59ad1353-ab7b-4bbe-8698-62269d40e886` had 14 passes and one failure in the CHD
test's initial three-second whole-call assertion. Instrumented run
`aadf8ab5-ea6c-4ac9-bc95-e83a3b0a989a` recorded helper readiness at 251.6193 ms,
durable cancellation acknowledgment at 3.088247 seconds and helper return at
3.1646548 seconds. The revised test measures the unchanged three-second stopping
bound after acknowledgment, separately from service admission; the supervisor's
two-second deadline, nextest's two slots and 30-second test limit remain unchanged.

These are first-party native helper fixtures on Windows, not upstream/gameplay or
physical interruption evidence. Unix process-group escape remains conservatively
unproven. The Linux GLib security hold and existing source, toolchain, publisher,
activation, persistence and recovery guards remain authoritative.

## Resume condition

After separate source review and exact-head required CI, deliver this bounded
component through #135. Resume #141 only with an admitted isolated producer route
bound to actual source, artifacts, toolchain, resource limits and positive worker
exit; record any lifetime-coverage refusal rather than treating these fixtures as
successful upstream production. A valid historical 0.6.1 baseline or separately
reviewed historical-artifact producer harness is still required for the prepared
0.6.1 to 0.6.2 progression. Keep both canonical issues open for remaining scope.
