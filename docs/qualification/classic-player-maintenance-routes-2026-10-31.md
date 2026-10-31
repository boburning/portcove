# Classic player maintenance routes — October 31, 2026

This dated source packet covers eight existing owners under #2510/#2926, using
current managed-engine and non-owning selected-player capabilities. All eight
join affected-312 and are outside historical #1422; the full frozen 858 distinct
identities and overlapping historical denominators remain unchanged. These facts
are not a second roadmap, a Supported designation or protected delivery.

## Two managed engines

| Owner                           | Package/player                                                                             | Data and maintenance boundary                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2580 Gunstar Heroes / gunstars | Official Windows x64 ZIP; normal gunstar.exe                                               | Normal in-process own-ROM picker. Core owns its engine and default settings.ini, states, screenshots and videos; original cartridge data and configured external overrides stay player-owned. |
| #2756 Atomic Bomberman — Modern | Official player asset, atomic.exe; server asset and sibling atomic_server.exe are distinct | Code-generated free graphics/sound require no original game. Normal shared SDL profile stays external; the dedicated local free-assets fallback is conservatively preserved by Core.          |

Both existing GitHub contracts use publisher digest evidence and version-independent
asset hints; no permanent per-version pin or new provider framework is added.
The two actual Windows ZIPs matched provider expected size/SHA256. Bounded raw
physical-index checks preceded ZIP parsing and bounded PE-header reads; no member
was extracted and no upstream binary was executed. These observations establish
package shape/header identity, not complete dependency closure or title behavior.

Gunstar's selected native entry uses its pinned Pulseman SDL runtime in the same
process. Its own source requires a 1 MiB USA cartridge and CRC32 B813CF0D; this is
an upstream compatibility check, **not Core cryptographic source authentication**.
Core does not acquire, copy or import the ROM. Windows does not take Pulseman's
macOS Finder-only chdir branch. Default state, settings and capture paths are
relative to the engine working directory; configured alternate paths remain
external and outside Core backup/removal. Preserve every effective root, the ROM
outside the engine, and compatible old runtime/state before changes. Save-format,
rewind, GIF and network claims are upstream claims, not new observations here.

Atomic's selected package contains both client and server executables. The asset
hint selects the player package, and the literal executable hint selects
atomic.exe. Its normal SDL profile for `atomic-bomberman-modern/atomic` holds
options.ini, schemes, anims.lst and imported/generated assets. All copies share
that external profile; Core does not adopt or back it up. Optional original data
and `--import-assets` stay under upstream/player ownership.

If SDL preference lookup fails, free assets can be generated under the creating
runtime's **free-assets** directory. The source writes only its known files and
writes free-assets.txt last; a version change regenerates those known files.
Core conservatively preserves this local directory, including unknown/custom
files during its own maintenance. This does not stop upstream regeneration or
turn that internal marker into a Core preparation/save certificate.

The same failed-profile case **disables ordinary settings persistence** and can
send an editor save to a drive-root `/name.sch`, because the editor receives an
empty user directory. That output is outside the engine and the declared local
free-assets directory. This managed offer assumes a writable normal SDL profile;
stop editor saving and repair the profile upstream if lookup fails, and preserve
any actual external outputs. Core is not a sandbox and does not claim complete
backup, migration or recovery of that fault state. This precise upstream fault
does not create a blanket family/framework prerequisite for the useful healthy
route. OpenGL 3.3 remains an upstream graphics-driver requirement, not an observed
host qualification.

## Six completed-copy guides

| Owner                              | Exact prepared route                                                                                                 | Preserve and reconsider                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2882 hode                         | A working native desktop build with coherent supported Windows Heart of Darkness data; selected Makefile target hode | Actual --datapath/--savepath, hode.ini, setup.cfg and screenshots. Official NRO/VPK packages do not prove desktop binaries; console/demo/PC data sets remain distinct. |
| #2883 1oom vanilla                 | Exact vanilla-RC5 beta/testing source/tag/branch with own MOO v1.3 LBX; graphical SDL player                         | Creating user/CWD root, CONFIG.MOO, SAVE*.GAM/1oom_save*.bin; do not inherit discontinued default/latest or a later fork.                                              |
| #2886 NFSIISE wrapper              | Completed Windows x86 copy with matching 32-bit dependencies and own Special Edition fedata/gamedata                 | AppData/.nfs2se profile and original CWD fallback; no accepted published managed digest.                                                                               |
| #2887 NFS Recompiled / NFS II SE   | Actual native AMD64 nfs2se.exe, distinct from nfs3hp.exe and the x86 wrapper                                         | Explicit absolute install/CD-root arguments and all mapped writable roots; no original-data picker or new Core builder supplied.                                       |
| #2902 NOLF Modern                  | Clean completed Windows public archive, prepared with own exact two European GOTY discs; direct NOLF.exe             | Whole creating installation, Save/, configuration, generated command file, logs/custom files; retain middleware terms and deliberate new-copy updates.                 |
| #2715 Syndicate Wars Fan Expansion | Completed supported PC original-data/patch-or-setup installation, normal swars.exe                                   | Registry/data/CD roots, actual user profile and qdata save/screenshot trees; 32-bit dependencies remain explicit.                                                      |

These are non-owning selected-player routes: upstream/player completes preparation,
owns replacement and every external file, and handles migration/recovery.
Registration binds the actual executable, working directory and literal arguments
with explicit intent/consent; Play is separate. Registration removal preserves
external files. It does not offer Core-managed downloads, setup, update, backup,
rollback, migration, registry changes or external deletion. A completed working
copy does not inherit curated immutable-tree certification.

