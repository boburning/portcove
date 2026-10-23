import { DirectionProvider } from "@base-ui/react/direction-provider";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { GameFileFilterObservation } from "../components/GameFileFilterObservation";
import { GameFileQueryControl } from "../components/GameFileQuery";
import { GameFileObservationSummary } from "../features/browsing/GameFileObservationSummary";
import { PortBrowser } from "../components/PortBrowser";
import { DetailLayout } from "../components/DetailLayout";
import { useDetailWorkspaceNavigation } from "../features/app-shell/use-detail-workspace-navigation";
import { useLibraryBrowsingContext } from "../features/app-shell/use-library-browsing-context";
import { useGameFileFilterContext } from "../features/browsing/use-game-file-filter-context";
import { portDefinition } from "../test-fixtures";
import type { GameFileQueryRefreshRequest, GameFileQuerySnapshot, PortStatus } from "../types";
import { filterPorts, summarizeLibrary } from "../view-model";
import "../styles/index.css";

vi.mock("../api", () => ({
  desktopApi: { libraryIdentity: vi.fn(), refreshGameFileQuery: vi.fn(), cancelOperation: vi.fn() },
}));
const ports = ["Complete", "Missing", "Checking", "Empty", "Unknown"]
  .map((name) => ({
    ...portDefinition(),
    id: name.toLowerCase(),
    name: `${name} game`,
    platforms: ["windows-x86-64", "linux-x86-64"] as const,
    channels: ["stable", "beta"] as const,
  }))
  .map((port) => ({ ...port, platforms: [...port.platforms], channels: [...port.channels] }));
const catalog = { schema_version: 2, ports };
const empty = new Map<string, PortStatus>();
const availableIds = new Set(ports.map((port) => port.id));
const remember = () => {};
const switchLibrary = async () => {};
const response = (request: GameFileQueryRefreshRequest): GameFileQuerySnapshot => ({
  schema_version: 1,
  library: { id: "opaque-core", root: "/private-game-files" },
  observed_at: Math.floor(Date.now() / 1000),
  expires_at: Math.floor(Date.now() / 1000) + 300,
  catalog_binding_sha256: "a".repeat(64),
  registration_sha256: "b".repeat(64),
  selection_sha256: "c".repeat(64),
  routes: request.routes.map((route, index) => ({
    ...route,
    state: [
      "files_available",
      "files_missing",
      "needs_checking",
      "no_files_required",
      "unavailable_context",
    ][index] as GameFileQuerySnapshot["routes"][number]["state"],
    reason: [
      "complete_compatible_observation",
      "no_connected_registration",
      "storage_absence_unconfirmed",
      "explicit_empty_requirements",
      "observation_unavailable",
    ][index] as GameFileQuerySnapshot["routes"][number]["reason"],
    contract_id: index === 0 ? "contract" : null,
    identity:
      index === 0
        ? { game_id: "profile", variant_id: "variant", representation_id: "complete-set" }
        : null,
    source_instance_sha256: index === 0 ? "d".repeat(64) : null,
    route_definition_sha256: index === 4 ? null : "e".repeat(64),
    route_instance_sha256: null,
  })),
});

