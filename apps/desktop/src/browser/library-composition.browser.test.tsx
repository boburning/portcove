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
import { discoverGroupForPort } from "./discover-test-helpers";
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
  document.documentElement.style.removeProperty("zoom");
  delete document.documentElement.dataset.theme;
});

async function mount(
  theme = "dark",
  journey: "collection" | "collection-large" = "collection",
  expectedLibraryEntries = journey === "collection-large" ? 60 : 12,
) {
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
    await page.getByRole("button", { name: "Back to library", exact: true }).click();
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
  expect(document.body.textContent).toContain("12 library entries");
  const portCard = (id: string) =>
    page.elementLocator(
      document
        .querySelector(`[data-detail-game-id="${id}"]`)!
        .closest<HTMLElement>(".collection-entry")!,
    );
  await portCard("collection-0").getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => launch.mock.calls[0]).toEqual(["collection-0", "", 1]);
  await portCard("collection-1").getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => launch.mock.calls[1]).toEqual(["collection-1", "", 1]);
  await page.getByRole("textbox", { name: "Search your library" }).fill("Super Mario 64");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(2);
  expect(document.body.textContent).toContain("2 of 12 library entries");
  await page.getByRole("button", { name: "Manage collections", exact: true }).click();
  const commands = page
    .getByText("Collection commands", { exact: true })
    .element()
    .closest("details")!;
  commands.open = true;
  expect(commands.textContent).toContain("12 installed entries");
  expect(commands.textContent).toContain("hidden by filters");
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  const more = page.getByRole("button", { name: /^More actions for/ }).first();
  await more.click();
  await expect.element(page.getByRole("menu", { name: /^More actions for/ })).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(page.getByRole("menuitem", { name: "Saves & backups" })).toHaveFocus();
  await captureParityState("card-overflow-keyboard-focus");
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
    .toHaveTextContent("1 game + 10 ungrouped projects · 12 matching ports");
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
      dialog.getByRole("button", { name: "Use Mario modern port · Modern renderer", exact: true }),
    )
    .toBeEnabled();
  await expect.element(row).toMatchTextContent("Stable");
  choice.scrollIntoView({ block: "nearest" });
  expect(choice.getBoundingClientRect().bottom).toBeLessThanOrEqual(innerHeight);
  await userEvent.click(choice);
  await expect
    .element(page.getByText("Mario modern port · Modern renderer", { exact: true }))
    .toBeVisible();
  expect(document.querySelector("[data-detail-port-id]")?.getAttribute("data-detail-port-id")).toBe(
    "collection-1",
  );
});

it("keeps artwork favorites separate from details and restores filter focus when its last result disappears", async () => {
  await page.viewport(1366, 768);
  await mount();
  const favorite = vi.spyOn(desktopApi, "setPortFavorite");
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
  await expect.poll(() => favorite.mock.calls[0]).toEqual(["collection-0", true, 1]);
  const filter = page.getByRole("button", { name: "Favorites 1", exact: true });
  await filter.click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(1);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await captureParityState("library-favorites");
  toggle.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(0);
  await expect
    .element(page.getByRole("button", { name: "Favorites 0", exact: true }))
    .toHaveFocus();
  expect(favorite.mock.calls[1]).toEqual(["collection-0", false, 1]);
});

it("shares the narrow filter row without losing query, independent readiness or view controls", async () => {
  await page.viewport(320, 768);
  await mount("light");
  const search = page.getByRole("textbox", { name: "Search your library" });
  await search.fill("Super Mario 64");
  const favorites = page.getByRole("button", { name: "Favorites 0", exact: true }).element();
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
  await page.getByText("Recorded checks", { exact: true }).click();
  await expect.element(page.getByText(/^Recorded history, not a fresh check/)).toBeVisible();
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
    const count = document.querySelectorAll(".collection-entry").length;
    const action = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".collection-actions button[data-variant=outline]",
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
    const group = discoverGroupForPort("collection-1");
    const artwork = group.querySelector<HTMLElement>(".collection-art")!;
    const ordinary = artwork.getBoundingClientRect();
    document.documentElement.style.fontSize = "32px";
    await expect
      .poll(() => artwork.getBoundingClientRect().width)
      .toBeLessThanOrEqual(Math.max(ordinary.width, 260));
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
  const opener = page.getByRole("button", { name: "Manage collections", exact: true });
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
  const compact = page.getByRole("button", { name: "Collections · Weekend games", exact: true });
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
    .element(dialog.getByText("Review this port’s requirements and recorded information."))
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
  await dialog.getByText("Recorded evidence and comparison settings", { exact: true }).click();
  await expect
    .element(dialog.getByRole("region", { name: "Recommendation context" }))
    .toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Why this port?", exact: true }).first())
    .toHaveFocus();
});

