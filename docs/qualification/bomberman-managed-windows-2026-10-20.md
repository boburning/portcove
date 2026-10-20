# BombermanRecomp Windows qualification, 2026-10-20

Related to #724, #136 and the fixed slice 6B batch in #1422. This is the
existing Core-managed staged-source route for the selected official runtime,
not the older setup/build package described in the original investigation.
Repository admission, actual operation acceptance, protected production delivery
and optional gameplay observations remain separate.

## Exact selected contract

- Port `super-bomberman-recomp`, upstream `elliotttate/BombermanRecomp`,
  source commit `56106599c1fb2f612fd642ee37c0e015611fc31d`, tree
  `51eb28241e2ca2f3e35ebdf3a4a0e40131481cbd`.
- Official release v0.1.1, release377253209, asset531001333:
  `BombermanRecomp-windows-x64-v0.1.1.zip`, 1,245,795 bytes, published
  SHA-256 `079744154b82c7d89c39e693cc1440ad63c2e4fc71762b436c03eb1a4faa778a`.
  Seven flat regular package files expand to 3,243,720 bytes. The selected
  AMD64 executable is `BombermanRecomp.exe`, 1,611,776 bytes, SHA-256
  `f0b6e6271c2035c12c05de7fa068d1fe3fcf22df84038940f65ab7025adb4150`.
  The headless executable is immutable package content and is not selected.
- Exact owned headerless USA original: 524,288 bytes, SHA-256
  `4efab3f49cbe91ec77b6cba747ddfedfdc0b080c755a8b6ba51234f0676c000f`.
  Bounded extraction from the owned archive selected one regular member.
  No header transformation occurred. The upstream validator can also strip a
  512-byte header; this narrower catalog identity accepts only the exact raw file.
- Existing staged-source capability11 and `printable-ascii-max-path` policy;
  copy materialization to `game.sfc`, independently required runtime SHA-256,
  fixed first argument `game.sfc`, and install-root working directory. The pinned
  Win32 source selects argv1; later arguments do not replace that source path.
  No local compiler, setup launcher or arbitrary prepared-executable authority
  is required for this release.
- Persistent paths are `game.sfc` and `saves`. The exact source resolver and
  SRAM implementation place `save.srm` and `save.srm.bak` under local `saves`.
  Windows uses the package's Win32/GDI and waveOut host. No shared registry or
  roaming preferences are claimed.
- Source-proven default coverage diagnostics are disposable root-level
  `tier2_super_bomberman_*.json` and `.jsonl`. Authenticated framework
  `tier2_capture.c` blob `291913e2593384b91f3f13afda27f5f2faed22ed`
  constructs the sanitized title, UTC timestamp and PID names. These are data,
  not executable or script exceptions. Core's existing child-environment policy
  excludes SNESRECOMP/BOMBERMAN diagnostic-path overrides.

The declared framework is `elliotttate/snesrecomp` commit
`5d651266b58e9e52dc39904c9468b32866ad28c6`. The first lookup followed an old
framework redirect; the retained corrected comparison authenticates all634 Git
entries from the declared fork by path/mode/type/SHA/size, independently of
repository-specific API URLs. No source from the redirected repository executed.
The official runtime retains its upstream notices. Noncommercial framework
restrictions are not converted into redistribution or protected publication
permission; no original, generated C or executable is committed or republished.

## Actual producer and operations

The fixture-enabled CLI producer is source `e648c6c8cfd384508492608746dcca0ef5fa4ea7`,
tree `2918ac2cba295ee9729643145b1f788eea470233`, API74, SHA-256
`8f828df6dce412746d73514dfb623918ba90de38692ae6e63fa77900c1b93e26`.
Its build passed; a mistaken `show` collection command failed afterward.
CollectorA2 used `catalog show` without rebuilding and binds the same bytes.
The ordinary CLI used for inert proposal/artwork work lacks the private-catalog
feature and was not the actual install/native producer.

Corrected private catalogA3 SHA-256 is
`0b7fc03f9791d2a8f76d1a860f8ce513bbbc11e00d433f82c805fe0baeafaa59`.
It preserves all109 prior ports and adds only this title's source graph, route
and cover. Its two diagnostic patterns are a fresh contract, not a retroactive
PASS for the earlier failed install's integrity result.

