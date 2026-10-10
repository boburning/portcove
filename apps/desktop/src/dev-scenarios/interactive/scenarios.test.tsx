// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startInteractiveScenarios, stopInteractiveScenarios } from "./entry";
import { recoveryKey } from "./transport";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [] });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

vi.mock("../scenarios", () => ({
  scenarios: [{ id: "static", label: "Static reference", viewport: "wide", limitation: "Inert" }],
  renderScenario: () => "<p>Static reference</p>",
}));

afterEach(async () => {
  await act(async () => stopInteractiveScenarios());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "getGamepads");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  sessionStorage.removeItem(recoveryKey);
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

async function mount(journey: string) {
  window.history.replaceState(null, "", `/scenarios.html?mode=interactive&journey=${journey}`);
  document.body.innerHTML =
    '<select id="scenario"></select><p id="scenario-limitation"></p><div id="scenario-preview"></div>';
  await act(async () => startInteractiveScenarios());
}
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      !item.hidden &&
      (item.getAttribute("aria-label") === label || item.textContent?.trim() === label),
  );
  expect(button, label).toBeDefined();
  expect(button?.disabled, label).toBe(false);
  await act(async () => button!.click());
}

it("opens actual game details, returns to Library and resets the selected journey", async () => {
  await mount("library");
  await click("View details for Harbor Adventure");
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')).not.toBeNull();
  await click("Back to previous workspace");
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')).toBeNull();
  await click("Reset journey");
  expect(document.querySelector("#port-search")).not.toBeNull();
  expect(document.querySelectorAll("#scenario-preview .app-shell")).toHaveLength(1);
});

it("reviews preparation, preserves progress until cancellation, and shows controlled failure", async () => {
  await mount("setup");
  await click("View details for Harbor Adventure");
  await click("Review game preparation");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("fixture/owned.iso");
  await click("Prepare game data");
  expect(document.body.textContent).toContain("Fixture preparation is waiting");
  await click("Cancel preparation");
  expect(document.body.textContent).toContain("Preparation did not complete");
  await click("Review game preparation");
  await click("Prepare game data");
  await click("Fail fixture preparation");
  expect(document.body.textContent).toContain("Controlled fixture preparation failure");
  expect(document.body.textContent).not.toContain("Game data is prepared");
});

it("shows recovery choices, accepts the platform-default choice, and resets to the original recovery state", async () => {
  await mount("recovery");
  expect(document.body.textContent).toContain("Resume move");
  expect(document.body.textContent).toContain("Keep using original library");
  await click("Use platform default");
  expect(document.querySelector("#port-search")).not.toBeNull();
  await click("Reset journey");
  expect(document.body.textContent).toContain("Portcove couldn’t start");
});

it("opens the selected interactive library journey as a usable application", async () => {
  window.history.replaceState(null, "", "/scenarios.html?mode=interactive&journey=library");
  document.body.innerHTML =
    '<select id="scenario"></select><p id="scenario-limitation"></p><div id="scenario-preview"></div>';
  await act(async () => {
    await import("../entry");
  });
  const preview = document.querySelector<HTMLElement>("#scenario-preview")!;
  expect(preview.inert, "interactive journeys must allow real application interaction").toBe(false);
  await vi.waitFor(() => expect(preview.querySelector("#port-search")).not.toBeNull());
});
it("preserves the existing inert static reference entry", async () => {
  window.history.replaceState(null, "", "/scenarios.html?scenario=static");
  document.body.innerHTML =
    '<select id="scenario"></select><p id="scenario-limitation"></p><div id="scenario-preview"></div>';
  vi.resetModules();
  await import("../entry");
  const preview = document.querySelector<HTMLElement>("#scenario-preview")!;
  expect(preview.inert).toBe(true);
  expect(preview.textContent).toBe("Static reference");
  expect("__TAURI_INTERNALS__" in window).toBe(false);
});
