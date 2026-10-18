# Slice 4 #439 proof-target fit assessment — 2026-10-18

Owner: [#246](https://github.com/boburning/portcove/issues/246), target specification
[#439](https://github.com/boburning/portcove/issues/439). This is preparation outside
the compiled catalog. It grants no port support, publisher authority, source use,
execution, key installation, signing or publication.

## Decision

Reject `v0.1.0 → v0.1.1` as the combined minimum's compatible progression pair.
The complete provider release list contains only these two releases. `v0.1.1`
fixes a relevant setup-host defect; that does not make `v0.1.0` an accepted
ordinary baseline. Do not publish a known defective initial definition merely
to demonstrate correction. No definition or catalog ID is assigned here.

The remaining condition is a second independently usable artifact version for a
single absent target, with the complete managed route established on both
versions. For #439, require two versions without the setup/BIOS defect under the
unchanged `psx-recomp-managed` contract 1, then owned-input preparation and retained
state observations. A fixed `v0.1.1` plus an untested future version is not such a
pair. This bounded assessment does not expand to another cohort target silently.

## Exact source and artifact identities

Canonical upstream is `alexbeavs-ps1-ports/crash-bandicoot-3-warped-recomp`,
repository 1359327606; durable issue key is
`alexbeav-crash-bandicoot-3-warped-recomp`. It remains in #1422's approved October 2
cohort. The current issue allows research; no overlapping implementation owner
was established during pickup.

| Version | Source commit                              | Release   | Windows ZIP asset |      Bytes | Provider SHA-256                                                   |
| ------- | ------------------------------------------ | --------- | ----------------- | ---------: | ------------------------------------------------------------------ |
| v0.1.0  | `9417e74f79d4d6b1eaa0f856ef1c6c09177cf87d` | 384048099 | 548703240         | 26,193,207 | `2d28cc45c6a971726cbc74ae8d5583ed79ebfefeee56c6d9c3584d06d59f5240` |
| v0.1.1  | `d800b79e2c6de39e7c588802a569f1268f2c861a` | 399975933 | 600755516         | 26,206,469 | `a65cf1eafdfa266cebc9f413aea5b80b06c19efd0aeada9d8523f53b8905d5cd` |

These are provider-authenticated artifact identities, not local ZIP comparison,
native setup, gameplay or lifecycle acceptance. No upstream binaries or scripts
were executed for this assessment.

## Actual Portcove route and relevant defects

The existing Core path in `crates/portcove-core/src/psx.rs` calls the package's
`psxrecomp/psxrecomp_cli.py generate --config game.toml --project-root ... --disc ...
--bios ... --no-toolchain-download`, then `rebuild --build-dir build-portcove
--target psx-runtime --exe-basename ... --no-pgo --no-toolchain-download`.
It launches the generated executable rather than the ZIP-root setup forwarder.
Thus a setup-forwarder naming problem alone would not establish failure of this
route. The game's CMake `EXE_NAME` and `codegen_setup.c` basename both equal
`Crash_Bandicoot_3__Warped_Recompiled` in the inspected v0.1.0 source.

The BIOS defect also affects the generated runtime's configured setup behavior:

1. [Pinned game.toml](https://github.com/alexbeavs-ps1-ports/crash-bandicoot-3-warped-recomp/blob/9417e74f79d4d6b1eaa0f856ef1c6c09177cf87d/game.toml)
   requires `psxrecomp/bios/SCPH5552.toml`; the game is USA SCUS-94244, accepted
   first data track size 285130608 and SHA-1
   `ae57f60f577c610476c7b8885bd76a6bea20d9de`. Preserve the selected BIOS profile;
   do not substitute a different regional image based on title region.
2. [Pinned CMake](https://github.com/alexbeavs-ps1-ports/crash-bandicoot-3-warped-recomp/blob/9417e74f79d4d6b1eaa0f856ef1c6c09177cf87d/CMakeLists.txt)
   forces `PSX_SETUP_WIZARD ON`, `PSXRECOMP_BIOS_STEMS SCPH5552`, and includes
   the game-owned `codegen_setup.c`. The managed builder does not disable this
   wizard or supply an alternate framework.
3. The v0.1.0 framework is `4d6f6c987ccc1f90e31966dc203ccd221545e013`.
   Its [CLI](https://github.com/RetroPortingToolKit/psxrecomp/blob/4d6f6c987ccc1f90e31966dc203ccd221545e013/psxrecomp_cli.py)
   already resolves the selected retail profile and emits SCPH5552. However,
   [the host](https://github.com/RetroPortingToolKit/psxrecomp/blob/4d6f6c987ccc1f90e31966dc203ccd221545e013/host/psxrecomp_codegen_host.c)
   recognizes only `OpenBIOS_dispatch.c` or `SCPH1001_dispatch.c` in
   `bios_backends_missing()`. `psxrecomp_codegen_host_sources_missing()` feeds
   `needs_setup` and `prepare_required_before_continue` in the game setup hook.
   [The runtime](https://github.com/RetroPortingToolKit/psxrecomp/blob/4d6f6c987ccc1f90e31966dc203ccd221545e013/runtime/src/main.cpp)
   calls that hook when game code/setup support is linked. Bypassing the root
   forwarder does not remove this source-level mismatch.
4. v0.1.1 pins framework `86506606be91a3f6aa0a2cf93ec0b4276fa95c82`.
   [The exact framework comparison](https://github.com/RetroPortingToolKit/psxrecomp/compare/4d6f6c987ccc1f90e31966dc203ccd221545e013...86506606be91a3f6aa0a2cf93ec0b4276fa95c82)
   changes the host to accept paired arbitrary BIOS stems, identifies the
   previous setup loop explicitly, and replaces hardcoded SCPH1001 discovery.
   Its new regression source records the expected SCPH5552 pair behavior.
   This is inspected upstream repair evidence, not a Portcove native pass.

This is sufficient to reject the old pair for proof preparation. Actual archive
closure, emitter/toolchain behavior, Windows encoding behavior, owned BIOS/disc
use, generated launch and preservation remain unexecuted. A claim that the old
package avoids the defect needs concrete package/compiled-runtime evidence;
release notes or a successful download cannot supply it.

## Unchanged ordinary-client preparation

Keep the proposed catalog metadata/targets origins and independent root in the
canonical Slice 4 packet. The configured default-feature CLI must be built with
that authorized public root before the selected definition is delivered. Record
source/tree, Cargo.lock, toolchain/target/features, catalog/root/executable hashes,
API schema, capability inventory, isolated library and feed configuration.
For this assessed route the requirement would be capability schema 1,
`psx-recomp-managed` window `[1,1]`; it is an existing engine template.

Record actual initial absence with that binary's ordinary catalog surfaces before
any new definition reaches its feed. Keep the binary and configuration fixed for
new definition → compatible real artifact progression → safe correction, then
read back current/staged/previous installs, source/save identities, pins and holds.
Today the compiled root is still `null`; no configured baseline was built and no
initial absence is claimed. Source inspection is not that observation.

Gen2 stable IDs and entries remain unchanged. Its delivered provisioning,
refresh, compatible artifact/correction and scheduled-observation components
retain their original scopes. Gen2 cannot supply this absent-definition leg.
The narrow publisher's final stable-ID/source/artifact scope remains unset until
a suitable single target is selected; no all-cohort grant is proposed.
