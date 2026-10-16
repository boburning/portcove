# Optional Windows Docker browser tooling

[#2006](https://github.com/boburning/portcove/issues/2006) owns this optional
browser-only adapter. Native Windows development remains the primary route.
The separate Linux builder is [#2007](https://github.com/boburning/portcove/issues/2007).

## Commands

Use the installed Docker Desktop WSL 2 Linux x86-64 engine and the repository's
Node pin. The adapter does not install/start Docker, enable features, relocate
data, alter global resources or use the T480. Start an already configured
Desktop engine explicitly before requesting container execution.
Use the normal frozen workspace installation before `run`; `doctor` and help
need only the repository-selected Node and existing host capabilities.

```powershell
just container-doctor
just container-browser --commit <full-40-character-commit>
just container-browser --commit <commit> --mode exact --files src/browser/controlled-react-act.browser.test.tsx
just container-browser --commit <commit> --mode probe
just container-export --run <run-UUID>
just container-clean
just container-clean --older-than-hours 72 --apply
```

Without Just, use `node scripts/container-browser.mjs doctor`, `run`, `export`
or `clean` with the same arguments. No global Vite+ or Corepack is required
by this host route. The deliberately failing `probe` command returns nonzero.
`exact` uses the maintained literal-file selector; the default `suite` runs
the canonical browser and forced-colors projects freshly.

`--commit` is mandatory and names a full committed SHA available locally.
Unpushed commits work without publication. Dirty current work is refused
unless the caller explicitly supplies `--exclude-dirty`; excluded paths are
disclosed and remain untested. Nothing commits, stashes, resets, pushes or
switches the source checkout. A private Git bundle carries the selected commit
and tree into Linux storage; Windows dependencies and browser binaries stay out.

## Read-only admission and preparation

The doctor verifies the local `desktop-linux` named-pipe context, actual Desktop
engine/WSL 2 kernel/architecture, Windows storage and Linux data-filesystem
capacity. The running backend's resolved settings identify its WSL data folder.
Desktop state and a fresh engine timestamp are required: Resource Saver can
leave the API serving cached info after its Linux engine stops. Exit that mode
explicitly in Desktop; starting an already-running UI may not resume it. The
doctor does not wake the engine or launch a WSL distribution while it is stopped.
The VHD's physical Windows path, including junction targets, is checked with
the existing machine storage policy. An unknown/stale settings record fails
closed with instructions to refresh Desktop Settings. A Linux pathname never
substitutes for this Windows backing-volume check.

Network probes establish HTTPS reachability of GHCR, npm, Node, Playwright and
Debian services. GHCR's unauthenticated 401 and the CDN root's invalid-request
400 are expected service responses, not successful binary downloads. Preparation
separately proves access to the actual selected payloads. Recovery export needs
no network downloads.

The browser Dockerfile pins the official Vite+ image by exact tag and Linux
index digest, with Linux x86-64 explicitly selected and verified. The tag must
match the selected source catalog. The complete
committed source, including manifests, lockfile, patches and lifecycle scripts,
participates in preparation. Git rejects tracked or
untracked source changes after preparation and immediately before fresh tests.
Ignored generated dependencies, caches and output remain separate. Frozen
installation and the maintained provider compatibility check precede
Playwright's own system-library installer and
canonical Chromium headless-shell bootstrap. No Rust or packaging toolchain is
added. The upstream image's sudo facility is removed before task execution.

Prepared images are specific to the source commit/tree, base, architecture,
recipe/entry bytes and workspace owner. Reusing one avoids preparation; every
requested test command executes again. Neither an image cache hit nor a task
replay supplies acceptance. Image ID, actual tool versions, installed npm/system
packages and observed Chromium version accompany results. Mutable Debian package
repositories mean a rebuilt image need not be byte-identical; no offline or
reproducible-build claim is made.

## Runtime, evidence and budgets

Tasks run as UID/GID 1000 with no host mounts, socket, publication/signing
credentials, added capabilities, privileged mode or host networking. Client
proxy defaults are explicitly cleared. Actual container configuration is read
back before start. The runtime has a private network namespace, four CPUs,
6 GiB memory without extra swap, 1 GiB shared memory and 1024 PIDs. Trusted
development tasks remain trusted code; this is not an arbitrary-code sandbox.

Preparation and task execution each have a finite 30-minute budget. A caller
may lower execution with `--timeout-ms` (100 through 1800000). Interrupt/timeout
handling stops only the verified owned container, attempts export and retains
causal status separately from the container exit. Abrupt host loss can leave
an inspectable labelled resource for later export.

Source bundles are capped at 256 MiB, captured command output at 16 MiB per host
command, task logs at 100 MiB and exported task evidence at 1 GiB. Owned staging
and published evidence each have a 10 GiB admission budget. Images have a
10 GiB individual/40 GiB aggregate budget, with an additional conservative
80 GiB global-image admission limit to account for shared base downloads.
Global build-cache observation reserves
headroom within a 40 GiB admission budget. These disk limits are admission and
post-operation refusal controls, not filesystem quotas or limits on other users.
The existing minimum-free-space floor also applies to physical Windows and Linux
storage. Exceeding a budget preserves resources and blocks further preparation;
it never triggers machine-wide pruning.

Staging and recovery state live under `work/container-browser/<run-UUID>`.
Verified exports go to the existing retained-evidence location, under
`container-browser/<run-UUID>`, outside checkout cleanup roots. Logs, traces,
screenshots, commands, source/environment identities and hashed publication
inventory remain available on failure. An interrupted export preserves the
container and partial copies; `container-export --run` attempts a separate
no-clobber publication. A later passing run has a new UUID and cannot replace
an earlier failure.

Cleanup defaults to an inspectable dry run. `--apply` may remove only this
workspace's stopped, successful, fully exported resources older than 72 hours
by default. `--older-than-hours` explicitly selects another finite age (0..8760).
Images require a matching successful, verified export selected by that cleanup;
orphaned or failed preparation images remain protected for manual inspection.
Published bytes are reverified before removing recovery resources. Active runs,
failures, unknown ownership and images still referenced by retained/unrelated
containers remain protected. Published evidence and global builder caches are
never automatically evicted. The evidence admission limit stops new runs rather
than deleting retained failures.

## Maintenance and execution evidence

Renovate's Dockerfile extractor maintains the base pin in the existing `vite-plus`
group. A tag-only or incompatible source/image bump fails admission. Coordinate
catalog, lock, image and browser-provider validation through the existing upgrade
route. Digest discovery is distinct from actual Windows execution.

Windows cold/warm, deliberate failure, interruption/export recovery, cleanup and
native-with-Docker-stopped results are recorded on #2006 when demonstrated.
Unit fixtures and an image build alone do not close that acceptance.
