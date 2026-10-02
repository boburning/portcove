// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import { failureReport } from "../../test-fixtures";
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

  it("distinguishes an unread list, a failed read, and a successful empty inventory", async () => {
    const initial = deferred<BackupInventory>();
    vi.spyOn(desktopApi, "backups")
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce({ port_id: "game", state: "healthy", backups: [], problems: [] });
    await act(async () => root?.render(<Fixture portId="game" />));
    expect(state.readState).toMatchObject({ status: "pending", hasInventory: false });
    await act(async () => initial.reject(new Error("read failure")));
    expect(state.readState).toMatchObject({ status: "failed", hasInventory: false });
    await act(async () => state.refresh());
    expect(state.readState).toMatchObject({ status: "current", hasInventory: true });
    expect(state.backups).toEqual([]);
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

  it("retains even a last-loaded empty inventory during a pending and failed refresh", async () => {
    const next = deferred<BackupInventory>();
    const failure = failureReport();
    vi.spyOn(desktopApi, "backups")
      .mockResolvedValueOnce({ port_id: "game", state: "healthy", backups: [], problems: [] })
      .mockReturnValueOnce(next.promise);
    await act(async () => root?.render(<Fixture portId="game" />));
    let pending!: Promise<void>;
    await act(async () => {
      pending = state.refresh();
    });
    expect(state.readState).toMatchObject({ status: "pending", hasInventory: true });
    await act(async () => {
      next.reject(failure);
      await pending;
    });
    expect(state.readState).toMatchObject({
      status: "failed",
      hasInventory: true,
      failure: failure.presentation,
    });
    expect(state.backups).toEqual([]);
  });

  it("keeps the newest rapid refresh authoritative over an older failure", async () => {
    const older = deferred<BackupInventory>();
    const newer = deferred<BackupInventory>();
    const read = vi
      .spyOn(desktopApi, "backups")
      .mockResolvedValueOnce(inventory("game", "initial"))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await act(async () => root?.render(<Fixture portId="game" />));
    let oldRequest!: Promise<void>;
    let newRequest!: Promise<void>;
    await act(async () => {
      oldRequest = state.refresh();
      newRequest = state.refresh();
    });
    expect(state.backups[0]?.id).toBe("initial");
    expect(state.readState).toMatchObject({ status: "pending", hasInventory: true });
    await act(async () => {
      newer.resolve(inventory("game", "newest"));
      await newRequest;
    });
    await act(async () => {
      older.reject(new Error("older failure"));
      await oldRequest;
    });
    expect(state.backups[0]?.id).toBe("newest");
    expect(state.readState.status).toBe("current");
    expect(setError).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not erase a newer failed refresh with an older successful response", async () => {
    const older = deferred<BackupInventory>();
    const newer = deferred<BackupInventory>();
    vi.spyOn(desktopApi, "backups")
      .mockResolvedValueOnce(inventory("game", "initial"))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await act(async () => root?.render(<Fixture portId="game" />));
    let oldRequest!: Promise<void>;
    let newRequest!: Promise<void>;
    await act(async () => {
      oldRequest = state.refresh();
      newRequest = state.refresh();
    });
    await act(async () => {
      newer.reject(new Error("newest failure"));
      await newRequest;
    });
    await act(async () => {
      older.resolve(inventory("game", "older"));
      await oldRequest;
    });
    expect(state.backups[0]?.id).toBe("initial");
    expect(state.readState).toMatchObject({ status: "failed", hasInventory: true });
    expect(setError).toHaveBeenCalledExactlyOnceWith("newest failure");
  });

  it("does not reuse a prior selection's inventory or callback when returning to the same port", async () => {
    const returned = deferred<BackupInventory>();
    const read = vi
      .spyOn(desktopApi, "backups")
      .mockResolvedValueOnce(inventory("old"))
      .mockResolvedValueOnce(inventory("other"))
      .mockReturnValueOnce(returned.promise);
    await act(async () => root?.render(<Fixture portId="old" />));
    const oldRefresh = state.refresh;
    await act(async () => root?.render(<Fixture portId="other" />));
    await act(async () => root?.render(<Fixture portId="old" />));
    expect(state.backups).toEqual([]);
    expect(state.readState).toMatchObject({ status: "pending", hasInventory: false });
    await act(async () => oldRefresh());
    expect(read).toHaveBeenCalledTimes(3);
    await act(async () => returned.resolve(inventory("old", "returned")));
    expect(state.backups[0]?.id).toBe("returned");
    expect(state.readState.status).toBe("current");
  });

  it("does not present another port's response as the selected port's current inventory", async () => {
    vi.spyOn(desktopApi, "backups").mockResolvedValueOnce(inventory("different"));
    await act(async () => root?.render(<Fixture portId="game" />));
    expect(state.inventory.port_id).toBe("game");
    expect(state.backups).toEqual([]);
    expect(state.readState).toMatchObject({ status: "failed", hasInventory: false });
  });

  it("settles a synchronously thrown read as a failed inventory without inventing a mutation result", async () => {
    vi.spyOn(desktopApi, "backups").mockImplementationOnce(() => {
      throw new Error("read could not start");
    });
    await act(async () => root?.render(<Fixture portId="game" />));
    expect(state.readState).toMatchObject({ status: "failed", hasInventory: false });
    expect(setError).toHaveBeenCalledExactlyOnceWith("read could not start");
  });
});
