import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { RecoveryReview } from "./RecoveryReview";
import { UpdateCenter } from "./UpdateCenter";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { ActivityRecord, DoctorReport } from "../types";

type Item = DoctorReport["repair"]["items"][number];
const port = portDefinition();
const item = (kind: Item["kind"]): Item => ({
  kind,
  port_id: port.id,
  operation_id: "retained-operation",
  path: "C:\\Private library\\retained",
  message: "private diagnostic",
  proposed_action: "Review retained state.",
});
const diagnostics = { refreshing: false, stale: false, refresh: vi.fn(async () => undefined) };
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

it.each([
  ["retained_preparation", "Review game setup", undefined],
  ["missing_registered_path", "Review game installation", "saves"],
  ["degraded_backup", "Review saves and backups", "saves"],
  ["backup_recovery_required", "Review saves and backups", "saves"],
  ["partial_operation", "Review game details", undefined],
  ["cleanup_pending", "Review game details", undefined],
] as const)(
  "routes %s to its actual game review without changing files",
  async (kind, label, destination) => {
    const onSelect = vi.fn();
    const mutate = vi.spyOn(desktopApi, "cleanupPreparation");
    await render(
      <RecoveryReview
        {...diagnostics}
        ports={[port]}
        repair={{ generated_at: 1, items: [item(kind)] }}
        onSelect={onSelect}
        onOpenStorage={vi.fn()}
      />,
    );
    expect(document.querySelector("details")?.open).toBe(false);
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(onSelect).toHaveBeenCalledWith(
      port.id,
      expect.stringContaining("updates:recovery:"),
      destination,
    );
    expect(mutate).not.toHaveBeenCalled();
  },
);

it.each(["future_kind", "constructor", "__proto__"])(
  "keeps unknown %s read-only even with every navigation callback",
  async (kind) => {
    const callbacks = { onSelect: vi.fn(), onOpenStorage: vi.fn(), onReviewActivity: vi.fn() };
    await render(
      <RecoveryReview
        {...diagnostics}
        {...callbacks}
        ports={[port]}
        availableActivityIds={new Set(["retained-operation"])}
        repair={{ generated_at: 1, items: [item(kind as Item["kind"])] }}
      />,
    );
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.body.textContent).toContain("Recovery information needs review");
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
  },
);

it.each(["orphaned_final_directory", "missing_registered_path"] as const)(
  "opens library storage for %s without a current game identity",
  async (kind) => {
    const onSelect = vi.fn();
    const onOpenStorage = vi.fn();
    await render(
      <RecoveryReview
        {...diagnostics}
        ports={[]}
        repair={{ generated_at: 1, items: [item(kind)] }}
        onSelect={onSelect}
        onOpenStorage={onOpenStorage}
      />,
    );
    await page.getByRole("button", { name: "Review library storage", exact: true }).click();
    expect(onOpenStorage).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  },
);

it("reveals and focuses the exact loaded recovery activity beyond the short history", async () => {
  const activities: ActivityRecord[] = Array.from({ length: 13 }, (_, index) => ({
    id: `activity-${index}`,
    operation: "install",
    target_kind: "port",
    target_id: port.id,
    status: "failed",
    started_at: 100 - index,
    finished_at: 101 - index,
    message: null,
    failure: null,
    cancellation: null,
  }));
  await render(
    <UpdateCenter
      ports={[port]}
      statuses={new Map()}
      activities={activities}
      outcomes={[]}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
      generation={1}
      repair={{
        generated_at: 1,
        items: [{ ...item("partial_operation"), operation_id: "activity-12" }],
      }}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn(async () => undefined)}
    />,
  );
  expect(document.querySelector('[data-activity-id="activity-12"]')).toBeNull();
  await page.getByRole("button", { name: "View related task record", exact: true }).click();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-activity-id"))
    .toBe("activity-12");
  expect(document.querySelectorAll("[data-activity-id]")).toHaveLength(9);
});

it("retains a recovery opener when a refresh removes an earlier unrelated item", async () => {
  const onSelect = vi.fn<(portId: string, originKey?: string) => void>();
  const retained = item("retained_preparation");
  const earlier = { ...item("degraded_backup"), operation_id: "earlier-operation" };
  const props = { ...diagnostics, ports: [port], onSelect };
  const screen = await render(
    <RecoveryReview {...props} repair={{ generated_at: 1, items: [earlier, retained] }} />,
  );
  const opener = page.getByRole("button", { name: "Review game setup", exact: true });
  await opener.click();
  const origin = onSelect.mock.calls[0]?.[1];
  expect(origin).toBeTypeOf("string");
  await screen.rerender(
    <RecoveryReview {...props} repair={{ generated_at: 2, items: [retained] }} />,
  );
  await expect.element(opener).toHaveAttribute("data-detail-origin", origin);
  expect(document.querySelector("details")?.open).toBe(false);
  await opener.click();
  expect(onSelect.mock.calls[1]).toEqual(onSelect.mock.calls[0]);
});
