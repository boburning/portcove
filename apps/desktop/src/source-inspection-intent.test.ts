// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "./api";
import type { SourceInspectionReport, SourceRecord } from "./types";
import { useSourceHealth, type Perform } from "./use-portcove";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const perform: Perform = async (_name, task) => task();
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
});
