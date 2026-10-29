import { openFilterField } from "../../test/filter-fields";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { PortBrowser } from "../components/PortBrowser";
import { ReleaseChannelControl } from "../components/ReleaseChannel";
import { portDefinition, portStatus } from "../test-fixtures";
import type { PortStatus, ReleaseChannel } from "../types";
import { filterPorts, summarizeLibrary, type Filter } from "../view-model";
import type { CatalogQuery } from "../features/browsing/catalog-query";
import "../styles/index.css";

vi.mock("../api", () => ({ desktopApi: {} }));
const ports = [
  { ...portDefinition(), id: "preview", name: "Upstream Beta 12", channels: ["beta" as const] },
  { ...portDefinition(), id: "stable", name: "Stable-only port", channels: ["stable" as const] },
];
const statuses = new Map<string, PortStatus>();
let root: Root;
let host: HTMLDivElement;
let query: Filter | CatalogQuery;
const change = vi.fn(async (channel: ReleaseChannel) => ({ ...portStatus(), channel }));
const refresh = vi.fn(async () => ({}));
function Fixture() {
  const [filter, setFilter] = useState<Filter | CatalogQuery>("all");
  query = filter;
  return (
    <main className="p-4">
      <PortBrowser
        view="catalog"
        ports={filterPorts(ports, statuses, "catalog", filter, "")}
        catalogFilterCandidates={ports}
        statuses={statuses}
        overview={summarizeLibrary(ports, statuses)}
        filter={filter}
        setFilter={setFilter}
        onSelect={() => {}}
        loading={false}
      />
      <ReleaseChannelControl
        channels={["stable", "beta", "rolling"]}
        selected="beta"
        busy={false}
        change={change}
        refresh={refresh}
      />
    </main>
  );
}
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  change.mockClear();
  refresh.mockClear();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
});
it.each(["light", "dark"])(
  "presents Preview while keeping beta identities in %s",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(1280, 800);
    flushSync(() =>
      root.render(
        <DirectionProvider direction="ltr">
          <Fixture />
        </DirectionProvider>,
      ),
    );
    const preview = page.getByRole("checkbox", { name: "Preview (1)", exact: true });
    const stableOnly = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Stable-only port", exact: true }) });
    await expect.element(stableOnly).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Filters (0)", exact: true }));
    await openFilterField("Release channels");
    await userEvent.click(preview);
    await expect.element(preview).toHaveAttribute("aria-checked", "true");
    expect(query).toEqual({ version: 1, channels: ["beta"] });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Done", exact: true }));
    await expect
      .element(
        page
          .getByRole("article")
          .filter({ has: page.getByRole("heading", { name: "Upstream Beta 12", exact: true }) }),
      )
      .toBeVisible();
    await expect.element(stableOnly).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    const selector = page.getByRole("combobox");
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "Preview", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(selector).toHaveFocus();
    await userEvent.click(selector);
    await userEvent.click(page.getByRole("option", { name: "Rolling", exact: true }));
    expect(change).toHaveBeenCalledExactlyOnceWith("rolling");
    await expect.poll(() => refresh.mock.calls.length).toBe(1);
    await expect
      .element(page.getByRole("status").filter({ hasText: "Rolling selected." }))
      .toHaveTextContent("Rolling selected. Release information refreshed.");
  },
);
