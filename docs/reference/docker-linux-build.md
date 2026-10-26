# Optional Windows-driven Linux build container

[#2007](https://github.com/boburning/portcove/issues/2007) owns this optional
Ubuntu 22.04 x86-64 build and unsigned-package route. Native Windows development
remains primary. [The browser adapter](docker-browser-tooling.md) describes shared
Windows Docker Desktop / WSL 2 admission, exact-commit source transfer,
publication/recovery and bounded cleanup. Both thin adapters use
`scripts/container-host.mts`; their images, labels, staging and exports are separate.
The builder does not inherit the browser runtime or install browser binaries.

## Commands

Start the already configured Docker Desktop WSL 2 Linux engine explicitly. This
route never installs Docker, enables Windows features, reboots, changes global
resources or relocates data. The T480 is excluded. Use the repository-selected
Node and a normal frozen workspace installation; global vp/Corepack are optional.

```powershell
just container-build-doctor
just container-build --commit <full-40-character-commit> --mode check
just container-build --commit <commit> --mode package
just container-build-export --run <run-UUID>
just container-build-clean
just container-build-clean --older-than-hours 72 --apply
```

Without Just, use `node scripts/container-build.mts doctor|run|export|clean`
with the same arguments. `check` is the default; packaging requires explicit
`--mode package`. There is no arbitrary shell-command mode. Dirty current work
is refused unless explicitly excluded with `--exclude-dirty`; exclusion is
recorded and never represented as tested. Local unpushed commits work without
pushing, committing dirty work or synchronizing another development tree.

## Preparation and fresh execution

Image preparation explicitly selects the native `desktop-linux` builder, verifies
its endpoint against that validated local context, and loads the result into the
engine. It does not depend on an implicit builder or cache-only export default.

The recipe pins Ubuntu 22.04, the Vite+ tool stage and Rust tool stage by digest.
Rust and Vite+ versions must match the selected source pins. Copied tools must
actually execute against Ubuntu's glibc during preparation. PowerShell's official
Linux archive has a paired version and SHA256; preparation checks it. Renovate
discovers image pins and PowerShell releases. A PowerShell version-only proposal
must update its verified archive hash and requalify canonical packaging; a failed
checksum blocks the proposal. Rust images stay in the existing Rust-toolchain
group; Vite+ images stay in the coordinated Vite+ group. Existing frozen-input,
install-script, release-age and security policies retain their owners.

Preparation installs the complete frozen workspace and fetches locked Linux Cargo
inputs. `install-linux-desktop-prerequisites.sh --include-rpm` owns native libraries;
headless packaging does not request WebDriver or native GUI prerequisites. The
builder selects `--install-timeout-seconds=3600` for cold package unpacking/configuration inside
the finite preparation budget. Existing hosted callers retain their 3/5-minute
installation defaults; package coverage is unchanged. An install deadline failure
stops immediately because a mirror retry cannot repair interrupted dpkg state.
Other mirror failures retain the existing bounded fallback.
The disposable image layer installs Ubuntu's `eatmydata` wrapper under separate
five-minute update/install safeguards. Only the prerequisite helper runs with its
sync-call interposition; a normal filesystem sync follows before the layer can
succeed. A failed/interrupted layer is discarded. No preload setting is persisted
or applied to source preparation, compilation, packaging, smoke tests or runtime.
This targets package-database sync overhead left by the base image's existing
`force-unsafe-io`; completion and any timing improvement require real run evidence.
Installed apt/npm packages and actual Node, pnpm, Vite+, Rust, Cargo and Linux
PowerShell versions are exported. Mutable apt inputs are observed; preparation
is not represented as reproducible or offline.

Every task starts in a new container from its prepared image, with no prior target,
dist or release-assets output. Setup/download reuse does not skip commands.
`check` executes guarded `cargo check --locked --offline --workspace --all-targets`
and the canonical frontend build with `--fresh`. `package` executes the guarded
locked/offline release CLI build, Linux PowerShell `package-cli.ps1` and
`smoke-test-cli-archive.ps1`, then guarded Tauri builds separately for AppImage,
deb and rpm with `--ci --no-sign`. Tauri's configuration disables updater artifacts.
No signing environment or publication command is supplied. Per-format inspection
and byte/hash inventories are separate from build exit codes. A missing/failed
format stays failed; existing files cannot turn it into success. Compile/archive
inspection establishes no installed, GUI, minimum-platform, updater, security,
signing or publication acceptance.

Recovery normally requires the exact terminal BuildKit record. If an incomplete
pre-runtime native build loses that record, recovery may instead establish actual
local daemon replacement **after its preserved terminal failure**. It requires the
original native-driver dispatch log, stopped client custody, a fresh validated
Desktop/WSL engine and unchanged Docker disk, plus ordered installed-Docker init
daemon stop/start events. A changed Desktop session or an existing image alone is
insufficient. Bounded raw lifecycle logs and content hashes are retained with the
run. Existing dead-owner, token and release-journal checks still control release;
the failed run stays incomplete. Recovery never restarts the engine itself.

## Resource and evidence boundaries

The task runs as UID/GID 1000 without sudo, mounts, host home/game libraries,
Docker socket, devices, extra capabilities, host networking or published ports.
All capabilities are dropped and no-new-privileges is required. A private bridge
permits Tauri-owned package-tool downloads; Cargo execution remains offline.
It exposes no service or host credential. This trusted build environment is not
an arbitrary-executable sandbox guarantee.

The builder uses four CPUs, 6 GiB RAM/no extra swap, 1 GiB shared memory and 1024
PIDs, matching browser limits. Preparation is bounded to 120 minutes and the task
to 90 minutes (`--timeout-ms` may tighten it). Browser deadlines stay at 30 minutes.
Builder source-bundle export has a 45-minute safeguard, clipped to the remaining
preparation budget; the browser source-bundle safeguard stays at five minutes.
Both adapters allow two minutes for each read-only daemon storage query, clipped
to remaining preparation time and covered by the existing cancellation signal.
Existing physical Windows volume and Linux free-space admission apply. Source
bundles are capped at 256 MiB, command output at 16 MiB, task logs at 100 MiB and
exported evidence at 1 GiB. Shared admission/retention budgets remain 10 GiB for
staging/exports/individual images, 40 GiB for owned images/build cache and 80 GiB
for global images. These are observed limits, not a Docker writable-layer quota.

Results bind selected commit/tree, driver/shared-host/wrapper hashes, all immutable
bases, built image, actual OS/architecture/tools, command arguments/exits and
artifact bytes/SHA256. Export failure retains owned container/staging evidence
for explicit recovery. Published records are immutable; later success cannot
erase failure. Cleanup is dry-run by default, scoped to this workspace's
`build-v1` ownership and bounded age. It preserves active/failing/unpublished runs
and foreign resources and never prunes machine-wide caches. Browser `browser-v1`
evidence and cleanup remain separate.

## Qualification record

The [October 16 execution record](https://github.com/boburning/portcove/issues/2007#issuecomment-6222586029)
binds actual Windows-host runs to source `78ce12f61d932b8fb22a1894c7d2aa54ce18c13d`
and Ubuntu 22.04 x86-64 image
`sha256:60e25133774e7dedd9dfb52fa9638dfadc94e76dfe0c079774fda093baa6a3ff`.
Guarded checks and fresh frontend execution passed. Actual Linux PowerShell
CLI packaging/smoke and separate AppImage, deb and rpm construction/inspection
passed; the record includes every product's bytes and SHA256. Independent review
verified all published files. These source-bound observations do not qualify a
later source revision or establish installed/native GUI or release acceptance.

That check run prepared the environment in 480,012 ms and executed freshly in
197,440 ms. The subsequent package run reused preparation (0 ms) and executed
freshly in 902,175 ms. The observed image size was 4,916,058,768 bytes; package
publication contained 139,241,434 bytes. Docker's physical backing VHD file on E:
was 43,586,158,592 bytes after packaging, distinct from image size or per-run
physical allocation. Earlier cold preparation failures remain retained. These
measurements promise no speedup, offline preparation or reproducibility.

Timeout, controlled Node signal-handler injection and export-collision recovery
preserved causal interruption and stopped the owned containers. Recovery success
did not turn either failed task into a pass; signal-handler injection does not
claim a physical Windows signal. #2007 owns current implementation acceptance,
native-Windows controls, exact-head checks and delivery status.
