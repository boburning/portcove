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
