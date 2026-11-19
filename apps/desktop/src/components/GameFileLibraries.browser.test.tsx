import { requireCompleteCaptureTarget } from "../../test/capture-target";
import "../styles/index.css";
import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { fixtureValue } from "../test-fixtures";
import { currentSourceCatalog } from "../catalog-test-fixtures";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
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
import { SettingsView, Sidebar } from "./Chrome";
import { installRecord } from "./rendered-test-fixtures";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";

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
  vi.spyOn(desktopApi, "rootSetupConsents").mockResolvedValue([]);
  vi.spyOn(desktopApi, "readyNoticesEnabled").mockResolvedValue(true);
  vi.spyOn(desktopApi, "gameFileRootMatchProfiles").mockResolvedValue([]);
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

function expectCandidateComposition(
  selector: string,
  stacked: boolean,
  path: string,
  label: string,
) {
  const row = fixtureValue(document.querySelector<HTMLElement>(selector), "candidate row");
  const identity = fixtureValue(
    row.querySelector<HTMLElement>(":scope > div"),
    "candidate identity",
  );
  const actions = fixtureValue(
    row.querySelector<HTMLElement>(".source-candidate-actions"),
    "candidate actions",
  );
  const workspace = fixtureValue(
    row.closest<HTMLElement>("[data-saved-folders-workspace]"),
    "saved-folder workspace",
  );
  const workspaceStyle = getComputedStyle(workspace);
  const available =
    workspace.clientWidth -
    parseFloat(workspaceStyle.paddingLeft) -
    parseFloat(workspaceStyle.paddingRight);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  expect(available < 38 * rem).toBe(stacked);
  const rowBounds = row.getBoundingClientRect();
  const identityBounds = identity.getBoundingClientRect();
  const actionBounds = actions.getBoundingClientRect();
  expect(actionBounds.top >= identityBounds.bottom - 1).toBe(stacked);
  expect(actionBounds.left >= identityBounds.right - 1).toBe(!stacked);
  expect(identityBounds.width).toBeGreaterThanOrEqual(stacked ? rowBounds.width - 1 : 18 * rem);
  expect(row.textContent).toContain(label);
  expect(row.textContent).toContain("Already added. Review game requirements in details.");
  expect(row.textContent).toContain("Already in your library");
  const code = fixtureValue(identity.querySelector("code"), "complete candidate path");
  expect(code.textContent).toBe(path);
  expect(getComputedStyle(code).direction).toBe("ltr");
  const range = document.createRange();
  range.selectNodeContents(identity);
  for (const line of range.getClientRects()) {
    expect(line.left).toBeGreaterThanOrEqual(identityBounds.left - 1);
    expect(line.right).toBeLessThanOrEqual(identityBounds.right + 1);
  }
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
  row.scrollIntoView({ block: "center", behavior: "instant" });
  const controls = [...actions.querySelectorAll("button")];
  expect(controls).toHaveLength(2);
  for (const target of [row, ...controls]) {
    const bounds = target.getBoundingClientRect();
    const label = "candidate composition " + target.tagName;
    requireCompleteCaptureTarget(
      {
        target: label,
        target_count: 1,
        visible: target.checkVisibility(),
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        viewport: { width: innerWidth, height: innerHeight },
      },
      label,
    );
  }
  return row;
}

