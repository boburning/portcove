import { captureParityState } from "../../test/parity-capture";
import { exactButtonXPath } from "../../scripts/browser-script.mts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { workspace } from "../dev-scenarios/interactive/scenarios";
import { fixtureValue, sourceProfile } from "../test-fixtures";
import { THEME_STORAGE_KEY } from "../theme";
vi.mock("../file-picker", { spy: true });

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let appHost: HTMLDivElement | undefined;
beforeEach(async () => {
  localStorage.clear();
  await page.viewport(1600, 1000);
});
afterEach(async () => {
  await cleanup();
  appHost?.remove();
  appHost = undefined;
  transport?.dispose();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});
async function renderApp() {
  // App supplies the real InterfaceSizeProvider and its responsive workspace.
  // Match main.tsx's bounded #root without overriding compact document scrolling.
  appHost = document.body.appendChild(document.createElement("div"));
  appHost.className = "h-dvh";
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: appHost },
  );
}
async function mount(journey: "library" | "collection" = "library") {
  transport = installInteractiveTransport(journey, () => {});
  initializeLocalization(["en"]);
  await renderApp();
  await page.getByRole("button", { name: "Add games", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Add games", level: 1 })).toHaveFocus();
}
function expectDesktopShell() {
  expect(window.scrollY).toBe(0);
  expect(document.scrollingElement?.scrollTop).toBe(0);
  // Dialogs make the background inert; inspect the same real navigation rather
  // than asking an accessibility locator to enter the inactive background.
  const navigation = fixtureValue(
    document.querySelector<HTMLElement>('nav[aria-label="Primary navigation"]'),
    "primary navigation",
  );
  expect(navigation.checkVisibility()).toBe(true);
  const bounds = navigation.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(innerWidth);
  const sidebar = fixtureValue(navigation.closest<HTMLElement>(".sidebar"), "desktop sidebar");
  expect(sidebar.getBoundingClientRect().top).toBe(0);
  expect(sidebar.getBoundingClientRect().height).toBe(innerHeight);
}
function route(name: string) {
  return page
    .getByRole("group", { name: "Ways to add games" })
    .getByRole("button", { name, exact: true });
}
async function expectDiscover() {
  await expect.element(page.getByRole("heading", { name: "Discover", level: 1 })).toBeVisible();
  expect(
    document.querySelector('section[aria-label="Add games workspace"]')?.hasAttribute("hidden"),
  ).not.toBe(false);
}

it("keeps native review button lookup exact for primary labels, accessible names and quotes", async () => {
  await mount();
  const matches = (label: string) => {
    const result = document.evaluate(
      exactButtonXPath(label),
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    return Array.from({ length: result.snapshotLength }, (_, index) => result.snapshotItem(index));
  };
  const existing = route("Use an existing installation").element();
  expect(matches("Use an existing installation")).toEqual([existing]);
  await expect.element(existing).toHaveAccessibleName("Use an existing installation");
  expect(matches("Copy a supported installation or keep using its current folder.")).toEqual([]);
  expect(matches("Use an existing")).toEqual([]);
  await route("Use an existing installation").click();
  await expect
    .element(page.getByRole("button", { name: "Copy an existing installation", exact: true }))
    .toBeVisible();

  const fixture = document.createElement("div");
  document.body.append(fixture);
  const add = (text: string) => {
    const button = document.createElement("button");
    button.textContent = text;
    fixture.append(button);
    return button;
  };
  try {
    for (const label of [
      "Exact fixture action",
      `Show "owner's" review`,
      `Fixture "] | //button | //button[@aria-label="escape`,
    ]) {
      const button = add(label);
      expect(matches(label)).toEqual([button]);
    }
    const legacy = add("Legacy fixture action");
    legacy.setAttribute("aria-label", "Legacy fixture action: Example game");
    expect(matches("Legacy fixture action")).toEqual([legacy]);
    expect(matches("Legacy fixture action: Example game")).toEqual([legacy]);
    const empty = add("");
    const icon = add("");
    icon.setAttribute("aria-label", "Icon fixture action");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("aria-hidden", "true");
    icon.append(svg);
    const originalEmpty = document.evaluate(
      '//button[normalize-space(.)=""]',
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null,
    );
    expect(matches("")).toEqual(
      Array.from({ length: originalEmpty.snapshotLength }, (_, index) =>
        originalEmpty.snapshotItem(index),
      ),
    );
    expect(matches("")).toContain(empty);
    expect(matches("")).toContain(icon);
    expect(matches("")).not.toContain(legacy);
    expect(matches("")).not.toContain(existing);
    const named = add("");
    named.setAttribute("aria-label", "Accessible fixture action");
    const strong = document.createElement("strong");
    strong.className = "block";
    strong.textContent = "Visible fixture action";
    named.append(strong);
    const description = document.createElement("span");
    description.setAttribute("aria-hidden", "true");
    description.textContent = " hidden fixture detail";
    named.append(description);
    expect(matches("Accessible fixture action")).toEqual([named]);
    expect(matches("Visible fixture action")).toEqual([]);
    expect(matches("Visible fixture action hidden fixture detail")).toEqual([named]);
    const reference = document.createElement("span");
    reference.id = "fixture-action-label";
    reference.textContent = "Referenced fixture action";
    fixture.append(reference);
    named.removeAttribute("aria-label");
    named.setAttribute("aria-labelledby", reference.id);
    await expect.element(named).toHaveAccessibleName("Referenced fixture action");
    expect(matches("Visible fixture action")).toEqual([]);
    const inline = add("Before ");
    const emphasis = document.createElement("strong");
    emphasis.textContent = "Inline fixture action";
    inline.append(emphasis, " after");
    expect(matches("Inline fixture action")).toEqual([]);
    expect(matches("Before Inline fixture action after")).toEqual([inline]);
    const hidden = add("Hidden wrapper ");
    const hiddenLabel = document.createElement("strong");
    hiddenLabel.className = "block";
    hiddenLabel.setAttribute("aria-hidden", "true");
    hiddenLabel.textContent = "Hidden fixture action";
    hidden.append(hiddenLabel);
    expect(matches("Hidden fixture action")).toEqual([]);
  } finally {
    fixture.remove();
  }
});

it("offers exactly three routes and sends game choice to Discover without a second chooser", async () => {
  await mount();
  const group = page.getByRole("group", { name: "Ways to add games", exact: true });
  const buttons = [...group.element().querySelectorAll("button")];
  expect(buttons).toHaveLength(3);
  for (const [index, name] of [
    "Browse games",
    "Scan a folder",
    "Use an existing installation",
  ].entries()) {
    await expect.element(buttons[index]!).toHaveAccessibleName(name);
  }
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
  expectDesktopShell();
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
  const opener = page
    .getByRole("group", { name: "Check game files" })
    .getByRole("button", { name: "Check game files", exact: true });
  opener.element().scrollIntoView({ block: "nearest", behavior: "instant" });
  const workspaceElement = fixtureValue(
    document.querySelector<HTMLElement>(".workspace-main"),
    "desktop workspace",
  );
  const originalScroll = workspaceElement.scrollTop;
  await opener.click();
  await page.getByRole("button", { name: "Choose game files to check", exact: true }).click();
  await expect.element(page.getByRole("alert")).toMatchTextContent("Unsupported owned input");
  expect(choose).toHaveBeenCalledWith(profile, "", "game");
  expect(inspect).toHaveBeenCalledExactlyOnceWith(profile.id, ["E:/owned/未知.iso"]);
  expectDesktopShell();
  await captureParityState("add-games-source-failed-fixture");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(opener).toHaveFocus();
  expectDesktopShell();
  expect(workspaceElement.scrollTop).toBe(originalScroll);
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
  await renderApp();
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

it("returns from Add games scan results to the saved-folder settings action", async () => {
  await mount();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Game files", exact: true })
    .click();
  const openScan = page.getByRole("button", { name: /Scan in Add games|View scan results/ });
  await expect.element(openScan).toBeVisible();
  await openScan.click();
  await expect.element(page.getByRole("heading", { name: "Add games", level: 1 })).toHaveFocus();
  await expect
    .element(page.getByRole("button", { name: "Scan saved folders", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Back to Game files settings", exact: true }).click();
  await expect.element(openScan).toHaveFocus();
});
