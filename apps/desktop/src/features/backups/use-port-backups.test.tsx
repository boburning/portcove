// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import type { BackupInventory } from "../../types";
import { usePortBackups } from "./use-port-backups";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const inventory = (portId: string, backupId = `${portId}-backup`): BackupInventory => ({
  port_id: portId,
  state: "healthy",
  backups: [
    {
      created_at: 1,
      file_count: 0,
      id: backupId,
      path: `D:/Backups/${backupId}`,
      port_id: portId,
      sha256: "a".repeat(64),
      size: 0,
    },
  ],
  problems: [],
});

describe("backup inventory read owner", () => {
  let root: Root | undefined;
  let state!: ReturnType<typeof usePortBackups>;
  let setError: ReturnType<typeof vi.fn<(error?: string) => void>>;

  function Fixture({ portId }: { portId?: string }) {
    state = usePortBackups(portId, setError);
    return <span>{state.inventory.port_id}</span>;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
    setError = vi.fn();
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not read backups without a selected port", async () => {
    const backups = vi.spyOn(desktopApi, "backups");
    await act(async () => root?.render(<Fixture />));

    expect(backups).not.toHaveBeenCalled();
    expect(state.inventory).toMatchObject({ port_id: "", backups: [], problems: [] });
  });

  it("does not publish an older port after the selection changes", async () => {
    const old = deferred<BackupInventory>();
    const current = deferred<BackupInventory>();
    vi.spyOn(desktopApi, "backups")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await act(async () => root?.render(<Fixture portId="old" />));
    await act(async () => root?.render(<Fixture portId="current" />));

    await act(async () => current.resolve(inventory("current")));
    expect(state.inventory.port_id).toBe("current");
    await act(async () => old.resolve(inventory("old")));
    expect(state.inventory.port_id).toBe("current");
  });

  it("reports only the current port failure", async () => {
    const old = deferred<BackupInventory>();
    const current = deferred<BackupInventory>();
    vi.spyOn(desktopApi, "backups")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await act(async () => root?.render(<Fixture portId="old" />));
    await act(async () => root?.render(<Fixture portId="current" />));

    await act(async () => old.reject(new Error("stale failure")));
    expect(setError).not.toHaveBeenCalled();
    await act(async () => current.reject(new Error("current failure")));
    expect(setError).toHaveBeenCalledWith("current failure");
  });

  it("does not let a retained old-port refresh cancel the current port read", async () => {
    const current = deferred<BackupInventory>();
    const backups = vi
      .spyOn(desktopApi, "backups")
      .mockResolvedValueOnce(inventory("old"))
      .mockReturnValueOnce(current.promise);
    await act(async () => root?.render(<Fixture portId="old" />));
    const refreshOld = state.refresh;
    await act(async () => root?.render(<Fixture portId="current" />));

    await act(async () => refreshOld());
    expect(backups).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(inventory("current")));
    expect(state.inventory.port_id).toBe("current");
    expect(setError).not.toHaveBeenCalled();
  });

  it("refreshes the current port and ignores a result after disposal", async () => {
    vi.spyOn(desktopApi, "backups").mockResolvedValueOnce(inventory("game", "initial"));
    await act(async () => root?.render(<Fixture portId="game" />));
    expect(state.backups[0]?.id).toBe("initial");

    const refreshed = deferred<BackupInventory>();
    vi.mocked(desktopApi.backups).mockReturnValueOnce(refreshed.promise);
    await act(async () => {
      const pending = state.refresh();
      refreshed.resolve(inventory("game", "refreshed"));
      await pending;
    });
    expect(state.backups[0]?.id).toBe("refreshed");

    const disposed = deferred<BackupInventory>();
    vi.mocked(desktopApi.backups).mockReturnValueOnce(disposed.promise);
    let pending!: Promise<void>;
    await act(async () => {
      pending = state.refresh();
      root?.unmount();
      root = undefined;
    });
    await act(async () => {
      disposed.reject(new Error("disposed failure"));
      await pending;
    });
    expect(setError).not.toHaveBeenCalled();
  });
});
