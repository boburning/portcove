# One-off Windows onboarding observation for #2404

This is a disposable controller, separate from the product delivery branch. It
has no schedule or dispatch input and runs only on a push to
`test/onboarding-native-2404` in the public `boburning/portcove`
repository. It uses one standard `windows-2022` job, read-only repository
permission, no persisted checkout credentials, no Actions cache or artifact
storage, and no new secret or service. A rerun attempt is refused; retain a
failure and review any new run as a separate decision.

## Freeze and review before publication

Replace `__FINAL_CANDIDATE_SHA__` in the workflow and `plan.json` with the full
production candidate commit. Replace `__FINAL_BASE_SHA__` in `plan.json` with the
full integrated main commit. These placeholders fail before build or game launch.
Review all three executable/controller inputs (`.github/workflows/`, `scripts/`
and `plan.json`) independently before creating and pushing the disposable branch.
Do not add this workflow to the product branch. The controller commit and product
commit are recorded separately, as are the compiled CLI and game binary hashes.

`plan.json` is the inspectable fixed scenario. It pins the real upstream Sopwith
2.9.0 win64 ZIP and all nine package members. Its SHA-256 becomes
`binding_sha256` in both `binding.json` and `execution.json`. The per-run download
receipt has a fresh identity and is separately inventoried. The compiler command is
`cargo build --release --locked --no-default-features -p portcove-cli --bin portcove`;
no qualification feature or synthetic provider is enabled.

The actual build invokes the source's maintained storage and Rust admission
wrappers. The fixed `plan.json` compiler arguments remain separate from the full
`build_invocation`. The outer Node process is owned and bounded to 2,400 seconds;
the existing Rust guard owns admission and Windows process containment. The child
build environment fixes `CARGO_BUILD_JOBS=2`, disables incremental compilation,
and directs the storage wrapper's target, temporary directory and build output
under the fresh work root. The Rust guard retains its existing runner scratch policy.
Storage policy retains its normal free-space requirement. The exact invocation,
resolved Node executable, environment overrides and budget are retained in
`build-invocation.json`; command results and partial logs retain failures.

The harness checks fresh Core previews before each mutation, including exact
asset/destination, executable/directory/arguments, relink identity, and explicit
external-file preservation on removal. It runs the production CLI for every
product operation. A qualification-owned byte-checked copy supplies the new relink
location; the original files remain intact.

Each `exec` supplies a new request UUID. Native ownership comes from the retained
CLI handle, Core's running launch record, and the unmodified source
`native-session.ps1` / `native-process-tree.ps1` helpers. The game screenshot uses
the observed foreground window rectangle after session, PID, creation time,
executable and window-owner checks, with the same checks after pixel capture.
One ordinary focus request is allowed; a blocked/noninteractive/contended session
fails visibly. There is no keyboard gameplay claim. Ordinary `CloseMainWindow`
must produce positively observed application and supervisor exit and a matching
Core `succeeded` terminal record with exit code zero. Forced owned cleanup, if
necessary, is recorded as failure and never counts as normal exit.

The removal comparison uses a **new inventory after both games exit**, including
both external directories, the isolated profile, and the runner account's actual
Roaming AppData `SDL Sopwith` directory. That last directory must be absent before
launch; the harness only observes it and never creates, changes, or deletes it.
SDL's Windows known-folder lookup is not redirected by setting `APPDATA` in the
child environment. Presence/absence and all entries under these bounded paths are
recorded; this is not a whole-profile claim. Earlier pregame inventories remain in
evidence. The seeded save file is explicitly a preservation witness; it is not
represented as a game-authored save or gameplay evidence.

This bounded storage choice follows Sopwith's pinned upstream
[preference lookup](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/src/sdl/video.c),
[package name](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/configure.ac),
[configuration file](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/src/swconf.c)
and [high-score file](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/src/hiscore.c),
with the official [SDL2 Windows implementation](https://github.com/libsdl-org/SDL/blob/SDL2/src/filesystem/windows/SDL_sysfilesystem.c)
as corroborating implementation context, not a byte-equivalence claim for the
bundled DLL. The pinned [game manual](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/doc/sopwith.6)
documents `-n` as novice single-player startup and `-q` as quiet audio. The exact
bundled game/DLL bytes remain the authority for this observation.

## Hosted commands

The fixed workflow runs these commands from its workspace, with the exact
controller and source already checked out into different directories:

```powershell
./controller/scripts/onboarding-native.ps1 -Mode Prepare -SourceRoot source -ControllerRoot controller -EvidenceRoot hosted-evidence -WorkRoot $env:PORTCOVE_ONCE_WORK
./controller/scripts/onboarding-native.ps1 -Mode Run -SourceRoot source -ControllerRoot controller -EvidenceRoot hosted-evidence -WorkRoot $env:PORTCOVE_ONCE_WORK
node source/scripts/native-backup-evidence.mts emit-hosted hosted-evidence
```

Within the source checkout, the owned build uses this exact wrapper command and
the recorded build environment:

```powershell
node scripts/dev-storage.mts run --scope rust -- node scripts/run-rust-tests.mts --guard-command cargo build --release --locked --no-default-features -p portcove-cli --bin portcove
```

The job always attempts lossless log retention. Startup/tool failures leave an
incomplete nonzero `execution.json`; later failures retain their original step,
raw command result and owned cleanup outcome. Evidence files are never treated as
a pass by their existence. The codec refuses excessive or malformed evidence
rather than silently truncating it. Missing retention leaves native acceptance
unestablished and the failed job log visible.

## Recover and independently inspect

Obtain the complete job log promptly through the existing GitHub log route. Build
an expected binding from the reviewed plan hash, actual source/controller/base,
run ID, attempt `1`, job `native`, and phase `native`. Do not accept expected
identity merely by copying unverified values out of recovered evidence.

```sh
node /path/to/exact/source/scripts/native-backup-evidence.mts recover-hosted \
  /path/to/job.log /path/to/new-evidence-directory /path/to/expected-binding.json
```

The expected JSON has string fields `source`, `controller`, `base`, `run`,
`attempt`, `job`, `phase`, and `binding_sha256`. Check recovered source/input and
binary hashes, every command result, both process/window identities and close/exit
receipts, both Core terminal records, fresh readiness and inventory equality.
Open both PNGs and describe only their actual pixels. Existing VCMI opaque-handoff
evidence remains a separate observation. This controller establishes no Desktop
UI, human gameplay, installer, minimum Windows version, signing, updater, catalog
publication or protected release result.

## Local authoring status

No Windows execution has occurred merely by preparing these files. The maintained
Desktop scenario planner was inspected, but its local `--plan --json` invocation
could not run its Cargo metadata child in this environment (`EPERM`). The existing
full native scenarios target different contracts; this fixed CLI journey reuses
their process/exit helpers and screenshot identity pattern. Local syntax and
source review are reported separately from the eventual hosted observation.
