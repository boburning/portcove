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
async function openAdvancedFilters(name: string) {
  await userEvent.click(button(name));
  if (!document.querySelector<HTMLDetailsElement>("[role=dialog] details")?.open)
    await userEvent.click(page.getByText("Advanced filters", { exact: true }));
}
async function closeFilters() {
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
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
    await userEvent.click(button("Ready (2)"));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(button("Linux (1)"));
    await closeFilters();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(button("Filters (1)")).toHaveFocus();
    await expect.element(button("Ready (1)")).toHaveAttribute("aria-pressed", "true");
    await expect.element(button("Needs attention (1)")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button("Needs attention (1)"));
    await expect.element(button("Remove Linux filter")).toBeInTheDocument();
    await openAdvancedFilters("Filters (1)");
    await expect.element(button("Windows (1)")).toBeEnabled();
    await userEvent.click(button("Preview (1)"));
    await closeFilters();
    await userEvent.click(button("Ready (1)"));
    await expect.element(button("Remove Preview filter")).toBeInTheDocument();
    await userEvent.click(button("View details for Linux game Port: Linux game"));
    await userEvent.click(button("Back to library"));
    await expect.element(button("Ready (1)")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button("Switch section"));
    await expect.element(button("Filters (0)")).toBeInTheDocument();
    await userEvent.click(button("Switch section"));
    await expect.element(button("Filters (2)")).toBeInTheDocument();
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<Fixture />));
    await expect.element(button("Ready (1)")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button("Switch library"));
    await expect.element(button("All (3)")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button("Switch library"));
    await expect.element(button("Ready (1)")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(button("Favorites (1)"));
    await expect.element(button("Needs attention (1)")).toBeEnabled();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Search library" }),
      "no matching title",
    );
    await expect.element(button("Ready (0)")).toBeEnabled();
    await openAdvancedFilters("Filters (2)");
    await expect.element(button("Linux (0)")).toBeEnabled();
    await closeFilters();
    await expect.element(button("Filters (2)")).toHaveFocus();
    const chip = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Linux filter"]',
    )!;
    chip.focus();
    await expect.element(button("Remove Linux filter")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(button("Remove Linux filter")).not.toBeInTheDocument();
    await expect.element(button("Filters (1)")).toHaveFocus();
    await userEvent.click(
      page.getByRole("button", { name: "Clear search and filters", exact: true }),
    );
    await expect.element(button("All (3)")).toHaveAttribute("aria-pressed", "true");
    await expect.element(button("Filters (0)")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  },
);
it("distinguishes missing snapshot and Favorites from known empty while preserving removable selections", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(button("Linux (2)"));
  await closeFilters();
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Ready (unavailable)")).toBeEnabled();
  await openAdvancedFilters("Filters (1)");
  await expect.element(button("Linux (unavailable)")).toHaveAttribute("aria-pressed", "true");
  await closeFilters();
  await userEvent.click(button("Toggle snapshot"));
  await userEvent.click(button("Favorites (2)"));
  await userEvent.click(button("Toggle favorite facts"));
  await expect.element(button("Ready (unavailable)")).toBeEnabled();
  await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
  await userEvent.click(button("Toggle favorite facts"));
  await userEvent.click(button("Toggle empty"));
  await expect.element(button("Ready (0)")).toBeEnabled();
  await openAdvancedFilters("Filters (1)");
  await expect.element(button("Linux (0)")).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(button("Reset library filters"));
  await closeFilters();
  expect(invoke).not.toHaveBeenCalled();
});
it("clears retained Favorites when its facts are unavailable", async () => {
  flushSync(() => root.render(<Fixture />));
  await userEvent.click(button("Favorites (2)"));
  await userEvent.click(button("Toggle favorite facts"));
  await expect.element(button("Favorites (unavailable)")).toBeDisabled();
  await userEvent.click(button("Clear search and filters"));
  await expect.element(button("Favorites (unavailable)")).toHaveAttribute("aria-pressed", "false");
  await expect.element(button("All (3)")).toHaveAttribute("aria-pressed", "true");
});
it("holds unknown migrated readiness and query separately until correction", async () => {
  flushSync(() => root.render(<Fixture />));
  await userEvent.click(button("Ready (2)"));
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
  await userEvent.click(button("All (unavailable)"));
  expect(JSON.parse(localStorage.getItem(key)!) as unknown).toMatchObject({
    inputs: { sections: { library: { filter: { version: 99 } } } },
  });
  await openAdvancedFilters("Filters (0)");
  await expect.element(button("Linux (unavailable)")).toBeDisabled();
  await userEvent.click(button("Reset library filters"));
  await expect.element(button("Linux (2)")).toBeEnabled();
  await closeFilters();
  expect(invoke).not.toHaveBeenCalled();
});

