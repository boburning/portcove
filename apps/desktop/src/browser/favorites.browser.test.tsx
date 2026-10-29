import { openFilterField } from "../../test/filter-fields";
import { evaluateCatalogQuery, type CatalogQuery } from "../features/browsing/catalog-query";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { PortBrowser } from "../components/PortBrowser";
import { useFavorites } from "../features/favorites/use-favorites";
import { portDefinition } from "../test-fixtures";
import type { Filter, View } from "../view-model";
import "../styles/index.css";
const api = vi.hoisted(() => ({ favoritePorts: vi.fn(), setPortFavorite: vi.fn() }));
vi.mock("../api", () => ({ desktopApi: api }));
const one = { ...portDefinition(), id: "one-port", name: "One independent port" };
const two = { ...portDefinition(), id: "two-port", name: "Two independent port" };
let host: HTMLDivElement;
let root: Root;
let saved: Map<number, Set<string>>;
function Fixture({ generation = 1, renamed = false }: { generation?: number; renamed?: boolean }) {
  const favorites = useFavorites(generation);
  const [filter, setFilter] = useState<Filter | CatalogQuery>("all");
  const [view, setView] = useState<View>("catalog");
  const [detail, setDetail] = useState(false);
  const ports = [{ ...one, name: renamed ? "Corrected independent name" : one.name }, two];
  return (
    <DirectionProvider direction="ltr">
      <main>
        <button onClick={() => setView(view === "catalog" ? "library" : "catalog")}>
          Switch browsing view
        </button>
        {detail ? (
          <button onClick={() => setDetail(false)}>Back to ports</button>
        ) : (
          <PortBrowser
            view={view}
            ports={filter === "all" ? ports : evaluateCatalogQuery(ports, filter).ports}
            catalogFilterCandidates={ports}
            statuses={new Map()}
            overview={{ installed: 2, ready: 0, needsSetup: 2, staged: 0 }}
            filter={filter}
            setFilter={setFilter}
            onSelect={() => setDetail(true)}
            loading={false}
            favorites={favorites}
            clearFilters={() => setFilter("all")}
          />
        )}
      </main>
    </DirectionProvider>
  );
}
beforeEach(() => {
  saved = new Map([
    [1, new Set(["absent-port"])],
    [2, new Set()],
  ]);
  api.favoritePorts
    .mockReset()
    .mockImplementation(async (generation: number) => [...(saved.get(generation) ?? [])]);
  api.setPortFavorite
    .mockReset()
    .mockImplementation(async (id: string, favorite: boolean, generation: number) => {
      const ids = saved.get(generation)!;
      if (favorite) ids.add(id);
      else ids.delete(id);
    });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
});
it.each(["dark", "light"])(
  "composes private choices, counts and independent keyboard controls in %s",
  async (theme) => {
    await page.viewport(960, 640);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    const toggle = page.getByRole("button", { name: "Favorite One independent port", exact: true });
    await expect.element(toggle).toBeEnabled();
    const domToggle = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Favorite One independent port"]',
    )!;
    expect(domToggle.closest("button button")).toBeNull();
    domToggle.focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(domToggle);
    expect(saved.get(1)?.has("absent-port")).toBe(true);
    await userEvent.click(page.getByRole("button", { name: "Favorites (1)", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Favorite Two independent port", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Filters (0)", exact: true }));
    await openFilterField("Release channels");
    await userEvent.click(page.getByRole("checkbox", { name: "Stable (1)", exact: true }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Done", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Remove Stable filter", exact: true }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Filters (1)", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Clear filters", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Done", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Remove Stable filter", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Favorites (1)", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    const details = page.getByRole("button").filter({
      has: page.getByRole("heading", { name: "One independent port", exact: true }),
    });
    await expect.element(details).toHaveAccessibleName(/^One independent port/);
    await expect.element(details).toHaveAccessibleDescription(/Setup/);
    await expect
      .element(details.element().closest("article")!)
      .toHaveAccessibleName(/^One independent port.*Setup/);
    await userEvent.click(details);
    await userEvent.click(page.getByRole("button", { name: "Back to ports", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Favorite One independent port", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(page.getByRole("button", { name: "Switch browsing view", exact: true }));
    await page.getByRole("button", { name: "More actions for One independent port" }).click();
    await page.getByRole("menuitem", { name: "Remove from favorites", exact: true }).click();
    await expect
      .poll(() => document.activeElement?.hasAttribute("data-favorites-filter"))
      .toBe(true);
    await expect
      .element(page.getByRole("button", { name: "Reset view", exact: true }).first())
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Reset view", exact: true }).first());
    await expect
      .element(
        page.getByRole("button", { name: "More actions for Two independent port", exact: true }),
      )
      .toBeVisible();
    flushSync(() => root.render(<Fixture renamed />));
    await page.getByRole("button", { name: "More actions for Corrected independent name" }).click();
    await page.getByRole("menuitem", { name: "Add to favorites", exact: true }).click();
    await expect.poll(() => saved.get(1)?.has("one-port")).toBe(true);
    flushSync(() => root.render(<Fixture generation={2} />));
    await page.getByRole("button", { name: "More actions for One independent port" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Add to favorites", exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    flushSync(() => root.render(<Fixture generation={1} renamed />));
    await page.getByRole("button", { name: "More actions for Corrected independent name" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Remove from favorites", exact: true }))
      .toBeVisible();
  },
);

it("reconciles a possibly committed rejection and returns retry focus to the current filter", async () => {
  api.setPortFavorite.mockImplementationOnce(
    async (id: string, _favorite: boolean, generation: number) => {
      saved.get(generation)!.add(id);
      throw new Error("reply lost after durable publication");
    },
  );
  flushSync(() => root.render(<Fixture />));
  const toggle = page.getByRole("button", { name: "Favorite One independent port", exact: true });
  await expect.element(toggle).toBeEnabled();
  await userEvent.click(toggle);
  await expect
    .element(page.getByText("Favorite choice could not be confirmed", { exact: true }))
    .toBeVisible();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(page.getByRole("button", { name: "Retry favorites", exact: true }));
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => document.activeElement?.hasAttribute("data-favorites-filter")).toBe(true);
});
it("does not move the new library's focus when an old write resolves", async () => {
  let finish!: () => void;
  api.setPortFavorite.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  flushSync(() => root.render(<Fixture />));
  const toggle = page.getByRole("button", { name: "Favorite One independent port", exact: true });
  await expect.element(toggle).toBeEnabled();
  await userEvent.click(toggle);
  flushSync(() => root.render(<Fixture generation={2} />));
  await expect.element(toggle).toBeEnabled();
  const focus = document.querySelector<HTMLButtonElement>("main > button")!;
  focus.focus();
  finish();
  await expect.poll(() => document.activeElement === focus).toBe(true);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
});

it("keeps focus on a failed retry and uses the empty Library action after successful retry", async () => {
  function EmptyFixture() {
    const favorites = useFavorites(1);
    return (
      <PortBrowser
        view="library"
        ports={[]}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={() => {}}
        onSelect={() => {}}
        loading={false}
        favorites={favorites}
      />
    );
  }
  api.favoritePorts.mockRejectedValueOnce(new Error("unreadable"));
  flushSync(() => root.render(<EmptyFixture />));
  const retry = page.getByRole("button", { name: "Retry favorites", exact: true });
  await expect.element(retry).toBeVisible();
  api.favoritePorts.mockRejectedValueOnce(new Error("still unreadable"));
  await userEvent.click(retry);
  await expect.poll(() => document.activeElement?.textContent).toBe("Retry favorites");
  await userEvent.click(retry);
  await expect.element(retry).not.toBeInTheDocument();
  await expect.poll(() => document.activeElement?.textContent).toBe("Add games");
});
