import { controlledAct as act } from "../../test/controlled-react-act";
import { captureParityState } from "../../test/parity-capture";
import { prepareCaptureTarget } from "../../test/capture-target";
import { observeVisibleTarget } from "../../scripts/browser-readiness.mts";
import { cleanup, render, type RenderResult } from "vitest-browser-react";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { desktopApi } from "../api";
import { SetupReviewSelectionProvider } from "../features/game-file-discovery/setup-review-selection";
import { gameFileScanLimits } from "../features/game-file-discovery/use-game-file-scan";
import { WorkspaceRefreshNotice } from "../features/workspace/WorkspaceRefreshNotice";
import {
  fixtureValue,
  installedLaunchStatus,
  portDefinition,
  portStatus,
  sourceProfile,
} from "../test-fixtures";
import { AddGames } from "./AddGames";
import type {
  GameFileScanSnapshot,
  InstallPlan,
  InstallBatchReview,
  PortIntentAssessments,
  InstallBatchRecord,
  PortStatus,
  SourceRecord,
} from "../types";
import { SettingsView } from "./Chrome";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const sources: SourceRecord[] = ["first", "second"].map((id, index) => ({
  profile_id: id,
  path: "D:/Originals/" + id + ".z64",
  sha256: String(index + 1).repeat(64),
  size: 64,
  storage_sha256: String(index + 1).repeat(64),
  storage_size: 64,
  updated_at: 1,
}));
const ports = sources.map((source, index) => ({
  ...portDefinition(),
  id: source.profile_id,
  name: index === 0 ? "First game" : "Second game",
  source_profile: source.profile_id,
}));
const profiles = sources.map((source) => ({ ...sourceProfile(), id: source.profile_id }));
const statuses = ports.map<PortStatus>((port) => ({
  ...portStatus(),
  port_id: port.id,
  port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
}));
const saved = {
  id: "saved-originals",
  path: "D:/Originals",
  availability: "available" as const,
  created_at: 1,
  updated_at: 1,
};
const scan: GameFileScanSnapshot = {
  format_version: 3,
  catalog_sha256: "a".repeat(64),
  completed_at: 1,
  freshness: "inputs_match",
  limits: gameFileScanLimits,
  roots: [saved],
  report: {
    searched_roots: [saved.path],
    searched_profiles: sources.map((source) => source.profile_id),
    candidates: sources,
    entries_examined: 2,
    files_hashed: 2,
    hash_bytes: 128,
    symlinks_skipped: 0,
    limits_reached: [],
    issues: [],
    issues_omitted: 0,
  },
  matches: {
    scan_id: "00000000-0000-4000-8000-000000000001",
    exact_matches: 2,
    preliminary_selections: 0,
    preview_complete: true,
  },
};
function plan(portId: string): NonNullable<InstallBatchReview["items"][number]["plan"]> {
  return {
    plan_sha256: (portId === "first" ? "1" : "2").repeat(64),
    selected_install: null,
    plan: {
      port_id: portId,
      channel: "stable",
      platform: "windows-x86-64",
      action: "download",
      auxiliary_downloads: [],
      preservation_notices: [],
      shared_preferences: null,
      temporary_space: null,
      bundled_runtime: null,
      download_bytes: 64,
      source_requirements: [],
      release: {
        version: "1.0",
        channel: "stable",
        published_at: null,
        asset: {
          name: "owned.zip",
          url: "https://example.invalid/owned.zip",
          size: 64,
          sha256: "a".repeat(64),
        },
      },
      storage: {
        library_root: "D:/Library",
        volume_total_bytes: 1024 ** 3,
        volume_available_bytes: 1024 ** 3,
      },
      output_location: {
        port_id: portId,
        configured_output_directory: null,
        library_root: "D:/Library",
        default_output_directory: "D:/Library/versions/" + portId,
        effective_output_directory: "D:/Library/versions/" + portId,
        selection_source: "library_default",
        user_data_root: "D:/Library/user/" + portId,
      },
    } satisfies InstallPlan,
  };
}
const batch: InstallBatchRecord = {
  format_version: 1,
  id: "owned-batch",
  created_at: 1,
  updated_at: 1,
  cancel_requested: false,
  items: ports.map((port) => ({
    port_id: port.id,
    expected_plan_sha256: plan(port.id).plan_sha256,
    state: "queued",
  })),
};
const completed: InstallBatchRecord = {
  ...batch,
  items: [
    {
      ...fixtureValue(batch.items[0], "first batch item"),
      state: "ready",
      install_id: "first-install",
    },
    {
      ...fixtureValue(batch.items[1], "second batch item"),
      state: "failed",
      detail: "Owned download refused",
    },
  ],
};
const refreshed: PortStatus[] = [
  {
    ...fixtureValue(statuses[0], "first status"),
    active: {
      ...fixtureValue(installedLaunchStatus().active, "installed fixture"),
      id: "first-install",
      port_id: "first",
    },
    port_actions: [],
  },
  fixtureValue(statuses[1], "second status"),
];

