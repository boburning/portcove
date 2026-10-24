import { controlledAct as act } from "../../test/controlled-react-act";
import { cleanup, render, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { desktopApi } from "../api";
import { catalogEntries } from "../features/browsing/catalog-entry";
import type { Perform, PerformOptions } from "../features/operations/use-operation-state";
import { pickInstallFolder, pickHostToolExecutable } from "../file-picker";
import { portStatus } from "../test-fixtures";
import type {
  CatalogDownloadCandidate,
  CatalogDownloadCandidates,
  CatalogDownloadPreview,
  CatalogDownloadRequest,
  PendingSetupRecord,
  PortListing,
  PortStatus,
} from "../types";
import { filterPorts, summarizeLibrary } from "../view-model";
import { CatalogDownloadControl } from "./CatalogDownload";
import { PortBrowser } from "./PortBrowser";
import { SelfServiceSetup } from "./SelfServiceSetup";
import { ListingDetailPanel } from "./ListingDetailPanel";

vi.mock("../file-picker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../file-picker")>()),
  pickInstallFolder: vi.fn(),
  pickHostToolExecutable: vi.fn(),
}));

const listing: PortListing = {
  id: "new-project",
  name: "New Project",
  summary: "An upstream game.",
  project_url: "https://github.com/example/game",
  platforms: [],
  availability: "unknown",
};
const artifact: CatalogDownloadCandidate = {
  release_id: 42,
  asset_id: 7,
  release_tag: "v1.2",
  release_url: `${listing.project_url}/releases/tag/v1.2`,
  name: "game.zip",
  size: 2048,
  download_url: `${listing.project_url}/releases/download/v1.2/game.zip`,
  can_extract: true,
  sha256: null,
};
const selection: CatalogDownloadRequest = {
  port_id: listing.id,
  release_id: artifact.release_id,
  asset_id: artifact.asset_id,
  destination_parent: "/home/player/Games",
  extract_archive: true,
};
const preview: CatalogDownloadPreview = {
  request: selection,
  artifact,
  destination_path: "/home/player/Games/new-project-v1.2",
  preview_sha256: "a".repeat(64),
};
const saved: PendingSetupRecord = {
  id: "setup-1",
  port_id: listing.id,
  listing,
  path: preview.destination_path,
  state: "downloaded",
  artifact,
  archive_sha256: "b".repeat(64),
  downloaded_at: "2026-10-22T12:00:00Z",
  reason: null,
};
const status = { ...portStatus(), port_id: listing.id };
const listingStatus = {
  port_id: listing.id,
  status,
  actions: [{ action: "attach-existing" as const, allowed: true }],
};
const entry = catalogEntries(
  undefined,
  { format_version: 1, listings: [listing] },
  [listingStatus],
  [],
)[0]!;
const candidates: CatalogDownloadCandidates = {
  port_id: listing.id,
  allowed: true,
  releases: [{ id: 42, tag: "v1.2", preview: false, assets_complete: true }],
  selected_release_id: 42,
  recommended_asset_id: 7,
  packages: [{ asset_id: 7, suitability: "suitable", reason: "Native platform portable package." }],
  recommendation_reason: "Recommended for this host.",
  candidates: [artifact],
  coverage: {
    release_limit: 10,
    candidate_limit: 200,
    releases_checked: 1,
    release_history_complete: true,
    candidates_complete: true,
  },
  default_destination_parent: "/home/player/Games",
  upstream_url: `${listing.project_url}/releases`,
  reason: null,
};
let root: RenderResult;
const reportEvent = vi.fn();
const performCalls = vi.fn<(name: string, options?: PerformOptions) => void>();
const perform: Perform = async (name, task, options) => {
  performCalls(name, options);
  return task(reportEvent);
};
const changed = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function click(label: string) {
  const candidates = [...document.body.querySelectorAll("button")];
  const button =
    candidates.find(
      (item) => item.closest('[data-slot="dialog-content"]') && item.textContent?.trim() === label,
    ) ?? candidates.find((item) => item.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
}
async function chooseSingleDownload() {
  await click("Check upstream downloads");
  await click("Change download folder…");
  await click("Review download");
}
beforeEach(async () => {
  performCalls.mockClear();
  reportEvent.mockClear();
  changed.mockClear();
  vi.mocked(pickInstallFolder).mockReset().mockResolvedValue(selection.destination_parent);
  vi.spyOn(desktopApi, "catalogDownloadCandidates").mockResolvedValue(candidates);
  vi.spyOn(desktopApi, "previewCatalogDownload").mockResolvedValue(preview);
  vi.spyOn(desktopApi, "downloadCatalogPackage").mockResolvedValue(saved);
  vi.spyOn(desktopApi, "discoverSetupLaunchTargets").mockResolvedValue({
    port_id: listing.id,
    pending_id: saved.id,
    candidates: [],
    recommended_executable: null,
    complete: true,
    entries_checked: 1,
    explanation: "No native application found; choose the installed executable elsewhere.",
  });
  vi.spyOn(desktopApi, "openPendingSetupFolder").mockResolvedValue(undefined);
  vi.spyOn(desktopApi, "forgetPendingSetup").mockResolvedValue(undefined);
  root = await render(
    <CatalogDownloadControl entry={entry} generation={9} busy={false} perform={perform} />,
  );
});
afterEach(async () => {
  await cleanup();
  await page.viewport(1280, 800);
  vi.restoreAllMocks();
});

it("accepts Core's recommended package and location together without a folder decision", async () => {
  await click("Check upstream downloads");
  await click("Review download");
  expect(pickInstallFolder).not.toHaveBeenCalled();
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(selection, 9);
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("keeps a recommendation beyond eight packages and an explicitly selected alternative visible", async () => {
  const others = Array.from({ length: 9 }, (_, index) => ({
    ...artifact,
    asset_id: 100 + index,
    name: `alternative-${index}.zip`,
  }));
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    candidates: [...others, artifact],
    packages: [
      ...candidates.packages,
      ...others.map((item) => ({
        asset_id: item.asset_id,
        suitability: "suitable",
        reason: "Supported alternative.",
      })),
    ],
  });
  await click("Check upstream downloads");
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll('[role="combobox"]')].some(
        (item) =>
          item.textContent?.includes("Recommended") && item.textContent.includes("game.zip"),
      ),
    ).toBe(true),
  );
  await click("Other and uncertain downloads");
  await page.getByRole("combobox", { name: /^Package/ }).click();
  await page.getByRole("option", { name: /alternative-8.zip/ }).click();
  await click("Show recommended packages");
  await vi.waitFor(() =>
    expect(
      [...document.querySelectorAll('[role="combobox"]')].some((item) =>
        item.textContent?.includes("alternative-8.zip"),
      ),
    ).toBe(true),
  );
  await click("Review download");
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(
    { ...selection, asset_id: 108 },
    9,
  );
});

