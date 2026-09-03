# Development storage

On Windows, Portcove development should run from a workspace on a non-system volume. Keeping the checkout there gives Cargo, Tauri, frontend builds, tests, mutation analysis, packaging, and generated data one physical home instead of accumulating independent trees on the Windows system drive.

## Bootstrap and preflight

Clone or copy the repository to a deliberately selected development path on the spacious volume, such as `E:\Portcove-Development`. Do not copy an old `target`, `node_modules`, `dist`, or `src-tauri/gen` directory; they are reconstructed from `Cargo.lock` and `apps/desktop/pnpm-lock.yaml`. Preserve ignored source inputs, qualification evidence, and final outputs unless each item has separately been proved disposable.

From the new workspace, inspect the resolved layout before a heavy command:

```powershell
node scripts/dev-storage.mjs preflight
node scripts/dev-storage.mjs run -- pnpm --dir apps/desktop install --frozen-lockfile
just check
```

The read-only preflight resolves the workspace and Cargo target through `cargo metadata`, follows existing symlinks and junctions (including ancestors of directories not yet created), and prints the physical storage paths. It stops on Windows if the workspace, Cargo target, project temporary directory, packaging output, pnpm store, frontend dependencies/output, or Tauri generated directory resolves to the system drive. It also stops when any relevant filesystem has less than 20 GiB free. `PORTCOVE_MIN_FREE_GIB` or `--minimum-free-gib` can raise that margin for release or mutation work; lowering it should be an explicit, temporary decision based on a measured build. `preflight --json` returns the same checked layout for scripts.

The default layout is entirely relative to the checkout:

| Purpose | Path |
|---|---|
| Cargo, rust-analyzer, Tauri, tests, and mutation builds | `target` |
| Process temporary data and test scratch space | `work/temp` |
| pnpm content-addressed store | `work/pnpm-store` |
| Local installers, executables, source archives, and checksums | `outputs` |
| Frontend dependencies and production output | `apps/desktop/node_modules`, `apps/desktop/dist` |
| Tauri generated schemas | `apps/desktop/src-tauri/gen` |

The launcher creates the temporary, packaging, and pnpm directories after a successful check. It exports `CARGO_TARGET_DIR`, `TEMP`, `TMP`, `TMPDIR`, `pnpm_config_store_dir` (pnpm 11), and the Portcove path variables to its child process. Every `just` quality recipe runs through this launcher, so `just check` and `just audit` also work directly in a fresh checkout.

`PORTCOVE_TEMP_DIR`, `PORTCOVE_OUTPUT_DIR`, and `PORTCOVE_PNPM_STORE_DIR` override their defaults; relative values are resolved from the repository root. Cargo owns target selection through its configuration or `CARGO_TARGET_DIR`. `apps/desktop/pnpm-workspace.yaml` supplies the default store for direct pnpm commands; the launcher applies its checked override to pnpm itself. The PowerShell packaging/release scripts use the same checked layout and restore the caller's environment afterward. Local packaging requires its output below the workspace and excludes configured build/scratch/store/output directories from the source ZIP. Installer qualification uses a private run directory below project temporary storage and retains failed-run evidence; an explicit `-TestBase` selects a different qualification root.

Run rust-analyzer from the non-system-volume workspace so its Cargo metadata resolves the same `target` directory. Do not create validation-mode-specific target directories unless a tool proves that isolation is required. These controls cover repository build and scratch data; they do not relocate installed tools, Cargo's global registry, or other user-level caches. Native executables receive their arguments directly. Windows batch shims support spaced arguments but reject shell expansion/control characters rather than interpreting them.

Use the explicit cleanup command when the shared Cargo tree is no longer needed:

```powershell
node scripts/dev-storage.mjs clean
```

The command prints the exact deletion target, accepts only this workspace's ordinary `target` directory (or an absent target), and refuses symlinks/junctions anywhere in its ancestor chain. It rejects custom targets, including other directories inside the checkout, and delegates deletion to `cargo clean --target-dir <checked-target>`. Cleanup remains available when free space is low or the old checkout is on the system drive. Stop build/editor processes using that target before invoking it; the command does not stop them for you.

## Migration and recovery

Before replacing an existing workspace, record `git status --short --branch --untracked-files=all`, `git rev-parse HEAD`, branches, remotes, worktrees, submodules, and rebase state. Stop or wait for Cargo, rust-analyzer, Tauri, Node, test, mutation, and packaging processes using that workspace. Copy first, excluding only verified rebuildable directories, then compare relative file paths and sizes and run Git integrity checks in both locations. Keep the old checkout as rollback until the new checkout passes representative Rust and UI checks.

After verification, remove the old Cargo target with the cleanup command from the old workspace. Do not delete ignored `work` content, imported media, source images, credentials, or `outputs` merely because Git does not track them. If an active editor prevents replacement of the old workspace, leave its small source checkout as a temporary rollback copy; open the new workspace after restarting the editor and remove the rollback only after another Git/status/preflight check.

From WSL, the same E: workspace must resolve below `/mnt/e`. For example:

```bash
cd /mnt/e/Portcove-Development
cargo metadata --format-version 1 --no-deps | jq -r .target_directory
node scripts/dev-storage.mjs preflight
```

If the new checkout fails, stop new builds, preserve its logs and outputs, and return to the untouched old source checkout. Do not restore an old `target`; recreate dependencies and build output from the lockfiles after correcting the storage path.
