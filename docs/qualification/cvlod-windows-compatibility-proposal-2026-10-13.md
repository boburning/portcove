# CVLoD Windows successor proposal and cheat-settings ownership

This finite #320 component compares the existing Windows v0.2.26 baseline with
v0.2.27 and preserves a newly declared player configuration file. It supplies
metadata selection controls and static source evidence, not successor lifecycle,
clean-shutdown, installed-client or support qualification.

## Exact metadata and source scope

The official releases and separately paginated asset endpoints were read on
October 13, 2026. Each selected release has six assets: Windows, Linux and macOS
packages plus checksum companions. The embedded and separate inventories agree.
The inert fixture retains those complete inventories with provider identities,
clocks, sizes and advertised digests; it contains no package or game bytes.

| Windows release | Release ID |  ZIP bytes | Expected SHA-256                                                   |
| --------------- | ---------- | ---------: | ------------------------------------------------------------------ |
| v0.2.26         | 348086625  | 29,713,287 | `be60fefdbc4a98d1cf2ab6932e69825f39268e5ad1daab950ea7b8a19e53b40a` |
| v0.2.27         | 398558955  | 29,758,946 | `677cea596030f2ae888904884a64e685be5215eb954431fcee01bafb7757f467` |

Names are `LodRecomp-v0.2.26-windows-x64.zip` and
`LodRecomp-v0.2.27-windows-x64.zip`. Sources are the
[baseline release](https://github.com/fliperama86/cvlod_recomp/releases/tag/v0.2.26)
and [successor release](https://github.com/fliperama86/cvlod_recomp/releases/tag/v0.2.27).
Dereferenced annotated tags resolve to `89566dd74781d39e19944c8ba29a116ee31b963e`
and `cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d` respectively. Tag source identity
is separate from proof that the provider's ZIP was built from that source.

The unchanged real catalog definition selects the exact Windows ZIP from each
inventory under rotation and reversal. The production observer selects the
successor metadata, preserves the exact size/digest, and holds missing,
ambiguous, undigested or wrong-platform Windows candidates without selecting
an older release. All provider-authentication, artifact-byte-verification and
catalog-admission flags remain false. These are metadata-only controls.

## Static write-contract finding and additive repair

The selected successor's
[`src/main/main.cpp`](https://github.com/fliperama86/cvlod_recomp/blob/cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d/src/main/main.cpp#L2600)
(blob `52c6c97b34e88af499598588e8e7269c5549bdbb`, 163,188 bytes) defines
`cheats_config_path` as `config_path / "cheats.cfg"`. Startup calls
`load_cheats_config`, which creates default text if the file is missing and
then reads it. Existing files are not overwritten by that default writer.
The baseline source has no corresponding file or writer. This is a concrete
new configuration output, not an inferred game-save observation.

In that same immutable source, `find_portable_config_path` checks the working
and executable directories for `portable.txt`; a match becomes `config_path`.
The current N64 portable adapter already declares that marker and uses its
managed runtime root. The catalog now adds only `cheats.cfg` to persistent
ownership. This aligns the new file with existing player settings rather than
immutable package verification or disposable session outputs. Existing
installation manifests and their migration are not established by this change.
No cheat is enabled or player setting modified by the definition update.

The complete prior persistent list remains `rom.z64`, `saves`, `mods`,
`mods.json`, `mod_config`, `graphics.json`, `audio.json`, `controls.json` and
`rom_path.txt`. Disposable `castlevania2.n64.us.z64` and `LodRecomp.log` remain
unchanged. Source contracts, v0.2.26 applicability, validators, platforms,
support tier and all qualification records remain unchanged.

Both immutable
[source definitions](https://github.com/fliperama86/cvlod_recomp/blob/cb8548d145a1077b8f03b9f5c0590b4cc8b3a03d/castlevania2.yaml)
retain North American SHA-1 `879ead98f197fd05edda867655da5b1ce25aa5b8`.
The byte-identical selected `include/lod/target_rom.hpp` additionally declares
canonical SHA-256 `89e15df6042defddc48c61f7408f99d06fffdb845e2422cf8b5ba8e73d4d70fb`.
The CMake project remains `LodRecomp`; this does not prove executable layout
inside an acquired package. Static settings paths remain under the portable
root; dependency/runtime changes and other generated writes still require
candidate-specific review before broader compatibility acceptance.

## Retained failures and exact remaining acceptance

Reuse [#805's delivered baseline](https://github.com/boburning/portcove/issues/320#issuecomment-5673764244)
and [v0.2.26 Windows lifecycle receipt](https://github.com/boburning/portcove/issues/320#issuecomment-5673145276)
only at their original source, artifact and operation scope. Source admission,
install, 53-file immutable verification and bounded backup/restore were
observed. Update was a same-version no-op and rollback was inapplicable.
Normal window close failed with upstream `0xC0000005` and Portcove exit 127.
That failure remains unresolved. The successor's startup/GPU and graphics
notes, or static exit/timer changes, do not prove it repaired.

Before protected compatible progression, verify the exact acquired ZIP and
its source/build provenance, executable/layout, materialized source and every
setup/launch output. Bind player settings and saves to actual runtime
coordinates; establish preservation of `cheats.cfg` and existing state across
only the offered changed transitions. Resolve the known Windows normal-close
failure with exact causal and execution evidence; do not replay unrelated
successful baseline checks. The source-only ownership correction establishes
none of those real artifact or process observations.

#254 owns proposal preparation, #246 authenticated compatible acceptance and
unchanged-client delivery, and #534 production custody/signing/publication.
This proposal grants no protected authority. #320 remains open; no broader
beta outcome, gameplay, save/load, other-platform or support claim is completed.
Game, helper and upstream executable execution and lifecycle replay: **Not run**.

The [October 19 diagnosis and maintenance result](cvlod-shutdown-and-maintenance-2026-10-19.md)
adds later actual observations at their exact scope. It preserves this proposal
as historical metadata/source evidence and retains the affected clean-close hold.
