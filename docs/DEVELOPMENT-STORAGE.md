# Development storage

Portcove development can use any writable contributor-owned volume with sufficient
free space, including the Windows system drive. Repository defaults check physical
paths, capacity and cleanup containment; a drive letter alone is not a failure.
The primary maintainer retains a stricter non-system-drive machine policy.

Start with [what preflight checks](#what-preflight-checks), then read
[when it stops](#when-it-stops) before [changing an override intentionally](#how-to-override-intentionally).
For reclamation, use [checked cleanup](#clean-up-verified-disposable-content);
[retained verification evidence](#retained-verification-evidence) has a separate
custody and cleanup decision.

Prefer a non-system **SSD** for active development. Free capacity alone does not
make an HDD suitable for the many small reads and writes in dependency loading,
SQLite fixtures and linking. Moving only Cargo output or temporary files leaves
frontend dependencies and relative-path tests on the checkout's volume. Storage
contention can time out test workers before assertions begin; investigate worker
startup and disk queues separately from slow test bodies.

For ordinary tasks, first follow the [warm single-session workflow](DEVELOPMENT-TOOLS.md#warm-single-session-workflow).
Reuse the verified owned checkout and its healthy dependencies; the examples below
are conditional new-workspace setup, not a per-task startup checklist.

An additional Git worktree provides an SSD development path without replacing a
dirty checkout when actual isolation is needed. On the primary Windows development host, keep the canonical
checkout at `E:\Portcove-Development` and additional worktrees below
`E:\Portcove-Worktrees` (or the configured `E:\Codex-Worktrees` root for
Codex-managed worktrees). Inspect existing worktrees and the proposed
destination first, then choose an unused path and branch name:

```powershell
git worktree list
git fetch origin
git worktree add -b feature/my-change E:\Portcove-Worktrees\my-change origin/main
Set-Location E:\Portcove-Worktrees\my-change
node scripts/dev-storage.mts preflight
just doctor
just local-check --plan
```

Provision only prerequisites reported missing or mismatched by the doctor. A new
frontend workspace normally needs the pinned frozen install described below; a
healthy existing workspace does not. Then use the task's focused validation;
`just check` is not an automatic startup or branch-transition step.

The defaults below keep the entire new workspace on that SSD. Check for inherited
`CARGO_TARGET_DIR`, `PORTCOVE_TEMP_DIR`, `PORTCOVE_PNPM_STORE_DIR` and
`PORTCOVE_OUTPUT_DIR` overrides in preflight; they may point back to an HDD or
another worktree. Use session-scoped overrides for deliberately shared caches,
and avoid simultaneous builds against the same Cargo target. Do not edit system
environment variables, move existing worktrees, or delete old artifacts simply
to prepare an isolated validation checkout. A clean SSD run diagnoses a storage
problem; it does not erase evidence from a failed HDD run.

## Retained verification evidence

Windows/Linux native verification retains declared tooling inputs in a dedicated
evidence store, separate from disposable build caches and outputs. Configure an
absolute `PORTCOVE_RETAINED_EVIDENCE_DIR` when needed. Windows defaults to
`Portcove-Retained-Evidence` on the configured output volume; Linux defaults to
`~/.local/share/portcove-retained-evidence`. No automatic eviction or garbage
collection is performed. Existing unknown directories are not adopted or cleaned.

New stores use private ownership/permissions, a retained-evidence marker, private
staging and verified no-clobber publication. Disposable cache ancestry is refused,
including malformed cache tags. Capacity is observed before copying; failures
preserve relevant partial bytes and observations. Only declared non-secret
tooling/source inputs belong here; authentication material and game collections
are not store inputs. No redacted copy is represented as original input bytes.

The existing Cargo cleanup routes cannot target this external store. Reclamation
requires an explicit reference-aware cleanup decision, preserving failed evidence.
See [retained input custody](adr/0001-retained-input-custody.md).

## Bootstrap and preflight

Run `node scripts/dev-storage.mts --help` for the supported actions, options and
examples. Help is also available after each action and exits without Cargo,
storage checks, directory creation or cleanup. When wrapping a command with
`run`, put storage options before `--`; every argument after it belongs to the
child command, including the child's own `--help`.

Clone or copy the repository to a deliberately selected development path on the spacious volume, such as `E:\Portcove-Development`. Do not copy an old `target`, `node_modules`, `dist`, or `src-tauri/gen` directory; they are reconstructed from `Cargo.lock` and the root `pnpm-lock.yaml`. Preserve ignored source inputs, qualification evidence, and final outputs unless each item has separately been verified to be disposable.

From the new workspace, inspect the resolved layout and prerequisites before a
heavy command:

```powershell
node scripts/dev-storage.mts preflight
just doctor
```

Only when frontend dependencies are missing or incompatible with the lockfile,
run `node scripts/dev-storage.mts run -- pnpm install --frozen-lockfile` from the repository root.
Browser Mode keeps its explicitly provisioned Chromium shell and companions under
the checkout's ignored `work/browser-cache`; `browser:bootstrap` owns that cache,
and the browser project reports the missing executable when it is absent. Browser
failure traces and screenshots remain in distinct invocation directories under
ignored `work/bt`; Vitest attachments may also remain under ignored
`apps/desktop/.vitest`. Raw provider traces remain after successful runs because
reporter completion does not prove successful browser shutdown. Preserve failed
evidence during diagnosis. Browser trace deletion requires an explicit owned-path
cleanup decision after confirming that the owning process has exited; the Cargo
target cleanup command below does not manage browser traces.
Use the owning task's narrow test command and `just local-check`; exhaustive
validation remains required only for its documented acceptance or investigation.

### What preflight checks

The read-only preflight follows existing symlinks and junctions (including missing
descendants), checks directory access and capacity, and prints the physical paths.
Its default `all` scope resolves the actual Cargo workspace/target through
`cargo metadata` and checks native/package outputs. `--scope frontend` checks
frontend dependencies, output, browser and package caches without Cargo or Tauri
generated paths. `--scope tooling` checks workspace, temporary and output paths;
`--scope rust` resolves actual Cargo outputs, the adjacent Rust support cache,
and Tauri generated paths (Desktop's Rust build script writes schemas) without
frontend dependency/output paths. Unknown commands retain `all`; cleanup always
uses complete Cargo discovery/containment.

The existing local planner selects these scopes from its complete command plan.
Its outer launcher uses tooling scope; selected Rust/mixed work still resolves
Cargo before execution. Plan-only frontend/tooling discovery does not require
Cargo. Receipt identity collection may probe optional tool versions; those probes
do not require the tools or resolve native outputs. Ordinary `cargo build -p
portcove-cli` remains independent of the frontend launcher and Node toolchain.

`preflight --json` returns the checked layout without creating output directories.

### When it stops

Path refusals identify the affected directory and the correction: reconnect an
unavailable volume, choose a readable/writable directory, or move configured
storage to a volume allowed by the machine policy. Cleanup never follows a link
to repair a rejected path. Preserve custom targets, linked contents, source
inputs, recovery material and verification evidence while correcting the layout.

Any selected filesystem with less than 20 GiB free blocks execution.

### How to override intentionally

`PORTCOVE_MIN_FREE_GIB` or `--minimum-free-gib` changes this configurable margin;
use observed requirements rather than treating it as a precise build prediction.
The command-line value takes precedence over the environment value. Both require
a positive finite number; invalid values are reported with the effective input
and a correction instruction.

`PORTCOVE_TEMP_DIR`, `PORTCOVE_OUTPUT_DIR`, and `PORTCOVE_PNPM_STORE_DIR` override their defaults; relative values are resolved from the repository root. Cargo owns target selection through its configuration or `CARGO_TARGET_DIR`. The root `pnpm-workspace.yaml` supplies the default store for direct pnpm commands; the launcher applies its checked override to pnpm itself. The PowerShell packaging/release scripts use the same checked layout and restore the caller's environment afterward. Local packaging requires its output below the workspace and excludes configured build/scratch/store/output directories from the source ZIP. Installer qualification uses a private run directory below project temporary storage and retains failed-run evidence; an explicit `-TestBase` selects a different qualification root.

For a stricter Windows profile, set `PORTCOVE_BLOCK_SYSTEM_DRIVE=1`, or keep this
private machine file at `~/.config/portcove/development-storage.json`:

```json
{ "format": 1, "blockSystemDrive": true }
```

It applies to selected physical paths, including redirected junctions, in every
checkout on that machine. Missing configuration uses portable defaults; malformed
or unreadable configuration blocks execution with its exact path. Environment
value `0` does not relax a strict machine policy. Do not commit machine settings or
change another contributor's policy. The primary maintainer's strict file must be
verified before switching from the historical repository-wide drive prohibition.

### Dependencies and default paths

Before installing dependencies, compare `pnpm --version` with `packageManager`
in the root `package.json`. A host-provided fallback that ignores the project
pin can create a different installation layout and later trigger an unexpected
reinstall. Use the repository's pinned package manager. If a worktree is renamed,
recreate its generated `node_modules` from the lockfile at the final location;
Windows dependency junctions may still contain the old absolute path. Preserve
the old generated directory until the replacement passes validation.

The default layout is entirely relative to the checkout:

| Purpose                                                       | Path                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Cargo, rust-analyzer, Tauri, tests, and mutation builds       | `target`                                                         |
| Validated Rust support executables                            | `target.portcove-rust-support/v1`                                |
| Process temporary data and test scratch space                 | `work/temp`                                                      |
| pnpm content-addressed store                                  | `work/pnpm-store`                                                |
| Local installers, executables, source archives, and checksums | `outputs`                                                        |
| JavaScript dependencies and frontend production output        | `node_modules`, `apps/desktop/node_modules`, `apps/desktop/dist` |
| Tauri generated schemas                                       | `apps/desktop/src-tauri/gen`                                     |

The launcher creates the temporary, packaging, and pnpm directories after a successful check. It exports `CARGO_TARGET_DIR`, `TEMP`, `TMP`, `TMPDIR`, `pnpm_config_store_dir`, and the Portcove path variables to its child process. Every `just` quality recipe runs through this launcher, so `just check` and `just audit` also work directly in a fresh checkout.

Rust support preparation stores its validated executables beside the selected
Cargo target, at `<target>.portcove-rust-support/v1`. It leaves an absent target
absent so the first ordinary Cargo build can create the directory and its
`CACHEDIR.TAG` ownership marker. Each selected target has its own support cache;
source, compiler, environment and artifact validation still govern reuse. Rust
storage admission checks the cache's own physical path and volume too, including
when a custom target is a mount point whose sibling is on a different volume. The
previous nested `target/portcove-rust-support` layout is left untouched and is
not read or migrated. The first preparation after this change rebuilds the small
support executables in the new location.

On a host where the workspace volume is rotational, sustained fixture-heavy
validation can saturate that volume even after cross-worktree Rust admission is
serialized. Set `PORTCOVE_TEMP_DIR` to a unique directory for this worktree on a
policy-permitted SSD before invoking the normal `just` entrypoint. The storage
preflight reports the resolved volume and enforces the same free-space floor.
Do not share one scratch directory between worktrees, and do not treat this
controlled local scratch relocation as packaged, production-feed, or
physical-platform evidence. Keep Cargo targets per worktree unless the entire
isolated validation checkout is deliberately located on that SSD.

Relevant storage changes select the regression suite in ordinary CI's Linux
contract lane with pinned Rust. Full qualification also exercises storage on
Windows and Linux. CI, release, and deep-quality workflows export the workspace
store before pnpm cache discovery, so the cached directory and the install
directory agree even when a setup action runs from the repository root.

Run rust-analyzer from the selected workspace so its Cargo metadata resolves the same `target` directory. That workspace must satisfy the effective machine-local policy as well as portable repository checks. Do not create validation-mode-specific target directories unless a tool proves that isolation is required. These controls cover repository build and scratch data; they do not relocate installed tools, Cargo's global registry, or other user-level caches. Native executables receive their arguments directly. Windows batch shims support spaced arguments but reject shell expansion/control characters rather than interpreting them.

### Clean up verified disposable content

Use the explicit cleanup command when the shared Cargo tree is no longer needed:

```powershell
node scripts/dev-storage.mts clean
```

The command prints the exact deletion target, accepts only this workspace's ordinary `target` directory (or an absent target), and refuses symlinks/junctions anywhere in its ancestor chain. It rejects custom targets, including other directories inside the checkout, and delegates deletion to `cargo clean --target-dir <checked-target>`. Cleanup remains available when free space is low or the old checkout is on the system drive. Stop build/editor processes using that target before invoking it; the command does not stop them for you.

Cargo also checks its target ownership marker. An old target created before
Cargo, including one initialized by the previous support-cache layout, may have
no valid marker and remain ineligible for checked cleanup even after a build.
On refusal, the wrapper preserves Cargo's failure status and performs no
fallback deletion. Preserve the remaining contents for a separate ownership
review; do not add a marker manually or switch cleanup commands to bypass the
refusal. To resume development, use a fresh owned checkout on a volume that
satisfies the unchanged storage policy, and let Cargo initialize its new target.

Checked Cargo cleanup does not remove the adjacent Rust support cache. Its
existing bounded retention keeps at most eight validated identities per product;
the same byte and mode checks apply when a later invocation reuses one. Cleanup
does not adopt or migrate an older nested cache.

Ordinary and exhaustive validation preserve `target/debug/incremental` so a
later Cargo stage or repair can reuse the compiler's prior work. Storage
preflight still rejects work below the configured free-space floor. When actual
storage pressure or cache-corruption evidence justifies destructive cleanup,
run the explicit `just prune-incremental` recipe; it removes only this
workspace's incremental state. The prune is idempotent, remains available below
the free-space margin, and refuses custom targets, files, symlinks, or junctions.
`just clean-build` remains the separate full Cargo cleanup. Supported expensive
Cargo stages use the shared Rust-validation admission guard; queue time is
reported and bounded separately from test execution. The lock is per host, not
per drive, so moving an isolated checkout to the SSD does not authorize an
overlapping compiler/test tree.

## Migration and recovery

Before replacing an existing workspace, record `git status --short --branch --untracked-files=all`, `git rev-parse HEAD`, branches, remotes, worktrees, submodules, and rebase state. Stop or wait for Cargo, rust-analyzer, Tauri, Node, test, mutation, and packaging processes using that workspace. Copy first, excluding only verified rebuildable directories, then compare relative file paths and sizes and run Git integrity checks in both locations. Keep the old checkout as rollback until the new checkout passes representative Rust and UI checks.

After verification, remove the old Cargo target with the cleanup command from the old workspace. Do not delete ignored `work` content, imported media, source images, credentials, or `outputs` merely because Git does not track them. If an active editor prevents replacement of the old workspace, leave its small source checkout as a temporary rollback copy; open the new workspace after restarting the editor and remove the rollback only after another Git/status/preflight check.

From WSL, the same E: workspace must resolve below `/mnt/e`. For example:

```bash
cd /mnt/e/Portcove-Development
cargo metadata --format-version 1 --no-deps | jq -r .target_directory
node scripts/dev-storage.mts preflight
```

If the new checkout fails, stop new builds, preserve its logs and outputs, and return to the untouched old source checkout. Do not restore an old `target`; recreate dependencies and build output from the lockfiles after correcting the storage path.
