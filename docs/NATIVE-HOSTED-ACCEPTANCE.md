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
