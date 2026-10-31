# Installed Linux updater reboot observation — October 29, 2026

The ordinary isolated guest reboot and interrupted-copy recovery cell **passes**.
The existing updater is unchanged. The repair changes the qualification service's
install target to `cloud-init.target`, retaining `After=cloud-final.service` and
its explicit first-boot start. No updater plugin, release trust, busy protection
or product deadline is replaced.

## Exact identities and actual result

- Controller `7e93ee75d38779634323a90a4a1f93464e340375`; all five required
  contexts pass in [40986938400/1](https://github.com/boburning/portcove/actions/runs/40986938400).
- Actual native [40993092728/1](https://github.com/boburning/portcove/actions/runs/40993092728),
  job `123859868703`, succeeds. The shipping-package job is skipped. Only this
  invalidated reboot sequence is repeated; accepted GUI/busy/channel/data cells
  are not replayed.
- Artifact `12950636778`: **204500 bytes**, SHA256
  `2c69a4d36ce2bd59cb23dd569512bac22b645712553b65d66896485f006a059c`.
  All 144 files / 708367 expanded bytes pass raw ZIP, CRC, length, hash and public
  manifest checks; all nine controller inputs byte-match exact Git7e93.
- Shipping product remains source38 and the original signed cohort from
  `40934887557/1`, artifact `12926701381` / SHA256 `cfc5f19d45839d45bdecc1ff36944f48c59d91d51744af4d5f362503bb3e8478`.
  Predecessor **98859512 bytes** / SHA256 `cda06e2dd9d2ac50bf2eb72057d466bc96011188af275d77a0c22497a319b9da`;
  candidate **98675192 bytes** / SHA256 `d2e8d9626cac8ad9febdf3db6c9eb23177602231051634564c888f853ed0f552`.
  Exact signatures, Root, metadata, file feed and public-key identities are in the
  [machine receipt](installed-updater-reboot-observation-2026-10-29.json) and
  [existing integrated report](installed-updater-busy-observation-2026-10-29.json).
- Preparation helper source `d29563ea99263e33dbec693ecf0aebd9f3de709c`,
  **46922552 bytes** / SHA256 `d850c698f6c35776002589e51aabf20621e4dd9de15b7e30dbd5fa6803634efd`;
  actual compiler rustc1.99.1 / LLVM23.1.1. It is a qualification tool, not a
  rebuilt shipping application or payload-signature claim.

The official signed Ubuntu26.04.1 x86-64 base is 859090944 bytes / SHA256
`5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5`.
The guest runs kernel7.0.0-38-generic and the updater executes as UID/GID1001,
CapEff0. Guest-only root provisioning is distinct from the ordinary application
caller. Runtime/tool/image/package/unit identities are retained explicitly.

Installed authenticated staging exits0, existing preparation exits0, and the
injected interrupted copy exits86 with a 65536-byte partial swap. The normal OS
reboot changes `f6e5a615-a4f9-40cb-8703-9fcce0539e62` to
`6fbd3593-b63f-44a7-a990-792a59b80a71`, retaining machine ID
`78cfb89f09dc47d8923b8d56aa97e07d`, caller and file ownership.

Existing displayless recovery exits0 and makes the attempt retryable: raw apply
journal revision3 / native_launch=starting becomes revision4 /
native_launch=failed / native_replacement=null. The original application and
verified d2e8 candidate remain intact; the partial swap is removed. Executed
source verifies checkpoint file identities before recovery and all nonjournal,
non-swap identities after recovery, including preferences and three explicitly
synthetic witnesses. Checkpoint/recover phases both exit0. A separate after-file
identity map was not emitted; the receipt distinguishes runtime equality
assertions from retained raw journal and preference copies.

One QEMU process, PID12998, exits OS0 without timeout in619.390573563 seconds.
The host boot ID remains `e14bc146-9177-4298-9bd7-9942f051c717`. Serial records one
normal guest reboot and power-down, with no ordering cycle. The shared host was
not rebooted. Independent non-writing raw/source/identity review is clear.

## Retained failure and causal repair

The original [40983521568/1](https://github.com/boburning/portcove/actions/runs/40983521568)
remains **failed**. Artifact12949881379 is183462 bytes / SHA256
`c070bb7fc90e9817470702af9a4845cd3eaacc98b455bf2ddafff86a94388915`;
all105files/656093expanded bytes and nine Git1d5 source inputs are audited.
Staging0/preparation0/interruption86/checkpoint0 completed. A real guest reboot
occurred, then serial explicitly reported `Ordering cycle found, skipping
portcove-reboot-cell.service`. Recovery was never invoked. The original5400s
allowance exhausted; QEMU's OS0 after owned termination is not a recovery pass.

The first divergence was the harness's second-boot service admission. Its old
`WantedBy=multi-user.target` formed a cycle through cloud-final. Actual offline
systemd transactions reproduce the cycle and optional job deletion even with
verifierOS0. Positive/current and negative/old-target controls inspect those
semantic diagnostics rather than requiring a particular optional job to be
chosen. The one install-target repair precedes the successful fresh native
sequence. Product recovery and its deadlines are unchanged. This cause is
separate from the older846 renderer-Restart missing-marker failure, whose cause
remains unknown despite the later actual38 journey passing.

## Acceptance boundary

This completes the missing ordinary Linux native reboot/recovery cell alongside
existing installed [GUI/busy/real-game preservation](installed-updater-busy-observation-2026-10-29.md)
and [acceptance matrix](application-updater-beta-acceptance-2026-10-28.md).
Synthetic witnesses here do not replace those earlier real-data observations.
Power loss, GUI after reboot, Steam/Deck and full1.0 package qualification are not
inferred.

Actual production candidate/default features/Root/feed/signing/custody/publication
joins remain unmet under #534 and required by #52. This receipt does not activate
publication or complete initial Public beta. #706/#49 remains non-remediating,
scoped and expiring November14,2026 at23:59 America/New_York or before the
relevant second ordinary Linux Public beta, whichever is earlier. Reconfirm the
exact candidate, complete scanner/native inputs/features, first publication tag,
count and policy at actual release; renewal is not presumed.
