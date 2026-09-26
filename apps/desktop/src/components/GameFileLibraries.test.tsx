// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type {
  GameFileRoot,
  GameFileScanSnapshot,
  OperationEvent,
  SourceImportPlan,
} from "../types";
import { GameFileLibraries } from "./GameFileLibraries";

const saved: GameFileRoot = {
  id: "root-1",
  path: "D:/Games",
  availability: "available",
  created_at: 1,
  updated_at: 1,
};
const snapshot: GameFileScanSnapshot = {
  format_version: 2,
  catalog_sha256: "a".repeat(64),
  completed_at: 1,
  freshness: "inputs_match",
  limits: null,
  roots: [saved],
  report: {
    searched_roots: [saved.path],
    searched_profiles: ["game"],
    candidates: [
      {
        profile_id: "game",
        path: "D:/Games/game.z64",
        sha256: "b".repeat(64),
        size: 64,
        storage_sha256: "b".repeat(64),
        storage_size: 64,
        updated_at: 1,
      },
    ],
    entries_examined: 2,
    files_hashed: 1,
    hash_bytes: 64,
    symlinks_skipped: 0,
    limits_reached: ["entries"],
    issues: [],
    issues_omitted: 0,
  },
};
let root: Root;
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(desktopApi, "gameFileRoots").mockResolvedValue([saved]);
  vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue(null);
  vi.spyOn(desktopApi, "scanGameFileRoots").mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "importSource");
  vi.spyOn(picker, "pickInstallFolder").mockResolvedValue("E:/More Games");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<GameFileLibraries ports={[]} profiles={[]} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("scans only after a player asks and keeps exact results as reviewed candidates", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    expect.objectContaining({ max_entries: 10_000, max_candidates: 64 }),
    expect.any(Function),
  );
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  expect(document.body.textContent).toContain("File and folder count");
  expect(document.body.textContent).toContain("Remove or relink saved folders");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("reviews a streamed match through a fresh core plan before the scan completes", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(snapshot);
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, callback) => {
    onEvent = callback;
    return new Promise<GameFileScanSnapshot>((resolve) => {
      finish = resolve;
    });
  });
  await act(async () => button("Scan saved folders").click());
  expect(onEvent).toBeDefined();
  await act(async () =>
    onEvent?.({
      schema_version: 3,
      operation_id: "scan-1",
      parent_operation_id: null,
      target: null,
      sequence: 0,
      timestamp_ms: 1,
      operation: "discover_sources",
      type: "started",
    }),
  );
  await act(async () =>
    onEvent?.({
      schema_version: 3,
      operation_id: "scan-1",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "discover_sources",
      type: "source_candidate",
      profile_id: "game",
      path: "D:/Games/game.z64",
      sha256: "b".repeat(64),
      size: 64,
    }),
  );
  expect(document.body.textContent).toContain("Matches found so far");
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  const plan: SourceImportPlan = {
    schema_version: 1,
    profile_id: "game",
    mode: "use_current_location",
    source: snapshot.report.candidates[0],
    admission_mode: "exact_identity",
    destination: "D:/Games/game.z64",
    destination_exists: true,
    existing_registration: null,
    reuse_existing: false,
    required_bytes: 0,
    source_guard_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
  };
  const review = vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue(plan);
  await click("Review source now");
  expect(review).toHaveBeenCalledWith("game", "D:/Games/game.z64", "use_current_location");
  expect(document.body.querySelector('[aria-label="Source import review"]')).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Cancel review");
  expect(document.body.textContent).toContain("Scanning selected folders…");
  expect(button("Cancel scan")).toBeDefined();
  expect(button("Scan saved folders").disabled).toBe(true);
  expect(button("Relink").disabled).toBe(true);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await click("Cancel review");
  expect(document.activeElement).toBe(button("Review source now"));
  await act(async () => finish?.(snapshot));
  expect(document.body.textContent).not.toContain("Matches found so far");
  expect(document.activeElement).toBe(button("Review source"));
  expect(button("Review source").disabled).toBe(false);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("restores focus to a completed match when its live scan button disappears", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(snapshot);
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, callback) => {
    onEvent = callback;
    return new Promise<GameFileScanSnapshot>((resolve) => {
      finish = resolve;
    });
  });
  await click("Scan saved folders");
  await act(async () =>
    onEvent?.({
      schema_version: 3,
      operation_id: "scan-1",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "discover_sources",
      type: "source_candidate",
      profile_id: "game",
      path: "D:/Games/game.z64",
      sha256: "b".repeat(64),
      size: 64,
    }),
  );
  button("Review source now").focus();
  await act(async () => finish?.(snapshot));
  expect(document.activeElement).toBe(button("Review source"));
});