Actual isolated Core acceptance in `H:/pc6-b724-a3` established:

- A wrong same-size original is refused before activation. The exact original
  installs the authenticated package; all seven immutable files verify.
- An unrecorded DLL is refused before a game child starts. Only the exact owned
  refusal-control file is removed after strict process absence.
- NativeA3 records two rendered startup/attract/menu observations and ordinary
  Alt+F4 closes, each correlated to PID/FILETIME, a retained OS handle, Core
  session exit0 and CLI exit0. Post-run verification passes after each cycle.
- Current-version check/update, no-previous rollback refusal, backup creation,
  restore and consented safety-backup deletion pass. Backup contents are the
  exact source copy and two empty save files. This is an unchanged-byte restore
  roundtrip; it does not establish a populated in-game save/load result.
- Stale-preview and missing-consent removal requests are refused. Fresh preview
  and consent remove the owned managed version after DB/process quiescence.
  All16 installation files are retained in a hash-verified evidence archive;
  the three persistent files, backup copies and external original are preserved.
- Same-version reinstall succeeds with the same package identity and preserved
  persistent data. NativeA4 adds two more ordinary-close cycles, taking the Core
  successful-launch count from2 to4. Before its second cycle, both owned active
  and canonical `game.sfc` copies are deliberately altered while retaining the
  source marker. Core recreates exact admitted bytes before the child starts;
  after close, active/canonical/original hashes match and the marker is unchanged.
  Each additional OS/Core/CLI exit is0 and immutable verification passes.

The later integration preserves target TFE initialization and API75, Render13,
TFE12 and existing Windows-path11 negotiation. This title has no managed TFE
initialization or Render source recipe. Independent target-interaction review
and final exact-head CI qualify integration separately from historical producer
and private operation identities.

## Preserved failures and limits

The first ordinary CLI attempt refused the unknown private port before install.
InstallA2 then passed installation/verification but its collector wrongly expected
the ROM copy before launch; collectorA3 repaired collection only. NativeA2
rendered the menu and closed with OS/Core/CLI0, then aggregate integrity failed
on two undeclared diagnostics. Its second cycle was never started. That root,
failed aggregate and actual positive close remain retained. Only its two exact
task-owned stale native leases were archived after independent review and fresh
PID/FILETIME, DB and game-process absence checks; no foreign sidecar was changed.
Reinstall harnessA1 was review-blocked before execution because it tried to
recreate the existing root; repairedA2 checks exact ownership instead.

Maintenance policy is `managed-compatible-release`: only admitted v0.1.1 is
currently selected. A future reviewed proposal must bind its exact accepted
artifact, source verification, executable and write/persistence contract before
replacement. Current-version update is verified; no different real release,
version-to-version rollback or automatic compatibility inheritance is claimed.
Existing #254 proposal preparation and protected #246 delivery remain distinct.

Underlying-game artwork is IGDB3450, cover292645, image `co69t1`, SHA-256
`ca7bb95b008bfa7dcfd4a2fe0da3af70abeeaa52b084f5a08504f0130a0a7669`.
The exact-port cover mismatch remains a finite underlying-game exception.
Artwork preparation also found an SMB cover; that unrelated change was retained
but not applied.

Gameplay completion, player controls, subjective audio, populated save/load,
minimum Windows, installed Desktop, signed-definition and release delivery are
Unknown or separately owned. Observed attract animation and zero exit do not
establish those claims. #724/#136 and other fixed slice6 owners are not closed
by this record; no wider candidates or slice7 are added.

## Evidence custody

Private source, package, original, producer and actual receipts live under
`H:/pc6-qualification-20261019-a3/evidence/`: `bomberman-source-pickup-a1`,
`builder-package-acquisition-a1`, `bomberman-package-inspection-a1`,
`bomberman-original-a1`, `bomberman-producer-a1`/`a2`,
`bomberman-core-install-a1`/`a2`/`a3`, `bomberman-install-collector-a3`,
`bomberman-native-a2`/`a3`/`a4`, `bomberman-maintenance-a1`,
`bomberman-removal-a1` and `bomberman-reinstall-a2`.
Reviewed harness hashes, raw process and UI observations, superseded inputs and
failed collectors remain there. The archive preserves bytes without granting
execution or publication authority.
