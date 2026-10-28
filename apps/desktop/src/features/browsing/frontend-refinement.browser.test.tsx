import { openFilterField } from "../../../test/filter-fields";
import { browserFixture } from "../../../test/browser-fixture";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { PortBrowser } from "../../components/PortBrowser";
import { CatalogFilters } from "./CatalogFilters";
import type { CatalogQuery } from "./catalog-query";
import type { CatalogEntry } from "./catalog-entry";
import type { Filter } from "../../view-model";
import { portDefinition } from "../../test-fixtures";
import "../../styles/index.css";

const entries: CatalogEntry[] = ["Harbor Project", "Harbor Alternative", "Another Project"].map(
  (name, index) => ({
    ...portDefinition(),
    id: `harbor-${index}`,
    name,
    channels: [index ? "beta" : "stable"],
    presentation: {
      original_game_title:
        index < 2
          ? "A Very Long Harbor Adventure Across the Northern Sea — Édition complète"
          : "Another Harbor Game",
      installation_method: "portable-package",
      source_requirements: [],
      saves_and_settings: "portcove-managed",
      original_game: {
        format_version: 1,
        id: index < 2 ? "harbor" : "another-game",
        evidence_urls: ["https://example.org/game"],
        source_editions: [
          {
            id: "original",
            title: "Original",
            system: "nintendo-64",
            evidence_urls: ["https://example.org/game"],
          },
        ],
      },
    },
  }),
);
let fixture: ReturnType<typeof browserFixture>;
beforeEach(() => {
  fixture = browserFixture({ attributes: ["data-theme"], styles: ["font-size"], viewport: true });
  fixture.defer(cleanup);
});
afterEach(async () => fixture.dispose());

it.each(
  (["covers", "rows"] as const).flatMap((layout) =>
    (["dark", "light"] as const).map((theme) => ({ layout, theme })),
  ),
)(
  "retains exact filtered destinations and Compare all focus in Discover $layout/$theme",
  async ({ layout, theme }) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1440, 900);
    const select = vi.fn();
    await render(
      <PortBrowser
        view="catalog"
        collectionLayout={layout}
        catalogUniverse={entries}
        ports={[entries[0]!, entries[2]!]}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        query=""
        setQuery={vi.fn()}
        onSelect={select}
        loading={false}
      />,
    );
    await expect
      .element(page.getByRole("textbox", { name: "Search Find games", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "View port", exact: true }).first().click();
    expect(select).toHaveBeenCalledExactlyOnceWith(entries[0]!.id, "catalog:card:harbor-0:details");
    const identities = document.querySelectorAll<HTMLElement>(".discover-game-identity");
    expect(identities).toHaveLength(2);
    for (const identity of identities) {
      const art = identity.querySelector<HTMLElement>(".collection-art")!.getBoundingClientRect();
      const title = identity
        .querySelector<HTMLElement>(".collection-title")!
        .getBoundingClientRect();
      const textSize = Number.parseFloat(getComputedStyle(identity).fontSize);
      const compact = layout === "rows";
      expect(art.width).toBeGreaterThan(0);
      expect(art.width).toBeLessThanOrEqual(textSize * (compact ? 3 : 16));
      expect(art.height).toBeLessThanOrEqual(textSize * (compact ? 4.5 : 24));
      expect(compact ? title.left : title.top).toBeGreaterThan(compact ? art.right : art.bottom);
    }
    await page.screenshot({
      path: `../../../../../outputs/ui-refinement/discover-${layout}-${theme}-1440.png`,
    });
    const compare = page.getByRole("button", { name: "Compare all 2", exact: true });
    await compare.click();
    const dialog = page.getByRole("dialog");
    await expect
      .element(dialog.getByText("Outside the current filters.", { exact: true }))
      .toBeVisible();
    const cards = dialog.element().querySelectorAll("article");
    expect(cards).toHaveLength(2);
    const left = cards[0]!.getBoundingClientRect(),
      right = cards[1]!.getBoundingClientRect();
    expect(right.left).toBeGreaterThanOrEqual(left.right);
    for (const card of cards) expect(card.textContent).toContain("Portable upstream package");
    await page.screenshot({
      path: `../../../../../outputs/ui-refinement/comparison-${layout}-${theme}-1440.png`,
    });
    await page.viewport(740, 900);
    document.documentElement.style.fontSize = "130%";
    await expect
      .poll(() => cards[1]!.getBoundingClientRect().top)
      .toBeGreaterThan(cards[0]!.getBoundingClientRect().top);
    expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
    await page.screenshot({
      path: `../../../../../outputs/ui-refinement/comparison-${layout}-${theme}-740-text-130.png`,
    });
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(compare.element());
    const games = page
      .getByRole("region", { name: "Discover games" })
      .element()
      .querySelectorAll("article");
    expect(games).toHaveLength(2);
    expect(
      Math.abs(games[0]!.getBoundingClientRect().left - games[1]!.getBoundingClientRect().left) < 1,
    ).toBe(layout === "rows");
    await page.screenshot({
      path: `../../../../../outputs/ui-refinement/discover-${layout}-${theme}-740-text-130.png`,
    });
  },
  45_000,
);

