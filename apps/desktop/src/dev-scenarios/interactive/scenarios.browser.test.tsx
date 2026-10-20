import { startDevelopmentScenarios } from "../start";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { startInteractiveScenarios, stopInteractiveScenarios } from "./entry";
import { recoveryKey } from "./transport";
import { desktopApi } from "../../api";
import { doctor, workspace } from "./scenarios";
import { sourceProfile } from "../../test-fixtures";
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
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')).not.toBeNull();
  await click("Back to previous workspace");
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')).toBeNull();
  await click("Reset journey");
  expect(document.querySelector("#port-search")).not.toBeNull();
  expect(document.querySelectorAll("#scenario-preview .app-shell")).toHaveLength(1);
});

it("returns to the exact older recovery activity after opening its game", async () => {
  const snapshot = workspace("library");
  snapshot.activities = {
    ...snapshot.activities,
    terminal_history_count: 13,
    records: Array.from({ length: 13 }, (_, index) => ({
      id: `recovery-history-${index}`,
      operation: "install",
      target_kind: "port",
      target_id: "sample",
      status: "failed",
      started_at: 100 - index,
      finished_at: 101 - index,
      message: null,
      failure: null,
      cancellation: null,
    })),
  };
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "doctor").mockResolvedValue({
    ...doctor,
    repair: {
      generated_at: 1,
      items: [
        {
          kind: "partial_operation",
          port_id: "sample",
          operation_id: "recovery-history-12",
          path: "fixture/retained",
          message: "Retained fixture operation",
          proposed_action: "Review current state",
        },
      ],
    },
  });
  await mount("library");
  await page.getByRole("button", { name: /^Activity/ }).click();
  await page.getByRole("button", { name: "Review activity", exact: true }).click();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-activity-id"))
    .toBe("recovery-history-12");
  const origin = "updates:activity:recovery-history-12:target";
  const opener = document.querySelector<HTMLButtonElement>(`[data-detail-origin="${origin}"]`);
  expect(opener).not.toBeNull();
  await act(async () => opener!.click());
  await expect
    .element(page.getByRole("button", { name: "Back to previous workspace", exact: true }))
    .toBeVisible();
  await click("Back to previous workspace");
  await expect.poll(() => document.activeElement?.getAttribute("data-detail-origin")).toBe(origin);
  expect(document.querySelector('[data-activity-id="recovery-history-12"]')).not.toBeNull();
});

it("opens current Settings read surfaces without fixture refusals", async () => {
  await mount("library");
  await act(async () => page.getByRole("button", { name: /^Settings/ }).click());
  expect(document.body.textContent).toContain("Color theme");
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
});

it("keeps unsaved update choices while switching Settings categories", async () => {
  await mount("library");
  await page.getByRole("button", { name: /^Settings/ }).click();
  const navigation = page.getByRole("navigation", { name: "Settings categories" });
  await navigation.getByRole("button", { name: "Updates", exact: true }).click();
  const preview = page
    .getByRole("group", { name: "Application update channel" })
    .getByRole("button", { name: "Preview", exact: true });
  await expect.element(preview).toBeEnabled();
  await preview.click();
  await navigation.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Color theme", exact: true }))
    .toBeVisible();
  await navigation.getByRole("button", { name: "Updates", exact: true }).click();
  await expect.element(preview).toHaveAttribute("aria-pressed", "true");
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
});

