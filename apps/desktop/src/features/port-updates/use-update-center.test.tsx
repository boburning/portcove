// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { portStatus } from "../../test-fixtures";
import type { InstallRecord, PortStatus, UpdateCheckOutcome } from "../../types";
import { useUpdateCenter } from "./use-update-center";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const install = (portId: string, digest: string): InstallRecord => ({
  id: `${portId}-install`,
  port_id: portId,
  version: "1.0",
  path: `${portId}/1.0`,
  channel: "stable",
  installed_at: 1,
  verified: true,
  staged: false,
  artifact: { asset_name: `${portId}.zip`, sha256: digest, size: 1 },
  manifest_sha256: "c".repeat(64),
  selected_executable: `${portId}.exe`,
  runtime: null,
});

function status(portId: string, digest: string): PortStatus {
  const active = install(portId, digest);
  return {
    ...portStatus(),
    port_id: portId,
    active,
    readiness: { launchable: true, blockers: [], pending_setup: false },
    last_update_check: {
      checked_at: 1,
      check: {
        port_id: portId,
        channel: "stable",
        installed_version: active.version,
        installed_artifact: active.artifact,
        installed_runtime: null,
        required_runtime: null,
        update_available: true,
        release: {
          published_at: null,
          version: "2.0",
          channel: "stable",
          asset: {
            name: `${portId}-2.zip`,
            url: `https://example.com/${portId}-2.zip`,
            size: 2,
            sha256: digest.replace(/^./u, digest[0] === "a" ? "b" : "a"),
          },
        },
      },
    },
  };
}

const outcome = (value: PortStatus): UpdateCheckOutcome => ({
  port_id: value.port_id,
  ok: true,
  error: null,
  result: value.last_update_check!.check,
});