it("retains a deliberate older release and package across refresh", async () => {
  const older = {
    ...artifact,
    release_id: 41,
    asset_id: 8,
    release_tag: "v1.1",
    name: "game-variant.zip",
  };
  const previous = {
    ...candidates,
    selected_release_id: 41,
    candidates: [older, { ...older, asset_id: 9, name: "other.zip" }],
    recommended_asset_id: 9,
  };
  vi.mocked(desktopApi.catalogDownloadCandidates)
    .mockResolvedValueOnce({
      ...candidates,
      releases: [
        ...candidates.releases,
        { id: 41, tag: "v1.1", preview: false, assets_complete: true },
      ],
    })
    .mockResolvedValue(previous);
  await click("Check upstream downloads");
  await page.getByRole("combobox", { name: /^Release v/ }).click();
  await page.getByRole("option", { name: /v1.1/ }).click();
  await click("Other and uncertain downloads");
  await page.getByRole("combobox", { name: /^Package/ }).click();
  await page.getByRole("option", { name: /game-variant.zip/ }).click();
  await click("Check downloads again");
  expect(desktopApi.catalogDownloadCandidates).toHaveBeenLastCalledWith(
    listing.id,
    9,
    41,
    "stable",
  );
  await click("Review download");
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(
    { ...selection, release_id: 41, asset_id: 8 },
    9,
  );
});

