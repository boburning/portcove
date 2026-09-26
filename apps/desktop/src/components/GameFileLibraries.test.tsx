// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { GameFileRoot, GameFileScanSnapshot } from "../types";
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