describe("port update read owner", () => {
  let root: Root;
  let mounted: boolean;
  let state!: ReturnType<typeof useUpdateCenter>;
  const calls = vi.fn();
  const perform = async <T,>(
    name: string,
    task: () => Promise<T>,
    options?: { refresh?: "workspace" | "activities" | "none"; invalidateDiagnostics?: boolean },
  ) => {
    calls(name, task, options);
    return await task();
  };

  function Fixture({ statuses }: { statuses: PortStatus[] }) {
    state = useUpdateCenter(perform, statuses);
    return <span>{state.outcomes.map((item) => item.port_id).join(",")}</span>;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    calls.mockReset();
  });

  it("uses current workspace snapshots and preserves the read-only refresh contract", async () => {
    const current = status("alpha", "a".repeat(64));
    const checkInstalled = vi
      .spyOn(desktopApi, "checkInstalled")
      .mockResolvedValue([outcome(current)]);
    await act(async () => root.render(<Fixture statuses={[current]} />));

    expect(state.outcomes).toEqual([outcome(current)]);
    await act(async () => state.checkAll());

    expect(calls).toHaveBeenCalledWith("check installed", expect.any(Function), {
      refresh: "workspace",
      invalidateDiagnostics: false,
    });
    expect(checkInstalled).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest result when overlapping checks complete out of order", async () => {
    const current = status("alpha", "a".repeat(64));
    const first = deferred<UpdateCheckOutcome[]>();
    const second = deferred<UpdateCheckOutcome[]>();
    vi.spyOn(desktopApi, "checkInstalled")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await act(async () => root.render(<Fixture statuses={[current]} />));

    let firstRun!: Promise<void>;
    let secondRun!: Promise<void>;
    act(() => {
      firstRun = state.checkAll();
      secondRun = state.checkAll();
    });
    const newest = outcome(status("newest", "b".repeat(64)));
    await act(async () => {
      second.resolve([newest]);
      await secondRun;
    });
    expect(state.outcomes).toEqual([newest]);

    await act(async () => {
      first.resolve([outcome(status("older", "c".repeat(64)))]);
      await firstRun;
    });
    expect(state.outcomes).toEqual([newest]);
  });

  it("absorbs an older rejection after a newer check succeeds", async () => {
    const current = status("alpha", "a".repeat(64));
    const first = deferred<UpdateCheckOutcome[]>();
    const second = deferred<UpdateCheckOutcome[]>();
    vi.spyOn(desktopApi, "checkInstalled")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await act(async () => root.render(<Fixture statuses={[current]} />));

    let firstRun!: Promise<void>;
    let secondRun!: Promise<void>;
    act(() => {
      firstRun = state.checkAll();
      secondRun = state.checkAll();
    });
    const newest = outcome(status("newest", "b".repeat(64)));
    await act(async () => {
      second.resolve([newest]);
      await secondRun;
    });

    await act(async () => {
      first.reject(new Error("stale failure"));
      await expect(firstRun).resolves.toBeUndefined();
    });
    expect(state.outcomes).toEqual([newest]);
  });

  it("rejects a completion from an earlier workspace baseline", async () => {
    const alpha = status("alpha", "a".repeat(64));
    const beta = status("beta", "b".repeat(64));
    const pending = deferred<UpdateCheckOutcome[]>();
    vi.spyOn(desktopApi, "checkInstalled").mockImplementation(() => pending.promise);
    await act(async () => root.render(<Fixture statuses={[alpha]} />));

    let run!: Promise<void>;
    act(() => {
      run = state.checkAll();
    });
    await act(async () => root.render(<Fixture statuses={[beta]} />));
    await act(async () => {
      pending.resolve([outcome(alpha)]);
      await run;
    });

    expect(state.outcomes).toEqual([outcome(beta)]);
  });

  it("drops a retained result when an unsnapshotted installation changes", async () => {
    const earlier = { ...status("alpha", "a".repeat(64)), last_update_check: null };
    const changed = { ...status("alpha", "b".repeat(64)), last_update_check: null };
    const oldResult = outcome(status("alpha", "a".repeat(64)));
    vi.spyOn(desktopApi, "checkInstalled").mockResolvedValue([oldResult]);
    await act(async () => root.render(<Fixture statuses={[earlier]} />));
    await act(async () => state.checkAll());
    expect(state.outcomes).toEqual([oldResult]);

    await act(async () => root.render(<Fixture statuses={[changed]} />));
    expect(state.outcomes).toEqual([]);
  });

  it("rejects an in-flight result after an unsnapshotted installation changes", async () => {
    const earlier = { ...status("alpha", "a".repeat(64)), last_update_check: null };
    const changed = { ...status("alpha", "b".repeat(64)), last_update_check: null };
    const pending = deferred<UpdateCheckOutcome[]>();
    vi.spyOn(desktopApi, "checkInstalled").mockImplementation(() => pending.promise);
    await act(async () => root.render(<Fixture statuses={[earlier]} />));

    let run!: Promise<void>;
    act(() => {
      run = state.checkAll();
    });
    await act(async () => root.render(<Fixture statuses={[changed]} />));
    await act(async () => {
      pending.resolve([outcome(status("alpha", "a".repeat(64)))]);
      await run;
    });
    expect(state.outcomes).toEqual([]);
  });

  it("absorbs a rejection from an earlier workspace baseline", async () => {
    const alpha = status("alpha", "a".repeat(64));
    const beta = status("beta", "b".repeat(64));
    const pending = deferred<UpdateCheckOutcome[]>();
    vi.spyOn(desktopApi, "checkInstalled").mockImplementation(() => pending.promise);
    await act(async () => root.render(<Fixture statuses={[alpha]} />));

    let run!: Promise<void>;
    act(() => {
      run = state.checkAll();
    });
    await act(async () => root.render(<Fixture statuses={[beta]} />));
    await act(async () => {
      pending.reject(new Error("old baseline failure"));
      await expect(run).resolves.toBeUndefined();
    });

    expect(state.outcomes).toEqual([outcome(beta)]);
  });

  it("does not publish a completion after disposal", async () => {
    const current = status("alpha", "a".repeat(64));
    const pending = deferred<UpdateCheckOutcome[]>();
    const checkInstalled = vi
      .spyOn(desktopApi, "checkInstalled")
      .mockImplementation(() => pending.promise);
    await act(async () => root.render(<Fixture statuses={[current]} />));

    let run!: Promise<void>;
    act(() => {
      run = state.checkAll();
      root.unmount();
      mounted = false;
    });
    await act(async () => {
      pending.resolve([outcome(status("late", "d".repeat(64)))]);
      await run;
    });
    expect(checkInstalled).toHaveBeenCalledTimes(1);
  });

  it("absorbs a rejection after disposal", async () => {
    const current = status("alpha", "a".repeat(64));
    const pending = deferred<UpdateCheckOutcome[]>();
    const checkInstalled = vi
      .spyOn(desktopApi, "checkInstalled")
      .mockImplementation(() => pending.promise);
    await act(async () => root.render(<Fixture statuses={[current]} />));

    let run!: Promise<void>;
    act(() => {
      run = state.checkAll();
      root.unmount();
      mounted = false;
    });
    await act(async () => {
      pending.reject(new Error("disposed failure"));
      await expect(run).resolves.toBeUndefined();
    });
    expect(checkInstalled).toHaveBeenCalledTimes(1);
  });
});