it("ignores delayed events from a completed scan while another scan runs", async () => {
  const callbacks: ((event: OperationEvent) => void)[] = [];
  const resolvers: ((value: GameFileScanSnapshot) => void)[] = [];
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, callback) => {
    if (callback) callbacks.push(callback);
    return new Promise<GameFileScanSnapshot>((resolve) => {
      resolvers.push(resolve);
    });
  });
  await act(async () => button("Scan saved folders").click());
  await act(async () => resolvers[0](snapshot));
  await act(async () => button("Scan saved folders").click());
  const late = {
    schema_version: 3,
    operation_id: "old-scan",
    parent_operation_id: null,
    target: null,
    sequence: 1,
    timestamp_ms: 1,
    operation: "discover_sources",
    type: "source_candidate",
    profile_id: "game",
    path: "D:/Games/stale.z64",
    sha256: "b".repeat(64),
    size: 64,
  } as const;
  await act(async () => callbacks[0](late));
  expect(document.body.querySelector('[aria-label="Matches found during scan"]')).toBeNull();
  await act(async () =>
    callbacks[1]({ ...late, operation_id: "new-scan", path: "D:/Games/new.z64" }),
  );
  expect(
    document.body.querySelector('[aria-label="Matches found during scan"]')?.textContent,
  ).toContain("new.z64");
  expect(
    document.body.querySelector('[aria-label="Matches found during scan"]')?.textContent,
  ).not.toContain("stale.z64");
  await act(async () => resolvers[1](snapshot));
});

it("keeps a streamed match unregistered when fresh planning rejects changed bytes", async () => {
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, callback) => {
    onEvent = callback;
    return new Promise<GameFileScanSnapshot>((resolve) => {
      finish = resolve;
    });
  });
  vi.spyOn(desktopApi, "planSourceImport").mockRejectedValue(
    new Error("Source changed during scan"),
  );
  await click("Scan saved folders");
  await act(async () =>
    onEvent?.({
      schema_version: 3,
      operation_id: "scan-1",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "discover_sources",
      type: "source_candidate",
      profile_id: "game",
      path: "D:/Games/game.z64",
      sha256: "b".repeat(64),
      size: 64,
    }),
  );
  await click("Review source now");
  expect(document.body.textContent).toContain("Source changed during scan");
  expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await act(async () => finish?.(snapshot));
});

it("preserves a saved root until removal is confirmed", async () => {
  const remove = vi.spyOn(desktopApi, "removeGameFileRoot").mockResolvedValue(true);
  await click("Remove");
  expect(remove).not.toHaveBeenCalled();
  await click("Keep folder");
  expect(remove).not.toHaveBeenCalled();
  await click("Remove");
  await click("Remove saved folder");
  expect(remove).toHaveBeenCalledWith(saved.id);
});

it("uses core root mutations for chosen folders and relinks the same root identity", async () => {
  const add = vi.spyOn(desktopApi, "addGameFileRoot").mockResolvedValue({
    ...saved,
    id: "root-2",
    path: "E:/More Games",
  });
  const relink = vi.spyOn(desktopApi, "relinkGameFileRoot").mockResolvedValue({
    ...saved,
    path: "E:/More Games",
  });
  await click("Add folder");
  expect(add).toHaveBeenCalledWith("E:/More Games");
  await click("Relink");
  expect(relink).toHaveBeenCalledWith(saved.id, "E:/More Games");
});

it("does not offer review from a snapshot whose inputs changed", async () => {
  vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue({
    ...snapshot,
    freshness: "inputs_changed",
  });
  await act(async () =>
    root.render(<GameFileLibraries key="other-library" ports={[]} profiles={[]} />),
  );
  expect(button("Review source").disabled).toBe(true);
  expect(document.body.textContent).toContain("Scan again before using these results");
});

it("caps saved roots at the core scan limit and explains the recovery", async () => {
  const add = vi.spyOn(desktopApi, "addGameFileRoot");
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValue(
    Array.from({ length: 8 }, (_, index) => ({
      ...saved,
      id: `root-${index}`,
      path: `D:/Games-${index}`,
    })),
  );
  await act(async () =>
    root.render(<GameFileLibraries key="eight-roots" ports={[]} profiles={[]} />),
  );
  expect(button("Add folder").disabled).toBe(true);
  expect(button("Scan saved folders").disabled).toBe(false);
  expect(document.body.textContent).toContain("at most eight saved folders");
  expect(add).not.toHaveBeenCalled();
});

it("rechecks availability when a previously unavailable root is scanned", async () => {
  vi.mocked(desktopApi.gameFileRoots)
    .mockResolvedValueOnce([{ ...saved, availability: "unavailable" }])
    .mockResolvedValue([saved]);
  await act(async () =>
    root.render(<GameFileLibraries key="reconnected-root" ports={[]} profiles={[]} />),
  );
  expect(button("Scan saved folders").disabled).toBe(false);
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Available");
});
