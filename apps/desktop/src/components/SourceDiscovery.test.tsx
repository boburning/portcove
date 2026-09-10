// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type {
  SourceDiscoveryReport,
  SourceImportPlan,
  SourceProfile,
} from "../types";
import { SourceDiscoveryButton } from "./SourceDiscovery";

it("opens and scans the Inbox, then applies the exact reviewed import", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  const candidate = {
    profile_id: profile.id,
    path: "D:/Selected/game.iso",
    sha256: "a".repeat(64),
    size: 64,
    storage_sha256: "a".repeat(64),
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
    limits_reached: [],
    issues: [],
    issues_omitted: 0,
  };
  const plan: SourceImportPlan = {
    schema_version: 1,
    profile_id: profile.id,
    mode: "copy",
    source: candidate,
    admission_mode: "structural_checks",
    destination: "D:/Library/source-inbox/test/game.iso",
    destination_exists: false,
    existing_registration: null,
    reuse_existing: false,
    required_bytes: 64,
    source_guard_sha256: "b".repeat(64),
    plan_sha256: "c".repeat(64),
  };
  vi.spyOn(picker, "pickInstallFolder")
    .mockResolvedValueOnce(null)
    .mockResolvedValue("D:/Selected");
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
        state: "unresolved",
        selected: null,
        candidates: [],
        stats: {
          entries_examined: 0,
          candidates_inspected: 0,
          hash_bytes: 0,
          symlinks_skipped: 0,
          limits_reached: [],
          issues: [],
          issues_omitted: 0,
        },
      };
    });
  const search = vi
    .spyOn(desktopApi, "discoverSources")
    .mockResolvedValue(report);
  const review = vi
    .spyOn(desktopApi, "planSourceImport")
    .mockRejectedValueOnce({ message: "Source changed after discovery" })
    .mockResolvedValue(plan);
  const importSource = vi
    .spyOn(desktopApi, "importSource")
    .mockImplementation(async (_profile, _path, _mode, _plan, emit) => {
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
  const refresh = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const control = (label: string) => {
    const result = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
      ...document.querySelectorAll<HTMLButtonElement>(".choice-menu button"),
    ].find((button) => button.textContent?.includes(label));
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  };
  const click = async (label: string) => {
    await act(async () => control(label).click());
  };
  try {
    await act(async () =>
      root.render(
        <SourceDiscoveryButton
          profiles={[profile]}
          disabled={false}
          onAdded={refresh}
        />,
      ),
    );
    await click("Find source files");
    await click("Choose folder");
    expect(control("Search this folder").disabled).toBe(true);
    await click("Choose folder");
    await click("Required source");
    await click("Owned game source");
    await click("Open Source Inbox");
    expect(openInbox).toHaveBeenCalledWith(profile.id);
    await click("Scan Source Inbox");
    expect(scanInbox).toHaveBeenCalledWith(
      profile.id,
      expect.objectContaining({ max_entries: 10_000, max_candidates: 64 }),
      expect.any(Function),
    );
    expect(host.textContent).toContain("Inbox state: unresolved");
    await click("Search this folder");
    expect(search).toHaveBeenCalledWith(
      { roots: ["D:/Selected"], profile_ids: [profile.id] },
      expect.any(Function),
    );
    await click("Review copy");
    expect(review).toHaveBeenCalledWith(profile.id, candidate.path, "copy");
    expect(host.textContent).toContain("Source changed after discovery");
    await click("Review copy");
    expect(host.textContent).toContain(plan.destination);
    await click("Copy to Inbox");
    expect(importSource).toHaveBeenCalledWith(
      profile.id,
      candidate.path,
      "copy",
      plan.plan_sha256,
      expect.any(Function),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Source registered");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it("keeps cancellation tied to the emitted durable operation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  vi.spyOn(picker, "pickInstallFolder").mockResolvedValue("D:/Selected");
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
  const root = createRoot(host);
  const control = (label: string) => {
    const result = [
      ...host.querySelectorAll<HTMLButtonElement>("button"),
      ...document.querySelectorAll<HTMLButtonElement>(".choice-menu button"),
    ].find((button) => button.textContent?.includes(label));
    if (!result) throw new Error(`Missing ${label}`);
    return result;
  };
  const click = async (label: string) => {
    await act(async () => control(label).click());
  };
  try {
    await act(async () =>
      root.render(
        <SourceDiscoveryButton profiles={[profile]} disabled={false} />,
      ),
    );
    await click("Find source files");
    await click("Choose folder");
    await click("Required source");
    await click("Owned game source");
    await click("Search this folder");
    await click("Cancel operation");
    expect(cancel).toHaveBeenCalledWith("search-operation");
    expect(control("Close").disabled).toBe(true);
    await act(async () =>
      stopSearch({
        code: "cancelled",
        message: "Operation cancelled before publication",
      }),
    );
    expect(host.textContent).toContain(
      "Operation cancelled. No unverified source was registered.",
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
