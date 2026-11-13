# CorsixTH and OpenLoco packages

[CorsixTH #1807](https://github.com/boburning/portcove/issues/1807) and
[OpenLoco #1855](https://github.com/boburning/portcove/issues/1855) already
have managed Windows runtimes with external player data. The sibling routes
keep that boundary and the original game data outside the managed runtime.

| Reviewed asset                                                                               |  Asset ID | Publisher and observed SHA-256                                     |
| -------------------------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| [CorsixTH v0.70.2 Linux AppImage](https://github.com/CorsixTH/CorsixTH/releases/tag/v0.70.2) | 709004077 | `106aa756cfbd59be153067f63fa8ac8b2090996752853cd4f03d03425011237e` |
| [OpenLoco v26.09 Linux AppImage](https://github.com/OpenLoco/OpenLoco/releases/tag/v26.09)   | 573269264 | `353750c8cee127aa24ce2e3cc7e8233c14fe37362bd62f6b3c3d6887a7d16fb3` |
| [OpenLoco v26.09 Mac ARM64 ZIP](https://github.com/OpenLoco/OpenLoco/releases/tag/v26.09)    | 573269199 | `15cd95be662810cae3a16bc8053b2cb3cd2bc680fc29ac486322c3e00fe6da1e` |

Each AppImage contains a type-2 runtime and an AppRun link to its native
engine. CorsixTH's ELF needs glibc 2.34 and libstdc++ with GLIBCXX_3.4.30.
The inspected OpenLoco player needs glibc 2.28. The Linux routes require
AppImage FUSE support. Core keeps the complete AppImages and checks the
temporary mount locations and adjacent portable profile paths.

CorsixTH's Lua configuration reader uses XDG_CONFIG_HOME when defined or
HOME/.config otherwise, appending CorsixTH. A defined empty XDG value
would select a path under the filesystem root and is refused by the managed
guard. The reviewed AppImage contains no bundled config.path.txt. The
player chooses their own Theme Hospital data folder in upstream setup.
CorsixTH can write a temporary copy after a profile write failure. Preserve
that copy separately before restarting.

OpenLoco uses a nonempty XDG_CONFIG_HOME on Linux. Otherwise it reads the
account home, with HOME as a fallback, and uses .config/OpenLoco. On Mac
the tagged Foundation code selects the account's Application Support folder.
The 222-member Mac ZIP has no archive links. Its exact executable is
`OpenLoco.app/Contents/MacOS/OpenLoco`, a thin ARM64 executable built for
macOS 15. The published bundle is unnotarized. The player chooses their
own Locomotion folder containing Data/g1.DAT.

The profiles, originals and separately selected player folders are outside
Portcove backups and stay with the player. The managed guard checks the
normal profile. Use a separately prepared copy for custom or relative save,
landscape, campaign, level, log or screenshot locations and keep those paths
outside the library. An unrecognized write inside a managed version holds
runtime replacement or removal under the existing immutable inventory check.

Controlled successors exercise the versioned package selectors, including
OpenLoco's two-part calendar versions and optional patch component. The
CorsixTH Mac DMG and Linux ARM64 Flatpak retain upstream setup. Package
inspection and fixtures do not establish native Mac launch, retail gameplay,
original-game identity or populated-save compatibility.
