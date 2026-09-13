// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import { useOperationState, usePortcoveData, useUpdateCenter, type Perform } from "./use-portcove";
import { failureReport, portDefinition, portStatus } from "./test-fixtures";
import type { DoctorReport, OperationEvent, WorkspaceSnapshot } from "./types";
import { WorkspaceRefreshNotice } from "./components/WorkspaceRefreshNotice";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const snapshot: WorkspaceSnapshot = {
  catalog: { schema_version: 1, ports: [portDefinition()], source_profiles: [] },
  statuses: [portStatus()],
  sources: [],
  activities: [],
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
let checkAll: () => Promise<void>;

function Fixture({ generation = 7 }: { generation?: number }) {
  renderCount += 1;
  data = usePortcoveData(generation);
  operations = useOperationState({
    refresh: data.retryRefresh,
    refreshActivities: data.refreshActivities,
    invalidateDiagnostics: data.invalidateDiagnostics,
  });
  return (
    <WorkspaceRefreshNotice
      failure={data.refreshFailure}
      hasSnapshot={Boolean(data.catalog)}
      refreshing={data.refreshing}
      retry={data.retryRefresh}
      subscriptionFailure={data.subscriptionFailure?.error ?? operations.subscriptionFailure}
    />
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  eventHandlers = new Map();
  renderCount = 0;
  vi.mocked(listen).mockImplementation(async (event, handler) => {
    eventHandlers.set(event, handler as (event: { payload: unknown }) => void);
    return () => eventHandlers.delete(event);
  });
  vi.spyOn(desktopApi, "workspaceSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "activities").mockResolvedValue([]);
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
  it("registers the library listener before acquiring the initial snapshot", async () => {
    const registration = deferred<() => void>();
    vi.mocked(listen).mockImplementationOnce((event, handler) => {
      eventHandlers.set(event, handler as (event: { payload: unknown }) => void);
      return registration.promise;
    });
    await render();
    expect(desktopApi.workspaceSnapshot).not.toHaveBeenCalled();
    registration.resolve(() => eventHandlers.delete("portcove://library-changed"));
    await act(async () => registration.promise);
    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
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

  it("coalesces a burst and runs one follow-up when invalidated during a request", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();
    const first = deferred<WorkspaceSnapshot>();
    vi.mocked(desktopApi.workspaceSnapshot)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(snapshot);
    let initial!: Promise<void>;
    let followups!: Promise<void>[];
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

  it("treats an external library event as a readback hint and invalidates diagnostics", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockClear();

    await act(async () => {
      eventHandlers.get("portcove://library-changed")?.({ payload: "external mutation" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(desktopApi.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(data.diagnosticsStale).toBe(true);
  });

  it("retains the last essential snapshot and exposes a failed refresh", async () => {
    await render();
    vi.mocked(desktopApi.workspaceSnapshot).mockRejectedValueOnce(failureReport());
    await act(async () => data.retryRefresh());
    expect(data.catalog).toEqual(snapshot.catalog);
    expect(host.textContent).toContain("Library information could not be refreshed");
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

  it("uses reduced visible-idle polling and refreshes immediately on focus", async () => {
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    const settledRenderCount = renderCount;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(desktopApi.activities).toHaveBeenCalledTimes(6);
    expect(renderCount).toBe(settledRenderCount);
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
      activities: [
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
    });
    await render();
    vi.mocked(desktopApi.activities).mockClear();
    const pending = deferred<WorkspaceSnapshot["activities"]>();
    vi.mocked(desktopApi.activities).mockReturnValueOnce(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(desktopApi.activities).toHaveBeenCalledOnce();
    const activeRenderCount = renderCount;
    pending.resolve([]);
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
    vi.spyOn(desktopApi, "checkInstalled").mockResolvedValue([]);
    const calls = vi.fn();
    const perform: Perform = async (name, task, options) => {
      calls(name, task, options);
      return await task();
    };
    await act(async () => root.render(<UpdateFixture perform={perform} />));

    await act(async () => checkAll());

    expect(calls).toHaveBeenCalledWith("check installed", desktopApi.checkInstalled, {
      refresh: "workspace",
      invalidateDiagnostics: false,
    });
  });
});
