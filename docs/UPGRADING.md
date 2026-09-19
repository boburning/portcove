# Upgrading and recovering Portcove

Portcove Alpha 2 opens and migrates an Alpha 1 library in place. The migration
retains registered source references, installed and staged application versions,
active and previous pointers, update settings, saves, configuration, backups,
launch history, and recovery records. New Alpha 2 fields begin empty. Migration
does not relocate content, choose output folders, reclassify old source records,
or replace their stored identity baselines.

## Alpha 1 to Alpha 2

1. Close Portcove and any game started from it.
2. Copy the complete Alpha 1 library directory to a safe location. Keep that
   copy unchanged until Alpha 2 has passed the checks that matter to you.
3. Install or unpack Alpha 2, then open the existing library. For the CLI, pass
   the same directory with `--library <path>`.
4. Confirm the expected installed games, source registrations, save/configuration
   files, backup listings, and active/previous versions before removing the copy.

The database migration is forward-only and transactional. A failure leaves the
recorded schema at the last complete migration so a corrected Alpha 2 build can
retry. Alpha 2 rejects a corrupt, partly recorded, or future database rather than
guessing at its state.

Library metadata format 1 from Alpha 1 remains importable. Metadata contains
references and lifecycle state; it never contains the game or source bytes. A
source that moved must be relinked separately. Relink preview inspects the new
path without changing the registration, and apply succeeds only when the
current registered baseline and the reviewed replacement identity still match.

## Four different recovery operations

**Game release rollback** switches one installed game to its retained previous
application version. Portcove keeps that game's persistent data separate and
synchronizes it before changing the active pointer.

**Save restore** restores a selected persistent-data backup. Portcove verifies
the snapshot and creates a safety backup of current data before replacing it.

**Portcove application replacement** installs or unpacks a different Portcove
binary. Replacing the application does not reverse a library database migration.
Do not run Alpha 1 against a library already migrated by Alpha 2.

**Whole-library or database recovery** returns to the complete pre-upgrade copy.
First preserve the current post-upgrade library under another name so newer
saves and activity are not silently lost. Restore the unchanged Alpha 1 copy to
a separate path and run the matching Alpha 1 application with that path. Do not
merge the two databases or copy an older database over a newer library tree.

This complete-copy route is the supported Alpha preview downgrade path. It is
also the safe route when database recovery is necessary: preserve both states,
select one internally consistent library, and retain the other until its newer
user data has been reviewed. Application package rollback alone is not database
recovery.

## Linux package ownership

Portcove updates a Linux application in place only when it is running from its
qualified, user-owned AppImage. A DEB or RPM installation remains owned by the
package manager and package source that installed it. When exactly one of those
package databases owns the running Portcove executable, **Settings > Application
updates** identifies the package format and directs you back to that same package
source. Portcove does not overwrite the managed executable or silently convert the
installation to an AppImage.

The same ownership check is available without starting the GUI:

```text
portcove-desktop --application-update-recovery eligibility
```

It reports AppImage eligibility or the detected DEB/RPM owner and never starts an
update check, download, installation, restart, or native prompt.

If neither package database owns the executable, or ownership is ambiguous,
Portcove keeps the installation unchanged and shows the general supported-package
or manual-recovery guidance. Installations copied or unpacked by hand remain under
their existing manual owner.

### Rootless AppImage lifecycle

For a rootless Portcove installation, keep the maintained AppImage as one direct
file at a stable absolute path owned by the current user. Do not place that file
behind a `current` symlink, a version-directory pointer, or a package-manager
path: the built-in updater deliberately refuses linked paths and installations
owned by another authority. The containing directory must remain writable for
the atomic replacement and its immediately previous verified backup.

A manually created desktop entry should use that exact stable AppImage path for
both `Exec` and `TryExec`. Routine AppImage replacement keeps the path unchanged,
so the entry does not need to be rewritten for each version. Moving the AppImage
later is a manual ownership change: update the desktop entry and recheck
eligibility from the new direct path before accepting another update.

To uninstall this rootless form, first close Portcove and every game it started,
then remove only the stable AppImage and the desktop entry created for it. Keep
the Portcove library and its game files, saves, backups and logs unless you are
making a separate explicit data-removal decision. Removing a DEB or RPM continues
to use its package manager instead; these instructions never convert or uninstall
a package-manager-owned installation.

## Application updater recovery without the GUI

If Portcove cannot open far enough to show **Settings > Application updates**,
close every Portcove window and run the installed desktop executable from a
terminal:

```text
portcove-desktop --application-update-recovery status
```

The command locally inspects update preferences, automatic check history,
staged-download state, the pending exit or restart request, and an interrupted
Linux AppImage replacement. The command does not contact a release server,
acquire a new payload, install anything, restart Portcove, or open a native
prompt. Exit code 0 means these coordination stores are healthy. Exit code 1
means the output lists a fixed recovery, reports that a requested recovery is
no longer needed, or could not inspect the state. Exit code 2 means the command
was malformed.

Run only a repair named by the status output:

```text
portcove-desktop --application-update-recovery repair preferences
portcove-desktop --application-update-recovery repair schedule
portcove-desktop --application-update-recovery repair staging
portcove-desktop --application-update-recovery repair apply
```

Each repair runs only while its selected store is still malformed or uses a
newer unsupported schema. If another process already repaired it, the command
leaves the healthy state unchanged. `preferences` clears saved application
update consent and requires a new choice. `schedule` clears only automatic-check
timing and retry history. `staging` removes the damaged staged payload and
requires a fresh authenticated download. `apply` clears only the damaged exit
or restart request and keeps an independently healthy staged payload. None of
these commands repairs or rolls back a Portcove library.

On Linux, status may instead report an AppImage replacement awaiting recovery
or startup reconciliation. With every Portcove process closed, run exactly the
fixed command it prints:

```text
portcove-desktop --application-update-recovery recover interrupted-appimage
```

The command first takes the shared application runtime lease. It then applies
the same exact predecessor, staged-candidate, stable-path, swap-path, hash and
byte-prefix checks as desktop startup. Only a verified pre-activation
interruption becomes retryable. Unknown bytes or paths remain unchanged. If the
candidate already occupies the stable path, start Portcove normally so its
healthy-startup boundary can recheck the candidate and exact predecessor backup,
then retire the backup, staged payload, and apply request. Portcove does not
automatically start another process after an ambiguous post-activation interruption.

After **Restart to update**, Windows or macOS may own the visible installer,
UAC, SmartScreen, or Gatekeeper prompt. Portcove cannot move focus into that
prompt, dismiss it, or determine that silence means approval. A quiet or
unattended update mode cannot bypass those controls. Complete or decline the OS
prompt directly, then reopen Portcove so it can reconcile the installed version
before offering another update action.
