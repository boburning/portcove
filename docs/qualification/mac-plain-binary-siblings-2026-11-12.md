# Mac plain-binary siblings: OpenCMR2 and OpenReliant

Dated package evidence for three managed macOS routes added on November 12, 2026, under #2926. Both titles reuse the established plain-binary `native-portable` Mac shape (as bstone and rerac do). Each title's Windows and Linux persistence contract applies unchanged, and no new runtime capability is introduced.

## Selection

Release metadata came from the hosted configured-upstream observer (run 43058926577).

- The screen covered `native-portable` titles without an Apple silicon route whose latest release publishes a macOS package.
- Disk images (DMG) were skipped, as were app bundles without a reviewed profile policy. Nine titles, including Gunstars, OpenTyrian, Dune Dynasty and Daggerfall Unity, publish app-bundle ZIPs. They are candidates for a shared app-bundle capability.
- SDL Sopwith's Mac ZIPs only wrap DMGs.

| Title                                    | Route         | Package, bytes, SHA-256 prefix                       | Player                              |
| ---------------------------------------- | ------------- | ---------------------------------------------------- | ----------------------------------- |
| OpenCMR2 (#1949), v1.8.7 (`f1f89d89`)    | Apple silicon | `OpenCMR2-macOS-arm64.zip`, 2,576,140                | `opencmr2` beside `libSDL3.0.dylib` |
| OpenReliant (#1789), v1.0.0 (`1606da5c`) | Apple silicon | `openreliant-v1.0.0-macos-aarch64.tar.gz`, 9,463,328 | `openreliant`                       |
| OpenReliant (#1789), v1.0.0              | Intel Mac     | `openreliant-v1.0.0-macos-x86_64.tar.gz`, 9,898,689  | `openreliant`                       |

Every package matched its provider SHA-256 and passed `portcove catalog inspect-package-layout` through Core extraction for its platform.

## Facts per title

### OpenCMR2

- **Binary:** arm64 Mach-O with an embedded code signature and `minos` 11.0. It loads `@rpath/libSDL3.0.dylib`, with `LC_RPATH @executable_path`.
- **Settings and saves:** `src/platform/sys.cpp` keeps settings, saves and logs in `SDL_GetPrefPath("", "OpenCMR2")`. On macOS that is `~/Library/Application Support/OpenCMR2`, outside the install, just as AppData is on Windows.
- **Data folder:** the optional `Data` folder resolves beside the executable through `./Data` and `SDL_GetBasePath()`, which matches the declared contract.

### OpenReliant

- **Binaries:**
  - The arm64 player has an embedded code signature and `minos` 15.0.
  - The x86_64 player has `minos` 15.0 and no signature, which macOS does not require on Intel.
  - Neither links non-system libraries.
- **Game folder:** `src/openreliant/install.zig` finds the `StarLancer` folder relative to the working folder, which is the player folder under Portcove, on every platform. Its only macOS-specific branch enumerates `/Volumes` for disc discovery. The declared `StarLancer` contract therefore applies unchanged.

Both titles are enrolled in the shared release-selection corpus. Each uses its real inventory plus a synthetic successor at `downloads.example.invalid`.

## Not observed

No upstream player was executed and no original data was used. Native launch, gameplay, saves, and update or rollback with real data were not observed.
