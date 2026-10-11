# Diablo PSXRecomp: Windows admission evidence

This is a catalog admission receipt for [#435](https://github.com/boburning/portcove/issues/435), not a runtime or gameplay qualification result. The distinct port identity is `alexbeav-diablo-recomp`; its existing frozen-cohort record remains under [#1422](https://github.com/boburning/portcove/issues/1422).

## Exact inputs and artifact

- Direct upstream: [alexbeavs-ps1-ports/diablo-recomp](https://github.com/alexbeavs-ps1-ports/diablo-recomp), repository ID `1355811747` / `R_kgDOUNALow`.
- [Release v0.1.4](https://github.com/alexbeavs-ps1-ports/diablo-recomp/releases/tag/v0.1.4), release ID `401948038`, tag commit `1e71257166f6a2c0e087f7a36e0e3bde984132d4`.
- Windows x86-64 asset `diablo-recomp-0.1.4-windows-x64.zip`, asset ID `605927357`, 29,909,581 bytes. Downloaded bytes matched the provider's expected SHA-256 `962088ec8a614305221e4f67879702b1c0ca57268392982b431ab8d17b6c4722`.
- The ZIP inventory contains 2,230 entries / 76,131,872 uncompressed bytes. Bounded static inspection found no absolute/traversal paths or symlink entries. The root setup host is `Diablo_Recompiled.exe`; fixed CLI and builder binaries, CMake files, license notices and regional BIOS profile are included. Bounded PE-header inspection identifies the host and both builders as AMD64 without execution. The kit does not supply retail disc/BIOS data or generated retail game C.
- [Pinned game.toml](https://github.com/alexbeavs-ps1-ports/diablo-recomp/blob/1e71257166f6a2c0e087f7a36e0e3bde984132d4/game.toml) identifies Europe `SLES-01156`, one complete data track, 653,296,224 normalized bytes, SHA-1 `3dcfffb32c962d7ee2b00ea532b044aaeaaeb8ad`. The admitted source representation is the existing single-track CHD route, not arbitrary disc images or other regions.
- The actual framework gitlink is `f7672e53b8504fd20bd2b2ad70e62adc6a87a5de`; the packaged [SCPH5552 profile](https://github.com/Alexbeav/psxrecomp/blob/f7672e53b8504fd20bd2b2ad70e62adc6a87a5de/bios/SCPH5552.toml) matches that source after line-ending normalization. It requires the legally obtained Europe v3.0 01/06/97 retail BIOS, raw `.bin`/`.rom`, SHA-256 `1faaa18fa820a0225e488d9f086296b8e6c46df739666093987ff7d8fd352c09`. OpenBIOS/HLE is not an accepted substitute for this artifact.

## Existing capability fit and safety

The definition uses `psx-recomp-managed`. Its fixed CLI accepts the existing generation/rebuild flags, including `--exe-basename`, `--no-pgo`, `--no-toolchain-download` and `--prune-after`. Core uses its registered Python and build tools rather than the upstream wizard's automatic toolchain download. The generated executable and working directory are `build-portcove/Diablo_Recompiled.exe`; play skips the launcher with `--no-launcher`.

Existing Core machinery verifies and materializes the CHD, stages the verified BIOS at `psxrecomp/bios/SCPH5552.BIN`, binds preparation to original input identities, removes only the verified staged BIOS copy, and rechecks those identities at launch. It projects the verified source into `.portcove-psx-runtime.toml` and supplies `--game`, `--bios` and `--memcard-dir`. No multi-disc raw-set materialization is declared. These are existing contracts consumed by new facts; this admission does not claim a real-input generation run.

Packaged source inspection places memory cards in `build-portcove/saves` and settings/input/keybindings/source preferences beside the generated executable. The explicit reviewed persistence paths also retain `mods` and `overlay-captures`. Cache, heartbeat, diagnostic reports, exit trace and LAN-lobby output are separately disposable; freeze dumps use the existing bounded filename pattern. The existing overlay-capture override is retained. Generic regional BIOS cleanup/refusal, preparation binding/cancellation, launch binding, source projection and persistence safety coverage remains authoritative; no title's gameplay evidence is reused.

[License notices](https://github.com/alexbeavs-ps1-ports/diablo-recomp/blob/1e71257166f6a2c0e087f7a36e0e3bde984132d4/THIRD_PARTY_NOTICES.md) distinguish project-owned GPL-3.0-only files, framework PolyForm Noncommercial and UI MIT. Original retail content, generated retail code, artwork, names and trademarks retain their own rights. Older `project-manifest.toml` release-binding fields describe earlier candidates; they do not supersede this selected tag, asset or qualification scope.

## Artwork, maintenance and evidence limits

The existing artwork proposal workflow was invoked with separate exact project and PlayStation original-game identity facts. Both lookups reported `identity-provider-unavailable`: private IGDB credentials were unavailable, with zero authentication/metadata/image requests. Diablo retains the existing generated/text fallback. Retry cover preparation when credentials/provider access become available; this specific cover exception does not block admission. Existing unrelated mappings were retained without changes.

Maintenance policy: **managed-compatible-release**. The admitted artifact is exact; a subsequent compatible artifact or correction needs its applicable source, layout, integrity, ownership and delivery checks. DirectManifest is a representation choice, not a permanent pinned-release exception or automatic update/install permission. Shared progression and protected unchanged-client publication proof remain with [#246](https://github.com/boburning/portcove/issues/246); this unsigned repository addition does not publish a signed production feed.

Generation, launch, lifecycle execution, gameplay, controllers, audio, save/load and all other platforms are **Not tested** here. Legacy automated/manual platform arrays and scoped qualification records receive no passing entry. Missing developer-owned retail inputs do not remove the verified use-time input requirements. Known future failures must be held at their actual affected scope.

The local admission evidence is retained under `work/435-diablo-admission-20261010` in the canonical development workspace: provider/source receipts, exact ZIP and inventory, selected packaged text, artwork proposal and scoped monitoring receipt. The issue/PR records validation and delivery separately.

## Reuse result

No application, adapter or qualification-harness code changed. New attributable game/BIOS facts and an exact Windows artifact pass through existing catalog, source, preparation, launch, ownership and artwork machinery. The independently reviewed additions fixture records the three new identities; historical migration fixtures remain unchanged. One generic authoring test used a hard-coded live port count; it now uses small fixed synthetic identities and retains explicit missing/unreviewed-identity and unchanged-expectation controls. No second title or duplicate scenario is required to demonstrate this existing-capability reuse.

One-time package/fit review and ordinary data authoring are distinct from machine validation and waiting. Local compilation used a fresh task-owned cache after a long-path linker failure; no comparable elapsed-time baseline or speed improvement is claimed. A later ordinary regional-BIOS addition can reuse the same fixed route and refusal coverage with its own identities and artifact facts.
