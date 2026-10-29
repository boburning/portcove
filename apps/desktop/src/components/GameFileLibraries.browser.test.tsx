import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import {
  GameFileScanProvider,
  useGameFileScan,
  useGameFileScanObserver,
} from "../features/game-file-discovery/use-game-file-scan";
import { useSetupSource } from "../features/app-shell/use-setup-source";
import { SetupReviewSelectionProvider } from "../features/game-file-discovery/setup-review-selection";
import * as picker from "../file-picker";
import {
  portDefinition,
  portStatus,
  preliminarySourceInspection,
  sourceProfile,
} from "../test-fixtures";
import type {
  GameFileRoot,
  GameFileScanSnapshot,
  OperationEvent,
  SourceImportPlan,
  SourceRecord,
} from "../types";
import { GameFileLibraries } from "./GameFileLibraries";

const saved: GameFileRoot = {
  id: "root-1",
  path: "D:/Games",
  availability: "available",
  created_at: 1,
  updated_at: 1,
};
function rootsWithAvailability(available: number, unavailable: number): GameFileRoot[] {
  return Array.from({ length: available + unavailable }, (_, index) => ({
    ...saved,
    id: `root-${index}`,
    path: `D:/Games-${index}`,
    availability: index < available ? "available" : "unavailable",
  }));
}
const savedCandidate: SourceRecord = {
  profile_id: "game",
  path: "D:/Games/game.z64",
  sha256: "b".repeat(64),
  size: 64,
  storage_sha256: "b".repeat(64),
  storage_size: 64,
  updated_at: 1,
};
const snapshot: GameFileScanSnapshot = {
  format_version: 3,
  catalog_sha256: "a".repeat(64),
  completed_at: 1,
  freshness: "inputs_match",
  limits: {
    max_entries: 10_000,
    max_depth: 6,
    max_file_bytes: 2 * 1024 * 1024 * 1024,
    max_hash_bytes: 16 * 1024 * 1024 * 1024,
    max_candidates: 64,
  },
  roots: [saved],
  report: {
    searched_roots: [saved.path],
    searched_profiles: ["game"],
    candidates: [savedCandidate],
    entries_examined: 2,
    files_hashed: 1,
    hash_bytes: 64,
    symlinks_skipped: 0,
    limits_reached: ["entries"],
    issues: [],
    issues_omitted: 0,
  },
};
function mockCompletedScan(roots: GameFileRoot[]) {
  const available = roots.filter((root) => root.availability === "available");
  const [firstAvailable] = available;
  if (!firstAvailable) throw new Error("Completed scan fixture requires an available root");
  const scanned: GameFileScanSnapshot = {
    ...snapshot,
    roots,
    report: {
      ...snapshot.report,
      searched_roots: available.map((root) => root.path),
      candidates: snapshot.report.candidates.map((candidate) => ({
        ...candidate,
        path: `${firstAvailable.path}/game.z64`,
      })),
    },
  };
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation(async () => {
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(scanned);
    return scanned;
  });
}
let root: RenderResult;
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
  vi.spyOn(desktopApi, "gameFileRoots").mockResolvedValue([saved]);
  vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue(null);
  vi.spyOn(desktopApi, "scanGameFileRoots").mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "importSource");
  vi.mocked(picker.pickGameFileFolder).mockResolvedValue("E:/More Games");
  const host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: document.body.appendChild(host) });
  await root.rerender(<GameFileLibraries generation={1} ports={[]} profiles={[]} />);
});
afterEach(async () => {
  await cleanup();
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
    1,
    expect.any(Function),
  );
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  expect(document.body.textContent).toContain("File and folder count");
  expect(document.body.textContent).toContain("Remove or update saved folders");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

function resumableSnapshot(): GameFileScanSnapshot {
  return {
    ...snapshot,
    coverage: {
      batch_entries_examined: 1,
      batches: 2,
      can_resume: true,
      entries_relisted: 1,
      frontier_exhausted: false,
      metadata_checks: 2,
      pending_directories: 1,
      prior_member_rechecks: 1,
      remaining_entries: null,
      restart_required: false,
    },
  };
}

it("continues Core's saved frontier without discarding matches or changing scan budgets", async () => {
  const continued = resumableSnapshot();
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(continued);
  await click("Refresh folders");
  expect(document.body.textContent).toContain("These totals cover 2 scan batches.");
  expect(document.body.textContent).toContain("The number of remaining entries is unknown.");
  expect(document.body.textContent).toContain("Earlier matches were kept.");
  expect(document.body.textContent).not.toContain("Remove or update saved folders");
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  await click("Continue scan");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    snapshot.limits,
    1,
    expect.any(Function),
  );
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("connects a registered preliminary selection to truthful port guidance and bounded setup review", async () => {
  const record = { ...savedCandidate, path: "D:/Games/selected.iso" };
  const inspection = preliminarySourceInspection(record);
  const observed = {
    ...snapshot,
    report: { ...snapshot.report, candidates: [], preliminary_selections: [inspection] },
  };
  const port = {
    ...portDefinition(),
    id: "preliminary-port",
    name: "Preliminary port",
    source_profile: record.profile_id,
  };
  const status = {
    ...portStatus(),
    port_id: port.id,
    port_actions: [
      {
        action: "install" as const,
        availability: "allowed" as const,
        reason: "available" as const,
      },
    ],
  };
  const open = vi.fn();
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(observed);
  const render = (records = [record]) =>
    root.rerender(
      <SetupReviewSelectionProvider>
        <GameFileLibraries
          generation={1}
          ports={[port]}
          profiles={[
            {
              ...sourceProfile(),
              id: record.profile_id,
              label: "Selected disc",
              kind: "upstream-validated-disc",
              accepted_extensions: ["iso"],
            },
          ]}
          registeredSources={records}
          statuses={new Map([[port.id, status]])}
          onOpenPort={open}
        />
      </SetupReviewSelectionProvider>,
    );
  await render();
  await click("Refresh folders");
  expect(document.body.textContent).toContain("Found no exact matches");
  expect(document.body.textContent).toContain("Validation has not run");
  expect(document.body.textContent).toContain("Catalog ports using this profile: Preliminary port");
  expect(document.body.textContent).toContain("Preliminary port: Ready for setup review");
  expect(document.querySelectorAll("[data-setup-review-port]")).toHaveLength(1);
  await act(async () =>
    document.querySelector<HTMLInputElement>("[data-setup-review-port]")!.click(),
  );
  await click("Review Preliminary port setup");
  expect(open).toHaveBeenCalledWith(port.id, "game-file-libraries-setup");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await render([]);
  expect(button("Review Preliminary port setup").disabled).toBe(true);
  expect(button("Review preliminary selection").disabled).toBe(false);
});

it("returns preliminary review cancellation to its opener or the heading when that control is unavailable", async () => {
  const record = { ...savedCandidate, path: "D:/Games/selected.iso" };
  const inspection = preliminarySourceInspection(record);
  const observed = {
    ...snapshot,
    report: { ...snapshot.report, candidates: [], preliminary_selections: [inspection] },
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(observed);
  const plan: SourceImportPlan = {
    schema_version: 1,
    profile_id: record.profile_id,
    mode: "use_current_location",
    source: record,
    admission_mode: "structural_checks",
    destination: record.path,
    destination_exists: false,
    existing_registration: null,
    reuse_existing: false,
    required_bytes: 0,
    source_guard_sha256: "c".repeat(64),
    plan_sha256: "d".repeat(64),
  };
  vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue(plan);
  const profile = {
    ...sourceProfile(),
    id: record.profile_id,
    label: "Selected disc",
    kind: "upstream-validated-disc" as const,
    accepted_extensions: ["iso"],
  };
  const render = (profiles = [profile]) =>
    root.rerender(<GameFileLibraries generation={1} ports={[]} profiles={profiles} />);
  await render();
  await click("Refresh folders");
  await click("Review preliminary selection");
  expect(document.activeElement).toBe(button("Cancel review"));
  expect(document.body.textContent).toContain("Structural checks");
  await click("Cancel review");
  expect(document.activeElement).toBe(button("Review preliminary selection"));
  await click("Review preliminary selection");
  await render([]);
  await click("Cancel review");
  expect(button("Review preliminary selection").disabled).toBe(true);
  expect(document.activeElement).toBe(document.getElementById("game-file-libraries-heading"));
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it.each(["inputs_match", "inputs_changed"] as const)(
  "suspends preliminary queued review during an active batch and respects completed freshness: %s",
  async (freshness) => {
    const record = { ...savedCandidate, path: "D:/Games/selected.iso" };
    const inspection = preliminarySourceInspection(record);
    const observed = {
      ...resumableSnapshot(),
      report: { ...snapshot.report, candidates: [], preliminary_selections: [inspection] },
    };
    const port = {
      ...portDefinition(),
      id: "preliminary-port",
      name: "Preliminary port",
      source_profile: record.profile_id,
    };
    const status = {
      ...portStatus(),
      port_id: port.id,
      port_actions: [
        {
          action: "install" as const,
          availability: "allowed" as const,
          reason: "available" as const,
        },
      ],
    };
    const open = vi.fn();
    let finish: ((result: GameFileScanSnapshot) => void) | undefined;
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(observed);
    vi.mocked(desktopApi.scanGameFileRoots).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await root.rerender(
      <SetupReviewSelectionProvider>
        <GameFileLibraries
          generation={1}
          ports={[port]}
          profiles={[]}
          registeredSources={[record]}
          statuses={new Map([[port.id, status]])}
          onOpenPort={open}
        />
      </SetupReviewSelectionProvider>,
    );
    await click("Refresh folders");
    await act(async () =>
      document.querySelector<HTMLInputElement>("[data-setup-review-port]")!.click(),
    );
    await click("Continue scan");
    expect(document.body.textContent).toContain("Scanning selected folders…");
    expect(document.querySelectorAll("[data-setup-review-port]")).toHaveLength(0);
    expect(button("Review Preliminary port setup").disabled).toBe(true);
    const completed = { ...observed, freshness };
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(completed);
    await act(async () => finish?.(completed));
    expect(document.body.textContent).not.toContain("Scanning selected folders…");
    expect(button("Review Preliminary port setup").disabled).toBe(freshness !== "inputs_match");
    expect(desktopApi.importSource).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);

it.each(["continued", "fresh", "stale", "restart"] as const)(
  "keeps earlier setup reviews available only during a confirmed continuation: %s",
  async (mode) => {
    const prior = resumableSnapshot();
    const source = savedCandidate;
    const open = vi.fn();
    const port = { ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" };
    const status = {
      ...portStatus(),
      port_id: port.id,
      port_actions: [
        {
          action: "install" as const,
          availability: "allowed" as const,
          reason: "available" as const,
        },
      ],
    };
    let finish: ((result: GameFileScanSnapshot) => void) | undefined;
    let emit: ((event: OperationEvent) => void) | undefined;
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(prior);
    vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
      emit = callback;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    await root.rerender(
      <SetupReviewSelectionProvider>
        <GameFileLibraries
          generation={1}
          ports={[port]}
          profiles={[]}
          registeredSources={[source]}
          statuses={new Map([[port.id, status]])}
          onOpenPort={open}
        />
      </SetupReviewSelectionProvider>,
    );
    await act(async () =>
      document.querySelector<HTMLInputElement>("[data-setup-review-port]")!.click(),
    );
    expect(button("Review Game A setup").disabled).toBe(false);
    // The start reads current Core state again; the displayed old view cannot authorize reuse.
    const current = structuredClone(prior);
    if (mode === "fresh") current.coverage!.can_resume = false;
    if (mode === "stale") current.freshness = "inputs_changed";
    if (mode === "restart") current.coverage!.restart_required = true;
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(current);
    await click("Continue scan");
    expect(document.body.textContent).toContain("Scanning selected folders…");
    expect(button("Review Game A setup").disabled).toBe(mode !== "continued");
    expect(desktopApi.scanGameFileRoots).toHaveBeenCalledTimes(1);
    expect(desktopApi.importSource).not.toHaveBeenCalled();
    const priorCandidateCount = document.querySelectorAll("[data-live-candidate]").length;
    if (mode === "continued") {
      await click("Review Game A setup");
      // New observations join the carried matches without duplicating a prior observation.
      await act(async () =>
        emit?.({
          schema_version: 3,
          type: "source_candidate",
          operation_id: "continued-scan",
          parent_operation_id: null,
          target: null,
          sequence: 1,
          timestamp_ms: 1,
          operation: "discover_sources",
          ...source,
        }),
      );
      await act(async () =>
        emit?.({
          schema_version: 3,
          type: "source_candidate",
          operation_id: "continued-scan",
          parent_operation_id: null,
          target: null,
          sequence: 2,
          timestamp_ms: 2,
          operation: "discover_sources",
          ...source,
          profile_id: "other-game",
          path: "D:/Games/other.z64",
          sha256: "c".repeat(64),
        }),
      );
    }
    expect(open.mock.calls).toEqual(
      mode === "continued" ? [[port.id, "game-file-libraries-setup"]] : [],
    );
    expect(document.querySelectorAll("[data-live-candidate]")).toHaveLength(
      mode === "continued" ? 2 : priorCandidateCount,
    );
    expect(button("Review Game A setup").disabled).toBe(mode !== "continued");
    await act(async () => finish?.(current));
    expect(document.body.textContent).not.toContain("Scanning selected folders…");
  },
);

it("preserves a CLI-created bounded scan budget when continuing through Desktop", async () => {
  const continued = resumableSnapshot();
  continued.limits = { ...snapshot.limits!, max_entries: 2 };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(continued);
  await click("Refresh folders");
  await click("Continue scan");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    continued.limits,
    1,
    expect.any(Function),
  );
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("refuses continuation that would widen Desktop's scan resource caps", async () => {
  const continued = resumableSnapshot();
  continued.limits = { ...snapshot.limits!, max_entries: 100_000 };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(continued);
  await click("Refresh folders");
  await click("Continue scan");
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("exceeds Desktop's scan budgets");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("keeps Core's bounded fresh-scan recovery available when the prior snapshot cannot be read", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("Unreadable old report"));
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    snapshot.limits,
    1,
    expect.any(Function),
  );
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("keeps stale resumable results from advertising continuation", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...resumableSnapshot(),
    freshness: "inputs_changed",
  });
  await click("Refresh folders");
  expect(button("Scan saved folders")).toBeDefined();
  expect(document.body.textContent).not.toContain("Continue the scan to check another");
  expect(document.body.textContent).toContain("Scan again before using these results.");
});

it("presents a required restart separately from another resumable batch", async () => {
  const restarted = resumableSnapshot();
  restarted.freshness = "inputs_changed";
  restarted.coverage = { ...restarted.coverage!, can_resume: false, restart_required: true };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(restarted);
  await click("Refresh folders");
  expect(button("Start new scan")).toBeDefined();
  expect(document.body.textContent).toContain("The saved scan cannot continue.");
  await click("Start new scan");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledTimes(1);
});

it("keeps exhausted coverage distinct from skipped files and gameplay support", async () => {
  const exhausted = resumableSnapshot();
  exhausted.coverage = {
    ...exhausted.coverage!,
    can_resume: false,
    frontier_exhausted: true,
    remaining_entries: 0,
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(exhausted);
  await click("Refresh folders");
  expect(button("Scan saved folders")).toBeDefined();
  expect(document.body.textContent).toContain("Skipped files and search limits still apply.");
  expect(document.body.textContent).toContain(
    "does not assess every source format or establish gameplay support",
  );
});

it("marks matching registered candidates without claiming installation and keeps each port distinct", async () => {
  const source = savedCandidate;
  const onOpenPort = vi.fn();
  const ports = [
    { ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" },
    { ...portDefinition(), id: "game-b", name: "Game B", bios_source_profile: "game" },
  ];
  const statuses = new Map([
    [
      "game-a",
      {
        ...portStatus(),
        port_id: "game-a",
        port_actions: [
          {
            action: "install" as const,
            availability: "allowed" as const,
            reason: "available" as const,
          },
        ],
      },
    ],
    [
      "game-b",
      {
        ...portStatus(),
        port_id: "game-b",
        port_actions: [
          {
            action: "install" as const,
            availability: "waiting" as const,
            reason: "missing_source" as const,
          },
        ],
      },
    ],
  ]);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={ports}
      profiles={[]}
      registeredSources={[source]}
      statuses={statuses}
      onOpenPort={onOpenPort}
    />,
  );
  await click("Scan saved folders");
  expect(document.body.textContent).toContain("Already added");
  expect(document.body.textContent).toContain("Game A: Ready for setup review");
  expect(document.body.textContent).toContain("Game B: Needs game files");
  expect(document.body.textContent).not.toContain("Already installed");
  await click("View Game B details");
  expect(onOpenPort).toHaveBeenCalledWith("game-b", "game-file-libraries-setup");
  expect(button("View Game A details")).toBeDefined();
  expect(button("Review game files")).toBeDefined();

  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={ports}
      profiles={[]}
      registeredSources={[source]}
      statuses={statuses}
      workspaceRefreshFailed
      onOpenPort={onOpenPort}
    />,
  );
  expect(document.body.textContent).toContain("An earlier library view listed these game files");
  expect(document.body.textContent).not.toContain("Ready for setup review");
  expect(button("View Game A details").disabled).toBe(true);
  expect(button("Review game files").disabled).toBe(false);
  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={ports}
      profiles={[]}
      registeredSources={[source]}
      statuses={statuses}
      onOpenPort={onOpenPort}
    />,
  );

  const stale = { ...snapshot, freshness: "inputs_changed" as const };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stale);
  await click("Refresh folders");
  expect(button("View Game A details").disabled).toBe(true);
  expect(button("Review game files").disabled).toBe(true);
});

it("uses core action reasons and installation state for each registered match", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  const port = { ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" };
  const status = portStatus();
  const action = (reason: "missing_bios" | "unsupported_platform" | "definition_ineligible") => ({
    action: "install" as const,
    availability: "waiting" as const,
    reason,
  });
  const renderStatus = async (value: typeof status) =>
    root.rerender(
      <GameFileLibraries
        generation={1}
        ports={[port]}
        profiles={[]}
        registeredSources={snapshot.report.candidates}
        statuses={new Map([[port.id, value]])}
      />,
    );
  await renderStatus({ ...status, port_actions: [action("missing_bios")] });
  await click("Scan saved folders");
  expect(document.body.textContent).toContain("Game A: BIOS file needed");
  await renderStatus({ ...status, port_actions: [action("unsupported_platform")] });
  expect(document.body.textContent).toContain("Game A: Unavailable on this platform");
  await renderStatus({ ...status, port_actions: [action("definition_ineligible")] });
  expect(document.body.textContent).toContain("Game A: Setup on hold");
  await renderStatus({ ...status, active: { id: "installed" } as typeof status.active });
  expect(document.body.textContent).toContain("Game A: Already in your library");
});

it("holds a prior setup continuation when a later workspace refresh fails", async () => {
  const source = savedCandidate;
  const ports = [{ ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" }];
  const onOpenPort = vi.fn();
  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={ports}
      profiles={[]}
      registeredSources={[source]}
      setupSource={source}
      setSetupSource={() => {}}
      onOpenPort={onOpenPort}
    />,
  );
  expect(button("Open Game A details").disabled).toBe(false);
  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={ports}
      profiles={[]}
      registeredSources={[source]}
      workspaceRefreshFailed
      setupSource={source}
      setSetupSource={() => {}}
      onOpenPort={onOpenPort}
    />,
  );
  expect(button("Open Game A details").disabled).toBe(true);
  expect(document.body.textContent).toContain("Use Retry refresh before continuing");
  expect(onOpenPort).not.toHaveBeenCalled();
});

it("recognizes a registered source in streamed results but still reviews a different identity", async () => {
  const source = savedCandidate;
  let onEvent: ((event: OperationEvent) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
    onEvent = callback;
    return new Promise<GameFileScanSnapshot>(() => {});
  });
  const onOpenPort = vi.fn();
  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={[{ ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" }]}
      profiles={[]}
      registeredSources={[source]}
      statuses={
        new Map([
          [
            "game-a",
            {
              ...portStatus(),
              port_id: "game-a",
              port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
            },
          ],
        ])
      }
      onOpenPort={onOpenPort}
    />,
  );
  await act(async () => button("Scan saved folders").click());
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
      profile_id: source.profile_id,
      path: source.path,
      sha256: source.sha256,
      size: source.size,
    }),
  );
  expect(document.body.textContent).toContain("Already added");
  expect(document.body.textContent).toContain("Game A: Ready for setup review");
  await click("View Game A details");
  expect(onOpenPort).toHaveBeenCalledWith("game-a", "game-file-libraries-setup");
  await root.rerender(
    <GameFileLibraries
      generation={1}
      ports={[]}
      profiles={[]}
      registeredSources={[{ ...source, sha256: "c".repeat(64) }]}
    />,
  );
  expect(document.body.textContent).not.toContain("Already added");
  expect(document.body.textContent).not.toContain("Ready for setup review");
  expect(button("Review game files now")).toBeDefined();
});

it("keeps live catalog associations distinct through completion and stale readback", async () => {
  const ports = [
    { ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" },
    { ...portDefinition(), id: "game-b", name: "Game B", source_profile: "game" },
    {
      ...portDefinition(),
      id: "firmware-consumer",
      name: "Firmware consumer",
      source_profile: "other",
      bios_source_profile: "game",
    },
    { ...portDefinition(), id: "unrelated", name: "Unrelated", source_profile: "other" },
  ];
  const orphan = {
    ...savedCandidate,
    profile_id: "orphan",
    path: "D:/Games/orphan.bin",
  };
  const completed = {
    ...snapshot,
    report: { ...snapshot.report, candidates: [...snapshot.report.candidates, orphan] },
  };
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
    onEvent = callback;
    return new Promise<GameFileScanSnapshot>((resolve) => {
      finish = resolve;
    });
  });
  await root.rerender(<GameFileLibraries generation={1} ports={ports} profiles={[]} />);
  await click("Scan saved folders");
  for (const [index, candidate] of completed.report.candidates.entries()) {
    await act(async () =>
      onEvent?.({
        schema_version: 3,
        operation_id: "scan-1",
        parent_operation_id: null,
        target: null,
        sequence: index,
        timestamp_ms: 1,
        operation: "discover_sources",
        type: "source_candidate",
        profile_id: candidate.profile_id,
        path: candidate.path,
        sha256: candidate.sha256,
        size: candidate.size,
      }),
    );
  }
  const row = (kind: "live" | "completed", profile: string) => {
    const element = document.querySelector(
      `[data-${kind}-candidate][data-profile-id="${profile}"]`,
    );
    expect(element).not.toBeNull();
    return element!;
  };
  expect(row("live", "game").textContent).toContain(
    "Catalog ports using this profile: Game A, Game B, Firmware consumer",
  );
  expect(row("live", "game").textContent).not.toContain("Unrelated");
  expect(row("live", "orphan").textContent).toContain(
    "No catalog port currently uses this profile",
  );
  expect(document.body.textContent).not.toContain("Ready for setup review");
  expect(document.body.textContent).not.toContain("Already added");
  expect(desktopApi.importSource).not.toHaveBeenCalled();

  const currentPorts = ports.filter((port) => port.id !== "game-a");
  await root.rerender(<GameFileLibraries generation={1} ports={currentPorts} profiles={[]} />);
  expect(row("live", "game").textContent).toContain(
    "Catalog ports using this profile: Game B, Firmware consumer",
  );
  expect(row("live", "game").textContent).not.toContain("Game A");
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(completed);
  await act(async () => finish?.(completed));
  expect(document.querySelector("[data-live-candidate]")).toBeNull();
  expect(row("completed", "game").textContent).toContain(
    "Catalog ports using this profile: Game B, Firmware consumer",
  );
  expect(row("completed", "orphan").textContent).toContain(
    "No catalog port currently uses this profile",
  );
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...completed,
    freshness: "inputs_changed",
  });
  await click("Refresh folders");
  expect(row("completed", "game").querySelector("button")?.disabled).toBe(true);
  expect(row("completed", "orphan").querySelector("button")?.disabled).toBe(true);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("reviews a streamed match through a fresh core plan before the scan completes", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(snapshot);
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
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
    source: savedCandidate,
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
  await click("Review game files now");
  expect(review).toHaveBeenCalledWith("game", "D:/Games/game.z64", "use_current_location");
  expect(document.body.querySelector('[aria-label="Source import review"]')).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Cancel review");
  expect(document.body.textContent).toContain("Scanning selected folders…");
  expect(button("Cancel scan")).toBeDefined();
  expect(button("Scan saved folders").disabled).toBe(true);
  expect(button("Relink").disabled).toBe(true);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await click("Cancel review");
  expect(document.activeElement).toBe(button("Review game files now"));
  await act(async () => finish?.(snapshot));
  expect(document.body.textContent).not.toContain("Matches found so far");
  expect(document.activeElement).toBe(button("Review game files"));
  expect(button("Review game files").disabled).toBe(false);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("restores focus to a completed match when its live scan button disappears", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot)
    .mockResolvedValueOnce(null)
    .mockResolvedValue(snapshot);
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
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
  button("Review game files now").focus();
  await act(async () => finish?.(snapshot));
  expect(document.activeElement).toBe(button("Review game files"));
});

