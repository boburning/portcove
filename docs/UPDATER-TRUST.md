# Application updates

Portcove updates itself with Tauri's standard updater plugin and a static
`latest.json` feed per channel. This replaced the earlier custom TUF client
(owner decision on
[#534](https://github.com/boburning/portcove/issues/534#issuecomment-6864263340));
no published build used that client, so there is nothing to migrate.

## Owners and independent trust claims

The Tauri host owns application update trust, the channel preference, checks,
download verification, save protection and replacement. Core owns library
schemas, game sessions, mutation locks and all game data. React presents typed
host results and forwards explicit player actions; it supplies no URL, key or
path. Catalog keys cannot authorize application code, and a game or catalog
update never updates Portcove.

Trust rests on two build inputs in
[`tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json):

- `plugins.updater.pubkey`: the base64 encoding of the minisign public key file
  for key ID `F92BD3EA87BB77B0`. The plugin verifies every downloaded package
  against it before returning any bytes to install.
- The fixed channel feed URLs in
  [`application_update.rs`](../apps/desktop/src-tauri/src/application_update.rs),
  chosen at runtime from the stored channel. The feeds are served over HTTPS and
  are unsigned; the package signature is the integrity check.

The matching private key is held as a secret in the GitHub `release` and
`release-stable` environments, with an offline backup kept by the owner. It never
enters the repository or ordinary builds' inputs. The base configuration keeps
`bundle.createUpdaterArtifacts` off, so ordinary and rehearsal bundles need no key.
The `app-release.yml` workflow turns it on with `--config` and signs with
`TAURI_SIGNING_PRIVATE_KEY`. [Releasing](RELEASING.md) owns publication.

## Channels and feeds

| Channel          | Feed                                                               |
| ---------------- | ------------------------------------------------------------------ |
| Beta (default)   | `https://boburning.github.io/portcove/updates/beta/latest.json`    |
| Preview (opt-in) | `https://boburning.github.io/portcove/updates/preview/latest.json` |

Preview gets new versions before Beta. There is no Stable channel before 1.0.
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

Release builds check shortly after startup and then every six hours while
automatic checks are on; development builds never check automatically. The
player can also choose Check for updates. A found update is announced in a
global notice and in Settings with its version, date and notes. Nothing is
downloaded or installed until the player chooses Download and restart.

Installing first downloads the package and lets the plugin verify its signature.
On Windows the plugin then starts the per-user NSIS installer in passive mode
and exits Portcove; the installer reopens it. On Linux (AppImage) and macOS
(`.app` bundle, ad-hoc signed) the plugin replaces the installation and Portcove
restarts.

## Save protection

An update must not interrupt work on the player's library. Before downloading,
the host runs Core's idle check so a busy library doesn't waste a download.
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
