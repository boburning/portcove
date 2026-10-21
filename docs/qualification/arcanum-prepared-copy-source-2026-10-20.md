# Arcanum selected prepared-copy source treatment — October 20, 2026

Owning issue: [#828](https://github.com/boburning/portcove/issues/828).
This delivers a source preparation component for the selected Windows x64
player-owned full-copy route. It does not establish catalog admission, actual
user delivery or operation acceptance. The owner currently has no commercial
Arcanum data. That leaves an exact acceptance prerequisite; it does not remove
this integration from slice 6.

## Selected identity and permission boundary

The [source patch](patches/slice6-arcanum-prepared-copy.patch) modifies
[alexbatalov/arcanum-ce at a7ff41b300ef712f0e7d088183a3d08957110cdd](https://github.com/alexbatalov/arcanum-ce/tree/a7ff41b300ef712f0e7d088183a3d08957110cdd),
tree `c541c5fe54f03f9a485bdf101671d5a1bf986031`.
It is a Portcove modification, not an upstream release. The upstream
[Sustainable Use License](patches/slice6-arcanum-SUSTAINABLE-USE-LICENSE.md)
is included with this source treatment. Preserve that license, upstream notices
and this modification notice with modified copies. The selected work is a private
personal-use build. No modified executable or original game data is published.
Expired Actions artifact metadata is not used as retrievable binary evidence.

The source README requires an owned GOG/Steam installation and identifies
`arcanum1.dat` through `arcanum4.dat`, `tig.dat`, the stock Arcanum module,
patch and media tree. This is a source-supported member description, not an
accepted edition/revision/hash allowlist. No commercial file identity is invented.
The precise owned-data contract and its acceptance/rejection observations remain
required before admitting a prepared installation.

## What the patch changes

Windows startup requires one argument (the executable itself), an ASCII physical
copy root and an executable directory matching the working directory. The root
is held open. Settings and TIG file-layer physical opens and mutations use contained
paths and held ordinary objects. File opens refuse reparse points and multiple
hard links before truncation, preserving CRT read/write/append modes. Rename
refuses overwrite. Recursive cleanup is bounded to depth 32 and 65,536 objects.

Only the stock Arcanum module can be selected. Existing fixed path builders stop
on overflow; checked formatters reject truncation before opening an output.
Windows enumeration is incremental, validates each returned name/path, refuses
reparse entries and stops on unsafe or unexpected enumeration failures. It does
not silently report an incomplete list as success. Non-Windows behavior is not
qualified by this Windows treatment.

The save reader validates the complete bounded raw index before creating an
output tree. It bounds record count, depth, component/path lengths and aggregate
payload, and refuses traversal, reserved/aliased names, collisions, malformed
nesting and trailing input. Slot index/data files must be direct matching siblings
of the same physical Save directory. They cannot come from Current or from
another repository. The root `data.sav` must be nonempty.

Extraction streams into a new sibling tree, flushes/closes it and its sources,
then moves prior Current aside and activates the new tree using non-overwriting
renames. The Windows load caller no longer destroys Current before validation.
A failed second rename attempts restoration; failed restoration retains the old
backup and staging with a diagnostic. This is **not** a journaled two-rename
transaction: a crash between renames can leave Current absent and its prior
cache in the retained backup. Canonical slot pairs are never extracted over or
removed. Old backup cleanup can retain a backup after successful activation.
Ordinary save creation retains upstream behavior; transactional slot replacement
is not established by this component.

Save/load coordinates retain the existing eight-byte slot basename. Metadata
filename components and fixed fields are bounded before copies/opens. A refused
PC-name copy releases the allocated name and thumbnail. These restrictions can
refuse long/non-ASCII names and unsupported modified layouts; no general mod
support or filesystem sandbox is claimed.

## Exact source and build evidence

The original authenticated tree contains 431 regular files. The treatment changes
seven files and adds six parser/guard/extractor files. The selected private
437-file CRLF/mixed source manifest is
`f737994afe49a74b9f13df1e41431c03e857315fb813eefb9f2500675734a680`.
A fresh whole-game Release x64 build of those exact inputs passed, producing
4,637,696-byte EXE SHA256
`233792c4f30ccf2c45b486990883721b0279e6db2947ce8bc2e52f6023771361`.
That executable was not run.

The repository patch uses LF, SHA256
`acfcfa4907b5951683cae0c574c27fff786c993df50412f22094a4f33a254a01`.
Fresh application to the authenticated base produced 437 checked postimages.
Export replay manifest SHA256:
`f8b2e0f9b738064edb3bd12707c8fad9b293ff1ef7ebd762216457b11d486de3`.
The first byte comparison correctly refused three additional carriage returns
before newlines in file.c; the normalized export and all 437 postimages were then
verified exactly. The original private mixed-line-ending inputs and intermediate
patch-build receipts remain separate. A fresh whole-game Release x64 build of
the exact exported postimages passed, producing a 4,637,696-byte EXE SHA256
`cccb977811df1e341c8e24a3d8709276283fff3e07aefb967f4266dae18c01d2`.
That executable was not run. The retained receipt is
`evidence/arcanum-patch-build-a2/result.json` beneath the evidence root below.

The build uses MSVC 14.44.35207, Windows SDK 10.0.19041.0 and complete before/after
checks of the selected 5,621-file, 908,859,619-byte SDK profile. Both selected
compiler-host binaries are authenticated. Source and copied compile roots are
checked before configure, between configure/build and after build. Configuration
uses explicit offline dependency roots and ordinary compiler probes. Two compile
workers, finite harnesses and no MSBuild node reuse bound the private build.

| Dependency      | Exact source commit                        |
| --------------- | ------------------------------------------ |
| fpattern        | `992b9685380ebb6bfd037856ececec1da2e3742e` |
| SDL 3.4.8       | `d9d5536704d585616d4db3c8ba3c4ff6fc2757e1` |
| SDL_mixer 3.2.2 | `a5e1890afc5115ffd16cefdbb4d50f74bf4970ce` |
| zlib 1.3.2      | `da607da739fa6047df13e66a2af6b8bec7c2a498` |

WAVE and vendored dr_mp3 support are enabled. Unselected external codecs and
macOS symlinks are never fetched/materialized. This is a selected build closure,
not source-commit-only executable trust or a general reproducible-build claim.

Actual focused evidence includes 51 parser cases, 87 actual metadata-loader
cases, 108 filesystem/CRT guard cases in each normal and extended path form,
37 actual stock-module cases with mocked mount witnesses, 15 actual extraction
filesystem cases and actual compat/enumeration boundaries plus ten hooked
fail-stop refusals. The extraction failure injection refuses a staged **open**;
it does not prove short-write/flush failure handling. SDL metadata in the
standalone enumeration fixture uses a Win32-backed mock. Whole-game compilation
and these fixtures are distinct from commercial-data/native acceptance.

Detailed manifests, requests, stdout/stderr, original failed attempts and
independent reviews remain in `H:/pc6-qualification-20261019-a3`. Retained build
receipts are not signing, publication, installed-client or gameplay evidence.

## Static CRT build and output trace — October 21, 2026

The earlier exported-source executable directly imports `VCRUNTIME140.dll` and
Universal CRT API sets. A fresh build of the same 437 postimages and exact
dependency/SDK closure instead selects static CRT linkage with both configure
arguments below, before the first `project()` call:

```text
-DCMAKE_POLICY_DEFAULT_CMP0091=NEW
-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded
```

Both are necessary for this source's older CMake policy baseline: setting the
runtime variable alone does not establish the selected policy. The selected
[CMake policy](https://cmake.org/cmake/help/v3.31/policy/CMP0091.html) and
[runtime setting](https://cmake.org/cmake/help/v3.31/variable/CMAKE_MSVC_RUNTIME_LIBRARY.html)
describe that distinction. Configuration remains offline, with the explicit
source roots, tool/SDK checks, two workers and finite bounds described above.
This is a build-configuration change; the source patch and its manifest do not
change.

The actual Release x64 build passed, producing a 4,877,312-byte executable,
SHA256 `7aaa9cdffb0e2bd28b0c4be3ed84d2daea86fb9cbd9cfdffaa4e7bf0bd46494f`.
It was not run. The cache and all nine application/dependency compile projects
select the static runtime; compiler-identification probes remain separate.
Actual compilation uses `/MT` and reports 13 warnings and zero errors.
The retained receipt is `evidence/arcanum-static-crt-build-a2/result.json`.
The first attempt reached the host resource-queue deadline before starting any
payload. Its log remains separate from the successful admitted retry.

Inert Microsoft `dumpbin /DEPENDENTS` inspection of that exact executable lists
eleven direct Windows imports: `KERNEL32.dll`, `USER32.dll`, `GDI32.dll`,
`WINMM.dll`, `IMM32.dll`, `ole32.dll`, `OLEAUT32.dll`, `VERSION.dll`,
`ADVAPI32.dll`, `SETUPAPI.dll` and `SHELL32.dll`. No direct VC runtime DLL or CRT
API-set dependency appears in that output. The raw inspection and executable
hash are retained in `evidence/arcanum-static-crt-pe-inspection-a1/`.
Direct imports do not establish all dynamically loaded modules, companion
admission, a minimum Windows environment or successful execution.

A separate source-bound trace establishes that normal non-editor stock-module
loading can regenerate mobile-object caches outside `Save`. `map_preprocess_mobile`
derives a cache name with ROT13 followed by reversal, checks an existing module
GUID and writes when regeneration is required. Original `*.mob` files are read
as inputs. The relative cache path passes through TIG repository selection;
its physical destination depends on the actual module representation and mount
order. The trace is retained in `evidence/arcanum-map-output-trace-a1/result.json`.
It is not a complete runtime write inventory. Save-only mutability is therefore
insufficient, and blanket mutable `Modules` or `maps` declarations are unjustified.
A narrow derived-cache classification or reviewed isolation treatment remains
engineering work before the prepared route can be admitted.

## Preparation and return point

The selected route uses a separately prepared **complete physical copy** of
qualified owned data. Never mount or write into the original installation, share
files by hard links/junctions, or replace its `arcanum.exe`. The selected patched
executable belongs beside the copied data, with that directory as working root,
no forwarded arguments and the modification/license notices retained. The copy
remains player-owned, including saves, configuration, logs and modifications.
This source treatment supplies no copy/staging or update/delete authority over
an original installation.

After the missing owned-data identity contract is qualified, the return point is
the existing reviewed UserPrepared/StagedSourcePortable flow: inspect the exact
prepared executable/companions and complete immutable/mutable inventory, obtain
explicit review consent, register, launch, ordinary-close, restart/read back,
then remove only registration while proving all external files and saves remain.
PR [#2280](https://github.com/boburning/portcove/pull/2280) supplies Core's two-sweep
mutable-file hardlink refusal for that future fit. It does not qualify this title.
User-managed updates require fresh exact review/revalidation; arbitrary selected
binaries cannot be made trusted by hashing them.

Issue #828 remains open. The precise remaining requirements are owned supported
data/representation identities, complete runtime/output classification and exact
prepared build/companion identity, followed by actual consent, startup/ordinary
close/restart/readback and registration-only removal acceptance. Any necessary
engineering revealed there remains assigned. Optional gameplay is not used as a
substitute gate, and no managed update/rollback/backup operation is offered here.

## Selected x64 legacy-codec boundary

The source treatment now prevents the selected Windows x64 build from loading
`binkw32.dll` through the ambient DLL search path. Its legacy module handle,
load and unload branches remain available to 32-bit Windows. The calling
convention and existing unavailable-codec wrapper results are unchanged.
On x64, codec initialization explicitly reports unavailable.

This addresses one executable-companion lookup. It does not establish the
complete dynamic module closure of SDL or its audio/video backends. An absolute
path alone would not authenticate a replacement codec; a future enabled codec
needs an authenticated, ABI-compatible artifact and a lawful acquisition path.

The proposed x64 route consequently has no Bink movie playback. Source callers
tolerate the existing unavailable-codec result, but useful stock-game behavior
and acceptance of this limitation remain pending with the other #828 route
acceptance. No game or movie playback is inferred from the fixture.

The [codec fixture](patches/slice6-arcanum-x64-codec-test.c) includes the real
selected implementation and replaces the loader with a local counter returning
no module. Its required positive observation is unavailable initialization,
zero load attempts and unchanged wrapper fallbacks. An unchanged-source control
must fail by observing a load attempt. These are narrow native fixture results,
not a game startup, owned-data or complete executable-companion qualification.

The static CRT build and PE evidence above belong to the preceding source patch
`acfcfa4907b5951683cae0c574c27fff786c993df50412f22094a4f33a254a01`
and its exact retained manifest. They remain historical component evidence and
do not qualify this new codec-boundary source.

The final combined source patch is SHA256
`8ce8711f6c457af255167207c22af434ba169b7094c66be10720d7557f528241`.
Exact 437-file replay passed with ordinary `git apply --check` and `git apply`,
with `core.autocrlf=false` preserving the authenticated LF source bytes. Its
manifest is SHA256
`caf06add7b050395c807330bf41a51aab5a27324fd807fc09024a9bed2d6da71`,
retained at `evidence/arcanum-x64-codec-replay-a3/verification.json` under the
same private evidence root. All other source files match the preceding replay.

The actual Windows x64 fixture and unchanged-source control passed in
`evidence/arcanum-x64-codec-fixture-a5/result.json`. Both compile with `/W4 /WX`.
The old control naturally exits 1 after its intercepted load attempt; the new
implementation exits 0 with unavailable initialization, zero load attempts and
unchanged wrapper fallbacks. The interceptor loads no DLL. Earlier failed
attempts remain retained, including A4's C4702 unreachable shared return. The
final patch repairs the preprocessor branch rather than suppressing that warning.

The matching offline static-CRT Release x64 build passed with 12 warnings and
zero errors, producing 4,876,800 bytes, SHA256
`2292768a17c80b03d1c2042748292b227b03a4134f868ae68c6cead33ef9cc4e`.
Receipt: `evidence/arcanum-x64-codec-build-a2/result.json`. The executable was
not run. Exact source/dependency and complete 5,621-file SDK checks bracket
the build. Inert PE inspection of this exact artifact reports the same eleven
direct Windows imports listed above and no direct VC runtime DLL or CRT API-set
imports; receipt: `evidence/arcanum-x64-codec-pe-inspection-a1/result.json`.
These observations validate this narrow source component. They do not resolve
movie limitation acceptance, complete dynamic loading, owned-data identity,
derived-cache isolation or actual prepared-route operations for open #828.