it("opens About directly and keeps custom catalog trust under Advanced", async () => {
  await mount("library");
  await page.getByRole("button", { name: "About Portcove", exact: true }).click();
  await expect
    .element(
      page
        .getByRole("navigation", { name: "Settings categories" })
        .getByRole("button", { name: "About", exact: true }),
    )
    .toHaveAttribute("aria-current", "page");
  const navigation = page.getByRole("navigation", { name: "Settings categories" });
  await navigation.getByRole("button", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Manage custom catalog sources", exact: true }).click();
  await expect
    .element(navigation.getByRole("button", { name: "Advanced", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await expect
    .element(page.getByRole("heading", { name: "Custom catalog sources", exact: true }))
    .toBeVisible();
});

it("opens the Updates category before focusing an application-update notice", async () => {
  vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
    schema_version: 1,
    revision: 1,
    choice: null,
  });
  await mount("library");
  await page.getByRole("button", { name: /^Settings/ }).click();
  await expect
    .element(page.getByRole("heading", { name: "Color theme", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Review options", exact: true }).click();
  await expect
    .element(
      page
        .getByRole("navigation", { name: "Settings categories" })
        .getByRole("button", { name: "Updates", exact: true }),
    )
    .toHaveAttribute("aria-current", "page");
  await vi.waitFor(() =>
    expect(document.activeElement?.closest(".application-update-settings")).not.toBeNull(),
  );
  expect(document.activeElement?.closest("[hidden]")).toBeNull();
});

it("opens application updates from Activity without entering custom catalog settings", async () => {
  await mount("library");
  await page.getByRole("button", { name: /^Activity/ }).click();
  await page.getByRole("button", { name: "Updates", exact: true }).click();
  await page.getByRole("button", { name: "Open Portcove update settings", exact: true }).click();
  await expect
    .element(
      page
        .getByRole("navigation", { name: "Settings categories" })
        .getByRole("button", { name: "Updates", exact: true }),
    )
    .toHaveAttribute("aria-current", "page");
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("settings-updates-heading"));
  const advanced = document.querySelector<HTMLElement>('[data-settings-group="advanced"]');
  expect(advanced?.hidden).toBe(true);
  expect(advanced && getComputedStyle(advanced).display).toBe("none");
});

it("checks a one-time update channel in actual Settings without saving consent", async () => {
  const save = vi.spyOn(desktopApi, "setApplicationUpdatePreferences");
  await mount("library");
  await page.getByRole("button", { name: /^Settings/ }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Updates", exact: true })
    .click();
  await page
    .getByRole("group", { name: "One-time update channel", exact: true })
    .getByRole("button", { name: "Stable", exact: true })
    .click();
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await expect.element(page.getByText("One-time check · Stable", { exact: true })).toBeVisible();
  await expect
    .element(
      page.getByText("Renderer fixture only: no update service or native trust checks were run.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Save application update settings", exact: true }))
    .toBeDisabled();
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
});

it.each([
  [960, 640, 3],
  [1280, 800, 4],
  [1600, 1000, 5],
] as const)(
  "keeps independent portrait frames in the actual %sx%s app grid",
  async (width, height, columns) => {
    await page.viewport(width, height);
    await mount("library");
    const grid = document.querySelector<HTMLElement>(".port-grid")!;
    expect(getComputedStyle(grid).gridTemplateColumns.split(" ")).toHaveLength(columns);
    const frames = [...grid.querySelectorAll<HTMLElement>(".card-art")];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const box = frame.getBoundingClientRect();
      expect(box.height / box.width).toBeCloseTo(1.5, 1);
    }
    expect(grid.getBoundingClientRect().width).toBeLessThanOrEqual(1064);
    expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
  },
);

it.each(["game", "bios"] as const)(
  "carries the selected %s repair path into inspection without asking for it again",
  async (purpose) => {
    const snapshot = workspace("setup");
    const profile = { ...sourceProfile(), id: "owned-game" };
    snapshot.catalog.source_profiles = [profile];
    snapshot.catalog.ports[0] = {
      ...snapshot.catalog.ports[0]!,
      [purpose === "bios" ? "bios_source_profile" : "source_profile"]: profile.id,
    };
    snapshot.statuses[0]!.readiness = {
      launchable: false,
      pending_setup: false,
      blockers: [],
      [purpose === "bios" ? "bios" : "source"]: "missing",
    };
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    await mount("setup");
    await click("View details for Harbor Adventure");
    const inspect = vi
      .spyOn(desktopApi, "inspectSourceIntake")
      .mockRejectedValue(new Error("Check fixture"));
    const input = document.querySelector<HTMLInputElement>('input[id^="source-"]')!;
    expect(input).not.toBeNull();
    await act(async () =>
      page
        .getByRole("textbox", { name: purpose === "bios" ? /Required BIOS ·/ : /Game files ·/ })
        .fill("fixture/replacement.iso"),
    );
    const repair = page.getByRole("button", {
      name: purpose === "bios" ? "Locate required BIOS" : "Locate game files",
    });
    expect(repair.element().closest(".primary-actions")).not.toBeNull();
    await act(async () => repair.click());
    expect(inspect).toHaveBeenCalledWith("owned-game", ["fixture/replacement.iso"]);
  },
);

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
    await startDevelopmentScenarios(true);
  });
  const preview = document.querySelector<HTMLElement>("#scenario-preview")!;
  expect(preview.inert, "interactive journeys must allow real application interaction").toBe(false);
  await vi.waitFor(() => expect(preview.querySelector("#port-search")).not.toBeNull());
});
it("preserves the existing inert static reference entry", async () => {
  window.history.replaceState(null, "", "/scenarios.html?scenario=static");
  document.body.innerHTML =
    '<select id="scenario"></select><p id="scenario-limitation"></p><div id="scenario-preview"></div>';
  await startDevelopmentScenarios(true);
  const preview = document.querySelector<HTMLElement>("#scenario-preview")!;
  expect(preview.inert).toBe(true);
  expect(preview.textContent).toBe("Static reference");
  expect("__TAURI_INTERNALS__" in window).toBe(false);
});
