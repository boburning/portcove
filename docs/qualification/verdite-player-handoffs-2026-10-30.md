# Two Verdite completed-player handoffs — October 30, 2026

This bounded [#2926](https://github.com/boburning/portcove/issues/2926) batch
selects two useful official upstream-prepared Windows players:
[#1900 Verdite2](https://github.com/boburning/portcove/issues/1900), US King's Field,
and [#1901 Verdite3](https://github.com/boburning/portcove/issues/1901), US King's
Field II. Japanese numbering differs: these are King's Field II and III there.
They are distinct games, discs and canonical implementations, not inherited
qualification from another King's Field port. Both are already original 524
members outside #1422's overlapping historical subset. No frozen identity,
Required scope, artwork or strict definition is added or discarded.

The real shared cause is RecompOne-based official apphost, original-disc,
generated-code and per-user-profile ownership. Existing Core native intent,
consent, registration/relink/restart, selected-process Play and metadata-only
preserving removal supply useful routes without a new PS1/.NET/build framework.
Upstream/player retain preparation, runtime replacement and all external data.
Full #2510/#2926 acceptance and every other stronger condition remain open.

## Exact source, grants and publisher observations

The [source packet](verdite-player-handoffs-2026-10-30.json) records 100 distinct
title-bound repository/commit/path/blob bindings and 63 unique content blobs.
Four current/release tree-reference roles describe **two distinct complete
trees**, not four independent trees. Current and latest tags match for each
project. Decoded source bytes, raw API responses and complete nontruncated tree
entry totals were independently rechecked against their recorded hashes.

| Owner          | Exact selected source and tag                      | Owned original                 |
| -------------- | -------------------------------------------------- | ------------------------------ |
| Verdite2 #1900 | `15c54b244d592f92d85f11f3f20c3d929193f0db`, v0.5.2 | US King's Field, SLUS-00158    |
| Verdite3 #1901 | `ebc307bc42669519af736c6d29cd5d1cba06881a`, v0.2.0 | US King's Field II, SLUS-00255 |

Each project, its vendored RecompOne and verdite-core have pinned MIT source
grants. BIOS/font public-domain notices and Noto Sans SIL OFL1.1 are recorded;
packaging copies project MIT and the Noto notice. Root MIT does not grant original
FromSoftware media rights or blanket permission for every dependency/artifact.
The exact csproj/component observations are retained; no exhaustive package
notice/asset-clean or source-to-binary certification is inferred.

Observed official Windows portable products:

| Product                    | Asset / bytes          | Published SHA-256                                                  |
| -------------------------- | ---------------------- | ------------------------------------------------------------------ |
| Verdite2-0.5.2-win-x64.zip | 678989849 / 48,692,197 | `5dc0b9f30585ec29cd13fe1125586271e6bf8811490bd1cdc22991793ee52298` |
| Verdite3-0.2.0-win-x64.zip | 654652066 / 48,080,389 | `fa2084b0cfa0d4477ba5d1fbbdde0b164c442d2df320780e66a5905ce8b22315` |

Installer EXEs and Linux AppImages are distinct offerings. These are publisher
metadata observations, not downloaded-byte verification or fresh accepted
identity. No release payload, original, installer or helper was acquired or
executed. Source/authoring/intent is separate from game/platform qualification.
Pickup source base is `e293281103644a228eec552f9bf288a5a199dad6`; final source,
base, composition and guarded delivery belong to the owning PR receipt.

## Completed entry and supported upstream preparation

Keep the entire permitted completed portable tree, especially `bin/`, `content/`
and `licenses/`. Finish upstream original-disc onboarding/first-run preparation
outside Portcove. On a cache miss the launcher regenerates/compiles
KingsField2.dll or KingsField3.dll in its own profile, loads it through
AssemblyLoadContext and synchronously invokes the game entry point in the same
long-lived apphost. Registration does not perform that preparation.

Select **bin/Verdite2.exe** or **bin/Verdite3.exe**, with **zero arguments** and
the complete installation root as explicit initial working directory. These are
win-x64 net10.0 self-contained apphosts; retain all adjacent native/runtime
files rather than selecting an isolated DLL or system dotnet host. No separate
system .NET10 installation is implied by the selected entry. The root
VerditeN.exe is a Framework4.8 stub which forwards, waits and returns the child
exit code; it is not falsely described as a short-lived unsupported launcher.
Selecting the actual bin apphost avoids that extra stub requirement.

The apphost finds root `content/` through its parent and intentionally changes
working directory to its selected profile. Zero arguments reuses `settings.json`
CdPath or upstream's original picker. A developer positional disc argument is
validated only after normal WaitForValidDisc and is not needed to bypass
onboarding. No `--rom`, `--config`, profile or build flag is invented.

Originals must be a CUE and all referenced BIN files, or a supported-codec CHD,
for that exact US serial. CHD cdzl/cdlz/cdfl/zlib/lzma are supported; cdzs is not.
DiscCheck inspects SYSTEM.CNF identity, selected files and minimum slice lengths;
it is not a full-disc cryptographic identity or completeness check. Validation
memoization uses path/size/mtime: an unchanged CUE can conceal changed BIN bytes.
The build key hashes selected input files, source/config and launcher assembly
version, not every media byte. Keep the full original set/path for streaming;
the generated assembly does not replace it. Neither Core intent nor this source
packet authenticates arbitrary mastering/region/images or generated code.

## Profile, cards and runtime ownership

Default Windows profiles are `%LOCALAPPDATA%/Verdite2` and
`%LOCALAPPDATA%/Verdite3`. Existing nonempty VERDITE2_DATA/VERDITE3_DATA values
select upstream profiles; relative overrides resolve from the initial directory
before the apphost switches CWD. Core registration binds executable, directory
and arguments, not per-entry environment settings. Do not assume shell-only
variables follow GUI Play, silently redirect a profile or force a new environment
setting merely to register. Preserve an already reproducible creating context.

Keep the whole actual runtime, original and profile, including settings.json
(CdPath, CardAPath, CardBPath), interface.ini, carda.sav/cardb.sav and backup or
damaged companions, mods/ and .cache/.mods-seeded, builds/<key>/KingsField2.dll
or KingsField3.dll, build.log, update.json, icon.png/icon.ico, crashes and optional
dump/diagnostic output. Custom relative card paths resolve under the profile CWD;
absolute card paths can remain elsewhere and also need preservation. Existing
mods can write additional data. Keep every unknown/custom path and each creating
version separately; same path names, standard card representations, private
builds and crash dumps do not establish save-state or cross-build compatibility.
Registration removal never adopts or deletes those external bytes.

Windows upstream code may refresh matching Desktop, Start Menu and pinned-taskbar
shortcut icons to the profile icon.ico. ICON_INSTALL=0/off is its environment
opt-out; these are upstream effects, not Core shortcut/profile ownership. Normal
closing writes settings and runs runtime shutdown. No actual cleanup durability,
profile mutation, save-load, gameplay or physical observation was performed here.

UpdateCheck is **notification/release-browser only**: it reads latest-release
metadata and writes update.json; it downloads/replaces nothing and does not
relaunch the game. This is not a self-updater blocker. Upstream/player still
owns actual runtime replacement; close all real instances before changing the
copy and bind a replacement executable through a fresh Core relink. Core
observes the selected apphost, not an exclusive process family/network sandbox.

### Why existing non-owning integration fits

These packages retain an active owned-disc-to-version-dependent-runtime-code
generator even after preparation. The current catalog contract distinguishes
such setup kits from ordinary immutable native-portable archives and requires
an appropriate existing integration or non-owning handoff. Existing
psx-recomp-managed has a different explicit preparation/runtime/source contract;
its existence does not establish interchangeable RecompOne fitting. There is no
new managed Native definition or bespoke downstream code generator here.

A useful permitted completed-copy route therefore uses existing capabilities
without making launch wait for a speculative console-family implementation,
full-disc digest invention, .NET provisioning or upstream engine repair. Managed
acquisition/setup/Install/Update/Backup/Rollback/migration/external deletion are
unoffered; stronger management remains conditional, not called impossible or
newly deferred. No extra acquisition hold is inferred from absent optional
package/gameplay evidence when no mandatory held condition was discovered.

## Validation and acceptance boundaries

Maintained preparation checks each proposed record with unchanged operational
projection; accepted artwork/lineage are preserved and listings regenerated.
Two actual-ID cases reuse the complete existing owned inert-native-probe
consent/stale-intent/relink/restart/retained-listing/selected-process Play and
preserving metadata-removal contract, with guide presence and no invented
acquisition hold. Final complete-diff review, exact-head hosted results, source
composition/guarded readback and individual canonical dispositions belong to
the delivery PR and consumers. The preceding #4097 candidate's source/evidence
is preserved independently and shared output composition is reviewed before
publication.

Source, metadata and inert Core cases are not actual game, disc verification,
generated DLL/package authenticity, gameplay/save-load/state/mod compatibility,
other-platform, installed-app, human or protected-delivery evidence. Those
observations remain Not run/Not evaluated. No Supported or fleet acceptance
count follows; both already frozen identities retain their historical scope.
