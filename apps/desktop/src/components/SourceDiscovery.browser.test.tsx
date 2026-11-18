import { requireCompleteCaptureTarget } from "../../test/capture-target";
import "../styles/index.css";
import { captureParityState } from "../../test/parity-capture";
import { render as renderComponent, cleanup } from "vitest-browser-react";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type {
  SourceDiscoveryLimits,
  SourceDiscoveryReport,
  SourceImportPlan,
  SourceProfile,
} from "../types";
import {
  SourceDiscoveryButton,
  SourceImportReview,
  sourceImportModePresentation,
} from "./SourceDiscovery";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { sourceImportFixtures } from "./rendered-test-fixtures";
beforeEach(() => {
  vi.mocked(picker.pickInstallFolder).mockReset();
});

it("opens and scans the Inbox, then applies the exact reviewed import", async () => {
  const profile: SourceProfile = {
    id: "test",
    label: "Owned game source",
    kind: "file",
    accepted_extensions: ["iso"],
    accepted_sha1: [],
    accepted_sha256: ["b".repeat(64)],
    disc: null,
    members: [],
  };
  const candidate = {
    profile_id: profile.id,
    path: "D:/Selected/game.iso",
    sha256: "b".repeat(64),
    size: 64,
    storage_sha256: "b".repeat(64),
    storage_size: 64,
    updated_at: 1,
  };
  const report: SourceDiscoveryReport = {
    searched_roots: ["D:/Selected"],
    searched_profiles: [profile.id],
    candidates: [candidate],
    entries_examined: 3,
    files_hashed: 1,
    hash_bytes: 64,
    symlinks_skipped: 0,
    limits_reached: ["entries", "depth", "file_size", "hash_bytes", "candidates"],
    issues: [],
    issues_omitted: 3,
  };
  const plan: SourceImportPlan = {
    schema_version: 1,
    profile_id: profile.id,
    mode: "copy",
    source: candidate,
    admission_mode: "exact_identity",
    destination: "D:/Library/source-inbox/test/game.iso",
    destination_exists: false,
    existing_registration: null,
    reuse_existing: false,
    required_bytes: 64,
    source_guard_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
  };
  vi.mocked(picker.pickInstallFolder).mockResolvedValueOnce(null).mockResolvedValue("D:/Selected");
  const openInbox = vi.spyOn(desktopApi, "openSourceInbox").mockResolvedValue({
    root: "D:/Library/source-inbox",
    profile_id: profile.id,
    profile: "D:/Library/source-inbox/test",
  });
  const scanInbox = vi
    .spyOn(desktopApi, "scanSourceInbox")
    .mockImplementation(async (_profile, _limits, emit) => {
      emit?.({
        schema_version: 2,
        parent_operation_id: null,
        target: null,
        operation_id: "scan-operation",
        operation: "discover_sources",
        sequence: 0,
        timestamp_ms: 1,
        type: "started",
      });
      return {
        operation_id: "scan-operation",
        profile_id: profile.id,
        paths: {
          root: "D:/Library/source-inbox",
          profile_id: profile.id,
          profile: "D:/Library/source-inbox/test",
        },
        state: "incomplete",
        selected: null,
        candidates: [
          {
            automatically_reusable: false,
            inspection: {
              profile_id: profile.id,
              path: "D:/Library/source-inbox/test/not-a-match.iso",
              observed_digests: [
                {
                  algorithm: "sha256",
                  scope: "original-file",
                  size: 64,
                  value: "c".repeat(64),
                },
              ],
              components: [],
              assessment: {
                health: "not_baselined",
                classification: { state: "unrecognized" },
                contract: { state: "not_evaluated" },
                admission: { state: "rejected", reason: "known_mismatch" },
                evidence: [],
              },
              record: null,
              message: "This file is not an exact match.",
            },
          },
        ],
        stats: {
          entries_examined: 2,
          candidates_inspected: 1,
          hash_bytes: 64,
          symlinks_skipped: 0,
          limits_reached: ["candidates", "file_size", "depth"],
          issues: [],
          issues_omitted: 1,
        },
      };
    });
  const search = vi.spyOn(desktopApi, "discoverSources").mockResolvedValue(report);
  const review = vi
    .spyOn(desktopApi, "planSourceImport")
    .mockRejectedValueOnce({ message: "Source changed after discovery" })
    .mockResolvedValue(plan);
  const importSource = vi
    .spyOn(desktopApi, "importSource")
    .mockImplementation(async (_profile, _path, _mode, _plan, _generation, emit) => {
      emit?.({
        schema_version: 2,
        parent_operation_id: null,
        target: null,
        operation_id: "import-operation",
        operation: "import_source",
        sequence: 0,
        timestamp_ms: 1,
        type: "started",
      });
      return {
        import_id: "import-operation",
        profile_id: profile.id,
        mode: "copy",
        outcome: "copied",
        registered: { ...candidate, path: plan.destination },
        copied: true,
        original_deleted: false,
        original_retained: true,
        retained_original_path: candidate.path,
        recovered: false,
      };
    });
  const refresh = vi.fn().mockRejectedValue(new Error("refresh failed after import"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = await renderComponent(null, { container: host });
  const control = (label: string) => {
    const result = [
      ...document.body.querySelectorAll<HTMLButtonElement>("button, [role=option]"),
    ].find((button) => button.textContent?.includes(label));
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  };
  const click = async (label: string) => {
    await userEvent.click(control(label));
  };
  try {
    await root.rerender(
      <SourceDiscoveryButton
        generation={7}
        profiles={[profile]}
        disabled={false}
        onAdded={refresh}
      />,
    );
    await click("Find required files");
    const searchField = document.body.querySelector<HTMLInputElement>("#source-search-root");
    const searchLabel = document.body.querySelector<HTMLLabelElement>(
      'label[for="source-search-root"]',
    );
    expect(searchField?.dataset.slot).toBe("input");
    expect(searchField?.className).toContain("border-pc-input");
    expect(searchField?.className).toContain("bg-[var(--color-bg-inset)]");
    expect(searchField?.labels?.[0]).toBe(searchLabel);
    expect(searchLabel?.textContent).toBe("Search folder");
    expect(document.body.textContent).toContain(
      "Searching does not upload or move your files. After finding a match, choose whether to use it where it is, copy it into Portcove, or move it.",
    );
    await page.getByRole("combobox", { name: /^Required files/ }).click();
    // The portal can mount after the browser click completes its input events.
    await expect
      .poll(() =>
        document.body.querySelector<HTMLElement>('[data-slot="select-content"][data-open]'),
      )
      .not.toBeNull();
    const openPopup = document.body.querySelector<HTMLElement>(
      '[data-slot="select-content"][data-open]',
    );
    expect(openPopup).not.toBeNull();
    await expect
      .poll(() => document.activeElement?.closest('[data-slot="select-content"]'))
      .toBe(openPopup);
    await userEvent.keyboard("{Escape}");
    expect(
      document.body.querySelector('[aria-labelledby="source-discovery-title"]'),
    ).not.toBeNull();
    await expect
      .poll(() => document.activeElement)
      .toBe(document.body.querySelector("#source-profile-select"));
    await click("Choose folder");
    expect(control("Search this folder").disabled).toBe(true);
    await click("Choose folder");
    await page.getByRole("combobox", { name: /^Required files/ }).click();
    await click("Owned game source");
    await click("Open game-file folder");
    expect(openInbox).toHaveBeenCalledWith(profile.id);
    await click("Search game-file folder");
    expect(scanInbox).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({ max_entries: 10_000, max_candidates: 64 }),
      expect.any(Function),
    );
    expect(document.body.textContent).toContain("The search could not check every file.");
    expect(document.body.textContent).toContain(
      "Some files weren't checked because this scan reached a limit.",
    );
    expect(document.body.textContent).toContain("Possible matches checked");
    expect(document.body.textContent).toContain("Individual file size");
    expect(document.body.textContent).toContain("2.0 GiB");
    expect(document.body.textContent).toContain("temporarily move some files outside it");
    expect(document.body.textContent).not.toContain("Result count");
    expect(document.body.textContent).not.toContain("not-a-match.iso");
    expect(document.body.textContent).toContain("1 more scan issue was omitted.");
    await captureParityState("source-discovery-incomplete-scan-fixture");
    await click("Search this folder");
    expect(search).toHaveBeenCalledWith(
      {
        roots: ["D:/Selected"],
        profile_ids: [profile.id],
        limits: {
          max_entries: 10_000,
          max_depth: 6,
          max_file_bytes: 2 * 1024 * 1024 * 1024,
          max_hash_bytes: 16 * 1024 * 1024 * 1024,
          max_candidates: 64,
        },
      },
      expect.any(Function),
    );
    expect(document.body.textContent).toContain(
      "Found 1 exact match. Checked 3 files and folders (64 B of verification data).",
    );
    expect(document.body.textContent).toContain(
      "Some files weren't checked because this scan reached a limit.",
    );
    expect(document.body.textContent).toContain("File and folder count");
    expect(document.body.textContent).toContain("Folder depth");
    expect(document.body.textContent).toContain("Individual file size");
    expect(document.body.textContent).toContain("Verification data");
    expect(document.body.textContent).toContain("16.0 GiB");
    expect(document.body.textContent).toContain("Choose a smaller folder and search again.");
    expect(document.body.textContent).toContain("Result count");
    expect(document.body.textContent).not.toContain("Possible matches checked");
    expect(document.body.textContent).not.toContain("file_size");
    expect(document.body.textContent).not.toContain("hash_bytes");
    expect(document.body.textContent).toContain("3 more scan issues were omitted.");
    expect(document.body.textContent).not.toContain("1 more scan issue was omitted.");
    await click("Review copy");
    expect(review).toHaveBeenCalledWith(profile.id, candidate.path, "copy");
    expect(document.body.textContent).toContain("Source changed after discovery");
    await captureParityState("source-discovery-changed-source-fixture");
    await click("Review copy");
    expect(document.body.textContent).toContain(plan.destination);
    expect(plan.admission_mode).toBe("exact_identity");
    const renderedReview = document.body.querySelector('[aria-label="Source import review"]');
    expect(renderedReview?.textContent).toContain(profile.label);
    expect(renderedReview?.textContent).toContain("File check: Edition identified");
    expect(renderedReview?.textContent).toContain("Additional space needed: 64 B");
    await click("Copy into Portcove");
    expect(importSource).toHaveBeenCalledWith(
      profile.id,
      candidate.path,
      "copy",
      plan.plan_sha256,
      7,
      expect.any(Function),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("File location saved");
    expect(document.body.textContent).toContain("The view couldn't refresh");
    expect(document.body.textContent).toContain("the files were already added");
    expect(
      document.body.querySelector('[aria-labelledby="source-discovery-title"] [role="alert"]'),
    ).toBeNull();
    expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
  } finally {
    await cleanup();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps cancellation tied to the emitted durable operation", async () => {
  const profile: SourceProfile = {
    id: "test",
    label: "Owned game source",
    kind: "file",
    accepted_extensions: ["iso"],
    accepted_sha1: [],
    accepted_sha256: [],
    disc: null,
    members: [],
  };
  vi.mocked(picker.pickInstallFolder).mockResolvedValue("D:/Selected");
  let stopSearch!: (error: unknown) => void;
  vi.spyOn(desktopApi, "discoverSources").mockImplementationOnce(
    (_request, emit) =>
      new Promise((_resolve, reject) => {
        stopSearch = reject;
        emit?.({
          schema_version: 2,
          parent_operation_id: null,
          target: null,
          operation_id: "search-operation",
          operation: "discover_sources",
          sequence: 0,
          timestamp_ms: 1,
          type: "started",
        });
      }),
  );
  const cancel = vi
    .spyOn(desktopApi, "cancelOperation")
    .mockResolvedValue({ phase: "preparing", requested: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = await renderComponent(null, { container: host });
  const control = (label: string) => {
    const result = [
      ...document.body.querySelectorAll<HTMLButtonElement>("button, [role=option]"),
    ].find((button) => button.textContent?.includes(label));
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  };
  const click = async (label: string) => {
    await userEvent.click(control(label));
  };
  try {
    await root.rerender(
      <SourceDiscoveryButton generation={7} profiles={[profile]} disabled={false} />,
    );
    await click("Find required files");
    await click("Choose folder");
    await page.getByRole("combobox", { name: /^Required files/ }).click();
    await click("Owned game source");
    await click("Search this folder");
    await click("Cancel operation");
    expect(cancel).toHaveBeenCalledWith("search-operation");
    expect(control("Close").disabled).toBe(true);
    stopSearch({ code: "cancelled", message: "Operation cancelled before publication" });
    await expect
      .poll(() => document.body.textContent)
      .toContain("Operation cancelled. No unverified source was registered.");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await cleanup();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

vi.mock("../file-picker", { spy: true });

const { plan } = sourceImportFixtures();
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["copy", "move", "use_current_location"] as const)(
  "keeps the known %s review actionable",
  async (mode) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const apply = vi.fn().mockResolvedValue(undefined);
    try {
      await act(async () =>
        root.render(
          <SourceImportReview plan={plan(mode)} busy={false} onApply={apply} onCancel={vi.fn()} />,
        ),
      );
      expect(host.textContent).toContain(sourceImportModePresentation(mode).explanation);
      expect(host.textContent).toContain(plan(mode).destination);
      expect(host.textContent).toContain(
        mode === "use_current_location" ? "Saved file location" : "Portcove game-file folder",
      );
      const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === sourceImportModePresentation(mode).label,
      );
      expect(action?.dataset.variant).toBe(mode === "move" ? "destructive" : "primary");
      await act(async () => action!.click());
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([
  { theme: "dark", width: 960, height: 640 },
  { theme: "light", width: 960, height: 640 },
  { theme: "dark", width: 430, height: 780 },
  { theme: "light", width: 430, height: 780 },
] as const)(
  "separates discovery controls and preliminary results in $theme at $width",
  async ({ theme, width, height }) => {
    const incoming = {
      theme: document.documentElement.dataset.theme,
      width: innerWidth,
      height: innerHeight,
    };
    const profile: SourceProfile = {
      id: "owned",
      label: "Owned disc files checked by the upstream game-data extractor",
      kind: "upstream-validated-disc",
      accepted_extensions: ["iso"],
      accepted_sha1: [],
      accepted_sha256: [],
      disc: null,
      members: [],
    };
    const { source } = sourceImportFixtures();
    const rootPath = "D:/Synthetic discovery presentation/Original game files";
    const report: SourceDiscoveryReport = {
      searched_roots: [rootPath],
      searched_profiles: [profile.id],
      candidates: [],
      preliminary_selections: [
        {
          profile_id: profile.id,
          path: source.path,
          observed_digests: [],
          components: [],
          validator: {
            contract_id: "owned-disc-v1",
            tool_id: "owned-validator",
            protocol_version: "1",
            result: "not_run",
          },
          assessment: {
            health: "not_baselined",
            classification: { state: "not_evaluated" },
            contract: { state: "not_evaluated" },
            admission: { state: "admitted", mode: "structural_checks" },
            evidence: [],
          },
          record: source,
          message: "Synthetic preliminary selection; validation has not run",
        },
      ],
      entries_examined: 1,
      files_hashed: 0,
      hash_bytes: 0,
      symlinks_skipped: 0,
      limits_reached: [],
      issues: [],
      issues_omitted: 0,
    };
    vi.mocked(picker.pickInstallFolder).mockResolvedValue(rootPath);
    const discover = vi.spyOn(desktopApi, "discoverSources").mockResolvedValue(report);
    const imported = vi
      .spyOn(desktopApi, "importSource")
      .mockRejectedValue(new Error("Import must require a reviewed choice"));
    const host = document.createElement("div");
    document.body.append(host);
    const rendered = await renderComponent(null, { container: host });
    try {
      await page.viewport(width, height);
      document.documentElement.dataset.theme = theme;
      await rendered.rerender(
        <SourceDiscoveryButton generation={7} profiles={[profile]} disabled={false} />,
      );
      await page.getByRole("button", { name: "Find required files", exact: true }).click();
      const dialog = page
        .getByRole("dialog", { name: "Find required files", exact: true })
        .element();
      await document.fonts.ready;
      expect(dialog.textContent).not.toContain("REQUIRED FILES");
      expect(dialog.getAttribute("aria-describedby")).toBe("source-discovery-description");
      const select = dialog.querySelector<HTMLElement>("#source-profile-select")!;
      const inboxActions = dialog.querySelector<HTMLElement>(".source-inbox-actions")!;
      const folderLabel = [...dialog.querySelectorAll("label")].find(
        (item) => item.textContent === "Search folder",
      )!;
      const folderInput = dialog.querySelector<HTMLInputElement>("#source-search-root")!;
      const stores = dialog.querySelector<HTMLElement>(
        '[aria-label="Games installed by Steam, GOG or Epic"]',
      )!;
      expect(
        inboxActions.getBoundingClientRect().top - select.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(8);
      expect(
        folderLabel.getBoundingClientRect().top - inboxActions.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(16);
      expect(
        stores.getBoundingClientRect().top -
          folderInput.parentElement!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(8);
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
      await captureParityState("source-discovery-rhythm-controls");
      await page.getByRole("combobox", { name: /^Required files/ }).click();
      await page.getByRole("option", { name: profile.label, exact: true }).click();
      await page.getByRole("button", { name: "Choose folder", exact: true }).click();
      await page.getByRole("button", { name: "Search this folder", exact: true }).click();
      const preliminary = page
        .getByRole("heading", { name: "Preliminary selections", exact: true })
        .element();
      const summary = [...dialog.querySelectorAll("p")].find((item) =>
        item.textContent?.startsWith("Found no exact matches."),
      )!;
      expect(
        preliminary.getBoundingClientRect().top - summary.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(16);
      expect(
        preliminary.nextElementSibling!.getBoundingClientRect().top -
          preliminary.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(8);
      expect(preliminary.parentElement?.textContent).toContain("Validation has not run");
      expect(discover).toHaveBeenCalledWith(
        {
          roots: [rootPath],
          profile_ids: [profile.id],
          limits: {
            max_entries: 10_000,
            max_depth: 6,
            max_file_bytes: 2 * 1024 * 1024 * 1024,
            max_hash_bytes: 16 * 1024 * 1024 * 1024,
            max_candidates: 64,
          } satisfies SourceDiscoveryLimits,
        },
        expect.any(Function),
      );
      expect(imported).not.toHaveBeenCalled();
      preliminary.scrollIntoView({ block: "center" });
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
      await captureParityState("source-discovery-rhythm-preliminary");
      const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!;
      footer.scrollIntoView({ block: "center", behavior: "instant" });
      const actions = [...footer.querySelectorAll<HTMLButtonElement>("button")];
      expect(actions.map((action) => action.textContent)).toEqual(["Close", "Search this folder"]);
      const dialogBounds = dialog.getBoundingClientRect();
      for (const action of actions) {
        const bounds = action.getBoundingClientRect();
        requireCompleteCaptureTarget(
          {
            target: action.textContent,
            target_count: 1,
            visible: action.checkVisibility(),
            rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
            viewport: { width: innerWidth, height: innerHeight },
          },
          action.textContent,
        );
        expect(bounds.left).toBeGreaterThanOrEqual(dialogBounds.left);
        expect(bounds.right).toBeLessThanOrEqual(dialogBounds.right);
        expect(bounds.top).toBeGreaterThanOrEqual(dialogBounds.top);
        expect(bounds.bottom).toBeLessThanOrEqual(dialogBounds.bottom);
      }
      if (width === 430) await captureParityState("source-discovery-rhythm-preliminary-footer");
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => document.activeElement?.textContent).toBe("Find required files");
    } finally {
      await cleanup();
      host.remove();
      vi.restoreAllMocks();
      if (incoming.theme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = incoming.theme;
      await page.viewport(incoming.width, incoming.height);
    }
  },
);
