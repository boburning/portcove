import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { PortBrowser } from "../../components/PortBrowser";
import { CatalogFilters } from "./CatalogFilters";
import type { CatalogQuery } from "./catalog-query";
import type { CatalogEntry } from "./catalog-entry";
import type { Filter } from "../../view-model";
import { portDefinition } from "../../test-fixtures";
import "../../styles/index.css";

const entries: CatalogEntry[] = ["Harbor Project", "Harbor Alternative"].map((name, index) => ({
  ...portDefinition(),
  id: `harbor-${index}`,
  name,
  channels: [index ? "beta" : "stable"],
  presentation: {
    original_game_title: "A Very Long Harbor Adventure Across the Northern Sea — Édition complète",
    installation_method: "portable-package",
    source_requirements: [],
    saves_and_settings: "portcove-managed",
    original_game: {
      format_version: 1,
      id: "harbor",
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
}));
afterEach(cleanup);

it.each(["covers", "rows"] as const)(
  "retains exact filtered destinations and Compare all focus in Discover %s",
  async (layout) => {
    await page.viewport(1440, 900);
    const select = vi.fn();
    await render(
      <PortBrowser
        view="catalog"
        collectionLayout={layout}
        catalogUniverse={entries}
        ports={[entries[0]!]}
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
    await page.getByRole("button", { name: "View port", exact: true }).click();
    expect(select).toHaveBeenCalledExactlyOnceWith(entries[0]!.id, "catalog:card:harbor-0:details");
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
    await page.viewport(740, 900);
    await expect
      .poll(() => cards[1]!.getBoundingClientRect().top)
      .toBeGreaterThan(cards[0]!.getBoundingClientRect().top);
    expect(dialog.element().scrollWidth).toBeLessThanOrEqual(dialog.element().clientWidth + 1);
    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    await expect.poll(() => document.activeElement).toBe(compare.element());
  },
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
    .toHaveTextContent("Target OS:");
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