it("ignores delayed events from a completed scan while another scan runs", async () => {
  const callbacks: ((event: OperationEvent) => void)[] = [];
  const resolvers: ((value: GameFileScanSnapshot) => void)[] = [];
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
    if (callback) callbacks.push(callback);
    return new Promise<GameFileScanSnapshot>((resolve) => {
      resolvers.push(resolve);
    });
  });
  await act(async () => button("Scan saved folders").click());
  await act(async () => fixtureValue(resolvers[0], "resolvers[0]")(snapshot));
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
  await act(async () => fixtureValue(callbacks[0], "callbacks[0]")(late));
  expect(document.body.querySelector('[aria-label="Matches found during scan"]')).toBeNull();
  await act(async () =>
    fixtureValue(
      callbacks[1],
      "callbacks[1]",
    )({ ...late, operation_id: "new-scan", path: "D:/Games/new.z64" }),
  );
  expect(
    document.body.querySelector('[aria-label="Matches found during scan"]')?.textContent,
  ).toContain("new.z64");
  expect(
    document.body.querySelector('[aria-label="Matches found during scan"]')?.textContent,
  ).not.toContain("stale.z64");
  await act(async () => fixtureValue(resolvers[1], "resolvers[1]")(snapshot));
});

it("keeps a streamed match unregistered when fresh planning rejects changed bytes", async () => {
  let onEvent: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
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
  await click("Review game files now");
  expect(document.body.textContent).toContain("Source changed during scan");
  expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await act(async () => finish?.(snapshot));
});

