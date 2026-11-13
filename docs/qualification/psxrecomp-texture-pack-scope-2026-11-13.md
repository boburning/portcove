# Managed PS1 texture-pack folder with a retained installation scope

Dated evidence from November 13, 2026, under #2926, #1585 and #1594. It
declares the `mods/texture-packs` folder that PSXRecomp `7192402` creates for
player texture replacements and dumps. It adds the Core rule that lets existing
installations keep working while newer definitions declare it. The framework
review and kit checks are in the
[builder downloads record](psxrecomp-7192402-builder-downloads-2026-11-13.md).
No upstream program was executed.

## The folder

At every start the `7192402` runtime creates
`mods/texture-packs/<game id>/{replacements,dumps}` beside the player
(`mod_runtime.cpp:1755-1793`). Files appear there only when the player adds HD
texture replacements, or turns on HD Textures and its Dump option
(`gpu_hd_textures.cpp:295`). Both settings are off by default. The v0.1.1 kits
of the 21 split-mods routes ship only empty `mods/texture-packs/<serial>`
folders.

The path joins the split mod paths for the `split-mods` and
`split-mods-openbios` authoring forms. It is also added to the explicit
Armored Core: Master of Arena, Fear Effect 2: Retro Helix and MediEvil
integrations. MediEvil's newest kit pins `031868cc`, whose runtime is
byte-identical to `7192402`.

## Existing installations

A PS1 definition does not depend on the kit version, so a new path in the
current catalog applies to every existing installation. Each managed PS1
installation keeps a data-restore receipt for the persistent scope it was
created with. Core refused collection, activation and backup whenever the
current scope differed from that scope (`persistence_contract_for_install`).
Independent review blocked the first attempt at this change because of this.

Core now keeps a managed PS1 installation's retained scope when the newer
definition only adds `mods/texture-packs`, the persistent patterns are
unchanged, and no retained path overlaps it. The rule applies where Core
derives an installation's checked definition (`installed_mutability`), so
verification, collection, activation, backup and restore all see the retained
scope, and the receipt stays the single scope authority.

- **Older copies:** texture files in an existing copy stay there unmanaged,
  exactly as before the folder was declared. Verification reports them, and
  they are not collected, carried to another version or backed up.
  - **The first version:** it held every data operation when such files
    existed. That included Play for players already using texture packs,
    which a second independent review rejected as a regression.
  - **Removal:** removing such a copy removes those files, as it did before.
- **New installations:** installations created under the wider definition
  retain it and carry texture data through update, rollback and backup.
- **Other added paths:** these still get the existing refusal.

Delivered definitions that declare the folder need managed PS1 capability 3,
which this engine advertises. An older reader therefore refuses the entry
instead of treating existing installations as a changed scope.

## Player copy

The two multi-disc titles now say: to change discs, use the game's own disc
change if it offers one, or quit and choose Play with the next disc. The
in-game disc change was found by static review only.

## Validation

- **Scope rule:** host-portable Core tests, run on Linux, cover these cases.
  Without the rule, the first test fails with the original refusal.
  - an existing copy with the folder absent, then holding only empty folders,
    then holding a file that stays in place, outside backups and reported by
    verification;
  - another added path, and the folder added to a whole-`mods` scope, still
    refused;
  - a version created under the wider definition carrying texture data
    through activation and backup;
  - rollback to the older copy keeping canonical texture data and the older
    copy's own files.
- **Windows lifecycle test:** the split-mods test now also carries texture-pack
  data through activation, backup and rollback. It runs in hosted CI.
- **Delivery gate:** the definition capability and entry tests cover the
  PS1 capability 3 gate.
- **Catalog:** the catalog generator check, the authoring tests and the
  release-selection corpus pass.

## Not observed

Nothing was built or run, and no texture pack was used. No update, rollback
or backup with real player data was observed.
