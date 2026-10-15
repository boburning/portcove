import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { portDefinition } from "../test-fixtures";
import type { GameFileQuerySnapshot, GameFileQueryRefreshRequest } from "../types";
import { acceptedGameFileQuery, GameFileQueryControl } from "./GameFileQuery";

vi.mock("../api", () => ({
  desktopApi: { libraryIdentity: vi.fn(), refreshGameFileQuery: vi.fn(), cancelOperation: vi.fn() },
}));
const port = portDefinition();
const request: GameFileQueryRefreshRequest["routes"][number] = {
  port_id: port.id,
  platform: fixtureValue(port.platforms[0], "port.platforms[0]"),
  channel: "stable",
  route: "managed_install",
};
const library = { id: "library-id", root: "private-library" };
const snapshot = (): GameFileQuerySnapshot => ({
  schema_version: 1,
  library,
  observed_at: Math.floor(Date.now() / 1000),
  expires_at: Math.floor(Date.now() / 1000) + 300,
  catalog_binding_sha256: "a".repeat(64),
  registration_sha256: "b".repeat(64),
  selection_sha256: "c".repeat(64),
  routes: [
    {
      ...request,
      state: "files_missing",
      reason: "no_connected_registration",
      contract_id: null,
      identity: null,
      source_instance_sha256: null,
      route_definition_sha256: "d".repeat(64),
      route_instance_sha256: null,
    },
  ],
});
let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
  vi.mocked(desktopApi.libraryIdentity).mockResolvedValue(library);
  vi.mocked(desktopApi.refreshGameFileQuery).mockResolvedValue(snapshot());
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (context = "accepted", generation = 1) => {
  await root.rerender(
    <GameFileQueryControl port={port} channel="stable" generation={generation} context={context} />,
  );
};
const check = async () => {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Check selected route game files",
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
};

