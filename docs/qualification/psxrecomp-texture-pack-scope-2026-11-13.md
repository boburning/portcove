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

Core now keeps a managed PS1 installation's retained scope when all of these
hold:

- the newer definition only adds directory paths;
- each added path overlaps no retained path;
- the persistent patterns are unchanged;
- in that copy, each added path is absent or holds only empty directories with
  exact spelling.

Collection, activation, backup and restore then use the retained scope, so the
receipt stays the single scope authority.

- **Files present:** any file, link or other entry under an added path holds
  these operations as a changed data contract, and the files stay in place.
  That would happen in a copy that already ran a `7192402` kit, then got
  texture files.
- **New installations:** installations created under the wider definition
  retain it and carry texture data through update, rollback and backup.

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
  - an existing copy with the folder absent, then holding only empty folders;
  - the same copy refused once a file is added, with the file kept;
  - an overlapping added path still refused;
  - a version created under the wider definition carrying texture data
    through activation and backup.
- **Windows lifecycle test:** the split-mods test now also carries texture-pack
  data through activation, backup and rollback. It runs in hosted CI.
- **Delivery gate:** the definition capability and entry tests cover the
  PS1 capability 3 gate.
- **Catalog:** the catalog generator check, the authoring tests and the
  release-selection corpus pass.

## Not observed

Nothing was built or run, and no texture pack was used. No update, rollback
or backup with real player data was observed.