it("reports a cancelled source check without describing the saved scan as cancelled", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  vi.spyOn(desktopApi, "planSourceImport").mockRejectedValue({ code: "cancelled" });
  await click("Scan saved folders");
  await click("Review game files");
  expect(document.body.textContent).toContain("Game-file check cancelled. No location was saved.");
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  expect(document.body.textContent).not.toContain("Scan cancelled");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("reports cancelled source addition while keeping its review and completed scan", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  await click("Scan saved folders");
  const source = savedCandidate;
  vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue({
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
    source_guard_sha256: source.sha256,
    plan_sha256: "c".repeat(64),
  });
  await click("Review game files");
  const renderedReview = document.body.querySelector('[aria-label="Source import review"]');
  expect(renderedReview?.textContent).toContain("Source check: Exact identity");
  expect(renderedReview?.textContent).toContain("Additional file data planned: 0 B");
  vi.mocked(desktopApi.importSource).mockRejectedValueOnce({ code: "cancelled" });
  await click("Use current location");
  expect(document.body.textContent).toContain(
    "Adding game files was cancelled. Refresh the workspace to confirm the current state.",
  );
  expect(document.body.querySelector('[aria-label="Source import review"]')).not.toBeNull();
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  expect(document.body.textContent).not.toContain("Scan cancelled");
});