The selected hode data contract names hod.paf, setup.dat and matching level/sss/mst
files, with specific Win32 edition sets and separate demos/PlayStation tuples in
RELEASES.yaml. Its source save consumer writes setup.cfg and screenshots through
the actual savepath. Desktop preparation stays upstream; no downstream compiler,
console SDK or generic family work is introduced.

1oom's documented plain `vanilla` branch name no longer resolves. The complete
current branch observation instead contains **master-vanilla-beta-RC5**; it and
the canonical **vanilla-RC5** tag both resolve to
`a956a6f73f75e6cd26b701afcd04bd4973650520`. The API's default/latest v1.11.9 is a
discontinued different lineage. The RC5 asset is explicitly beta/testing even
though its publisher prerelease flag is false; no stable qualification follows
from that flag. The guide neither pins the default package nor silently adopts
the separately referenced SourceCraft successor.

The selected RC5 Windows code defaults its user root to **the working directory**;
CONFIGURATION's “User directory” is not an invented literal User subfolder.
`-data ABS` and `-user ABS` select distinct roots. Original-format SAVE*.GAM slots
are enabled by default, and CONFIG.MOO is written there, so placing this engine
in an existing MOO directory can overwrite original slots. Preserve independent
copies before running/changing engines; format support is not observed backward
compatibility or automatic conversion authority.

The NFSIISE wrapper's actual profile mapping activates only with a usable profile
configuration; it creates config/save/stats/prh/tmptrk beneath AppData/.nfs2se on
Windows and copies nfs2se.conf.template on first use. Without usable profile setup,
original relative game paths can remain the write targets. Preserve both roots.
Its x86 package and original-code wrapper are distinct from the AMD64 native
NFS Recompiled executable. A missing expected digest is not repaired by computing
a fresh hash or inventing a permanent Direct pin.

For NFS Recompiled, the existing R14 public ZIP observation is reused only after
matching the current source, asset ID, expected size/digest and actual cached bytes.
The old inventory filename `linux-archive-inventory.json` is historical: the
separate actual-host headers prove Windows AMD64 nfs2se.exe/nfs3hp.exe, not Linux
ELF qualification. NFS II's own entry/source consumer is separately bound. Zero
arguments derive roots from argv[0]; explicit one/two absolute directory arguments
avoid assuming CWD selects the originals. File-backend writes/removal follow the
installation/CD mapping, so both actual original roots remain player-owned.

NOLF's selected modern direct NOLF.exe entry sets CWD to its own directory and
**waits for its lithtech.exe child** before returning its exit status. The separate
NOLFLauncher.exe is configuration UI. The clean public package requires completed
upstream installation from the exact own European GOTY discs; the rez submodule's
original-image fetching workflow is excluded. New archives go into a new empty
installation, with deliberate compatible save transfer upstream. The Monolith,
GameSpy, OpenMiles GPL, Bink/FFmpeg LGPL and DirectMusic terms remain distinct;
public availability is not a whole-package grant or an invented private-use ban.
Non-Windows Wine/Proton/CrossOver paths do not become native platform qualification.

Syndicate Wars reads its real registry-backed HDD root (HKCU then HKLM), otherwise
CWD. Windows user paths use AppData/Syndicate Wars **only when installation lookup
and AppData succeed**; otherwise CWD remains effective. Saves/screenshots are mapped
to the selected user root, with their qdata/savegame and qdata/screenshots paths;
other data can resolve to HDD/CD. Preserve all effective locations and existing
custom/profile INI files. A patch/installer, partial game tree or 64-bit OS by
itself is not a complete 32-bit prepared runtime.

## Source, validation and evidence limits

The [companion JSON](classic-player-maintenance-routes-2026-10-31.json) binds exact
selected/current source commits, actual complete root trees, blob identities,
package observations, individual management decisions and input hashes. Contextual
discontinued 1oom source is labeled separately from the qualified RC5 route.
Gunstar's Pulseman dependency is independently pinned, not treated as the parent's
current branch. Duplicate observations are not counted as distinct bindings.

All eight exact private records passed maintained preparation before source
application. Preparation used reviewed parent 41f8382e; actual delivered parent
f66fdbd6 has exactly the same tree, and all eight original record preimages match.
That is content-equivalent authoring reuse, not native/installed acceptance.
Compatible first-party Core validation accepts 279 declarations and 1,424 listings
with matched identities. All 277 prior strict definitions and the source catalog
remain exact; two compatibility identities append to the ordered old prefix, with
all source IDs unchanged. The two new strict summaries use concise outcomes,
with setup/maturity facts kept in structured fields.

Two inert actual-definition cases reuse the existing complete unchanged-definition
N-to-N+1, native executable/working-parent, local-data carry and rollback helper.
Six actual-ID prepared-copy cases reuse the existing complete selected-registration
intent/consent/relink/restart/Play/removal helper. Every prior Rust byte/assertion
remains unchanged; only test cases append. Existing shared archive/provider,
modified-byte/stale-plan, interruption, process and preservation coverage remains
under ordinary complete-diff selection. These fixtures do not execute the upstream
player, ROM, original-data picker, installer, import tool or game.

Required exact-head CI, full source/target review and delivery readbacks are recorded
on the delivering PR. No new original/ROM/private-save acquisition or upstream
helper/compiler/game execution, actual save, native/installed, human, multiplayer,
Supported or protected-publication acceptance is claimed. The physical desktop
GUI stop remains binding; ordinary source/static work does not resume it.
