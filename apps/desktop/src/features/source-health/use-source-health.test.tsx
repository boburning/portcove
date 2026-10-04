// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import type { SourceInspectionReport, SourceRecord, SourceVerificationOutcome } from "../../types";
import { useOperationState } from "../operations/use-operation-state";
import { useSourceHealth } from "./use-source-health";

vi.mock("../../desktop-events", () => ({ listenDesktopEvent: async () => () => undefined }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const perform: Parameters<typeof useSourceHealth>[0] = async (_name, task) => task();
const refresh = async () => undefined;
let operation: ReturnType<typeof useOperationState>;
function VerificationFixture() {
  operation = useOperationState({ refresh });
  state = useSourceHealth(operation.perform, [source("current/game.z64")], ["game"], "catalog");
  return null;
}
const source = (path: string): SourceRecord => ({
  profile_id: "game",
  path,
  sha256: "a".repeat(64),
  size: 1,
  storage_sha256: "a".repeat(64),
  storage_size: 1,
  updated_at: 1,
});
const report = (path: string): SourceInspectionReport => ({
  schema_version: 1,
  profile_id: "game",
  health: "current",
  state_code: "recognized_exact",
  summary: path,
  next_action: "Continue",
  registered: source(path),
  applications: [],
  evidence: [],
  legacy: {
    registration_identity_not_recorded: false,
    variant_unspecified_records: [],
  },
});

let root: Root;
let state: ReturnType<typeof useSourceHealth>;
function Fixture({
  path,
  catalog,
  requested = true,
}: {
  path: string;
  catalog: string;
  requested?: boolean;
}) {
  state = useSourceHealth(perform, [source(path)], requested ? ["game"] : [], catalog);
  return null;
}
async function render(path: string, catalog: string) {
  await act(async () => root.render(createElement(Fixture, { path, catalog })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("source inspection intent", () => {
  it("does not hash a registration during ordinary browsing", async () => {
    const inspect = vi.spyOn(desktopApi, "inspectSource");
    await act(async () =>
      root.render(
        createElement(Fixture, {
          path: "D:/Game.z64",
          catalog: "catalog",
          requested: false,
        }),
      ),
    );
    expect(inspect).not.toHaveBeenCalled();
    expect(state.inspections.size).toBe(0);
  });

  it.each([
    ["a later selected path", "D:/Old.z64", "D:/Current.z64", "catalog-a", "catalog-a"],
    ["a later catalog", "D:/Game.z64", "D:/Game.z64", "catalog-old", "catalog-current"],
  ])(
    "does not let an old response replace %s",
    async (_label, oldPath, currentPath, oldCatalog, currentCatalog) => {
      const old = deferred<SourceInspectionReport>();
      const current = deferred<SourceInspectionReport>();
      vi.spyOn(desktopApi, "inspectSource")
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      await render(oldPath, oldCatalog);
      await render(currentPath, currentCatalog);
      await act(async () => {
        current.resolve(report(currentPath));
        await current.promise;
      });
      expect(state.inspections.get("game")?.summary).toBe(currentPath);
      await act(async () => {
        old.resolve(report(oldPath));
        await old.promise;
      });
      expect(state.inspections.get("game")?.summary).toBe(currentPath);
    },
  );

  it("keeps the newest verification outcome when an older request finishes last", async () => {
    vi.spyOn(desktopApi, "inspectSource").mockResolvedValue(report("D:/Game.z64"));
    const old = deferred<SourceVerificationOutcome[]>();
    const current = deferred<SourceVerificationOutcome[]>();
    const oldOutcome: SourceVerificationOutcome[] = [
      { error: null, ok: false, profile_id: "game", result: null },
    ];
    const currentOutcome: SourceVerificationOutcome[] = [
      { error: null, ok: true, profile_id: "game", result: null },
    ];
    vi.spyOn(desktopApi, "verifySources")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await render("D:/Game.z64", "catalog");

    let oldRequest!: Promise<void>;
    let currentRequest!: Promise<void>;
    await act(async () => {
      oldRequest = state.verifyAll();
      currentRequest = state.verifyAll();
      current.resolve(currentOutcome);
      await currentRequest;
    });
    expect(state.outcomes).toBe(currentOutcome);

    await act(async () => {
      old.resolve(oldOutcome);
      await oldRequest;
    });
    expect(state.outcomes).toBe(currentOutcome);
  });
});

function HealthFixture({
  sources,
  profiles,
  catalog = "catalog",
}: {
  sources: SourceRecord[];
  profiles: string[];
  catalog?: string;
}) {
  state = useSourceHealth(perform, sources, profiles, catalog);
  return null;
}
async function renderHealth(
  sources = [source("current/game.z64")],
  profiles = sources.map((item) => item.profile_id),
  catalog = "catalog",
) {
  await act(async () => root.render(createElement(HealthFixture, { sources, profiles, catalog })));
}
it("records a settled failure separately from source verification and coalesces its pending retry", async () => {
  const next = deferred<SourceInspectionReport>();
  const failure = { code: "state", message: "read failed" };
  const inspect = vi
    .spyOn(desktopApi, "inspectSource")
    .mockRejectedValueOnce(failure)
    .mockReturnValueOnce(next.promise);
  const verify = vi.spyOn(desktopApi, "verifySources");
  await renderHealth();
  expect(state.inspectionReads.get("game")?.status).toBe("failed");
  expect(state.inspectionReads.get("game")?.code).toBe("state");
  expect(state.inspections.size).toBe(0);
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = state.inspectSource("game");
    second = state.inspectSource("game");
  });
  expect(first).toBe(second);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(state.inspectionReads.get("game")?.status).toBe("pending");
  await act(async () => {
    next.resolve(report("current/game.z64"));
    await first;
  });
  expect(state.inspectionReads.get("game")?.status).toBe("current");
  expect(state.inspections.get("game")?.summary).toBe("current/game.z64");
  expect(state.outcomes).toEqual([]);
  expect(verify).not.toHaveBeenCalled();
});
it("retries only a failed profile and preserves a healthy sibling", async () => {
  const sibling = { ...source("current/bios.bin"), profile_id: "bios" };
  const siblingReport = { ...report(sibling.path), profile_id: "bios", registered: sibling };
  let gameReads = 0;
  const inspect = vi.spyOn(desktopApi, "inspectSource").mockImplementation((id) => {
    if (id === "bios") return Promise.resolve(siblingReport);
    if (++gameReads === 1) return Promise.reject({ code: "state" });
    return Promise.resolve(report("current/game.z64"));
  });
  await renderHealth([source("current/game.z64"), sibling]);
  expect(state.inspectionReads.get("bios")?.status).toBe("current");
  expect(state.inspectionReads.get("game")?.status).toBe("failed");
  await act(async () => {
    await state.inspectSource("game");
  });
  expect(inspect.mock.calls.map(([id]) => id)).toEqual(["game", "bios", "game"]);
  expect(state.inspections.get("bios")).toBe(siblingReport);
});
it("keeps independent profile retries when another profile is still pending", async () => {
  const game = deferred<SourceInspectionReport>();
  const bios = deferred<SourceInspectionReport>();
  const sibling = { ...source("current/bios.bin"), profile_id: "bios" };
  vi.spyOn(desktopApi, "inspectSource").mockImplementation((id) =>
    id === "game" ? game.promise : bios.promise,
  );
  await renderHealth([source("current/game.z64"), sibling]);
  await act(async () => {
    bios.resolve({ ...report(sibling.path), profile_id: "bios", registered: sibling });
    await bios.promise;
  });
  expect(state.inspectionReads.get("bios")?.status).toBe("current");
  expect(state.inspectionReads.get("game")?.status).toBe("pending");
  await act(async () => {
    game.resolve(report("current/game.z64"));
    await game.promise;
  });
  expect(state.inspectionReads.get("game")?.status).toBe("current");
});
it.each(["source", "catalog", "requested profiles"])(
  "rejects an older failure after %s changes",
  async (kind) => {
    const old = deferred<SourceInspectionReport>();
    vi.spyOn(desktopApi, "inspectSource")
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(report("current/game.z64"));
    await renderHealth([source("old/game.z64")]);
    await renderHealth(
      [source(kind === "source" ? "current/game.z64" : "old/game.z64")],
      kind === "requested profiles" ? [] : ["game"],
      kind === "catalog" ? "new-catalog" : "catalog",
    );
    await act(async () => {
      old.reject({ code: "state", message: "old error" });
      await old.promise.catch(() => undefined);
    });
    expect(state.inspectionReads.get("game")?.status).toBe(
      kind === "requested profiles" ? undefined : "current",
    );
    expect(state.inspectionReads.get("game")?.code).toBeUndefined();
  },
);
it("refuses a stale profile retry after selection and a retry after disposal", async () => {
  const inspect = vi
    .spyOn(desktopApi, "inspectSource")
    .mockResolvedValue(report("current/game.z64"));
  await renderHealth();
  const retry = state.inspectSource;
  await renderHealth([], []);
  await act(async () => {
    await retry("game");
  });
  await act(async () => root.unmount());
  await retry("game");
  expect(inspect).toHaveBeenCalledTimes(1);
  root = createRoot(document.createElement("div"));
});
it("ignores an in-flight response after unmount", async () => {
  const pending = deferred<SourceInspectionReport>();
  vi.spyOn(desktopApi, "inspectSource").mockReturnValueOnce(pending.promise);
  await renderHealth();
  const before = state;
  await act(async () => root.unmount());
  await act(async () => {
    pending.resolve(report("late/game.z64"));
    await pending.promise;
  });
  expect(state).toBe(before);
  root = createRoot(document.createElement("div"));
});
it("keeps cancellation neutral and permits a later explicit retry", async () => {
  vi.spyOn(desktopApi, "inspectSource")
    .mockRejectedValueOnce({ code: "cancelled" })
    .mockResolvedValue(report("current/game.z64"));
  await renderHealth();
  expect(state.inspectionReads.get("game")?.status).toBe("cancelled");
  expect(state.inspections.size).toBe(0);
  await act(async () => {
    await state.inspectSource("game");
  });
  expect(state.inspectionReads.get("game")?.status).toBe("current");
});
it("rejects a mismatched profile report without inventing source identity", async () => {
  vi.spyOn(desktopApi, "inspectSource").mockResolvedValue({
    ...report("current/game.z64"),
    profile_id: "other",
  });
  await renderHealth();
  expect(state.inspectionReads.get("game")?.status).toBe("failed");
  expect(state.inspections.size).toBe(0);
});
it("settles a synchronous inspection throw as a safe failure", async () => {
  vi.spyOn(desktopApi, "inspectSource").mockImplementation(() => {
    throw new Error("private debug input");
  });
  await renderHealth();
  expect(state.inspectionReads.get("game")?.status).toBe("failed");
  expect(state.inspectionReads.get("game")?.failure).toBeUndefined();
});

it("rejects an old failure even when the same registration is selected again", async () => {
  const old = deferred<SourceInspectionReport>();
  const inspect = vi
    .spyOn(desktopApi, "inspectSource")
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(report("first/game.z64"));
  await renderHealth([source("first/game.z64")]);
  await renderHealth([source("other/game.z64")]);
  await renderHealth([source("first/game.z64")]);
  await act(async () => {
    old.reject({ code: "state" });
    await old.promise.catch(() => undefined);
  });
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(state.inspectionReads.get("game")?.status).toBe("current");
  expect(state.inspectionReads.get("game")?.code).toBeUndefined();
});

it.each(["failed", "cancelled"])(
  "clears prior verification success during a later %s attempt through the real operation handler",
  async (kind) => {
    const inspected = report("current/game.z64");
    vi.spyOn(desktopApi, "inspectSource").mockResolvedValue(inspected);
    const first: SourceVerificationOutcome[] = [
      { error: null, ok: true, profile_id: "game", result: null },
    ];
    const later = deferred<SourceVerificationOutcome[]>();
    const recovered: SourceVerificationOutcome[] = [
      { error: null, ok: false, profile_id: "game", result: null },
    ];
    vi.spyOn(desktopApi, "verifySources")
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(later.promise)
      .mockResolvedValueOnce(recovered);
    await act(async () => root.render(createElement(VerificationFixture)));
    await act(async () => state.verifyAll());
    expect(state.outcomes).toBe(first);

    let pending!: Promise<void>;
    await act(async () => {
      pending = state.verifyAll();
    });
    expect(state.outcomes).toEqual([]);
    expect(state.inspections.get("game")).toBe(inspected);
    const failure = {
      code: kind === "cancelled" ? "cancelled" : "state",
      message: "current failure",
    };
    await act(async () => {
      later.reject(failure);
      await pending;
    });
    expect(state.outcomes).toEqual([]);
    expect(operation.error).toBe(kind === "cancelled" ? undefined : failure);
    expect(state.inspections.get("game")).toBe(inspected);
    expect(state.inspectionReads.get("game")?.status).toBe("current");

    await act(async () => state.verifyAll());
    expect(state.outcomes).toBe(recovered);
    expect(operation.error).toBeUndefined();
  },
);
