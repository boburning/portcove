import { captureParityState } from "../../test/parity-capture";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { workspace } from "../dev-scenarios/interactive/scenarios";
import { sourceProfile } from "../test-fixtures";
import { THEME_STORAGE_KEY } from "../theme";
vi.mock("../file-picker", { spy: true });

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
beforeEach(async () => {
  localStorage.clear();
  await page.viewport(1600, 1000);
});
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});
async function mount(journey: "library" | "collection" = "library") {
  transport = installInteractiveTransport(journey, () => {});
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  await page.getByRole("button", { name: "Add games", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Add games", level: 1 })).toHaveFocus();
}
function route(name: string) {
  return page
    .getByRole("group", { name: "Ways to add games" })
    .getByRole("button", { name, exact: true });
}
function routeNames() {
  const group = document.querySelector<HTMLElement>(
    '[role="group"][aria-label="Ways to add games"]',
  );
  return [...(group?.querySelectorAll("button") ?? [])].map((button) =>
    button.getAttribute("aria-label"),
  );
}
async function expectDiscover() {
  await expect.element(page.getByRole("heading", { name: "Discover", level: 1 })).toBeVisible();
  expect(
    document.querySelector('section[aria-label="Add games workspace"]')?.hasAttribute("hidden"),
  ).not.toBe(false);
}
it("offers exactly three routes and sends game choice to Discover without a second chooser", async () => {
  await mount();
  expect(routeNames()).toEqual(["Browse games", "Scan a folder", "Use an existing installation"]);
  expect(document.querySelector('[role="combobox"]')).toBeNull();
  expect(document.getElementById("add-games-check-files")).toBeNull();
  expect(document.body.textContent).not.toContain("You can leave this workspace");
  await route("Browse games").click();
  await expectDiscover();
});
it("sends the existing-installation choice to Discover", async () => {
  await mount();
  await route("Use an existing installation").click();
  const options = page.getByRole("region", { name: "Existing installation options" });
  await expect
    .element(options.getByRole("heading", { name: "Use the game where it is" }))
    .toBeVisible();
  await options.getByRole("button", { name: "Browse games", exact: true }).click();
  await expectDiscover();
});
it("retains the chosen folder route through details, navigation and closing the workspace", async () => {
  await mount();
  await route("Scan a folder").click();
  const folders = page.getByRole("heading", { name: "Folders Portcove scans", level: 2 });
  await expect.element(folders).toBeVisible();
  const panel = folders.element().closest(".add-route-panel");
  expect(panel).not.toBeNull();
  expect(panel!.querySelector('[data-settings-control="add-game-file-root"]')?.textContent).toBe(
    "Choose folder to scan",
  );
  await expect.element(route("Scan a folder")).toHaveAttribute("aria-pressed", "true");
  // Choosing a game happens in Discover; its details return there, not to Add games.
  await route("Browse games").click();
  await expectDiscover();
  const harbor = document.querySelector<HTMLButtonElement>(
    `.discover-game-identity[data-detail-game-id="${workspace("library").catalog.ports[0]!.id}"]`,
  );
  expect(harbor).not.toBeNull();
  harbor!.click();
  await expect
    .element(page.getByRole("heading", { name: "Harbor Adventure", level: 1 }))
    .toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Back to Discover" })).toBeVisible();
  await page.getByRole("button", { name: "Back to Discover" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("button", { name: /^Library/ })
    .click();
  await expect.element(page.getByRole("heading", { name: "Add games", level: 1 })).toBeVisible();
  await expect.element(folders).toBeVisible();
  await captureParityState("add-games-folder-route-return-fixture");
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Add games", exact: true })).toHaveFocus();
  await page.getByRole("button", { name: "Add games", exact: true }).click();
  await expect.element(route("Scan a folder")).toHaveAttribute("aria-pressed", "true");
  await expect.element(folders).toBeVisible();
});
it("checks a chosen game's files from its Discover details, preserves failures and restores its real opener", async () => {
  const snapshot = workspace("library");
  const profile = sourceProfile();
  snapshot.catalog.source_profiles = [profile];
  const port = snapshot.catalog.ports[0]!;
  port.source_profile = profile.id;
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  const choose = vi.spyOn(picker, "pickSourcePath").mockResolvedValue("E:/owned/未知.iso");
  const inspect = vi
    .spyOn(desktopApi, "inspectSourceIntake")
    .mockRejectedValue(new Error("Unsupported owned input"));
  await mount();
  await route("Browse games").click();
  await expectDiscover();
  document
    .querySelector<HTMLButtonElement>(`.discover-game-identity[data-detail-game-id="${port.id}"]`)!
    .click();
  await expect
    .element(page.getByRole("heading", { name: "Harbor Adventure", level: 1 }))
    .toHaveFocus();
  await page.getByRole("tab", { name: "Game files" }).click();
  const requirements = document.querySelector<HTMLDetailsElement>(".requirements-disclosure")!;
  requirements.open = true;
  const opener = page
    .getByRole("group", { name: "Check game files" })
    .getByRole("button", { name: "Check game files", exact: true });
  await opener.click();
  await page.getByRole("button", { name: "Choose game files to check", exact: true }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent("Unsupported owned input");
  expect(choose).toHaveBeenCalledWith(profile, "", "game");
  expect(inspect).toHaveBeenCalledExactlyOnceWith(profile.id, ["E:/owned/未知.iso"]);
  await captureParityState("add-games-source-failed-fixture");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(opener).toHaveFocus();
  await captureParityState("add-games-source-opener-restored-fixture");
});
it.each(["dark", "light"])(
  "keeps the %s routes readable at 240px and exposes no duplicated search IDs",
  async (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    await page.viewport(240, 800);
    await mount();
    expect(document.querySelectorAll("#port-search")).toHaveLength(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
    await route("Scan a folder").click();
    await expect
      .element(page.getByRole("heading", { name: "Folders Portcove scans", level: 2 }))
      .toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
    await route("Browse games").click();
    await expectDiscover();
    expect(document.querySelectorAll("#port-search")).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(241);
    await expect.poll(() => document.documentElement.dataset.theme).toBe(theme);
    await captureParityState("add-games-routes-compact-fixture");
  },
);

it.each([320, 240])("returns to the actual document reading position at %spx", async (width) => {
  await page.viewport(width, 800);
  transport = installInteractiveTransport("collection", () => {});
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
  );
  const origin = page.getByRole("button", { name: "Add games", exact: true });
  await expect.element(origin).toBeVisible();
  origin.element().scrollIntoView({ block: "center" });
  const readingOwner = document.scrollingElement!;
  const originDocumentTop = origin.element().getBoundingClientRect().top + readingOwner.scrollTop;
  readingOwner.scrollTop = Math.min(100, originDocumentTop / 2);
  const top = document.scrollingElement!.scrollTop;
  expect(top).toBeGreaterThan(0);
  await origin.click();
  await expect.element(page.getByRole("heading", { name: "Add games", level: 1 })).toHaveFocus();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect.element(origin).toHaveFocus();
  expect(Math.abs(document.scrollingElement!.scrollTop - top)).toBeLessThanOrEqual(2);
  expect(origin.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight + 1);
});
