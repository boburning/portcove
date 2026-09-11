// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { desktopApi } from "./api";
import { useOperationState, usePortcoveData } from "./use-portcove";
import { failureReport, portDefinition, portStatus } from "./test-fixtures";
import type { CatalogDocument, DoctorReport } from "./types";
import { WorkspaceRefreshNotice } from "./components/WorkspaceRefreshNotice";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
const catalog: CatalogDocument = {
  schema_version: 1,
  ports: [portDefinition()],
  source_profiles: [],
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
let root: Root;
let host: HTMLDivElement;
let data: ReturnType<typeof usePortcoveData>;
let operations: ReturnType<typeof useOperationState>;
function Fixture() {
  data = usePortcoveData();
  operations = useOperationState(data.retryRefresh);
  return (
    <WorkspaceRefreshNotice
      failure={data.refreshFailure}
      hasSnapshot={Boolean(data.catalog)}
      refreshing={data.refreshing}
      retry={data.retryRefresh}
    />
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(desktopApi, "catalog").mockResolvedValue(catalog);
  vi.spyOn(desktopApi, "statuses").mockResolvedValue([portStatus()]);
  vi.spyOn(desktopApi, "sources").mockResolvedValue([]);
  vi.spyOn(desktopApi, "activities").mockResolvedValue([]);
  vi.spyOn(desktopApi, "doctor").mockResolvedValue(doctor);
  await act(async () => root.render(<Fixture />));
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
  it("offers an explicit retry after initial failure and clears it only after a successful snapshot", async () => {
    const error = failureReport();
    error.message = "private-machine-value";
    vi.mocked(desktopApi.catalog).mockRejectedValueOnce(error);
    await act(async () => {
      await data.retryRefresh();
    });
    expect(data.catalog).toBeUndefined();
    expect(data.refreshing).toBe(false);
    expect(host.textContent).toContain("Library information could not be loaded");
    expect(host.textContent).toContain(error.presentation.summary);
    expect(host.textContent).not.toContain("private-machine-value");
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry refresh",
    )!;
    await act(async () => {
      retry.click();
    });
    expect(data.catalog).toBe(catalog);
    expect(data.refreshFailure).toBeUndefined();
    expect(host.textContent).toBe("");
    expect(desktopApi.catalog).toHaveBeenCalledTimes(2);
  });
  it("retains every previous snapshot field when one refresh command fails", async () => {
    await act(async () => {
      await data.retryRefresh();
    });
    const previous = {
      catalog: data.catalog,
      statuses: data.statuses,
      sources: data.sources,
      activities: data.activities,
      doctor: data.doctor,
    };
    vi.mocked(desktopApi.catalog).mockResolvedValue({ ...catalog, ports: [] });
    vi.mocked(desktopApi.doctor).mockRejectedValueOnce(new Error("temporarily unavailable"));
    await act(async () => {
      await data.retryRefresh();
    });
    for (const key of Object.keys(previous) as (keyof typeof previous)[])
      expect(data[key]).toBe(previous[key]);
    expect(host.textContent).toContain(
      "Showing the last loaded information. It may be out of date.",
    );
    expect(host.textContent).not.toContain("No files were changed");
  });
  it("does not let a stale rejection replace the newest successful refresh", async () => {
    let reject!: (reason: unknown) => void;
    vi.mocked(desktopApi.catalog).mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    let old!: Promise<void>;
    await act(async () => {
      old = data.retryRefresh();
    });
    expect(data.refreshing).toBe(true);
    await act(async () => {
      await data.retryRefresh();
    });
    await act(async () => {
      reject(new Error("old failure"));
      await old;
    });
    expect(data.catalog).toBe(catalog);
    expect(data.refreshFailure).toBeUndefined();
    expect(data.refreshing).toBe(false);
  });
  it("keeps a newer failed refresh visible when an older response succeeds later", async () => {
    let resolve!: (value: CatalogDocument) => void;
    vi.mocked(desktopApi.catalog).mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    let old!: Promise<void>;
    await act(async () => {
      old = data.retryRefresh();
    });
    vi.mocked(desktopApi.catalog).mockRejectedValueOnce(new Error("new failure"));
    await act(async () => {
      await data.retryRefresh();
    });
    await act(async () => {
      resolve(catalog);
      await old;
    });
    expect(data.catalog).toBeUndefined();
    expect(data.refreshFailure?.error).toEqual(new Error("new failure"));
  });
  it("handles failed library-change refreshes without losing the failure or retrying automatically", async () => {
    vi.mocked(desktopApi.catalog).mockRejectedValueOnce(new Error("event failure"));
    const callback = vi
      .mocked(listen)
      .mock.calls.find(([event]) => event === "portcove://library-changed")![1];
    await act(async () => {
      callback({ event: "portcove://library-changed", id: 1, payload: "" });
    });
    expect(data.refreshFailure?.error).toEqual(new Error("event failure"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(desktopApi.catalog).toHaveBeenCalledOnce();
  });
  it("refreshes after an operation without replacing its failure or repeating the operation", async () => {
    const mutationFailure = failureReport();
    const action = vi.fn().mockRejectedValue(mutationFailure);
    vi.mocked(desktopApi.catalog).mockRejectedValueOnce(new Error("refresh failure"));
    await act(async () => {
      await operations.perform("move", action);
    });
    expect(operations.error).toBe(mutationFailure);
    expect(data.refreshFailure).toBeDefined();
    await act(async () => {
      await data.retryRefresh();
    });
    expect(operations.error).toBe(mutationFailure);
    expect(data.refreshFailure).toBeUndefined();
    expect(action).toHaveBeenCalledOnce();
  });
  it("keeps a successful operation result distinct from a failed display refresh", async () => {
    const committed = { changed: true };
    const action = vi.fn().mockResolvedValue(committed);
    vi.mocked(desktopApi.catalog).mockRejectedValueOnce(new Error("refresh failure"));
    let result: unknown;
    await act(async () => {
      result = await operations.perform("save", action);
    });
    expect(result).toBe(committed);
    expect(operations.error).toBeUndefined();
    expect(data.refreshFailure).toBeDefined();
    await act(async () => {
      await data.retryRefresh();
    });
    expect(action).toHaveBeenCalledOnce();
    expect(data.refreshFailure).toBeUndefined();
  });
  it("disables retry during the pending request and preserves the current failure until completion", async () => {
    vi.mocked(desktopApi.catalog).mockRejectedValueOnce(new Error("initial failure"));
    await act(async () => {
      await data.retryRefresh();
    });
    let resolve!: (value: CatalogDocument) => void;
    vi.mocked(desktopApi.catalog).mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = data.retryRefresh();
    });
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Refreshing library…",
    )!;
    expect(retry.disabled).toBe(true);
    expect(data.refreshFailure).toBeDefined();
    await act(async () => {
      resolve(catalog);
      await pending;
    });
    expect(data.refreshing).toBe(false);
    expect(data.refreshFailure).toBeUndefined();
  });
});
