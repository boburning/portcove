import { useState } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { portDefinition, installedLaunchStatus } from "../test-fixtures";
import type { CatalogQuery } from "../features/browsing/catalog-query";
import { queryFromFilter } from "../features/browsing/CatalogFilters";
import type { Organization } from "../features/organization/OrganizationControls";
import type { Filter } from "../view-model";
import { PortBrowser } from "./PortBrowser";

afterEach(cleanup);

const organization: Organization = {
  snapshot: {
    revision: 1,
    followed_port_ids: [],
    followed_release_acknowledgments: {},
    collections: {},
    hidden_port_ids: [],
    saved_game_ids: [],
    update_notices: {},
    setup_confirmations: [],
  },
  busy: false,
  failure: undefined,
  commit: vi.fn().mockResolvedValue(true),
  refresh: vi.fn().mockResolvedValue(true),
};

it.each([
  { membership: [], selected: false },
  { membership: ["in-library"], selected: false },
  { membership: ["not-in-library"], selected: true },
  { membership: ["not-in-library", "in-library"], selected: false },
  { membership: ["in-library", "not-in-library"], selected: false },
])(
  "selects the Not in library quick view only for exact membership $membership",
  async ({ membership, selected }) => {
    const installed = { ...portDefinition(), name: "Installed game" };
    const available = { ...portDefinition(), id: "available", name: "Available game" };
    const statuses = new Map([
      [installed.id, { ...installedLaunchStatus(), port_id: installed.id }],
    ]);
    let current: CatalogQuery;
    function Browse() {
      const [filter, setFilter] = useState<Filter | CatalogQuery>({
        version: 1,
        membership,
        platforms: ["windows-x86-64"],
      });
      current = queryFromFilter(filter);
      return (
        <PortBrowser
          view="catalog"
          organization={organization}
          ports={[installed, available]}
          statuses={statuses}
          queryContext={{ library: { id: "/fixture/library", statuses } }}
          overview={{ installed: 1, ready: 1, needsSetup: 0, staged: 0 }}
          filter={filter}
          setFilter={setFilter}
          onSelect={vi.fn()}
          loading={false}
        />
      );
    }
    await render(<Browse />);
    const quickView = page.getByRole("button", { name: "Not in library", exact: true });
    await expect.element(quickView).toHaveAttribute("aria-pressed", String(selected));
    await expect.element(quickView).toBeEnabled();
    await quickView.click();
    await expect.element(quickView).toHaveAttribute("aria-pressed", "true");
    expect(current!).toEqual({
      version: 1,
      membership: ["not-in-library"],
      platforms: ["windows-x86-64"],
    });
  },
);
