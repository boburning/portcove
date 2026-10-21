# Fixed controller transport preparation

The reader composite must allow a worker to request an upload or its sole role
key between control rounds. Waiting for every round before those Actions steps
would deadlock the worker. The prepared replacement has forty sequential slots.
Each slot routes one fixed control-ready, role-key, signature/context/result/site
upload, or final predicate attestation event. It cannot select commands, actions,
credential roles or an arbitrary backend. The final DAG still owns activation.

Producer hooks publish job-local locators only after the existing ready file or
authenticated pending operation boundary; the key locator follows the actual
socket listen and mode change. Upload acknowledgements retain the existing
`artifact_id`/`sha256` shape (site uses `artifact_id` alone), use exclusive creation,
and remain untrusted locators until the existing producer verifies provider bytes.
The composite pins the existing upload and attest Actions. Uploads keep seven-day
retention, compression zero and no overwrite. Only the key-client step receives
the job's sole key/password and maps them into the existing challenge socket.
The key slot starts one fixed client concurrently, with only the required runtime
environment and that sole key. This lets a payload-signing callback request a
fresh control round before it acknowledges key consumption. The client records
only public PID/start identity and exit disposition. Final completion requires
the actual socket acknowledgement, a successful client result and kernel proof
that the original process has exited (including zombie or reused-PID identity).
Missing or failed client evidence stops the job; no client is retried or signalled.

The first slot observes the actual fixed provider job and retains a bounded,
hash-bound source/run/ref/job/start clock. Later subprocesses intersect the
original wall-clock expiry with the same host monotonic expiry; they neither
repeat the provider GET nor restart the phase budget. This clock is resource
metadata, never role admission. Existing factories independently authenticate
their own original job and controls.

The old control marker remains exactly `{exit_code}`. The new pump separately
requires `controller-job-settlement-PHASE.json` with exactly
`{exit_code,requires_attestation}`. A successful producer exit does not complete
required attestation. The trusted job wrapper must retain the actual fixed
subject/predicate locator before settlement, and the pinned attest Action must
return before the pump acknowledges it. A genuine no-op may explicitly require
no attestation. Failure, exhausted slots, expired time, changed bytes, missing
acknowledgement or malformed settlement stops the job without effect retries.

Local tests exercise real temporary-file routing across control round zero,
pending context upload acknowledgement, round one and final attestation. They
also exercise unchanged original timing under wall-clock rollback and refusals
for cross-role routes, changed public bytes and incomplete attestation. Linux
socket cases remain separately qualified by their existing harness; Windows
skips do not establish a live socket or hosted Actions execution. No protected
controller, signing, publication, credentials or setup changes were performed.
