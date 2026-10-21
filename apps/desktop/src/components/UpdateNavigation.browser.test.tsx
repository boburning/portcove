import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { SettingsView } from "./Chrome";
import { UpdateCenter } from "./UpdateCenter";
import { portDefinition, portStatus } from "../test-fixtures";
import type { ActivityRecord, OperationEvent } from "../types";

describe("update destination links", () => {
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
      const section = [
        ...host.querySelectorAll<HTMLButtonElement>(
          '[role="tablist"][aria-label="Activity sections"] [role="tab"]',
        ),
      ].find((button) => button.textContent === "Updates")!;
      await act(async () => section.click());
      expect(tasks.hidden).toBe(true);
      expect(updates.hidden).toBe(false);
      expect(section.getAttribute("aria-selected")).toBe("true");
      const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Open Portcove update settings",
      );
      expect(link?.closest(".update-center")).not.toBeNull();
      await act(async () => link!.click());
      expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("application-updates");
    } finally {
      await act(async () => root.unmount());
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
