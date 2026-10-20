# Managed RaceWave46 data and sign-in

The Windows v1.0.0 route installs the unchanged official package and stages a
checked original as `game.z64`. Fixed launch arguments select that private copy.
Existing external registrations remain non-owning and are not adopted.

Core retains the exact artifact-bound runtime-data policy with the installation.
Capability 14 is required; delivered Render96 capability13 does not implement this
credential boundary. Historical qualification retains its original engine identity.
Removing the policy from the same managed artifact is
invalid; older engine capabilities cannot silently ignore it.
Acquisition, manifest publication and retained-manifest reads also check the
actual installed artifact, version and platform. Copying an arbitrary executable
folder cannot acquire this policy: adoption is refused for this managed route.

## Saves, settings and RetroAchievements

Ordinary `.runtime` saves and settings are mirrored to canonical managed data.
RetroAchievements sign-in stays with each installed version. Core never decrypts,
opens, hashes or copies `retroachievements.credentials` or its exact numeric
`.tmp-<pid>-<tick>-<sequence>` siblings. These files are omitted only by the closed
retained-policy runtime mirror. Restoring ordinary data preserves destination-only
sign-in files. Another installed version requires a new sign-in; returning to an
older retained version leaves its sign-in in place. Uninstalling a version deletes
its local sign-in together with that version.

Generic backup, adoption, library transfer, relocation and recovery readers refuse
these reserved names before reading payloads. They do not silently filter a
whole-library copy. This conservative refusal applies even to an unrelated file
with the reserved name, or a directory or link bearing it. Canonical data and
backup contamination also refuse. No catalog change authorizes copying a secret.

## Manual transfer recovery

1. Stop the game and review the exact path shown by the refusal.
2. Open that installed version, sign out of RetroAchievements, and close it.
   Sign-out may leave numeric temporary credential files behind.
3. If the version cannot run, privately preserve the listed credential file on
   this Windows host, outside every Portcove installation, canonical-data,
   backup, staging and recovery tree. Then remove it from the listed transfer or recovery tree.
   Treat leftover temporary credential files the same way. Do not upload them or
   put their bytes in diagnostics, screenshots or an issue.
4. Review and retry the operation. A previous review does not authorize a changed
   tree. If a partial copy was retained, follow its recovery notice too.
5. Sign in again in the destination version. Do not restore old credential files
   into canonical data or a backup.

This is a manual preservation path, not portable credential support. The files
use Windows-host protection; preserving them does not prove they can be restored
under another account or machine. Core does not test a real account as part of
qualification. Synthetic credential probes establish omission/refusal behavior
without containing a player's credentials.

## Upstream scope

This route acquires the exact official public Windows artifact from its upstream
URL. Keep the complete package and its notices. It grants no authority to mirror,
repackage, sublicense or describe all included frontend contributions as GPL.
Historical source notices retain their unresolved contribution caveat. Broader
redistribution requires a suitable grant or replacement artifact.
