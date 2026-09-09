// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AdoptionModal } from "./AdoptionModal";

it("keeps an uncancellable copy open and inputs locked even while another operation is busy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); const close = vi.fn();
  try {
    await act(async () => root.render(<AdoptionModal path="owned/original" setPath={vi.fn()} close={close} review={vi.fn()} adopt={vi.fn()} pickFolder={vi.fn()} applying busy="refresh" copyFailed />));
    for (const control of container.querySelectorAll<HTMLInputElement | HTMLButtonElement>("button, input")) expect(control.disabled).toBe(true);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".close")!.click();
      container.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(close).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Check the library and activity history");
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
