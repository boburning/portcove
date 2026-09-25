// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./Chrome";
import { UpdateCenter } from "./UpdateCenter";

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
});