/** Add games owns the batch and Settings displays the same refreshed file requirements. */
function BatchWorkspace({
  readWorkspace,
  generation,
}: {
  readWorkspace: () => Promise<PortStatus[]>;
  generation: number;
}) {
  const [current, setCurrent] = useState(statuses);
  const [failure, setFailure] = useState<{ error: unknown }>();
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [openedScan, setOpenedScan] = useState(false);
  const statusMap = new Map(current.map((status) => [status.port_id, status]));
  const refresh = async () => {
    setRefreshing(true);
    try {
      setCurrent(await readWorkspace());
      setFailure(undefined);
    } catch (error) {
      setFailure({ error });
      throw error;
    } finally {
      setRefreshing(false);
    }
  };
  const retry = async () => {
    try {
      await refresh();
    } catch {
      // Same ownership contract as the actual workspace coordinator.
    }
  };
  return (
    <SetupReviewSelectionProvider>
      <main className="workspace-main h-screen min-h-0 overflow-auto">
        <div data-workspace-refresh-observation>
          <WorkspaceRefreshNotice
            failure={failure}
            hasSnapshot
            refreshing={refreshing}
            retry={retry}
            retryRecovery={async () => undefined}
          />
        </div>
        <div hidden={scanning}>
          <SettingsView
            category="game-files"
            generation={generation}
            ports={ports}
            statuses={statusMap}
            sources={sources}
            sourceProfiles={profiles}
            sourceRequirementsState="available"
            installedCount={current.filter((status) => status.active).length}
            workspaceRefreshFailed={Boolean(failure)}
            onSourceAdded={refresh}
            onOpenPort={() => undefined}
            onOpenGameFileScan={() => {
              setOpenedScan(true);
              setScanning(true);
            }}
          />
        </div>
        {scanning && (
          <button type="button" onClick={() => setScanning(false)}>
            Back to Game files settings
          </button>
        )}
        <AddGames
          active={scanning}
          scanRequest={openedScan ? { sequence: 1 } : undefined}
          generation={generation}
          ports={ports}
          statuses={statusMap}
          sources={sources}
          profiles={profiles}
          refreshFailed={Boolean(failure)}
          perform={async (_, task) => task()}
          onAdded={refresh}
          onOpenPort={() => undefined}
          onBrowseCatalog={() => undefined}
          onCopyInstallation={() => undefined}
          setSetupSource={() => undefined}
        />
      </main>
    </SetupReviewSelectionProvider>
  );
}

