import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { SettingsView } from "./Chrome";
import { UpdateCenter } from "./UpdateCenter";
import { portDefinition, portStatus } from "../test-fixtures";
import type { ActivityRecord, OperationEvent } from "../types";

describe("update destination links", () => {
  it("retains a focused settling record and its open disclosure across Tasks and History", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const activity: ActivityRecord = {
      id: "retained-task",
      operation: "backup",
      target_kind: "port",
      target_id: "sample",
      status: "running",
      started_at: Date.now() / 1000,
      finished_at: null,
      message: null,
      failure: null,
      cancellation: null,
    };
    const show = (record: ActivityRecord) =>
      act(async () =>
        root.render(
          <UpdateCenter
            generation={1}
            ports={[]}
            statuses={new Map()}
            activities={[record]}
            outcomes={[]}
            diagnosticsRefreshing={false}
            diagnosticsStale={false}
            refreshDiagnostics={vi.fn()}
            checkAll={vi.fn()}
            onSelect={vi.fn()}
            onOpenSettings={vi.fn()}
          />,
        ),
      );
    try {
      await show(activity);
      const row = host.querySelector<HTMLElement>('[data-activity-id="retained-task"]')!;
      const disclosure = row.querySelector<HTMLDetailsElement>("details")!;
      await page.getByText("Task details", { exact: true }).click();
      expect(disclosure.open).toBe(true);
      await show({ ...activity, status: "succeeded", finished_at: Date.now() / 1000 });
      expect(row.hidden).toBe(false);
      expect(document.activeElement).toBe(disclosure.querySelector("summary"));
      expect(disclosure.open).toBe(true);
      await page.getByRole("tab", { name: "History", exact: true }).click();
      await expect.poll(() => row.hidden).toBe(false);
      expect(host.querySelector('[data-activity-id="retained-task"]')).toBe(row);
      expect(disclosure.open).toBe(true);
      await page.getByRole("tab", { name: "Tasks", exact: true }).click();
      await expect.poll(() => row.hidden).toBe(true);
      expect(disclosure.open).toBe(true);
      await page.getByRole("tab", { name: "History", exact: true }).click();
      await expect.poll(() => row.hidden).toBe(false);
      expect(disclosure.open).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("attributes live progress by exact durable identity and keeps durable completion authoritative", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const record: ActivityRecord = {
      id: "owned-A",
      operation: "install",
      target_kind: "port",
      target_id: "A",
      status: "running",
      started_at: Date.now() / 1000,
      finished_at: null,
      message: null,
      failure: null,
      cancellation: null,
    };
    const progress: OperationEvent = {
      schema_version: 2,
      operation_id: "owned-A",
      parent_operation_id: null,
      target: null,
      sequence: 2,
      timestamp_ms: 1,
      operation: "install",
      type: "progress",
      phase: "download",
      completed: 25,
      total: 100,
    };
    const render = async (activities: ActivityRecord[]) =>
      act(async () =>
        root.render(
          <UpdateCenter
            generation={1}
            ports={[]}
            statuses={new Map()}
            activities={activities}
            operationEvents={
              new Map([
                [progress.operation_id, progress],
                [
                  "unrelated-later-event",
                  {
                    ...progress,
                    operation_id: "unrelated-later-event",
                    completed: 99,
                    timestamp_ms: 999,
                  },
                ],
              ])
            }
            outcomes={[]}
            diagnosticsRefreshing={false}
            diagnosticsStale={false}
            refreshDiagnostics={vi.fn()}
            checkAll={vi.fn()}
            onSelect={vi.fn()}
            onOpenSettings={vi.fn()}
          />,
        ),
      );
    try {
      await render([record, { ...record, id: "owned-B", target_id: "B" }]);
      const a = host.querySelector('[data-activity-id="owned-A"]')!;
      const b = host.querySelector('[data-activity-id="owned-B"]')!;
      expect(a.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25");
      expect(b.querySelector('[role="progressbar"]')).toBeNull();
      await render([{ ...record, status: "succeeded", finished_at: Date.now() / 1000 }]);
      expect(host.querySelector('[role="progressbar"]')).toBeNull();
      expect(host.querySelector(".activity-status")?.textContent).toBe("Completed");
      expect(host.querySelector('[data-activity-id="owned-A"]')).toBe(a);
      expect(a.hasAttribute("hidden")).toBe(true);
      await page.getByRole("tab", { name: "History", exact: true }).click();
      await expect.poll(() => a.hasAttribute("hidden")).toBe(false);
      expect(host.querySelector('[data-activity-id="owned-A"]')).toBe(a);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("opens Activity from application and catalog update settings", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const onOpenGameUpdates = vi.fn();
    try {
      await act(async () => root.render(<SettingsView onOpenGameUpdates={onOpenGameUpdates} />));
      const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Open game updates in Activity",
      );
      expect(link?.closest("[data-settings-group]")?.getAttribute("data-settings-group")).toBe(
        "updates",
      );
      await act(async () => link!.click());
      expect(onOpenGameUpdates).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("opens application and catalog update settings from Activity", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onOpenSettings = vi.fn();
    try {
      await act(async () =>
        root.render(
          <UpdateCenter
            generation={1}
            ports={[]}
            statuses={new Map()}
            activities={[]}
            outcomes={[]}
            diagnosticsRefreshing={false}
            diagnosticsStale={false}
            refreshDiagnostics={vi.fn().mockResolvedValue(undefined)}
            checkAll={vi.fn()}
            onSelect={vi.fn()}
            onOpenSettings={onOpenSettings}
          />,
        ),
      );
      const tasks = host.querySelector<HTMLElement>('[aria-label="Tasks and history"]')!;
      const updates = host.querySelector<HTMLElement>('[aria-label="Game updates"]')!;
      expect(tasks.hidden).toBe(false);
      expect(updates.hidden).toBe(true);
      const tabs = [...host.querySelectorAll('[aria-label="Activity sections"] [role="tab"]')];
      expect(tabs).toHaveLength(3);
      const descriptions = [
        "No task count is established by the loaded activity records.",
        "Update coverage is incomplete. 0 known updates available at last check.",
        "No history count is established by the loaded activity records.",
      ];
      for (const [index, label] of ["Tasks", "Game updates", "History"].entries()) {
        const tab = tabs[index]!;
        await expect.element(tab).toHaveAccessibleName(label);
        await expect.element(tab).toHaveAccessibleDescription(descriptions[index]!);
        const count = tab.querySelector(".activity-tab-count")!;
        expect(count.textContent).toBe("—");
        expect(count.getAttribute("aria-hidden")).toBe("true");
      }
      const section = page.getByRole("tab", { name: "Game updates", exact: true }).element();
      await page.getByRole("tab", { name: "Game updates", exact: true }).click();
      await expect.poll(() => section.getAttribute("aria-selected")).toBe("true");
      // Base UI settles the outgoing panel's hidden state after its animation
      // frame; keep both panels mounted while waiting for that transition.
      await expect.poll(() => tasks.hidden).toBe(true);
      await expect.poll(() => updates.hidden).toBe(false);
      expect(host.querySelector('[aria-label="Tasks and history"]')).toBe(tasks);
      expect(host.querySelector('[aria-label="Game updates"]')).toBe(updates);
      const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Open Portcove update settings",
      );
      expect(link?.closest(".update-center")).not.toBeNull();
      await page.getByText("About update checks", { exact: true }).click();
      await page
        .getByRole("button", { name: "Open Portcove update settings", exact: true })
        .click();
      expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("application-updates");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("shows an external runtime separately and opens its details", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const onSelect = vi.fn();
    const checkAll = vi.fn();
    const port = portDefinition();
    try {
      await act(async () =>
        root.render(
          <UpdateCenter
            section="updates"
            generation={1}
            ports={[port]}
            statuses={
              new Map([
                [
                  port.id,
                  {
                    ...portStatus(),
                    port_id: port.id,
                    external_runtime: {
                      id: "external-1",
                      port_id: port.id,
                      path: "C:\\Player\\Runtime",
                      executable: "C:\\Player\\Runtime\\game.exe",
                      version: "1.0.2",
                      platform: "windows-x86-64",
                      archive_sha256: "a".repeat(64),
                      immutable_tree_sha256: "b".repeat(64),
                      registered_at: 1,
                    },
                  },
                ],
              ])
            }
            activities={[]}
            outcomes={[]}
            diagnosticsRefreshing={false}
            diagnosticsStale={false}
            refreshDiagnostics={vi.fn().mockResolvedValue(undefined)}
            checkAll={checkAll}
            onSelect={onSelect}
            onOpenSettings={vi.fn()}
          />,
        ),
      );
      expect(host.textContent).toContain("Externally updated games");
      expect(host.textContent).toContain("Registered version1.0.2");
      expect(host.textContent).toContain("Updated externally");
      expect(host.textContent).toContain("No managed installations to check");
      expect(host.textContent).toContain("Registered runtimes are updated externally");
      expect(host.textContent).toContain("—Updates available");
      const checkButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Check installed ports for updates"),
      );
      expect(checkButton?.disabled).toBe(true);
      const external = host.querySelector<HTMLButtonElement>(
        `[data-detail-origin="updates:external:${port.id}"]`,
      );
      await act(async () => external!.click());
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(port.id, `updates:external:${port.id}`);
      expect(checkAll).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});