it("retains a progressive scan across selected game details without starting another scan", async () => {
  const source = savedCandidate;
  let emit: ((event: OperationEvent) => void) | undefined;
  let finish: ((value: GameFileScanSnapshot) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
    emit = callback;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  function WorkspaceJourney() {
    const [details, setDetails] = useState(false);
    return details ? (
      <button onClick={() => setDetails(false)}>Back to settings</button>
    ) : (
      <GameFileLibraries
        generation={1}
        ports={[{ ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" }]}
        profiles={[]}
        registeredSources={[source]}
        onOpenPort={() => setDetails(true)}
      />
    );
  }
  await root.rerender(
    <GameFileScanProvider generation={1}>
      <WorkspaceJourney />
    </GameFileScanProvider>,
  );
  await click("Scan saved folders");
  await act(async () => {
    emit?.({
      schema_version: 3,
      type: "started",
      operation_id: "scan-owned",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "discover_sources",
    });
    emit?.({
      schema_version: 3,
      type: "source_candidate",
      operation_id: "scan-owned",
      parent_operation_id: null,
      target: null,
      sequence: 2,
      timestamp_ms: 2,
      operation: "discover_sources",
      ...source,
    });
  });
  await click("View Game A details");
  await click("Back to settings");
  expect(document.body.textContent).toContain("Scanning selected folders…");
  expect(button("Scan saved folders").disabled).toBe(true);
  expect(button("Cancel scan")).toBeDefined();
  expect(button("View Game A details")).toBeDefined();
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
  await act(async () => {
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
    finish?.(snapshot);
  });
  expect(document.body.textContent).not.toContain("Scanning selected folders…");
  expect(document.body.textContent).toContain(source.path);
  expect(button("Scan saved folders").disabled).toBe(false);
});

it("offers only affected catalog ports after explicit source registration", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  const source = savedCandidate;
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
        generation={1}
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
  await root.rerender(<SettingsAndDetails />);
  await click("Review game files");
  await click("Cancel review");
  expect(document.activeElement).toBe(button("Review game files"));
  await click("Review game files");
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

it("coalesces simultaneous scan requests before root validation finishes", async () => {
  let scan: ReturnType<typeof useGameFileScan> | undefined;
  let rootsReady: ((roots: GameFileRoot[]) => void) | undefined;
  function Owner() {
    scan = useGameFileScan(1);
    return null;
  }
  await root.rerender(<Owner />);
  const readRoots = vi.fn(
    () =>
      new Promise<GameFileRoot[]>((resolve) => {
        rootsReady = resolve;
      }),
  );
  let first: Promise<void> | undefined;
  await act(async () => {
    first = scan?.start(readRoots);
    await scan?.start(readRoots);
  });
  expect(readRoots).toHaveBeenCalledOnce();
  expect(scan?.scanning).toBe(true);
  await act(async () => {
    rootsReady?.([saved]);
    await first;
  });
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
  expect(scan?.scanning).toBe(false);
});

it("disposes scan observation with its workspace and ignores old events and completion", async () => {
  let scan: ReturnType<typeof useGameFileScan> | undefined;
  const callbacks: ((event: OperationEvent) => void)[] = [];
  const finishes: ((value: GameFileScanSnapshot) => void)[] = [];
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
    callbacks.push(callback!);
    return new Promise((resolve) => finishes.push(resolve));
  });
  function Owner() {
    scan = useGameFileScanObserver(1);
    return null;
  }
  await root.rerender(
    <GameFileScanProvider generation={1} key="old-library">
      <Owner />
    </GameFileScanProvider>,
  );
  await act(async () => {
    void scan?.start();
  });
  await root.rerender(
    <GameFileScanProvider generation={1} key="new-library">
      <Owner />
    </GameFileScanProvider>,
  );
  await act(async () => {
    void scan?.start();
  });
  const source = savedCandidate;
  await act(async () => {
    fixtureValue(
      callbacks[0],
      "callbacks[0]",
    )({
      schema_version: 3,
      type: "source_candidate",
      operation_id: "old",
      parent_operation_id: null,
      target: null,
      sequence: 2,
      timestamp_ms: 2,
      operation: "discover_sources",
      ...source,
    });
    fixtureValue(finishes[0], "finishes[0]")(snapshot);
  });
  expect(scan?.scanning).toBe(true);
  expect(scan?.candidates).toEqual([]);
  expect(scan?.completion).toBe(0);
  await act(async () => {
    fixtureValue(
      callbacks[1],
      "callbacks[1]",
    )({
      schema_version: 3,
      type: "started",
      operation_id: "new",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "discover_sources",
    });
  });
  expect(scan?.operationId).toBe("new");
  await act(async () => fixtureValue(finishes[1], "finishes[1]")(snapshot));
  expect(scan?.completion).toBe(1);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("retains a scan failure that arrives while selected game details are open", async () => {
  const source = savedCandidate;
  let emit: ((event: OperationEvent) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
    emit = callback;
    return new Promise((_resolve, reject) => {
      fail = reject;
    });
  });
  function Journey() {
    const [details, setDetails] = useState(false);
    return details ? (
      <button onClick={() => setDetails(false)}>Back to settings</button>
    ) : (
      <GameFileLibraries
        generation={1}
        profiles={[]}
        registeredSources={[source]}
        ports={[{ ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" }]}
        onOpenPort={() => setDetails(true)}
      />
    );
  }
  await root.rerender(
    <GameFileScanProvider generation={1}>
      <Journey />
    </GameFileScanProvider>,
  );
  await click("Scan saved folders");
  await act(async () =>
    emit?.({
      schema_version: 3,
      type: "source_candidate",
      operation_id: "owned",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "discover_sources",
      ...source,
    }),
  );
  await click("View Game A details");
  await act(async () => fail?.(new Error("The selected drive disconnected")));
  await click("Back to settings");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "The selected drive disconnected",
  );
  expect(button("Scan saved folders").disabled).toBe(false);
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
});

it("keeps a committed source visible but holds setup until a failed refresh recovers", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  const source = savedCandidate;
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
        generation={1}
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
  await root.rerender(<Settings />);
  await click("Review game files");
  await click("Use current location");
  expect(desktopApi.importSource).toHaveBeenCalledOnce();
  expect(onAdded).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("The view couldn't refresh");
  expect(document.body.textContent).toContain("the files were already added");
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
  expect(remove).toHaveBeenCalledWith(saved.id, 1);
});

it.each([
  ["add", "roots"],
  ["add", "snapshot"],
  ["relink", "roots"],
  ["relink", "snapshot"],
  ["remove", "roots"],
  ["remove", "snapshot"],
] as const)("keeps a committed %s distinct from a failed %s read", async (action, read) => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  const onOpenPort = vi.fn();
  await root.rerender(
    <GameFileLibraries
      generation={1}
      key="loaded"
      ports={[{ ...portDefinition(), id: "game-a", name: "Game A", source_profile: "game" }]}
      profiles={[]}
      registeredSources={[savedCandidate]}
      onOpenPort={onOpenPort}
    />,
  );
  expect(button("Review game files").disabled).toBe(false);
  expect(button("View Game A details").disabled).toBe(false);
  const failRead = () => {
    if (read === "roots")
      vi.mocked(desktopApi.gameFileRoots).mockRejectedValue(new Error("folder read unavailable"));
    else
      vi.mocked(desktopApi.gameFileScanSnapshot).mockRejectedValue(
        new Error("scan read unavailable"),
      );
  };
  let mutation;
  let notice;
  if (action === "add") {
    mutation = vi.spyOn(desktopApi, "addGameFileRoot").mockImplementation(async () => {
      failRead();
      return { ...saved, id: "root-2", path: "E:/More Games" };
    });
    notice = "Folder saved.";
    await click("Add folder");
  } else if (action === "relink") {
    mutation = vi.spyOn(desktopApi, "relinkGameFileRoot").mockImplementation(async () => {
      failRead();
      return { ...saved, path: "E:/More Games" };
    });
    notice = "Saved folder location updated.";
    await click("Relink");
  } else {
    mutation = vi.spyOn(desktopApi, "removeGameFileRoot").mockImplementation(async () => {
      failRead();
      return true;
    });
    notice = "Saved folder removed. The game files were kept.";
    await click("Remove");
    await click("Remove saved folder");
  }
  expect(document.body.textContent).toContain(notice);
  expect(document.body.textContent).toContain("Use Refresh folders");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Saved roots and catalog match this snapshot");
  expect(document.body.textContent).toContain("D:/Games/game.z64");
  expect(button("Review game files").disabled).toBe(true);
  expect(button("View Game A details").disabled).toBe(true);
  await click("Refresh folders");
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(button("Review game files").disabled).toBe(true);
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValue([saved]);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...snapshot,
    freshness: "inputs_changed",
  });
  await click("Refresh folders");
  expect(document.body.textContent).toContain("Scan again before using these results");
  expect(button("Review game files").disabled).toBe(true);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  await click("Refresh folders");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).toContain("Saved roots and catalog match this snapshot");
  expect(button("Review game files").disabled).toBe(false);
  expect(button("View Game A details").disabled).toBe(false);
  expect(mutation).toHaveBeenCalledOnce();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  expect(onOpenPort).not.toHaveBeenCalled();
});

it("does not describe an already absent root as a new removal", async () => {
  vi.spyOn(desktopApi, "removeGameFileRoot").mockResolvedValue(false);
  await click("Remove");
  await click("Remove saved folder");
  expect(document.body.textContent).toContain("The folder was already absent from saved folders.");
  expect(document.body.textContent).not.toContain("Saved folder removed.");
});

it.each(["success", "failure"] as const)(
  "ignores superseded initial-read %s after root-change recovery",
  async (initialOutcome) => {
    let finishInitialRoots!: (roots: GameFileRoot[]) => void;
    let finishInitialSnapshot!: (value: GameFileScanSnapshot) => void;
    let failInitialSnapshot!: (error: Error) => void;
    vi.mocked(desktopApi.gameFileRoots).mockReturnValueOnce(
      new Promise((resolve) => {
        finishInitialRoots = resolve;
      }),
    );
    vi.mocked(desktopApi.gameFileScanSnapshot).mockReturnValueOnce(
      new Promise((resolve, reject) => {
        finishInitialSnapshot = resolve;
        failInitialSnapshot = reject;
      }),
    );
    await root.rerender(
      <GameFileLibraries generation={1} key="slow-start" ports={[]} profiles={[]} />,
    );
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
    await click("Refresh folders");
    const replacement = { ...saved, path: "E:/More Games" };
    const relink = vi.spyOn(desktopApi, "relinkGameFileRoot").mockImplementation(async () => {
      vi.mocked(desktopApi.gameFileRoots).mockRejectedValue(new Error("read unavailable"));
      return replacement;
    });
    await click("Relink");
    expect(button("Review game files").disabled).toBe(true);
    vi.mocked(desktopApi.gameFileRoots).mockResolvedValue([replacement]);
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
      ...snapshot,
      freshness: "inputs_changed",
    });
    await click("Refresh folders");
    await act(async () => {
      finishInitialRoots([{ ...saved, path: "D:/Old Folder" }]);
      if (initialOutcome === "success") finishInitialSnapshot(snapshot);
      else failInitialSnapshot(new Error("old initial read failed"));
    });
    expect(document.body.textContent).toContain(replacement.path);
    expect(document.body.textContent).not.toContain("D:/Old Folder");
    expect(document.body.textContent).not.toContain("Saved roots and catalog match this snapshot");
    expect(document.body.textContent).toContain("Scan again before using these results");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(button("Review game files").disabled).toBe(true);
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
    await click("Refresh folders");
    expect(button("Review game files").disabled).toBe(false);
    expect(relink).toHaveBeenCalledOnce();
  },
);

