# Snap64 Recomp Windows qualification, 2026-09-13

This is a dated evidence snapshot for the first Portcove catalog admission of
Snap64 Recomp. It records automated lifecycle and bounded native-launch evidence;
it is not a hands-on gameplay, controller, audio, or real save/load attestation.

## Scope

- Port: `snap64-recomp`
- Platform: `windows-x86-64`
- Upstream ref: `v1.0.5` (`0b1a67eb4fd15ff3a87957110c428eb4905c36cc`)
- Windows release artifact SHA-256:
  `e3ab514df95d4a8133d2504ddc2ce43c12e376f5be74f076b3f90c09f8baf6b7`
- Source contract: `snap64-recomp-game-source`
- Source identity: `pokemon-snap` / `usa-rev0` / `canonical-rom`
- Canonical source SHA-1: `edc7c49cc568c045fe48be0d18011c30f393cbaf`
- Canonical source SHA-256:
  `a1d5d816db7f8557ee04c35a011326d058b2c1fbca76b57b352b1d705a1ec1cc`
- Portcove base revision: `f02dabd6eeef1850a6df42d8288dc7c5cad3ed1e`
- Candidate CLI SHA-256:
  `d26f2af461822394eba468f8f138adacc7af99082a70e9e78d67bb3daa3e4018`
- Host renderer: AMD Radeon RX 9070 XT through Direct3D 12

The authorized source was read from the BoburNAS RomM library as the original
`Pokemon Snap (USA).zip`. Portcove inspected the archive member, normalized its
N64 byte order, and matched both canonical hashes above.

## Passed Portcove lifecycle observations

- Rejected the known-mismatching Shadows of the Empire ROM with
  `source_invalid` and preserved the previously registered Pokemon Snap source.
- Resolved and installed the live `v1.0.5` Windows release. The downloaded
  artifact size was 16,058,168 bytes and its SHA-256 matched the scoped contract.
- Verified all 44 immutable installed files and reported no update from the
  current release.
- Materialized `pokemonsnap.z64` only under the isolated
  `user/snap64-recomp` root selected through `SNAP_DATA_DIR`. The materialized
  source retained the canonical SHA-256, and no ROM appeared in the immutable
  install tree.
- Started the Portcove-owned executable. Snap64 registered ROM hash
  `0x73CBBC5C7DE9425C`, created its renderer, reached a responsive
  `Snap64 Recomp 1.0.5` window, generated settings and cache files in the user
  root, and exited with code 0 after an SDL quit event.
- Created a seven-file Portcove backup, mutated a persistent sentinel, restored
  the backup through the guarded restore path, and observed the original
  sentinel SHA-256
  `fcdad99777e107b9b6f9674d23665affe0f121123aa4a053d359a57ba3984ed3`.
  Portcove also created the expected safety backup of the replaced state. The
  restored ROM remained absent from every immutable install tree.
- Adopted a second clean copy of the official `v1.0.5` payload, launched it,
  updated it transactionally through the normal GitHub release provider,
  verified and launched the downloaded install, rolled back to the adopted
  install, verified and launched the rollback target, and preserved the
  persistent sentinel at SHA-256
  `2ce9711851b8e8118efb5ec655d8f14ce0f981f49e5416826593f0a9a11b1678`
  throughout. Neither the update nor rollback target acquired a ROM, including
  after the rollback target launched again.

The update/rollback predecessor deliberately used the same `v1.0.5` payload.
Snap64 `v1.0.4` was also probed and was not treated as a passing predecessor:
it predates `SNAP_DATA_DIR`, looked for the ROM in its immutable runtime root,
reported the missing ROM, and did not start gameplay. Portcove first admits this
port at `v1.0.5`, so no compatibility claim is made for older releases.

## Upstream release-owned checks

The upstream `tools/release_check.py` default suite ran against the exact ROM
and official Windows archive in a separate isolated runtime. Eighteen of 22
checks passed, including PE subsystem and icon checks, package layout, static
C++ runtime, log rotation, valid 41-field settings, menu staging, four nonblack
changing captures, and an attract replay without a hold or crash.

Four checks failed on this 165 Hz Windows host: the statistics replay emitted
7 pacing reports rather than the required 20, emitted 0 coherence lines rather
than 500, emitted 39 tick lines, and the scoring route produced 0 scored-photo
and 0 photo-export events. These bounded failures remain visible and are not
converted into Portcove gameplay qualification.

## Remaining evidence

- Windows hands-on gameplay, audio, controller input, and a real in-game
  save/load cycle are unassessed.
- The upstream replay timing and scoring failures need reproduction or an
  upstream fix before that suite can be called fully passing on this host.
- Linux is declared by upstream but was not exercised in this Windows session.
