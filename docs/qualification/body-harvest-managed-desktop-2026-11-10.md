# Body Harvest direct desktop packages

The official stable v1.0.0 native TAR.GZ adds a managed Linux x86-64 route
beside the existing Windows route. Intel Mac and Apple Silicon Mac use the
universal ZIP through upstream setup. Linux ARM64 and Flatpak remain separate
upstream setup choices. [Publisher release](https://github.com/mcsoderh/BodyHarvestRecomp/releases/tag/v1.0.0).

| Verified asset                 |      Bytes | SHA-256                                                            |
| ------------------------------ | ---------: | ------------------------------------------------------------------ |
| Linux x86-64 TAR.GZ, 607572511 |  7,838,568 | `7e64896d65a161a6ccf3fe1976e496df630b34985d8192e1bf6e1f27f2b96a08` |
| Universal macOS ZIP, 607572512 | 17,078,394 | `1f6ee251de9b464ae5a89b791e450a7c0fda86f0d712a47e596d8c184dbdfc24` |

The maintained package inspector reproduced the Linux authored layout and
inspected the Mac layout against publisher sizes and SHA-256 digests. The Linux AMD64 ELF imports glibc symbols through
2.35, SDL2, GTK 3, FreeType, libatomic and libgcc_s and uses the extracted folder for its bundled assets.
The Mac player is
`BodyHarvestRecompiled.app/Contents/MacOS/BodyHarvestRecompiled` and has
x86-64 and arm64 executable slices. The player slices and Info.plist declare macOS 11.
Bundled SDL2, FreeType and other dylib load commands target macOS 14 on both
architectures. Use macOS 14 or later for this package and keep all bundle
resources with the executable. The ZIP's signed CodeResources seals four
required dylib aliases as symbolic links. The current bounded extraction
materializes these as regular copies, changing the publisher's resource
seal. A managed Mac route requires preserving the verified app bundle
through extraction or an equivalent upstream artifact, followed by native
verification of the managed output. Use upstream setup with the original
bundle on both Mac architectures in the meantime.

The exact v1.0.0 entrypoint registers the upstream frontend configuration
directory for settings and the upstream private copy of the North American
cartridge. The player validates and normalizes the player's own original.
The launch stays in the player process. On native Linux, a present
`APP_FOLDER_PATH` takes precedence over `HOME/.config/BodyHarvestRecompiled`.
The fallback uses the OS account home when HOME is absent. On macOS, the same
override precedes the Foundation user Application Support lookup. When that
lookup yields no directory, the upstream frontend tries HOME or Foundation's
home lookup, then `.config/BodyHarvestRecompiled`. Windows uses its LocalAppData
Known Folder. The existing source, original and acquisition boundaries are
documented with the [Windows route](body-harvest-managed-windows-2026-11-06.md).
[Tagged entrypoint](https://github.com/mcsoderh/BodyHarvestRecomp/blob/e90747cd09fd732340443c73ed0657eb9bee0fdf/src/main/main.cpp).
[Pinned frontend profile lookup](https://github.com/N64Recomp/RecompFrontend/blob/b1a1477c6556aeb7ed45defbfb5924f721efebc1/recompui/src/util/file.cpp).

The profile guard checks the actual child environment and holds empty,
relative or managed-overlapping defaults. The managed Unix launch keeps
APP_FOLDER_PATH out of the child environment and refuses an explicitly
configured host override so it cannot silently select a different profile.
Use a separately prepared copy for an override. The guard also holds a
`portable.txt` marker in the working folder. For the upstream Mac bundle,
the frontend also checks beside the app. Portcove manages the
separate runtime. The external profile, saves and remembered ROM stay with
the player, including when a separate copy shares them. Core can use the
guard with a matching retained Windows installation while preserving its
creating definition. The independently stated archive expectations exercise
the published release and a synthetic compatible successor. Static package
observations and controlled fixtures establish neither upstream gameplay
nor real-save interoperability, native execution qualification or protected
publication.