it.each([
  [1440, 900, 5],
  [1024, 800, 4],
  [740, 900, 3],
])("preserves the prototype cover density at %ipx by %ipx", async (width, height, columns) => {
  await page.viewport(width, height);
  await mount();
  const grid = document.querySelector<HTMLElement>(".collection-covers")!;
  expect(getComputedStyle(grid).gridTemplateColumns.split(" ")).toHaveLength(columns);
  const main = document.querySelector<HTMLElement>("main[data-focus-region=workspace]")!;
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1);
});

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
  await page.getByRole("button", { name: "Manage collections", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Collection name", exact: true });
  await expect.element(name).toBeVisible();
  const create = page.getByRole("button", { name: "Create collection", exact: true });
  await expect.element(create).toBeDisabled();
  await name.fill("  Weekend sessions  ");
  change.mockRejectedValueOnce(new Error("Fixture organization write refused"));
  await create.click();
  await expect
    .poll(() => document.body.textContent)
    .toContain("These choices could not be saved. Your previous choices were kept.");
  await expect.element(name).toHaveValue("  Weekend sessions  ");
  await expect
    .element(page.getByRole("button", { name: "Collection: Weekend sessions", exact: true }))
    .not.toBeInTheDocument();
  await captureParityState("collection-create-failed-draft");
  await create.click();
  await expect.element(name).toHaveValue("");
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
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
  await captureParityState("collection-removed-all-games-focus");
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
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(11);
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
    .element(page.getByRole("heading", { name: "No matching library entries", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Favorites 0", exact: true }))
    .toHaveFocus();
  await captureParityState("library-hidden-final-entry-restored");
  await page.getByRole("button", { name: "Reset view", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-entry").length).toBe(12);
}, 45_000);

it("keeps the confirmed favorite state during a pending and rejected write", async () => {
  await page.viewport(1024, 800);
  await mount();
  let rejectWrite!: (reason: Error) => void;
  const favorite = vi.spyOn(desktopApi, "setPortFavorite").mockReturnValueOnce(
    new Promise<void>((_resolve, reject) => {
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
  expect(favorite).toHaveBeenCalledExactlyOnceWith("collection-0", true, 1);
  await captureParityState("library-favorite-write-pending");
  rejectWrite(new Error("Fixture favorite write refused"));
  await expect
    .element(page.getByText("Favorite choice could not be confirmed", { exact: true }))
    .toBeVisible();
  await expect.element(toggle).toBeEnabled();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(page.getByRole("button", { name: "Favorites 0", exact: true }))
    .toBeVisible();
  await captureParityState("library-favorite-write-rejected");
  const rejection = page.getByText("Favorite choice could not be confirmed", { exact: true });
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
}, 45_000);

it("sorts actual Library entries by the selected title order without changing their identities", async () => {
  await page.viewport(1024, 800);
  await mount();
  const ids = () =>
    [...document.querySelectorAll<HTMLElement>(".collection-identity")].map((entry) =>
      entry.getAttribute("data-detail-game-id")!,
    );
  const sort = page.getByRole("combobox", { name: /^Sort / });
  await sort.click();
  await expect.element(page.getByRole("option", { name: "Title A–Z", exact: true })).toBeVisible();
  await captureParityState("library-sort-menu");
  await page.getByRole("option", { name: "Title A–Z", exact: true }).click();
  await expect
    .element(sort.element().querySelector<HTMLElement>("[data-slot=select-value]"))
    .toHaveTextContent("Title A–Z");
  const ascending = ids();
  expect(ascending).toHaveLength(12);
  expect(new Set(ascending).size).toBe(12);
  await sort.click();
  await page.getByRole("option", { name: "Title Z–A", exact: true }).click();
  await expect
    .element(sort.element().querySelector<HTMLElement>("[data-slot=select-value]"))
    .toHaveTextContent("Title Z–A");
  const descending = ids();
  expect(descending).not.toEqual(ascending);
  expect([...descending].sort((a, b) => a.localeCompare(b))).toEqual(
    [...ascending].sort((a, b) => a.localeCompare(b)),
  );
  const titles = [
    ...document.querySelectorAll<HTMLElement>(".collection-entry .collection-title"),
  ].map((title) => title.textContent?.trim() ?? "");
  expect(titles).toHaveLength(12);
  expect(titles).toEqual(
    [...titles].sort((a, b) => b.localeCompare(a, "en", { sensitivity: "base" })),
  );
  await captureParityState("library-sort-title-descending");
}, 45_000);

it("keeps a grouped Discover Save unselected while pending and after a rejected write", async () => {
  await page.viewport(1024, 800);
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(groupedCollectionSnapshot());
  await mount("dark", "collection", 11);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await expect.poll(() => document.querySelectorAll(".collection-art").length).toBe(11);
  let rejectWrite!: (reason: Error) => void;
  const change = vi.spyOn(desktopApi, "changeOrganization").mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectWrite = reject;
    }),
  );
  const group = discoverGroupForPort("collection-1");
  const save = page.elementLocator(group.querySelector<HTMLButtonElement>(".collection-save")!);
  await expect.element(save).toHaveAttribute("aria-pressed", "false");
  await save.click();
  await expect.element(save).toBeDisabled();
  const requested = change.mock.calls[0]![1];
  if (requested.kind !== "set_saved_group") throw new Error("Expected grouped Save");
  expect(requested.legacy_port_ids).toEqual(["collection-0", "collection-1"]);
  expect(requested.saved).toBe(true);
  await captureParityState("discover-group-save-pending");
  rejectWrite(new Error("Fixture grouped Save refused"));
  await expect.element(save).toBeEnabled();
  await expect.element(save).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(
      page.getByRole("group", { name: "Discover collections", exact: true }).getByRole("alert"),
    )
    .toMatchTextContent("These choices could not be saved. Your previous choices were kept.");
  await expect
    .element(
      page.getByRole("group", { name: "Discover collections", exact: true }).getByRole("alert"),
    )
    .toBeVisible();
  await captureParityState("discover-group-save-rejected");
}, 45_000);
