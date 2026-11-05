# Marathon wrapper derivation — November 5, 2026

Revalidation used main `5d9310dba5e7f20cd8a0d1de5067fbc0a1a77a4d`.
This is F2 of the maintenance assignment, under existing owner #3943; completed
port integrations #2588/#2589/#2591 and their October 28 evidence remain intact.

The three NativePortable integrations no longer author `runtime_subdirectory`.
The existing resolver requires the exact declared per-game player name, refuses
multiple matches and derives its containing directory. The exact selected
relative executable and creating definition are retained in the installation’s
authenticated manifest. Existing installed definitions keep their historical
explicit wrapper; they are not migrated to today’s rule.

| Real official Windows package                                                                             | Size     | Publisher and downloaded SHA-256                                   | Resolved player                          |
| --------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ | ---------------------------------------- |
| [Marathon-20250829-Win.zip](https://github.com/Aleph-One-Marathon/alephone/releases/tag/release-20250829) | 33310497 | `bc59e4058f0a56e2ba6e67a00bbc2ed7d53d392ed8a3b9706c2e2940b7612798` | `Marathon-20250829/Classic Marathon.exe` |
| [Marathon-20260930-Win.zip](https://github.com/Aleph-One-Marathon/alephone/releases/tag/release-20260930) | 33591851 | `7955753d1ee198b67a53ed598a98713a1cbfbee8b05aa673af99d924b3ee6dc7` | `Marathon-20260930/Classic Marathon.exe` |

Both actual ZIPs contain 184 members, one top-level dated wrapper, one exact
player, and the complete adjacent scenario (`Map.scen`, `Marathon.appl`,
`Physics.phys`, `Shapes.shps`, `Sounds.sndz`). Authentication remains the accepted
exact full-package digest, not the directory spelling or a calculated hash alone.
The shared archive extractor retains its existing path, link, containment and
resource checks. The selected player and complete immutable manifest retain
executable and data identity; wrapper derivation grants no new package authority.

Focused inert regression cases independently declare the two observed wrapper
coordinates, verify each retained selected path and actual adapter working root,
refuse a missing exact player, ambiguous duplicate players and redirected player
directory, detect altered immutable scenario data, and retain the old authored
root despite the current definition’s change. Existing packaged-file path-limit
controls retain literal historical Infinity coordinates as independent oracles.

## Remaining explicit boundaries

This removes one per-release authored wrapper edit for each of three production
integrations. It does not eliminate their exact artifact pins or claim automatic
cross-version compatibility. Full-game and engine-only package names both satisfy
the current positive literal provider hints; choosing one arbitrarily would lose
scenario data. No duplicate scraper or publisher is introduced to work around it.

Shared profile ownership is a separate issue. The October 28 native receipt
observed initially absent profiles and normal startup/restart, not a populated
cross-version save/film/configuration transition. The official 20250829 release
also explicitly describes a network/film compatibility boundary with its
predecessor. File-layout equivalence does not prove these protocols compatible.
Resume compatible automatic replacement only with an unambiguous full-scenario
provider selector plus bounded evidence/disposition for the actual affected
shared profiles. The runtime remains separately owned, and Core still neither
adopts nor restores external Documents/LocalAppData AlephOne profiles.

OpenPete’s accepted runtime, exact source, cards and states remain unchanged.
Its canonical #113 owns missing version/artifact/source/runtime/data compatibility
facts. A wrapper resolver cannot qualify those facts.

No game execution, populated-profile access, native Windows observation,
gameplay, signing or protected publication is claimed here. Existing Native4
capability/path-limit and old-reader behavior are unchanged. Main files and
ordinary hosted delivery evidence belong to the linked PR.
