# Resident Evil Gaiden: exact Windows prepared-runtime route

Fixed slice 6B, owner #342 under #136, October 19, 2026. This route registers
an existing authenticated runtime in place and starts it with a separately
verified original. Core owns the registration, source and launch checks.
The external runtime, game outputs and account-wide preferences remain user owned.
Repository admission, actual operation acceptance, protected production delivery,
installed Desktop observations and optional gameplay remain separate.

## Frozen selection and original

Upstream is `sergiomanzur/regaiden-recomp`, source
`2b1bd51e09c8599d5436ba56f5ad17bd22550d2e`, release `v0.4.1`
(release 390139712, Windows asset 568476029).
`Resident_Evil_Gaiden_Recomp_v0.4.1_Windows.zip` is 33,085,815 bytes,
SHA256 `d16ba320c75a23765ef1e84c6f70f551612834914c70fd4c542e20ae7ce5dcc6`.
Bounded inspection found 15 regular package files, 77,912,752 expanded bytes,
with a root executable, no enclosing wrapper directory and retained notices;
`hd_pack` and `music_pack` subdirectories remain present. The executable
`Resident_Evil_Gaiden__USA_.exe` is 64,387,584 bytes,
SHA256 `722085905ea114c88a7afcc2b46eee179731d8967c6e629ad643036de83e7b64`;
the included SDL2 file version is 2.30.12.0.

