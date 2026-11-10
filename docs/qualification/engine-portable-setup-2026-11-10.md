# TRX and R.E.L.I.V.E. upstream setup

## TRX

The [TRX 1.12 release](https://github.com/LostArtefacts/TRX/releases/tag/trx-1.12) supplies both a Windows installer and a complete manual ZIP. The Windows ZIP, asset 703482896, matched SHA-256 `db890625de2de0baf4f97802b65754af22f30a3f4b3307ef789537f09606fc0e` and contains `TRX.exe`. The Linux ZIP, asset 703482884, matched `278e2bc97749971d18682189c7d737de39ff48132c8014aae74c7d72b996ef17` and contains the x86-64 `TRX` executable. Both contain the complete `cfg` and `games` trees alongside the player.

The [tagged installation guide](https://github.com/LostArtefacts/TRX/blob/bbed65a0e4fee48f1aa70956f9f0f4a44a059013/docs/trx/INSTALLING.md) maps each original's files into its own `games/<game-id>` path. Both observed archives already ship some content in those paths, including `games/tr2/music/57.mp3` and the Golden Mask levels. Whole-directory preservation would mix player and build content. A separate extracted folder, the upstream file map and a backup of the creating copy are the supported manual replacement procedure. The runtime derives `cfg`, `cache`, `games`, `screenshots` and `saves` from the executable's root by default. Its documented environment variables can select separate locations. The guide preserves those actual locations and keeps the existing installer and Mac DMG options.

## R.E.L.I.V.E.

The [github-v1.1.0 release](https://github.com/AliveTeam/alive_reversing/releases/tag/github-v1.1.0) publishes Windows x64 Debug binaries and an amd64 Debian package inside a ZIP. Asset 678062811 matched SHA-256 `c88582e831399ac1db72675c5dc104d539c32302f4db8885a57899ea0fe28677` and contains `relive.exe` with `SDL3.dll`. Asset 678064565 matched `9cec2ce9c627320565212f62aba89df421991a880c23840b47311449bd7905a8`. Its Debian metadata names `libsdl3-0` and `zenity`, and the payload contains `/usr/bin/relive` and the two upstream shortcuts.

The [tagged executable source](https://github.com/AliveTeam/alive_reversing/blob/fe6f54c4b349f344fccd1bc0bf0839ee58db7e34/Source/relive/Exe.cpp) chooses Exoddus by default or Oddysee when the literal command line includes `AO`. Exoddus checks `st.lvl` and `mi.lvl`. Oddysee checks `s1.lvl` and `r1.lvl`. It falls back to the other game when the selected files are missing, so the guides keep the two originals and working folders separate. Both branches enter the selected game in the same process. The Debian shortcuts may select and remember a folder outside Portcove.

The tagged README describes a future license choice, and the reviewed Windows package contains only the executable and SDL library. The current publisher digests resolve the package checksum question. The existing fresh-download hold retains the attributable distribution and supported-release conditions. Both guides apply to already permitted working copies.

The three records provide setup guidance. Artifact inspection and source review establish the stated paths and selection behavior. Native execution, game-data compatibility, populated-save behavior and protected publication remain separate observations.
