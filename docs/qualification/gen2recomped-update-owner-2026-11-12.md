# Gen2Recomped update ownership

Repair under #2926 for the existing managed Gen2Recomped routes (Gold, Silver and Crystal).

## Finding

The current `v0.8.57` package (`Gen2Recomped-0.8.57.love`, 27,367,473 bytes, provider SHA-256 matched) contains a self-updater:

- `src/update/Check.lua` selects `self-update` mode in any fused desktop build with a network transport. Its downloader writes `Gen2Recomped-<X.Y.Z>.love` payloads to `updates/` in LÖVE's save folder.
- At boot, `src/update/Boot.lua` chainloads the newest payload whose engine version is newer than the bundled one.
- `conf.lua` names that save folder `Gen2Recomp` on desktop, which is `%APPDATA%/Gen2Recomp` for the fused Windows build. The folder is per user, shared across copies, and outside portable mode (`src/update/Payload.lua` with `src/core/SaveData.lua`, which redirects only `save.lua`/`options.lua`).

A Portcove-managed copy could therefore run Lua that Portcove did not install and cannot roll back. The gen1recomp route already avoids the equivalent behaviour with `POKEPORT_PORTMASTER_MANAGED=1`. Gen2Recomped has no such switch.

## Repair

The three current definitions set `POKEPORT_NOTIFY_ONLY_UPDATES=1`. `Check.capability()` then reports `suppressed`, so the managed copy no longer downloads payloads. Release checks still contact the network to announce new versions. Installations created before this definition keep their creating launch recipe until their next Portcove update or reinstall. The frozen schema-1 reader expectation records the change, and the Gen2 contract test asserts it.

## Remaining limit

`Boot.run` still chainloads a newer payload that another copy has already placed in the shared folder. Starting the managed copy also lets `Boot.select` delete payloads in that shared folder that are not newer than its bundled engine, including ones another copy downloaded. The player copy explains the loading case and names the folder to remove.

Isolating the managed copy with a private `POKEPORT_IDENTITY` would also close this gap. That would move every non-portable item stored in the save folder, so it needs its own data review first. The Linux AppImage route for these titles (`Gen2Recomped-x86_64.AppImage` in `Gen2Recomped-0.8.57-linux.zip`) waits for that decision. That package passes Core layout inspection, and portable mode resolves `dirname($APPIMAGE)`.

## Not observed

No upstream runtime was executed, and no original ROM was used.
