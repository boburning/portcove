# Managed Dark Forces setup

The managed Windows route for The Force Engine is closed to the reviewed
v1.22.420 engine artifact. It accepts the complete reviewed PC installed-data
folder or ZIP: four GOB files and 44 files under `LFD/`. A lone `DARK.GOB`, an
unrecognized edition, or flattened LFD files cannot satisfy this route. The
historical single-GOB profile and retained external installations keep their
original contracts; this change does not adopt an existing installation or pilot.

Choose the complete folder or **Add ZIP**, then use **Check game files**. Portcove
checks every required relative path, size and SHA-256 and retains the observation.
ZIP storage identity is distinct from the normalized complete-file identity.
The quick **Files ready** filter cannot confirm this source shape: its bounded
batch reports **Not checked**. Use the full file check in game details or
Settings to inspect it. A quick refresh does not establish readiness.

Core copies only those checked members into private `GameData/` when preparing
launch. Unrelated original files are not copied. It checks originals and private
copies again when reusing preparation; a matching marker is not sufficient.
Changing a checked original requires checking it again. Original files are not
edited. Discovery retains caller entry, depth, file-size and hash budgets;
direct inspection also has fixed entry and expanded-size limits.

If absent, Core creates a fresh, empty compatible `DARKPILO.CFG` and minimal
local `settings.ini` pointing to `GameData/`. Compatible existing profiles and
settings are preserved byte for byte. Invalid or linked profiles refuse
preparation; Portcove never imports a pilot from another installation. Settings,
pilot, input mappings, ImGui settings, screenshots and saves follow the declared
managed persistence paths. `GameData/` is generated data, not a save directory.

## Recovering interrupted or replaced preparation

Preparation uses `.tfe-preparation` inside the version directory. Private
incomplete staging is cleaned when possible. Replaced `GameData/` is captured
under `previous-data-*` and is **not deleted automatically**, including when
another process adds an unexpected file during replacement. Publication and
restoration never overwrite a competing destination.

These copies are recovery material, not normal saves or portable backup data.
Nonempty, unsafe or unreadable `.tfe-preparation` prevents removal. Core checks
the fixed namespace in every validated owned version root, including inactive
versions and removal quarantine. Reopening Portcove, changed catalog metadata,
previous removal consent and already-deleted installation records do not clear
the hold. A failed removal retains its recovery journal.

When Portcove reports `recovery_directory`:

1. Close the game and stop the affected preparation or removal operation.
2. Preserve the **entire indicated `.tfe-preparation` directory** outside every
   Portcove installation and recovery directory. Move it when safely possible;
   for a copy across volumes, verify the copied files before removing the
   original. Do not merge it into `GameData/`, canonical saves or another install.
3. Inspect the preserved copies for files you want to retain. Keep ambiguous
   copies; do not delete them merely because a fresh game can start. Resolve
   linked or unreadable paths without following them into unrelated locations.
4. Return to Portcove and obtain a fresh removal review, or retry the retained
   interrupted operation. Only an absent or ordinary empty preparation directory
   clears the hold. Portcove does not perform the manual preservation for you.

The hold only refuses destructive cleanup in already-owned roots. It does not
grant ownership of an arbitrary path or infer consent from a catalog entry.
The same conservative protection applies if another managed version contains
this fixed recovery namespace.

Process startup, gameplay, save loading and platform support remain separately
qualified observations. Managed setup alone does not establish them.