it.each(["failure", "cancellation"] as const)(
  "preserves a confirmed scan on a root mutation %s",
  async (outcome) => {
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
    await root.rerender(<GameFileLibraries generation={1} key="loaded" ports={[]} profiles={[]} />);
    vi.spyOn(desktopApi, "removeGameFileRoot").mockRejectedValue(
      outcome === "failure" ? new Error("removal refused") : { code: "cancelled" },
    );
    await click("Remove");
    await click("Remove saved folder");
    expect(document.body.textContent).toContain(
      outcome === "failure" ? "removal refused" : "Action cancelled.",
    );
    expect(document.body.textContent).not.toContain("Saved folder removed.");
    expect(document.body.textContent).toContain("Saved roots and catalog match this snapshot");
    expect(button("Review game files").disabled).toBe(false);
  },
);

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
  expect(add).toHaveBeenCalledWith("E:/More Games", 1);
  await click("Relink");
  expect(relink).toHaveBeenCalledWith(saved.id, "E:/More Games", 1);
});

it("does not offer review from a snapshot whose inputs changed", async () => {
  vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue({
    ...snapshot,
    freshness: "inputs_changed",
  });
  await root.rerender(
    <GameFileLibraries generation={1} key="other-library" ports={[]} profiles={[]} />,
  );
  expect(button("Review game files").disabled).toBe(true);
  expect(document.body.textContent).toContain("search rules changed");
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
  await root.rerender(
    <GameFileLibraries generation={1} key="eight-roots" ports={[]} profiles={[]} />,
  );
  expect(button("Add folder").disabled).toBe(true);
  expect(button("Scan saved folders").disabled).toBe(false);
  expect(document.body.textContent).toContain("at most eight available folders");
  expect(add).not.toHaveBeenCalled();
});

