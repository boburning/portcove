# VCMI managed Windows engine and shared profile

The official [VCMI 1.7.5 release](https://github.com/vcmi/vcmi/releases/tag/1.7.5)
ships `VCMI-Windows.zip`, 48,727,777 bytes. The archive matched the provider
SHA-256 `0a530799085c1a135f9686d49d859beab8741869dcd9fe0877ef428ca0830d88`.
Core inspected the package and identified the client, launcher, server, map
editor and their companions. The exact archive name is stable across releases.

The [tagged source](https://github.com/vcmi/vcmi/tree/6901839ae9760dfcd1d5ff2c4aa4ef6968fee752)
keeps the direct Windows client's working folder beside its executable. The
launcher starts a detached client on Windows and macOS. Managed Windows Play
uses the direct client after the upstream launcher has imported the player's
original files. The client owns its local server and waits for it during
normal shutdown. The launcher and player remain available as a separate
upstream installation.

In this package, the optional `config/dirs.json` is absent. Without that
override, VCMI uses Windows Documents plus `My Games/vcmi` for data and
derives its cache, configuration, logs and save paths from that root. Failed
Windows folder resolution would make the game fall back to the current
folder. Core resolves Documents through the same Windows API, refuses that
fallback and any runtime override file, and checks the effective shared
profile through its existing bounded external-profile guard. The player owns
that profile, its originals and mod data. Use a separate upstream copy for
custom paths.

NativePortable capability 31 fences the profile guard. The Linux AppImage and
Mac disk images remain upstream setup, as do Android and iOS. Portcove did
not run VCMI, an importer, an original game, a populated profile or gameplay.
