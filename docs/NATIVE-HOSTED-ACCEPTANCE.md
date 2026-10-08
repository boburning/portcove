# On-demand hosted native acceptance

Explicitly requested, manual-only hosted acceptance may use an isolated standard
GitHub Windows runner and the maintained Selenium/Tauri desktop harness. It is
not routine CI, a schedule, a blanket required status, shipping-package or
minimum-OS qualification, physical-device evidence, or human observation. It
does not migrate the client or change the outstanding #1033/#1037 pilot boundary.

The Windows backup-focus job in the registered manual compatibility workflow builds a clean, explicitly recorded merge of its
workflow source and the reviewed focus candidate. The two input heads and merge
parents remain distinct. A conflict stops before building; nothing is pushed.
Normal application mode is required, not the design-compatibility fixture.

Exactly one `native-backup-delete-focus` scenario checks two successful native
deletions: focus on the matching remaining backup action, then focus on Saves and
storage after an uninstalled port's final backup removes history. Owned fixture
setup and supported CLI removal prepare the second state; they are not native
uninstall acceptance. Native consent, unchanged bytes before consent, committed
inventory, natural renderer focus and preserved unrelated bytes are separate
assertions. Never force focus or retry a mutation to make acceptance pass.

The first run is a feasibility probe. Actual Tauri/WebView2 launch, same-session
native UI Automation access, visible exact owned consent, enabled target button,
real mutation, post-completion focus, retained screenshots and positive owned
process exit must all succeed. A WinForms fixture or WebDriver connection alone
does not establish this. A blocked/noninteractive session remains a failed or
inconclusive probe; do not configure login, RDP, security or another runner to
hide it. Preserve existing per-interaction, watchdog and process-identity guards.

Record the runner image, OS, session, input revisions, executable hashes,
driver/application/WebView identities, scenario outcomes, screenshots, timing and
cleanup. Inspect the recovered images themselves before a visual claim.

The backup-focus route captures its driver at launch and requires an unchanged
root identity before quitting the session. Its opt-in `SnapshotDriverTree` uses
the existing chronological process-tree owner to retain the native driver,
application and WebView descendants. The raw snapshot remains immutable; a
labeled derived inventory includes the same driver root for the existing
five-second positive-exit check. Quit errors remain failures after identity-bound
cleanup. Ambiguous identity never falls back to a PID-only termination. Other
scenarios and existing snapshot/stop/wait modes are unchanged.

Existing issue #1360's EdgeDriver signature-before-invocation repair must be
included in the actual qualification source before Windows bootstrap or dispatch.
The route does not waive signature/publisher verification or execute an unverified
driver to collect its version. A passing compile or CI result cannot discharge
this direct trust dependency.

Use standard public `windows-2022` compute only. The workflow writes no Actions
artifacts or caches. Its dedicated bounded evidence encoder retains the real PNG,
JSON and log bytes in ordinary job logs, which GitHub documents as outside the
artifact-storage allowance. Recover those records with
`node scripts/native-backup-evidence.mjs recover <job-log> <new-directory>`;
missing, reordered, corrupt, excessive or incomplete records refuse recovery.
Verify source/run identities and hashes before inspecting the actual images.
Log retention remains GitHub's existing retention; download promptly. Failure to
retain/recover required images leaves acceptance incomplete, never synthetic.

