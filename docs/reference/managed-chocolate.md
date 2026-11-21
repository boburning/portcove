# Managed Chocolate profiles

The Windows Chocolate Doom, Heretic and Hexen routes use official portable
packages and exact original-game identities. Each engine has its own catalog
entry and package selector. Strife keeps its upstream route. This recipe does
not supply Strife’s retail IWAD or voice data.

Choose a listed original IWAD, install, then choose Play. Portcove preserves the
original and prepares a separate `game.wad`. It starts the game executable
directly with fixed configuration and save locations. The separate upstream
setup utility is not a managed launch or process owner.

The creating installation and canonical data retain:

- The copied `game.wad` and the engine's main and extra configuration files.
- `savegames`, including a separate directory for each exact IWAD's SHA-256.
- Local `autoload` and `music-packs` trees.
- Engine-named PCX and PNG screenshots.

The main configuration is `default.cfg`, `heretic.cfg` or `hexen.cfg`; the extra
configuration is `chocolate-doom.cfg`, `chocolate-heretic.cfg` or
`chocolate-hexen.cfg`. Core seeds only a missing extra configuration with local
autoload and music-pack paths. Existing compatible configuration remains byte
identical. Incompatible, ambiguous, linked or unreadable data holds preparation;
preserve that data before selecting a compatible profile. Core never silently
rewrites a player's configuration or imports a shared roaming profile.

Each save-directory argument is a 74-byte relative path. Even Hexen's longest
reviewed slot/map filename fits its upstream 100-byte buffer. Core also checks
the complete Windows path budget before preparing the directory. An empty or
different IWAD cannot silently inherit populated save slots. The actual copied
IWAD is checked independently of the ordinary source-copy marker, including
before canonical data moves. Incoming data with saves but no IWAD is refused.
Prepared data stays intact when an unoffered profile operation is requested.
Ordinary backup restoration uses its existing reviewed snapshot contract.

Compatible updates, rollback and backups retain the declared data through Core's
existing staged-archive persistence contract. Runtime replacement belongs to
Portcove for the managed route. Removing that route does not grant ownership of
the original input. Optional SDL stdout/stderr logs are runtime diagnostics.
Autoload preservation does not establish compatibility of arbitrary mods or
saved games across engines or upstream versions.

Linux distribution packages and Intel/Apple Silicon Mac Homebrew installations
retain their own replacement owner. The official release also contains separate
Mac disk images; this candidate does not add a managed DMG installer. Explicit
selection of an installation outside Portcove remains a separate, non-owning
route with its retained execution intent. Its updates and data remain with the
player and upstream package manager. Current release asset enumeration contains
no Android package; no Android managed host or native qualification is claimed.

The original identities come from versioned Debian game-data-packager 89
manifests. Source observations use Chocolate Doom commit
`410d96855b5df5410ff591a90efeafa889119224` (tag `chocolate-doom-3.1.1`).
Publisher asset digests authenticate the selected Windows archives. Tagged
source, inert package inspection, deterministic Core fixtures and execution of
the packaged players are separate evidence scopes. The owning issues retain
native results and remaining acceptance; this document does not establish them.

The source applicability retained here names the reviewed 3.1.1 archives. The
existing reusable source policy requires the separate provider-bound archive-data
version-27 contract; this recipe does not widen that policy. Dynamic release
selectors remain in use, but a future release does not inherit a source-matching
or qualification claim from this receipt. Shared maintenance owners retain that
follow-up; no zero-routine-maintenance claim is made for the gap.
