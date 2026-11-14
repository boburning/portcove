# Sonic the Hedgehog v1.2.0 additive settings files (November 14, 2026)

Dated static evidence for [#152](https://github.com/boburning/portcove/issues/152)
and the generic Core transition in
[#5678](https://github.com/boburning/portcove/issues/5678). Catalog support and
Project fields keep their authority. Nothing was installed, executed or played.

## Decision

The owner chose a reviewed, generic Core transition (option 3 of the
November 14 mstan Genesis and PS1 forward review) on November 14, 2026.
A partitioned data policy may move to a successor that only appends shared
conventional files. Core derives the predecessor from the contract itself;
no catalog field names it. The rule and its refusals are owned by
[CATALOG](../CATALOG.md#adding-or-changing-a-port).

`sonic-the-hedgehog-recomp` now appends `sonic1-sound.ini`,
`sonic1-bug-fixes.ini` and `sonic1-easy-access.ini` to both its persistent and
shared paths. Every existing path, the contract ID and progress paths are
unchanged, so existing installations keep their namespace. On their next update
each file the active runtime already wrote becomes its initial canonical
content. The v1.2.0 applicability row is appended after the existing rows with
one new `upstream_support` record.

## Artifact and tag evidence

Each artifact was downloaded with `python3 -I` urllib into its own new, empty
directory, hashed from the bytes and deleted. No archive was opened or run.
Tag commits came from `git ls-remote`.

| Artifact                                        | Bytes     | SHA-256                                                            |
| ----------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `SonicTheHedgehogRecomp-windows-x64-v1.2.0.zip` | 5,562,704 | `fa01c42f2e04251e8fbce5c4bd2ec7ff75c2c8b8f3e01df1cf265b08c6c6c3c2` |
| v0.8.3 download URL today                       | 5,324,030 | `df79626eb3dbb35228ba22dfbb1dbaf7ce314e18bc5db8809a1c74cf12291c54` |

No publisher checksum file was found for v1.2.0 and the provider release digest
was not read, so its digest is computed only.

- v1.2.0 resolves to commit `e82c95baa1ea8c53750fa9864f48dd45dc668b51`
  (annotated tag object `ff93b011…`).
- mstan moved older tags: v0.7.3 now resolves to `3f03256a…` (catalog evidence
  records `510679e6…`) and v0.8.3 to `e0e9a78c…` (catalog records `5cfa5f92…`).
- The v0.8.3 download URL now serves different bytes (`df79626e…`) from the
  bound `54c73309…`. The existing row keeps its bound digest, so the new bytes
  are not admitted under it. Evidence binds commits and digests, not tag names.

From that review's static reading of the tagged source: v1.2.0 adds three
default-off settings writers beside `settings.ini`, all through the engine's
atomic store: `sonic1-sound.ini` (Clone Driver choice), `sonic1-bug-fixes.ini`
(debug-transporter escape) and `sonic1-easy-access.ini` (level select and debug
shortcuts). Package changes are notices, release notes,
`tools/replay_diagnostic.py` and removed `licenses/`; the replay writer stays
under the declared `logs`. Packaged `build-info.json` names game `0e6805c3…`,
engine `7c067f95…` and UI `ff71584e…`. Because the route's
`integration-contract-v1` release policy already admitted v1.2.0, installations
can already be on it with these files undeclared in the runtime folder; the
successor transition adopts them.

## Not observed

- Any launch, first-run file creation, actual write location or settings
  migration.
- An update, rollback or backup of a real installation under the new
  definition. The Core transition is covered by unit tests and a Windows-only
  service test, not by a native acceptance run.
- Provider release digests, asset IDs and draft or prerelease flags.
- Intermediate releases between v0.8.3 and v1.2.0.