it("rechecks availability when a previously unavailable root is scanned", async () => {
  vi.mocked(desktopApi.gameFileRoots)
    .mockResolvedValueOnce([{ ...saved, availability: "unavailable" }])
    .mockResolvedValue([saved]);
  await root.rerender(
    <GameFileLibraries generation={1} key="reconnected-root" ports={[]} profiles={[]} />,
  );
  expect(button("Scan saved folders").disabled).toBe(false);
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Available");
});

it.each([
  [1, 8],
  [8, 1],
])(
  "scans %i available folders while keeping %i disconnected folders saved",
  async (available, unavailable) => {
    const roots = rootsWithAvailability(available, unavailable);
    vi.mocked(desktopApi.gameFileRoots).mockResolvedValue(roots);
    mockCompletedScan(roots);
    await root.rerender(
      <GameFileLibraries generation={1} key="mixed-roots" ports={[]} profiles={[]} />,
    );
    expect(button("Scan saved folders").disabled).toBe(false);
    expect(button("Add folder").disabled).toBe(available === 8);
    expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
    await click("Scan saved folders");
    expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
    expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
      snapshot.limits,
      1,
      expect.any(Function),
    );
    expect(document.body.textContent).toContain("Unavailable saved folders were not searched.");
    expect(document.body.textContent).toContain(
      fixtureValue(roots[available], "roots[available]").path,
    );
    expect(desktopApi.importSource).not.toHaveBeenCalled();
  },
);

