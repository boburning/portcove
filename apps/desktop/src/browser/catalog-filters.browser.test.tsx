import { captureParityState } from "../../test/parity-capture";
import {
  filterChoice,
  closeFilterPanel,
  openAdvancedFilters as openAdvancedPanel,
} from "../../test/filter-fields";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { PortBrowser } from "../components/PortBrowser";
import { openDiscoverPort } from "./discover-test-helpers";
import {
  useLibraryBrowsingContext,
  libraryBrowsingPreferenceKey,
} from "../features/app-shell/use-library-browsing-context";
import { portDefinition, portStatus } from "../test-fixtures";
import { filterPorts, summarizeLibrary } from "../view-model";
import type { PortStatus } from "../types";
import { browsingContextFixture } from "./browsing-context-fixture";
import { BrowsingMatchDetails } from "../features/browsing/BrowsingMatchDetails";
import { evaluateCatalogQuery } from "../features/browsing/catalog-query";
import "../styles/index.css";
const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../api", () => ({ desktopApi: new Proxy({}, { get: () => invoke }) }));
const ports = [
  {
    ...portDefinition(),
    id: "windows",
    name: "Windows game",
    platforms: ["windows-x86-64"] as const,
    channels: ["stable"] as const,
  },
  {
    ...portDefinition(),
    id: "linux",
    name: "Linux game",
    platforms: ["linux-x86-64"] as const,
    channels: ["beta"] as const,
  },
  {
    ...portDefinition(),
    id: "both",
    name: "Both game",
    platforms: ["windows-x86-64", "linux-x86-64"] as const,
    channels: ["stable", "beta"] as const,
  },
].map((port) => ({ ...port, platforms: [...port.platforms], channels: [...port.channels] }));
const statuses = new Map<string, PortStatus>([
  [
    "windows",
    {
      ...portStatus(),
      port_id: "windows",
      readiness: { launchable: true, pending_setup: true, blockers: [] },
      active: {
        id: "managed",
        port_id: "windows",
        version: "1",
        path: "/fixture",
        channel: "stable",
        installed_at: 1,
        verified: true,
        staged: false,
        runtime: null,
        artifact: { asset_name: "fixture.zip", sha256: "a".repeat(64), size: 1 },
        manifest_sha256: "b".repeat(64),
        selected_executable: "game.exe",
      },
    },
  ],
  [
    "both",
    {
      ...portStatus(),
      port_id: "both",
      readiness: {
        launchable: false,
        pending_setup: false,
        blockers: ["missing_bios", "changed_source"],
      },
      external_runtime: {
        id: "external",
        port_id: "both",
        path: "/fixture",
        executable: "game.exe",
        platform: "windows-x86-64",
        version: "1",
        registered_at: 1,
        archive_sha256: "a".repeat(64),
        immutable_tree_sha256: "b".repeat(64),
      },
    },
  ],
]);
const installed = statuses.get("windows")!.active!;
const downloadedUpdate = {
  ...installed,
  id: "candidate",
  version: "2",
  staged: true,
  artifact: { ...installed.artifact, sha256: "c".repeat(64) },
};
const updateSnapshot: NonNullable<PortStatus["last_update_check"]> = {
  checked_at: 10,
  check: {
    port_id: "windows",
    channel: "stable",
    installed_version: installed.version,
    installed_artifact: { ...installed.artifact },
    installed_runtime: null,
    required_runtime: null,
    update_available: true,
    release: {
      version: "2",
      channel: "stable",
      published_at: null,
      asset: {
        name: installed.artifact.asset_name,
        sha256: "c".repeat(64),
        size: installed.artifact.size,
        url: "https://example.com/game.zip",
      },
    },
  },
};
const remember = () => {};
const switchLibrary = async () => {};
let host: HTMLDivElement;
let root: Root;
function Session({ library }: { library: string }) {
  const { ui, workspace } = useLibraryBrowsingContext({
    root: library,
    remember,
    switchLibrary,
    resetLibrary: switchLibrary,
    ready: false,
  });
  const [detail, setDetail] = useState<string>();
  const [facts, setFacts] = useState(true);
  const [downloaded, setDownloaded] = useState(true);
  const selectedStatuses = library.endsWith("a")
    ? new Map(statuses).set("windows", {
        ...statuses.get("windows")!,
        staged: downloaded ? downloadedUpdate : null,
        last_update_check: updateSnapshot,
      })
    : new Map<string, PortStatus>();
  const context = facts ? browsingContextFixture(ports, selectedStatuses, library) : {};
  const { setView } = ui;
  useEffect(() => {
    setView("catalog");
  }, [setView]);
  return (
    <main ref={workspace}>
      <label>
        Search catalog
        <input value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} />
      </label>
      <button onClick={() => setFacts((value) => !value)}>Toggle membership snapshot</button>
      <button onClick={() => setDownloaded((value) => !value)}>Toggle candidate download</button>
      {detail ? (
        <>
          <button onClick={() => setDetail(undefined)}>Back to catalog</button>
          <BrowsingMatchDetails
            portId={detail}
            binding={context.browsing?.workspace_binding_sha256}
            result={evaluateCatalogQuery(
              ports.filter((port) => port.id === detail),
              typeof ui.filter === "string"
                ? { version: 1, channels: ui.filter === "all" ? [] : [ui.filter] }
                : ui.filter,
              context,
            )}
          />
        </>
      ) : (
        <PortBrowser
          view="catalog"
          ports={filterPorts(
            ports,
            selectedStatuses,
            "catalog",
            ui.filter,
            ui.query,
            ui.catalogSort,
            context,
          )}
          catalogFilterCandidates={
            facts ? filterPorts(ports, selectedStatuses, "catalog", "all", ui.query) : undefined
          }
          queryContext={context}
          statuses={selectedStatuses}
          overview={summarizeLibrary(ports, statuses)}
          filter={ui.filter}
          query={ui.query}
          catalogSort={ui.catalogSort}
          setCatalogSort={ui.setCatalogSort}
          setFilter={ui.setFilter}
          onSelect={(id) => setDetail(id)}
          clearFilters={() => {
            ui.setFilter("all");
            ui.setQuery("");
          }}
          loading={false}
        />
      )}
    </main>
  );
}
function Fixture() {
  const [library, setLibrary] = useState("/filters-library-a");
  return (
    <DirectionProvider direction="ltr">
      <button
        onClick={() =>
          setLibrary((current) =>
            current.endsWith("a") ? "/filters-library-b" : "/filters-library-a",
          )
        }
      >
        Switch library
      </button>
      <Session key={library} library={library} />
    </DirectionProvider>
  );
}
beforeEach(() => {
  localStorage.clear();
  invoke.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});
