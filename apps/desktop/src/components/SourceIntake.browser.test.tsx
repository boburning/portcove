import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type {
  HostToolStatus,
  SourceImportPlan,
  SourceImportResult,
  SourceInspectionReport,
  SourceIntakeInspection,
  SourceProfile,
  SourceRecord,
} from "../types";
import { SourceIntakeDialog, type SourceIntakeRequest } from "./SourceIntake";
import { PreparationControl, type RunPreparation } from "./Preparation";
import { preparation } from "../dev-scenarios/interactive/scenarios";

const profile: SourceProfile = {
  id: "game",
  label: "Owned game source",
  kind: "file",
  accepted_extensions: ["z64"],
  accepted_sha1: [],
  accepted_sha256: [],
  disc: null,
  members: [],
};
const record = (path: string): SourceRecord => ({
  profile_id: profile.id,
  path,
  sha256: "a".repeat(64),
  size: 64,
  storage_sha256: "a".repeat(64),
  storage_size: 64,
  updated_at: 1,
});
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
    assessment: {
      health: "not_baselined",
      classification: { state: "unrecognized" },
      contract: { state: "not_evaluated" },
      admission: { state: "admitted", mode: "exact_identity" },
      evidence: [],
    },
    record: record(path),
    message: "exact",
  },
  applications: [],
  evidence: [],
  legacy: {
    registration_identity_not_recorded: false,
    variant_unspecified_records: [],
  },
});
const intake = (path: string): SourceIntakeInspection => ({
  schema_version: 1,
  profile_id: profile.id,
  input_count: 1,
  state_code: "recognized_exact",
  summary: "Exact",
  next_action: "Choose how to add it.",
  report: report(path),
});
const request = (
  paths: string[],
  purpose: SourceIntakeRequest["purpose"] = "game",
  selectedProfile: SourceProfile = profile,
): SourceIntakeRequest => ({
  portId: "port",
  portName: "Example Port",
  profile: selectedProfile,
  purpose,
  paths,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("source intake dialog", () => {
  let host: HTMLDivElement;
  let root: RenderResult;
  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = await renderComponent(null, { container: document.body.appendChild(host) });
  });
  afterEach(async () => {
    await cleanup();
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const button = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(label),
    );

  const prepareImport = () => {
    vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue(intake("D:/Game.z64"));
    const plan: SourceImportPlan = {
      schema_version: 1,
      profile_id: profile.id,
      mode: "copy",
      source: record("D:/Game.z64"),
      admission_mode: "exact_identity",
      destination: "D:/Inbox/Game.z64",
      destination_exists: false,
      existing_registration: null,
      reuse_existing: false,
      required_bytes: 64,
      source_guard_sha256: "b".repeat(64),
      plan_sha256: "c".repeat(64),
    };
    vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue(plan);
    const imported: SourceImportResult = {
      import_id: "owned-import",
      profile_id: profile.id,
      mode: "copy",
      outcome: "copied",
      registered: record(plan.destination),
      copied: true,
      original_deleted: false,
      original_retained: true,
      retained_original_path: plan.source.path,
      recovered: false,
    };
    return vi.spyOn(desktopApi, "importSource").mockResolvedValue(imported);
  };
  const openImportReview = async (onAdded: () => Promise<unknown>) => {
    await root.rerender(
      <SourceIntakeDialog request={request(["D:/Game.z64"])} close={vi.fn()} onAdded={onAdded} />,
    );
    await act(async () => button("Copy into Portcove")!.click());
    const renderedReview = document.body.querySelector('[aria-label="Source import review"]');
    expect(renderedReview?.textContent).toContain(profile.label);
    expect(renderedReview?.textContent).toContain("Source check: Exact identity");
  };

  it("does not carry a cancelled Move review into another game's preparation or a later Move approval", async () => {
    const imported = prepareImport();
    let reviewNumber = 0;
    const preview = vi
      .spyOn(desktopApi, "planSourceImport")
      .mockImplementation(async (_profile, path, mode) => ({
        schema_version: 1,
        profile_id: profile.id,
        mode,
        source: record(path),
        admission_mode: "exact_identity",
        destination: "D:/Inbox/Game.z64",
        destination_exists: false,
        existing_registration: null,
        reuse_existing: false,
        required_bytes: 64,
        source_guard_sha256: "b".repeat(64),
        plan_sha256: `move-review-${++reviewNumber}`,
      }));
    const added = vi.fn(async () => undefined);
    const openMove = async () => {
      await root.rerender(
        <SourceIntakeDialog request={request(["D:/Game.z64"])} close={vi.fn()} onAdded={added} />,
      );
      await page.getByRole("button", { name: "Review move", exact: true }).click();
      await expect
        .element(page.getByRole("region", { name: "Source import review", exact: true }))
        .toBeVisible();
      expect(preview.mock.lastCall).toEqual([profile.id, "D:/Game.z64", "move"]);
    };
    await openMove();
    await captureParityState("source-move-initial-review-fixture");
    await page.getByRole("button", { name: "Cancel review", exact: true }).click();
    expect(imported).not.toHaveBeenCalled();

    vi.spyOn(desktopApi, "planPreparation").mockResolvedValue({
      ...preparation,
      port_id: "other-port",
    });
    const run = vi.fn<RunPreparation>(async () => preparation.inputs.install);
    await root.rerender(
      <PreparationControl
        portId="other-port"
        taskLabel="Other game"
        generation={7}
        disabled={false}
        run={run}
      />,
    );
    await page.getByRole("button", { name: "Review setup", exact: true }).click();
    const prepare = page.getByRole("button", { name: "Prepare game data", exact: true });
    await expect.element(prepare).toBeEnabled();
    await prepare.click();
    await expect.poll(() => run.mock.calls.length).toBe(1);
    expect(run.mock.calls[0]?.[0]).toBe(preparation.plan_sha256);
    expect(imported).not.toHaveBeenCalled();

    // A later Move needs a new reviewed fingerprint and its own native approval.
    await openMove();
    expect(reviewNumber).toBe(2);
    await captureParityState("source-move-new-approval-required-fixture");
    expect(imported).not.toHaveBeenCalled();
    imported.mockResolvedValueOnce(null);
    await page.getByRole("button", { name: "Move into Portcove", exact: true }).click();
    await expect.poll(() => imported.mock.calls.length).toBe(1);
    expect(imported.mock.calls[0]?.slice(0, 4)).toEqual([
      profile.id,
      "D:/Game.z64",
      "move",
      "move-review-2",
    ]);
    expect(added).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Move cancelled");
    await captureParityState("source-move-second-consent-declined-fixture");
  });

  it("preserves a committed import when its workspace refresh fails", async () => {
    const imported = prepareImport();
    const refresh = vi.fn().mockRejectedValue(new Error("owned refresh failure"));
    await openImportReview(refresh);
    await act(async () => button("Copy into Portcove")!.click());

    expect(imported).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("the files were already added");
    expect(document.body.textContent).toContain("Use Retry refresh");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
    expect(button("Close")!.disabled).toBe(false);
    expect(button("Copy into Portcove")).toBeUndefined();
    await captureParityState("source-import-refresh-failed-fixture");
    refresh.mockResolvedValue(undefined);
    await act(async () => button("Retry refresh")!.click());
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(imported).toHaveBeenCalledOnce();
    expect(button("Return to game")!.disabled).toBe(false);
    expect(button("Retry refresh")).toBeUndefined();
  });

  it("offers a return after saving and prevents a repeated import", async () => {
    const imported = prepareImport();
    const refresh = vi.fn().mockResolvedValue(undefined);
    await openImportReview(refresh);
    await act(async () => button("Copy into Portcove")!.click());
    expect(imported).toHaveBeenCalledOnce();
    expect(button("Return to game")!.disabled).toBe(false);
    expect(button("Copy into Portcove")).toBeUndefined();
    expect(button("Use current location")).toBeUndefined();
  });

  it("returns focus to the current same-game action when saving replaces its opener", async () => {
    prepareImport();
    function RepairFixture() {
      const [open, setOpen] = useState(false);
      const [ready, setReady] = useState(false);
      return (
        <>
          {ready ? (
            <button id="current-game-action">Play</button>
          ) : (
            <button onClick={() => setOpen(true)}>Select game files</button>
          )}
          {open && (
            <SourceIntakeDialog
              request={request(["D:/Game.z64"])}
              close={() => setOpen(false)}
              onAdded={async () => setReady(true)}
              returnFocus={() => document.getElementById("current-game-action")}
            />
          )}
        </>
      );
    }
    await root.rerender(<RepairFixture />);
    await page.getByRole("button", { name: "Select game files" }).click();
    await act(async () => button("Copy into Portcove")!.click());
    await act(async () => button("Copy into Portcove")!.click());
    expect(button("Select game files")).toBeUndefined();
    await page.getByRole("button", { name: "Return to game" }).click();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById("current-game-action")),
    );
  });

  it("keeps a genuine import failure separate from a refresh failure", async () => {
    prepareImport().mockRejectedValue(new Error("owned import failure"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    await openImportReview(refresh);
    await act(async () => button("Copy into Portcove")!.click());

    expect(refresh).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("the files were already added");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "owned import failure",
    );
    await captureParityState("source-import-failed-fixture");
    expect(button("Close")!.disabled).toBe(false);
  });

  it("keeps a cancelled import separate from a refresh failure", async () => {
    prepareImport().mockResolvedValue(null);
    const refresh = vi.fn().mockResolvedValue(undefined);
    await openImportReview(refresh);
    await act(async () => button("Copy into Portcove")!.click());

    expect(refresh).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("the files were already added");
    expect(document.body.textContent).toContain("Move cancelled");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    await captureParityState("source-import-cancelled-fixture");
    expect(button("Close")!.disabled).toBe(false);
  });

  it("ignores an obsolete post-import refresh rejection after the intake session changes", async () => {
    const imported = prepareImport();
    let rejectRefresh!: (error: Error) => void;
    const refresh = vi.fn(() => new Promise((_, reject) => (rejectRefresh = reject)));
    await openImportReview(refresh);
    await act(async () => button("Copy into Portcove")!.click());
    expect(refresh).toHaveBeenCalledOnce();
    await root.rerender(<SourceIntakeDialog request={request(["D:/Other.z64"])} close={vi.fn()} />);
    await act(async () => rejectRefresh(new Error("obsolete refresh failure")));

    expect(imported).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("obsolete refresh failure");
    expect(document.body.textContent).not.toContain("the files were already added");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a native drop read-only until a separately labeled import review", async () => {
    const inspect = vi
      .spyOn(desktopApi, "inspectSourceIntake")
      .mockResolvedValue(intake("D:/Game.z64"));
    const plan = vi.spyOn(desktopApi, "planSourceImport");
    const apply = vi.spyOn(desktopApi, "importSource");

    await root.rerender(<SourceIntakeDialog request={request(["D:/Game.z64"])} close={vi.fn()} />);

    expect(inspect).toHaveBeenCalledWith(profile.id, ["D:/Game.z64"]);
    expect(document.body.textContent).toContain("Checking won't change them.");
    expect(document.body.textContent).toContain("Choose how to add these files.");
    expect(button("Copy into Portcove")).toBeDefined();
    expect(button("Use current location")).toBeDefined();
    expect(button("Review move")).toBeDefined();
    await captureParityState("source-intake-readonly-fixture");
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("shows the core multi-path result without offering a mutation", async () => {
    vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue({
      schema_version: 1,
      profile_id: profile.id,
      input_count: 2,
      state_code: "multiple_paths",
      summary: "Choose one source.",
      next_action: "Try again.",
    });

    await root.rerender(
      <SourceIntakeDialog request={request(["D:/One.z64", "D:/Two.z64"])} close={vi.fn()} />,
    );

    expect(document.body.textContent).toContain("Choose one source.");
    expect(button("Copy into Portcove")).toBeUndefined();
    expect(document.body.textContent).toContain("Try again.");
    expect(document.body.textContent).not.toContain("Choose how to add them.");
    await captureParityState("source-intake-multiple-paths-fixture");
  });

  it("keeps pending validation guidance distinct from an accepted match", async () => {
    const pending = intake("D:/Needs-upstream-check.iso");
    pending.state_code = "selected_needs_checking";
    pending.next_action = "Complete the remaining file check during reviewed setup.";
    pending.report!.state_code = pending.state_code;
    pending.report!.next_action = pending.next_action;
    vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue(pending);
    await root.rerender(
      <SourceIntakeDialog request={request(["D:/Needs-upstream-check.iso"])} close={vi.fn()} />,
    );
    expect(document.body.textContent).toContain(pending.next_action);
    await captureParityState("source-intake-validation-pending-fixture");
    expect(document.body.textContent).not.toContain("Choose how to add these files.");
    expect(button("Copy into Portcove")).toBeDefined();
  });

  it.each(["future_mode", "constructor", "__proto__"])(
    "leaves an unfamiliar %s plan cancellable without importing",
    async (mode) => {
      vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue(intake("D:/Game.z64"));
      const plan: SourceImportPlan = {
        schema_version: 1,
        profile_id: profile.id,
        mode: mode as SourceImportPlan["mode"],
        source: record("D:/Game.z64"),
        admission_mode: "structural_checks",
        destination: "D:/Inbox/Game.z64",
        destination_exists: false,
        existing_registration: null,
        reuse_existing: false,
        required_bytes: 64,
        source_guard_sha256: "b".repeat(64),
        plan_sha256: "c".repeat(64),
      };
      vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue(plan);
      const apply = vi.spyOn(desktopApi, "importSource");
      await root.rerender(
        <SourceIntakeDialog request={request(["D:/Game.z64"])} close={vi.fn()} />,
      );
      await act(async () => button("Copy into Portcove")!.click());
      expect(document.body.textContent).toContain("Import method unavailable");
      expect(
        document.body.querySelector(
          'section[aria-label="Source import review"] button:not([data-variant="outline"])',
        ),
      ).toBeNull();
      await act(async () => button("Cancel review")!.click());
      expect(button("Copy into Portcove")).toBeDefined();
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it("offers the matching preparation tool inline and rechecks the unchanged selection", async () => {
    const missing: SourceIntakeInspection = {
      schema_version: 1,
      profile_id: profile.id,
      input_count: 1,
      state_code: "unsupported_shape",
      summary: "A preparation tool is required.",
      next_action: "Locate the tool and check again.",
      problem: {
        code: "source_invalid",
        message: "chdman is required",
        tool_id: "chdman",
      },
    };
    const tool: HostToolStatus = {
      id: "chdman",
      display_name: "chdman",
      state: "missing",
      path: null,
      source: null,
      configuration_variable: "PORTCOVE_CHDMAN",
      purpose: "Check CHD game files and prepare disc images",
      official_url: "https://docs.mamedev.org/tools/chdman.html",
    };
    const inspect = vi
      .spyOn(desktopApi, "inspectSourceIntake")
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(intake("D:/Game.chd"));
    const locate = vi.fn().mockResolvedValue({
      tool_id: "chdman",
      path: "C:/Tools/chdman.exe",
      state: "success",
      message: "Ready",
      persisted: true,
      retry_action: "",
      clear_action_available: true,
    });

    await root.rerender(
      <SourceIntakeDialog
        request={request(["D:/Game.chd"])}
        close={vi.fn()}
        hostTools={[tool]}
        hostToolActions={{
          locate,
          clear: vi.fn(),
          recheck: vi.fn(),
          openOfficial: vi.fn(),
        }}
      />,
    );

    expect(document.body.textContent).toContain("Preparation tool needed");
    expect(document.body.textContent).toContain("Your selected game files remain unchanged.");
    expect(document.body.textContent).not.toContain("Technical ID");
    await captureParityState("source-tool-needed-fixture");
    await act(async () => button("Locate chdman…")!.click());
    expect(locate).toHaveBeenCalledWith(tool);
    expect(inspect).toHaveBeenNthCalledWith(2, profile.id, ["D:/Game.chd"]);
    expect(button("Copy into Portcove")).toBeDefined();
    await captureParityState("source-tool-rechecked-fixture");
  });

  it("ignores an older inspection and an older error after the selected path changes", async () => {
    const old = deferred<SourceIntakeInspection>();
    const current = deferred<SourceIntakeInspection>();
    vi.spyOn(desktopApi, "inspectSourceIntake")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await root.rerender(<SourceIntakeDialog request={request(["D:/Old.z64"])} close={vi.fn()} />);
    await root.rerender(
      <SourceIntakeDialog request={request(["D:/Current.z64"])} close={vi.fn()} />,
    );
    await act(async () => {
      current.resolve(intake("D:/Current.z64"));
      await current.promise;
    });
    expect(document.body.textContent).toContain("D:/Current.z64");
    await act(async () => {
      old.resolve({
        schema_version: 1,
        profile_id: profile.id,
        input_count: 1,
        state_code: "unsupported_shape",
        summary: "Old unsupported result",
        next_action: "Old action",
      });
      await old.promise;
    });
    expect(document.body.textContent).not.toContain("Old unsupported result");
    expect(document.body.textContent).toContain("D:/Current.z64");
  });

  it("provides the always-visible keyboard path and treats picker cancellation neutrally", async () => {
    vi.mocked(picker.pickSourcePath)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("D:/Keyboard.z64");
    const inspect = vi
      .spyOn(desktopApi, "inspectSourceIntake")
      .mockResolvedValue(intake("D:/Keyboard.z64"));
    await act(
      async () => await root.rerender(<SourceIntakeDialog request={request([])} close={vi.fn()} />),
    );
    expect(button("Choose game files to check")?.getAttribute("data-variant")).toBe("primary");
    await act(async () => button("Choose game files to check")!.click());
    expect(document.body.textContent).toContain("File selection cancelled. Nothing was changed.");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Choose game files to check")!.click());
    expect(inspect).toHaveBeenCalledWith(profile.id, ["D:/Keyboard.z64"]);
  });

  it("keeps BIOS identity through the intake chooser and visible check copy", async () => {
    const biosProfile: SourceProfile = {
      ...profile,
      id: "psx-scph-1001-bios",
      label: "PlayStation SCPH-1001 BIOS",
      accepted_extensions: ["bin", "rom"],
      accepted_sha1: ["10155d8d6e6e832d6ea66db9bc098321fb5e8ebf"],
      accepted_sha256: ["71af94d1e47a68c11e8fdb9f8368040601514a42a5a399cda48c7d3bff1e99d3"],
    };
    const choose = vi.mocked(picker.pickSourcePath).mockResolvedValue(null);
    await root.rerender(
      <SourceIntakeDialog request={request([], "bios", biosProfile)} close={vi.fn()} />,
    );

    expect(document.body.textContent).toContain("Check BIOS for Example Port");
    expect(button("Choose BIOS file to check")).toBeDefined();
    await captureParityState("source-intake-bios-selection-fixture");
    await act(async () => button("Choose BIOS file to check")!.click());
    expect(choose).toHaveBeenCalledWith(biosProfile, "", "bios");
    expect(document.body.textContent).toContain("File selection cancelled. Nothing was changed.");
  });

  it("restores focus to the details action after the intake dialog closes", async () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Check original game files
          </button>
          {open && <SourceIntakeDialog request={request([])} close={() => setOpen(false)} />}
        </>
      );
    }
    await root.rerender(<Fixture />);
    const opener = button("Check original game files")!;
    opener.focus();
    await act(async () => opener.click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => button("Close")!.click());
    expect(document.activeElement).toBe(opener);
  });
});

vi.mock("../file-picker", { spy: true });