it("retains Library narrowing and readiness counts for membership without relaxing a zero match", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(button("Not in my library (0)"));
  await closeFilters();
  await expect.element(button("Ready (0)")).toBeEnabled();
  await expect
    .element(
      page.getByText("No ports in your library match your search and filters", { exact: true }),
    )
    .toBeInTheDocument();
  await openAdvancedFilters("Filters (1)");
  await userEvent.click(button("In my library (3)"));
  await closeFilters();
  await expect.element(button("Ready (2)")).toBeEnabled();
  await userEvent.click(button("Ready (2)"));
  await openAdvancedFilters("Filters (2)");
  await expect.element(button("In my library (2)")).toBeEnabled();
  await userEvent.click(button("Not in my library (0)"));
  await closeFilters();
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Ready (unavailable)")).toBeEnabled();
  await expect.element(page.getByText("Ports unavailable", { exact: true })).toBeInTheDocument();
  await expect.element(button("Remove In my library filter")).toBeInTheDocument();
  await userEvent.click(button("Remove In my library filter"));
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Ready (2)")).toBeEnabled();
  expect(invoke).not.toHaveBeenCalled();
});

it("retains specific attention with independent Library readiness, zero counts and unavailable removable focus", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(button("Missing game files (1)"));
  await expect.element(button("Finish setup (0)")).toBeEnabled();
  await closeFilters();
  await expect.element(button("Ready (0)")).toBeEnabled();
  await expect.element(button("Needs attention (1)")).toBeEnabled();
  await userEvent.click(button("Ready (0)"));
  await expect
    .element(
      page.getByText("No ports in your library match your search and filters", { exact: true }),
    )
    .toBeInTheDocument();
  await openAdvancedFilters("Filters (1)");
  await expect.element(button("Missing game files (0)")).toHaveAttribute("aria-pressed", "true");
  await closeFilters();
  await userEvent.click(button("Needs attention (1)"));
  await userEvent.click(button("View details for Both game Port: Both game"));
  await userEvent.click(button("Back to library"));
  await expect.element(button("Remove Missing game files filter")).toBeInTheDocument();
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Ready (unavailable)")).toBeEnabled();
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Remove Missing game files filter"]')!
    .focus();
  await expect.element(button("Remove Missing game files filter")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(button("Filters (0)")).toHaveFocus();
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Needs attention (1)")).toHaveAttribute("aria-pressed", "true");
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps playable plus matching staged updates independent from attention with self-excluding counts and zero IPC", async () => {
  flushSync(() => root.render(<Fixture />));
  await userEvent.click(button("Ready (2)"));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(button("Matching update staged (1)"));
  await expect.element(button("Available at last check (1)")).toBeEnabled();
  await closeFilters();
  await expect.element(button("Ready (1)")).toHaveAttribute("aria-pressed", "true");
  await expect.element(button("Needs attention (0)")).toBeEnabled();
  await userEvent.click(button("View details for Windows game Port: Windows game"));
  await userEvent.click(button("Back to library"));
  await openAdvancedFilters("Filters (1)");
  await userEvent.click(button("Available at last check (1)"));
  await userEvent.click(button("Missing game files (0)"));
  await closeFilters();
  await expect.element(button("Ready (0)")).toHaveAttribute("aria-pressed", "true");
  await expect
    .element(
      page.getByText("No ports in your library match your search and filters", { exact: true }),
    )
    .toBeInTheDocument();
  await userEvent.click(button("Remove Missing game files filter"));
  await expect.element(button("Ready (2)")).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Ready (unavailable)")).toBeEnabled();
  await userEvent.click(button("Remove Matching update staged filter"));
  await userEvent.click(button("Remove Available at last check filter"));
  await userEvent.click(button("Toggle snapshot"));
  await expect.element(button("Ready (2)")).toHaveAttribute("aria-pressed", "true");
  expect(invoke).not.toHaveBeenCalled();
});
