import { captureParityState } from "../../test/parity-capture";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import {
  navigationScope,
  focusableControls,
  cyclePrimaryNavigation,
  dismissActiveDialog,
} from "../focus";
import { controlledAct as act } from "../../test/controlled-react-act";
import { desktopApi } from "../api";
import { PortBrowser } from "../components/PortBrowser";
import {
  discoverGroupForPort,
  inspectLibraryGroups,
  mountLibraryPort,
  inspectDiscoverGroups,
  mountDiscoverPort,
} from "./discover-test-helpers";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { workspace } from "../dev-scenarios/interactive/scenarios";
import { initializeLocalization, LocalizationProvider } from "../localization";
import { portDefinition, portStatus } from "../test-fixtures";
import type { ExternalRuntimeRecord, PortListing } from "../types";
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
  document.documentElement.style.removeProperty("zoom");
  delete document.documentElement.dataset.theme;
});

async function mount(
  theme = "dark",
  journey: "collection" | "collection-large" = "collection",
  expectedLibraryEntries = journey === "collection-large" ? 60 : 12,
  seed?: () => Promise<void>,
) {
  localStorage.clear();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  transport = installInteractiveTransport(journey, (message) => {
    throw Error(message);
  });
  await seed?.();
  initializeLocalization(["en"]);
  document.documentElement.dataset.theme = theme;
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );
  await expect
    .poll(() =>
      Number(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")),
    )
    .toBe(expectedLibraryEntries);
  document.documentElement.dataset.theme = theme;
}

function groupedCollectionSnapshot() {
  const snapshot = workspace("collection");
  for (const port of snapshot.catalog.ports.slice(0, 2)) {
    port.presentation = {
      ...port.presentation!,
      original_game: {
        format_version: 1,
        id: "fixture-super-mario-64",
        evidence_urls: ["https://example.com/fixture/super-mario-64"],
        source_editions: [],
      },
    };
  }
  return snapshot;
}

function expectContainedCover(card: HTMLElement) {
  const art = card.querySelector<HTMLElement>(".collection-art")!;
  const bounds = art.getBoundingClientRect();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height / bounds.width).toBeCloseTo(1.5, 2);
  for (const image of art.querySelectorAll("img")) {
    const imageBounds = image.getBoundingClientRect();
    expect(imageBounds.left).toBeGreaterThanOrEqual(bounds.left - 1);
    expect(imageBounds.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(imageBounds.top).toBeGreaterThanOrEqual(bounds.top - 1);
    expect(imageBounds.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
  }
}

function expectBoundsInViewport(element: HTMLElement) {
  const bounds = element.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(innerWidth);
}

async function focusFooterControlsInViewport(card: HTMLElement) {
  const controls = [
    ...card.querySelectorAll<HTMLButtonElement>(".library-entry-footer button"),
  ].filter((control) => !control.matches(":disabled,[aria-disabled=true]"));
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    control.focus();
    await expect.element(page.elementLocator(control)).toHaveFocus();
    const bounds = control.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth + 1);
  }
  const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
}

it("leaves more room for a long row identity than its status and actions at 960px", async () => {
  await page.viewport(960, 640);
  await mount();
  await page.getByRole("button", { name: "Compact rows", exact: true }).click();
  const row = document.querySelector<HTMLElement>(".collection-row")!;
  const identity = row.querySelector<HTMLElement>(".collection-main")!;
  const footer = row.querySelector<HTMLElement>(".library-entry-footer")!;

  expect(identity.getBoundingClientRect().width).toBeGreaterThan(
    footer.getBoundingClientRect().width,
  );
});

