# Super Mario World Recompiled package settings source evidence

On November 21, 2026, the managed catalog route selected the official Windows
x64 ZIP from `mstan/SuperMarioWorldRecomp`. The three verified packages below
have one root-level `config.ini`, beside the selected executable. Each package
contains that file before any user-data restoration. The tagged program reads
`config.ini` in the executable's working directory. The only byte-level
difference between the v0.15.9 and v0.15.10 files is `WindowSize = Auto`
becoming `WindowSize = 1280x720`. v0.15.11 ships the same bytes as v0.15.10.
[Old consumer](https://github.com/mstan/SuperMarioWorldRecomp/blob/8c280aac7ea08456372cd2b42603bb2ad7ab51eb/src/config.c)
[Successor consumer](https://github.com/mstan/SuperMarioWorldRecomp/blob/46525ab8da5ed53a061669c7ea4cdd3d96fb9424/src/config.c)
[Current consumer](https://github.com/mstan/SuperMarioWorldRecomp/blob/cbbf35c57dd637102925798d0cc092803dd44c32/src/config.c)

| Windows release                                                                  | Asset ID  | ZIP SHA-256                                                        | File bytes | File SHA-256                                                       |
| -------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------ | ---------: | ------------------------------------------------------------------ |
| [v0.15.9](https://github.com/mstan/SuperMarioWorldRecomp/releases/tag/v0.15.9)   | 734141150 | `8603cc1097348284215f09c1de644026dafb96ea4da7533bbdf5d3f02fc0ef82` |       3865 | `f94cfc6771f424c04c96287597a5eef515de453216615af6bd8027b92f1efbb2` |
| [v0.15.10](https://github.com/mstan/SuperMarioWorldRecomp/releases/tag/v0.15.10) | 750041540 | `d85a36e2c59d67685a26cb4fa0835079ff732e11720eb080ec0aa74fe09126dc` |       3869 | `bc463ec8136c2ca05753e1f375015cc88d36e73cb4414b22a25cc2654c3868cd` |
| [v0.15.11](https://github.com/mstan/SuperMarioWorldRecomp/releases/tag/v0.15.11) | 774297589 | `c4c0933bcbbf575ce1d74389b7ce89c9e34960aed395c18764683c483ecdc5cd` |       3869 | `bc463ec8136c2ca05753e1f375015cc88d36e73cb4414b22a25cc2654c3868cd` |

Retained v0.12.0 asset 556785079 had a different `config.ini` of 4274 bytes,
SHA-256 `84033a1d99f038decc6dfc3a4e13ea9e9d55cc1a9a9a4422ddb575de9ec5905a`.
The ZIP SHA-256 was
`1609aa46af51b9839c30d45ebac0c6bb8341a501fae22be4653486a71eab19fd`.
It needs its own managed settings and activation qualification.
[v0.12.0 release](https://github.com/mstan/SuperMarioWorldRecomp/releases/tag/v0.12.0)

The existing declared settings population also contains Shipwright and Golden
Balloon. The #8248 receipt records that Shipwright 9.3.1 Windows asset
656566128 and Golden Balloon v1.8.0 Windows asset 638366821 omit
`shipofharkinian.json` and `GoldenBalloon/mdkr64.ini` respectively.
Their existing scalar declarations do not supply package baselines.
[#8248 source and package observations](https://github.com/boburning/portcove/issues/8248)

Super Metroid Recompiled v0.4.2 and v0.4.5 Linux assets 707800602 and
728387215 each ship a 3266-byte `config.ini` of SHA-256
`b78e992f0f8821262965831578b933368f4e1713d1be391c48adf037ab6ceaf3`.
These two Linux files are unchanged and the managed route uses partitioned
data. The independent mirrored Windows contract does not cover that route.
[v0.4.2 release](https://github.com/mstan/SuperMetroidRecomp/releases/tag/v0.4.2)
[v0.4.5 release](https://github.com/mstan/SuperMetroidRecomp/releases/tag/v0.4.5)

The frozen Linux Preview.12 CLI accepted the three exact Windows ZIPs in its
read-only package layout inspector. It accepted the scoped inert legacy
projection and refused the same projection with the package-only declaration
as an unsupported settings contract version.

These are observations of upstream package and source bytes. Native Windows
activation with the reviewed pair, installed Desktop and CLI acceptance,
and delivery to a released client remain separate verification.

## Released retained-reader check

Frozen Preview.12 installed [OpenTyrian v2.1.20260913](https://github.com/opentyrian/opentyrian/releases/tag/v2.1.20260913)
in a private library using its ordinary Linux managed route. The installed
archive had SHA-256
`77dc7ba68540e1333aa243af122e2745ce54196fdba19a9141ed37ea17eab9e3`.
Its unindexed manifest retained a format-1 catalog. Full `verify` passed for
manifest SHA-256
`cf62302daf80fb015d91468551f9f5d0ddd3e94214c59c1627a7c9e03ed790b6`.

For the control, the same older reader verified the same OpenTyrian files
against a private copy of the manifest and its matching updated database
digest. Adding only the incidental Super Mario World format-2 settings row
caused exit 2 with `unsupported settings contract version`. Restoring the
original manifest and database digest made `verify` pass again. This exercises
the released verification boundary with an actual unrelated install. The Core
fixture covers the creating client's projection and the selected settings
reader floor separately.