it("allows another available folder without removing disconnected saved folders", async () => {
  const roots = rootsWithAvailability(7, 2);
  const added: GameFileRoot = { ...saved, id: "added-root", path: "E:/More Games" };
  vi.mocked(desktopApi.gameFileRoots)
    .mockResolvedValueOnce(roots)
    .mockResolvedValueOnce(roots)
    .mockResolvedValue([...roots, added]);
  const add = vi.spyOn(desktopApi, "addGameFileRoot").mockResolvedValue(added);
  const remove = vi.spyOn(desktopApi, "removeGameFileRoot");
  await root.rerender(
    <GameFileLibraries generation={1} key="add-mixed-roots" ports={[]} profiles={[]} />,
  );
  expect(button("Add folder").disabled).toBe(false);
  expect(add).not.toHaveBeenCalled();
  await click("Add folder");
  expect(add).toHaveBeenCalledOnce();
  expect(add).toHaveBeenCalledWith(added.path, 1);
  expect(remove).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(fixtureValue(roots[7], "roots[7]").path);
  expect(button("Add folder").disabled).toBe(true);
  expect(button("Scan saved folders").disabled).toBe(false);
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("rechecks available folders after choosing a folder before adding it", async () => {
  const initial = rootsWithAvailability(7, 2);
  const reconnected = rootsWithAvailability(8, 1);
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValueOnce(initial).mockResolvedValue(reconnected);
  const add = vi.spyOn(desktopApi, "addGameFileRoot");
  await root.rerender(
    <GameFileLibraries generation={1} key="reconnected-add" ports={[]} profiles={[]} />,
  );
  expect(button("Add folder").disabled).toBe(false);
  await click("Add folder");
  expect(picker.pickGameFileFolder).toHaveBeenCalledWith("");
  expect(add).not.toHaveBeenCalled();
  expect(button("Add folder").disabled).toBe(true);
  expect(document.body.textContent).toContain("at most eight available folders");
});

it("uses fresh availability when disconnected folders can now be scanned", async () => {
  const initial = rootsWithAvailability(0, 9);
  const reconnected = rootsWithAvailability(1, 8);
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValueOnce(initial).mockResolvedValue(reconnected);
  mockCompletedScan(reconnected);
  await root.rerender(
    <GameFileLibraries generation={1} key="reconnected-mixed-scan" ports={[]} profiles={[]} />,
  );
  expect(button("Scan saved folders").disabled).toBe(false);
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Unavailable saved folders were not searched.");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("blocks a scan when refreshed availability exceeds eight and keeps prior evidence stale", async () => {
  const initial = rootsWithAvailability(8, 1);
  const reconnected = rootsWithAvailability(9, 0);
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValueOnce(initial).mockResolvedValue(reconnected);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...snapshot,
    roots: initial,
    freshness: "inputs_changed",
  });
  await root.rerender(
    <GameFileLibraries generation={1} key="too-many-reconnected" ports={[]} profiles={[]} />,
  );
  expect(button("Scan saved folders").disabled).toBe(false);
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  expect(button("Scan saved folders").disabled).toBe(true);
  expect(document.body.textContent).toContain("at most eight available folders");
  expect(document.body.textContent).toContain(savedCandidate.path);
  expect(button("Review game files").disabled).toBe(true);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("explains that all nine saved folders are unavailable without starting a scan", async () => {
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValue(rootsWithAvailability(0, 9));
  await root.rerender(
    <GameFileLibraries generation={1} key="all-offline-roots" ports={[]} profiles={[]} />,
  );
  expect(button("Scan saved folders").disabled).toBe(false);
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("No saved folder is available");
  expect(document.body.textContent).toContain("D:/Games-8");
});

it("offers Core's hash-limited continuation without widening the allowance or authorizing setup", async () => {
  const continued = resumableSnapshot();
  continued.report = { ...continued.report, limits_reached: ["hash_bytes"] };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(continued);
  await click("Refresh folders");
  expect(document.body.textContent).toContain(
    "Continue the scan to check the next batch. Earlier matches were kept.",
  );
  expect(document.body.textContent).not.toContain("Remove or update saved folders");
  await click("Continue scan");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    snapshot.limits,
    1,
    expect.any(Function),
  );
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

vi.mock("../file-picker", { spy: true });

it.each(["picker", "preflight"] as const)(
  "discards an outgoing-library add after a delayed %s",
  async (wait) => {
    const add = vi.spyOn(desktopApi, "addGameFileRoot").mockResolvedValue(saved);
    let release!: () => void;
    if (wait === "picker") {
      vi.mocked(picker.pickGameFileFolder).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve("E:/Old intention");
          }),
      );
    } else {
      vi.mocked(desktopApi.gameFileRoots).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve([saved]);
          }),
      );
    }
    await click("Add folder");
    await root.rerender(
      <GameFileLibraries generation={2} key="replacement-library" ports={[]} profiles={[]} />,
    );
    await act(async () => release());
    expect(add).not.toHaveBeenCalled();
    expect(desktopApi.gameFileRoots).toHaveBeenCalledWith(2);
  },
);

