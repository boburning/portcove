// @vitest-environment jsdom
import { act, StrictMode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "../../api";
import { useUpdateCenter } from "../port-updates/use-update-center";
import { useOperationState, type Perform } from "../operations/use-operation-state";
import {
  emptyActivityFeed,
  essentialSnapshotIdentity,
  usePortcoveData,
} from "./use-workspace-data";
import { failureReport, portDefinition, portStatus } from "../../test-fixtures";
import type { DoctorReport, OperationEvent, WorkspaceSnapshot } from "../../types";
import { WorkspaceRefreshNotice } from "./WorkspaceRefreshNotice";
import { indexStatuses } from "../../view-model";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const snapshot: WorkspaceSnapshot = {
  catalog: { schema_version: 1, ports: [portDefinition()], source_profiles: [] },
  statuses: [portStatus()],
  sources: [],
  activities: emptyActivityFeed(),
};
const doctor: DoctorReport = {
  catalog_port_count: 1,
  installed_port_count: 0,
  registered_source_count: 0,
  platform: "windows-x86-64",
  host_tools: [],
  catalog_provenance: {
    catalog_sha256: "a".repeat(64),
    expires_at: null,
    fallback_reasons: [],
    key_id: null,
    origin: "embedded",
    sequence: null,
  },
  library: {
    library_root: "fixture/library",
    volume_available_bytes: 100,
    volume_total_bytes: 200,
  },
  repair: { generated_at: 0, items: [] },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

let root: Root;
let host: HTMLDivElement;
let data: ReturnType<typeof usePortcoveData>;
let operations: ReturnType<typeof useOperationState>;
let eventHandlers: Map<string, (event: { payload: unknown }) => void>;
let renderCount: number;
let catalogProjectionCount: number;
let statusIndexCount: number;
let sourceProjectionCount: number;
let checkAll: () => Promise<void>;

function Fixture({ generation = 7 }: { generation?: number }) {
  renderCount += 1;
  data = usePortcoveData(generation);
  const { catalog, sources, statuses } = data;
  const catalogPortCount = useMemo(() => {
    catalogProjectionCount += 1;
    return catalog?.ports.length ?? 0;
  }, [catalog]);
  const statusIndex = useMemo(() => {
    statusIndexCount += 1;
    return indexStatuses(statuses);
  }, [statuses]);
  const sourceCount = useMemo(() => {
    sourceProjectionCount += 1;
    return sources.length;
  }, [sources]);
  operations = useOperationState({
    refresh: data.retryRefresh,
    refreshActivities: data.refreshActivities,
    invalidateDiagnostics: data.invalidateDiagnostics,
  });
  return (
    <div
      data-catalog-count={catalogPortCount}
      data-source-count={sourceCount}
      data-status-count={statusIndex.size}
    >
      <WorkspaceRefreshNotice
        failure={data.refreshFailure}
        recoveryFailure={data.recoveryFailure}
        hasSnapshot={Boolean(data.catalog)}
        refreshing={data.refreshing}
        retry={data.retryRefresh}
        retryRecovery={data.retryRecovery}
        subscriptionFailure={data.subscriptionFailure?.error ?? operations.subscriptionFailure}
      />
    </div>
  );
}

function UpdateFixture({ perform }: { perform: Parameters<typeof useUpdateCenter>[0] }) {
  ({ checkAll } = useUpdateCenter(perform, snapshot.statuses));
  return null;
}

async function render() {
  await act(async () => {
    root.render(<Fixture />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderStrict() {
  await act(async () => {
    root.render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  eventHandlers = new Map();
  renderCount = 0;
  catalogProjectionCount = 0;
  statusIndexCount = 0;
  sourceProjectionCount = 0;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    eventHandlers.set(event, handler as (event: { payload: unknown }) => void);
    return () => eventHandlers.delete(event);
  });
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "workspaceChanged").mockResolvedValue(false);
  vi.spyOn(desktopApi, "workspaceChanged").mockResolvedValue(false);
  vi.spyOn(desktopApi, "discoverOrphanedOperations").mockResolvedValue(undefined);
  vi.spyOn(desktopApi, "activities").mockResolvedValue(emptyActivityFeed());
  vi.spyOn(desktopApi, "doctor").mockResolvedValue(doctor);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace refresh recovery", () => {
  it("compares each essential collection once without increasing serialized identity bytes", () => {
    const combinedIdentity = JSON.stringify([
      snapshot.catalog,
      snapshot.statuses,
      snapshot.sources,
    ]);
    const stringify = vi.spyOn(JSON, "stringify");

    const identities = essentialSnapshotIdentity(snapshot);

    expect(stringify).toHaveBeenCalledTimes(3);
    expect(identities.catalog.length + identities.statuses.length + identities.sources.length).toBe(
      combinedIdentity.length - 4,
    );
  });

  it("preserves unchanged IPC snapshot references and avoids redundant status indexing", async () => {
    await render();
    const before = { catalog: data.catalog, statuses: data.statuses, sources: data.sources };
    const indexesBefore = statusIndexCount;
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    vi.mocked(desktopApi.workspaceSnapshot).mockImplementation(async () =>
      structuredClone(snapshot),
    );

    for (let index = 0; index < 5; index += 1) await act(async () => data.refresh());

    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledTimes(5);
    expect(statusIndexCount - indexesBefore).toBe(0);
    expect(data.catalog).toBe(before.catalog);
    expect(data.statuses).toBe(before.statuses);
    expect(data.sources).toBe(before.sources);
    expect(data.diagnosticsStale).toBe(false);
  });

  it("preserves catalog, source, and unchanged record references for a status-only change", async () => {
    const secondStatus = { ...portStatus(), port_id: "second-port" };
    const initial = { ...snapshot, statuses: [snapshot.statuses[0], secondStatus] };
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(initial);
    await render();
    const before = {
      catalog: data.catalog,
      firstStatus: data.statuses[0],
      secondStatus: data.statuses[1],
      sources: data.sources,
    };
    const projectionsBefore = {
      catalog: catalogProjectionCount,
      sources: sourceProjectionCount,
      statuses: statusIndexCount,
    };
    const changed = structuredClone(initial);
    changed.statuses[0].successful_launches += 1;
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(changed);

    await act(async () => data.refresh());

    expect(data.catalog).toBe(before.catalog);
    expect(data.sources).toBe(before.sources);
    expect(data.statuses).not.toBe(initial.statuses);
    expect(data.statuses[0]).not.toBe(before.firstStatus);
    expect(data.statuses[1]).toBe(before.secondStatus);
    expect(catalogProjectionCount - projectionsBefore.catalog).toBe(0);
    expect(sourceProjectionCount - projectionsBefore.sources).toBe(0);
    expect(statusIndexCount - projectionsBefore.statuses).toBe(1);
    expect(data.diagnosticsStale).toBe(true);
  });

  it("updates only a changed catalog reference", async () => {
    await render();
    const before = { statuses: data.statuses, sources: data.sources };
    const changed = structuredClone(snapshot);
    changed.catalog.ports[0].name = "Changed by an external client";
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(changed);

    await act(async () => data.refresh());

    expect(data.catalog).toBe(changed.catalog);
    expect(data.statuses).toBe(before.statuses);
    expect(data.sources).toBe(before.sources);
  });

  it("updates only a changed source reference", async () => {
    await render();
    const before = { catalog: data.catalog, statuses: data.statuses };
    const changed = structuredClone(snapshot);
    changed.sources = [
      {
        path: "fixture/game.bin",
        profile_id: "fixture-source",
        sha256: "a".repeat(64),
        size: 1,
        storage_sha256: "b".repeat(64),
        storage_size: 1,
        updated_at: 1,
      },
    ];
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(changed);

    await act(async () => data.refresh());

    expect(data.catalog).toBe(before.catalog);
    expect(data.statuses).toBe(before.statuses);
    expect(data.sources).toBe(changed.sources);
  });

  it("keeps retained status records correct across removal and reordering", async () => {
    const secondStatus = { ...portStatus(), port_id: "second-port" };
    const thirdStatus = { ...portStatus(), port_id: "third-port" };
    const initial = { ...snapshot, statuses: [snapshot.statuses[0], secondStatus, thirdStatus] };
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(initial);
    await render();
    const retained = data.statuses[2];
    const changed = structuredClone(initial);
    changed.statuses = [changed.statuses[2], changed.statuses[0]];
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(changed);

    await act(async () => data.refresh());

    expect(data.statuses.map((status) => status.port_id)).toEqual([
      "third-port",
      initial.statuses[0].port_id,
    ]);
    expect(data.statuses[0]).toBe(retained);
  });

  it("clears refresh failure on unchanged readback while accepting newer activities", async () => {
    await render();
    const before = { catalog: data.catalog, statuses: data.statuses, sources: data.sources };
    vi.mocked(desktopApi.workspaceSnapshot).mockRejectedValueOnce(failureReport());
    await act(async () => data.retryRefresh());
    expect(data.refreshFailure).toBeDefined();
    const recovered = structuredClone(snapshot);
    recovered.activities = {
      ...emptyActivityFeed(),
      terminal_history_count: 1,
      records: [
        {
          id: "external-install",
          operation: "install",
          target_kind: "port",
          target_id: "fixture",
          status: "succeeded",
          message: null,
          failure: null,
          started_at: 1,
          finished_at: 2,
          cancellation: null,
        },
      ],
    };
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(recovered);

    await act(async () => data.retryRefresh());

    expect(data.refreshFailure).toBeUndefined();
    expect(data.refreshing).toBe(false);
    expect(data.catalog).toBe(before.catalog);
    expect(data.statuses).toBe(before.statuses);
    expect(data.sources).toBe(before.sources);
    expect(data.activities).toEqual(recovered.activities.records);
    expect(data.activityFeed).toEqual(recovered.activities);
  });

  it("keeps workspace, diagnostics, and activity refreshes live after Strict Mode replay", async () => {
    await renderStrict();

    expect(data.catalog).toEqual(snapshot.catalog);
    expect(data.doctor).toEqual(doctor);
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    vi.mocked(desktopApi.activities).mockClear();
    vi.mocked(desktopApi.doctor).mockClear();

    await act(async () => {
      await data.refresh();
      await data.refreshActivities();
      data.invalidateDiagnostics();
      await data.refreshDiagnostics();
    });

    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(desktopApi.activities).toHaveBeenCalledOnce();
    expect(desktopApi.doctor).toHaveBeenCalledOnce();
  });

  it("registers the library listener before acquiring the initial snapshot", async () => {
    const registration = deferred<() => void>();
    vi.mocked(listen).mockImplementationOnce((event, handler) => {
      eventHandlers.set(event, handler as (event: { payload: unknown }) => void);
      return registration.promise;
    });
    await render();
    expect(desktopApi.workspaceSnapshot).not.toHaveBeenCalled();
    expect(desktopApi.discoverOrphanedOperations).not.toHaveBeenCalled();
    registration.resolve(() => eventHandlers.delete("portcove://library-changed"));
    await act(async () => registration.promise);
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(desktopApi.discoverOrphanedOperations).not.toHaveBeenCalled();
  });

  it("renders essential data without waiting for slow diagnostics", async () => {
    const diagnostics = deferred<DoctorReport>();
    vi.mocked(desktopApi.doctor).mockReturnValueOnce(diagnostics.promise);
    await render();
    expect(data.catalog).toEqual(snapshot.catalog);
    expect(data.diagnosticRefreshing).toBe(true);
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledWith(7);
    diagnostics.resolve(doctor);
    await act(async () => diagnostics.promise);
    expect(data.doctor).toEqual(doctor);
  });

  it("discards an essential response from a library generation that was replaced", async () => {
    const previous = deferred<WorkspaceSnapshot>();
    const current = { ...snapshot, statuses: [] };
    vi.mocked(desktopApi.workspaceSnapshot)
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(current);
    await render();
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledWith(7);

    await act(async () => {
      root.render(<Fixture generation={8} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledWith(8);
    expect(data.statuses).toEqual([]);

    previous.resolve(snapshot);
    await act(async () => previous.promise);
    expect(data.statuses).toEqual([]);

    vi.mocked(desktopApi.activities).mockClear();
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(desktopApi.activities).toHaveBeenCalledOnce();
  });

  it("does not retain references across library generations with identical content", async () => {
    await render();
    const before = { catalog: data.catalog, statuses: data.statuses, sources: data.sources };
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce(structuredClone(snapshot));

    await act(async () => {
      root.render(<Fixture generation={8} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(data.catalog).not.toBe(before.catalog);
    expect(data.statuses).not.toBe(before.statuses);
    expect(data.sources).not.toBe(before.sources);
    expect(data.catalog).toEqual(before.catalog);
    expect(data.statuses).toEqual(before.statuses);
    expect(data.sources).toEqual(before.sources);
  });

  it("discards diagnostics from a library generation that was replaced", async () => {
    const previous = deferred<DoctorReport>();
    const current = { ...doctor, catalog_port_count: 2 };
    vi.mocked(desktopApi.doctor)
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(current);
    await render();
    expect(desktopApi.doctor).toHaveBeenCalledWith(7);

    await act(async () => {
      root.render(<Fixture key="generation-8" generation={8} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(desktopApi.doctor).toHaveBeenCalledWith(8);
    expect(data.doctor).toEqual(current);

    previous.resolve(doctor);
    await act(async () => previous.promise);
    expect(data.doctor).toEqual(current);
  });

  it("discards an external observer result from a replaced library generation", async () => {
    await render();
    const previous = deferred<boolean>();
    vi.mocked(desktopApi.workspaceChanged).mockReturnValueOnce(previous.promise);
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(desktopApi.workspaceChanged).toHaveBeenCalledWith(7);

    await act(async () => {
      root.render(<Fixture key="observer-generation-8" generation={8} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    previous.resolve(true);
    await act(async () => previous.promise);

    expect(desktopApi.workspaceSnapshot).not.toHaveBeenCalled();
    expect(desktopApi.discoverOrphanedOperations).not.toHaveBeenCalled();
  });

  it("coalesces a burst and runs one follow-up when invalidated during a request", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    const first = deferred<WorkspaceSnapshot>();
    vi.mocked(desktopApi.workspaceSnapshot)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(snapshot);
    let initial!: ReturnType<typeof data.refresh>;
    let followups!: ReturnType<typeof data.refresh>[];
    await act(async () => {
      initial = data.refresh();
      await Promise.resolve();
      followups = [data.refresh(), data.refresh()];
    });
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    first.resolve(snapshot);
    await act(async () => Promise.all([initial, ...followups]));
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledTimes(2);
  });

  it("discovers orphaned work after a library event and invalidates diagnostics", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();

    await act(async () => {
      eventHandlers.get("portcove://library-changed")?.({ payload: "external mutation" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(desktopApi.discoverOrphanedOperations).toHaveBeenCalledWith(7);
    expect(data.diagnosticsStale).toBe(true);
  });

  it("observes an external durable change while idle without a desktop event", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    vi.mocked(desktopApi.workspaceChanged).mockResolvedValueOnce(true);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(desktopApi.workspaceChanged).toHaveBeenCalledWith(7);
    expect(desktopApi.discoverOrphanedOperations).toHaveBeenCalledWith(7);
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(data.diagnosticsStale).toBe(true);
  });

  it("keeps recovery failure distinct from a successful workspace read and retries explicitly", async () => {
    await render();
    vi.mocked(desktopApi.workspaceChanged).mockResolvedValueOnce(true);
    vi.mocked(desktopApi.discoverOrphanedOperations).mockRejectedValueOnce(failureReport());

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledTimes(2);
    expect(data.refreshFailure).toBeUndefined();
    expect(data.recoveryFailure).toBeDefined();
    expect(host.textContent).toContain("Library recovery could not finish");
    expect(host.textContent).toContain("Retry recovery");

    await act(async () => data.retryRecovery());
    expect(desktopApi.discoverOrphanedOperations).toHaveBeenCalledTimes(2);
    expect(data.recoveryFailure).toBeUndefined();
    expect(host.textContent).not.toContain("Library recovery could not finish");
  });

  it("restores focus after recovery retry failure and success", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const region = document.createElement("main");
    region.dataset.focusRegion = "workspace";
    const workspaceButton = document.createElement("button");
    workspaceButton.setAttribute("aria-current", "page");
    region.append(workspaceButton);
    document.body.append(region);
    await render();
    vi.mocked(desktopApi.workspaceChanged).mockResolvedValueOnce(true);
    vi.mocked(desktopApi.discoverOrphanedOperations).mockRejectedValueOnce(failureReport());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    vi.mocked(desktopApi.discoverOrphanedOperations).mockRejectedValueOnce(failureReport());
    let retryButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry recovery",
    );
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton?.focus();
      retryButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    retryButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry recovery",
    );
    expect(document.activeElement).toBe(retryButton);

    await act(async () => {
      retryButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(data.recoveryFailure).toBeUndefined();
    expect(document.activeElement).toBe(workspaceButton);
    region.remove();
  });

  it("retains the last essential snapshot and exposes a failed refresh", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockRejectedValueOnce(failureReport());
    await act(async () => data.retryRefresh());
    expect(data.catalog).toEqual(snapshot.catalog);
    expect(host.textContent).toContain("Library information could not be refreshed");
    expect(host.textContent).not.toContain("The changes could not be confirmed");
    expect(host.textContent).toContain("View technical details");
    expect(
      [...host.querySelectorAll('button[data-slot="button"][data-variant="outline"]')].find(
        (button) => button.textContent === "Retry refresh",
      ),
    ).toBeDefined();
  });

  it.each([
    ["committed", "The change was committed"],
    ["recovery_required", "Retained work needs recovery review"],
    ["future-outcome", "The changes could not be confirmed"],
  ] as const)("retains a consequential %s outcome on a failed refresh", async (state, message) => {
    await render();
    const error = failureReport();
    error.presentation.mutation_state = state as typeof error.presentation.mutation_state;
    vi.mocked(desktopApi.workspaceSnapshot).mockRejectedValueOnce(error);
    await act(async () => data.retryRefresh());
    expect(host.textContent).toContain(message);
    expect(host.textContent).toContain("View technical details");
  });

  it("keeps a committed operation successful when its workspace refresh fails", async () => {
    await render();
    const committed = { id: "committed-install" };
    const install = vi.fn().mockResolvedValue(committed);
    vi.mocked(desktopApi.workspaceSnapshot).mockRejectedValueOnce(failureReport());

    let result: typeof committed | undefined;
    await act(async () => {
      result = await operations.perform("install", install);
    });

    expect(result).toEqual(committed);
    expect(install).toHaveBeenCalledOnce();
    expect(operations.error).toBeUndefined();
    expect(data.refreshFailure).toBeDefined();
    expect(host.textContent).toContain("Showing the last loaded information");
    expect(host.textContent).toContain("It does not repeat your last install");
    expect(host.textContent).not.toContain("The changes could not be confirmed");

    await act(async () => data.retryRefresh());
    expect(install).toHaveBeenCalledOnce();
    expect(data.refreshFailure).toBeUndefined();
  });

  it("retains diagnostics but marks them stale when a later check fails", async () => {
    await render();
    await act(async () => data.invalidateDiagnostics());
    vi.mocked(desktopApi.doctor).mockRejectedValueOnce(failureReport());
    await act(async () => data.refreshDiagnostics());
    expect(data.doctor).toEqual(doctor);
    expect(data.diagnosticsStale).toBe(true);
    expect(data.diagnosticFailure).toBeDefined();
  });

  it("queues a fresh diagnostic read when a mutation invalidates an in-flight result", async () => {
    await render();
    const stale = deferred<DoctorReport>();
    const fresh = { ...doctor, registered_source_count: 1 };
    vi.mocked(desktopApi.doctor).mockClear();
    vi.mocked(desktopApi.doctor).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(fresh);

    let first!: ReturnType<typeof data.refreshDiagnostics>;
    let followup!: ReturnType<typeof data.refreshDiagnostics>;
    await act(async () => {
      data.invalidateDiagnostics();
      first = data.refreshDiagnostics();
      await Promise.resolve();
      void data.refreshAfterMutation();
      followup = data.refreshDiagnostics();
      stale.resolve(doctor);
      await Promise.all([first, followup]);
    });

    expect(desktopApi.doctor).toHaveBeenCalledTimes(2);
    expect(data.doctor).toEqual(fresh);
    expect(data.diagnosticsStale).toBe(false);
  });

  it("uses reduced visible-idle polling and refreshes immediately on focus", async () => {
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(desktopApi.activities).toHaveBeenCalledTimes(6);
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(desktopApi.discoverOrphanedOperations).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(desktopApi.activities).toHaveBeenCalledTimes(7);
  });

  it("coalesces same-turn focus and visibility reconciliation hints", async () => {
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(desktopApi.activities).toHaveBeenCalledOnce();
  });

  it("backs hidden idle polling off and reconciles when visibility returns", async () => {
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(desktopApi.activities).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());
    expect(desktopApi.activities).toHaveBeenCalledTimes(2);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => Promise.resolve());
    expect(desktopApi.activities).toHaveBeenCalledTimes(3);
  });

  it("polls active operations every second without overlapping requests", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    vi.mocked(desktopApi.workspaceSnapshot).mockResolvedValueOnce({
      ...snapshot,
      activities: {
        ...emptyActivityFeed(),
        current_activity_ids: ["active"],
        records: [
          {
            id: "active",
            operation: "install",
            target_kind: "port",
            target_id: "fixture",
            status: "running",
            message: null,
            failure: null,
            started_at: 1,
            finished_at: null,
            cancellation: null,
          },
        ],
      },
    });
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    const pending = deferred<WorkspaceSnapshot["activities"]>();
    vi.mocked(desktopApi.activities).mockReturnValueOnce(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(desktopApi.activities).toHaveBeenCalledOnce();
    const activeRenderCount = renderCount;
    pending.resolve(emptyActivityFeed());
    await act(async () => pending.promise);
    expect(data.activities).toEqual([]);
    expect(renderCount).toBeGreaterThan(activeRenderCount);
  });

  it("shows degraded notification state when listener setup fails", async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error("event bridge unavailable"));
    await render();
    expect(data.catalog).toEqual(snapshot.catalog);
    expect(host.textContent).toContain("Live workspace updates are unavailable");
    expect(host.textContent).toContain("Refresh now");
    expect(
      [...host.querySelectorAll('button[data-slot="button"][data-variant="outline"]')].find(
        (button) => button.textContent === "Refresh now",
      ),
    ).toBeDefined();
  });

  it("refreshes once after an operation and never starts the removed 250ms refresh", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    const task = deferred<string>();
    let result!: Promise<string | undefined>;
    await act(async () => {
      result = operations.perform("install", () => task.promise);
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(desktopApi.workspaceSnapshot).not.toHaveBeenCalled();
    task.resolve("complete");
    await act(async () => result);
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(data.diagnosticsStale).toBe(true);

    await act(async () => {
      const handler = eventHandlers.get("portcove://operation");
      handler?.({
        payload: {
          schema_version: 2,
          operation_id: "operation",
          parent_operation_id: null,
          sequence: 1,
          timestamp_ms: 1,
          target: null,
          operation: "install",
          type: "progress",
          phase: "running",
          completed: 0,
          total: 1,
        } satisfies OperationEvent,
      });
      await Promise.resolve();
    });
    expect(desktopApi.activities).toHaveBeenCalled();
  });

  it("keeps visual progress immediate while bounding durable activity reads", async () => {
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    const handler = eventHandlers.get("portcove://operation")!;
    const event = (sequence: number, type: OperationEvent["type"]): OperationEvent => ({
      schema_version: 2,
      operation_id: "bounded-operation",
      parent_operation_id: null,
      sequence,
      timestamp_ms: sequence * 100,
      target: null,
      operation: "install",
      ...(type === "started"
        ? { type }
        : type === "finished"
          ? { type, result: "succeeded" }
          : { type: "progress", phase: "running", completed: sequence, total: 20 }),
    });

    await act(async () => {
      handler({ payload: event(0, "started") });
      await Promise.resolve();
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        handler({ payload: event(sequence, "progress") });
        await vi.advanceTimersByTimeAsync(100);
      }
      handler({ payload: event(21, "finished") });
      await Promise.resolve();
    });

    expect(operations.operation?.type).toBe("finished");
    expect(desktopApi.activities).toHaveBeenCalledTimes(6);
  });

  it("does not invalidate workspace or diagnostics for a read-only operation", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    await act(async () =>
      operations.perform("support bundle", () => Promise.resolve("bundle.zip"), {
        refresh: "none",
        invalidateDiagnostics: false,
      }),
    );
    expect(desktopApi.workspaceSnapshot).not.toHaveBeenCalled();
    expect(data.diagnosticsStale).toBe(false);
  });

  it("refreshes persisted workspace state after checking all installed ports", async () => {
    const checkInstalled = vi.spyOn(desktopApi, "checkInstalled").mockResolvedValue([]);
    const calls = vi.fn();
    const perform: Perform = async (name, task, options) => {
      calls(name, task, options);
      return await task();
    };
    await act(async () => root.render(<UpdateFixture perform={perform} />));

    await act(async () => checkAll());

    expect(calls).toHaveBeenCalledWith("check installed", expect.any(Function), {
      refresh: "workspace",
      invalidateDiagnostics: false,
    });
    expect(checkInstalled).toHaveBeenCalledTimes(1);
  });
});
