# STFS importer: PIRS, hash tree and content identity — November 13, 2026

This record covers scope items 1 and 2 of
[#5360](https://github.com/boburning/portcove/issues/5360), as the owner decided on
November 13, 2026. It extends the existing read-only importer behind `stfs-directory`
(#1408, #2640) rather than adding another importer. The contract is in
[STFS package extraction](../CATALOG.md#stfs-package-extraction).

## What changed

| Area         | Result                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers   | `LIVE` and `PIRS` in the single-table layout are read. `CON`, two-table packages and SVOD are refused, each with its own reason. A later container adds one arm to the reader's package-type or hash-layout enum.                                  |
| Header       | Magic, content type, title ID, media ID, version and base version are parsed and returned with every validation.                                                                                                                                   |
| Hash tree    | Header SHA-1 (`0x344` to the first hash table), top hash, level-2 and level-1 tables, each level-0 table when it is read, and every data block read are checked. The policy below decides whether a finding refuses.                               |
| Contiguous   | The entry flag selects sequential blocks. A recorded next pointer must name the following block or be empty; otherwise an enforced read refuses and an advisory read follows the recorded chain.                                                   |
| Binding      | Optional `runtime_stfs_package {content_types, title_ids, max_package_bytes}`, compared before reuse or extraction. Only content type `000D0000` is accepted. Requires staged-source capability 32, which Core now advertises.                     |
| Identity     | A new `stfs-content` source representation: package types, title IDs, content types and member SHA-256 digests over a verified package. The whole-package `compound`/`stfs-live` identity is unchanged and remains NocturneRecomp's only identity. |
| Failure copy | `stfs_format_unsupported` now names LIVE or PIRS; a wrong game or content type reports `stfs_package_mismatch`.                                                                                                                                    |
| Catalog      | No shipped port declares a binding or content identity. NocturneRecomp's definition, capability requirement and compatibility projection are unchanged.                                                                                            |

## Policy

The reader has two policies. Inspection always reads once in the advisory mode and
then applies the profile's policy; extraction selects it from the port's binding.

- **Enforced** applies to a content identity and to any profile or port with
  `runtime_stfs_package`. Inspection is enforced for every profile a catalog port binds,
  so the refusal happens at registration. Every check below refuses.
- **Advisory** applies to an `stfs-directory` port without a binding. Catalog validation
  requires that port's source profile to carry an exact whole-package SHA-256, which
  registration verified. The reader accepts every package the earlier reader accepted.

| Check                                                                                                                                                                                                                                | Enforced | Advisory                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------- |
| Container kind and layout, table and block counts, data base at least `0x400` and inside the file, block range, block and parent cycles, traversal, reserved and duplicate names, entry and depth limits, expanded bytes, free space | Refuses  | Refuses                           |
| Header SHA-1, top hash, level-2/1/0 tables, data blocks, truncated hash tables                                                                                                                                                       | Refuses  | Advisory                          |
| Contiguous file disagreeing with its recorded chain                                                                                                                                                                                  | Refuses  | Advisory; recorded chain followed |
| 16 GiB package cap, descriptor length `0x24`, header at least `0x3AD` bytes, at most three hash levels, block count fitting in the file                                                                                              | Refuses  | Advisory                          |

Without a bounded block count, an advisory read does not check the hash tree at all and
reads next pointers unverified, as the earlier reader did. When a package matches both a
profile's exact identity and its content identity, the exact identity is admitted
rather than the two being reported as ambiguous.

## Evidence

- **Format facts.** These come from public documentation read as text: the Free60 STFS
  page, Xenia's `stfs_xbox.h` and `stfs_container_device.cc` (BSD), and darkuni's MIT
  `tools/stfs_extract.py` at `poker-smash-recomp@0465fac`. No upstream code was run.
  Velocity (GPL-3) and the Fable II Pub Games PowerShell extractor were not used.
- **Synthetic fixtures.** The tests build LIVE and PIRS packages in memory with real
  SHA-1 trees at level 0, level 1 and, in a sparse 119 MB package, level 2. The
  fixture lays out blocks from darkuni's and Xenia's published formulas, independently
  of the reader's own arithmetic. The packages are chained, contiguous with next
  pointers and contiguous without them, with the LIVE/PIRS `0x971A` header (data base
  `0xA000`) and the larger `0xAD0E` header (data base `0xB000`).
- **Hostile cases.** The tests change a byte at each hash level, the header and the
  top hash. They also cover out-of-range and cyclic chains, parent cycles, `..` and
  reserved names, case-duplicate names, oversized and under-allocated entries,
  truncation, and `CON`, two-table and SVOD packages. A wrong title, a title update and
  an oversized package are refused before any write.
- **Mutation tests.** Seeded proptest campaigns (192 cases each) run random bytes
  under four magics and byte edits and truncation of valid LIVE and PIRS seeds. Every
  case stays inside staging. No accepted mutation changes a byte the package reads.
- **Policies.** For each relaxed check, an exact-digest package that breaks it is
  admitted with an advisory and refused under the enforced policy and under a port
  binding at inspection. This includes a wrong level-0 hash. The same package is refused
  under a content identity.
- **Identity.** Two synthetic copies that differ only in their licence entries are both
  admitted by one content identity. A wrong package type, title, content type or
  member digest is a known mismatch. Damaged and foreign files fail closed. The
  existing whole-package identity still admits its package beside a content identity,
  including when the content identity also matches.

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
