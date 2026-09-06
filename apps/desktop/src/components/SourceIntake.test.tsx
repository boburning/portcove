// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { HostToolStatus, SourceInspectionReport, SourceIntakeInspection, SourceProfile, SourceRecord } from "../types";
import { SourceIntakeDialog, type SourceIntakeRequest } from "./SourceIntake";

const profile: SourceProfile = { id: "game", label: "Owned game source", kind: "file", accepted_extensions: ["z64"], accepted_sha1: [], accepted_sha256: [], members: [] };
const record = (path: string): SourceRecord => ({ profile_id: profile.id, path, sha256: "a".repeat(64), size: 64, storage_sha256: "a".repeat(64), storage_size: 64, updated_at: 1 });
const report = (path: string): SourceInspectionReport => ({
  schema_version: 1,
  profile_id: profile.id,
  health: "not_baselined",
  state_code: "recognized_exact",
  summary: "The selected files are an exact supported match.",
  next_action: "Choose how to add them.",
  inspection: {
    profile_id: profile.id,
    path,
    observed_digests: [],
    components: [],
    assessment: { health: "not_baselined", classification: { state: "unrecognized" }, contract: { state: "not_evaluated" }, admission: { state: "admitted", mode: "exact_identity" }, evidence: [] },
    record: record(path),
    message: "exact",
  },
  applications: [], evidence: [], legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
});
const intake = (path: string): SourceIntakeInspection => ({ schema_version: 1, profile_id: profile.id, input_count: 1, state_code: "recognized_exact", summary: "Exact", next_action: "Choose how to add it.", report: report(path) });
const request = (paths: string[]): SourceIntakeRequest => ({ portId: "port", portName: "Example Port", profile, paths });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("source intake dialog", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.includes(label));

  it("keeps a native drop read-only until a separately labeled import review", async () => {
    const inspect = vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue(intake("D:/Game.z64"));
    const plan = vi.spyOn(desktopApi, "planSourceImport");
    const apply = vi.spyOn(desktopApi, "importSource");

    await act(async () => root.render(<SourceIntakeDialog request={request(["D:/Game.z64"])} close={vi.fn()} />));

    expect(inspect).toHaveBeenCalledWith(profile.id, ["D:/Game.z64"]);
    expect(host.textContent).toContain("Checking does not install, register, copy, move, replace, or delete anything.");
    expect(button("Copy to Source Inbox")).toBeDefined();
    expect(button("Use current location")).toBeDefined();
    expect(button("Review destructive move")).toBeDefined();
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("shows the core multi-path result without offering a mutation", async () => {
    vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue({ schema_version: 1, profile_id: profile.id, input_count: 2, state_code: "multiple_paths", summary: "Choose one source.", next_action: "Try again." });

    await act(async () => root.render(<SourceIntakeDialog request={request(["D:/One.z64", "D:/Two.z64"])} close={vi.fn()} />));

    expect(host.textContent).toContain("Choose one source.");
    expect(button("Copy to Source Inbox")).toBeUndefined();
  });

  it("offers the matching preparation tool inline and rechecks the unchanged selection", async () => {
    const missing: SourceIntakeInspection = {
      schema_version: 1,
      profile_id: profile.id,
      input_count: 1,
      state_code: "unsupported_shape",
      summary: "A preparation tool is required.",
      next_action: "Locate the tool and check again.",
      problem: { code: "source_invalid", message: "chdman is required", tool_id: "chdman" },
    };
    const tool: HostToolStatus = {
      id: "chdman",
      display_name: "chdman",
      state: "missing",
      configuration_variable: "PORTCOVE_CHDMAN",
      purpose: "CHD validation and disc-image materialization",
      official_url: "https://docs.mamedev.org/tools/chdman.html",
    };
    const inspect = vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValueOnce(missing).mockResolvedValueOnce(intake("D:/Game.chd"));
    const locate = vi.fn().mockResolvedValue({ tool_id: "chdman", path: "C:/Tools/chdman.exe", state: "success", message: "Ready", persisted: true, retry_action: "", clear_action_available: true });

    await act(async () => root.render(<SourceIntakeDialog request={request(["D:/Game.chd"])} close={vi.fn()} hostTools={[tool]} hostToolActions={{
      locate,
      clear: vi.fn(),
      recheck: vi.fn(),
      openOfficial: vi.fn(),
    }} />));

    expect(host.textContent).toContain("Preparation tool needed");
    expect(host.textContent).toContain("Your selected game files remain unchanged.");
    expect(host.textContent).not.toContain("Technical ID");
    await act(async () => button("Locate executable")!.click());
    expect(locate).toHaveBeenCalledWith(tool);
    expect(inspect).toHaveBeenNthCalledWith(2, profile.id, ["D:/Game.chd"]);
    expect(button("Copy to Source Inbox")).toBeDefined();
  });

  it("ignores an older inspection and an older error after the selected path changes", async () => {
    const old = deferred<SourceIntakeInspection>();
    const current = deferred<SourceIntakeInspection>();
    vi.spyOn(desktopApi, "inspectSourceIntake").mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await act(async () => root.render(<SourceIntakeDialog request={request(["D:/Old.z64"])} close={vi.fn()} />));
    await act(async () => root.render(<SourceIntakeDialog request={request(["D:/Current.z64"])} close={vi.fn()} />));
    await act(async () => { current.resolve(intake("D:/Current.z64")); await current.promise; });
    expect(host.textContent).toContain("D:/Current.z64");
    await act(async () => { old.resolve({ schema_version: 1, profile_id: profile.id, input_count: 1, state_code: "unsupported_shape", summary: "Old unsupported result", next_action: "Old action" }); await old.promise; });
    expect(host.textContent).not.toContain("Old unsupported result");
    expect(host.textContent).toContain("D:/Current.z64");
  });

  it("provides the always-visible keyboard path and treats picker cancellation neutrally", async () => {
    vi.spyOn(picker, "pickSourcePath").mockResolvedValueOnce(null).mockResolvedValueOnce("D:/Keyboard.z64");
    const inspect = vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue(intake("D:/Keyboard.z64"));
    await act(async () => root.render(<SourceIntakeDialog request={request([])} close={vi.fn()} />));
    expect(button("Choose game files to check")).toBeDefined();
    await act(async () => button("Choose game files to check")!.click());
    expect(host.textContent).toContain("File selection cancelled. Nothing was changed.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Choose game files to check")!.click());
    expect(inspect).toHaveBeenCalledWith(profile.id, ["D:/Keyboard.z64"]);
  });

  it("restores focus to the details action after the intake dialog closes", async () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Check original game files</button>{open && <SourceIntakeDialog request={request([])} close={() => setOpen(false)} />}</>;
    }
    await act(async () => root.render(<Fixture />));
    const opener = button("Check original game files")!;
    opener.focus();
    await act(async () => opener.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => button("Close")!.click());
    expect(document.activeElement).toBe(opener);
  });
});
