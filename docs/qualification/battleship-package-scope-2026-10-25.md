# BattleShip package scope — October 25, 2026

Partial delivery for [#2510](https://github.com/boburning/portcove/issues/2510)
and [#2926](https://github.com/boburning/portcove/issues/2926); canonical port
[#110](https://github.com/boburning/portcove/issues/110) retains its completed
Windows qualification. Base source: `dc2e4a0606e73eb6480682ab0eca751122de7e12`.
This dated assessment does not create another backlog or close full beta acceptance.

The complete 33-record upstream release traversal observed on October 25 selects
[v1.6](https://github.com/JRickey/BattleShip/releases/tag/v1.6), release ID
368973572, published August 12, 2026. Its complete nine-asset inventory is retained
as a metadata fixture, including exact names, IDs, publisher digests and sizes.
The offered USA Windows ZIP and Linux AppImage remain valid selector inputs.
macOS Apple Silicon is distributed only as `BattleShip.dmg`; the JP DMG is a
different source variant. Core's managed selector/extraction does not support DMG.
A declared managed macOS route therefore previously ended in no-supported-asset.

The correction limits **fresh managed installation** to Windows/Linux and gives
macOS a concrete upstream application-bundle handoff in the existing setup guide.
It preserves identity, artwork, source profile, channel, provider and every
Windows/Linux executable and data contract. No installed definition, existing
registration, runtime or player data is rewritten. Retained-definition readers and
recovery behavior keep their original interpretation; catalog changes are not a
migration or ownership grant. An existing historical macOS contract does not gain
a working managed replacement through this metadata correction.

The reviewed upstream [`package-macos.sh`](https://github.com/JRickey/BattleShip/blob/78069c1fdac54351612ccf1c99778b51f2db1256/scripts/package-macos.sh)
creates `BattleShip.app/Contents/MacOS/BattleShip`, its Torch companion, resources
and libraries. `NON_PORTABLE` places saves, configuration and extracted assets in
`~/Library/Application Support/BattleShip/`, outside the bundle. Players mount
and copy the complete DMG application themselves, select the existing executable,
review launch details and explicitly choose Play for the upstream original-file
wizard. Upstream owns setup and runtime updates. External app data and originals
require separate preservation; external registration grants no managed update,
backup or rollback. No discovered helper executes during registration.

A focused production-selector regression reads the actual release metadata and
requires a supported package for **every currently offered managed platform**.
It fails on the previous macOS claim before offering an unusable managed route,
keeps USA/JP discrimination, and records that DMG itself remains unsupported.
Existing package/variant, retained-contract and external-registration coverage
continues to apply. Existing Windows automated/manual arrays are unchanged;
Linux/macOS hands-on evidence is not inferred from Windows.

This assessment acquired no game package, original, installer or helper and ran
no upstream executable or native game. Metadata/source inspection, catalog
preparation, fixtures, hosted checks, native operation and real-save acceptance
remain distinct. Final exact-head checks, independent review and merge evidence
belong to the linked canonical delivery records.
