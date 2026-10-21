# Same-entry credential-free semantic setup probe

This is source preparation for #534. No account, WSL guest, credential, Task,
service or runtime was provisioned or launched. Actual cold-start capability
remains Unknown until the one consolidated initial setup.

The existing `release-semantic-worker.mts CONFIG SHA256` entry accepts an explicit
closed initial-only configuration, alongside its unchanged normal worker schema:

```json
{
  "schema_version": 1,
  "kind": "portcove-initial-semantic-boundary-probe",
  "initial_setup_probe": true,
  "worker_revision": "EXACT_FINAL_CONTROLLER_COMMIT",
  "setup_grant_sha256": "EXACT_CONSOLIDATED_SETUP_GRANT_DIGEST",
  "source_git_sha256": "ACTUAL_USR_BIN_GIT_SHA256",
  "output_parent": "/home/BROKER_USER/private/semantic-output",
  "runtime": "EXISTING_STRICT_QUALIFICATION_CONFIGURATION_OBJECT"
}
```

Placeholders are deliberately invalid. `runtime` is the existing schema1 object
from `inspectLinuxQualificationConfiguration`: the same exact output parent,
fixed Node/Codex paths and hashes, supervisor hash and Python/bwrap/systemd-run/
systemctl hashes. No auth cache, source-read token, issuer/App key, outcome,
backend or arbitrary mode is accepted. The probe always selects `fixture`, never
`codex-fixture` or actual semantic review. It creates no review or Check authority.

The protected configuration has the fixed basename `semantic-setup-probe.json`.
Existing `renderSemanticWorkerUnits` and `renderSemanticWslWorkerTask` accept it;
the Windows action remains exactly `wsl.exe ... systemctl --user start --wait
portcove-semantic-worker.service`. The service still invokes the same worker
entry and retains Type=oneshot, Restart=no, KillMode=control-group, 45-minute
start ceiling and 30-second stop bound. No new Task or direct Node fallback is
introduced. Its timer remains disabled. Rendered `worker-state.json` has the
probe-only custody kind plus exact raw configuration SHA, source and setup pins.

The actual entry checks private owner/mode/ancestor custody, raw config/state,
clean pinned controller source, fixed Git hash and actual configured/running Node
hash before claiming the fixed `output_parent/initial-setup-probe` directory.
Atomic mkdir plus CreateNew/fsynced claim files refuse every repeat, including
concurrency, changed config or a retained refusal. There is no nonce override,
reset, automatic retry or promotion. Preconditions failing before the claim start
no fixture; any claimed attempt is retained permanently for setup reconciliation.

The worker writes a derived credential-free qualification configuration beneath
that claim and invokes the existing `qualify-semantic-linux.mts fixture` through
the maintained resource supervisor. The child gets the existing scrubbed semantic
supervisor environment, with no source/reviewer/issuer/API credential projection.
Admission uses the original module-entry service budget with a 30-second stop
reserve; the existing fixture itself retains its 60-second request bound.

The original fixture verifies its tool/runtime/source bytes and actual bounded
rootless unit/cgroup/namespaces/capture/network teardown. The worker rechecks its
source/config/tools, requires exactly one original q-* capture, and uses the same
extracted positive settlement predicate as the fixture. It hashes the unchanged
original isolation bytes and writes `probe-settlement.json` with authority none,
authenticated false and semantic/native acceptance false. Failure writes a fixed
`probe-refusal.json` and leaves the claim and all q-* evidence in place.
This inner fixture result does not by itself prove the outer Task or fixed service
has stopped: independently retain their original completion/inactive/empty-group
readback after the cold Task invocation, using the existing fixed readback route.

After a positive cold probe and outer settlement, initial setup must keep Tasks
and timers disabled while explicitly sealing the ordinary worker configuration,
normal worker-state, changed exact service bytes/hash and corresponding Task-plan
readback. This is a manual setup transition under the consolidated grant, not an
automatic credential promotion. Preserve the original probe configuration, claim,
refusal/settlement and capture. A refused or Unknown probe cannot be promoted or
silently rerun. The normal worker path and its credential separation are unchanged.

Local source validation: 29 focused worker/Task/supervisor/broker cases passed without skips,
including a controlled actual-entry module invocation, real filesystem concurrent
claim/repeat refusal, exact Task action/service rendering and shared positive
settlement refusals. Changed-module typed lint passed. Initial feedback retained:
the new test first supplied network_refused=true although the maintained positive
fixture contract requires false, and its Windows-only mocked executable basename
needed explicit treatment. The assertions and production predicate were retained.
These controlled tests do not establish actual Linux/WSL or native acceptance.