it("requires a new choice when an explicitly selected package disappears", async () => {
  await click("Check upstream downloads");
  // Selecting a listed file is a deliberate preference even if it was recommended.
  const alternative = { ...artifact, asset_id: 8, name: "variant.zip" };
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    candidates: [artifact, alternative],
  });
  await click("Check downloads again");
  await click("Other and uncertain downloads");
  await page.getByRole("combobox", { name: /^Package/ }).click();
  await page.getByRole("option", { name: /variant.zip/ }).click();
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue(candidates);
  await click("Check downloads again");
  expect(document.body.textContent).toContain("Your selected package is no longer available");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeDisabled();
});

it("suggests Core's native target and preserves a manual installation outside the download folder", async () => {
  const executable = `${saved.path}/bin/Harbor.exe`;
  vi.mocked(desktopApi.discoverSetupLaunchTargets).mockResolvedValue({
    port_id: listing.id,
    pending_id: saved.id,
    complete: true,
    entries_checked: 4,
    candidates: [
      {
        executable,
        working_directory: `${saved.path}/bin`,
        supporting_program: false,
        reason: "Native game application.",
      },
    ],
    recommended_executable: executable,
    explanation: "Confirm the game or upstream launcher.",
  });
  await root.rerender(
    <SelfServiceSetup
      entry={{ ...entry, pendingSetup: saved }}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
    />,
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain(`Executable: ${executable}`));
  expect(desktopApi.discoverSetupLaunchTargets).toHaveBeenCalledExactlyOnceWith(
    listing.id,
    saved.id,
    9,
  );
  vi.mocked(pickHostToolExecutable).mockResolvedValue("C:/Games/Harbor/Harbor.exe");
  await click("Choose game executable…");
  expect(document.body.textContent).toContain("Executable: C:/Games/Harbor/Harbor.exe");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Working directory"]')?.value,
  ).toBe("C:/Games/Harbor");
  await click("Refresh launch suggestions");
  expect(document.body.textContent).toContain("Executable: C:/Games/Harbor/Harbor.exe");
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("discards a late launch suggestion when the selected game or library changes", async () => {
  const scan = deferred<Awaited<ReturnType<typeof desktopApi.discoverSetupLaunchTargets>>>();
  vi.mocked(desktopApi.discoverSetupLaunchTargets).mockReturnValueOnce(scan.promise);
  await root.rerender(
    <SelfServiceSetup
      key="old"
      entry={{ ...entry, pendingSetup: saved }}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
    />,
  );
  await root.rerender(
    <SelfServiceSetup
      key="new"
      entry={{ ...entry, id: "other" }}
      status={status}
      generation={10}
      perform={perform}
      onChanged={changed}
    />,
  );
  await act(async () =>
    scan.resolve({
      port_id: listing.id,
      pending_id: saved.id,
      candidates: [
        {
          executable: "C:/stale.exe",
          working_directory: "C:/",
          supporting_program: false,
          reason: "old",
        },
      ],
      recommended_executable: "C:/stale.exe",
      complete: true,
      entries_checked: 1,
      explanation: "old context",
    }),
  );
  expect(document.body.textContent).not.toContain("stale.exe");
  expect(document.body.textContent).not.toContain("old context");
});

it("keeps long package names, keyboard review and narrow layouts usable", async () => {
  const long = { ...artifact, name: `Harbor-${"portable-build-".repeat(8)}windows-x64.zip` };
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    candidates: [long],
  });
  await page.viewport(1280, 800);
  await root.rerender(
    <ListingDetailPanel
      entry={entry}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
      close={vi.fn()}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeEnabled();
  await page.screenshot({
    element: page.getByRole("region", { name: "Download from upstream" }),
    path: "../../../../work/installation-rendered/recommendation-wide.png",
  });
  await page.viewport(360, 740);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await page.screenshot({
    element: page.getByRole("region", { name: "Download from upstream" }),
    path: "../../../../work/installation-rendered/recommendation-narrow.png",
  });
  await click("Review download");
  await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
  await page.screenshot({
    element: page.getByRole("dialog"),
    path: "../../../../work/installation-rendered/review-narrow.png",
  });
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toHaveFocus();
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("shows Core's refusal and does not turn observed assets into download permission", async () => {
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    allowed: false,
    reason: "This project has no supported direct download route.",
  });
  expect(desktopApi.catalogDownloadCandidates).not.toHaveBeenCalled();
  await click("Check upstream downloads");
  expect(document.body.textContent).toContain(
    "This project has no supported direct download route.",
  );
  expect(document.body.textContent).not.toContain("Review download");
  expect(pickInstallFolder).not.toHaveBeenCalled();
  expect(desktopApi.previewCatalogDownload).not.toHaveBeenCalled();
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("keeps the listing download selection through all four production detail tabs", async () => {
  await root.rerender(
    <ListingDetailPanel
      entry={entry}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
      close={vi.fn()}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeEnabled();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await click("Set up game");
  await expect.element(page.getByRole("region", { name: "Set up and launch" })).toHaveFocus();
  await vi.waitFor(() =>
    expect(desktopApi.catalogDownloadCandidates).toHaveBeenCalledExactlyOnceWith(
      entry.id,
      9,
      undefined,
      "stable",
    ),
  );
  await click("Change download folder…");
  await page.getByRole("tab", { name: "Saved data", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Back up data", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Check for updates", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect.element(page.getByText(listing.summary, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await click("Review download");
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(selection, 9);
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("reveals pending setup through the header without restarting the download", async () => {
  await root.rerender(
    <ListingDetailPanel
      entry={{ ...entry, pendingSetup: saved }}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
      close={vi.fn()}
    />,
  );
  await page.getByRole("button", { name: "Continue setup", exact: true }).first().click();
  await expect
    .element(page.getByRole("heading", { name: "Launch details", exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Versions", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Launch details", exact: true }))
    .toBeVisible();
  expect(desktopApi.catalogDownloadCandidates).not.toHaveBeenCalled();
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("requires a package choice for ambiguous builds while retaining the default folder", async () => {
  const second = { ...artifact, asset_id: 8, name: "other-system.zip" };
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    candidates: [artifact, second],
    recommended_asset_id: null,
    packages: [
      ...candidates.packages,
      { asset_id: 8, suitability: "suitable", reason: "Another plausible build." },
    ],
  });
  await click("Check upstream downloads");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeDisabled();
  await click("Change download folder…");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeDisabled();
  await page.getByRole("combobox", { name: /^Package/ }).click();
  await page.getByRole("option", { name: /other-system\.zip/ }).click();
  await click("Review download");
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(
    { ...selection, asset_id: 8 },
    9,
  );
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("uses selected-release evidence even when older history is unchecked", async () => {
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    coverage: { ...candidates.coverage!, release_history_complete: false },
    reason: "Older downloads may be available upstream.",
  });
  await click("Check upstream downloads");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeEnabled();
  expect(pickInstallFolder).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Older downloads may be available upstream.");
  await click("Review download");
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(selection, 9);
});
it("requires a package choice when selected asset coverage is insufficient", async () => {
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    recommended_asset_id: null,
    coverage: { ...candidates.coverage!, candidates_complete: false },
    reason: "More downloads may be available upstream.",
  });
  await click("Check upstream downloads");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeDisabled();
  await page.getByRole("combobox", { name: /^Package/ }).click();
  await page.getByRole("option", { name: /game\.zip/ }).click();
  await click("Review download");
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(selection, 9);
});

it("keeps empty partial-search guidance distinct from unavailable upstream packages", async () => {
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    allowed: false,
    candidates: [],
    coverage: { ...candidates.coverage!, release_history_complete: false },
    reason:
      "No release assets were found in the recent releases checked here. Older downloads may be available upstream.",
  });
  await click("Check upstream downloads");
  expect(document.body.textContent).toContain("in the recent releases checked here");
  expect(document.body.textContent).toContain("Older downloads may be available upstream");
  expect(document.body.textContent).not.toContain("Review download");
  await expect.element(page.getByRole("link", { name: "View upstream releases" })).toBeVisible();
});

it("reviews the exact file and destination, then hands an unexecuted installer to the operation owner", async () => {
  const installer = { ...artifact, name: "setup.exe", can_extract: false };
  const installerRequest = { ...selection, extract_archive: false };
  const checked = { ...preview, artifact: installer, request: installerRequest };
  vi.mocked(desktopApi.catalogDownloadCandidates).mockResolvedValue({
    ...candidates,
    candidates: [installer],
  });
  vi.mocked(desktopApi.previewCatalogDownload).mockResolvedValue(checked);
  const transfer = deferred<PendingSetupRecord>();
  vi.mocked(desktopApi.downloadCatalogPackage).mockReturnValue(transfer.promise);
  const launch = vi.spyOn(desktopApi, "launch");
  await chooseSingleDownload();
  expect(pickInstallFolder).toHaveBeenCalledExactlyOnceWith(candidates.default_destination_parent);
  expect(desktopApi.previewCatalogDownload).toHaveBeenCalledExactlyOnceWith(installerRequest, 9);
  expect(document.body.textContent).toContain(preview.destination_path);
  expect(document.body.textContent).toContain("will not run an installer");
  expect(document.body.textContent).toContain("Not supplied. Portcove will record a SHA-256");
  expect(document.querySelector('[role="checkbox"]')).toBeNull();
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
  await click("Download");
  expect(desktopApi.downloadCatalogPackage).toHaveBeenCalledExactlyOnceWith(
    installerRequest,
    checked.preview_sha256,
    9,
    reportEvent,
  );
  expect(performCalls.mock.calls[0]?.[1]?.context).toMatchObject({
    target: { kind: "port", id: listing.id },
    libraryGeneration: 9,
    exclusionScope: "target",
  });
  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  await act(async () => {
    transfer.resolve({ ...saved, artifact: installer });
  });
  expect(launch).not.toHaveBeenCalled();
  expect(desktopApi.openPendingSetupFolder).not.toHaveBeenCalled();
  expect(desktopApi.forgetPendingSetup).not.toHaveBeenCalled();
});

it("keeps folder cancellation and closing a review free of mutations", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValueOnce(null);
  await click("Check upstream downloads");
  await click("Change download folder…");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeEnabled();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await click("Change download folder…");
  await click("Review download");
  await click("Cancel");
  expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
});

it("discards lookup and native picker results from an earlier game or library", async () => {
  const lookup = deferred<CatalogDownloadCandidates>();
  vi.mocked(desktopApi.catalogDownloadCandidates).mockReturnValueOnce(lookup.promise);
  await click("Check upstream downloads");
  await root.rerender(
    <CatalogDownloadControl
      entry={{ ...entry, id: "another" }}
      generation={10}
      busy={false}
      perform={perform}
    />,
  );
  await act(async () => {
    lookup.resolve(candidates);
  });
  expect(document.body.textContent).not.toContain(artifact.name);
  await root.rerender(
    <CatalogDownloadControl entry={entry} generation={11} busy={false} perform={perform} />,
  );
  await click("Check upstream downloads");
  const picker = deferred<string | null>();
  vi.mocked(pickInstallFolder).mockReturnValueOnce(picker.promise);
  await click("Change download folder…");
  await root.rerender(
    <CatalogDownloadControl entry={entry} generation={12} busy={false} perform={perform} />,
  );
  await act(async () => {
    picker.resolve("/stale-folder");
  });
  await click("Check upstream downloads");
  expect(document.body.textContent).not.toContain("/stale-folder");
  await expect
    .element(page.getByRole("button", { name: "Review download", exact: true }))
    .toBeEnabled();
});

it("resumes durable downloads and binds folder/reminder operations to the exact saved ID", async () => {
  await root.rerender(
    <SelfServiceSetup
      entry={{ ...entry, pendingSetup: saved }}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
    />,
  );
  expect(desktopApi.catalogDownloadCandidates).not.toHaveBeenCalled();
  await click("Continue setup");
  const directory = document.querySelector('input[value="/home/player/Games/new-project-v1.2"]');
  expect(directory).not.toBeNull();
  await click("Open download folder");
  expect(desktopApi.openPendingSetupFolder).toHaveBeenCalledExactlyOnceWith(
    listing.id,
    saved.id,
    9,
  );
  await click("Remove setup entry…");
  expect(document.body.textContent).toContain("all files inside it stay where they are");
  expect(desktopApi.forgetPendingSetup).not.toHaveBeenCalled();
  await click("Cancel");
  await click("Remove setup entry…");
  await click("Remove setup entry");
  expect(desktopApi.forgetPendingSetup).toHaveBeenCalledExactlyOnceWith(listing.id, saved.id, 9);
});

it("counts a pending listing under Needs attention beside a ready registration without offering Play for the download", async () => {
  const readyListing = { ...listing, id: "ready-project", name: "Ready Project" };
  const readyStatus: PortStatus = {
    ...portStatus(),
    port_id: readyListing.id,
    external_runtime: {
      id: "registered-runtime",
      port_id: readyListing.id,
      platform: "linux-x86-64",
      path: "/home/player/Ready",
      executable: "/home/player/Ready/game",
      user_selected: { arguments: [] },
      archive_sha256: "",
      immutable_tree_sha256: "",
      version: "user-managed",
      registered_at: 1,
    },
    readiness: { launchable: true, pending_setup: false, blockers: [] },
  };
  const members = catalogEntries(
    undefined,
    { format_version: 1, listings: [listing, readyListing] },
    [
      listingStatus,
      {
        port_id: readyListing.id,
        status: readyStatus,
        actions: [{ action: "launch", allowed: true }],
      },
    ],
    [saved],
  );
  const statuses = new Map([
    [listing.id, status],
    [readyListing.id, readyStatus],
  ]);
  const launch = vi.fn();
  const select = vi.fn();
  function PendingLibrary() {
    const [selectedReadiness, setSelectedReadiness] = useState("all");
    return (
      <PortBrowser
        view="library"
        ports={filterPorts(
          members,
          statuses,
          "library",
          selectedReadiness as "all" | "ready" | "setup",
          "",
        )}
        libraryFilterCandidates={members}
        queryContext={{ library: { id: "/fixture/library", statuses } }}
        libraryReadiness={selectedReadiness}
        setLibraryReadiness={setSelectedReadiness}
        statuses={statuses}
        overview={summarizeLibrary(members, statuses)}
        filter="all"
        setFilter={() => {}}
        onSelect={select}
        onContinue={launch}
        loading={false}
      />
    );
  }
  await root.rerender(<PendingLibrary />);
  const readiness = page.getByRole("combobox", { name: /^Readiness / });
  await expect.element(readiness).toHaveAccessibleName("Readiness All (2)");
  await expect.element(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await readiness.click();
  await expect.element(page.getByRole("option", { name: "Ready (1)", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Needs attention (1)", exact: true }).click();
  await expect.element(readiness).toHaveAccessibleName("Readiness Needs attention (1)");
  expect(document.body.textContent).toContain("Downloaded · setup needed");
  expect(document.body.textContent).not.toContain(readyListing.name);
  await expect
    .element(page.getByRole("button", { name: "Play", exact: true }))
    .not.toBeInTheDocument();
  await click("Continue setup");
  expect(select.mock.calls[0]?.[0]).toBe(listing.id);
  expect(launch).not.toHaveBeenCalled();
  expect(desktopApi.catalogDownloadCandidates).not.toHaveBeenCalled();
});

it("presents interrupted downloads as recovery and never as launchable or ready setup", async () => {
  const attention = {
    ...saved,
    id: "setup-recovery",
    state: "attention-required" as const,
    reason: "The downloaded archive is incomplete.",
  };
  await root.rerender(
    <SelfServiceSetup
      entry={{ ...entry, pendingSetup: attention }}
      status={status}
      generation={9}
      perform={perform}
      onChanged={changed}
    />,
  );
  expect(document.body.textContent).toContain(attention.reason);
  expect(
    [...document.querySelectorAll("button")].some((button) =>
      ["Play", "Continue setup", "Choose game executable…"].includes(
        button.textContent?.trim() ?? "",
      ),
    ),
  ).toBe(false);
  await click("Open download folder");
  expect(desktopApi.openPendingSetupFolder).toHaveBeenCalledExactlyOnceWith(
    listing.id,
    attention.id,
    9,
  );
  expect(desktopApi.downloadCatalogPackage).not.toHaveBeenCalled();
  expect(desktopApi.forgetPendingSetup).not.toHaveBeenCalled();
});