it.each([
  ["dark", 390],
  ["light", 390],
  ["dark", 320],
  ["light", 320],
] as const)(
  "keeps compact %s/%ipx Library game-led and restores its heading intake action",
  async (theme, width) => {
    await page.viewport(width, 844);
    const snapshot = workspace("collection");
    snapshot.statuses[0]!.last_launched_at = 1;
    snapshot.statuses[0]!.successful_launches = 1;
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    await mount(theme);
    await expect
      .poll(() => {
        const cover = document
          .querySelector<HTMLElement>(".collection-art")!
          .getBoundingClientRect();
        return Math.max(0, Math.min(innerHeight, cover.bottom) - Math.max(0, cover.top));
      })
      .toBeGreaterThanOrEqual(160);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
    await page.screenshot({
      path: `../../../../outputs/ui-refinement/continue-${theme}-${width}-100.png`,
    });
    const add = document.querySelector<HTMLButtonElement>(
      "[data-library-header] [data-add-games-trigger]",
    )!;
    expect(add).not.toBeNull();
    add.focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("heading", { name: "Add games", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Back to Library", exact: true }).click();
    await expect
      .poll(() => document.activeElement?.hasAttribute("data-add-games-trigger"))
      .toBe(true);
  },
);

it.each(["dark", "light"])(
  "keeps the production Continue strip and toolbar reachable at 130%% interface zoom in %s",
  async (theme) => {
    await page.viewport(740, 960);
    document.documentElement.style.zoom = "1.3";
    const snapshot = workspace("collection");
    snapshot.statuses[0]!.last_launched_at = 1;
    snapshot.statuses[0]!.successful_launches = 1;
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    await mount(theme);
    const continuation = page.getByRole("region", { name: /^Continue / });
    await expect.element(continuation).toBeVisible();
    await expect
      .element(continuation.getByRole("button", { name: "Continue playing", exact: true }))
      .toBeEnabled();
    await expect
      .poll(() => {
        const image = continuation
          .element()
          .querySelector<HTMLImageElement>(".game-hero-foreground img");
        return Boolean(image?.complete && image.naturalWidth > 0);
      })
      .toBe(true);
    expect(document.querySelectorAll(".continue-card")).toHaveLength(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    await page.screenshot({
      path: `../../../../outputs/ui-refinement/continue-${theme}-740-interface-130.png`,
    });
    await page.getByRole("button", { name: "Filters (0)", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .poll(() => document.activeElement)
      .toBe(page.getByRole("button", { name: "Filters (0)", exact: true }).element());
  },
);

it("groups retrieval, preserves independent duplicate-port launch targets and states the Steam selection scope", async () => {
  await page.viewport(1366, 768);
  await mount();
  const launch = vi.spyOn(desktopApi, "launch");
  expect(document.querySelector(".library-query-tools #port-search")).not.toBeNull();
  expect(document.querySelector(".header-tools #port-search")).toBeNull();
  expect(document.body.textContent).toContain("12 in your library");
  const portCard = (id: string) =>
    page.elementLocator(
      document
        .querySelector(`[data-detail-game-id="${id}"]`)!
        .closest<HTMLElement>(".collection-entry")!,
    );
  await portCard("collection-0")
    .getByRole("button", { name: /^Play: / })
    .click();
  await expect.poll(() => launch.mock.calls[0]).toEqual(["collection-0", "", 1]);
  await portCard("collection-1")
    .getByRole("button", { name: /^Play: / })
    .click();
  await expect.poll(() => launch.mock.calls[1]).toEqual(["collection-1", "", 1]);
  await page.getByRole("textbox", { name: "Search your library" }).fill("Super Mario 64");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  const summary = document.querySelector(".collection-result-summary")!;
  expect(summary.textContent).toContain("2 of 12 in your library");
  expect(document.querySelectorAll('[role="status"][aria-label="Search results"]')).toHaveLength(1);
  expect(document.querySelectorAll(".collection-result-summary")).toHaveLength(1);
  expect(document.querySelectorAll(".collection-result-summary button")).toHaveLength(1);
  await page.getByRole("button", { name: "Create your first collection", exact: true }).click();
  const commands = page.getByText("Library tools", { exact: true }).element().closest("details")!;
  commands.open = true;
  expect(commands.textContent).toContain("12 installed entries");
  expect(commands.textContent).toContain("hidden by filters");
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect
    .poll(() =>
      Number(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")),
    )
    .toBe(12);
  const more = page.getByRole("button", { name: /^More actions for/ }).first();
  await more.click();
  await expect.element(page.getByRole("menu", { name: /^More actions for/ })).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(page.getByRole("menuitem", { name: "Saves & backups" })).toHaveFocus();
  await captureParityState("card-overflow-keyboard-focus");
  await userEvent.keyboard("{Escape}");
  await expect.element(more).toHaveFocus();
});

it.each([
  ["dark", 1440, 100],
  ["light", 740, 100],
  ["dark", 390, 100],
  ["dark", 340, 100],
  ["dark", 240, 100],
  ["light", 320, 200],
  ["light", 960, 200],
] as const)(
  "keeps %s rows grouped and contained at %ipx with %i%% text",
  async (theme, width, scale) => {
    await page.viewport(width, 1000);
    await mount(theme);
    document.documentElement.style.fontSize = `${scale}%`;
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    const row = document.querySelector<HTMLElement>(".collection-row")!;
    const art = row.querySelector<HTMLElement>(".collection-art")!.getBoundingClientRect();
    expect(art.width).toBeCloseTo(40, 0);
    expect(art.height).toBeCloseTo(60, 0);
    const list = row.closest<HTMLElement>(".collection-rows")!;
    expect(list.getBoundingClientRect().width).toBeLessThanOrEqual(1121);
    const footer = row.querySelector<HTMLElement>(".library-entry-footer")!;
    expect(getComputedStyle(footer).display).toBe("flex");
    const identity = row.querySelector<HTMLElement>(".collection-identity")!;
    const chips = row.querySelector<HTMLElement>(".library-entry-chips")!;
    expect(identity.querySelector(".library-entry-chips")).toBeNull();
    expect(identity.querySelector("button, a, [tabindex]")).toBeNull();
    expect(chips.parentElement).toBe(identity.parentElement);
    const factsFitDetails =
      !CSS.supports("grid-template-rows", "subgrid") ||
      identity.getBoundingClientRect().bottom + 1 >= chips.getBoundingClientRect().bottom;
    expect(factsFitDetails).toBe(true);
    expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth + 1);
    const personal = row.querySelector<HTMLElement>(".collection-personal-actions")!;
    const controls = personal.getBoundingClientRect();
    const action = footer.getBoundingClientRect();
    expect(
      controls.right <= action.left + 1 ||
        action.right <= controls.left + 1 ||
        controls.bottom <= action.top + 1 ||
        action.bottom <= controls.top + 1,
    ).toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width + 1);
    await expect
      .element(
        page.elementLocator(
          row.querySelector<HTMLButtonElement>(".collection-personal-actions button")!,
        ),
      )
      .toBeVisible();
  },
);

it.each(["dark", "light"])(
  "keeps compact %s quick views on one row with accessible hidden counts",
  async (theme) => {
    await page.viewport(380, 844);
    await mount(theme);
    const group = page.getByRole("radiogroup", { name: "Library quick views", exact: true });
    const controls = [...group.element().querySelectorAll<HTMLButtonElement>("button")];
    expect(controls).toHaveLength(4);
    for (const control of controls) {
      expect(control.getBoundingClientRect().top).toBeCloseTo(
        controls[0]!.getBoundingClientRect().top,
        0,
      );
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await expect
      .element(group.getByRole("radio", { name: "All", exact: true }))
      .toHaveAccessibleDescription("Every game in this library scope. 12 games");
    await expect
      .element(group.getByRole("radio", { name: "Needs attention", exact: true }))
      .toHaveAccessibleDescription(/Games that need setup, files or repair/);
    expect(getComputedStyle(group.element().querySelector(".browse-count")!).display).toBe("none");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    await page.getByRole("button", { name: "Manage collections", exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Collection name", exact: true }))
      .toBeVisible();
  },
);

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
    .getByRole("button", { name: /View details for Super Mario 64 Mario modern port/ })
    .click();
  const detail = page.getByRole("region", { name: "Super Mario 64", exact: true });
  await expect
    .element(detail.getByText("Mario modern port · Modern renderer", { exact: true }))
    .toBeVisible();
  await detail.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => launch.mock.calls[0]).toEqual(["collection-1", "", 1]);
  await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
  await expect.element(search).toHaveValue("Super Mario 64");
  await expect.poll(() => document.querySelectorAll(".collection-row").length).toBe(2);
  await expect
    .poll(() => document.activeElement?.getAttribute("data-detail-origin"))
    .toBe(originId);
});

it("names exact port choices from their visible identity and readiness inside grouped Discover", async () => {
  await page.viewport(1366, 768);
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(groupedCollectionSnapshot());
  await mount("dark", "collection", 11);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const group = discoverGroupForPort("collection-1");
  expect(JSON.parse(group.dataset.discoverPortIds!)).toEqual(["collection-0", "collection-1"]);
  expect(document.querySelectorAll("[data-discover-port-ids]")).toHaveLength(11);
  await expect
    .element(page.getByRole("status", { name: "Search results", exact: true }))
    .toHaveTextContent("11 games");
  await userEvent.click(group.querySelector<HTMLButtonElement>(".discover-game-identity")!);
  const dialog = page.getByRole("dialog", { name: "Super Mario 64", exact: true });
  await expect.element(dialog).toBeVisible();
  const choice = document.querySelector<HTMLButtonElement>(
    '[data-discover-port-id="collection-1"]',
  )!;
  const row = choice.closest("article")!;
  await expect
    .element(row)
    .toHaveAccessibleName(/Super Mario 64.*Mario modern port.*Ready to play/);
  expect(row.querySelectorAll("h3")).toHaveLength(1);
  await expect
    .element(row.querySelector("h3")!)
    .toHaveTextContent("Mario modern port · Modern renderer");
  await expect
    .element(
      dialog.getByRole("button", {
        name: "Choose Mario modern port · Modern renderer",
        exact: true,
      }),
    )
    .toBeEnabled();
  await expect.element(row).toMatchTextContent("Stable");
  choice.scrollIntoView({ block: "nearest" });
  expect(choice.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
  await userEvent.click(choice);
  // The opened installation names the port in its identity link; the still-mounted
  // choice button names it too, so select the link by role rather than bare text.
  await expect
    .element(page.getByRole("link", { name: "Mario modern port · Modern renderer", exact: true }))
    .toBeVisible();
  expect(document.querySelector("[data-detail-port-id]")?.getAttribute("data-detail-port-id")).toBe(
    "collection-1",
  );
});

it("keeps artwork favorites separate from details and restores filter focus when its last result disappears", async () => {
  await page.viewport(1366, 768);
  await mount();
  const favorite = vi.spyOn(desktopApi, "changeOrganization");
  const toggle = page.getByRole("button", {
    name: "Favorite Super Mario 64 · sm64-port",
    exact: true,
  });
  const button = toggle.element();
  expect(button.closest(".collection-identity")).toBeNull();
  const cover = button
    .closest("article")!
    .querySelector(".collection-art")!
    .getBoundingClientRect();
  const bounds = button.getBoundingClientRect();
  expect(bounds.right).toBeLessThanOrEqual(cover.right);
  expect(bounds.top).toBeGreaterThanOrEqual(cover.top);
  expect(bounds.width).toBeGreaterThanOrEqual(32);
  button.focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .poll(() => favorite.mock.calls[0]?.[1])
    .toMatchObject({ kind: "set_saved_group", saved: true });
  const filter = page.getByRole("radio", { name: "Favorites 1 game", exact: true });
  await filter.click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(1);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await captureParityState("library-favorites");
  toggle.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(0);
  await expect
    .element(page.getByRole("radio", { name: "Favorites 0 games", exact: true }))
    .toHaveFocus();
  expect(favorite.mock.calls[1]?.[1]).toMatchObject({ kind: "set_saved_group", saved: false });
});

it("shares the narrow filter row without losing query, independent readiness or view controls", async () => {
  await page.viewport(320, 768);
  await mount("light");
  const search = page.getByRole("textbox", { name: "Search your library" });
  await search.fill("Super Mario 64");
  const favorites = page.getByRole("radio", { name: "Favorites 0 games", exact: true }).element();
  const filters = page.getByRole("button", { name: "Filters (0)", exact: true }).element();
  expect(favorites.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    search.element().getBoundingClientRect().top,
  );
  expect(filters.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    search.element().getBoundingClientRect().bottom,
  );
  await page.getByRole("button", { name: "Compact rows", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-row").length).toBe(2);
  await expect.element(search).toHaveValue("Super Mario 64");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
});

it("keeps compatibility facts visible while disclosing project history on detail", async () => {
  await page.viewport(1366, 768);
  await mount();
  await page
    .getByRole("button", { name: "View details for Super Mario 64 sm64-port", exact: true })
    .click();
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const disclosure = page.getByText("Project status and release information", { exact: true });
  expect(disclosure.element().closest("details")?.open).toBe(false);
  await disclosure.click();
  await expect.element(page.getByText("Upstream project", { exact: true })).toBeVisible();
  await page.getByText("Test results", { exact: true }).click();
  await expect.element(page.getByText(/^These are earlier test results\./)).toBeVisible();
  expect(document.body.textContent).not.toContain("No current check");
});

it("opens Continue playing details and restores its exact trigger after Back", async () => {
  await page.viewport(1366, 768);
  const snapshot = workspace("collection");
  snapshot.statuses[0]!.last_launched_at = 1;
  snapshot.statuses[0]!.successful_launches = 1;
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  await mount();
  await expect
    .element(page.getByRole("button", { name: "Continue playing", exact: true }))
    .toBeVisible();
  const origin = '[data-detail-origin="library:continue-details:collection-0"]';
  await page.getByRole("button", { name: "Game details", exact: true }).click();
  await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
  await expect.poll(() => document.activeElement?.matches(origin)).toBe(true);
  const target = document.querySelector<HTMLElement>(origin)!;
  expect(target.closest(".continue-card")).not.toBeNull();
  expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
});

it.each([
  { theme: "dark", width: 390, text: "100%" },
  { theme: "light", width: 390, text: "100%" },
  { theme: "dark", width: 640, text: "200%" },
  { theme: "light", width: 640, text: "200%" },
])(
  "keeps unbroken Continue identity and Play reachable in $theme at $width with $text text",
  async ({ theme, width, text }) => {
    await page.viewport(width, 780);
    document.documentElement.style.fontSize = text;
    const snapshot = workspace("collection");
    const port = snapshot.catalog.ports[0]!;
    const title =
      "The Very Long Voyage Beyond the Northern Sea — Édition complète / 完全版 " +
      "UnbrokenIdentity".repeat(12);
    const project = "Community project " + "UnbrokenProject".repeat(12);
    port.name = project;
    port.presentation = { ...port.presentation!, original_game_title: title };
    snapshot.statuses[0]!.last_launched_at = 1;
    snapshot.statuses[0]!.successful_launches = 1;
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    const launch = vi
      .spyOn(desktopApi, "launch")
      .mockResolvedValue({ processId: null, sessionId: "compact-identity-return" });
    await mount(theme);
    const continuation = page.getByRole("region", {
      name: `Continue ${title} · ${project}`,
      exact: true,
    });
    await expect.element(continuation).toBeVisible();
    await expect
      .element(continuation.getByRole("heading", { name: title, exact: true }))
      .toHaveAccessibleName(title);
    await expect
      .element(continuation.getByText(project, { exact: true }))
      .toHaveTextContent(project);
    const identity = continuation.element().querySelector<HTMLElement>(".continue-identity")!;
    expect(identity.scrollWidth).toBeLessThanOrEqual(identity.clientWidth + 1);
    for (const layout of ["Covers", "Compact rows"]) {
      await page.getByRole("button", { name: layout, exact: true }).click();
      await mountLibraryPort(port.id);
      document.querySelector<HTMLButtonElement>(`[data-detail-game-id="${port.id}"]`)!.focus();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
      expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    }
    await continuation.getByRole("button", { name: "Game details", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: title, exact: true }))
      .toHaveAccessibleName(title);
    await expect.element(page.getByText(project, { exact: true })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
    const play = continuation.getByRole("button", { name: "Continue playing", exact: true });
    await expect.element(play).toBeEnabled();
    play.element().scrollIntoView({ block: "nearest" });
    const bounds = play.element().getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth + 1);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
    play.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => launch.mock.calls).toEqual([[port.id, "", 1]]);
  },
  // This complete long-identity journey includes both layouts, detail/return and
  // keyboard launch. The retained cold-run15s failures exhausted the outer case
  // budget before View details/return; action deadlines and assertions are unchanged.
  45_000,
);

for (const theme of ["dark", "light"]) {
  it(`keeps ${theme} scrolled row action focus and browsing context through live resizing`, async () => {
    await page.viewport(1366, 768);
    await mount(theme, "collection-large");
    await page.getByRole("button", { name: "Compact rows", exact: true }).click();
    await page.getByRole("textbox", { name: "Search your library" }).fill("a");
    // The native input value changes before React commits the raw query. Wait for
    // its real clear control before starting a destination scoped to that query.
    await expect
      .element(page.getByRole("button", { name: "Clear search", exact: true }))
      .toBeVisible();
    const expectedCount = Number(
      document.querySelector("[data-library-port-ids]")!.getAttribute("aria-setsize"),
    );
    await mountLibraryPort("collection-59");
    const action = document.querySelector<HTMLButtonElement>(
      '[data-detail-origin="library:card:collection-59:play"]',
    )!;
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
      expect(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")).toBe(
        String(expectedCount),
      );
      expect(document.querySelectorAll(".collection-row").length).toBeLessThan(expectedCount);
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
    "Can't check right now",
  );
  expect(page.getByRole("button", { name: /^Play/ }).query()).toBeNull();
  await page.getByRole("button", { name: /^View details:/ }).click();
  expect(select).toHaveBeenCalledWith(port.id, `library:card:${port.id}:review`);
  expect(status.external_runtime).toBe(record);
  expect(status.active).toBeNull();
  expect(record.path).toBe("C:\\Player\\External");
  expect(launch).not.toHaveBeenCalled();
});

for (const theme of ["dark", "light"]) {
  it(`keeps enlarged ${theme} grouped Discover artwork bounded and exact port identity reachable`, async () => {
    await page.viewport(1366, 768);
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(groupedCollectionSnapshot());
    await mount(theme, "collection", 11);
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".collection-art").length).toBe(11);
    const ordinary = discoverGroupForPort("collection-1")
      .querySelector<HTMLElement>(".collection-art")!
      .getBoundingClientRect();
    document.documentElement.style.fontSize = "32px";
    // Font reflow can replace complete virtual rows. Wait for current DOM to
    // settle, then resolve the logical group instead of retaining its old node.
    await expect
      .poll(async () => {
        const group = discoverGroupForPort("collection-1");
        const artwork = group.querySelector<HTMLElement>(".collection-art")!;
        const before = artwork.getBoundingClientRect();
        await act(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        const after = artwork.getBoundingClientRect();
        return (
          artwork.isConnected &&
          group === discoverGroupForPort("collection-1") &&
          before.width === after.width &&
          before.height === after.height &&
          after.width > 0 &&
          after.width <= Math.max(ordinary.width, 260)
        );
      })
      .toBe(true);
    const group = await mountDiscoverPort("collection-1");
    const artwork = group.querySelector<HTMLElement>(".collection-art")!;
    expect(artwork.getBoundingClientRect().width).toBeLessThanOrEqual(
      Math.max(ordinary.width, 260),
    );
    expect(
      artwork.getBoundingClientRect().height / artwork.getBoundingClientRect().width,
    ).toBeCloseTo(1.5);
    const identity = group.querySelector<HTMLButtonElement>(".discover-game-identity")!;
    const workspace = group.closest<HTMLElement>("main")!;
    identity.scrollIntoView({ block: "start", inline: "nearest" });
    const viewport = workspace.getBoundingClientRect();
    const visibleTop = Math.max(0, viewport.top);
    const visibleBottom = Math.min(innerHeight, viewport.bottom);
    const title = identity.querySelector(".collection-title")!;
    const project = identity.querySelector<HTMLElement>(".collection-project")!;
    for (const item of [title, project]) {
      const bounds = item.getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(visibleTop);
      expect(bounds.bottom).toBeLessThanOrEqual(visibleBottom);
    }
    expect(project.textContent).toContain("2 separate port projects");
    expect(identity.textContent).toContain("Super Mario 64");
    expect(identity.querySelectorAll("button")).toHaveLength(0);
    expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    identity.focus();
    await userEvent.keyboard("{Enter}");
    const comparison = page.getByRole("dialog", { name: "Super Mario 64", exact: true });
    await expect.element(comparison).toBeVisible();
    const exactPort = comparison
      .element()
      .querySelector<HTMLButtonElement>('[data-discover-port-id="collection-1"]')!;
    expect(exactPort.closest("article")?.textContent).toContain(
      "Mario modern port · Modern renderer",
    );
    exactPort.focus();
    await userEvent.keyboard("{Enter}");
    await expect
      .poll(() =>
        document.querySelector("[data-detail-port-id]")?.getAttribute("data-detail-port-id"),
      )
      .toBe("collection-1");
    await page.getByRole("button", { name: /^Back to (Library|Discover)$/, exact: true }).click();
    await expect
      .poll(() => document.activeElement?.getAttribute("data-detail-origin"))
      .toBe("catalog:card:collection-0");
  });
}

it("keeps Collections inside the shared controller scope and returns Back and Escape to its opener", async () => {
  await page.viewport(1200, 900);
  await mount();
  const opener = page.getByRole("button", { name: "Create your first collection", exact: true });
  await opener.click();
  const scope = navigationScope();
  expect(scope).not.toBe(document);
  expect(focusableControls().length).toBeGreaterThan(0);
  expect(focusableControls().every((control) => scope.contains(control))).toBe(true);
  await captureParityState("collection-editor");
  const active = document.activeElement;
  cyclePrimaryNavigation(1);
  expect(document.activeElement).toBe(active);
  await act(async () => {
    expect(dismissActiveDialog()).toBe(true);
  });
  await expect.element(opener).toHaveFocus();
  await expect.poll(() => navigationScope()).toBe(document);
  await opener.click();
  await userEvent.keyboard("{Escape}");
  await expect.element(opener).toHaveFocus();
  await expect.poll(() => navigationScope()).toBe(document);
});

it("keeps a sidebar collection selected through detail return and compact navigation", async () => {
  await page.viewport(1440, 900);
  vi.spyOn(desktopApi, "organizationPreferences").mockResolvedValue({
    revision: 0,
    followed_port_ids: [],
    followed_release_acknowledgments: {},
    collections: {
      favorites: { name: "Weekend games", port_ids: ["collection-0", "collection-1"] },
    },
    hidden_port_ids: [],
    saved_game_ids: [],
    update_notices: {},
    setup_confirmations: [],
  });
  await mount();
  const collection = page.getByRole("button", { name: "Collection: Weekend games", exact: true });
  await expect.element(collection).toBeVisible();
  await collection.click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  await expect.element(collection).toHaveAttribute("aria-pressed", "true");
  await captureParityState("library-selected-collection");
  const identity = document.querySelector<HTMLButtonElement>(
    '[data-detail-game-id="collection-0"]',
  )!;
  await userEvent.click(identity);
  await expect
    .element(page.getByRole("button", { name: "Back to Library", exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  await expect.element(collection).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => document.activeElement?.getAttribute("data-detail-game-id"))
    .toBe("collection-0");
  const collectionElement = collection.element();
  await page.viewport(740, 900);
  await expect.element(collectionElement).not.toBeVisible();
  const compact = page.getByRole("button", { name: "Manage collections", exact: true });
  await expect.element(compact).toBeVisible();
  await compact.click();
  await expect
    .element(page.getByRole("button", { name: "Weekend games (2)", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await captureParityState("compact-collection-picker");
  await userEvent.keyboard("{Escape}");
  await expect.element(compact).toHaveFocus();
});

it("keeps a singleton port review readable below its close control at narrow width", async () => {
  await page.viewport(320, 844);
  await mount();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Why this port?", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect
    .element(dialog.getByText("Review this port’s setup requirements and reports."))
    .toBeVisible();
  const close = dialog
    .getByRole("button", { name: "Close", exact: true })
    .element()
    .getBoundingClientRect();
  const description = dialog
    .element()
    .querySelector<HTMLElement>("[data-slot=dialog-description]")!;
  const range = document.createRange();
  range.selectNodeContents(description);
  for (const line of range.getClientRects()) {
    expect(line.right <= close.left || line.top >= close.bottom || line.bottom <= close.top).toBe(
      true,
    );
  }
  expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
  await dialog.getByText("Comparison options and reports", { exact: true }).click();
  await expect.element(dialog.getByRole("region", { name: "Comparison options" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Why this port?", exact: true }).first())
    .toHaveFocus();
});

it.each([
  ["dark", false],
  ["light", false],
  ["dark", true],
  ["light", true],
] as const)(
  "keeps short-window %s Covers actionable with several entries (grouped: %s)",
  async (theme, grouped) => {
    await page.viewport(960, 640);
    const snapshot = workspace("collection-large");
    const first = snapshot.catalog.ports[0]!;
    first.name = "Harbor Adventure Community Edition";
    first.presentation!.original_game_title = "Harbor Adventure and the Forgotten Islands";
    if (grouped) {
      for (const port of snapshot.catalog.ports.slice(0, 2)) {
        port.presentation!.original_game = {
          format_version: 1,
          id: "fixture-super-mario-64",
          evidence_urls: ["https://example.com/fixture/super-mario-64"],
          source_editions: [],
        };
      }
    }
    snapshot.statuses = snapshot.statuses.slice(0, grouped ? 4 : 3);
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    await mount(theme, "collection-large", 3);
    const cards = [...document.querySelectorAll<HTMLElement>(".collection-cover")];
    const firstTop = cards[0]!.getBoundingClientRect().top;
    const firstRow = cards.filter(
      (card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 1,
    );
    expect(firstRow.length).toBeGreaterThanOrEqual(2);
    for (const card of firstRow) {
      const art = card.querySelector<HTMLElement>(".collection-art")!.getBoundingClientRect();
      const title = card.querySelector<HTMLElement>(".collection-title")!.getBoundingClientRect();
      const footer = card
        .querySelector<HTMLElement>(".library-entry-footer")!
        .getBoundingClientRect();
      expect(art.width).toBeGreaterThan(100);
      expect(art.height / art.width).toBeCloseTo(1.5, 2);
      expect(title.top).toBeLessThan(art.bottom);
      expect(footer.bottom).toBeLessThan(innerHeight);
      for (const overlay of card.querySelectorAll<HTMLElement>(".collection-personal-actions")) {
        expect(overlay.getBoundingClientRect().right).toBeLessThanOrEqual(art.right + 1);
        expect(overlay.getBoundingClientRect().left).toBeGreaterThanOrEqual(art.left - 1);
      }
    }
    await captureParityState(`library-short-covers-${theme}-${grouped ? "grouped" : "plain"}`);
    const search = page.getByRole("textbox", { name: "Search your library" });
    await search.fill("Forgotten Islands");
    await expect.poll(() => document.querySelectorAll(".collection-cover").length).toBe(1);
    await search.fill("");
    await expect.poll(() => document.querySelectorAll(".collection-cover").length).toBe(3);
    const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  },
);

it.each([
  ["dark", 1280, 800, false, 2],
  ["light", 1280, 800, false, 2],
  ["dark", 1366, 768, false, 2],
  ["light", 1366, 768, false, 2],
  ["dark", 1280, 800, true, 3],
  ["light", 1366, 768, true, 3],
  ["light", 1280, 800, false, 1],
  ["dark", 1366, 768, false, 12],
] as const)(
  "keeps four-platform %s Covers actionable at %i×%i (grouped: %s, entries: %i)",
  async (theme, width, height, grouped, entryCount) => {
    await page.viewport(width, height);
    const snapshot = workspace("collection-large");
    const listing = workspace("details").listing_catalog!.listings[0]!;
    const platforms: PortListing["platforms"] = [
      "windows-x86-64",
      "linux-x86-64",
      "macos-x86-64",
      "macos-aarch64",
    ];
    const visiblePorts = snapshot.catalog.ports.slice(0, entryCount);
    for (const [index, port] of visiblePorts.entries()) {
      port.name = `Harbor desktop project ${index + 1}`;
      port.presentation!.original_game_title =
        index === 0 ? "Harbor Adventure and the Forgotten Islands" : `Harbor game ${index + 1}`;
    }
    if (grouped) {
      for (const port of visiblePorts.slice(0, 2)) {
        port.presentation!.original_game_title = "Harbor Adventure and the Forgotten Islands";
        port.presentation!.original_game = {
          format_version: 1,
          id: "fixture-medium-harbor",
          evidence_urls: ["https://example.com/fixture/medium-harbor"],
          source_editions: [],
        };
      }
    }
    // Library intentionally clears definition platforms before rendering its
    // chips. The synthetic listing supplies all four platform labels seen natively.
    snapshot.listing_catalog = {
      format_version: 1,
      listings: visiblePorts.map((port) => ({
        ...listing,
        id: port.id,
        name: port.name,
        original_game_title: port.presentation!.original_game_title ?? port.name,
        platforms,
      })),
    };
    snapshot.statuses = snapshot.statuses.slice(0, entryCount);
    const needsFiles = snapshot.statuses[grouped ? 2 : 1];
    if (needsFiles)
      needsFiles.readiness = {
        launchable: false,
        pending_setup: false,
        blockers: ["missing_source"],
        source: "missing",
      };
    // Accepted listings also need an explicit current action assessment. The
    // controlled Core replies permit only this fixture's launchable entries.
    snapshot.listing_statuses = snapshot.statuses.map((status) => ({
      port_id: status.port_id,
      status,
      actions: [{ action: "launch", allowed: status.readiness?.launchable === true }],
    }));
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    const renderedEntries = entryCount - Number(grouped);
    await mount(theme, "collection-large", renderedEntries);
    await page.getByRole("textbox", { name: "Search your library" }).fill("Harbor");
    await expect
      .poll(() => document.querySelectorAll(".collection-cover").length)
      .toBe(renderedEntries);
    if (grouped) {
      const prompt = document.querySelector<HTMLElement>(
        '[data-library-game-id="game:fixture-medium-harbor"] .collection-cover',
      )!;
      const promptFooter = prompt.querySelector<HTMLElement>(".library-entry-footer")!;
      expectBoundsInViewport(promptFooter);
      await captureParityState(`library-medium-four-platform-${theme}-${width}-unresolved`);
      await page
        .elementLocator(prompt)
        .getByRole("button", { name: "Choose Harbor desktop project 1", exact: true })
        .click();
    }
    await expect
      .poll(() => document.querySelectorAll("button.collection-identity").length)
      .toBe(renderedEntries);
    const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
    page.getByRole("button", { name: "Covers", exact: true }).element().focus();
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    await expect
      .poll(() => {
        const row = document.querySelector<HTMLElement>("[data-collection-row]");
        return row?.querySelectorAll("[data-library-port-ids]").length;
      })
      .toBe(Math.min(renderedEntries, 3));
    const cards = [...document.querySelectorAll<HTMLElement>(".collection-cover")];
    const firstTop = cards[0]!.getBoundingClientRect().top;
    const firstRow = cards.filter(
      (card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 1,
    );
    expect(firstRow.length).toBe(Math.min(renderedEntries, 3));
    await expect
      .poll(() =>
        firstRow.every((card) => {
          const images = [...card.querySelectorAll<HTMLImageElement>(".collection-art img")];
          return (
            images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0)
          );
        }),
      )
      .toBe(true);
    for (const card of firstRow) {
      expectContainedCover(card);
      const identity = card.querySelector<HTMLElement>(".collection-identity")!;
      const art = card.querySelector<HTMLElement>(".collection-art")!.getBoundingClientRect();
      const title = card.querySelector<HTMLElement>(".collection-title")!.getBoundingClientRect();
      expect(title.left).toBeGreaterThanOrEqual(art.right);
      expect(title.top).toBeLessThan(art.bottom);
      const chips = [
        ...card.querySelectorAll<HTMLElement>('.library-entry-chips [title="Runs on"]'),
      ];
      expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
        "Windows",
        "Linux",
        "macOS Intel",
        "Apple silicon",
      ]);
      const readiness = card.querySelector<HTMLElement>(".readiness")!;
      expect(readiness.textContent).toMatch(/Ready to play|Game files missing/);
      const footer = card.querySelector<HTMLElement>(".library-entry-footer")!;
      expect(footer.querySelector(".library-card-action")?.textContent).toMatch(
        /Play|Finish setup/,
      );
      for (const element of [identity, readiness, footer, ...chips]) {
        await expect.element(page.elementLocator(element)).toBeVisible();
        expectBoundsInViewport(element);
      }
    }
    expect(main.scrollTop).toBe(0);
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    await captureParityState(
      `library-medium-four-platform-${theme}-${width}-${grouped ? "grouped" : "plain"}-${entryCount}`,
    );
    await focusFooterControlsInViewport(cards.at(-1)!);
  },
);

it("keeps grouped short Covers usable at 320px with enlarged text and returns keyboard choice focus", async () => {
  await page.viewport(320, 580);
  document.documentElement.style.fontSize = "20px";
  const snapshot = groupedCollectionSnapshot();
  const title =
    "Harbor Adventure and the Forgotten Islands — The Extended Voyage Beyond the Northern Sea";
  const project =
    "Harbor Adventure Community Restoration Project with Modern Graphics and Expanded Controller Support";
  snapshot.catalog.ports[0]!.name = project;
  for (const port of snapshot.catalog.ports.slice(0, 2)) {
    port.presentation!.original_game_title = title;
  }
  snapshot.statuses = snapshot.statuses.slice(0, 4);
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  const choosePort = vi.spyOn(desktopApi, "changeOrganization");
  await mount("dark", "collection", 3);
  const group = document.querySelector<HTMLElement>(
    '[data-library-game-id="game:fixture-super-mario-64"]',
  )!;
  const prompt = group.querySelector<HTMLElement>(".collection-cover")!;
  expectContainedCover(prompt);
  await captureParityState("library-short-covers-compact-grouped-initial");
  await focusFooterControlsInViewport(prompt);
  const choiceButton = prompt.querySelector<HTMLButtonElement>(".collection-actions button")!;
  const prefix = choiceButton.querySelector("span")!.firstChild!;
  expect(prefix.nodeType).toBe(Node.TEXT_NODE);
  const chooseStart = prefix.textContent!.indexOf("Choose");
  expect(chooseStart).toBeGreaterThanOrEqual(0);
  const prefixRange = document.createRange();
  prefixRange.setStart(prefix, chooseStart);
  prefixRange.setEnd(prefix, chooseStart + "Choose".length);
  expect(prefixRange.getClientRects()).toHaveLength(1);
  await captureParityState("library-short-covers-compact-grouped-choices");
  const choices = page.elementLocator(prompt.querySelector<HTMLElement>(".collection-actions")!);
  const choose = choices.getByRole("button", { name: `Choose ${project}`, exact: true });
  choose.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.elementLocator(group).getByRole("button", { name: /^Play: / }))
    .toBeVisible();
  await expect.element(page.elementLocator(group)).toHaveFocus();
  expect(choosePort).toHaveBeenCalledExactlyOnceWith(
    expect.any(Number),
    {
      kind: "set_preferred_implementation",
      game_id: "fixture-super-mario-64",
      port_id: "collection-0",
    },
    1,
  );
  const card = group.querySelector<HTMLElement>(".collection-cover")!;
  expect(card.querySelector("[data-detail-game-id]")?.getAttribute("data-detail-game-id")).toBe(
    "collection-0",
  );
  expect(card.querySelector(".collection-title")?.textContent).toBe(title);
  const projectLabel = card.querySelector<HTMLElement>(".collection-project")!;
  expect(projectLabel.textContent).toContain(project);
  expect(projectLabel.title).toBe(project);
  expect(projectLabel.getBoundingClientRect().height).toBeLessThanOrEqual(
    Number.parseFloat(getComputedStyle(projectLabel).lineHeight) * 2 + 1,
  );
  expectContainedCover(card);
  await captureParityState("library-short-covers-compact-grouped-selected-focus");
  const identity = card.querySelector<HTMLButtonElement>("button.collection-identity")!;
  identity.focus();
  await expect.element(page.elementLocator(identity)).toHaveFocus();
  expect(projectLabel.getBoundingClientRect().height).toBeGreaterThan(
    Number.parseFloat(getComputedStyle(projectLabel).lineHeight) * 2,
  );
  await captureParityState("library-short-covers-compact-grouped-full-identity");
  await focusFooterControlsInViewport(card);
  const more = page.elementLocator(card).getByRole("button", { name: /^More actions for/ });
  more.element().focus();
  await userEvent.keyboard("{Enter}");
  const menu = page.getByRole("menu", { name: /^More actions for/ });
  await expect.element(menu).toBeVisible();
  const firstEnabledItem = menu
    .element()
    .querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]):not([disabled]):not([data-disabled])',
    )!;
  await expect.element(page.elementLocator(firstEnabledItem)).toHaveFocus();
  expect(menu.element().contains(document.activeElement)).toBe(true);
  const bounds = menu.element().getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(innerWidth + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
  await captureParityState("library-short-covers-compact-grouped-menu");
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(more).toHaveFocus();
  await captureParityState("library-short-covers-compact-grouped-menu-return");
});

it("keeps plain short Covers and their overflow menu reachable at 430px", async () => {
  await page.viewport(430, 640);
  const snapshot = workspace("collection");
  snapshot.statuses = snapshot.statuses.slice(0, 3);
  snapshot.catalog.ports[0]!.name = "Harbor Adventure Community Restoration Edition";
  snapshot.catalog.ports[0]!.presentation!.original_game_title =
    "Harbor Adventure and the Forgotten Islands — The Long Northern Voyage";
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  await mount("light", "collection", 3);
  const cards = [...document.querySelectorAll<HTMLElement>(".collection-cover")];
  for (const card of cards) expectContainedCover(card);
  await captureParityState("library-short-covers-compact-plain-initial");
  const card = document
    .querySelector('[data-detail-game-id="collection-0"]')!
    .closest<HTMLElement>(".collection-cover")!;
  await focusFooterControlsInViewport(card);
  await captureParityState("library-short-covers-compact-plain-action");
  const more = page.elementLocator(card).getByRole("button", { name: /^More actions for/ });
  more.element().focus();
  await userEvent.keyboard("{Enter}");
  const menu = page.getByRole("menu", { name: /^More actions for/ });
  await expect.element(menu).toBeVisible();
  const firstEnabledItem = menu
    .element()
    .querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"]):not([disabled]):not([data-disabled])',
    )!;
  await expect.element(page.elementLocator(firstEnabledItem)).toHaveFocus();
  expect(menu.element().contains(document.activeElement)).toBe(true);
  const bounds = menu.element().getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(innerWidth + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight + 1);
  await captureParityState("library-short-covers-compact-plain-menu");
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  await expect.element(more).toHaveFocus();
  await captureParityState("library-short-covers-compact-plain-menu-return");
});

it("keeps twelve short-window Covers contained through fallback artwork and the last action", async () => {
  await page.viewport(960, 640);
  await mount("dark", "collection", 12);
  await inspectLibraryGroups(
    [2, 6, 10, 4, 8, 5, 9, 0, 1, 3, 7, 11].map((index) => [`collection-${index}`]),
    (card) => expectContainedCover(card.querySelector<HTMLElement>(".collection-cover") ?? card),
  );
  await mountLibraryPort("collection-4");
  await captureParityState("library-short-covers-many-initial");
  const missing = document
    .querySelector('[data-detail-game-id="collection-4"]')!
    .closest<HTMLElement>(".collection-cover")!;
  const missingMore = page
    .elementLocator(missing)
    .getByRole("button", { name: /^More actions for/ });
  missingMore.element().focus();
  await expect.element(missingMore).toHaveFocus();
  const fallback = missing.querySelector<HTMLElement>(".collection-art")!;
  await expect.poll(() => fallback.getAttribute("data-artwork-source")).toBe("generated_fallback");
  expect(fallback.querySelectorAll("img")).toHaveLength(0);
  expect(fallback.querySelector("[data-cover-illustration]")).not.toBeNull();
  expectContainedCover(missing);
  fallback.scrollIntoView({ block: "center" });
  const fallbackBounds = fallback.getBoundingClientRect();
  expect(fallbackBounds.top).toBeGreaterThanOrEqual(0);
  expect(fallbackBounds.bottom).toBeLessThanOrEqual(innerHeight);
  await captureParityState("library-short-covers-many-fallback");
  const lastGroup = await mountLibraryPort("collection-11");
  const last = lastGroup.querySelector<HTMLElement>(".collection-cover") ?? lastGroup;
  await focusFooterControlsInViewport(last);
  const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
  const owner =
    getComputedStyle(main).overflowY === "visible"
      ? (document.scrollingElement ?? document.documentElement)
      : main;
  expect(owner.scrollTop).toBeGreaterThan(0);
  await captureParityState("library-short-covers-many-last-action");
});

it.each([false, true])(
  "keeps the only playable cover in view with long identity text (grouped: %s)",
  async (grouped) => {
    await page.viewport(960, 640);
    const snapshot = grouped ? groupedCollectionSnapshot() : workspace("collection");
    const port = snapshot.catalog.ports[0]!;
    port.name = "Harbor Adventure Community Edition";
    port.presentation!.original_game_title = "Harbor Adventure and the Forgotten Islands";
    snapshot.statuses = snapshot.statuses.filter(
      (status) => status.port_id === port.id || status.port_id === "collection-5",
    );
    port.channels = ["stable", "beta"];
    snapshot.statuses[0]!.channel = "beta";
    snapshot.statuses[0]!.active!.channel = "beta";
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
    await mount("dark", "collection", 2);

    const firstCover = document.querySelector<HTMLElement>(".collection-cover .collection-art")!;
    const gridArtworkWidth = firstCover.getBoundingClientRect().width;
    const search = page.getByRole("textbox", { name: "Search your library" });
    await search.fill("Forgotten Islands");

    await expect.poll(() => document.querySelectorAll(".collection-cover").length).toBe(1);
    const cover = document.querySelector<HTMLElement>(".collection-cover")!;
    expect(
      (
        JSON.parse(
          cover.closest<HTMLElement>("[data-library-port-ids]")!.dataset.libraryPortIds!,
        ) as string[]
      ).length > 1,
    ).toBe(grouped);
    const play = page.getByRole("button", { name: /^Play: Harbor Adventure/ });
    await expect.element(play).toBeVisible();
    const action = play.element().getBoundingClientRect();
    expect(action.top).toBeGreaterThan(0);
    expect(action.bottom).toBeLessThan(document.documentElement.clientHeight);

    await search.fill("");
    await expect.poll(() => document.querySelectorAll(".collection-cover").length).toBe(2);
    const gridArtwork = document.querySelector<HTMLElement>(".collection-cover .collection-art")!;
    expect(gridArtwork.getBoundingClientRect().width).toBeCloseTo(gridArtworkWidth, 0);
  },
);

it.each([
  [1440, 900, 6, 180.7],
  [1440, 768, 3, 144],
  [1024, 800, 2, 144],
  [1024, 801, 3, 220],
  [1920, 800, 4, 144],
  [1920, 801, 8, 190.5],
  [740, 900, 3, 205.3],
  [390, 844, 2, 143],
  [320, 844, 1, 220],
])(
  "keeps Library cover density and identity placement consistent at %ipx by %ipx",
  async (width, height, columns, artworkWidth) => {
    await page.viewport(width, height);
    await mount();
    const grid = document.querySelector<HTMLElement>(".collection-covers")!;
    expect(
      getComputedStyle(
        grid.querySelector("[data-collection-row]") ?? grid,
      ).gridTemplateColumns.split(" "),
    ).toHaveLength(columns);
    const cover = grid.querySelector<HTMLElement>(".collection-cover")!;
    const art = cover.querySelector<HTMLElement>(".collection-art")!;
    const overlay = cover.querySelector<HTMLElement>(".collection-personal-actions")!;
    const horizontal = matchMedia("(height <= 50rem)").matches;
    expect(
      horizontal ||
        Math.abs(art.getBoundingClientRect().width - cover.getBoundingClientRect().width) < 0.5,
    ).toBe(true);
    expect(overlay.getBoundingClientRect().width).toBeCloseTo(art.getBoundingClientRect().width, 0);
    expect(art.getBoundingClientRect().height / art.getBoundingClientRect().width).toBeCloseTo(
      1.5,
      2,
    );
    expect(art.getBoundingClientRect().width).toBeCloseTo(artworkWidth, 0);
    const title = cover.querySelector<HTMLElement>(".collection-title")!;
    // A previous pointer position can hover the first poster and translate its
    // artwork by two pixels. Measure the resting composition after that settles.
    await userEvent.hover(
      page.getByRole("heading", { name: "Your library", exact: true }).element(),
    );
    await expect.poll(() => getComputedStyle(art).transform).toBe("none");
    // Horizontal identities use the grid gap; posters include caption padding.
    expect(
      horizontal
        ? title.getBoundingClientRect().left - art.getBoundingClientRect().right
        : title.getBoundingClientRect().top - art.getBoundingClientRect().bottom,
    ).toBeCloseTo(horizontal ? 12 : 24, 0);
    expect(getComputedStyle(title).fontWeight).toBe("600");
    expect(getComputedStyle(art).borderRadius).toBe("10px");
    const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
  },
);

it("shares Discover membership quick views with filters while preserving search", async () => {
  await page.viewport(1024, 800);
  await mount();
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search Discover", exact: true });
  await search.fill("Mario");
  const quickViews = page.getByRole("group", { name: "Discover collections", exact: true });
  await quickViews.getByRole("button", { name: "Not in library", exact: true }).click();
  await expect.element(search).toHaveValue("Mario");
  await expect
    .element(quickViews.getByRole("button", { name: "Not in library", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => document.querySelectorAll(".discover-game").length).toBe(0);
  await quickViews.getByRole("button", { name: "All games", exact: true }).click();
  await expect.element(search).toHaveValue("Mario");
  await expect.poll(() => document.querySelectorAll(".discover-game").length).toBe(2);
});

it("creates and removes a collection through its editor while retaining a failed draft and restoring All games focus", async () => {
  await page.viewport(1440, 900);
  await mount();
  const change = vi.spyOn(desktopApi, "changeOrganization");
  const opener = page
    .getByRole("button", { name: "Create your first collection", exact: true })
    .element();
  await userEvent.click(opener);
  const name = page.getByRole("textbox", { name: "Collection name", exact: true });
  await expect.element(name).toBeVisible();
  const create = page.getByRole("button", { name: "Create collection", exact: true });
  await expect.element(create).toBeDisabled();
  await name.fill("  Weekend sessions  ");
  change.mockRejectedValueOnce(new Error("Fixture organization write refused"));
  await create.click();
  await expect
    .poll(() => document.body.textContent)
    .toContain("Portcove couldn’t confirm the changes. Showing your last confirmed choices.");
  await expect.element(name).toHaveValue("  Weekend sessions  ");
  await expect
    .element(page.getByRole("button", { name: "Collection: Weekend sessions", exact: true }))
    .not.toBeInTheDocument();
  await captureParityState("collection-create-failed-draft");
  await create.click();
  await expect.element(name).toHaveValue("");
  await expect.element(opener).toHaveAccessibleName("Manage collections");
  await userEvent.keyboard("{Escape}");
  await expect.element(opener).toHaveFocus();
  await userEvent.click(opener);
  await expect.element(name).toBeVisible();
  const created = change.mock.calls.at(-1)![1];
  if (created.kind !== "upsert_collection") throw new Error("Expected collection creation");
  expect(created.collection_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(change).toHaveBeenLastCalledWith(
    0,
    { kind: "upsert_collection", collection_id: created.collection_id, name: "Weekend sessions" },
    1,
  );
  const selected = page.getByRole("button", { name: "Weekend sessions (0)", exact: true });
  await selected.click();
  await expect.element(selected).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(0);
  await captureParityState("collection-created-empty-selected");
  await page.getByRole("button", { name: "Remove collection", exact: true }).click();
  expect(change).toHaveBeenLastCalledWith(
    1,
    { kind: "remove_collection", collection_id: created.collection_id },
    1,
  );
  const all = page
    .getByRole("group", { name: "Library collections", exact: true })
    .getByRole("button", { name: "All games", exact: true });
  await expect.element(all).toHaveAttribute("aria-pressed", "true");
  await expect.element(all).toHaveFocus();
  await expect.element(selected).not.toBeInTheDocument();
  await expect
    .poll(() =>
      Number(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")),
    )
    .toBe(12);
  await captureParityState("collection-removed-all-games-focus");
  await expect.element(opener).toHaveAccessibleName("Create your first collection");
  await userEvent.keyboard("{Escape}");
  await expect.element(opener).toHaveFocus();
}, 45_000);

it("opens Hidden games and restores Favorites focus when its last entry is shown in Library", async () => {
  await page.viewport(1440, 900);
  await mount();
  const change = vi.spyOn(desktopApi, "changeOrganization");
  const entry = () =>
    page.elementLocator(
      document
        .querySelector('[data-detail-game-id="collection-0"]')!
        .closest<HTMLElement>(".collection-entry")!,
    );
  await entry()
    .getByRole("button", { name: /^More actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Hide from Library", exact: true }).click();
  expect(change).toHaveBeenLastCalledWith(
    0,
    { kind: "set_hidden", port_id: "collection-0", hidden: true },
    1,
  );
  await expect
    .poll(() =>
      Number(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")),
    )
    .toBe(11);
  const hidden = page.getByRole("button", { name: /^Hidden games/ });
  await hidden.click();
  await expect.element(hidden).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(1);
  await captureParityState("library-hidden-selection");
  await entry()
    .getByRole("button", { name: /^More actions for/ })
    .click();
  await page.getByRole("menuitem", { name: "Show in Library", exact: true }).click();
  expect(change).toHaveBeenLastCalledWith(
    1,
    { kind: "set_hidden", port_id: "collection-0", hidden: false },
    1,
  );
  await expect.element(hidden).not.toBeInTheDocument();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(0);
  await expect
    .element(page.getByRole("heading", { name: "Nothing in your library matches", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("radio", { name: "Favorites 0 games", exact: true }))
    .toHaveFocus();
  await captureParityState("library-hidden-final-entry-restored");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect
    .poll(() =>
      Number(document.querySelector("[data-library-port-ids]")?.getAttribute("aria-setsize")),
    )
    .toBe(12);
}, 45_000);

it("keeps the confirmed favorite state during a pending and rejected write", async () => {
  await page.viewport(1024, 800);
  await mount();
  let rejectWrite!: (reason: Error) => void;
  const favorite = vi.spyOn(desktopApi, "changeOrganization").mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectWrite = reject;
    }),
  );
  const toggle = page.getByRole("button", {
    name: "Favorite Super Mario 64 · sm64-port",
    exact: true,
  });
  await userEvent.hover(toggle.element());
  expect(toggle.element().matches(":hover")).toBe(true);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await captureParityState("library-favorite-hover");
  await toggle.click();
  await expect.element(toggle).toBeDisabled();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  expect(favorite.mock.calls[0]?.[1]).toMatchObject({ kind: "set_saved_group", saved: true });
  await captureParityState("library-favorite-write-pending");
  rejectWrite(new Error("Fixture favorite write refused"));
  await expect
    .element(
      page.getByText("Portcove couldn’t confirm your favorites. Retry to check what was saved.", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect.element(toggle).toBeDisabled();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(page.getByRole("radio", { name: "Favorites 0 games", exact: true }))
    .toBeVisible();
  await captureParityState("library-favorite-write-rejected");
  const rejection = page.getByText(
    "Portcove couldn’t confirm your favorites. Retry to check what was saved.",
    { exact: true },
  );
  rejection.element().scrollIntoView({ block: "center" });
  await expect.element(rejection).toBeVisible();
  await expect
    .poll(() => {
      const bounds = rejection.element().getBoundingClientRect();
      return (
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth
      );
    })
    .toBe(true);
  await captureParityState("library-favorite-write-rejected-notice");
  await page.getByRole("button", { name: "Retry favorites", exact: true }).click();
  await expect.element(toggle).toBeEnabled();
}, 45_000);

it("sorts actual Library entries by the selected title order without changing their identities", async () => {
  await page.viewport(1024, 800);
  await mount();
  const sort = page.getByRole("combobox", { name: /^Sort / });
  await sort.click();
  await expect.element(page.getByRole("option", { name: "Title A–Z", exact: true })).toBeVisible();
  await captureParityState("library-sort-menu");
  await page.getByRole("option", { name: "Title A–Z", exact: true }).click();
  await expect
    .element(sort.element().querySelector<HTMLElement>("[data-slot=select-value]"))
    .toHaveTextContent("Title A–Z");
  const ascending: string[] = [];
  await inspectLibraryGroups(
    [2, 6, 10, 4, 8, 5, 9, 0, 1, 3, 7, 11].map((index) => [`collection-${index}`]),
    (card, index) => {
      ascending[index] = card
        .querySelector(".collection-identity")!
        .getAttribute("data-detail-game-id")!;
    },
  );
  expect(ascending).toHaveLength(12);
  expect(new Set(ascending).size).toBe(12);
  await sort.click();
  await page.getByRole("option", { name: "Title Z–A", exact: true }).click();
  await expect
    .element(sort.element().querySelector<HTMLElement>("[data-slot=select-value]"))
    .toHaveTextContent("Title Z–A");
  const descending: string[] = [];
  const descendingTitles: string[] = [];
  await inspectLibraryGroups(
    // Descending titles retain original input order within each equal-title cohort.
    [3, 7, 11, 0, 1, 5, 9, 4, 8, 6, 10, 2].map((index) => [`collection-${index}`]),
    (card, index) => {
      descending[index] = card
        .querySelector(".collection-identity")!
        .getAttribute("data-detail-game-id")!;
      descendingTitles[index] = card.querySelector(".collection-title")!.textContent?.trim() ?? "";
    },
  );
  expect(descending).not.toEqual(ascending);
  expect([...descending].sort((a, b) => a.localeCompare(b))).toEqual(
    [...ascending].sort((a, b) => a.localeCompare(b)),
  );
  const titles = descendingTitles;
  expect(titles).toHaveLength(12);
  expect(titles).toEqual(
    [...titles].sort((a, b) => b.localeCompare(a, "en", { sensitivity: "base" })),
  );
  await captureParityState("library-sort-title-descending");
}, 45_000);

it("keeps a grouped Discover Favorite unselected while pending and after a rejected write", async () => {
  await page.viewport(1024, 800);
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(groupedCollectionSnapshot());
  await mount("dark", "collection", 11);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const order = [2, 6, 10, 4, 8, 5, 9, 0, 3, 7, 11].map((index) =>
    index === 0 ? ["collection-0", "collection-1"] : [`collection-${index}`],
  );
  await inspectDiscoverGroups(order);
  await mountDiscoverPort("collection-1");
  let rejectWrite!: (reason: Error) => void;
  const change = vi.spyOn(desktopApi, "changeOrganization").mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectWrite = reject;
    }),
  );
  const group = discoverGroupForPort("collection-1");
  const save = page.elementLocator(group.querySelector<HTMLButtonElement>(".collection-favorite")!);
  await expect.element(save).toHaveAttribute("aria-pressed", "false");
  await save.click();
  await expect.element(save).toBeDisabled();
  const requested = change.mock.calls[0]![1];
  if (requested.kind !== "set_saved_group") throw new Error("Expected grouped Favorite");
  expect(requested.legacy_port_ids).toEqual(["collection-0", "collection-1"]);
  expect(requested.saved).toBe(true);
  await captureParityState("discover-group-save-pending");
  rejectWrite(new Error("Fixture grouped Favorite refused"));
  await expect.element(save).toBeDisabled();
  await expect.element(save).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(
      page.getByRole("group", { name: "Discover collections", exact: true }).getByRole("alert"),
    )
    .toMatchTextContent(
      "Portcove couldn’t confirm the changes. Showing your last confirmed choices.",
    );
  await expect
    .element(
      page.getByRole("group", { name: "Discover collections", exact: true }).getByRole("alert"),
    )
    .toBeVisible();
  await captureParityState("discover-group-save-rejected");
}, 45_000);

it("keeps the Library favorite and overflow visible for pointer and keyboard use", async () => {
  await page.viewport(1440, 900);
  await mount();
  const favorite = document.querySelector<HTMLButtonElement>(
    '.collection-cover .collection-favorite[aria-pressed="false"]',
  )!;
  const cover = favorite.closest<HTMLElement>(".collection-cover")!;
  const more = cover.querySelector<HTMLElement>(".collection-more")!;
  await userEvent.hover(document.querySelector("main h1")!);
  expect(getComputedStyle(favorite).opacity).toBe("1");
  expect(getComputedStyle(more).opacity).toBe("1");
  await userEvent.hover(cover);
  expect(getComputedStyle(favorite).opacity).toBe("1");
  expect(getComputedStyle(more).opacity).toBe("1");
  expect(more.getBoundingClientRect().right).toBeLessThanOrEqual(
    favorite.getBoundingClientRect().left,
  );
  await userEvent.hover(document.querySelector("main h1")!);
  more.focus();
  expect(getComputedStyle(more).opacity).toBe("1");
  await userEvent.keyboard("{Tab}");
  await expect.element(favorite).toHaveFocus();
  expect(getComputedStyle(favorite).opacity).toBe("1");
  await userEvent.keyboard("{Enter}");
  await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
  favorite.blur();
  expect(getComputedStyle(favorite).opacity).toBe("1");
});

it.each([false, true])(
  "rereads mixed Favorites after a sibling write fails (reply lost: %s)",
  async (replyLost) => {
    await page.viewport(1366, 900);
    vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(groupedCollectionSnapshot());
    const persisted = new Set(["collection-0", "collection-1", "unknown-port"]);
    const gameId = "game-fixture-super-mario-64";
    vi.spyOn(desktopApi, "favoritePorts").mockImplementation(async () => [...persisted]);
    await mount("dark", "collection", 11, async () => {
      await desktopApi.changeOrganization(
        0,
        { kind: "set_saved", game_id: gameId, saved: true },
        1,
      );
      await desktopApi.changeOrganization(
        1,
        { kind: "set_saved", game_id: "port-unknown-port", saved: true },
        1,
      );
    });
    let finishWrite!: () => void;
    const attempted = vi
      .spyOn(desktopApi, "setPortFavorite")
      .mockImplementation(async (portId, favorite) => {
        expect(favorite).toBe(false);
        persisted.delete(portId);
      })
      .mockImplementationOnce(async (portId, favorite) => {
        await new Promise<void>((resolve) => {
          finishWrite = resolve;
        });
        expect(favorite).toBe(false);
        if (replyLost) persisted.delete(portId);
        throw new Error("Fixture transport rejected the sibling clear");
      });
    const favorite = page.getByRole("button", { name: "Favorite Super Mario 64", exact: true });
    await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
    const filter = page.getByRole("radio", { name: "Favorites 1 game", exact: true });
    await expect.element(filter).toHaveAccessibleName("Favorites 1 game");
    await filter.click();
    await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(1);
    await favorite.click();
    await expect.poll(() => attempted.mock.calls.length).toBe(1);
    expect((await desktopApi.organizationPreferences(1)).saved_game_ids).toEqual([
      "port-unknown-port",
    ]);
    await expect.element(favorite).toBeDisabled();
    await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
    finishWrite();
    const retry = page.getByRole("button", { name: "Retry favorites", exact: true });
    await expect.element(retry).toBeVisible();
    await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
    await retry.click();
    await expect.element(retry).not.toBeInTheDocument();
    await expect.element(favorite).toHaveAttribute("aria-pressed", "true");
    await favorite.click();
    await expect
      .element(page.getByRole("radio", { name: "Favorites 0 games", exact: true }))
      .toBeVisible();
    expect(attempted.mock.calls).toEqual([
      ["collection-0", false, 1],
      ...(!replyLost ? [["collection-0", false, 1]] : []),
      ["collection-1", false, 1],
    ]);
    expect([...persisted]).toEqual(["unknown-port"]);
    expect((await desktopApi.organizationPreferences(1)).saved_game_ids).toEqual([
      "port-unknown-port",
    ]);
  },
);
