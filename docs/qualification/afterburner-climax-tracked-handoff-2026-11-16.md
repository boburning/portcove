# After Burner Climax (darkuni) managed Windows route with tracked handoff

This candidate gives After Burner Climax (darkuni Recomp) a managed Windows
x86-64 route that declares `windows_tracked_handoff: true`.
[Canonical title #4134](https://github.com/boburning/portcove/issues/4134).

## Exact inputs

Observed 2026-11-16. Tag `v1.1.0` is commit
`9eeeb46030a2247e7b13b0f6241b42c4f32383b7`. The release asset
`AfterBurnerClimax-v1.1.0-win64.zip` is 16,725,177 bytes with SHA-256
`bdfe2e331ea939abe20a42111a906d6a56637b694375cf07c8247d40fe06e5b4`, computed
from a fresh download and equal to the asset digest recorded on #4134 on
2026-11-08. `portcove catalog inspect-package-layout` with that hash reported the
directory `licenses` and the programs `after_burner_climax.exe` and
`after_burner_climax_world.exe` below one unwrapped `AfterBurnerClimax/` folder,
which is the declared reviewed layout. Nothing from the package or source was
executed.

## Process lifetime

Source at the tag commit:

- `src/after_burner_climax_app.h` `OnConfigurePaths` calls `xex_variant_check`
  (`src/package_setup.cpp`), which compares the extracted `assets/default.xex`
  by SHA-1 and size with two variants: the original release (1.0.0.0) for
  `after_burner_climax.exe` and the World release (0.0.1.2) for
  `after_burner_climax_world.exe`. Any other file gets a message and exit code 1.
  When the other program owns the variant and exists beside this one, the check
  hands off and returns 2, and the process exits with 0; if the sibling is
  missing it shows an error and exits with 1.
- `src/package_setup.cpp` `relaunch_as` starts that sibling with
  `CreateProcessW`, the original command line, no inherited handles, creation
  flags `0` and the sibling's own folder as the working directory, then closes
  its handles. The successor is a declared program inside the installation,
  started from the game's own process tree without job breakaway and without
  the shell, so the tracked handoff keeps the session until it exits.
- Both programs construct the app with the name `after_burner_climax`, so they
  share `after_burner_climax.toml` beside the program and the same profile.
- No updater or download code was found.

## Writes and data

On first start `package_setup_first_run` looks for the player's own package for
title `58410A06` beside the program and extracts it into `assets`. Settings go to
`after_burner_climax.toml` beside the program; saves and the shader cache go to
ReXGlue's user folder, `Documents\after_burner_climax`; logs go to `logs` beside
the program. The route keeps `58410A06`, `assets` and `after_burner_climax.toml`
as persistent paths with `external-user-owned` saves and settings, as the
OutRun Online Arcade and Lode Runner routes do. The program sets
`license_mask=1`, so it always runs as the full game; the guide requires the
player's own purchased full package, with the same wording as the managed
OutRun Online Arcade and Lode Runner routes.

## Rights

The package includes recompiled game code that the project license does not
cover. Under the rights basis that is a recorded listing warning, not a hold.

## Limits

This evidence is bound to `v1.1.0` / `9eeeb460`. A later release that adds job
breakaway, a shell-started helper or an updater falls outside it. No real
install, handoff or gameplay under Portcove has been observed.