function button(name: string) {
  return fixtureValue(
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (control) => control.textContent === name,
    ),
    "button " + name,
  );
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function confirmBatch() {
  await page.getByRole("button", { name: "View scan results", exact: true }).click();
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-setup-review-port]")).toHaveLength(2),
  );
  await click("Select all 2 eligible");
  await click("Review installing 2 selected");
  await vi.waitFor(() => expect(button("Add 2 to Library and install 2").disabled).toBe(false));
  await click("Add 2 to Library and install 2");
}
async function captureResults(name: string) {
  const target = '[aria-label="Install selected games"]';
  await prepareCaptureTarget({
    target,
    label: name,
    scroll: () =>
      fixtureValue(document.querySelector(target), "batch results").scrollIntoView({
        block: "center",
        behavior: "instant",
      }),
    observe: () => observeVisibleTarget(target, "visual"),
  });
  await captureParityState(name);
}
let view: RenderResult;
let previousViewport: { width: number; height: number };
let previousTheme: string | undefined;
beforeEach(async () => {
  previousViewport = { width: innerWidth, height: innerHeight };
  previousTheme = document.documentElement.dataset.theme;
  vi.spyOn(desktopApi, "gameFileRoots").mockResolvedValue([saved]);
  vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue(scan);
  vi.spyOn(desktopApi, "gameFileScanRegisteredMatches").mockResolvedValue({
    candidates: sources,
    preliminary_selections: [],
  });
  vi.spyOn(desktopApi, "rootSetupConsents").mockResolvedValue([]);
  vi.spyOn(desktopApi, "gameFileRootMatchProfiles").mockResolvedValue([]);
  vi.spyOn(desktopApi, "readyNoticesEnabled").mockResolvedValue(true);
  vi.spyOn(desktopApi, "assessPortIntents").mockResolvedValue({
    assessments: [],
    not_assessed: 0,
    ready_notices_enabled: true,
  } satisfies PortIntentAssessments);
  vi.spyOn(desktopApi, "datReferences").mockResolvedValue([]);
  vi.spyOn(desktopApi, "unfinishedInstallBatches").mockResolvedValue([]);
  vi.spyOn(desktopApi, "planInstallBatch").mockResolvedValue({
    items: ports.map((port) => ({ port_id: port.id, plan: plan(port.id) })),
    capacity: { download_bytes: 128, volumes: [] },
  });
  vi.spyOn(desktopApi, "startInstallBatch").mockResolvedValue(batch);
  vi.spyOn(desktopApi, "runInstallBatch");
  vi.spyOn(desktopApi, "addGamesToLibrary");
  view = await render(null);
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  if (previousTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = previousTheme;
  await page.viewport(previousViewport.width, previousViewport.height);
});

it.for([
  [960, 640, "light"],
  [430, 780, "dark"],
] as const)(
  "refreshes committed mixed outcomes before Done while keeping results and focus at %sx%s %s",
  async ([width, height, theme]) => {
    await page.viewport(width, height);
    document.documentElement.dataset.theme = theme;
    const running = deferred<InstallBatchRecord>();
    const reading = deferred<PortStatus[]>();
    vi.mocked(desktopApi.runInstallBatch).mockReturnValue(running.promise);
    const read = vi.fn(() => reading.promise);
    try {
      await view.rerender(<BatchWorkspace generation={1} readWorkspace={read} />);
      await confirmBatch();
      expect(read).not.toHaveBeenCalled();
      await act(async () => running.resolve(completed));
      await vi.waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith());
      const done = button("Done");
      done.focus();
      expect(document.body.textContent).toContain("First game: Installed");
      expect(document.body.textContent).toContain(
        "Second game: Couldn't install. Owned download refused",
      );
      // The held read cannot create optimistic installed state.
      expect(document.body.textContent).toContain("No ports in your library yet");
      await act(async () => reading.resolve(refreshed));
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("No ports in your library yet"),
      );
      expect(document.body.textContent).toContain(
        "No missing original game files are currently listed",
      );
      expect(document.body.textContent).toContain("Already in your library");
      expect(button("Done")).toBe(done);
      expect(document.activeElement).toBe(done);
      expect(desktopApi.startInstallBatch).toHaveBeenCalledTimes(1);
      expect(desktopApi.runInstallBatch).toHaveBeenCalledExactlyOnceWith(
        "owned-batch",
        1,
        expect.any(Function),
      );
      await captureResults("batch-parent-refreshed-mixed-results");
      await click("Done");
      await vi.waitFor(() =>
        expect(document.querySelector('[aria-label="Install selected games"]')).toBeNull(),
      );
      await expect
        .element(
          page
            .getByRole("region", { name: "Add games workspace" })
            .getByRole("heading", { name: "Folders Portcove scans" }),
        )
        .toHaveFocus();
      await click("Back to Game files settings");
      await expect
        .element(
          page.getByText("No missing original game files are currently listed", { exact: false }),
        )
        .toBeVisible();
      expect(read).toHaveBeenCalledTimes(1);
      expect(desktopApi.addGamesToLibrary).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        running.resolve(completed);
        reading.resolve(refreshed);
      });
    }
  },
);

