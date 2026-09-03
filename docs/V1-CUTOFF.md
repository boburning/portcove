# V1 game cutoff

The Portcove V1 research cutoff was approved on 2026-09-01. No newly discovered game is added to the V1 attempt queue after this date. A candidate may still be removed when its source contract, release integrity, licensing, or update boundary cannot be made safe. Removal is recorded in `DEFERRED.md`; it is never hidden by weakening validation.

“Attempt for V1” means research the direct game upstream, implement the narrowest reusable adapter, and qualify every practical platform independently. It does not promise that every candidate ships. A game-specific blocker is deferred while work proceeds on the rest of the queue.

## Embedded catalog baseline

All 61 ports in `crates/portcove-core/catalog/catalog.json` after the approved immediate wave, G-Diffuser, Severed Chains, OpenPete, the three OpenGOAL entries, Mega Man X6 Recompiled, and Paper Mario ReCut are in scope. That file remains the machine-readable authority for exact titles, upstreams, platforms, channels, source identities, and evidence. Existing entries are not duplicated here because catalog validation and tests enforce their contracts.

## Final expansion queue

The following entries are the only post-baseline games Portcove will attempt for V1:

| Wave | Game or upstream project | Intended route | Current state |
|---|---|---|---|
| Immediate | Space Station Silicon Valley: Recompiled | N64 recomp portable | Windows automation passed with explicit Vulkan, including v0.1.4/v0.2.0 lifecycle, clean animated launches and exact seven-file persistence through remove/reinstall. The tested host's Auto/D3D12 driver failure remains documented; hands-on qualification remains |
| Immediate | Animal Crossing PC Port | normalized GameCube ISO staging | Cataloged; Windows install, RVZ conversion, source staging, and process smoke complete |
| Immediate | Project Picori / The Minish Cap | exact GBA copy staging | Windows source/install automation and real CLI/GUI save restore with safety recovery passed; abnormal upstream exit remains documented, and physical gameplay/audio/controller qualification remains |
| Immediate | BattleShip / Super Smash Bros. 64 | Libultraship portable | Cataloged; Windows install, cache generation, persistence, and process smoke complete |
| Shared-source adapters | ProjectR: San Francisco Rush: The Rock | reviewed multi-file source set plus fixed launch target | Direct upstream and v0.7.1 reviewed; release integrity, arcade source availability, and interactive setup deferred |
| Shared-source adapters | ProjectR: San Francisco Rush 2049 | reviewed multi-file source set plus fixed launch target | Direct upstream and v0.7.1 reviewed; release integrity, arcade source availability, and interactive setup deferred |
| Shared-source adapters | R.E.L.I.V.E. / Oddworld: Abe's Oddysee and Abe's Exoddus | reviewed game-data directory | Active direct upstream and v1.0.9 reviewed; release integrity and original PC data deferred per game |
| Shared-source adapters | Severed Chains / The Legend of Dragoon | reviewed multi-disc data set | Automated Windows qualification complete with a verified bundled Corretto runtime, real release-pair lifecycle, title-screen launch, clean exit, immutable verification and preserved settings; gameplay/audio/controller/save qualification remains manual |
| Shared-source adapters | OpenPete / Spyro the Dragon | reviewed source set | Cataloged from the official direct manifest; application artifact qualified; local Redump CHD is not the exact disc image OpenPete accepts, so managed install/boot is deferred |
| Shared-source adapters | WipeOut Phantom Edition | reviewed PS1 disc extraction contract | CHD-to-9-track staging implemented and locally proven; upstream artifact/source integrity publication deferred |
| Shared-source adapters | Cannonball / OutRun | reviewed ROM set | ZIP/folder CRC32 validation and staging implemented; exact local Revision B set qualified; upstream release integrity deferred |
| Shared-source adapters | F-Zero X G-Diffuser | reviewed cartridge, disk, and IPL set | Cataloged; release resolves; local translated disk is the wrong format/revision and is deferred |
| Shared-source adapters | OpenGOAL: Jak and Daxter, Jak II, and Jak 3 | reviewed upstream-managed data setup per title | Windows automation complete for all three with accepted retail ISOs, real v0.3.5-to-v0.3.6 lifecycle pairs, fresh setup after reinstall, visible launches, clean supervised exits, immutable verification, and unchanged originals; hands-on gameplay/audio/controller/save qualification remains |
| Reviewed ReXGlue | NocturneRecomp | reviewed deterministic generator contract | Active direct v1.4.5 artifacts qualified; XBLA/STFS source identity and local source are deferred |
| Reviewed ReXGlue | Kameo RePowered | reviewed deterministic generator contract | Active direct v0.2.1 artifacts qualified; Xbox 360 disc identity and local source are deferred |
| Reviewed ReXGlue | Destroy All Humans! Path of the Furon recompilation | reviewed deterministic generator contract | Active direct `new` artifact qualified; source identity, local source, and deterministic first-run path contract are deferred |
| Reviewed ReXGlue | WWE SmackDown vs. Raw 2007 recompilation | reviewed deterministic generator contract | Active direct v1.0 artifact qualified; source identity and local source are deferred |
| Direct portable | Sonic Unleashed Recompiled | reviewed installed-data contract | Exact local Xbox 360 ISO found; active v1.0.3 artifacts lack published SHA-256 integrity and are deferred |
| High-value beta | Paper Mario ReCut | opt-in beta Windows release | Cataloged; Windows automated qualification passed, including v0.1.1 adoption to v0.1.2 staged update, activation, rollback, retained reuse, verified library move, post-move collection recovery, clean launch/exit, and unchanged original source; hands-on play/save validation remains |
| High-value candidate | Chameleon Twist recompilation | direct stable Windows release | Active v0.1 artifact lacks a digest and the local Japanese ROM is translated rather than the required clean revision; deferred |
| High-value candidate | Star Fox Enhanced | opt-in beta portable releases | v0.0.3 artifacts and exact local USA 1.0 ROM qualified; global Documents/SDL save and settings paths have no Portcove override, so safe update ownership is deferred |
| High-value stable | Mega Man X6 recompilation | stable Windows release with opt-in beta support | Cataloged; Windows automated qualification passed, including v1.0.7 adoption to v1.0.9 staged update/activation/rollback/retained reuse, exact Rev 1 CHD staging, direct boot, and managed memory-card preservation through remove/reinstall/launch; hands-on play/save validation remains |

Stable, beta, and rolling are user-selected release channels and never substitutes for qualification evidence.

## Explicitly outside the cutoff

- Mod recommendations and installation integration, including Dinomod Enhanced, were explicitly postponed to post-V1 by the user on 2026-09-03. The isolated Dinomod startup experiment does not change the V1 product scope.
- Additional projects discovered after 2026-09-01, including unnamed PS1 recompilation repositories.
- Toolchains, launchers, decompilation databases, and browser-only builds that do not install a native game.
- Incomplete projects that do not yet run the game.
- Source builds that require arbitrary unreviewed project scripts.
- Stale or missing repositories and unofficial redistributed game-data archives.

Archived upstreams are not rejected solely for being archived. A retired project is eligible only when the last release is useful, its immutable artifact can be pinned by size and SHA-256 in a stable direct manifest, and Portcove can preserve its source and user-data boundaries. Superseded or abandoned projects remain excluded when a maintained successor exists or the release is not responsibly supportable.

## Completion rule

Process the queue autonomously. When a title hits a source, artifact, runtime, or validation blocker, add a precise row to `PCV-DEF-007` and continue with the next title. The V1 cutoff changes only by an explicit product decision recorded in this file.