function Session({ library }: { library: string }) {
  const { ui, workspace } = useLibraryBrowsingContext({
    root: library,
    remember,
    switchLibrary,
    resetLibrary: switchLibrary,
    ready: false,
  });
  const [generation, setGeneration] = useState(1);
  const observation = useGameFileFilterContext({
    catalog,
    sources: [],
    statuses: [],
    generation,
    libraryKey: library,
  });
  const navigation = useDetailWorkspaceNavigation(workspace, ui.setSelectedId, availableIds);
  const context = { library: { id: library, statuses: empty }, gameFiles: observation.context };
  const { setView } = ui;
  useEffect(() => setView("catalog"), [setView]);
  return (
    <main ref={workspace} data-focus-region="workspace" tabIndex={-1}>
      <button onClick={() => ui.setView("library")}>Go to Library</button>
      <button onClick={() => ui.setView("catalog")}>Go to Catalog</button>
      <label>
        Search catalog
        <input value={ui.query} onChange={(event) => ui.setQuery(event.target.value)} />
      </label>
      <button onClick={() => setGeneration((value) => value + 1)}>
        Invalidate library observation
      </button>
      {ui.selectedId ? (
        <DetailLayout
          port={ports.find((port) => port.id === ui.selectedId)!}
          opening={navigation.opening}
          initialSection="files"
          readiness="File observations"
          installation="Not installed"
          action={() => null}
          close={navigation.close}
        >
          {() => ({
            overview: null,
            files: (
              <>
                <GameFileFilterObservation portId={ui.selectedId!} context={observation.context} />
                <GameFileObservationSummary
                  observation={observation.observation}
                  catalog
                  portId={ui.selectedId!}
                />
                <GameFileQueryControl
                  port={ports.find((port) => port.id === ui.selectedId)!}
                  channel="stable"
                  generation={generation}
                  context={library}
                />
              </>
            ),
            saves: null,
            versions: null,
          })}
        </DetailLayout>
      ) : (
        <PortBrowser
          view={ui.view}
          ports={filterPorts(ports, empty, ui.view, ui.filter, ui.query, ui.catalogSort, context)}
          catalogFilterCandidates={filterPorts(ports, empty, "catalog", "all", ui.query)}
          queryContext={context}
          gameFileQuery={observation}
          statuses={empty}
          overview={summarizeLibrary(ports, empty)}
          filter={ui.filter}
          query={ui.query}
          catalogSort={ui.catalogSort}
          setCatalogSort={ui.setCatalogSort}
          setFilter={ui.setFilter}
          onSelect={navigation.open}
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
  const [library, setLibrary] = useState("/game-filter-library-a");
  return (
    <DirectionProvider direction="ltr">
      <button
        onClick={() =>
          setLibrary((value) =>
            value.endsWith("a") ? "/game-filter-library-b" : "/game-filter-library-a",
          )
        }
      >
        Switch library
      </button>
      <Session key={library} library={library} />
    </DirectionProvider>
  );
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(desktopApi.libraryIdentity).mockResolvedValue({
    id: "opaque-core",
    root: "/private-game-files",
  });
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementation(async (request) =>
    response(request),
  );
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.useRealTimers();
  vi.restoreAllMocks();
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
const noAdditionalChecks = () => {
  expect(desktopApi.libraryIdentity).toHaveBeenCalledTimes(1);
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  expect(desktopApi.cancelOperation).not.toHaveBeenCalled();
};

it.each(["dark", "light"])(
  "carries complete filter reasons through keyboard selection and return in %s",
  async (theme) => {
    await page.viewport(960, 900);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await expect
      .element(button("Compatible complete files available (unavailable)"))
      .toBeDisabled();
    expect(desktopApi.refreshGameFileQuery).not.toHaveBeenCalled();
    await userEvent.click(button("Check game-file filters"));
    for (const label of [
      "Compatible complete files available",
      "Files missing",
      "Needs checking",
      "No game files required",
      "Unavailable context",
    ])
      await expect.element(button(`${label} (1)`)).toBeEnabled();
    await userEvent.click(button("Compatible complete files available (1)"));
    await closeFilters();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(button("Filters (1)")).toHaveFocus();
    const card = page.getByRole("button", { name: /^Complete game\s/ });
    await userEvent.click(card);
    await expect
      .element(page.getByRole("region", { name: "Catalog game-file observation" }))
      .toBeInTheDocument();
    const explanation = document.querySelector('[aria-label="Catalog game-file observation"]')!;
    expect(explanation.textContent).toContain("Managed setup · Windows · Stable");
    expect(explanation.textContent).toContain("profile / variant / complete-set");
    await expect
      .element(page.getByRole("heading", { name: "Complete game", level: 1 }))
      .toHaveFocus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(button("Back to previous workspace")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect.element(card).toHaveFocus();
    await expect
      .element(button("Remove Compatible complete files available filter"))
      .toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "Search catalog" }), "no match");
    await openAdvancedFilters("Filters (1)");
    await expect.element(button("Compatible complete files available (0)")).toBeEnabled();
    await closeFilters();
    noAdditionalChecks();
    expect(document.body.textContent).not.toContain("/private-game-files");
  },
);

it("retains unavailable choices across library invalidation, persistence and isolation without rechecking", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(button("Check game-file filters"));
  await userEvent.click(button("Needs checking (1)"));
  await closeFilters();
  await userEvent.click(page.getByRole("button", { name: /^Checking game\s/ }));
  await expect
    .element(page.getByRole("region", { name: "Catalog game-file observation" }))
    .toBeInTheDocument();
  expect(
    document.querySelector('[aria-label="Catalog game-file observation"]')?.textContent,
  ).toContain("files are not confirmed missing");
  await userEvent.click(button("Invalidate library observation"));
  await expect
    .element(page.getByRole("region", { name: "Catalog game-file observation" }))
    .not.toBeInTheDocument();
  await userEvent.click(button("Back to previous workspace"));
  await expect.element(button("Remove Needs checking filter")).toBeInTheDocument();
  await openAdvancedFilters("Filters (1)");
  await expect.element(button("Needs checking (unavailable)")).toBeDisabled();
  await closeFilters();
  await userEvent.click(button("Switch library"));
  await expect.element(button("Filters (0)")).toBeInTheDocument();
  await userEvent.click(button("Switch library"));
  await expect.element(button("Filters (1)")).toBeInTheDocument();
  flushSync(() => root.unmount());
  root = createRoot(host);
  flushSync(() => root.render(<Fixture />));
  await expect.element(button("Remove Needs checking filter")).toBeInTheDocument();
  noAdditionalChecks();
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Remove Needs checking filter"]')!
    .focus();
  await expect.element(button("Remove Needs checking filter")).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(button("Filters (0)")).toHaveFocus();
});

it.each(["dark", "light"])(
  "keeps catalog history across details/back while independent history ends in %s",
  async (theme) => {
    await page.viewport(520, 780);
    document.documentElement.dataset.theme = theme;
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(button("Check game-file filters"));
    await closeFilters();
    await userEvent.click(page.getByRole("button", { name: /^Complete game\s/ }));
    await expect.element(page.getByLabelText("Catalog check history")).toBeInTheDocument();
    await userEvent.click(button("Check selected route game files"));
    await expect.element(page.getByLabelText("Selected-route check history")).toBeInTheDocument();
    await userEvent.click(button("Back to previous workspace"));
    await userEvent.click(page.getByRole("button", { name: /^Complete game\s/ }));
    await expect.element(page.getByLabelText("Catalog check history")).toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Selected-route check history"))
      .not.toBeInTheDocument();
    const metadata = document.querySelector('[aria-label="Catalog check history"]')!;
    expect(metadata.textContent).toContain("Catalog (5 ports) · Managed setup · Windows · Stable");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(520);
    await page.screenshot({
      element: metadata.parentElement!,
      path: `../../../../outputs/observation-clarity/catalog-current-${theme}-520.png`,
    });
    expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(2);
  },
);

it.each(["dark", "light"])(
  "shows expired catalog history independently of absent matching evidence in %s",
  async (theme) => {
    await page.viewport(520, 780);
    document.documentElement.dataset.theme = theme;
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1000);
    flushSync(() => root.render(<Fixture />));
    await openAdvancedFilters("Filters (0)");
    await userEvent.click(button("Check game-file filters"));
    await closeFilters();
    await userEvent.click(page.getByRole("button", { name: /^Complete game\s/ }));
    monotonic.mockReturnValue(301001);
    flushSync(() => root.render(<Fixture />));
    await expect
      .element(page.getByRole("region", { name: "Catalog game-file observation" }))
      .not.toBeInTheDocument();
    const metadata = document.querySelector('[aria-label="Catalog check history"]')!;
    expect(metadata.textContent).toContain("Previous check");
    expect(metadata.textContent).toMatch(/\bexpired\b/iu);
    expect(metadata.textContent).toContain("Filters → Check game-file filters");
    expect(metadata.textContent).not.toContain("Complete set");
    expect(metadata.querySelector("time")?.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(520);
    await page.screenshot({
      element: metadata.parentElement!,
      path: `../../../../outputs/observation-clarity/catalog-expired-${theme}-520.png`,
    });
    await userEvent.click(button("Back to previous workspace"));
    await openAdvancedFilters("Filters (0)");
    await expect
      .element(button("Compatible complete files available (unavailable)"))
      .toBeDisabled();
    noAdditionalChecks();
  },
);

it("retains catalog history through Catalog/Library section navigation without inspection", async () => {
  flushSync(() => root.render(<Fixture />));
  await openAdvancedFilters("Filters (0)");
  await userEvent.click(button("Check game-file filters"));
  const recordedTime = page
    .getByLabelText("Catalog check history")
    .element()
    .querySelector("time")!.dateTime;
  await closeFilters();
  await userEvent.click(button("Go to Library"));
  await openAdvancedFilters("Filters (0)");
  await expect.element(page.getByLabelText("Catalog check history")).toBeInTheDocument();
  expect(
    page.getByLabelText("Catalog check history").element().querySelector("time")!.dateTime,
  ).toBe(recordedTime);
  await closeFilters();
  await userEvent.click(button("Go to Catalog"));
  await openAdvancedFilters("Filters (0)");
  await expect.element(page.getByLabelText("Catalog check history")).toBeInTheDocument();
  noAdditionalChecks();
});
