# Verifiable continuation evidence

`just handoff-check --manifest <private-handoff.json> --json` performs read-only
resource checks and, when requested by the manifest, fresh selected-PR readback.
It neither admits execution nor migrates, repairs, cleans up or recovers state.
`--expected-revision <40-character-sha>` additionally binds the consumer's source.
Nonzero exit means evidence reuse is incomplete. This is optional continuation
feedback, not a new required status or native acceptance lane.

The companion format is `format_version: 1`, extending the shared
`scripts/development-evidence.mts` file identities. It records `revision`,
`captured_at`, `library: { id, resource_id }`, `resources`, `completed`,
`outstanding` and `resume_condition`. `pull_request: { repository, number, head }`
is optional and must match the source revision. The checker validates the selected
PR identity/head and reports live draft/open/closed/merged state; incomplete or
unavailable API responses remain unknown. No inventory of unrelated PRs is implied.

Each resource has a unique `id`, `role`, absolute local `path`, `required` flag,
`snapshot_at` and `kind`. Roles are package, profile, library, runtime, original,
evidence, inventory and native-custody. A file adds `bytes` and `sha256`. A directory
adds `scope: "selected-files"` and `files: [{ relative_path, bytes, sha256 }]`.
Directory checks verify only declared files, not whole-tree preservation or closure;
include the full fresh inventory when that claim is required. Relative paths cannot
escape the directory. Snapshot timestamps distinguish mutable pre/post-game state;
recapture explicitly rather than editing historical hashes to erase a difference.

Completed observations have `name`, `method` (automated or operator) and nonempty
`evidence_ids` referencing resources. A required resource failure, changed source
or unknown/changed selected PR blocks reuse. An optional missing resource blocks
observations that reference it. Native custody is a referenced receipt owned by
the existing native contract; resource existence does not establish process exit.
Library identity is an explicitly captured value, not discovered or migrated here.

Inspection is bounded to a 1-MiB manifest,128 resources,10,000 declared files and
1 GiB of declared snapshot bytes. JSON stdout is at most16 KiB including its
newline. A compact result preserves the verdict and status totals, marks omitted
details and points to the manifest's full input references. Resource states are
verified, missing, changed or unavailable. Legacy manifests require explicit
recapture; there is no optimistic migration.

Keep manifests, private paths and original inputs local. Publish only a suitable
bounded outcome summary. Preserve immutable dated checkpoints; maintain one
current summary with exact selected source/package/library identities, live PR
readback, separately classified observations, gaps and resume conditions. Before
replacement, archive the previous summary verbatim with its SHA-256 and verify
all referenced evidence. New summaries supersede historical status, never delete
history or retroactively manufacture acceptance.