it("labels active facets and restores focus after removing chips or clearing while preserving search", async () => {
  function Fixture() {
    const [filter, setFilter] = useState<Filter | CatalogQuery>({
      version: 1,
      channels: ["beta"],
      platforms: ["windows-x86-64"],
    });
    const [search, setSearch] = useState("Harbor");
    return (
      <>
        <input aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <CatalogFilters candidates={entries} filter={filter} setFilter={setFilter} />
      </>
    );
  }
  await render(<Fixture />);
  const chip = page.getByRole("button", { name: "Remove Preview filter", exact: true });
  await expect.element(chip).toHaveTextContent("Release channels: Preview");
  await expect
    .element(page.getByRole("button", { name: /Remove Windows/ }))
    .toMatchTextContent("Target OS:");
  chip.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("button", { name: "Filters (1)", exact: true }))
    .toHaveFocus();
  const clear = page.getByRole("button", { name: "Clear filters", exact: true });
  clear.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("textbox", { name: "Search", exact: true }))
    .toHaveValue("Harbor");
  await expect
    .element(page.getByRole("button", { name: "Filters (0)", exact: true }))
    .toHaveFocus();
  await page.getByRole("button", { name: "Filters (0)", exact: true }).click();
  await page.getByText("How filters work", { exact: true }).click();
  await expect
    .element(
      page.getByText(
        "Choose one or more options. Results match at least one option in each selected group.",
      ),
    )
    .toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("region", { name: "Filter options" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Filters (0)", exact: true }))
    .toHaveFocus();
  await page.getByRole("button", { name: "Filters (0)", exact: true }).click();
  await openFilterField("Release channels");
  await page.getByRole("checkbox", { name: /^Stable/ }).click();
  await userEvent.keyboard("{Escape}");
  const panelClear = page.getByRole("button", { name: "Clear filters", exact: true });
  panelClear.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("region", { name: "Filter options" })).toBeVisible();
  await expect.element(panelClear).toHaveFocus();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Filters (0)", exact: true }))
    .toHaveFocus();
});

it("routes active work to its owned Activity identity instead of launching", async () => {
  const { PortBrowser } = await import("../../components/PortBrowser");
  const { OperationPresentationProvider } = await import("../operations/operation-presentation");
  const { installedLaunchStatus } = await import("../../test-fixtures");
  const task = vi.fn(),
    launch = vi.fn();
  const port = entries[0]!;
  const status = installedLaunchStatus({ launchable: true, pending_setup: false, blockers: [] });
  await render(
    <OperationPresentationProvider
      generation={1}
      pending={
        new Map([
          [
            1,
            {
              id: 1,
              name: "prepare",
              phase: "pending",
              context: {
                action: "Prepare",
                target: { kind: "port", id: port.id, label: port.name },
                libraryGeneration: 1,
                exclusionScope: "target",
                activityId: "owned-task",
              },
            },
          ],
        ])
      }
    >
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={vi.fn()}
        onContinue={launch}
        onTask={task}
        loading={false}
      />
    </OperationPresentationProvider>,
  );
  await page.getByRole("button", { name: "View task", exact: true }).click();
  expect(task).toHaveBeenCalledExactlyOnceWith("owned-task");
  expect(launch).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Play", exact: true }))
    .not.toBeInTheDocument();
});