it("does no implicit inspection and displays a bounded exact route observation only after selection", async () => {
  await render();
  expect(desktopApi.refreshGameFileQuery).not.toHaveBeenCalled();
  await check();
  expect(container.textContent).toContain("Files missing");
  expect(container.textContent).toContain("No game-file registration");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledExactlyOnceWith(
    {
      routes: [request],
      maximum_age_seconds: 300,
      limits: { max_file_bytes: 2147483648, max_hash_bytes: 34359738368, max_elapsed_ms: 30000 },
    },
    1,
    expect.any(Function),
  );
  expect(container.textContent).not.toContain(library.root);
  await render("changed-source");
  expect(container.textContent).not.toContain("Files missing");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
});
it("discards obsolete completion and late events after a library/context switch", async () => {
  let resolve!: (value: GameFileQuerySnapshot) => void;
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await render();
  await check();
  const event = fixtureValue(
    vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0],
    "vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0]",
  )[2];
  await act(async () => {
    event?.({
      schema_version: 3,
      operation_id: "obsolete",
      parent_operation_id: null,
      operation: "verify_source",
      sequence: 0,
      timestamp_ms: Date.now(),
      target: null,
      type: "started",
    });
  });
  expect(container.textContent).toContain("Cancel game-file check");
  await render("other-library", 2);
  expect(container.textContent).not.toContain("Cancel game-file check");
  await render("accepted", 1);
  await act(async () => {
    event?.({
      schema_version: 3,
      operation_id: "obsolete",
      parent_operation_id: null,
      operation: "verify_source",
      sequence: 1,
      timestamp_ms: Date.now(),
      target: null,
      type: "started",
    });
    resolve(snapshot());
  });
  expect(container.textContent).not.toContain("Files missing");
  expect(container.textContent).not.toContain("Cancel game-file check");
});
it("does not resurrect an accepted observation after changing context and returning", async () => {
  await render();
  await check();
  expect(container.textContent).toContain("Files missing");
  await render("changed-registration");
  await render();
  expect(container.textContent).not.toContain("Files missing");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
});
it("keeps the real refresh pending after cancellation acknowledgment and rejects overlapping clicks", async () => {
  let resolve!: (value: GameFileQuerySnapshot) => void;
  vi.mocked(desktopApi.refreshGameFileQuery).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  vi.mocked(desktopApi.cancelOperation).mockResolvedValue({ phase: "preparing", requested: true });
  await render();
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Check selected route game files",
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  const event = fixtureValue(
    vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0],
    "vi.mocked(desktopApi.refreshGameFileQuery).mock.calls[0]",
  )[2];
  await act(async () =>
    event?.({
      schema_version: 3,
      operation_id: "owned",
      parent_operation_id: null,
      operation: "verify_source",
      sequence: 0,
      timestamp_ms: Date.now(),
      target: null,
      type: "started",
    }),
  );
  const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === "Cancel game-file check",
  )!;
  await act(async () => cancel.click());
  expect(desktopApi.cancelOperation).toHaveBeenCalledExactlyOnceWith("owned");
  expect(container.textContent).toContain("Cancellation requested");
  expect(container.textContent).toContain("Checking selected route…");
  expect(button.disabled).toBe(true);
  await act(async () => resolve(snapshot()));
  expect(container.textContent).not.toContain("Cancellation requested");
});
it("expires accepted observations without issuing another inspection", async () => {
  vi.useFakeTimers();
  await render();
  await check();
  await act(async () => vi.advanceTimersByTime(300001));
  expect(container.textContent).toContain("Observation expired");
  expect(container.textContent).not.toContain("Files missing");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects a clock jump before timer callbacks, never resurrects the old observation, and allows explicit recheck", async () => {
  vi.useFakeTimers();
  await render();
  await check();
  expect(container.textContent).toContain("Files missing");
  const originalTime = Date.now();
  vi.setSystemTime(originalTime + 300001);
  await render();
  expect(container.textContent).toContain("Observation expired");
  expect(container.textContent).not.toContain("Files missing");
  vi.setSystemTime(originalTime);
  await render();
  expect(container.textContent).not.toContain("Files missing");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(1);
  vi.mocked(desktopApi.refreshGameFileQuery).mockResolvedValue(snapshot());
  await check();
  expect(container.textContent).toContain("Files missing");
  expect(container.textContent).not.toContain("Observation expired");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(2);
});
it("rejects monotonic expiry with unchanged wall time and rejects a wall clock earlier than observation", async () => {
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(1000);
  await render();
  await check();
  monotonic.mockReturnValue(301001);
  await render();
  expect(container.textContent).not.toContain("Files missing");
  monotonic.mockReturnValue(400000);
  const refreshed = snapshot();
  vi.mocked(desktopApi.refreshGameFileQuery).mockResolvedValue(refreshed);
  await check();
  expect(container.textContent).toContain("Files missing");
  vi.useFakeTimers();
  vi.setSystemTime(refreshed.observed_at * 1000 - 1);
  await render();
  expect(container.textContent).not.toContain("Files missing");
  expect(desktopApi.refreshGameFileQuery).toHaveBeenCalledTimes(2);
  monotonic.mockRestore();
});
it("rejects stale, mismatched, duplicated and contradictory producer observations", () => {
  const now = Math.floor(Date.now() / 1000);
  const baseline = snapshot();
  expect(acceptedGameFileQuery(baseline, request, library, now)).toBe(true);
  const positive = {
    ...fixtureValue(baseline.routes[0], "baseline.routes[0]"),
    state: "files_available" as const,
    reason: "complete_compatible_observation" as const,
    contract_id: "contract",
    identity: { game_id: "profile", variant_id: "variant", representation_id: "raw" },
    source_instance_sha256: "e".repeat(64),
  };
  expect(acceptedGameFileQuery({ ...baseline, routes: [positive] }, request, library, now)).toBe(
    true,
  );
  for (const invalid of [
    { ...baseline, schema_version: 2 },
    { ...baseline, library: { ...library, id: "other" } },
    { ...baseline, expires_at: now - 1 },
    { ...baseline, observed_at: now + 1 },
    { ...baseline, routes: [...baseline.routes, ...baseline.routes] },
    {
      ...baseline,
      routes: [
        { ...fixtureValue(baseline.routes[0], "baseline.routes[0]"), channel: "rolling" as const },
      ],
    },
    {
      ...baseline,
      routes: [
        {
          ...fixtureValue(baseline.routes[0], "baseline.routes[0]"),
          state: "files_available" as const,
        },
      ],
    },
    {
      ...baseline,
      routes: [
        {
          ...fixtureValue(baseline.routes[0], "baseline.routes[0]"),
          state: "no_files_required" as const,
        },
      ],
    },
    { ...baseline, routes: [{ ...positive, contract_id: null }] },
    { ...baseline, routes: [{ ...positive, identity: null }] },
    { ...baseline, routes: [{ ...positive, identity: { ...positive.identity, variant_id: "" } }] },
    {
      ...baseline,
      routes: [
        {
          ...fixtureValue(baseline.routes[0], "baseline.routes[0]"),
          state: "no_files_required" as const,
          reason: "explicit_empty_requirements" as const,
          route_definition_sha256: null,
        },
      ],
    },
  ])
    expect(acceptedGameFileQuery(invalid, request, library, now)).toBe(false);
});
