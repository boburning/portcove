import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { PortBrowser } from "../components/PortBrowser";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { workspace } from "../dev-scenarios/interactive/scenarios";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { portDefinition, portStatus } from "../test-fixtures";
import type { ExternalRuntimeRecord } from "../types";
import "../styles/index.css";

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
afterEach(async () => {
  await cleanup();
  document.getElementById("root")?.remove();
  transport?.dispose();
  transport = undefined;
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.style.removeProperty("font-size");
  delete document.documentElement.dataset.theme;
});

async function mount(theme = "dark", journey: "collection" | "collection-large" = "collection") {
  localStorage.clear();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  transport = installInteractiveTransport(journey, (message) => {
    throw Error(message);
  });
  initializeLocalization(["en"]);
  document.documentElement.dataset.theme = theme;
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect
    .poll(() => document.querySelectorAll(".collection-entry").length)
    .toBe(journey === "collection-large" ? 60 : 12);
  document.documentElement.dataset.theme = theme;
}

it("groups retrieval, preserves independent duplicate-port launch targets and states the Steam selection scope", async () => {
  await page.viewport(1366, 768);
  await mount();
  const launch = vi.spyOn(desktopApi, "launch");
  expect(document.querySelector(".library-query-tools #port-search")).not.toBeNull();
  expect(document.querySelector(".header-tools #port-search")).toBeNull();
  expect(document.body.textContent).toContain("12 entries · On this computer");
  const plays = page
    .getByRole("region", { name: "Library entries" })
    .getByRole("button", { name: "Play", exact: true });
  await plays.nth(0).click();
  await expect.poll(() => launch.mock.calls[0]).toEqual(["collection-0", "", 1]);
  await plays.nth(1).click();
  await expect.poll(() => launch.mock.calls[1]).toEqual(["collection-1", "", 1]);
  await page.getByRole("textbox", { name: "Search your library" }).fill("Super Mario 64");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  expect(document.body.textContent).toContain("2 of 12 library entries");
  const commands = document.querySelector<HTMLDetailsElement>(".library-query-tools details")!;
  commands.open = true;
  expect(commands.textContent).toContain("12 installed entries");
  expect(commands.textContent).toContain("hidden by filters");
  await page.getByRole("button", { name: "Clear search and filters", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  const more = page.getByRole("button", { name: /^More actions for/ }).first();
  await more.click();
  await userEvent.keyboard("{End}");
  await expect.element(page.getByRole("menuitem", { name: "Saves and storage" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(more).toHaveFocus();
});

it("plays the distinct duplicate port from details and returns to its filtered row", async () => {
  await page.viewport(1366, 768);
  await mount();
  const launch = vi.spyOn(desktopApi, "launch");
  const search = page.getByRole("textbox", { name: "Search your library" });
  await search.fill("Super Mario 64");
  await page.getByRole("button", { name: "Compact rows", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-row").length).toBe(2);
  const origin = document.querySelectorAll<HTMLElement>(".collection-identity")[1]!;
  const originId = origin.getAttribute("data-detail-origin");
  await page
    .getByRole("button", { name: /View details for Super Mario 64 Port: Mario modern port/ })
    .click();
  const detail = page.getByRole("region", { name: "Super Mario 64", exact: true });
  await expect
    .element(detail.getByText("Port project: Mario modern port · Modern renderer", { exact: true }))
    .toBeVisible();
  await detail.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => launch.mock.calls[0]).toEqual(["collection-1", "", 1]);
  await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
  await expect.element(search).toHaveValue("Super Mario 64");
  await expect.poll(() => document.querySelectorAll(".collection-row").length).toBe(2);
  await expect
    .poll(() => document.activeElement?.getAttribute("data-detail-origin"))
    .toBe(originId);
});

it("names discovery cards by distinguishing identity and keeps state in their descriptions", async () => {
  await page.viewport(1366, 768);
  await mount();
  await page.getByRole("button", { name: "Find games", exact: true }).click();
  const card = page.getByRole("button", {
    name: "View details for Super Mario 64 · Mario modern port · Modern renderer",
    exact: true,
  });
  await expect.element(card).toHaveAccessibleDescription(/Ready to play.*Stable/);
  const element = card.element();
  expect(element.textContent?.match(/Modern renderer/g)).toHaveLength(1);
  expect(
    element.querySelector(".collection-actions")!.getBoundingClientRect().bottom,
  ).toBeLessThanOrEqual(innerHeight);
  await card.click();
  await expect
    .element(page.getByText("Port project: Mario modern port · Modern renderer", { exact: true }))
    .toBeVisible();
});

it("keeps Favorites in the entry menu and restores filter focus when its last result disappears", async () => {
  await page.viewport(1366, 768);
  await mount();
  const favorite = vi.spyOn(desktopApi, "setPortFavorite");
  const more = page.getByRole("button", {
    name: "More actions for Super Mario 64 · sm64-port",
    exact: true,
  });
  await more.click();
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("menuitem", { name: "Add to favorites", exact: true }))
    .toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => favorite.mock.calls[0]).toEqual(["collection-0", true, 1]);
  const filter = page.getByRole("button", { name: "Favorites (1)", exact: true });
  await filter.click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(1);
  await more.click();
  await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(0);
  await expect
    .element(page.getByRole("button", { name: "Favorites (0)", exact: true }))
    .toHaveFocus();
  expect(favorite.mock.calls[1]).toEqual(["collection-0", false, 1]);
});

it("shares the narrow filter row without losing query, independent readiness or view controls", async () => {
  await page.viewport(320, 768);
  await mount("light");
  const search = page.getByRole("textbox", { name: "Search your library" });
  await search.fill("Super Mario 64");
  const favorites = page.getByRole("button", { name: "Favorites (0)", exact: true }).element();
  const filters = page.getByRole("button", { name: "Filters (0)", exact: true }).element();
  expect(
    Math.abs(favorites.getBoundingClientRect().top - filters.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Compact rows", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-row").length).toBe(2);
  await expect.element(search).toHaveValue("Super Mario 64");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
});

it("keeps compatibility facts visible while disclosing project history on detail", async () => {
  await page.viewport(1366, 768);
  await mount();
  await page
    .getByRole("button", { name: "View details for Super Mario 64 Port: sm64-port", exact: true })
    .click();
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const disclosure = page.getByText("Project and compatibility details", { exact: true });
  expect(disclosure.element().closest("details")?.open).toBe(false);
  await disclosure.click();
  await expect.element(page.getByText("Upstream project", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("heading", { name: "Recorded checks", exact: true }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("No current check");
});

it("reopens Last played and restores its exact details trigger after Back", async () => {
  await page.viewport(1366, 768);
  const snapshot = workspace("collection");
  snapshot.statuses[0]!.last_launched_at = 1;
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  await mount();
  await page.getByText("Last played", { exact: true }).first().click();
  const origin = '[data-detail-origin="library:continue-details:collection-0"]';
  await page.getByRole("button", { name: "View details", exact: true }).click();
  await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
  await expect.poll(() => document.activeElement?.matches(origin)).toBe(true);
  const target = document.querySelector<HTMLElement>(origin)!;
  expect(target.closest("details")?.open).toBe(true);
  expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
});

for (const theme of ["dark", "light"]) {
  it(`keeps ${theme} scrolled row action focus and browsing context through live resizing`, async () => {
    await page.viewport(1366, 768);
    await mount(theme, "collection-large");
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    await page.getByRole("textbox", { name: "Search your library" }).fill("a");
    const count = document.querySelectorAll(".collection-entry").length;
    const action = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".collection-actions button[data-variant=primary]",
      ),
    ].at(-1)!;
    action.focus();
    action.scrollIntoView({ block: "center" });
    const main = document.querySelector<HTMLElement>(".app-shell > main")!;
    expect(main.scrollTop).toBeGreaterThan(0);
    for (const [width, height] of [
      [1920, 1080],
      [960, 640],
      [1366, 768],
    ]) {
      await page.viewport(width!, height!);
      expect(document.activeElement).toBe(action);
      expect(document.querySelectorAll(".collection-row")).toHaveLength(count);
      expect((document.getElementById("port-search") as HTMLInputElement).value).toBe("a");
      expect(Math.abs(main.getBoundingClientRect().right - innerWidth)).toBeLessThanOrEqual(1);
      expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
      expect(getComputedStyle(main).overflowY).toBe("auto");
      action.scrollIntoView({ block: "nearest" });
      const box = action.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(innerHeight + 1);
    }
  });

  it(`connects enlarged ${theme} row identity and readiness without an inset in a separate column`, async () => {
    await page.viewport(1366, 768);
    document.documentElement.style.fontSize = "200%";
    await mount(theme);
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    const row = document.querySelector<HTMLElement>(".collection-row")!;
    const identity = row.querySelector<HTMLElement>(".collection-identity")!;
    const state = row.querySelector<HTMLElement>(".collection-state")!;
    const ready = state.querySelector<HTMLElement>(".readiness")!;
    expect(getComputedStyle(document.documentElement).fontSize).toBe("32px");
    expect(ready.textContent).toContain("Ready to play");
    const range = document.createRange();
    range.selectNodeContents(ready.lastChild!);
    expect(range.getClientRects()).toHaveLength(1);
    const inset = parseFloat(getComputedStyle(state).paddingInlineStart);
    expect(
      inset === 0 || state.getBoundingClientRect().top >= identity.getBoundingClientRect().bottom,
    ).toBe(true);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  });
}

it("keeps an unknown external record distinct from managed readiness and reviews its stable port", async () => {
  const port = portDefinition();
  const record: ExternalRuntimeRecord = {
    id: "external-observed",
    port_id: port.id,
    path: "C:\\Player\\External",
    executable: "C:\\Player\\External\\game.exe",
    version: "1",
    platform: "windows-x86-64",
    archive_sha256: "a".repeat(64),
    immutable_tree_sha256: "b".repeat(64),
    registered_at: 1,
  };
  const status = { ...portStatus(), external_runtime: record };
  const select = vi.fn(),
    launch = vi.fn();
  await render(
    <PortBrowser
      view="library"
      ports={[port]}
      statuses={new Map([[port.id, status]])}
      overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
      filter="all"
      setFilter={() => {}}
      onSelect={select}
      onContinue={launch}
      loading={false}
    />,
  );
  expect(document.querySelector(".collection-state")?.textContent).toContain(
    "Readiness unavailable",
  );
  expect(page.getByRole("button", { name: "Play", exact: true }).query()).toBeNull();
  await page.getByRole("button", { name: /^Review game:/ }).click();
  expect(select).toHaveBeenCalledWith(port.id, `library:card:${port.id}:review`);
  expect(status.external_runtime).toBe(record);
  expect(status.active).toBeNull();
  expect(record.path).toBe("C:\\Player\\External");
  expect(launch).not.toHaveBeenCalled();
});

for (const theme of ["dark", "light"]) {
  it(`keeps enlarged ${theme} catalog artwork bounded with visible distinguishing identity`, async () => {
    await page.viewport(1366, 768);
    await mount(theme);
    await page.getByRole("button", { name: "Find games", exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".card-art").length).toBe(12);
    const artwork = document.querySelector<HTMLElement>(".card-art")!;
    const ordinary = artwork.getBoundingClientRect();
    document.documentElement.style.fontSize = "32px";
    await expect
      .poll(() => artwork.getBoundingClientRect().width)
      .toBeLessThanOrEqual(ordinary.width);
    const enlarged = artwork.getBoundingClientRect();
    expect(enlarged.height / enlarged.width).toBeCloseTo(1.5);
    const card = artwork.closest<HTMLButtonElement>(".port-card")!;
    const workspace = card.closest<HTMLElement>("main")!;
    // Header and filter controls may wrap; reveal the card in its scrolling workspace.
    card.scrollIntoView({ block: "start", inline: "nearest" });
    const viewport = workspace.getBoundingClientRect();
    const visibleTop = Math.max(0, viewport.top);
    const visibleBottom = Math.min(innerHeight, viewport.bottom);
    const title = card.querySelector("h2")!;
    const project = card.querySelector<HTMLElement>(".card-content > p")!;
    for (const identity of [title, project]) {
      const bounds = identity.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(visibleTop);
      expect(bounds.bottom).toBeLessThanOrEqual(visibleBottom);
    }
    expect(project.textContent).toContain("sm64-port");
    expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth + 1);
    expect(card.textContent).toContain("Super Mario 64");
    expect(card.textContent).toContain("sm64-port");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    const otherPort = [...document.querySelectorAll<HTMLButtonElement>("button.port-card")].find(
      (button) => button.textContent?.includes("Mario modern port"),
    )!;
    otherPort.focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() =>
        document.querySelector("[data-detail-port-id]")?.getAttribute("data-detail-port-id"),
      )
      .toBe("collection-1");
    await page.getByRole("button", { name: "Back to previous workspace", exact: true }).click();
    await expect.poll(() => document.activeElement?.textContent).toContain("Mario modern port");
    expect(document.activeElement?.getAttribute("data-detail-origin")).toBe(
      "catalog:card:collection-1",
    );
  });
}
