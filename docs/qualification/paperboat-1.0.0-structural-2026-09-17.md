# PaperBoat 1.0.0 structural qualification — 2026-09-17

This record captures source, release, package, executable, setup and persistence
evidence for admitting Harbour Masters' PaperBoat as catalog ID `paperboat`. It
does not manufacture ROM, gameplay, physical-device or cross-version evidence.

## Scope

| Identity               | Value                                                    |
| ---------------------- | -------------------------------------------------------- |
| Portcove base          | `45e884c5a05fc5583abf14ca6fb99436ca5ca8c0`               |
| Canonical issue        | [#909](https://github.com/boburning/portcove/issues/909) |
| Upstream               | `HarbourMasters/PaperBoat`                               |
| Release                | tag `1.0.0`, `Mulberry Alfa 1.0.0`                       |
| Tag commit             | `5489baad1c08bc134ed894b96cf66c3da615deed`               |
| Declared platforms     | `windows-x86-64`, `linux-x86-64`                         |
| Source profile         | `paperboat-paper-mario-us`                               |
| Exact source SHA-1     | `3837f44cda784b466c9a2d99df70d77c322b97a0`               |
| Isolated evidence root | `E:\Portcove-Validation\paperboat-20260917-1415`         |

The annotated `1.0.0` tag resolves to the commit above. Its `config.yml` names
only that North American source identity and `pm64.o2r` output. Portcove's
existing N64 normalizer admits `.z64`, `.n64` and `.v64` containers only when
their canonical big-endian bytes match the exact identity; PaperBoat itself
hashes raw selected bytes, so Portcove performs normalization before the
upstream tool sees the private source.

## Complete release inventory and integrity

GitHub reported one non-draft, non-prerelease release and three runtime assets:

| Asset                               |       Size | GitHub SHA-256                                                     | Result                  |
| ----------------------------------- | ---------: | ------------------------------------------------------------------ | ----------------------- |
| `Paperboat-Mulberry-Alfa-Win64.zip` | 24,193,220 | `705b413a3657fa4e2e5fb50e65cf3c1860946955cf385a89547435f2aa714b86` | Declared Windows x86-64 |
| `Paperboat-Mulberry-Alfa-Linux.zip` | 17,289,088 | `0621a8bfc028c647f4e83b8975c9f4eeb393bc7a2c1cab5fd8161eac5d906bac` | Declared Linux x86-64   |
| `Paperboat-Mulberry-Alfa-Mac.zip`   |  8,851,503 | `31658b61135394305eb05015f9c163dafa1074d243bdafc6843936c9ceed0ae0` | Not declared            |

Independent local downloads matched all three GitHub-published digests. Archive
paths were checked for traversal and absolute names before isolated extraction.
The Windows package expands to 243 files and contains `Paperboat.exe`, bundled
`paperboat.o2r`, `assets`, `config.yml`, controller mappings and debug symbols.
The PE executable reports AMD64 machine `0x8664`. The Linux ZIP contains a
nested executable `Paperboat.AppImage`; its outer and inner ELF headers report
x86-64 machine `0x003e`. The AppImage contains the same engine archive, recipe
and assets beside `usr/bin/Paperboat`.

The macOS ZIP contains a DMG, whose application executable is ARM64-only Mach-O
(`cpu 0x0100000c`). Portcove's game installer does not have a reviewed nested
ZIP-to-DMG-to-app materializer, and no Intel artifact exists. The catalog
therefore makes no macOS claim. Windows extraction of the AppImage and DMG for
inspection could not recreate Unix symbolic links without the required Windows
privilege; header, layout and archive-mode inspection remained available, but
this was not a Linux or macOS installation test.

## Release selection and successor behavior

The catalog uses stable, version-independent `win64` and `linux` asset hints.
The complete 1.0.0 inventory selects one runtime per declared platform and does
not select the Mac package. Controlled N/N+1 provider fixtures keep the same
definition, select the later ordinary release and retain its independent digest.
The provider's existing ambiguity, absent-digest and conflicting-platform tests
continue to fail closed.

## Preparation, launch and ownership

PaperBoat bundles immutable `paperboat.o2r` engine data but generates
source-derived `pm64.o2r`. Portcove installs the verified release first, copies
it to an operation-private tree, normalizes the registered source to
`paper-mario.us.z64`, and invokes only the installed executable. On Linux the
setup process receives `SHIP_HOME` pointing at that private tree; the Windows
portable build uses its working directory. The upstream graphical setup remains
visible. After extraction the user chooses **No** at “Run PaperBoat?” so the
setup process exits without bypassing Portcove supervision.

Portcove then requires `pm64.o2r`, admits it and optional `torch.hash.yml` only
inside the generated-output contract, rebuilds the immutable manifest, binds a
receipt to source, definition, artifact, tool and host identities, and atomically
activates the prepared derivative. A missing marker, changed source, changed
setup executable, output outside the reviewed paths, or changed candidate fails
without replacing the active installation.

`pm64.o2r` is version-owned rather than player-owned, so an update or rollback
cannot silently reuse generated data across incompatible releases. PaperBoat's
tagged save manager cancels the engine's original save events and reads, writes
and erases `saves/file{slot}.json`; the player-data contract therefore owns the
complete `saves` directory alongside `mods`, `default.sav`,
`paperboat.cfg.json`, `imgui.ini` and `cvars.cfg`. Runtime `logs` are disposable
and excluded from backup ownership. Normal launch points `SHIP_HOME` at
canonical Portcove user data, including on Linux; Windows remains portable in
the supervised working directory and uses the same synchronization contract.

## Bounded runtime observations

The exact Windows executable was started twice in isolated empty `SHIP_HOME`
directories with `--help` and `--version`. Neither option produced standard
output or exited within four seconds. Each exact owned PID was then stopped and
no child was left running. This proves only that the release has no bounded
help/version CLI. It is not a crash, launch, extraction or gameplay result.

Source review at the tagged commit confirmed that the executable:

- searches for a valid generated archive before entering gameplay;
- validates a source against `config.yml` before extraction;
- writes `pm64.o2r` through the pinned Torch dependency;
- stores saves, configuration, ImGui state and console variables through the
  Libultraship application-directory contract; and
- writes the normal log and Windows crash dump under `logs`.

## Result and explicit limits

The first complete selected local run was stopped after two catalog regressions
correctly detected that the initial candidate had broadened the pre-existing
Paper Mario ReCut compatibility profile and had not advanced the catalog port
count. PaperBoat now owns the distinct `paperboat-paper-mario-us` profile; the
ReCut profile and its schema-1 projection remain unchanged. The affected tests
and the final complete local result are recorded on the implementing pull
request rather than treating the failed run as passing evidence.

Structural admission passes for the exact source contract and release inventory
above, subject to the repository tests and hosted exact-head checks recorded on
the implementing pull request. No proprietary source bytes entered Git.

The following are explicitly Unknown or not run:

- source-backed `pm64.o2r` generation, because no lawful source was available in
  this workstream;
- first gameplay launch, controls, audio, rendering, save/load and mod behavior;
- update, rollback, removal/reinstall, backup/restore and interrupted preparation
  using an actual PaperBoat source;
- native Linux, Steam Deck, macOS and physical-device behavior;
- macOS package installation, Intel compatibility, signing and notarization;
- a future real upstream release beyond controlled N/N+1 fixtures; and
- production definition-feed publication or older-client compatibility. The
  new preparation capability requires a Portcove application update and does
  not authorize catalog signing or publication.
