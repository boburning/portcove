// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { useSetupSource } from "../features/app-shell/use-setup-source";
import * as picker from "../file-picker";
import { portDefinition } from "../test-fixtures";
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

it("offers only affected catalog ports after explicit source registration", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  const source = snapshot.report.candidates[0];
  const plan: SourceImportPlan = {
    schema_version: 1,
    profile_id: "game",
    mode: "use_current_location",
    source,
    admission_mode: "exact_identity",
    destination: source.path,
    destination_exists: true,
    existing_registration: null,
    reuse_existing: false,
    required_bytes: 0,
    source_guard_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
  };
  vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue(plan);
  vi.mocked(desktopApi.importSource).mockResolvedValue({
    import_id: "import-1",
    profile_id: "game",
    mode: "use_current_location",
    outcome: "registered_current_location",
    registered: source,
    copied: false,
    original_deleted: false,
    original_retained: true,
    retained_original_path: source.path,
    recovered: false,
  });
  const onAdded = vi.fn().mockResolvedValue(undefined);
  const onOpenPort = vi.fn();
  const ports = [
    { ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" },
    { ...portDefinition(), id: "game-b", name: "Game B", bios_source_profile: "game" },
    { ...portDefinition(), id: "unrelated", name: "Unrelated", source_profile: "different" },
  ];
  let removeRegisteredSource: (() => void) | undefined;
  function SettingsAndDetails() {
    const [registeredSources, setRegisteredSources] = useState([source]);
    const [setupSource, setSetupSource] = useSetupSource(registeredSources);
    const [selectedPort, setSelectedPort] = useState<string>();
    removeRegisteredSource = () => setRegisteredSources([]);
    return selectedPort ? (
      <button onClick={() => setSelectedPort(undefined)}>Back to settings</button>
    ) : (
      <GameFileLibraries
        ports={ports}
        profiles={[]}
        registeredSources={registeredSources}
        onAdded={onAdded}
        onOpenPort={(portId, originKey) => {
          onOpenPort(portId, originKey);
          setSelectedPort(portId);
        }}
        setupSource={setupSource}
        setSetupSource={setSetupSource}
      />
    );
  }
  await act(async () => root.render(<SettingsAndDetails />));
  await click("Review source");
  expect(document.body.querySelector('[aria-label="Continue to a game"]')).toBeNull();
  await click("Use current location");
  expect(desktopApi.importSource).toHaveBeenCalledWith(
    "game",
    source.path,
    "use_current_location",
    plan.plan_sha256,
  );
  expect(onAdded).toHaveBeenCalledOnce();
  const handoff = document.body.querySelector('[aria-label="Continue to a game"]');
  expect(handoff?.textContent).toContain("Open Game A details");
  expect(handoff?.textContent).toContain("Open Game B details");
  expect(handoff?.textContent).not.toContain("Unrelated");
  expect(document.activeElement).toBe(button("Open Game A details"));
  await click("Open Game B details");
  expect(onOpenPort).toHaveBeenCalledWith("game-b", "game-file-libraries-setup");
  expect(document.body.querySelector('[aria-label="Continue to a game"]')).toBeNull();
  await click("Back to settings");
  expect(document.body.querySelector('[aria-label="Continue to a game"]')).not.toBeNull();
  expect(
    document.body.querySelector('[data-detail-origin="game-file-libraries-setup"]'),
  ).not.toBeNull();
  await act(async () => removeRegisteredSource?.());
  expect(document.body.querySelector('[aria-label="Continue to a game"]')).toBeNull();
});

it("keeps a committed source visible but holds setup until a failed refresh recovers", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  const source = snapshot.report.candidates[0];
  const plan: SourceImportPlan = {
    schema_version: 1,
    profile_id: "game",
    mode: "use_current_location",
    source,
    admission_mode: "exact_identity",
    destination: source.path,
    destination_exists: true,
    existing_registration: null,
    reuse_existing: false,
    required_bytes: 0,
    source_guard_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
  };
  vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue(plan);
  vi.mocked(desktopApi.importSource).mockResolvedValue({
    import_id: "import-1",
    profile_id: "game",
    mode: "use_current_location",
    outcome: "registered_current_location",
    registered: source,
    copied: false,
    original_deleted: false,
    original_retained: true,
    retained_original_path: source.path,
    recovered: false,
  });
  const onAdded = vi.fn().mockRejectedValue(new Error("refresh failed after import"));
  const onOpenPort = vi.fn();
  function Settings() {
    const [registeredSources] = useState([source]);
    const [setupSource, setSetupSource] = useSetupSource(registeredSources);
    return (
      <GameFileLibraries
        ports={[{ ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" }]}
        profiles={[]}
        registeredSources={registeredSources}
        onAdded={onAdded}
        onOpenPort={onOpenPort}
        setupSource={setupSource}
        setSetupSource={setSetupSource}
      />
    );
  }
  await act(async () => root.render(<Settings />));
  await click("Review source");
  await click("Use current location");
  expect(desktopApi.importSource).toHaveBeenCalledOnce();
  expect(onAdded).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("The view could not refresh");
  expect(document.body.textContent).toContain("this source was already added");
  expect(document.body.textContent).toContain("before continuing to a game");
  expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
  expect(button("Open Game A details").disabled).toBe(true);
  expect(onOpenPort).not.toHaveBeenCalled();
  onAdded.mockResolvedValueOnce(undefined);
  await click("Retry refresh");
  expect(onAdded).toHaveBeenCalledTimes(2);
  expect(button("Open Game A details").disabled).toBe(false);
  await click("Open Game A details");
  expect(onOpenPort).toHaveBeenCalledWith("game-a", "game-file-libraries-setup");
  expect(desktopApi.importSource).toHaveBeenCalledOnce();
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
