import { captureParityState } from "../../test/parity-capture";
import { filterChoice } from "../../test/filter-fields";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { PortBrowser } from "../components/PortBrowser";
import {
  useLibraryBrowsingContext,
  libraryBrowsingPreferenceKey,
} from "../features/app-shell/use-library-browsing-context";
import { portDefinition, portStatus } from "../test-fixtures";
import { filterPorts, summarizeLibrary } from "../view-model";
import type { PortStatus } from "../types";
import { browsingContextFixture } from "./browsing-context-fixture";
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
const statuses = new Map<string, PortStatus>(
  ports.map((port) => [
    port.id,
    {
      ...portStatus(),
      port_id: port.id,
      active: {
        id: `${port.id}-install`,
        port_id: port.id,
        channel: "stable",
        version: "1",
        path: "/fixture",
        installed_at: 1,
        staged: false,
        verified: true,
        manifest_sha256: "a".repeat(64),
        selected_executable: "game.exe",
        runtime: null,
        artifact: { asset_name: "fixture.zip", size: 1, sha256: "a".repeat(64) },
      },
      readiness: {
        launchable: port.id !== "both",
        pending_setup: false,
        blockers: port.id === "both" ? ["missing_source"] : [],
      },
    },
  ]),
);
for (const id of ["windows", "linux"]) {
  const status = statuses.get(id)!;
  const active = status.active!;
  const candidate = {
    ...active,
    id: "candidate",
    version: "2",
    staged: true,
    artifact: { ...active.artifact, sha256: "c".repeat(64) },
  };
  statuses.set(id, {
    ...status,
    staged: id === "windows" ? candidate : null,
    last_update_check: {
      checked_at: 10,
      check: {
        port_id: id,
        channel: "stable",
        installed_version: active.version,
        installed_artifact: { ...active.artifact },
        installed_runtime: null,
        required_runtime: null,
        update_available: true,
        release: {
          version: "2",
          channel: "stable",
          published_at: null,
          asset: {
            name: candidate.artifact.asset_name,
            sha256: candidate.artifact.sha256,
            size: candidate.artifact.size,
            url: "https://example.com/game.zip",
          },
        },
      },
    },
  });
}
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
  const [detail, setDetail] = useState(false);
  const [only, setOnly] = useState(false);
  const [facts, setFacts] = useState(true);
  const [favoriteFacts, setFavoriteFacts] = useState(true);
  const [empty, setEmpty] = useState(false);
  const snapshotPorts = empty ? [] : ports;
  const context = facts ? browsingContextFixture(snapshotPorts, statuses, library) : {};
  const candidates = facts
    ? filterPorts(snapshotPorts, statuses, "library", "all", ui.query)
    : undefined;
  const readinessPorts = ["all", "ready", "setup"].includes(ui.libraryReadiness)
    ? filterPorts(
        snapshotPorts,
        statuses,
        "library",
        ui.libraryReadiness as "all" | "ready" | "setup",
        "",
      )
    : [];
  return (
    <main ref={workspace}>
      <label>
        Search library
        <input value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} />
      </label>
      <button onClick={() => ui.setView(ui.view === "library" ? "catalog" : "library")}>
        Switch section
      </button>
      <button onClick={() => setFacts((value) => !value)}>Toggle snapshot</button>
      <button onClick={() => setFavoriteFacts((value) => !value)}>Toggle favorite facts</button>
      <button onClick={() => setEmpty((value) => !value)}>Toggle empty</button>
      {detail ? (
        <button onClick={() => setDetail(false)}>Back to library</button>
      ) : (
        <PortBrowser
          view={ui.view}
          ports={filterPorts(
            facts ? (ui.view === "library" ? readinessPorts : snapshotPorts) : [],
            statuses,
            ui.view,
            ui.filter,
            ui.query,
            ui.catalogSort,
            context,
          )}
          libraryFilterCandidates={candidates}
          queryContext={context}
          catalogFilterCandidates={
            facts ? filterPorts(snapshotPorts, statuses, "catalog", "all", ui.query) : undefined
          }
          libraryReadiness={ui.libraryReadiness}
          setLibraryReadiness={ui.setLibraryReadiness}
          statuses={statuses}
          overview={summarizeLibrary(facts ? snapshotPorts : [], statuses)}
          filter={ui.filter}
          query={ui.query}
          setFilter={ui.setFilter}
          onSelect={() => setDetail(true)}
          loading={!facts}
          favorites={{
            only,
            setOnly,
            ids: favoriteFacts ? new Set(["linux", "both"]) : undefined,
            failure: undefined,
            busy: false,
            toggle: async () => false,
            refresh: async () => false,
          }}
          clearFilters={() => {
            ui.setFilter("all");
            ui.setLibraryReadiness("all");
            ui.setQuery("");
          }}
        />
      )}
    </main>
  );
}
function Fixture() {
  const [library, setLibrary] = useState("/library-filters-a");
  return (
    <DirectionProvider direction="ltr">
      <button
        onClick={() =>
          setLibrary((value) => (value.endsWith("a") ? "/library-filters-b" : "/library-filters-a"))
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
const button = (name: string) => page.getByRole("button", { name, exact: true });
const readiness = () => page.getByRole("combobox", { name: /^Readiness / });
async function revealReadiness() {
  if (document.querySelector("[data-slot=checkbox]")) await userEvent.keyboard("{Escape}");
  const panelTrigger = page.getByRole("button", { name: /^Filters \(\d+\)$/ });
  if (panelTrigger.element().getAttribute("aria-expanded") !== "true") await panelTrigger.click();
  const advanced = page.getByText("Advanced filters", { exact: true });
  if (!advanced.element().closest("details")?.open) await advanced.click();
}
async function expectReadinessLabel(name: string) {
  await revealReadiness();
  await expect.element(readiness()).toHaveAccessibleName(name);
  await closeFilters();
}

async function chooseReadiness(name: string) {
  await revealReadiness();
  await readiness().click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect.element(readiness()).toHaveAttribute("aria-expanded", "false");
  await expect.element(readiness()).toHaveFocus();
  await closeFilters();
}
async function expectReadinessOption(name: string, selected?: boolean) {
  await revealReadiness();
  await readiness().click();
  const option = page.getByRole("option", { name, exact: true });
  await expect.element(option).toBeEnabled();
  await expect
    .element(option)
    .toHaveAttribute(
      "aria-selected",
      String(selected ?? readiness().element().textContent?.includes(name) ?? false),
    );
  await userEvent.keyboard("{Escape}");
  await expect.element(readiness()).toHaveAttribute("aria-expanded", "false");
  await expect.element(readiness()).toHaveFocus();
  await closeFilters();
}
async function openAdvancedFilters(name: string) {
  await userEvent.click(button(name));
  if (!page.getByText("Advanced filters", { exact: true }).element().closest("details")?.open)
    await userEvent.click(page.getByText("Advanced filters", { exact: true }));
}
async function closeFilters() {
  const field = document.querySelector<HTMLButtonElement>(
    '.catalog-filter-panel button[aria-haspopup="dialog"][aria-expanded="true"]',
  );
  if (field) await userEvent.keyboard("{Escape}");
  await expect
    .poll(() =>
      document.querySelector(
        '.catalog-filter-panel button[aria-haspopup="dialog"][aria-expanded="true"]',
      ),
    )
    .toBeNull();
  await expect.poll(() => field === null || document.activeElement === field).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("region", { name: "Filter options", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: /^Filters \(\d+\)$/, exact: true }))
    .toHaveFocus();
}
it.each(["dark", "light"])(
  "retains independent Library constraints, self-excluding counts and return context in %s",
  async (theme) => {
    await page.viewport(1100, 800);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await chooseReadiness("Ready (2)");
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(await filterChoice("Linux (1)"));
    await captureParityState("library-filters-expanded");
    await closeFilters();
    await expect
      .element(page.getByRole("region", { name: "Filter options", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(button("Filters (1)")).toHaveFocus();
    await expectReadinessLabel("Readiness Ready (1)");
    await expectReadinessOption("Needs attention (1)", false);
    await chooseReadiness("Needs attention (1)");
    await expect.element(button("Remove Linux filter")).toBeInTheDocument();
    await openAdvancedFilters("Filters (1)");
    await expect.element(await filterChoice("Windows (1)")).toBeEnabled();
    await userEvent.click(await filterChoice("Preview (1)"));
    await closeFilters();
    await chooseReadiness("Ready (1)");
    await expect.element(button("Remove Preview filter")).toBeInTheDocument();
    const footers = [
      ...document.querySelectorAll<HTMLElement>(".collection-cover .library-entry-footer"),
    ];
    expect(footers.length).toBeGreaterThan(0);
    for (const footer of footers) {
      const bounds = footer.getBoundingClientRect();
      const status = footer
        .querySelector<HTMLElement>(".collection-state")!
        .getBoundingClientRect();
      const actions = footer
        .querySelector<HTMLElement>(".collection-actions")!
        .getBoundingClientRect();
      expect(status.width).toBeGreaterThanOrEqual(Math.min(96, bounds.width) - 1);
      expect(
        status.right <= actions.left ||
          actions.right <= status.left ||
          status.bottom <= actions.top ||
          actions.bottom <= status.top,
      ).toBe(true);
    }
    await captureParityState("library-selected-filter-chips");
    await userEvent.click(button("View details for Linux game Linux game"));
    await userEvent.click(button("Back to library"));
    await expectReadinessLabel("Readiness Ready (1)");
    await userEvent.click(button("Switch section"));
    await expect.element(button("Filters (0)")).toBeInTheDocument();
    await userEvent.click(button("Switch section"));
    await expect.element(button("Filters (2)")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expectReadinessLabel("Readiness Ready (1)");
    await userEvent.click(button("Switch library"));
    await expectReadinessLabel("Readiness All (3)");
    await userEvent.click(button("Switch library"));
    await expectReadinessLabel("Readiness Ready (1)");
    await userEvent.click(button("Favorites 1"));
    await expectReadinessOption("Needs attention (1)");
    await userEvent.fill(
      page.getByRole("textbox", { name: "Search library" }),
      "no matching title",
    );
    await expectReadinessOption("Ready (0)");
    await openAdvancedFilters("Filters (2)");
    await expect.element(await filterChoice("Linux (0)")).toBeEnabled();
    await closeFilters();
    await expect.element(button("Filters (2)")).toHaveFocus();
    await captureParityState("library-zero-results");
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Linux filter"]',
    )!;
    chip.focus();
    await expect.element(button("Remove Linux filter")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(button("Remove Linux filter")).not.toBeInTheDocument();
    await expect.element(button("Filters (1)")).toHaveFocus();
    await userEvent.click(page.getByRole("button", { name: "Reset view", exact: true }));
    await expectReadinessLabel("Readiness All (3)");
    await expect.element(button("Filters (0)")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  },
  // The repeated popover/context journey exhausted 15s in CI with only 14ms left for a click.
  45_000,
);
it("distinguishes missing snapshot and Favorites from known empty while preserving removable selections", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("Linux (2)"));
  await closeFilters();
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessOption("Ready (unavailable)");
  await openAdvancedFilters("Filters (1)");
  await expect
    .element(await filterChoice("Linux (unavailable)"))
    .toHaveAttribute("aria-checked", "true");
  await closeFilters();
  await userEvent.click(button("Toggle snapshot"));
  await userEvent.click(button("Favorites 2"));
  await userEvent.click(button("Toggle favorite facts"));
  await expectReadinessOption("Ready (unavailable)");
  await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
  await captureParityState("library-unavailable-facts");
  await userEvent.click(button("Toggle favorite facts"));
  await userEvent.click(button("Toggle empty"));
  await expectReadinessOption("Ready (0)");
  await openAdvancedFilters("Filters (1)");
  await expect.element(await filterChoice("Linux (0)")).toHaveAttribute("aria-checked", "true");
  await userEvent.click(button("Clear filters"));
  await closeFilters();
  expect(invoke).not.toHaveBeenCalled();
});
it("clears retained Favorites when its facts are unavailable", async () => {
  flushSync(() => root.render(<Fixture />));
  await userEvent.click(button("Favorites 2"));
  await userEvent.click(button("Toggle favorite facts"));
  await expect.element(button("Favorites unavailable")).toBeDisabled();
  await userEvent.click(button("Reset view"));
  await expect.element(button("Favorites unavailable")).toHaveAttribute("aria-pressed", "false");
  await expectReadinessLabel("Readiness All (3)");
});
it("holds unknown migrated readiness and query separately until correction", async () => {
  flushSync(() => root.render(<Fixture />));
  await chooseReadiness("Ready (2)");
  const key = libraryBrowsingPreferenceKey("/library-filters-a");
  const stored = JSON.parse(localStorage.getItem(key)!) as {
    inputs: { sections: { library: { filter: unknown; readiness: string } } };
  };
  stored.inputs.sections.library.readiness = "future";
  stored.inputs.sections.library.filter = { version: 99, platforms: ["future"] };
  localStorage.setItem(key, JSON.stringify(stored));
  flushSync(() => root.unmount());
  root = createRoot(host);
  flushSync(() => root.render(<Fixture />));
  await expect
    .element(page.getByText(/Restored readiness “future” is not supported/))
    .toBeInTheDocument();
  await chooseReadiness("All (unavailable)");
  expect(JSON.parse(localStorage.getItem(key)!) as unknown).toMatchObject({
    inputs: { sections: { library: { filter: { version: 99 } } } },
  });
  await openAdvancedFilters("Filters (0)");
  await expect.element(await filterChoice("Linux (unavailable)")).toBeDisabled();
  await userEvent.click(button("Clear filters"));
  await expect.element(await filterChoice("Linux (2)")).toBeEnabled();
  await closeFilters();
  expect(invoke).not.toHaveBeenCalled();
});

it("retains Library narrowing and readiness counts for membership without relaxing a zero match", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("Not in my library (0)"));
  await closeFilters();
  await expectReadinessOption("Ready (0)");
  await expect
    .element(page.getByText("No matching library entries", { exact: true }))
    .toBeInTheDocument();
  await openAdvancedFilters("Filters (1)");
  await userEvent.click(await filterChoice("In my library (3)"));
  await closeFilters();
  await expectReadinessOption("Ready (2)");
  await chooseReadiness("Ready (2)");
  await openAdvancedFilters("Filters (2)");
  await expect.element(await filterChoice("In my library (2)")).toBeEnabled();
  await userEvent.click(await filterChoice("Not in my library (0)"));
  await closeFilters();
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessOption("Ready (unavailable)");
  await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
  await expect.element(button("Remove In my library filter")).toBeInTheDocument();
  await userEvent.click(button("Remove In my library filter"));
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessOption("Ready (2)");
  expect(invoke).not.toHaveBeenCalled();
}, 45_000);

it("retains specific attention with independent Library readiness, zero counts and unavailable removable focus", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("Missing game files (1)"));
  await expect.element(await filterChoice("Finish setup (0)")).toBeEnabled();
  await closeFilters();
  await expectReadinessOption("Ready (0)");
  await expectReadinessOption("Needs attention (1)");
  await chooseReadiness("Ready (0)");
  await expect
    .element(page.getByText("No matching library entries", { exact: true }))
    .toBeInTheDocument();
  await openAdvancedFilters("Filters (1)");
  await expect
    .element(await filterChoice("Missing game files (0)"))
    .toHaveAttribute("aria-checked", "true");
  await closeFilters();
  await chooseReadiness("Needs attention (1)");
  await userEvent.click(button("View details for Both game Both game"));
  await userEvent.click(button("Back to library"));
  await expect.element(button("Remove Missing game files filter")).toBeInTheDocument();
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessOption("Ready (unavailable)");
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Remove Missing game files filter"]')!
    .focus();
  await expect.element(button("Remove Missing game files filter")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(button("Filters (0)")).toHaveFocus();
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessLabel("Readiness Needs attention (1)");
  expect(invoke).not.toHaveBeenCalled();
}, 30_000);

it("keeps playable plus matching staged updates independent from attention with self-excluding counts and zero IPC", async () => {
  flushSync(() => root.render(<Fixture />));
  await chooseReadiness("Ready (2)");
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("Matching update staged (1)"));
  await expect.element(await filterChoice("Available at last check (1)")).toBeEnabled();
  await closeFilters();
  await expectReadinessLabel("Readiness Ready (1)");
  await expectReadinessOption("Needs attention (0)");
  await userEvent.click(button("View details for Windows game Windows game"));
  await userEvent.click(button("Back to library"));
  await openAdvancedFilters("Filters (1)");
  await userEvent.click(await filterChoice("Available at last check (1)"));
  await userEvent.click(await filterChoice("Missing game files (0)"));
  await closeFilters();
  await expectReadinessLabel("Readiness Ready (0)");
  await expect
    .element(page.getByText("No matching library entries", { exact: true }))
    .toBeInTheDocument();
  await userEvent.click(button("Remove Missing game files filter"));
  await expectReadinessLabel("Readiness Ready (2)");
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessOption("Ready (unavailable)");
  await userEvent.click(button("Remove Matching update staged filter"));
  await userEvent.click(button("Remove Available at last check filter"));
  await userEvent.click(button("Toggle snapshot"));
  await expectReadinessLabel("Readiness Ready (2)");
  expect(invoke).not.toHaveBeenCalled();
}, 45_000);

it("composes quick views with declared filters and clears only quick-view scope from All games", async () => {
  flushSync(() => root.render(<Fixture />));
  const search = page.getByRole("textbox", { name: "Search library", exact: true });
  await search.fill("game");
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(await filterChoice("Windows (2)"));
  await closeFilters();
  await page.getByRole("button", { name: "Favorites 1", exact: true }).click();
  const quick = page.getByRole("group", { name: "Library quick views", exact: true });
  await quick.getByRole("button", { name: "Updates", exact: true }).click();
  await expect
    .element(quick.getByRole("button", { name: "Updates", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect.element(button("Remove Windows filter")).toBeVisible();
  await expect.element(button("Remove Available at last check filter")).toBeVisible();
  await expect.element(button("Remove Matching update staged filter")).toBeVisible();
  await quick.getByRole("button", { name: "All games", exact: true }).click();
  await expect.element(search).toHaveValue("game");
  await expect.element(button("Remove Windows filter")).toBeVisible();
  await expect.element(button("Remove Available at last check filter")).not.toBeInTheDocument();
  await expect.element(button("Remove Matching update staged filter")).not.toBeInTheDocument();
  await expect.element(button("Favorites 1")).toHaveAttribute("aria-pressed", "false");
  await expect
    .element(quick.getByRole("button", { name: "Updates", exact: true }))
    .toHaveAttribute("aria-pressed", "false");
  expect(document.querySelectorAll(".collection-entry")).toHaveLength(2);
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps selected filter labels and their popover bounded at 320px with enlarged text", async () => {
  await page.viewport(320, 844);
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.fontSize = "32px";
  try {
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(await filterChoice("Linux (2)"));
    await userEvent.click(await filterChoice("Preview (2)"));
    await closeFilters();
    const preview = page.getByRole("button", { name: "Remove Preview filter", exact: true });
    const linux = page.getByRole("button", { name: "Remove Linux filter", exact: true });
    await expect.element(preview).toHaveTextContent("Release channels: Preview");
    await expect.element(linux).toHaveTextContent("Target OS: Linux");
    for (const chip of [preview, linux]) {
      const element = chip.element();
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(innerWidth + 1);
    }
    await captureParityState("library-selected-chips-narrow-text-200");
    await openAdvancedFilters("Filters (2)");
    const panel = page.getByRole("region", { name: "Filter options", exact: true });
    await expect.element(panel).toBeVisible();
    const panelBounds = panel.element().getBoundingClientRect();
    const overflowing = [...panel.element().querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.getBoundingClientRect().right > panelBounds.right + 1)
      .map((element) => `${element.className}: ${element.textContent}`);
    expect(panel.element().scrollWidth, overflowing.join("\n")).toBeLessThanOrEqual(
      panel.element().clientWidth + 1,
    );
    await captureParityState("library-selected-popover-narrow-text-200");
    await closeFilters();
    await expect.element(button("Filters (2)")).toHaveFocus();
  } finally {
    document.documentElement.style.removeProperty("font-size");
  }
}, 45_000);
