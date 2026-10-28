import { startDevelopmentScenarios } from "../start";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { startInteractiveScenarios, stopInteractiveScenarios } from "./entry";
import { recoveryKey } from "./transport";
import { desktopApi } from "../../api";
import { doctor, workspace } from "./scenarios";
import { sourceProfile } from "../../test-fixtures";
import { navigateTo } from "../../../test/primary-navigation";
import "../../styles/index.css";
import "../scenarios.css";
import scenarioShell from "../../../scenarios.html?raw";
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
  document.body.innerHTML = new DOMParser().parseFromString(
    scenarioShell,
    "text/html",
  ).body.innerHTML;
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

it("gives every disposable detail route five real tabs and binds external Play to its exact ID", async () => {
  await mount("details");
  const launch = vi.spyOn(desktopApi, "launch");
  await page
    .getByRole("button", {
      name: "View details for Summit Racer Harbor upstream project · external",
      exact: true,
    })
    .click();
  await expect
    .element(page.getByRole("tab", { name: "Overview", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  expect(launch.mock.calls[0]).toEqual(["details-external", "", 1]);
  for (const label of [
    "Game files",
    "Saves & backups",
    "Versions & updates",
    "Manage",
    "Overview",
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect.element(page.getByRole("tabpanel", { name: label, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
  await page
    .getByRole("button", {
      name: "View details for Summit Racer Harbor upstream project · unknown",
      exact: true,
    })
    .click();
  await expect
    .element(page.getByRole("tab", { name: "Game files", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await expect
    .element(page.getByRole("button", { name: "Play", exact: true }))
    .not.toBeInTheDocument();
  expect(document.querySelector("[data-installation-fact]")?.textContent).toBe(
    "Registered external installation",
  );
  await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
  await page.getByRole("button", { name: "Update prepared", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Versions & updates", exact: true }))
    .toHaveFocus();
  await expect
    .element(page.getByRole("button", { name: "Use update · 1.3", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

it("opens actual game details, returns to Library and resets the selected journey", async () => {
  await mount("library");
  await click("View details for Harbor Adventure Harbor Adventure");
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')).not.toBeNull();
  await click("Back to previous workspace");
  expect(document.querySelector('[aria-labelledby="port-detail-title"]')).toBeNull();
  await click("Reset journey");
  expect(document.querySelector("#port-search")).not.toBeNull();
  expect(document.querySelectorAll("#scenario-preview .app-shell")).toHaveLength(1);
});

it("keeps the optional folder editor and artwork behind disclosures without losing a draft", async () => {
  await mount("library");
  await click("View details for Harbor Adventure Harbor Adventure");
  const folder = page.getByText("Folder for a future install", { exact: true });
  const input = page.getByRole("textbox", { name: "Folder for future installs", exact: true });
  await expect.element(input).not.toBeInTheDocument();
  expect(document.querySelector(".detail-artwork")).toBeNull();
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  await folder.click();
  await expect.element(input).toBeVisible();
  await input.fill("fixture/future-draft");
  await folder.click();
  await expect.element(input).not.toBeInTheDocument();
  await folder.click();
  await expect.element(input).toHaveValue("fixture/future-draft");
  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect.element(input).toHaveValue("fixture/future-draft");
  await page.getByText("Change artwork", { exact: true }).click();
  await expect
    .element(
      page
        .getByRole("region", { name: "Cover image", exact: true })
        .getByRole("button", { name: "Choose local image", exact: true }),
    )
    .toBeVisible();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: /^More actions for Harbor Adventure/ }).click();
  await page.getByRole("menuitem", { name: "Change artwork", exact: true }).click();
  await expect
    .element(page.getByRole("region", { name: "Cover image", exact: true }))
    .toBeVisible();
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
});

it("shows different installed and selected release channels separately", async () => {
  const snapshot = workspace("library");
  snapshot.statuses[0]!.channel = "beta";
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  await mount("library");
  await click("View details for Harbor Adventure Harbor Adventure");
  const facts = document.querySelector('[aria-label="Installation and release versions"]')!;
  expect(facts.textContent).toContain("Selected channelPreview");
  expect(facts.textContent).toContain("Installed channelStable");
  expect(facts.textContent).toContain("Installed version1.2");
});

it("uses a viewport-bound demo workspace across resizing and preserves embedded mode on reset", async () => {
  window.history.replaceState(
    null,
    "",
    "/scenarios.html?mode=interactive&journey=collection-large&embed=1",
  );
  document.body.innerHTML =
    '<details class="scenario-controls" open><summary>Review desk</summary><p id="scenario-description">Static previews</p><select id="scenario"></select><p id="scenario-limitation"></p></details><div id="scenario-preview" class="scenario-preview" inert></div>';
  await act(async () => startInteractiveScenarios());
  await document.fonts.ready;
  expect(document.querySelector("#scenario-description")?.textContent).toContain(
    "Actions are simulated",
  );
  expect(document.querySelector<HTMLDetailsElement>(".scenario-controls")?.open).toBe(false);
  const preview = document.querySelector<HTMLElement>("#scenario-preview")!;
  const work = document.querySelector<HTMLElement>('main[data-focus-region="workspace"]')!;
  for (const [width, height] of [
    [1366, 768],
    [1920, 1080],
    [960, 640],
    [1366, 768],
  ] as const) {
    await page.viewport(width, height);
    await expect.poll(() => Math.round(preview.getBoundingClientRect().height)).toBe(height);
    expect(work.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    expect(work.scrollHeight).toBeGreaterThan(work.clientHeight);
  }
  await page.viewport(320, 900);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  expect(getComputedStyle(work).overflowY).toBe("visible");
  expect(document.scrollingElement!.scrollHeight).toBeGreaterThan(900);
  await click("Reset journey");
  expect(new URL(window.location.href).searchParams.get("embed")).toBe("1");
  expect(document.querySelectorAll(".collection-entry")).toHaveLength(60);
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
  await navigateTo("Activity");
  await page.getByRole("button", { name: "View related task record", exact: true }).click();
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
  await navigateTo("Settings");
  expect(document.body.textContent).toContain("Color theme");
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
});

it("keeps unsaved update choices while switching Settings categories", async () => {
  await mount("library");
  await navigateTo("Settings");
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

it("opens About through Settings and keeps custom catalog trust under Advanced", async () => {
  await mount("library");
  await navigateTo("Settings");
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "About", exact: true })
    .click();
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
  await navigateTo("Settings");
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
  await navigateTo("Activity");
  await page.getByRole("tab", { name: "Game updates", exact: true }).click();
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
  await navigateTo("Settings");
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
  [960, 640],
  [1280, 800],
  [1600, 1000],
] as const)(
  "keeps independent portrait frames in the actual %sx%s app grid",
  async (width, height) => {
    await page.viewport(width, height);
    await mount("library");
    const grid = document.querySelector<HTMLElement>(".port-grid")!;
    const frames = [...grid.querySelectorAll<HTMLElement>(".card-art")];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const box = frame.getBoundingClientRect();
      expect(box.height / box.width).toBeCloseTo(1.5, 1);
    }
    // Usable width determines column count. Assert containment and independent
    // artwork bounds rather than freezing a particular column population.
    const cover = frames[0]!.getBoundingClientRect();
    expect(cover.width).toBeLessThanOrEqual(height <= 680 ? 160 : 260);
    expect(grid.getBoundingClientRect().right).toBeLessThanOrEqual(width);
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
    await click("View details for Harbor Adventure Harbor Adventure");
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
  await click("View details for Harbor Adventure Harbor Adventure");
  await click("Review setup");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("fixture/owned.iso");
  await click("Prepare game data");
  expect(document.body.textContent).toContain("Fixture preparation is waiting");
  await click("Cancel preparation");
  expect(document.body.textContent).toContain("Cancellation requested");
  expect((await desktopApi.activities()).records[0]?.status).toBe("running");
  await click("Settle fixture cancellation");
  expect(document.body.textContent).toContain("Preparation did not complete");
  await click("Review setup");
  await click("Prepare game data");
  await click("Fail fixture preparation");
  expect(document.body.textContent).toContain("The demo setup did not finish");
  expect(document.body.textContent).not.toContain("Game data is prepared");
});

it("revisits the original running task after browsing another game and records its exact completion", async () => {
  await mount("activity");
  await click("View details for Harbor Adventure Harbor Adventure");
  await click("Review setup");
  await click("Prepare game data");
  const retained = await desktopApi.previewPreparationCleanup("fixture-retained-orchard", 1);
  await click("Back to previous workspace");
  await click("View details for Orchard Quest Orchard Quest");
  await click("Back to previous workspace");
  await navigateTo("Activity");
  const row = () => document.querySelector('[data-activity-id="fixture-preparation"]');
  await expect.poll(() => row()?.textContent).toContain("In progress");
  expect(row()?.textContent).toContain("Harbor Adventure");
  expect(row()?.textContent).not.toContain("Orchard Quest");
  expect(await desktopApi.previewPreparationCleanup("fixture-retained-orchard", 1)).toEqual(
    retained,
  );
  await click("Complete fixture preparation");
  await expect.poll(() => row()?.textContent).toContain("Completed");
  expect(row()?.textContent).toContain("Harbor Adventure");
  expect(
    (await desktopApi.activities()).records.find((item) => item.id === "fixture-preparation"),
  ).toMatchObject({ target_id: "sample", status: "succeeded" });
  expect(document.querySelector(".scenario-fixture-actions [role=alert]")?.textContent).toBe("");
});

it("shows recovery choices, accepts the platform-default choice, and resets to the original recovery state", async () => {
  await mount("recovery");
  expect(document.body.textContent).toContain("Continue location change");
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
