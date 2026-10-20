# F-Zero managed Windows path-policy qualification — October 19, 2026

This supplements the [earlier managed-route observations](f-zero-managed-windows-2026-10-19.md)
for [#1114](https://github.com/boburning/portcove/issues/1114) and
[#2177](https://github.com/boburning/portcove/issues/2177). Earlier API71 evidence
retains its original identity. These are new operations in a new disposable
library, using the policy-bearing API73 implementation.

## Executed identity

- Core/CLI source: `7563fedf1915faaecd87f83f1a4a4f48e0b86c27`.
- Source tree: `91974a49a20782e3404851b88af32ba28167ec94`.
- Catalog SHA256: `85e83b9de5dea9b35d0c8bb3109a7784c2f5feef70afd87f4b5b4beff928afe8`.
- Retained CLI: 47,423,488 bytes; SHA256
  `97a703dad6613ec16928a24657060edd3bd7df8c6f06ef988289ee6bbfd2f01c`.
- Official v1.8.3 Windows asset580473673: 8,247,843 bytes; SHA256
  `4a97edf9478501ad15d5f66403298e5c983d69558b1839017acbba5c58efe658`.
- Selected executable: `FZeroSNESRecomp-1.8.3-windows-x64/FZeroSNESRecomp.exe`;
  SHA256 `b2875639509787278193299a283545b23b2808c8e2608a7ad6858132d2605d96`.
- Original: headerless F-Zero USA `.sfc`, 524,288 bytes; SHA256
  `bf16c3c867c58e2ab061c70de9295b6930d63f29f81cc986f5ecae03e0ad18d2`.

## Path restriction and observations

Pinned framework source and executable inspection identified narrow Windows path
APIs without an active UTF8 code-page manifest. The new managed definition
therefore requires printable ASCII runtime paths within MAX_PATH, including its
write-probe suffix. Original files may remain at Unicode paths. Core checks the
output before acquisition, the actual executable before preparation, retained
installation readiness before restoring user data, and relocation previews using
the retained definition. This does not change historical external registrations.

1. Eleven prelaunch controls passed. They include invalid 1,024-byte source
   refusal, exact Unicode-named original registration, Unicode and overlong
   runtime-folder refusal with `runtime_path_requirement`, changed-original
   refusal after review, fresh reviewed installation and 70-file verification.
2. Native request `fd9eae01-9da2-48f0-9ccb-b2efe10c6798` reached the visible F-Zero
   title/menu. Ordinary close produced exit0 and durable outcome `succeeded`.
   Identity-bound helpers proved process exit. An active-tree synthetic save
   probe was collected unchanged into canonical ownership.
3. Backup, active-probe change and collection, restore, reviewed removal and
   reviewed reinstall passed. Removal preserved the probe and healthy backup
   inventory. Reinstallation identity was
   `53d11eb7-1ffe-4ad6-bbb0-a3ed6d64b269`; originals remained unchanged.
4. A separate post-reinstall native session captured the actual generated source
   marker. The next controlled session corrupted only disposable active and
   canonical source copies while preserving that matching marker. Request
   `83c00558-9456-477a-8ac5-0c8184186b66` recreated exact runtime bytes, preserved
   both original files and the earlier synthetic probe, closed ordinarily and
   passed immutable verification. Its screenshot was black at capture time;
   this session establishes recreation and process outcomes, not visible menu
   arrival. The earlier native request establishes menu arrival separately.
5. A fresh release check reported installed v1.8.3 and no update available for
   that exact accepted artifact. It does not establish future compatibility.

Seven focused Core tests also passed for path bounds, legacy omissions,
pre-mutation refusal, retained-policy relocation and capability negotiation.
The actual compiled Playnite reference consumer passed492 checks against the
retained API73 CLI after stale test expectations were repaired. Those consumer
checks are not observations of the live Playnite application.

## Scope and retained evidence

Windows x64 developer environment, real Core/CLI, authenticated official package,
authorized private originals, disposable library/preferences and exclusive native
session admission. No existing installation or save directory was adopted.
Persistence probes test byte preservation, not gameplay save/load. Gameplay,
input/controllers, audio, GUI first-play workflow, minimum Windows version,
another OS, version-to-version update/rollback and Supported status remain
unqualified. The maintenance target remains managed-compatible-release; the
current manifest offers only v1.8.3.

Private evidence root:
`E:/Codex-Evidence/ui-ux-implementation-20261019/managed-fzero-policy-a1/`.
Retained receipts include `build-receipt-a2.json`, `lifecycle-a1/receipt.json`,
`lifecycle-a1/native-a3/receipt.json`, `lifecycle-a1/maintenance-a2/receipt.json`,
`lifecycle-a1/native-reinstall-seed-a1/receipt.json`,
`lifecycle-a1/native-cache-a1/receipt.json`, owned screenshots and
`check-current-release-a2.stdout.json`. Earlier compilation and consumer test
failures remain retained separately; later passing results do not erase them.

Later documentation, qualification metadata and C# test changes do not relabel
the executed CLI source above. Final hosted CI and merge evidence belong to the
actual final delivery head.
