import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { PortBrowser } from "./components/PortBrowser";
import { portDefinition } from "./test-fixtures";
import type { PortDefinition } from "./types";

afterEach(cleanup);

it.each(["catalog", "library"] as const)(
  "keeps same-game projects distinct during pointer and keyboard selection in %s",
  async (view) => {
    const ports: PortDefinition[] = ["Cobalt Project", "Amber Recompiled"].map((name, index) => ({
      ...portDefinition(),
      id: `same-game-${index}`,
      name,
      presentation: {
        original_game_title: "A Familiar Adventure",
        variant_label: index === 0 ? "US edition" : null,
        installation_method: "portable-package",
        source_requirements: [],
        saves_and_settings: "portcove-managed",
      },
    }));
    const onSelect = vi.fn();
    await render(
      <PortBrowser
        view={view}
        ports={ports}
        statuses={new Map()}
        overview={{ installed: 0, ready: 0, needsSetup: 0, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={onSelect}
        loading={false}
      />,
    );
    const prefix = view === "library" ? "View details for " : "";
    const first = page.getByRole("button", {
      name: new RegExp(`^${prefix}A Familiar Adventure · Cobalt Project · US edition`),
    });
    const second = page.getByRole("button", {
      name: new RegExp(`^${prefix}A Familiar Adventure · Amber Recompiled`),
    });
    await expect.element(first).toBeVisible();
    await expect.element(second).toBeVisible();
    await first.click();
    expect(onSelect).toHaveBeenLastCalledWith("same-game-0", `${view}:card:same-game-0`);
    second.element().focus();
    expect(document.activeElement).toBe(second.element());
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("same-game-1", `${view}:card:same-game-1`);
    expect(onSelect).toHaveBeenCalledTimes(2);
    await expect
      .element(
        page.getByText(view === "library" ? "Port: Cobalt Project · US edition" : "US edition", {
          exact: true,
        }),
      )
      .toBeVisible();
  },
);
