# Manual recovery of an owned resource record

The owner authorizes carefully engineered manual recovery when the maintained
guard cannot interpret a task-owned record. A missing automatic recovery route
does not itself require another permission request. This procedure preserves
resource admission and process-containment protections; it does not authorize
reclaiming another worker's records or treating uncertain process exit as proven.

Prefer the maintained recovery route when it can handle the observed failure.
Use a bounded manual procedure only for the specific damaged record that prevents
that route from operating. Follow the ordinary independent review and validation
requirements for a consequential mutation. Keep the failed command and all its
evidence, including unsuccessful recovery attempts.

## Establish ownership and quiescence

Record the exact absolute resource root, parent and child paths, reservation token,
wrapper/child creation identities, command, workspace, raw bytes, sizes and hashes.
Preserve immutable before copies outside the active admission directory. Resolve
the actual resource location and refuse unexpected links or path traversal.

Establish that the record belongs to this task. A matching filename, old timestamp
or absent PID alone is insufficient. Correlate the token, recorded command and
workspace with the task's retained execution evidence. Preserve every unrelated
reservation, queue item, process and output.

Prove the relevant containment is quiescent. Use the maintained supervisor's
identity-bound positive exit and cleanup evidence where available. A verified
later operating-system boot can independently establish that recorded processes
from the earlier boot cannot still be running on that host. Bind boot time and
recorded process creation times to the same host; do not extend that proof to
another host, an independent namespace or unobserved external processes. Unknown
ownership or incomplete quiescence remains a hold, with its exact missing fact.

## Design and review the smallest mutation

Write a finite proposal that names the exact preimages, mutation, retained
destination, postconditions and failure behavior. Prefer retaining the malformed
leaf under a new name rather than deleting evidence or modifying a valid parent.
Never create a replacement capacity record, successful test result or supervisor
cleanup receipt to make admission appear satisfied.

Coordinate with the actual maintained acquirer. Use its exact token-specific
reclaim claim or an equivalent synchronization boundary verified against that
implementation. An unrelated mutex or a momentary "no process found" observation
does not exclude a concurrent acquirer. Hold the claim through mutation and
readback, and release only the claim created by this recovery.

Compare fresh preimages inside the mutation boundary. On Windows, a reviewed
implementation can hold the parent against writes/deletion, open the child leaf
without following a reparse point, check its regular-file/single-link identity
and held-handle hash, then rename that same handle on the same volume without
replacement. Equivalent implementations must establish those properties; a
path-based hash followed by an unchecked path-based rename leaves a race.

Refuse changed bytes, identities or ownership; an existing reclaim claim or
retained destination; unsupported file types; and unavailable exclusion/handles.
Do not broaden the proposal to other malformed records merely because they have
the same symptom. Review the actual mutator and its interaction with the guard,
not only a prose description.

## Validate, execute and reconcile

Exercise the mutator against disposable records before touching the real one.
Cover success, changed preimages, destination collisions, held handles, an existing
reclaim claim and a real maintained-acquirer interleaving. Add controls for other
refusal branches on which this recovery relies. Retain failed controls and repair
their causes without weakening the original ownership or preservation assertions.

Execute only the reviewed bytes, with fresh ownership, quiescence and preimage
checks. Record the applied operation separately from the original failed command.
Verify the retained file's identity/hash, the original leaf's absence, unchanged
parent and unrelated records, and removal of only this recovery's temporary claim.
Use non-overwriting, durable evidence writes. An ambiguous result requires readback
and reconciliation before another mutation; do not automatically retry.

Resume through the normal resource guard. The guard still decides whether the
remaining parent/containment state permits admission. Successful retention alone
is not a cleanup receipt, test pass or proof that the original command completed.
Keep source, command, package and native-observation boundaries attached to any
subsequent validation.

This is a recovery engineering procedure, not a generic delete-lock command.
The October 19 [#2177](https://github.com/boburning/portcove/issues/2177) recovery retained one exact 235-byte malformed child sidecar
after a verified Windows reboot, preserved its valid parent and all foreign
records, then resumed through maintained admission. Its private evidence retains
the proposal, exact script hashes, eight disposable controls, separate review and
applied readback. It does not establish a safe recovery for a different record.