const roleButton = (name: string) => page.getByRole("button", { name, exact: true });
async function openAdvancedFilters(name: string) {
  await userEvent.click(roleButton(name));
  await openAdvancedPanel();
}
const closeFilters = closeFilterPanel;
// Cold browser setup and repeated dialog handoffs share this finite outer budget.
it("keeps host, setup method and membership on one context through details and return without IPC", async () => {
  await page.viewport(1100, 900);
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("For this device (2)"));
  await userEvent.click(await filterChoice("In my library (2)"));
  await expect
    .element(await filterChoice("Linux (0)"))
    .not.toHaveAttribute("aria-disabled", "true");
  await expect
    .element(await filterChoice("Portable upstream package (0)"))
    .not.toHaveAttribute("aria-disabled", "true");
  await userEvent.click(await filterChoice("Portable upstream package (0)"));
  await closeFilters();
  await expect
    .element(page.getByRole("heading", { name: "No matching games", exact: true }))
    .toBeInTheDocument();
  await openAdvancedFilters("Filters (3)");
  await expect.element(await filterChoice("Portable upstream package (0)")).toBeChecked();
  await userEvent.click(await filterChoice("Original disc referenced at launch (1)"));
  await closeFilters();
  expect(document.querySelectorAll("[data-discover-port-ids]")).toHaveLength(1);
  await openDiscoverPort("windows");
  const region = page.getByRole("region", { name: "Matching browsing contexts" });
  await expect.element(region).toBeInTheDocument();
  await expect
    .element(roleButton("Installed build · Windows · Stable · 1"))
    .toHaveAttribute("aria-pressed", "true");
  expect(
    document.querySelector('[aria-label="Matching browsing contexts"]')?.textContent,
  ).toContain("Original disc referenced at launch");
  await userEvent.click(roleButton("Back to catalog"));
  await expect.element(roleButton("Remove For this device filter")).toBeInTheDocument();
  await expect.element(roleButton("Remove Portable upstream package filter")).toBeInTheDocument();
  expect(invoke).not.toHaveBeenCalled();
}, 60_000);
it.each(["dark", "light"])(
  "composes Catalog constraints, keyboard return and persisted library context in %s",
  async (theme) => {
    await page.viewport(960, 720);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(await filterChoice("Windows (2)"));
    await userEvent.click(await filterChoice("Preview (1)"));
    await captureParityState("discover-filters-expanded");
    await expect
      .element(await filterChoice("Linux (2)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await filterChoice("Linux (2)"));
    await userEvent.click(await filterChoice("Linux (2)"));
    await closeFilters();
    await expect.element(roleButton("Filters (2)")).toHaveFocus();
    await expect.element(roleButton("Remove Windows filter")).toBeInTheDocument();
    await expect.element(roleButton("Remove Preview filter")).toBeInTheDocument();
    await captureParityState("discover-selected-filter-chips");
    await openDiscoverPort("both");
    await userEvent.click(roleButton("Back to catalog"));
    await expect.element(roleButton("Remove Windows filter")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expect.element(roleButton("Remove Preview filter")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (2)")).toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "Search catalog" }), "no match");
    await openAdvancedFilters("Filters (2)");
    await expect
      .element(await filterChoice("Windows (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await filterChoice("Windows (0)"));
    await expect
      .element(await filterChoice("Preview (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await closeFilters();
    await expect.element(roleButton("Filters (1)")).toHaveFocus();
    await captureParityState("discover-zero-results");
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Preview filter"]',
    )!;
    chip.focus();
    await expect.element(roleButton("Remove Preview filter")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(roleButton("Filters (0)")).toHaveFocus();
    expect(invoke).not.toHaveBeenCalled();
  },
);
it("retains unsupported persisted intent until explicit reset", async () => {
  flushSync(() => root.render(<Fixture />));
  await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
  const key = libraryBrowsingPreferenceKey("/filters-library-a");
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("Stable (2)"));
  await closeFilters();
  const stored = JSON.parse(localStorage.getItem(key)!) as {
    inputs: { sections: { catalog: { filter: unknown } } };
  };
  stored.inputs.sections.catalog.filter = { version: 999, platforms: ["future"] };
  localStorage.setItem(key, JSON.stringify(stored));
  flushSync(() => root.unmount());
  root = createRoot(host);
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await expect
    .element(await filterChoice("Windows (unavailable)"))
    .toHaveAttribute("aria-disabled", "true");
  expect(JSON.parse(localStorage.getItem(key)!) as unknown).toMatchObject({
    inputs: { sections: { catalog: { filter: { version: 999 } } } },
  });
  await userEvent.click(roleButton("Clear filters"));
  await expect
    .element(await filterChoice("Windows (2)"))
    .not.toHaveAttribute("aria-disabled", "true");
  await closeFilters();
  await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
});

it.each(["dark", "light"])(
  "composes membership, preserves return/restart/library isolation and makes no requests in %s",
  async (theme) => {
    await page.viewport(1100, 800);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(await filterChoice("In my library (2)"));
    await expect
      .element(await filterChoice("Preview (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await filterChoice("Stable (2)"));
    await expect
      .element(await filterChoice("Linux (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await closeFilters();
    expect(document.querySelectorAll("[data-discover-port-ids]")).toHaveLength(2);
    await openDiscoverPort("both");
    await userEvent.click(roleButton("Back to catalog"));
    await expect.element(roleButton("Filters (2)")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expect.element(roleButton("Filters (2)")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
    await openAdvancedFilters("Filters (0)");
    await expect
      .element(await filterChoice("In my library (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await filterChoice("Not in my library (3)"));
    await closeFilters();
    expect(document.querySelectorAll("[data-discover-port-ids]")).toHaveLength(3);
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (2)")).toBeInTheDocument();
    await userEvent.click(roleButton("Toggle membership snapshot"));
    await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove In my library filter"]',
    )!;
    chip.focus();
    await expect.element(roleButton("Remove In my library filter")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(roleButton("Filters (1)")).toHaveFocus();
    await userEvent.click(roleButton("Toggle membership snapshot"));
    await openAdvancedFilters("Filters (1)");
    await userEvent.click(roleButton("Clear filters"));
    await closeFilters();
    expect(invoke).not.toHaveBeenCalled();
  },
);

// macOS job 123627550913 exceeded the 15s harness budget for this multi-step
// return/restart/library-isolation journey; the light case completed in 11.1s.
// Keep every assertion, cleanup and zero retries; allow 30s for this family only.
it.each(["dark", "light"])(
  "composes installation attention with return, restart, unavailable correction and zero IPC in %s",
  async (theme) => {
    await page.viewport(1100, 800);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await expect
      .element(await filterChoice("Missing game files (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await filterChoice("Missing BIOS (1)"));
    await userEvent.click(await filterChoice("Finish setup (1)"));
    await expect
      .element(await filterChoice("Preview (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.click(await filterChoice("Stable (2)"));
    await expect.element(await filterChoice("Finish setup (1)")).toBeChecked();
    await closeFilters();
    await openDiscoverPort("both");
    await userEvent.click(roleButton("Back to catalog"));
    await expect.element(roleButton("Remove Missing BIOS filter")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expect.element(roleButton("Filters (3)")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
    await openAdvancedFilters("Filters (0)");
    await expect
      .element(await filterChoice("Missing BIOS (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await closeFilters();
    await userEvent.click(roleButton("Switch library"));
    await userEvent.click(roleButton("Toggle membership snapshot"));
    await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
    await openAdvancedFilters("Filters (3)");
    await expect
      .element(await filterChoice("Missing BIOS (unavailable)"))
      .toHaveAttribute("aria-disabled", "true");
    await closeFilters();
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Remove Missing BIOS filter"]')!
      .focus();
    await expect.element(roleButton("Remove Missing BIOS filter")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(roleButton("Filters (2)")).toHaveFocus();
    await userEvent.click(roleButton("Remove Finish setup filter"));
    await userEvent.click(roleButton("Toggle membership snapshot"));
    await expect.element(roleButton("Remove Stable filter")).toBeInTheDocument();
    await openAdvancedFilters("Filters (1)");
    await userEvent.click(roleButton("Clear filters"));
    await closeFilters();
    expect(invoke).not.toHaveBeenCalled();
  },
  30_000,
);

it.each(["dark", "light"])(
  "retains exact observed update choices across download changes, return, restart and library isolation in %s",
  async (theme) => {
    await page.viewport(1100, 800);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(await filterChoice("Matching update staged (1)"));
    await expect
      .element(await filterChoice("Available at last check (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await closeFilters();
    await openDiscoverPort("windows");
    await userEvent.click(roleButton("Back to catalog"));
    await expect.element(roleButton("Remove Matching update staged filter")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expect.element(roleButton("Filters (1)")).toBeInTheDocument();
    await userEvent.click(roleButton("Switch library"));
    await openAdvancedFilters("Filters (0)");
    await expect
      .element(await filterChoice("Matching update staged (0)"))
      .not.toHaveAttribute("aria-disabled", "true");
    await closeFilters();
    await userEvent.click(roleButton("Switch library"));
    await userEvent.click(roleButton("Toggle candidate download"));
    await expect
      .element(page.getByRole("heading", { name: "No matching games", exact: true }))
      .toBeInTheDocument();
    await openAdvancedFilters("Filters (1)");
    await expect.element(await filterChoice("Matching update staged (0)")).toBeChecked();
    await userEvent.click(await filterChoice("Available at last check (1)"));
    await closeFilters();
    await userEvent.click(roleButton("Toggle membership snapshot"));
    await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
    document
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Remove Matching update staged filter"]',
      )!
      .focus();
    await expect.element(roleButton("Remove Matching update staged filter")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(roleButton("Filters (1)")).toHaveFocus();
    await userEvent.click(roleButton("Remove Available at last check filter"));
    await userEvent.click(roleButton("Toggle membership snapshot"));
    await expect.element(roleButton("Filters (0)")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  },
);