it("reaches Core's fresh scan when the previous payload is unreadable from mount onward", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockRejectedValue(
    new Error("malformed saved scan JSON"),
  );
  await root.rerender(
    <GameFileLibraries generation={1} key="corrupt-at-mount" ports={[]} profiles={[]} />,
  );
  expect(document.body.textContent).toContain(saved.path);
  expect(document.body.textContent).toContain("malformed saved scan JSON");
  expect(button("Scan saved folders").disabled).toBe(false);
  await click("Scan saved folders");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    snapshot.limits,
    1,
    expect.any(Function),
  );
  expect(document.body.textContent).not.toContain("Saved roots and catalog match this snapshot");
});

it("discards a relink picker after the originating library is replaced", async () => {
  const relink = vi.spyOn(desktopApi, "relinkGameFileRoot").mockResolvedValue(saved);
  let release!: (path: string) => void;
  vi.mocked(picker.pickGameFileFolder).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await click("Relink");
  await root.rerender(
    <GameFileLibraries generation={2} key="new-library" ports={[]} profiles={[]} />,
  );
  await act(async () => release("E:/Old relink"));
  expect(relink).not.toHaveBeenCalled();
});

it("keeps a roots-only add preflight from confirming an older observation after mutation failure", async () => {
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(snapshot);
  await click("Refresh folders");
  expect(button("Review game files").disabled).toBe(false);
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValue([{ ...saved, path: "E:/Changed root" }]);
  vi.spyOn(desktopApi, "addGameFileRoot").mockRejectedValue(new Error("save failed"));
  await click("Add folder");
  expect(document.body.textContent).toContain("save failed");
  expect(button("Review game files").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Saved roots and catalog match this snapshot");
});
