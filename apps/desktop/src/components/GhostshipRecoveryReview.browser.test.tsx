import { controlledAct as act } from "../../test/controlled-react-act";
import { render, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import type { BackupRecord, GhostshipRecoveryPlan } from "../types";
import { installRecord } from "./rendered-test-fixtures";
import { GhostshipRecoveryReview } from "./GhostshipRecoveryReview";
import { BackupHistory } from "./BackupHistory";

const backup: BackupRecord = {
  id: "qualified-backup",
  port_id: "ghostship",
  path: "library/backups/legacy",
  created_at: 1,
  file_count: 2,
  size: 128,
  sha256: "a".repeat(64),
};
const tree = { directories: [], files: [], skipped_entries: [], total_bytes: 0 };
const plan: GhostshipRecoveryPlan = {
  format_version: 1,
  library_root: "library",
  backup,
  qualification_sha256: "b".repeat(64),
  legacy_install: installRecord({
    id: "legacy-2",
    port_id: "ghostship",
    path: "library/retained2",
  }),
  active_install: installRecord({ id: "current-3", port_id: "ghostship", path: "library/active3" }),
  staged_install: null,
  source: {
    path: "original.z64",
    profile_id: "ghostship",
    sha256: "c".repeat(64),
    size: 1,
    storage_sha256: "c".repeat(64),
    storage_size: 1,
    updated_at: 1,
  },
  channel: "stable",
  update_policy: "notify",
  canonical_data: tree,
  active_install_tree: tree,
  legacy_install_tree: tree,
  snapshot_data: tree,
  required_bytes: 1024,
  plan_sha256: "d".repeat(64),
};
let root: RenderResult;
beforeEach(async () => {
  root = await render(null);
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

it("reviews compound consequences separately from ordinary restore and binds the exact Core plan", async () => {
  const preview = vi.spyOn(desktopApi, "planGhostshipLegacyRecovery").mockResolvedValue(plan);
  const ordinary = vi.spyOn(desktopApi, "restoreBackup");
  const apply = vi.fn().mockResolvedValue(true),
    close = vi.fn();
  await root.rerender(
    <GhostshipRecoveryReview backup={backup} generation={7} apply={apply} close={close} />,
  );
  expect(preview).toHaveBeenCalledExactlyOnceWith(backup.id, 7);
  expect(apply).not.toHaveBeenCalled();
  for (const text of [
    "library/retained2",
    "library/active3",
    backup.path,
    "fresh derivative",
    "Independent safety copies",
    "deleting",
    "Ordinary restore",
  ])
    expect(document.body.textContent?.toLowerCase()).toContain(text.toLowerCase());
  await expect.poll(() => document.activeElement?.textContent).toBe("Cancel");
  await click("Recover legacy installation and data");
  expect(apply).toHaveBeenCalledExactlyOnceWith(backup, plan.plan_sha256);
  expect(ordinary).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("does not offer recovery when Core refuses an unqualified snapshot", async () => {
  vi.spyOn(desktopApi, "planGhostshipLegacyRecovery").mockRejectedValue(
    new Error("Snapshot is not Core-qualified"),
  );
  const apply = vi.fn();
  await root.rerender(
    <GhostshipRecoveryReview backup={backup} generation={7} apply={apply} close={vi.fn()} />,
  );
  expect(document.body.textContent).toContain("Snapshot is not Core-qualified");
  expect(document.body.textContent).not.toContain("Recover legacy installation and data");
  expect(apply).not.toHaveBeenCalled();
});

it("rejects a plan for a different backup rather than applying its authority", async () => {
  vi.spyOn(desktopApi, "planGhostshipLegacyRecovery").mockResolvedValue({
    ...plan,
    backup: { ...backup, id: "another" },
  });
  const apply = vi.fn();
  await root.rerender(
    <GhostshipRecoveryReview backup={backup} generation={7} apply={apply} close={vi.fn()} />,
  );
  expect(document.body.textContent).toContain("Recovery plan does not match this backup");
  expect(document.body.textContent).not.toContain("Recover legacy installation and data");
  expect(apply).not.toHaveBeenCalled();
});

it("invalidates an outgoing library's delayed review before enabling apply", async () => {
  let finish!: (value: GhostshipRecoveryPlan) => void;
  vi.spyOn(desktopApi, "planGhostshipLegacyRecovery").mockImplementation((_id, generation) =>
    generation === 7
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ ...plan, library_root: "replacement", plan_sha256: "e".repeat(64) }),
  );
  const apply = vi.fn().mockResolvedValue(true);
  await root.rerender(
    <GhostshipRecoveryReview backup={backup} generation={7} apply={apply} close={vi.fn()} />,
  );
  await root.rerender(
    <GhostshipRecoveryReview backup={backup} generation={8} apply={apply} close={vi.fn()} />,
  );
  await act(async () => finish(plan));
  expect(document.body.textContent).toContain("replacement");
  await click("Recover legacy installation and data");
  expect(apply).toHaveBeenCalledExactlyOnceWith(backup, "e".repeat(64));
});

it("keeps discovery distinct from eligibility and disables review of stale backup history", async () => {
  const preview = vi.spyOn(desktopApi, "planGhostshipLegacyRecovery");
  const props = {
    backups: [backup],
    generation: 7,
    restore: vi.fn(),
    remove: vi.fn(),
    recoverGhostshipLegacy: vi.fn(),
    state: "healthy" as const,
  };
  await root.rerender(
    <BackupHistory {...props} readState={{ status: "failed", hasInventory: true }} />,
  );
  let review = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Review legacy recovery",
  )!;
  expect(review.disabled).toBe(true);
  expect(preview).not.toHaveBeenCalled();
  await root.rerender(
    <BackupHistory
      {...props}
      backups={[{ ...backup, port_id: "other" }]}
      readState={{ status: "current", hasInventory: true }}
    />,
  );
  review = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Review legacy recovery",
  )!;
  expect(review).toBeUndefined();
});
