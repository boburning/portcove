# Unified installation, upstream setup and portable updates — October 23, 2026

Owning issue: [#2494](https://github.com/boburning/portcove/issues/2494).
This is a source implementation and bounded evidence record. The owning PR
records independent review, final exact-head hosted checks and merge readback.
It does not authorize client publication or protected definition delivery.

## Player journeys

| Journey                           | Before                                                                                                             | Delivered interaction and remaining manual work                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing richer integration       | Managed setup, source checks, retention, updates and recovery already existed.                                     | Remains the default when eligible. Source/BIOS requirements still precede installation. Install opens its existing review directly when ready.                                                                                                                                                                               |
| Fitting portable runtime          | Catalog acquisition could download a user-owned package; registration did not establish managed updates.           | Install uses the existing managed storage, expected checksum and activation lifecycle. Review explains Portcove ownership. Launch remains explicit. SDL Sopwith needs no commercial game input.                                                                                                                              |
| Upstream first-launch setup       | Upstream/manual setup and a selected external executable were useful, but did not give Portcove runtime ownership. | CorsixTH can use managed installation and updates while its own first launch asks for authorized Theme Hospital data. Those original files stay outside the managed runtime. No duplicate source-preparation screen is added.                                                                                                |
| User-owned download               | A raw asset list and separate destination choice preceded review.                                                  | Details automatically perform read-only release/package discovery. Core recommends a sufficiently established native package and existing user-owned parent together; the player can change either, then review/download. Extraction never executes setup.                                                                   |
| Existing copy or upstream updater | Explicit external registration retained upstream ownership.                                                        | “Use an existing installation · Installation options” remains discoverable. Downloaded setup persists across restart; folder/instructions and executable suggestions lead to reviewed registration. Manual executable selection can point outside the downloaded folder. Removing the reminder/registration preserves files. |
| Portable update                   | No reusable managed portable adapter covered this route.                                                           | Check, notify, explicit update/staging, pins, retention, verification and runtime rollback use the established managed lifecycle. Automatic application remains opt-in.                                                                                                                                                      |

The recommendation removes the ordinary raw-file and mandatory folder decisions;
it does not claim measured time savings. Meaningful channel, release, variant,
location and upstream/existing-installation choices remain accessible. Refresh
retains deliberate release/package choices; a disappeared choice requires another
selection. The concise list always includes the recommendation and selected file.

Core separates bounded recent-release selection from complete selected-release
asset enumeration. A deliberate release can be inspected directly without proving
all repository history. Incomplete asset coverage cannot establish a unique
recommendation. Native processor/platform facts, all managed package hints and
auxiliary-file exclusion precede ranking. Ambiguous packages need a choice.
Recommendation, independent expected identity and execution permission remain
separate decisions.

## Real upstream package transition on Windows x86-64

`cargo run --locked -p portcove-core --example portable_lifecycle -- PORT_ID
BASELINE_RELEASE_JSON NEW_LIBRARY` is a repeatable developer probe. The baseline
JSON supplies older published artifact facts with an independently expected digest;
the next release uses the normal GitHub provider. Both use production Core
download, extraction, installation, staged activation, verification and rollback.
The probe refuses an existing destination and never launches the game.

CorsixTH completed the following real transition, with both version directories
retained and the older version active after the explicit rollback:

| State                                          | Upstream asset                     |      Bytes | Independently published SHA-256                                    |
| ---------------------------------------------- | ---------------------------------- | ---------: | ------------------------------------------------------------------ |
| Baseline and final rollback                    | `CorsixTH-v0.70.0-Windows-x64.zip` | 32,838,074 | `350afc28b29e1d8e79bbb52e65e7c24a9997a251e9b8c62f3f16134156caa01b` |
| Discovered, installed and verified replacement | `CorsixTH-v0.70.1-Windows-x64.zip` | 32,838,355 | `e0e54833c81706f4e3413351869ece9870a4d3c8915809c84e5f80a51895418c` |

The normal provider selected `v0.70.1`; the explicit older baseline was recorded
as `0.70.0`. Retained manifest hashes were respectively
`8b10abb33c2e939871a15bf35b2755c692cafc85827ead04d38937af7875f6b7`
and `1e1cf221ef65e7205d6ff6016ad05dd69b8173b235dabe4aaf627a2129fe2fa3`.
The initial probe hit Windows' default main-thread stack limit; that failure and
its partial library were retained. The successful probe uses the CLI's existing
8 MiB worker-thread convention, rather than reusing the failed destination.

Host receipts, upstream metadata, failed logs and both libraries are retained under
`E:/Codex-Evidence/unified-installation-20261023/`; `real-transition-result.json`
and `real-transition-2.log` contain the successful production observations.
These are real acquisition/extraction/update observations. They do not establish
native setup, game launch, gameplay, installed-app acceptance or save compatibility.
No copyrighted original game data was used. macOS/Linux packages were not run.

The current Windows CLI also acquired the real SDL Sopwith 2.9.0 win64 ZIP
(release `268043256`, asset `325276947`, 1,142,869 bytes, independently expected
SHA-256 `b664b5fac5feac3f3a23b7082909d9280a95ae40cc7f8daeff089b191bcc746c`).
Production setup extraction found one valid native executable among ten entries.
The observation prompted use of existing reviewed executable hints when the title
and executable differ; the native format check and explicit launch remain required.
Explicit reviewed registration/relink with the literal `--version` argument then
launched through Core and printed `SDL Sopwith 2.9.0` with exit zero. The first
attempt supplied an additional caller argument to a fixed-launch registration and
was refused before execution; that failed activity is retained. Removing the
registration preserved all ten external files, verified against their prior
hashes. Setup pending was empty afterward; a stale forget request was refused.
This is a native version-process observation, not a
gameplay or setup-window observation. The `real-sopwith-*` receipts retain this run.

A separate normal managed installation of the same Sopwith package also completed.
Core launched its literal `--version` argument and reported `SDL Sopwith 2.9.0`
with exit zero; full managed verification checked nine package files successfully.
`real-sopwith-managed-install-2.json` and `real-sopwith-managed-verify.json`
retain those observations. This establishes managed acquisition and a native
version process, without establishing gameplay or an interactive setup window.

CorsixTH normally keeps configuration and saves in `%APPDATA%/CorsixTH`, outside
Portcove's managed data and backups. Its exact-tag
[configuration implementation](https://github.com/CorsixTH/CorsixTH/blob/v0.70.1/CorsixTH/Lua/config_finder.lua)
also makes its update notification distinct from replacing the runtime. The
catalog describes those external-data limits. SDL Sopwith's exact-tag
[configuration](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/src/swconf.c)
and [high-score implementation](https://github.com/fragglet/sdl-sopwith/blob/sdl-sopwith-2.9.0/src/hiscore.c)
use upstream preference storage, with declared in-folder fallback data preserved.

## Deterministic and rendered verification

Compact local HTTP/ZIP fixtures exercise the shared production install/update
path with synthetic executable headers. Declared original data, saves, settings
and mods reach the activated replacement, including before its first launch.
Same-tag changed digests produce a distinct artifact. Staging, activation and
runtime rollback retain their existing policy semantics. Renaming/changing the
retained persistence contract is refused until a supported migration exists.

Changed package files and undeclared additions refuse portable update, switching
and removal, preserving the current files. A failure before activation leaves
the prior active installation. Fault injection after committed activation reports
the new authoritative version; recovery preserves that state rather than claiming
an automatic rollback. Unknown data is not silently adopted as package content.
Runtime rollback carries declared current data; it does not restore older saves.

Portable refusals present concrete recovery instructions before technical details:
back up and restore changed package files or move unknown additions, or keep using
the current version when a data contract needs a supported migration. Typed causes
preserve the original mutation state, including a refusal after staging has already
published a retained replacement. Adding executable hints for another platform
does not invalidate the current platform's compatible transition.

The first hosted run caught an unlaunched deeper-integration backup regression.
Collection before first launch now requires a verified retained portable contract;
the previous unlaunched behavior of other adapters remains intact. A fixture also
checks portable collection when the current catalog no longer contains its entry.

Two local Windows portable lifecycle fixtures reached the 30-second harness limit
at 30.042 and 30.085 seconds while another completed at 28.979 seconds. The original
logs remain retained. Only Windows portable lifecycle fixtures receive a finite 90-second budget;
assertions, two workers, zero retries, product deadlines and cleanup remain intact.
This is harness calibration, not a claim that a product defect was repaired by time.

A later focused run passed nine cases but one initial localhost download failed.
Its fixture accepted a socket from a nonblocking listener without explicitly
restoring blocking I/O, then ignored request-read errors before replying. The
fixture now uses bounded blocking I/O, consumes complete headers within five
seconds and 8 KiB, and reports read/write failures. Product networking is unchanged.
The follow-up focused run passed all ten selected Core cases; its longest portable
case completed at 32.742 seconds under the calibrated budget. Both focused CLI
repairs passed, and all 35 rendered failure-detail tests passed. The PR retains
the final source identity and required hosted results separately.

Focused Core tests cover package/release selection, native executable discovery,
handoff integrity and portable lifecycle failures. Browser tests render the
production listing/details, download review, pending setup, registration and
managed installation controls using mocked transport. They cover ambiguity,
partial coverage, stale game/library results, deliberate choices, progress,
errors, existing alternatives, native suggestions and manual outside-folder
selection. Long package names were inspected at 1280px and 360px; keyboard
Escape restores review-button focus. Captures are retained in
`work/installation-rendered/`. These are Chromium fixtures, not native app captures.

The required hosted baseline additionally covers the existing deeper integrations,
source preparation, retained contracts, persistence and recovery. Focused fixtures
do not replace that baseline or port-specific native/gameplay qualification.

## Authoring and ownership limits

The two examples add only authored catalog facts, not per-game code. Another
fitting project needs its existing listing identity, official GitHub repository,
supported native platform/channel, discriminating archive hints, executable hints,
compatible relative persistence paths (possibly empty), and honest setup/data
presentation. See [the authoring contract](../CATALOG.md#managed-native-portable-packages).
Expected artifact identity is obtained through existing provider/checksum rules.
Ordinary compatible releases require no application code or new gameplay campaign.

This adapter supports official ZIP/tar.gz/tgz runtimes with immutable package
content and compatible declared persistence. Installers, self-replacing launchers,
version-dependent generated data needing unsupported regeneration and incompatible
data-coordinate changes need an existing richer integration or non-owning route.
An external registration remains external when a managed integration is added.
Unsupported application bundles/architectures get a handoff rather than a false
native launch claim. No ownership migration, shell interpretation, credentials,
catalog authority or release permissions are added.