it("keeps committed results and workspace retry feedback when the parent refresh fails", async () => {
  const reading = deferred<PortStatus[]>();
  vi.mocked(desktopApi.runInstallBatch).mockResolvedValue(completed);
  const read = vi
    .fn<() => Promise<PortStatus[]>>()
    .mockReturnValueOnce(reading.promise)
    .mockResolvedValue(refreshed);
  try {
    await view.rerender(<BatchWorkspace generation={1} readWorkspace={read} />);
    await confirmBatch();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const done = button("Done");
    done.focus();
    await act(async () => reading.reject(new Error("Owned workspace read refused")));
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-workspace-refresh-observation] [role="alert"]')?.textContent,
      ).toContain("Owned workspace read refused"),
    );
    expect(document.body.textContent).toContain("First game: Installed");
    expect(document.body.textContent).toContain(
      "Second game: Couldn't install. Owned download refused",
    );
    expect(button("Done")).toBe(done);
    expect(document.activeElement).toBe(done);
    await click("Retry refresh");
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-workspace-refresh-observation] [role="alert"]'),
      ).toBeNull(),
    );
    expect(document.body.textContent).not.toContain("No ports in your library yet");
    expect(button("Done")).toBe(done);
    expect(read).toHaveBeenCalledTimes(2);
    expect(desktopApi.startInstallBatch).toHaveBeenCalledTimes(1);
    expect(desktopApi.runInstallBatch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => reading.resolve(refreshed));
  }
});

it("closes resumed results and keeps focus in Add games if the workspace refresh settles later", async () => {
  const reading = deferred<PortStatus[]>();
  const read = vi.fn(() => reading.promise);
  vi.mocked(desktopApi.unfinishedInstallBatches).mockResolvedValue([batch]);
  vi.mocked(desktopApi.runInstallBatch).mockResolvedValue(completed);
  try {
    await view.rerender(<BatchWorkspace generation={1} readWorkspace={read} />);
    await page.getByRole("button", { name: "View scan results", exact: true }).click();
    const workspace = page.getByRole("region", { name: "Add games workspace" });
    await workspace.getByRole("button", { name: "Continue setup batch", exact: true }).click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await workspace.getByRole("button", { name: "Done", exact: true }).click();
    const returnTarget = workspace.getByRole("heading", { name: "Folders Portcove scans" });
    await expect.element(returnTarget).toHaveFocus();
    await expect
      .element(workspace.getByRole("region", { name: "Install selected games" }))
      .not.toBeInTheDocument();
    await act(async () => reading.resolve(refreshed));
    await expect.element(returnTarget).toHaveFocus();
    expect(desktopApi.startInstallBatch).not.toHaveBeenCalled();
    expect(desktopApi.runInstallBatch).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => reading.resolve(refreshed));
  }
});

it("refreshes Core after a rejected run without losing the retained mixed result or its error", async () => {
  vi.mocked(desktopApi.runInstallBatch).mockRejectedValue(new Error("Owned batch response lost"));
  vi.spyOn(desktopApi, "installBatch").mockResolvedValue(completed);
  const read = vi.fn(async () => refreshed);
  await view.rerender(<BatchWorkspace generation={1} readWorkspace={read} />);
  await confirmBatch();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(document.body.textContent).not.toContain("No ports in your library yet"),
  );
  expect(document.body.textContent).toContain("Owned batch response lost");
  expect(document.body.textContent).toContain("First game: Installed");
  expect(document.body.textContent).toContain(
    "Second game: Couldn't install. Owned download refused",
  );
  expect(document.body.textContent).not.toContain("No ports in your library yet");
  expect(button("Done").isConnected).toBe(true);
  expect(desktopApi.installBatch).toHaveBeenCalledExactlyOnceWith("owned-batch", 1);
  expect(desktopApi.runInstallBatch).toHaveBeenCalledTimes(1);
});

it("does not refresh a replacement workspace when a detached batch finishes", async () => {
  const running = deferred<InstallBatchRecord>();
  vi.mocked(desktopApi.runInstallBatch).mockReturnValue(running.promise);
  const oldRead = vi.fn(async () => refreshed);
  const currentRead = vi.fn(async () => statuses);
  try {
    await view.rerender(<BatchWorkspace key={1} generation={1} readWorkspace={oldRead} />);
    await confirmBatch();
    await view.rerender(<BatchWorkspace key={2} generation={2} readWorkspace={currentRead} />);
    await act(async () => running.resolve(completed));
    expect(oldRead).not.toHaveBeenCalled();
    expect(currentRead).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Setup batch results");
    expect(document.body.textContent).toContain("No ports in your library yet");
    expect(desktopApi.runInstallBatch).toHaveBeenCalledExactlyOnceWith(
      "owned-batch",
      1,
      expect.any(Function),
    );
  } finally {
    await act(async () => running.resolve(completed));
  }
});
