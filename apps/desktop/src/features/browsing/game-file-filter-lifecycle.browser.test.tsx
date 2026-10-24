import { controlledAct as act } from "../../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../../test-fixtures";
import { useState } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { portDefinition } from "../../test-fixtures";
import type { GameFileQueryRefreshRequest, GameFileQuerySnapshot } from "../../types";
import { useGameFileFilterContext } from "./use-game-file-filter-context";
import { evaluateCatalogQuery, type CatalogQuery } from "./catalog-query";
import { CatalogFilters } from "./CatalogFilters";

vi.mock("../../api", () => ({
  desktopApi: { libraryIdentity: vi.fn(), refreshGameFileQuery: vi.fn(), cancelOperation: vi.fn() },
}));
const ports = ["complete", "missing", "unreadable", "empty", "unknown"].map((id) => ({
  ...portDefinition(),
  id,
}));
const catalog = { schema_version: 2, ports };
const library = { id: "opaque", root: "private-root" };
const response = (request: GameFileQueryRefreshRequest): GameFileQuerySnapshot => ({
  schema_version: 1,
  library,
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
        ? { game_id: "profile", variant_id: "variant", representation_id: "complete" }
        : null,
    source_instance_sha256: index === 0 ? "d".repeat(64) : null,
    route_definition_sha256: index === 4 ? null : "e".repeat(64),
    route_instance_sha256: null,
  })),
});
let host: HTMLDivElement;
let root: RenderResult;
let state: ReturnType<typeof useGameFileFilterContext>;
function Fixture({
  generation = 1,
  browsingBinding,
}: {
  generation?: number;
  browsingBinding?: string;
}) {
  state = useGameFileFilterContext({
    catalog,
    sources: [],
    statuses: [],
    generation,
    libraryKey: "scope",
    browsing: browsingBinding
      ? {
          schema_version: 1,
          library,
          host_platform: "windows-x86-64",
          retained_metadata_complete: false,
          contexts: [],
          workspace_binding_sha256: browsingBinding,
        }
      : undefined,
  });
  const [filter, setFilter] = useState<CatalogQuery>({ version: 1 });
  const context = { library: { id: "scope", statuses: new Map() }, gameFiles: state.context };
  const result = evaluateCatalogQuery(ports, filter, context);
  return (
    <>
      <CatalogFilters
        candidates={ports}
        context={context}
        filter={filter}
        setFilter={(update) =>
          setFilter(
            (current) => (typeof update === "function" ? update(current) : update) as CatalogQuery,
          )
        }
        gameFileQuery={state}
      />
      <p data-matches>
        {result.state}:{result.ports.map((port) => port.id).join(",")}
      </p>
    </>
  );
}
beforeEach(async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = await renderComponent(null, { container: document.body.appendChild(host) });
  vi.mocked(desktopApi.libraryIdentity).mockResolvedValue(library);
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementation(async (request) =>
    response(request),
  );
});
afterEach(async () => {
  await cleanup();
  host.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (generation = 1) => {
  await root.rerender(<Fixture generation={generation} />);
};
const button = (text: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  expect(element).toBeDefined();
  return element!;
};
const click = async (text: string) => {
  await act(async () => button(text).click());
};

it("checks one complete catalog once, then composes choices and counts without inspection IPC", async () => {
  await render();
  expect(desktopApi.refreshGameFileQuery).not.toHaveBeenCalled();
  await click("Filters (0)");
  expect(button("Compatible complete files available (unavailable)").disabled).toBe(true);
  await click("Check game-file filters");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  expect(
    fixtureValue(
      vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0],
      "vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0]",
    )[0].routes,
  ).toHaveLength(5);
  for (const label of [
    "Compatible complete files available",
    "Files missing",
    "Needs checking",
    "No files to add in Portcove",
    "Unavailable context",
  ])
    expect(button(`${label} (1)`).disabled).toBe(false);
  await click("Compatible complete files available (1)");
  expect(host.querySelector("[data-matches]")?.textContent).toBe("matched:complete");
  await click("Needs checking (1)");
  expect(host.querySelector("[data-matches]")?.textContent).toBe("matched:complete,unreadable");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain(library.root);
});
it("keeps retained choices unavailable after expiry without another check", async () => {
  vi.useFakeTimers();
  await render();
  await act(async () => state.refresh());
  expect(state.context).toBeDefined();
  await act(async () => vi.advanceTimersByTime(300001));
  expect(state.context).toBeUndefined();
  expect(state.expired).toBe(true);
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
});
it("invalidates an accepted observation when only retained browsing metadata changes without another check", async () => {
  await root.rerender(<Fixture browsingBinding={"a".repeat(64)} />);
  await act(async () => state.refresh());
  expect(state.context).toBeDefined();
  await root.rerender(<Fixture browsingBinding={"b".repeat(64)} />);
  expect(state.context).toBeUndefined();
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
});
it("rejects expired context on a filter render before queued timer callbacks, including a later clock return", async () => {
  vi.useFakeTimers();
  await render();
  await act(async () => state.refresh());
  expect(state.context).toBeDefined();
  const originalTime = Date.now();
  vi.setSystemTime(originalTime + 300001);
  await render();
  expect(state.context).toBeUndefined();
  expect(state.expired).toBe(true);
  vi.setSystemTime(originalTime);
  await render();
  expect(state.context).toBeUndefined();
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  await act(async () => state.refresh());
  expect(state.context).toBeDefined();
  expect(state.expired).toBe(false);
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(2);
});
it("expires against the original monotonic deadline even when the wall clock stays unchanged", async () => {
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(1000);
  await render();
  await act(async () => state.refresh());
  expect(state.context).toBeDefined();
  monotonic.mockReturnValue(301001);
  await render();
  expect(state.context).toBeUndefined();
  expect(state.expired).toBe(true);
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  monotonic.mockRestore();
});
it("rejects held A-to-B-to-A completions and pre-switch events, without overlapping requests", async () => {
  let resolve!: (value: GameFileQuerySnapshot) => void;
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await act(async () => {
    void state.refresh();
    void state.refresh();
  });
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  const [request, , event] = fixtureValue(
    vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0],
    "query request call",
  );
  await act(async () =>
    event?.({
      schema_version: 3,
      operation_id: "old",
      parent_operation_id: null,
      operation: "verify_source",
      sequence: 0,
      timestamp_ms: Date.now(),
      target: null,
      type: "started",
    }),
  );
  expect(state.operationId).toBe("old");
  await render(2);
  expect(state.operationId).toBeUndefined();
  await render(1);
  await act(async () => resolve(response(request)));
  expect(state.context).toBeUndefined();
  expect(state.pending).toBe(false);
});

it("keeps history while retry and failure make classifications and counts unavailable", async () => {
  await render();
  await click("Filters (0)");
  await click("Check game-file filters");
  const metadata = state.observation.lastAccepted;
  let reject!: (value: unknown) => void;
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await click("Check game-file filters");
  expect(state.context).toBeUndefined();
  expect(state.observation.lastAccepted).toBe(metadata);
  expect(button("Compatible complete files available (unavailable)").disabled).toBe(true);
  expect(document.body.textContent).toContain("Previous check");
  expect(document.body.textContent).toContain("Checking game files for the catalog");
  await act(async () => reject(new Error("offline")));
  expect(state.context).toBeUndefined();
  expect(state.observation.lastAccepted).toBe(metadata);
  expect(button("Compatible complete files available (unavailable)").disabled).toBe(true);
  expect(document.body.textContent).toContain("latest check failed");
  expect(document.body.textContent).not.toContain("Last checked");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(2);
});
