# Application updates

Portcove uses Tauri's standard updater plugin. Each channel has a static
`latest.json` feed that describes its available update. The plugin replaced the
earlier custom TUF client. No published version used that client, so existing
installations need no migration.
See the [owner's decision on #534](https://github.com/boburning/portcove/issues/534#issuecomment-6864263340).

## Owners and independent trust claims

The Tauri host stores the channel preference. It checks for updates, verifies
downloads, protects saves, and replaces the application. Core owns library
schemas, game sessions, mutation locks, and game data. React displays typed host
results and forwards the player's explicit choices. The host supplies URLs,
keys, and paths. Catalog keys authorize only catalog data. Portcove uses
separate update paths for the application, catalog, and games.

Trust rests on two build inputs in
[`tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json):

- `plugins.updater.pubkey`: the base64 encoding of the minisign public key file
  for key ID `F92BD3EA87BB77B0`. The plugin verifies every downloaded package
  against it before returning any bytes to install.
- The fixed channel feed URLs in
  [`application_update.rs`](../apps/desktop/src-tauri/src/application_update.rs).
  The host chooses the URL for the saved channel. The feeds use HTTPS. The JSON
  is unsigned. The plugin checks the package signature for integrity.

GitHub stores the private key as a secret in the `release` and `release-stable`
environments. The owner keeps an offline backup. The repository and ordinary
build inputs contain no private key. The base configuration keeps
`bundle.createUpdaterArtifacts` off, so ordinary and rehearsal bundles need no key.
The `app-release.yml` workflow turns it on with `--config` and signs with
`TAURI_SIGNING_PRIVATE_KEY`. [Releasing](RELEASING.md) owns publication.

## Channels and feeds

| Channel          | Feed                                                               |
| ---------------- | ------------------------------------------------------------------ |
| Beta (default)   | `https://boburning.github.io/portcove/updates/beta/latest.json`    |
| Preview (opt-in) | `https://boburning.github.io/portcove/updates/preview/latest.json` |

Preview gets new versions before Beta. There is no Stable channel before 1.0.
Until the first Beta release, the Beta feed serves the current Preview version
([interim Beta alias](RELEASING.md#interim-beta-alias)).
Each feed is the plugin's static JSON format (`version`, `notes`, `pub_date` and
per-platform `url` and `signature`). Linux is published as the AppImage under
`linux-x86_64`. The plugin installs only a version newer than the running one, the
signature must name that version (see [Signed version](#signed-version)), and the
release workflow keeps each feed's version monotonic.

The preference file `application-update-preferences.json` sits beside host
preferences (`PORTCOVE_APPLICATION_UPDATE_PREFERENCES` overrides its path for
isolated runs). It holds only the channel and the automatic-check switch. A
missing or damaged file means Beta with automatic checks on; it grants no
authority. Changing the channel discards an update found on the other channel.

## Checks and installs

If automatic checks are on, a release build checks shortly after startup and
every six hours after that. Development builds never check automatically.
To check manually, choose **Check for updates**. If the app finds an update, it
shows the version, date, and notes in a global notice and in Settings. To
download and install it, choose **Download and restart**.

The updater downloads the package. The plugin verifies its signature before it
installs the package. On Windows, the plugin starts the per-user NSIS installer
in passive mode and exits Portcove. The installer reopens Portcove. On Linux
(AppImage) and macOS (ad-hoc signed `.app` bundle), the plugin replaces the
installation. Portcove then restarts.

## Save protection

An update must not interrupt work on the player's library. Before downloading,
the host runs Core's idle check so a busy library does not waste a download.
After the download is verified, `application_update_admission`:

1. takes the desktop's library-selection mutex, so the library cannot be switched
   or moved;
2. blocks new backend workers in this process, game launches included, and
   refuses if any are running;
3. refuses an unfinished library handoff or startup and repeats Core's
   `Library::require_application_update_idle`, which refuses while a game launch
   is unrecovered, any durable activity (install, backup, restore and so on) is
   still running, the library needs migration, or it has relocated;
4. swaps its open library for a placeholder, releasing its own shared library
   lease, and releases its shared application runtime lease; and
5. acquires Core's `ApplicationUpdateExclusivityGuard` (no other Portcove window,
   CLI or launch supervisor process) and `ApplicationUpdateQuiescenceGuard`
   (the exclusive library lease, with the idle check repeated under it).

These guards are held across the plugin's install call. If any step or the
install fails, nothing is replaced: the guards are dropped, the shared runtime
lease is reacquired and the same library is reopened. Each refusal names its
cause to the player: work still running, another Portcove process or game using
the library, a library that moved, or one that must finish an upgrade first.

On Windows the plugin flushes diagnostics, starts the installer and exits the
process while the guards are held. On Linux and macOS the worker block stays
committed and the library stays closed, and only the exclusive leases are
released immediately before the restart so the new build can start.

Package-managed `.deb` and `.rpm` installations never check for or install
updates; they tell the player to use their package manager. The hidden
`--portcove-update-eligibility` mode reports this without a window.

## Timeouts

A check is abandoned after 60 seconds. Each updater request, including the
package download, is bounded to 30 minutes, and a download that receives no bytes
for 60 seconds is abandoned. Either failure clears the in-progress state so the
player can try again.

## Signed version

`plugins.updater.requireSignedVersion` is on: the package signature's trusted
comment must name the version the feed announces, so a tampered feed cannot pair
a newer version number with an older, validly signed package. The Tauri CLI used
for releases records that version, and this key has no older signatures.