The pinned [primary README](https://github.com/sergiomanzur/regaiden-recomp/blob/2b1bd51e09c8599d5436ba56f5ad17bd22550d2e/README.md)
specifies the exact USA GBC original: 2,097,152 bytes,
SHA256 `9a97678cbd8da02c8763e977674e17f460c06ea8b73bad35c52fe6817f506d44`.
The private working copy matched; a one-byte changed copy was refused as
`source_invalid`, `known_mismatch`, under the exact profile. The original archive
and raw source remained unchanged. No header conversion or hash override applies.
Upstream MIT, clean-room and original-mod-assets descriptions are attributed
claims. Bounded comparison of the authenticated official executable found no complete
raw original and no tested aligned 16 KiB raw-bank matches. Generated `__rom.c`
was absent from the pinned repository. Encoded or smaller data completeness
remains unknown; this does not establish blanket rights clearance or cover
optional replacement assets. The route does not redistribute the original.

## Bounded ownership and consent

The closed `regaiden041-windows` contract accepts only this Windows x64 artifact,
version and executable, root working directory and `--rom <verified .gbc>` followed
by the fixed `--save-dir saves` arguments. Extra forwarded options are refused.
A safe existing `saves` directory is mandatory. Paths are printable ASCII and
bounded below MAX_PATH, including generated save names, because the selected
runtime uses narrow filesystem calls. Unsafe aliases, reparse points, hardlinks,
nonregular files and unexpected immutable changes are refused.

Exactly five local mutable paths are declared: `config.ini`, `runtime_prefs.ini`,
`imgui.ini`, `saves` and `snapshots`. The 14 immutable package files retain tree
SHA256 `0dee3194883214a9842093ca511a899ca0a95689e01c837e8f0546655daeb4ef`.
The current account's resolved Roaming path for
`gbrecompiled/runtime/runtime_prefs.ini` and the local fallback are reviewed
explicitly. A token-derived account binding and exact paths are retained;
file contents/timestamps are not frozen because normal settings edits are allowed.
Core does not create or copy these preference files during registration.
Runtime execution can create or overwrite preferences and discard unknown keys.
The CLI requires a fresh preview hash plus `--acknowledge-shared-preferences`;
generic `--yes` alone is insufficient. Desktop uses its native shared-scope
confirmation before registration confirmation; no renderer boolean grants consent.
Final preparation/spawn rechecks the retained binding and path safety.

Unregistering removes only Portcove registration metadata. It does not delete,
update, back up, restore, isolate or sandbox any external runtime, save, fallback
or shared preference file. Managed maintenance operations remain unoffered.
Staged-source capability version 8 exposes this new consequential contract;
versions 1 through 7 retain their existing semantics. Strict retained-envelope
reading refuses unsupported/noncanonical fields instead of silently dropping them.

## Actual operation acceptance and preserved failures

Evidence root is `E:/Codex-Evidence/slice6-20261018`; the isolated runtime and
library are under `E:/pcs6 regaiden 20261019`. These are private development
observations, with recorded source, CLI/catalog digests and captured process
identities, rather than installed Desktop or protected production execution.

The first four-path native packet (`regaiden-shared-native-a1`) positively
observed one responsive game and ordinary close, Core/CLI exit 0, then failed
post-run immutable verification because upstream ImGui wrote `imgui.ini`.
All 14 package immutable files, original and SDL/executable bytes remained intact.
The failure, raw process evidence and generated file were retained. Source review
at the frozen upstream pin established ImGui's default working-directory file
and shutdown write. Commit `d730f59463694a8f36da58a1dce482a935f6cbbd`
causally adds that exact file to the closed five-path contract and safety fixtures.
Only the two owned settled leases were archived by reviewed directory renames,
after captured terminal process/Core state and unchanged files were verified.

The old four-path registration was removed through its compatible Core reader,
with runtime preservation. The corrected reader refused generic confirmation
and the actual stale four-path preview. A duplicate exclusive evidence filename
then stopped registration packet a4 before creating a new record; that failure
is retained. Packet a5 resumes the remaining fresh five-path consent registration,
with unchanged external bytes and shared preferences absent.

With CLI source `d730f59463694a8f36da58a1dce482a935f6cbbd`, SHA256
`20f5eb70c69a441738c13e34c288a00ce87f720b13c831512cd92f162e36dc1e`,
and private catalog SHA256
`21d9dd1010df519318bcdc49e5f6a563e3f887cfb0818b228daee478303131d4`,
`regaiden-shared-native-a2/result.json` records two passing Windows cycles:
requests `9f0d2b28-fbd3-45ed-b449-8f6ca543acae` and
`8d384a0b-9a13-4fb3-bed0-19ffe1a6f1e7`. Core and captured OS identities match;
responsive windows, ordinary close, positive captured exit and Core/CLI exit 0
were observed. Each post-run immutable preview passed. Fresh removal preview,
explicit consent and unregister preserved all 18 files, both original-directory
files and shared-preference absence. Successful return of a wrapper alone is
not the exit evidence. The private environment was tested in an inert child
with competing Windows case aliases before actual execution.

An isolated metadata copy also demonstrated actual older v7 reader refusal
(`verification`, unsupported/noncanonical retained semantics), with current
reader success before/after and unchanged record/migrations; no game ran.
This observation belongs to the earlier four-path source. The same strict
canonical mechanism and five-path malformed/legacy fixture tests cover the
new contract, without relabelling that older native receipt.

## Validation and remaining boundaries

Focused Core fixtures cover exact artifact/catalog admission, source argv,
missing/wrong/stale consent, retained account binding, local/shared path safety,
mutable ImGui edits, hardlinks/directories, missing saves, strict retained reads
and pre-spawn fallback replacement refusal without a child. CLI capability
inventory and compiled Core/headless/native Tauri transport plus generated
TypeScript checks retain their exact source provenance. Target lockfile refresh
composition is rebuilt and checked separately before delivery.

Actual shared-preference creation or rewrites were not observed: that file
remained absent. Local `config.ini` and `imgui.ini` writes and SRAM creation
were observed; SRAM creation does not establish save/load acceptance. No save/load, audio, controller, full gameplay, other OS,
installed Desktop confirmation or protected catalog publication is inferred.
The offered minimum is this exact original-bound Windows registration/Play and
registration-only removal route. Optional gameplay does not gate that minimum.

The lockfile-only target advance `b19bc373e2ab15e7a08fb098bd625710f765b1c6`
was integrated as `030bcd5a85601efbe7c03cdd550afbf707b62504`.
`regaiden-shared-qualification-a4/receipt.json` binds its locked rebuild:
45 affected Core tests, the actual CLI capability inventory test, compiled
Core/headless/native Tauri parity, generated TypeScript and proposal admission
all passed. The new CLI SHA256 is
`923b81e58a5c75814d02e22a82770fce46c2128ce74fd2c1369cdfebfc45f1a6`.
Earlier negative and two-cycle receipts retain their original build identities.

`regaiden-shared-register-a6` and `regaiden-shared-native-a3` then passed a
fresh consent registration and one actual composition cycle, request
`fb3d425a-cb7d-4d20-b7c7-0b49826a0156`. Responsive captured Core/OS startup, ordinary close,
positive captured exit and Core/CLI exit 0, immutable revalidation and
registration-only removal preserved the same 18 external files, original
directory bytes and shared-preference absence. The three prior successful
sessions remained intact. This checks the refreshed dependency composition;
it does not relabel earlier receipts or repeat their unchanged negatives.
