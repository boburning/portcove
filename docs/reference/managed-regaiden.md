# Managed ReGaiden Windows contract

This route acquires the unchanged official v0.4.1 Windows ZIP after checking the
player's exact Resident Evil Gaiden (USA) original. The package is 33,085,815 bytes,
SHA-256 `d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6`.
The GBC original is 2,097,152 bytes, SHA-256
`9a97678cbd8da02c8763e977674e17f460c06ea8b73bad35c52fe6817f506d44`.
This is user-side acquisition, not redistribution or a blanket license assertion.
Keep all package files and notices. Historical prepared registrations keep their
original non-owning contract; no external folders or saves are adopted.

Core copies the admitted original to `game.gbc`, creates an owned local `saves`
directory in private installation staging, and launches the fixed executable from
the installation root with `--rom game.gbc --save-dir saves`. Only this exact
artifact and closed route support the new `regaiden-gbc` materialization. Older
engines cannot parse it. Definition capability 16 and API77 describe the contract;
Render96 capability13 and RaceWave capability14 cannot authorize shared preferences.
Historical qualification retains its original engine identity;
schema7 installation manifests retain the reviewed account/path binding. Earlier
manifest readers refuse schema7 instead of dropping consent.

## Shared preferences and consent

The game may rewrite the Windows-account roaming file resolved through the OS at
`gbrecompiled/runtime/runtime_prefs.ini`, discard unknown entries and affect other
copies. Portcove does not create, own, move, copy, back up, restore or delete that
file. If it is unavailable, the game can use installation-local
`runtime_prefs.ini`. That fallback, `config.ini`, `imgui.ini`, `saves`, `snapshots`
and the private original copy are managed local data. Backups protect only those
local files, not the account-wide preferences.

The installation review shows both exact paths. Desktop asks for native explicit
acceptance. The reviewed CLI requires `--acknowledge-shared-preferences` alongside
the exact `--expected-plan`; `--yes` alone is insufficient. Playnite asks separately
before adding that flag. Changed inputs invalidate authorization. An old external
registration or accepted external preview cannot authorize managed installation.

The proof binds the account SID digest, shared path and local fallback path, not
mutable file contents or whether a file currently exists. Safe ordinary preference
edits remain possible. Account/path safety is checked before acquisition,
publication, activation, recovery and launch. Printable ASCII and MAX_PATH checks
include generated save-state transaction names. Global state is never initialized
to make a failed check pass.

## Recover from a changed account or folder

If Portcove reports that the Windows account or shared preferences location changed:

1. Close the game and other copies using the shared preferences.
2. Use the game's reviewed **Uninstall** action. Keep the
   displayed saved-data folder and backups. Removal preserves local saved data;
   it does not delete or move the account-wide file.
3. If changing location, choose a safe short installation folder in setup options.
4. Review a fresh installation, read both resolved paths, and explicitly accept
   the current scope. Portcove restores its retained local data into the new copy.

An **unable to check shared preferences** hold is different: Portcove could not
establish safe access or path type. Leave the file unchanged, close other copies,
check that the Windows profile is available, and refresh. Reinstallation does not
repair an unsafe or unreadable account-wide location. Keep the hold and inspect
the actual failure before proposing a repair; do not weaken path safety or change
global data to obtain a passing result.

Do not edit installation manifests, transplant old acceptance, or delete the shared
file to bypass consent. Library transfer and output relocation refuse this route
because moving bytes cannot transfer account/location permission. Use the bounded
reinstall procedure instead. Retain independent copies of any external data; it is
outside this managed contract. Interrupted private work stays under ordinary
recovery safeguards and is not evidence of successful installation or gameplay.

No gameplay, in-game save/load compatibility, installed-package, minimum-system or
other-platform qualification follows from this contract. Exact execution evidence
belongs in a separate dated qualification record.