Sources: [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
and [standard public runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

All existing pre-change validation policy, applicable selected checks, separate
nonwriting review and exact-head hosted checks remain required for implementation.
Native acceptance is a distinct obligation. This manual route supplies no policy
waiver, merge authority, replacement release gate or permission change.

## Reviewed Cloud validation and Linux history

The manual compatibility workflow also provides fixed `bootstrap`, `selected`,
`compiled`, and `qualification-history` operations on standard public Ubuntu
24.04. `bootstrap` runs complete fresh selected validation and a separate complete
fresh audit. Their outer allocations are 60 and 30 minutes; compiled acceptance
has its own 120-minute allocation and native presentation 45 minutes. These are
job allocations, not changes to product or child-command deadlines. The maintained
compiled command retains its 600/180/15-second children and default resource/profile
choices. No phase retries automatically or promotes another phase's result.

Before dispatch, independently review the exact source and controller commits,
base/merge-base/authority, complete regular-file changed inventory, workflow and
executable hashes, and the full candidate-root selected plan. The binding JSON's
SHA-256 must be the externally admitted digest. `bootstrap` is execution under
test: Primary's separate source-bound admission is required; a candidate-produced
plan or PASS cannot admit itself or make its controller trusted. The original
`deep-quality.yml` local-check operation still refuses authority changes.
Baseline obligation arguments are preserved exactly; newly reviewed obligations
are additive. No arbitrary command is accepted through dispatch inputs.

The source and controller use separate clean checkouts without persisted checkout
credentials. Existing pins, audit/recipe authority, resource guards, and test-tree
containment remain unchanged. Setup is explicit in the hosted workflow, never
implicit in ordinary checks. Selected setup installs frozen dependencies through
Corepack using the source package-manager pin, populating the provider cache
observed by preflight and used by the retained selected recipes. A separately
installed pnpm executable alone does not establish that cache prerequisite.
Preserve the actual preflight report before rejecting an identity, plan or
prerequisite mismatch; retention does not turn a rejected plan into acceptance. The full audit is not selected validation, and neither
is a substitute for required exact-head CI or native acceptance. The preserved
audit job/provisioning bytes must also be reviewed when a controller workflow changes.

The Linux history scenario uses the normal Tauri application and the existing
Selenium/Xvfb/dbus harness. Only read responses are supplied: maintained Snap64
history and synthetic external/user-prepared branch state. It verifies the scoped
failure alongside other kinds, technical disclosure reachability/toggling, both
themes and representative measured layouts. The 20px root-text view is explicitly
synthetic text scaling, not OS scaling or minimum-version evidence. No game launch,
file registration, acquisition, native consent or physical controller is qualified.
Interception and root-text/window state are restored; original native sources must
remain empty in the isolated library. Existing process-identity and exit proof apply.

A16's frozen product commit and the A17 controller commit are separate inputs.
The native consumer must include both reviewed changes at an explicitly recorded
clean integration commit; record parents, executable hash and the four product-file
hashes. Evidence from this integration tree is not silently credited to the original
A16 tree. Reconcile/review affected target changes before acceptance or merge.

The fixed `candidate-consumer` operation permits selected, compiled and history
execution before controller merge, strictly as execution under test. Its externally
admitted binding adds `consumer` with exactly `controller_tree`, `source_tree`,
`product_source` and `product_tree` (full Git tree/commit identities). The controller
must descend from the actual declared base and stay within the fifteen controller
paths, including the existing Windows CI analyzer acquisition step. The integration
must descend from that controller and differ only in all
four reviewed A16 product paths; their regular-file modes and blobs must exactly
match the separately reviewed product commit. The product commit's own merge-base
diff must contain exactly those four paths. The complete integration inventory,
baseline and full selected plan remain independently reviewed and digest-bound.
This operation cannot execute audit; bootstrap's separate complete audit obligation
remains. Primary must admit the exact final controller and composition before
execution. The ordinary operations retain their controller-ancestor-of-base refusal;
neither candidate PASS nor candidate plans establish trust or merge authority.

These jobs do not upload artifacts or caches. They emit bounded lossless JSON/log/PNG
records through the existing evidence codec. Direct `gh` artifact/job-log redirects
were denied on the Cloud host; the supported GitHub connector's decoded job-log
reader actually returned a complete existing job log. Retrieve the identified
job through that reader and materialize its complete decoded text, then run:

```bash
node scripts/native-backup-evidence.mjs recover-hosted job.log new-evidence expected-binding.json
```

The expected binding supplies source/controller/base/run/attempt, fixed job name,
execution phase and binding SHA-256 from the admitted inputs and actual run/job
readback. Recovery checks complete ordered
records, compressed and per-file digests, byte/path limits and terminal identity.
A passing audit retains its maintained raw complete-audit receipt separately from
selected execution evidence. A passing native phase must include actual PNG bytes; inspect recovered images
before a visual claim. Codec unit PNGs, a file reference, truncated tool text or
unreadable logs never establish native acceptance. Failure or an exceeded retention
bound remains visible and incomplete. The proven reader route is not a promise that
all future large logs will fit: complete real evidence recovery is an execution gate.
