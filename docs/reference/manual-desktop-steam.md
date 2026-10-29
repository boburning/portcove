# Manual desktop Steam launch

[#290](https://github.com/boburning/portcove/issues/290) owns this plugin-free,
launch-only route on Windows and ordinary Linux desktops. The player maintains
the shortcut. Steam does not install, update or roll back Portcove games through
it. #292's managed entries and #527's optional artwork provider are independent.
Physical Deck/Gaming Mode qualification belongs to #217.

## Add the application

Use Steam's **Add a Game → Add a Non-Steam Game → Browse** flow, select the
installed Portcove application, then open that shortcut's Properties. Valve's
[non-Steam shortcut guidance](https://help.steampowered.com/en/faqs/view/4B8B-9697-2338-40EC)
is the setup reference. This manual route does not write Steam profiles itself.

| Desktop        | Target                                                     | Launch Options | Start In                           |
| -------------- | ---------------------------------------------------------- | -------------- | ---------------------------------- |
| Windows        | Absolute path to the installed `portcove-desktop.exe`      | Empty          | Application executable's directory |
| Ordinary Linux | Absolute path to the selected executable Portcove AppImage | Empty          | AppImage's directory               |

Use the actual installed executable, not an installer, archive or a source build
command. The filename/location can vary with the selected package. Preserve any
required executable permission on Linux. Launch from the ordinary Steam library
and Big Picture separately; a successful direct process start does not qualify
both Steam modes. Exit Portcove normally and confirm return/focus to Steam.

## Add one already-installed game

Select the verified standalone CLI executable as a separate non-Steam target.
Keep it at a stable absolute path. The application package and standalone CLI
have separate update ownership. Obtain the stable port ID and selected library
from Portcove, rather than deriving either from a title or Steam display name.

The canonical argument array is:

```json
["--library", "ABSOLUTE_LIBRARY_ROOT", "exec", "STABLE_PORT_ID", "--"]
```

Enter the following example as separate Steam fields, substituting your paths
and the selected installed port ID. Quote each complete path in Steam's fields;
retain Unicode literally. The quotes group arguments; they are not part of the
library path. Do not use a shell wrapper or a version-specific game executable.

| Desktop        | Target                                         | Launch Options                                                                   | Start In                              |
| -------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- |
| Windows        | `"C:\Games ü\Portcove CLI\portcove.exe"`       | `--library "D:\Game libraries\Portcove 日本語" exec STABLE_PORT_ID --`           | `"C:\Games ü\Portcove CLI"`           |
| Ordinary Linux | `"/home/player/Games ü/Portcove CLI/portcove"` | `--library "/home/player/Game libraries/Portcove 日本語" exec STABLE_PORT_ID --` | `"/home/player/Games ü/Portcove CLI"` |

Do not add `--json`/`--jsonl` to `exec`: the supervisor inherits the game's streams
and exit code. Omit a static `--request-id`; each invocation needs a fresh session
identity. The GUI can remain closed. A prepared game can launch offline if its
own runtime requirements permit; no new Portcove account or provider is needed.
The selected library, port and runtime registration remain Core-owned.

## Repair and maintenance

| Change or failure              | Manual action and boundary                                                                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Game update/rollback           | Keep CLI target, library argument and port ID. Core resolves the active managed version and collects against the exact launched installation. A version directory is never the Steam target.                                             |
| User-owned runtime changes     | Use Portcove's reviewed relink/repair for the registered runtime. Retain the registration identity and player data; Steam cannot adopt changed executable bytes. Runtime updates remain with the owner shown by #2494's installed route. |
| Application or CLI moves       | Repair that entry's Target and Start In. Verify the replacement package/CLI identity. The app updater does not update a separately located CLI automatically.                                                                            |
| Library moves                  | Complete Portcove's supported library move/recovery first, then repair the explicit `--library` path. Verify the durable library identity. Editing a shortcut alone does not move a library.                                             |
| Missing/removable storage      | Reconnect the exact library/runtime/source or perform the supported repair. A different mount/drive letter or directory with the same name does not prove identity. Do not install into a replacement library to hide the error.         |
| Read-only or unavailable files | Record the actual permission/storage failure. Do not elevate, remove locks, silently redirect writes or infer that every read-only source prevents launch: an already-prepared runtime may no longer need it.                            |
| CLI missing/incompatible       | Repair the verified standalone CLI target. Steam's failure to start an executable is not a Core game session.                                                                                                                            |

## Exit, Stop and recovery

Normal game exit returns through the existing Core supervisor and its exact
installation/session. A nonzero exit or crash must remain failed, with its actual
exit/recovery record; it is not a successful launch merely because Steam stopped
showing Running. Confirm focus/return in the selected Steam mode separately.

Steam Stop can terminate the supervisor or game abruptly. Do not promise final
save flushing or collection after a hard kill. If a retained session is still
unfinished, inspect its actual request ID with the public CLI:

```text
portcove --library ABSOLUTE_LIBRARY_ROOT --json launch show REQUEST_UUID
portcove --library ABSOLUTE_LIBRARY_ROOT --json launch recover REQUEST_UUID
```

Use the ID from the retained launch/session diagnostics, not a new guessed UUID.
Recovery uses Core's existing supervisor/child start-identity and installation
checks. A live or ambiguously identified process, changed installation or missing
identity can require review. Do not delete session state or kill an unrelated PID
to force recovery. Static Steam entries are not a durable polling client.

## Qualification scope

The maintained CLI regression
`listing_only_selected_runtime_survives_cli_restart_relink_and_registration_removal`
exercises a synthetic user-owned runtime through the public `exec` argument array,
a spaces/Unicode library and runtime directory, a copied/relocated CLI with repaired
Start In, missing runtime refusal and reviewed relink retaining registration identity.
This is native executable/CLI fixture evidence when executed, not actual Steam,
managed-game update/rollback, packaged release or gameplay evidence.

The [retained Windows Steam Stop recovery receipt](https://github.com/boburning/portcove/issues/290#issuecomment-5706391139)
remains credited only for its recorded executable, session and environment.
For additional acceptance, retain OS/architecture, Steam version/mode, exact
application/CLI hashes, package/source identity, selected durable library ID,
port/runtime/install/request identities, action/result, focus/return observation
and cleanup. Exercise application and selected-game entries separately on Windows
and ordinary Linux; include normal exit, crash, Stop, prepared offline launch,
relocation, update/rollback, storage and recovery outcomes. Preserve every failed
or not-run cell and its concrete resume condition on #290. WSL, process simulation
and a controlled shortcut file do not establish an ordinary Linux Steam result.

The [October 29 acceptance table and ordinary-Linux procedure](../qualification/manual-steam-slice6-acceptance-2026-10-29.md)
retain the actual Windows application observations, separate installed-game
preparation, failed/not-run cells and exact remaining interaction requirements.
The Linux procedure is preparation until executed in its own usable Steam
graphical session.
