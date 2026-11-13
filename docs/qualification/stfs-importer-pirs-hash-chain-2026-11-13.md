# STFS importer: PIRS, hash tree and content identity — November 13, 2026

This record covers scope items 1 and 2 of
[#5360](https://github.com/boburning/portcove/issues/5360), as the owner decided on
November 13, 2026. It extends the existing read-only importer behind `stfs-directory`
(#1408, #2640) rather than adding another importer. The contract is in
[STFS package extraction](../CATALOG.md#stfs-package-extraction).

## What changed

| Area         | Result                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers   | `LIVE` and `PIRS` in the single-table layout are read. `CON`, two-table packages and SVOD are refused, each with its own reason. A later container adds one arm to the reader's package-type or hash-layout enum.                                                             |
| Header       | Magic, content type, title ID, media ID, version and base version are parsed and returned with every validation.                                                                                                                                                              |
| Hash tree    | Header SHA-1 (`0x344` to the first hash table), top hash, level-2 and level-1 tables, each level-0 table when it is read, and every data block read are checked. Mismatches refuse a content identity or a bound port; for an exact whole-package digest they are advisories. |
| Contiguous   | The entry flag selects sequential blocks. A recorded next pointer must then name the following block or be empty.                                                                                                                                                             |
| Binding      | Optional `runtime_stfs_package {content_types, title_ids, max_package_bytes}`, compared before reuse or extraction. Only content type `000D0000` is accepted. Requires staged-source capability 32, which Core now advertises.                                                |
| Identity     | A new `stfs-content` source representation: package types, title IDs, content types and member SHA-256 digests over a verified package. The whole-package `compound`/`stfs-live` identity is unchanged and remains NocturneRecomp's only identity.                            |
| Failure copy | `stfs_format_unsupported` now names LIVE or PIRS; a wrong game or content type reports `stfs_package_mismatch`.                                                                                                                                                               |
| Catalog      | No shipped port declares a binding or content identity. NocturneRecomp's definition, capability requirement and compatibility projection are unchanged.                                                                                                                       |

## Evidence

- **Format facts.** These come from public documentation read as text: the Free60 STFS
  page, Xenia's `stfs_xbox.h` and `stfs_container_device.cc` (BSD), and darkuni's MIT
  `tools/stfs_extract.py` at `poker-smash-recomp@0465fac`. No upstream code was run.
  Velocity (GPL-3) and the Fable II Pub Games PowerShell extractor were not used.
- **Synthetic fixtures.** The tests build LIVE and PIRS packages in memory with real
  SHA-1 trees at level 0, level 1 and, in a sparse 119 MB package, level 2. The
  fixture lays out blocks from darkuni's and Xenia's published formulas, independently
  of the reader's own arithmetic. The packages are chained, contiguous with next
  pointers and contiguous without them.
- **Hostile cases.** The tests change a byte at each hash level, the header and the
  top hash. They also cover out-of-range and cyclic chains, parent cycles, `..` and
  reserved names, case-duplicate names, oversized and under-allocated entries,
  truncation, and `CON`, two-table and SVOD packages. A wrong title, a title update and
  an oversized package are refused before any write.
- **Mutation tests.** Seeded proptest campaigns (192 cases each) run random bytes
  under four magics and byte edits and truncation of valid LIVE and PIRS seeds. Every
  case stays inside staging. No accepted mutation changes a byte the package reads.
- **Identity.** Two synthetic copies that differ only in their licence entries are both
  admitted by one content identity. A wrong package type, title, content type or
  member digest is a known mismatch. Damaged and foreign files fail closed. The
  existing whole-package identity still admits its package beside a content identity.

These are fixture observations. No game package, installed copy or physical Xbox 360
content was read.

## Open

- **UNKNOWN: real packages.** It is not yet confirmed that the owner's NocturneRecomp
  package passes the new header-hash and hash-tree checks. The checks follow Free60's
  description of the header hash range and the published block formulas. A follow-up
  change on the same day removes the risk to the stable route: a package admitted by its
  exact whole-package digest is no longer refused on a hash mismatch. The mismatch is
  reported as an inspection advisory and an extraction warning, while header parsing
  and every structural bound stay enforced. Synthetic tests show such a package with a
  wrong level-0 hash is admitted with its advisory, and the same package is refused
  under a content identity. Content identities and ports with `runtime_stfs_package`
  still require the full tree. Checking the owner's package remains useful evidence
  that the advisory path is unused.
- **Scope 3 and 4 remain on #5360.** These are the EXIT 2 managed route and the
  follow-up issue for title-update application.