it.each(
  (["dark", "light"] as const).flatMap((theme) => [
    { theme, layout: "dual-sidebar", viewport: 960, inlineSize: undefined, stacked: true },
    {
      theme,
      layout: "below-container-boundary",
      viewport: 1280,
      inlineSize: "calc(51rem + var(--space-6) - 1px)",
      stacked: true,
    },
    {
      theme,
      layout: "at-container-boundary",
      viewport: 1280,
      inlineSize: "calc(51rem + var(--space-6))",
      stacked: false,
    },
  ]),
)(
  "keeps streamed and completed candidates readable in $theme $layout",
  async ({ theme, layout, viewport, inlineSize, stacked }) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    const transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    const source: SourceRecord = {
      ...savedCandidate,
      path: String.raw`D:\a\portcove\portcove\work\native-product-workflows-review-continuation\desktop-verify\2026-11-18T21-00-52-826Z-ps3xzZ\native\opengoal-jak1.iso`,
      size: 41,
      storage_size: 41,
    };
    const profile = {
      ...sourceProfile(),
      id: source.profile_id,
      label: "Jak and Daxter retail disc validated by the pinned OpenGOAL extractor",
    };
    const port = {
      ...portDefinition(),
      id: "sample",
      name: "OpenGOAL: Jak and Daxter",
      source_profile: source.profile_id,
    };
    const status = {
      ...portStatus(),
      port_id: port.id,
      active: installRecord({ port_id: port.id }),
    };
    const candidateRoot = { ...saved, path: source.path.slice(0, source.path.lastIndexOf("\\")) };
    const completed = {
      ...snapshot,
      roots: [candidateRoot],
      report: {
        ...snapshot.report,
        searched_roots: [candidateRoot.path],
        candidates: [source],
        limits_reached: [],
      },
    };
    vi.mocked(desktopApi.gameFileRoots).mockResolvedValue([candidateRoot]);
    const open = vi.fn();
    let emit: ((event: OperationEvent) => void) | undefined;
    let finish: ((value: GameFileScanSnapshot) => void) | undefined;
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(null);
    vi.mocked(desktopApi.scanGameFileRoots).mockImplementation((_limits, _generation, callback) => {
      emit = callback;
      return new Promise<GameFileScanSnapshot>((resolve) => {
        finish = resolve;
      });
    });
    try {
      await page.viewport(viewport, 780);
      document.documentElement.dataset.theme = theme;
      await root.rerender(
        <GameFileScanProvider generation={1}>
          <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)] bg-[var(--color-bg)]">
            <Sidebar
              view="settings"
              setView={vi.fn()}
              installedCount={1}
              updateCount={0}
              activities={[]}
            />
            <main className="workspace-main min-h-0 w-full min-w-0 overflow-auto pb-12 max-[75rem]:pb-10">
              <div style={{ inlineSize }}>
                <SettingsView
                  category="game-files"
                  generation={1}
                  ports={[port]}
                  statuses={new Map([[port.id, status]])}
                  sourceProfiles={[profile]}
                  sources={[source]}
                  installedCount={1}
                  sourceRequirementsState="available"
                  onOpenPort={open}
                />
              </div>
            </main>
          </div>
        </GameFileScanProvider>,
      );
      await expect
        .element(page.getByRole("navigation", { name: "Primary navigation", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("navigation", { name: "Settings categories", exact: true }))
        .toBeVisible();
      await click("Scan saved folders");
      const publish = fixtureValue(emit, "owned scan event callback");
      await act(async () => {
        publish({
          schema_version: 3,
          operation_id: "owned-layout-scan",
          parent_operation_id: null,
          target: null,
          sequence: 1,
          timestamp_ms: 1,
          operation: "discover_sources",
          type: "started",
        });
        publish({
          schema_version: 3,
          operation_id: "owned-layout-scan",
          parent_operation_id: null,
          target: null,
          sequence: 2,
          timestamp_ms: 2,
          operation: "discover_sources",
          type: "source_candidate",
          ...source,
        });
      });
      await document.fonts.ready;
      const live = expectCandidateComposition(
        "[data-live-candidate]",
        stacked,
        source.path,
        profile.label,
      );
      const view = fixtureValue(
        live.querySelector<HTMLButtonElement>("button:not([data-candidate-review])"),
        "view game details",
      );
      view.focus();
      await userEvent.keyboard("{Enter}");
      expect(open).toHaveBeenCalledExactlyOnceWith(port.id, "game-file-libraries-setup");
      expect(document.activeElement).toBe(view);
      await captureParityState(`game-file-candidates-${layout}`);
      vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(completed);
      await act(async () => fixtureValue(finish, "owned scan settlement")(completed));
      expect(document.querySelector("[data-live-candidate]")).toBeNull();
      expectCandidateComposition("[data-completed-candidate]", stacked, source.path, profile.label);
      expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce();
      expect(desktopApi.importSource).not.toHaveBeenCalled();
    } finally {
      await act(async () => finish?.(completed));
      await root.rerender(null);
      transport.dispose();
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

function expectWholeFolderIssueList(
  expected: { identity: string | null; message: string; path: string | null }[],
) {
  const list = page.getByRole("list", { name: "Folder search issues", exact: true }).element();
  list.scrollIntoView({ block: "center" });
  const rows = [...list.querySelectorAll(":scope > li")];
  expect(rows).toHaveLength(expected.length);
  for (const [index, issue] of expected.entries()) {
    const row = fixtureValue(rows[index], "reported folder issue");
    expect(row.querySelector("strong")?.textContent ?? null).toBe(
      issue.identity === null ? null : `${issue.identity}: `,
    );
    expect(row.textContent).toContain(issue.message);
    expect(row.querySelector("code")?.textContent ?? null).toBe(issue.path);
    const range = document.createRange();
    range.selectNodeContents(fixtureValue(row.querySelector("p"), "issue message and path"));
    const bounds = row.getBoundingClientRect();
    for (const line of range.getClientRects()) {
      expect(line.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(line.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  }
  const bounds = list.getBoundingClientRect();
  requireCompleteCaptureTarget(
    {
      target: "whole folder search issue list",
      target_count: 1,
      visible: true,
      rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      viewport: { width: innerWidth, height: innerHeight },
    },
    "whole folder search issue list",
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  return list;
}

it.each(["dark", "light"] as const)(
  "identifies every saved-folder issue in the actual Settings consumer in %s",
  async (theme) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    const transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    const ids = [
      "blue-dragon",
      "dark-forces-pc-complete-installed-data",
      "doom-3-classic-pc-131-pk4",
      "doom-3-roe-classic-pc-131-pk4",
      "twilight-princess",
    ];
    const catalog = currentSourceCatalog();
    const profiles = ids.map((id) => {
      const identity = fixtureValue(
        catalog.identities.find((entry) => entry.id === id),
        id,
      );
      return { ...sourceProfile(), id, label: identity.label };
    });
    const message = "Folder search can't find files for this requirement. Choose them directly.";
    const issues = ids.map((profile_id) => ({ profile_id, path: null, message }));
    const report = { ...snapshot.report, candidates: [], limits_reached: [], issues };
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({ ...snapshot, report });
    const port = {
      ...portDefinition(),
      id: "sample",
      name: "Disc game",
      source_profile: "blank-profile",
    };
    const review = vi
      .spyOn(desktopApi, "planSourceImport")
      .mockRejectedValue(new Error("Fixture direct check finished"));
    try {
      await page.viewport(1028, 750);
      document.documentElement.dataset.theme = theme;
      await root.rerender(
        <GameFileScanProvider generation={1}>
          <div className="app-shell grid h-[100vh] grid-cols-[var(--layout-sidebar)_minmax(0,_1fr)] bg-[var(--color-bg)]">
            <Sidebar
              view="settings"
              setView={vi.fn()}
              installedCount={0}
              updateCount={0}
              activities={[]}
            />
            <main className="workspace-main min-h-0 w-full min-w-0 overflow-auto pb-12 max-[75rem]:pb-10">
              <SettingsView
                category="game-files"
                generation={1}
                ports={[port]}
                statuses={new Map()}
                sourceProfiles={[
                  ...profiles,
                  { ...sourceProfile(), id: "blank-profile", label: "  " },
                ]}
                sources={[]}
                installedCount={0}
                sourceRequirementsState="available"
              />
            </main>
          </div>
        </GameFileScanProvider>,
      );
      await expect
        .element(page.getByRole("list", { name: "Folder search issues", exact: true }))
        .toBeVisible();
      await document.fonts.ready;
      expectWholeFolderIssueList(
        profiles.map((profile) => ({ identity: profile.label, message, path: null })),
      );
      await captureParityState("game-files-requirement-issues");

      const path = "D:/Games/original disc whose exact path remains available.iso";
      const unknownProfile = "u".repeat(128);
      const variants = [
        { profile_id: unknownProfile, path: null, message },
        {
          profile_id: "blank-profile",
          path: null,
          message: "The selected requirement could not be checked.",
        },
        {
          profile_id: null,
          path,
          message: "File exceeds the scan size limit.",
          direct_check_profiles: [port.source_profile],
        },
      ];
      vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
        ...snapshot,
        report: { ...report, issues: variants },
      });
      await click("Refresh folders");
      await expect.element(page.getByText(unknownProfile, { exact: false })).toBeVisible();
      const list = expectWholeFolderIssueList(
        variants.map((issue) => ({
          identity: issue.profile_id,
          message: issue.message,
          path: issue.path,
        })),
      );
      const direct = page.getByText("Check this file", { exact: true });
      await direct.click();
      await expect
        .element(page.getByRole("button", { name: "Check for Disc game", exact: true }))
        .toBeEnabled();
      expect(list.querySelector("code")?.getAttribute("dir")).toBe("ltr");
      expectWholeFolderIssueList(
        variants.map((issue) => ({
          identity: issue.profile_id,
          message: issue.message,
          path: issue.path,
        })),
      );
      await captureParityState("game-files-requirement-issue-fallbacks");
      await click("Check for Disc game");
      expect(review).toHaveBeenCalledExactlyOnceWith(
        port.source_profile,
        path,
        "use_current_location",
      );
      expect(desktopApi.importSource).not.toHaveBeenCalled();
      expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
      expect(picker.pickGameFileFolder).not.toHaveBeenCalled();
    } finally {
      await root.rerender(null);
      transport.dispose();
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

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
  await captureParityState("game-files-scan-results-fixture");
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
      observations_reused: 0,
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
  await captureParityState("game-files-scan-continuation-fixture");
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
  await captureParityState("game-files-registered-preliminary-selection-fixture");
  const candidate = document.querySelector<HTMLElement>("[data-preliminary-selection]")!;
  const reviewAction = candidate.querySelector<HTMLButtonElement>("[data-candidate-review]")!;
  expect(reviewAction.textContent).toBe("Check these files");
  expect(reviewAction.disabled).toBe(false);
  candidate.scrollIntoView({ block: "center", behavior: "instant" });
  for (const target of [candidate, reviewAction]) {
    const bounds = target.getBoundingClientRect();
    requireCompleteCaptureTarget(
      {
        target: "registered preliminary " + target.tagName,
        target_count: 1,
        visible: target.checkVisibility(),
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        viewport: { width: innerWidth, height: innerHeight },
      },
      "registered preliminary " + target.tagName,
    );
  }
  await captureParityState("game-files-registered-preliminary-candidate-actions-fixture");
  await act(async () =>
    document.querySelector<HTMLInputElement>("[data-setup-review-port]")!.click(),
  );
  await click("Review Preliminary port setup");
  expect(open).toHaveBeenCalledWith(port.id, "game-file-libraries-setup");
  expect(desktopApi.importSource).not.toHaveBeenCalled();
  await render([]);
  expect(button("Review Preliminary port setup").disabled).toBe(true);
  expect(button("Check these files").disabled).toBe(false);
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
  await click("Check these files");
  expect(document.activeElement).toBe(button("Cancel review"));
  expect(document.body.textContent).toContain("Basic file checks passed");
  await click("Cancel review");
  expect(document.activeElement).toBe(button("Check these files"));
  await click("Check these files");
  await render([]);
  await click("Cancel review");
  expect(button("Check these files").disabled).toBe(true);
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
  await captureParityState("game-files-stale-snapshot-fixture");
});

it("presents a required restart separately from another resumable batch", async () => {
  const restarted = resumableSnapshot();
  restarted.freshness = "inputs_changed";
  restarted.coverage = { ...restarted.coverage!, can_resume: false, restart_required: true };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(restarted);
  await click("Refresh folders");
  expect(button("Start new scan")).toBeDefined();
  expect(document.body.textContent).toContain("The saved scan cannot continue.");
  await captureParityState("game-files-scan-restart-required-fixture");
  await click("Start new scan");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledTimes(1);
});

it("keeps the reported large ISO actionable after finishing a saved scan", async () => {
  const path = "D:/Games/original.iso";
  const first = {
    ...portDefinition(),
    id: "jak1",
    name: "Jak and Daxter",
    source_profile: "opengoal-jak1-disc",
  };
  const second = {
    ...portDefinition(),
    id: "jak2",
    name: "Jak II",
    source_profile: "opengoal-jak2-disc",
  };
  const review = vi
    .spyOn(desktopApi, "planSourceImport")
    .mockRejectedValue(new Error("Fixture check finished"));
  const resumed = resumableSnapshot();
  const retained = {
    ...resumed,
    matches: storedMatchesSnapshot().matches!,
    report: {
      ...snapshot.report,
      limits_reached: ["file_size"],
      issues: [
        {
          path,
          profile_id: null,
          message: "File exceeds the scan size limit.",
          direct_check_profiles: [first.source_profile, second.source_profile],
        },
      ],
    },
  } satisfies GameFileScanSnapshot;
  const finished = {
    ...retained,
    coverage: { ...resumed.coverage!, can_resume: false, frontier_exhausted: true },
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(retained);
  const scan = vi.mocked(desktopApi.scanGameFileRoots).mockImplementation(async () => {
    vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(finished);
    return finished;
  });
  await root.rerender(<GameFileLibraries generation={1} ports={[first, second]} profiles={[]} />);
  await click("Refresh folders");
  await click("Finish scanning these folders");
  expect(scan).toHaveBeenCalledExactlyOnceWith(
    resumed.limits,
    1,
    expect.any(Function),
    retained.matches.scan_id,
  );
  expect(button("Scan saved folders")).toBeDefined();
  const summary = [...document.querySelectorAll("summary")].find(
    (item) => item.textContent === "Check this file",
  );
  await act(async () => summary?.click());
  await click("Check for Jak II");
  expect(review).toHaveBeenCalledExactlyOnceWith(
    second.source_profile,
    path,
    "use_current_location",
  );
  expect(picker.pickGameFileFolder).not.toHaveBeenCalled();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
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
  expect(button("Update folder location").disabled).toBe(true);
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
  expect(renderedReview?.textContent).toContain("File check: Edition identified");
  expect(renderedReview?.textContent).toContain("Additional space needed: 0 B");
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
  await captureParityState("game-files-streamed-scan-running-fixture");
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
    1,
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
  await captureParityState("game-files-scan-failed-fixture");
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
  await captureParityState("game-files-remove-root-reviewed-fixture");
  await click("Keep scanning this folder");
  expect(remove).not.toHaveBeenCalled();
  await click("Remove");
  await click("Stop scanning this folder");
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
    await click("Update folder location");
  } else {
    mutation = vi.spyOn(desktopApi, "removeGameFileRoot").mockImplementation(async () => {
      failRead();
      return true;
    });
    notice = "Saved folder removed. The game files were kept.";
    await click("Remove");
    await click("Stop scanning this folder");
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
  await click("Stop scanning this folder");
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
    await click("Update folder location");
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
    await click("Stop scanning this folder");
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
  await click("Update folder location");
  expect(relink).toHaveBeenCalledWith(saved.id, "E:/More Games", 1);
  await captureParityState("game-files-root-relinked-fixture");
});

it("names the folders Portcove scans and only saves a chosen folder in Settings", async () => {
  expect(document.querySelector("h2")?.textContent).toBe("Folders Portcove scans");
  expect(() => button("Choose folder to scan")).toThrow("Missing button: Choose folder to scan");
  const add = vi.spyOn(desktopApi, "addGameFileRoot").mockResolvedValue({
    ...saved,
    id: "root-2",
    path: "E:/More Games",
  });
  await click("Add folder");
  expect(add).toHaveBeenCalledExactlyOnceWith("E:/More Games", 1);
  expect(document.body.textContent).toContain("Folder saved.");
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
});

it("scans the saved folders once after a chosen folder is saved when adding means scanning", async () => {
  const added: GameFileRoot = { ...saved, id: "root-2", path: "E:/More Games" };
  vi.mocked(desktopApi.gameFileRoots)
    .mockResolvedValueOnce([saved])
    .mockResolvedValue([saved, added]);
  const add = vi.spyOn(desktopApi, "addGameFileRoot").mockResolvedValue(added);
  await root.rerender(
    <GameFileLibraries generation={1} key="scan-after-add" scanAfterAdd ports={[]} profiles={[]} />,
  );
  expect(document.querySelector("h2")?.textContent).toBe("Folders Portcove scans");
  expect(() => button("Add folder")).toThrow("Missing button: Add folder");
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  await click("Choose folder to scan");
  expect(picker.pickGameFileFolder).toHaveBeenCalledWith("");
  expect(add).toHaveBeenCalledExactlyOnceWith(added.path, 1);
  await vi.waitFor(() => expect(desktopApi.scanGameFileRoots).toHaveBeenCalledOnce());
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledWith(
    expect.objectContaining({ max_entries: 10_000, max_candidates: 64 }),
    1,
    expect.any(Function),
  );
  expect(add.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(desktopApi.scanGameFileRoots).mock.invocationCallOrder[0]!,
  );
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it.each([
  ["the folder choice is cancelled", null, undefined],
  ["saving the folder fails", "E:/More Games", new Error("save failed")],
] as const)("does not scan when %s", async (_case, chosen, failure) => {
  vi.mocked(picker.pickGameFileFolder).mockResolvedValue(chosen);
  const add = vi.spyOn(desktopApi, "addGameFileRoot");
  if (failure) add.mockRejectedValue(failure);
  await root.rerender(
    <GameFileLibraries
      generation={1}
      key="scan-after-add-refused"
      scanAfterAdd
      ports={[]}
      profiles={[]}
    />,
  );
  await click("Choose folder to scan");
  expect(add).toHaveBeenCalledTimes(failure ? 1 : 0);
  expect(document.body.textContent?.includes("save failed")).toBe(Boolean(failure));
  expect(button("Choose folder to scan").disabled).toBe(false);
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
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

it("keeps Add and Scan available with eight saved folders", async () => {
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
  expect(button("Add folder").disabled).toBe(false);
  expect(button("Scan saved folders").disabled).toBe(false);
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
    expect(button("Add folder").disabled).toBe(false);
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
  expect(button("Add folder").disabled).toBe(false);
  expect(button("Scan saved folders").disabled).toBe(false);
  expect(desktopApi.scanGameFileRoots).not.toHaveBeenCalled();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("rechecks available folders after choosing a folder before adding it", async () => {
  const initial = rootsWithAvailability(7, 2);
  const reconnected = rootsWithAvailability(8, 1);
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValueOnce(initial).mockResolvedValue(reconnected);
  const add = vi.spyOn(desktopApi, "addGameFileRoot").mockResolvedValue(saved);
  await root.rerender(
    <GameFileLibraries generation={1} key="reconnected-add" ports={[]} profiles={[]} />,
  );
  expect(button("Add folder").disabled).toBe(false);
  await click("Add folder");
  expect(picker.pickGameFileFolder).toHaveBeenCalledWith("");
  expect(add).toHaveBeenCalledWith("E:/More Games", 1);
  expect(button("Add folder").disabled).toBe(false);
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

it("finishes a retained scan of nine folders with the existing Core scan action", async () => {
  const roots = rootsWithAvailability(9, 0);
  const continued = { ...resumableSnapshot(), roots };
  vi.mocked(desktopApi.gameFileRoots).mockResolvedValue(roots);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(continued);
  mockCompletedScan(roots);
  const remove = vi.spyOn(desktopApi, "removeGameFileRoot");
  await root.rerender(
    <GameFileLibraries generation={1} key="continued-nine-roots" ports={[]} profiles={[]} />,
  );
  await click("Continue scan");
  expect(desktopApi.scanGameFileRoots).toHaveBeenCalledExactlyOnceWith(
    continued.limits,
    1,
    expect.any(Function),
  );
  expect(remove).not.toHaveBeenCalled();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("starts one Finish action bound to the displayed saved scan", async () => {
  const stored = storedMatchesSnapshot();
  const resumed = { ...resumableSnapshot(), matches: stored.matches! };
  let resolve!: (snapshot: GameFileScanSnapshot) => void;
  const pending = new Promise<GameFileScanSnapshot>((done) => {
    resolve = done;
  });
  const scan = vi.mocked(desktopApi.scanGameFileRoots);
  scan.mockImplementation((_limits, _generation, emit) => {
    emit?.({
      schema_version: 3,
      operation_id: "finish-scan",
      parent_operation_id: null,
      sequence: 2,
      timestamp_ms: 1,
      operation: "discover_sources",
      target: null,
      type: "progress",
      phase: "saved_folder_scan_checkpoints",
      phase_id: "saved_folder_scan_checkpoints",
      unit: "items",
      completed: 3,
      total: null,
    });
    return pending;
  });
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(resumed);
  try {
    await click("Refresh folders");
    await click("Finish scanning these folders");
    await expect.poll(() => document.body.textContent).toContain("3 batches saved.");
    expect(scan).toHaveBeenCalledExactlyOnceWith(
      resumed.limits,
      1,
      expect.any(Function),
      stored.matches!.scan_id,
    );
    expect(desktopApi.importSource).not.toHaveBeenCalled();
  } finally {
    await act(async () => resolve(stored));
  }
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

it.each(["hash_bytes", "candidates"] as const)(
  "offers Core's %s-limited continuation without widening the allowance or authorizing setup",
  async (limit) => {
    const continued = resumableSnapshot();
    continued.report = { ...continued.report, limits_reached: [limit] };
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
  },
);

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
  await click("Update folder location");
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

it("keeps automatic folder setup off until the player chooses its boundary", async () => {
  const consent = {
    format_version: 1,
    root_id: saved.id,
    enrollment: "future_only" as const,
    enabled_at: 2,
    updated_at: 2,
    existing_files: 1,
  };
  vi.spyOn(desktopApi, "setRootSetupConsent").mockResolvedValue(consent);
  vi.spyOn(desktopApi, "runStandingSetup").mockResolvedValue({
    already_running: false,
    assessments: [],
    not_assessed: 0,
    batches: [],
    failures: [],
  });
  await act(async () => {});
  const off = document.querySelector<HTMLInputElement>('input[type="radio"][value="off"]');
  expect(off?.checked).toBe(true);
  const futureOnly = document.querySelector<HTMLInputElement>(
    'input[type="radio"][value="future_only"]',
  );
  await act(async () => futureOnly?.click());
  expect(desktopApi.setRootSetupConsent).toHaveBeenCalledWith(saved.id, "future_only", 1);
  expect(
    document.querySelector<HTMLInputElement>('input[type="radio"][value="future_only"]')?.checked,
  ).toBe(true);
});

it("asks which game to set up when several games can use a folder's files", async () => {
  const consent = {
    format_version: 1,
    root_id: saved.id,
    enrollment: "existing_and_future" as const,
    enabled_at: 2,
    updated_at: 2,
    existing_files: 0,
  };
  vi.mocked(desktopApi.rootSetupConsents).mockResolvedValue([consent]);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...snapshot,
    report: { ...snapshot.report, limits_reached: [] },
  });
  vi.spyOn(desktopApi, "setRootSetupImplementation").mockResolvedValue({
    ...consent,
    implementations: [{ profile_id: "game", port_id: "second" }],
  });
  const first = { ...portDefinition(), id: "first", name: "First", source_profile: "game" };
  const second = { ...portDefinition(), id: "second", name: "Second", source_profile: "game" };
  // Remount so the folder list loads the scan and folder choices above.
  await root.rerender(null);
  await root.rerender(<GameFileLibraries generation={1} ports={[first, second]} profiles={[]} />);
  await act(async () => {});
  const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find((item) =>
    [...item.options].some((option) => option.value === "second"),
  );
  expect(select).toBeDefined();
  await act(async () => {
    select!.value = "second";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(desktopApi.setRootSetupImplementation).toHaveBeenCalledWith(saved.id, "game", "second", 1);
});

it("offers a folder's game choice for files matched beyond the shown results", async () => {
  const consent = {
    format_version: 1,
    root_id: saved.id,
    enrollment: "existing_and_future" as const,
    enabled_at: 2,
    updated_at: 2,
    existing_files: 0,
  };
  vi.mocked(desktopApi.rootSetupConsents).mockResolvedValue([consent]);
  // The shown results hold none of this folder's shared files; Core reports them.
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...snapshot,
    report: { ...snapshot.report, candidates: [], limits_reached: [] },
  });
  vi.mocked(desktopApi.gameFileRootMatchProfiles).mockResolvedValue(["shared"]);
  const first = { ...portDefinition(), id: "first", name: "First", source_profile: "shared" };
  const second = { ...portDefinition(), id: "second", name: "Second", source_profile: "shared" };
  await root.rerender(null);
  await root.rerender(<GameFileLibraries generation={1} ports={[first, second]} profiles={[]} />);
  await act(async () => {});
  expect(desktopApi.gameFileRootMatchProfiles).toHaveBeenCalledWith(saved.id, 1);
  const offered = () =>
    [...document.querySelectorAll<HTMLSelectElement>("select")].some((item) =>
      [...item.options].some((option) => option.value === "second"),
    );
  expect(offered()).toBe(true);
  // A later scan no longer matches those files; the choice follows it even
  // though the shown results did not change.
  vi.mocked(desktopApi.gameFileRootMatchProfiles).mockResolvedValue([]);
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue({
    ...snapshot,
    completed_at: 2,
    report: { ...snapshot.report, candidates: [], limits_reached: [] },
  });
  await click("Refresh folders");
  expect(offered()).toBe(false);
});

it("offers keeping a local copy only once automatic setup is on, and saves the choice", async () => {
  const consent = {
    format_version: 1,
    root_id: saved.id,
    enrollment: "existing_and_future" as const,
    enabled_at: 2,
    updated_at: 2,
    existing_files: 0,
  };
  const label = "Keep a copy of each game's files on this computer";
  const copyBox = () =>
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
      input.closest("label")?.textContent?.includes(label),
    );
  await act(async () => {});
  expect(copyBox()).toBeUndefined();
  vi.mocked(desktopApi.rootSetupConsents).mockResolvedValue([consent]);
  vi.spyOn(desktopApi, "setRootSetupLocalCopy").mockResolvedValue({
    ...consent,
    keep_local_copy: true,
  });
  vi.spyOn(desktopApi, "runStandingSetup").mockResolvedValue({
    already_running: false,
    assessments: [],
    not_assessed: 0,
    batches: [],
    failures: [],
  });
  await root.rerender(null);
  await root.rerender(<GameFileLibraries generation={1} ports={[]} profiles={[]} />);
  await act(async () => {});
  expect(copyBox()?.checked).toBe(false);
  await act(async () => copyBox()?.click());
  expect(desktopApi.setRootSetupLocalCopy).toHaveBeenCalledWith(saved.id, true, 1);
  expect(copyBox()?.checked).toBe(true);
  expect(document.body.textContent).toContain("nothing in this folder is moved or deleted");
});

function storedMatchesSnapshot(): GameFileScanSnapshot {
  return {
    ...snapshot,
    report: { ...snapshot.report, limits_reached: [] },
    matches: {
      scan_id: "00000000-0000-4000-8000-000000000001",
      exact_matches: 3,
      preliminary_selections: 0,
      preview_complete: false,
    },
  };
}

it("counts every stored match and shows more of them a page at a time", async () => {
  const stored = storedMatchesSnapshot();
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stored);
  const later = (name: string): SourceRecord => ({ ...savedCandidate, path: `D:/Games/${name}` });
  const pages = vi
    .spyOn(desktopApi, "gameFileScanMatches")
    .mockResolvedValueOnce({
      scan_id: stored.matches!.scan_id,
      kind: "exact",
      offset: 1,
      total: 3,
      candidates: [later("second.z64")],
      preliminary_selections: [],
      next_offset: 2,
    })
    .mockResolvedValueOnce({
      scan_id: stored.matches!.scan_id,
      kind: "exact",
      offset: 2,
      total: 3,
      candidates: [later("third.z64")],
      preliminary_selections: [],
      next_offset: null,
    });
  await click("Refresh folders");
  expect(document.body.textContent).toContain("Found 3 exact matches.");
  expect(document.body.textContent).toContain("Showing 1 of 3 matches.");
  expect(document.body.textContent).not.toContain("D:/Games/second.z64");
  await click("Show more matches");
  expect(pages).toHaveBeenLastCalledWith(
    { scan_id: stored.matches!.scan_id, kind: "exact", offset: 1, limit: 64 },
    1,
  );
  expect(document.body.textContent).toContain("D:/Games/second.z64");
  expect(document.body.textContent).toContain("Showing 2 of 3 matches.");
  await click("Show more matches");
  expect(pages).toHaveBeenLastCalledWith(
    { scan_id: stored.matches!.scan_id, kind: "exact", offset: 2, limit: 64 },
    1,
  );
  expect(document.body.textContent).toContain("D:/Games/third.z64");
  expect(document.body.textContent).not.toContain("Showing");
  expect(document.querySelector("[data-match-preview-notice]")).toBeNull();
  expect(
    [...document.querySelectorAll("button")].some(
      (item) => item.textContent === "Show more matches",
    ),
  ).toBe(false);
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("uses Core's registered path spelling even when the complete scan fits its preview", async () => {
  const stored: GameFileScanSnapshot = {
    ...storedMatchesSnapshot(),
    report: {
      ...snapshot.report,
      candidates: [{ ...savedCandidate, path: "\\\\?\\D:\\Games\\game.z64" }],
    },
    matches: { ...storedMatchesSnapshot().matches!, exact_matches: 1, preview_complete: true },
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stored);
  const projection = vi.spyOn(desktopApi, "gameFileScanRegisteredMatches").mockResolvedValue({
    candidates: [savedCandidate],
    preliminary_selections: [],
  });
  const port = {
    ...portDefinition(),
    id: "registered-port",
    source_profile: savedCandidate.profile_id,
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
  const review = vi.spyOn(desktopApi, "planInstallBatch").mockResolvedValue({
    items: [{ port_id: port.id, hold: "Waiting for setup input" }],
    capacity: { download_bytes: 0, volumes: [] },
  });
  const start = vi.spyOn(desktopApi, "startInstallBatch");
  await root.rerender(
    <SetupReviewSelectionProvider>
      <GameFileLibraries
        generation={1}
        ports={[port]}
        profiles={[{ ...sourceProfile(), id: savedCandidate.profile_id }]}
        registeredSources={[savedCandidate]}
        statuses={new Map([[port.id, status]])}
        onOpenPort={vi.fn()}
      />
    </SetupReviewSelectionProvider>,
  );
  await click("Refresh folders");
  await vi.waitFor(() =>
    expect(document.querySelectorAll("[data-setup-review-port]")).toHaveLength(1),
  );
  expect(projection).toHaveBeenLastCalledWith(stored.matches, 1);
  await act(async () => document.querySelector<HTMLElement>("[data-setup-review-port]")!.click());
  await click("Review installing 1 selected");
  expect(review).toHaveBeenCalledExactlyOnceWith([port.id], 1);
  expect(start).not.toHaveBeenCalled();
  expect(desktopApi.importSource).not.toHaveBeenCalled();
});

it("adds a game whose registered match is outside the scan preview", async () => {
  const stored = storedMatchesSnapshot();
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stored);
  const paged: SourceRecord = {
    ...savedCandidate,
    profile_id: "paged",
    path: "D:/Games/paged.z64",
    sha256: "c".repeat(64),
  };
  const projection = vi.spyOn(desktopApi, "gameFileScanRegisteredMatches").mockResolvedValue({
    candidates: [paged],
    preliminary_selections: [],
  });
  vi.spyOn(desktopApi, "addGamesToLibrary").mockResolvedValue([]);
  const port = {
    ...portDefinition(),
    id: "paged-port",
    name: "Paged port",
    source_profile: "paged",
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
  await root.rerender(
    <SetupReviewSelectionProvider>
      <GameFileLibraries
        generation={1}
        ports={[port]}
        profiles={[{ ...sourceProfile(), id: "paged" }]}
        registeredSources={[paged]}
        statuses={new Map([[port.id, status]])}
        onOpenPort={vi.fn()}
      />
    </SetupReviewSelectionProvider>,
  );
  await click("Refresh folders");
  expect(projection).toHaveBeenLastCalledWith(stored.matches, 1);
  expect(document.querySelectorAll("[data-setup-review-port]")).toHaveLength(1);
  await act(async () =>
    document.querySelector<HTMLInputElement>("[data-setup-review-port]")!.click(),
  );
  await click("Add 1 selected to Library");
  expect(desktopApi.addGamesToLibrary).toHaveBeenCalledWith(
    [
      {
        port_id: port.id,
        origin: "game_file_discovery",
        sources: [{ profile_id: "paged", sha256: paged.sha256 }],
      },
    ],
    1,
  );
});

it("reviews more than sixteen eligible games without opening their match pages", async () => {
  const sources = Array.from({ length: 21 }, (_, index): SourceRecord => ({
    ...savedCandidate,
    profile_id: `profile-${index}`,
    path: `D:/Games/game-${index}.z64`,
    sha256: index.toString(16).padStart(64, "0"),
  }));
  const [ambiguous, ...eligible] = sources;
  const ports = [
    ...sources.map((source) => ({
      ...portDefinition(),
      id: `port-${source.profile_id}`,
      name: `Game ${source.profile_id}`,
      source_profile: source.profile_id,
    })),
    {
      ...portDefinition(),
      id: "alternative",
      name: "Alternative version",
      source_profile: ambiguous!.profile_id,
    },
  ];
  const stored = storedMatchesSnapshot();
  stored.report.candidates = sources.slice(0, 9);
  stored.matches!.exact_matches = 79;
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stored);
  const pages = vi.spyOn(desktopApi, "gameFileScanMatches");
  const projection = vi.spyOn(desktopApi, "gameFileScanRegisteredMatches").mockResolvedValue({
    candidates: sources,
    preliminary_selections: [],
  });
  const selectedIds = eligible.map((source) => `port-${source.profile_id}`);
  const plan = vi.spyOn(desktopApi, "planInstallBatch").mockResolvedValue({
    items: selectedIds.map((port_id) => ({ port_id, hold: "Waiting for setup input" })),
    capacity: { download_bytes: 0, volumes: [] },
  });
  const start = vi.spyOn(desktopApi, "startInstallBatch");
  const run = vi.spyOn(desktopApi, "runInstallBatch");
  const add = vi.spyOn(desktopApi, "addGamesToLibrary");
  const statuses = new Map(
    ports.map((port) => [
      port.id,
      {
        ...portStatus(),
        port_id: port.id,
        port_actions: [
          {
            action: "install" as const,
            availability: "allowed" as const,
            reason: "available" as const,
          },
        ],
      },
    ]),
  );
  await root.rerender(
    <SetupReviewSelectionProvider>
      <GameFileLibraries
        generation={1}
        ports={ports}
        profiles={sources.map((source) => ({ ...sourceProfile(), id: source.profile_id }))}
        registeredSources={sources}
        statuses={statuses}
        onOpenPort={vi.fn()}
      />
    </SetupReviewSelectionProvider>,
  );
  await click("Refresh folders");
  expect(document.body.textContent).toContain("Showing 9 of 79 matches.");
  expect(document.body.textContent).toContain(
    "0 selected · 20 eligible · 1 game needs a version choice",
  );
  expect(projection).toHaveBeenLastCalledWith(stored.matches, 1);
  expect(pages).not.toHaveBeenCalled();
  await click("Select all 20 eligible");
  const trigger = button("Review installing 20 selected");
  trigger.focus();
  await act(async () => userEvent.keyboard(" "));
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Install selected games"]')?.textContent).toContain(
      "0 ready to install, 20 waiting",
    ),
  );
  const panel = document.querySelector<HTMLElement>('[aria-label="Install selected games"]')!;
  await vi.waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
  const focused = document.activeElement!.getBoundingClientRect();
  expect(focused.top).toBeGreaterThanOrEqual(0);
  expect(focused.top).toBeLessThan(innerHeight);
  for (let step = 0; document.activeElement?.textContent !== "Cancel" && step < 4; step++)
    await act(async () => userEvent.tab());
  expect(document.activeElement?.textContent).toBe("Cancel");
  await act(async () => userEvent.keyboard(" "));
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Install selected games"]')).toBeNull(),
  );
  const choices = document.querySelector<HTMLElement>('[aria-label="Selected setup reviews"]')!;
  await vi.waitFor(() => expect(choices.contains(document.activeElement)).toBe(true));
  const returned = document.activeElement!.getBoundingClientRect();
  expect(returned.width).toBeGreaterThan(0);
  expect(returned.height).toBeGreaterThan(0);
  expect(returned.top).toBeGreaterThanOrEqual(0);
  expect(returned.top).toBeLessThan(innerHeight);
  expect(plan).toHaveBeenCalledExactlyOnceWith(selectedIds, 1);
  expect(start).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(add).not.toHaveBeenCalled();
});

it("reloads the saved scan instead of mixing pages when a newer scan replaced it", async () => {
  const stored = storedMatchesSnapshot();
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stored);
  const conflict = Object.assign(new Error("the saved scan changed; reload its matches"), {
    code: "conflict",
  });
  vi.spyOn(desktopApi, "gameFileScanMatches").mockRejectedValue(conflict);
  await click("Refresh folders");
  const reads = vi.mocked(desktopApi.gameFileScanSnapshot).mock.calls.length;
  const replaced: GameFileScanSnapshot = {
    ...stored,
    matches: {
      ...stored.matches!,
      scan_id: "00000000-0000-4000-8000-000000000002",
      exact_matches: 1,
      preview_complete: true,
    },
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(replaced);
  await click("Show more matches");
  await vi.waitFor(() =>
    expect(vi.mocked(desktopApi.gameFileScanSnapshot).mock.calls.length).toBeGreaterThan(reads),
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain("Found 1 exact match."));
  expect(document.body.textContent).not.toContain("Show more matches");
});

it("explains a scan that stopped at its safety limit for matches", async () => {
  const limited: GameFileScanSnapshot = {
    ...storedMatchesSnapshot(),
    report: { ...snapshot.report, limits_reached: ["candidates"] },
    coverage: {
      batch_entries_examined: 1,
      batches: 4,
      can_resume: false,
      entries_relisted: 0,
      frontier_exhausted: false,
      metadata_checks: 2,
      observations_reused: 0,
      pending_directories: 1,
      prior_member_rechecks: 0,
      remaining_entries: null,
      restart_required: false,
    },
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(limited);
  await click("Refresh folders");
  expect(document.body.textContent).toContain("reached its safety limit for matches");
  expect(document.body.textContent).toContain("The matches found so far were kept.");
  expect(document.body.textContent).not.toContain("Continue scan");
});

it("drops earlier pages when a continued scan keeps its ID but changes its preview", async () => {
  const stored = storedMatchesSnapshot();
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(stored);
  const later = (name: string): SourceRecord => ({ ...savedCandidate, path: `D:/Games/${name}` });
  const pages = vi.spyOn(desktopApi, "gameFileScanMatches").mockResolvedValueOnce({
    scan_id: stored.matches!.scan_id,
    kind: "exact",
    offset: 1,
    total: 3,
    candidates: [later("second.z64")],
    preliminary_selections: [],
    next_offset: 2,
  });
  await click("Refresh folders");
  await click("Show more matches");
  expect(document.body.textContent).toContain("D:/Games/second.z64");
  // The same scan continues: its preview now holds two matches of four.
  const continued: GameFileScanSnapshot = {
    ...stored,
    report: { ...stored.report, candidates: [savedCandidate, later("second.z64")] },
    matches: { ...stored.matches!, exact_matches: 4 },
  };
  vi.mocked(desktopApi.gameFileScanSnapshot).mockResolvedValue(continued);
  await click("Refresh folders");
  expect(document.body.textContent).toContain("Showing 2 of 4 matches.");
  // The earlier page is not appended again, so nothing is shown twice.
  expect(document.body.textContent?.split("D:/Games/second.z64").length).toBe(2);
  pages.mockResolvedValueOnce({
    scan_id: stored.matches!.scan_id,
    kind: "exact",
    offset: 2,
    total: 4,
    candidates: [later("third.z64")],
    preliminary_selections: [],
    next_offset: 3,
  });
  await click("Show more matches");
  expect(pages).toHaveBeenLastCalledWith(
    { scan_id: stored.matches!.scan_id, kind: "exact", offset: 2, limit: 64 },
    1,
  );
});
