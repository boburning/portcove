// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./Chrome";
import { UpdateCenter } from "./UpdateCenter";
import { portDefinition, portStatus } from "../test-fixtures";

describe("update destination links", () => {
  it("opens Game updates from application and catalog update settings", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const onOpenGameUpdates = vi.fn();
    try {
      await act(async () => root.render(<SettingsView onOpenGameUpdates={onOpenGameUpdates} />));
      const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Open Game updates",
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

  it("opens application and catalog update settings from Game updates", async () => {
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
      const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Open Portcove & catalog update settings",
      );
      expect(link?.closest(".update-center")).not.toBeNull();
      await act(async () => link!.click());
      expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("catalog-updates");
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
