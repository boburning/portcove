import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { InvocationOwnerProvider } from "../features/operations/invocation-owner";
import { OperationPresentationProvider } from "../features/operations/operation-presentation";
import { useOperationState } from "../features/operations/use-operation-state";
import * as picker from "../file-picker";
import App from "../App";
import { initializeLocalization, LocalizationProvider } from "../localization";
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
import { SourceRemovalControl } from "./SourceRemoval";
import { PreparationControl, type RunPreparation } from "./Preparation";
import { preparation, workspace } from "../dev-scenarios/interactive/scenarios";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";

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
  generation: 7,
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
    await page.viewport(1280, 800);
  });
  for (const label of ["The Legend of Zelda: Majora's Mask source", "Owned_source_".repeat(12)]) {
    it(`keeps the picker and source label inside the narrow dialog: ${label.slice(0, 45)}`, async () => {
      await page.viewport(320, 208);
      await root.rerender(
        <SourceIntakeDialog request={request([], "game", { ...profile, label })} close={vi.fn()} />,
      );
      const dialog = page.getByRole("dialog").element() as HTMLElement;
      const sourceLabel = page.getByText(label, { exact: true }).element();
      const pickerButton = page.getByRole("button", { name: "Choose game files to check" });
      for (const width of [320, 240]) {
        await page.viewport(width, 208);
        await expect.element(pickerButton).toBeEnabled();
        await expect.poll(() => dialog.scrollWidth - dialog.clientWidth).toBeLessThanOrEqual(1);
        const bounds = dialog.getBoundingClientRect();
        for (const element of [sourceLabel, pickerButton.element()]) {
          const rectangle = element.getBoundingClientRect();
          expect(rectangle.left).toBeGreaterThanOrEqual(bounds.left);
          expect(rectangle.right).toBeLessThanOrEqual(bounds.right);
        }
      }
    });
  }
  const button = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(label),
    );

  it("reveals its restored caller when background scrolling changes while the review is open", async () => {
    await page.viewport(320, 208);
    function ScrolledCallerFixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <div id="source-return-scroll" style={{ height: 120, overflow: "auto" }}>
            <div style={{ height: 800 }} />
            <button id="source-review-opener" onClick={() => setOpen(true)}>
              Check files
            </button>
            <div style={{ height: 400 }} />
          </div>
          {open && <SourceIntakeDialog request={request([])} close={() => setOpen(false)} />}
        </>
      );
    }
    await root.rerender(<ScrolledCallerFixture />);
    await page.getByRole("button", { name: "Check files", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    const owner = document.getElementById("source-return-scroll")!;
    const opener = document.getElementById("source-review-opener")!;
    expect(owner.scrollTop).toBeGreaterThan(0);
    // Native WebView zoom can reposition the background while the popup stays open.
    owner.scrollTop = 0;
    expect(opener.getBoundingClientRect().top).toBeGreaterThan(
      owner.getBoundingClientRect().bottom,
    );
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    await expect
      .poll(() => opener.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(owner.getBoundingClientRect().bottom);
    expect(opener.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      owner.getBoundingClientRect().top,
    );
  });

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
    expect(renderedReview?.textContent).toContain("File check: Edition identified");
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
      await expect
        .element(page.getByRole("heading", { name: "Move into Portcove", exact: true }))
        .toHaveFocus();
      expect(preview.mock.lastCall).toEqual([profile.id, "D:/Game.z64", "move"]);
    };
    await openMove();
    const review = document.querySelector<HTMLElement>('[aria-label="Source import review"]')!;
    expect(
      review.getBoundingClientRect().top -
        review.previousElementSibling!.getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(23);
    const reviewChildren = [...review.children];
    for (let index = 1; index < reviewChildren.length; index += 1) {
      expect(
        reviewChildren[index]!.getBoundingClientRect().top -
          reviewChildren[index - 1]!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(11);
    }
    await captureParityState("source-move-initial-review-fixture");
    const move = page.getByRole("button", { name: "Move into Portcove", exact: true });
    const cancelMove = page.getByRole("button", { name: "Cancel review", exact: true });
    move.element().scrollIntoView({ block: "center" });
    await expect.element(move).toBeVisible();
    await expect
      .poll(() =>
        [move.element(), cancelMove.element()].every((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.top >= 0 &&
            bounds.bottom <= innerHeight &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth
          );
        }),
      )
      .toBe(true);
    await captureParityState("source-move-initial-review-lower-fixture");
    await page.getByRole("button", { name: "Cancel review", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Review move", exact: true }))
      .toHaveFocus();
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
    await page
      .getByRole("region", { name: "Finish setup", exact: true })
      .getByRole("button", { name: "Finish setup", exact: true })
      .click();
    const prepare = page
      .getByRole("dialog")
      .getByRole("button", { name: "Finish setup", exact: true });
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

  it("retires a lost import reply and holds another write for that requirement", async () => {
    const imported = prepareImport().mockRejectedValue(new Error("Native reply interrupted"));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const remove = vi.spyOn(desktopApi, "removeSource");
    const sourceRequest = request(["D:/Game.z64"]);
    function Fixture() {
      const [open, setOpen] = useState(true);
      const operations = useOperationState({
        refresh,
        libraryGeneration: sourceRequest.generation,
      });
      return (
        <OperationPresentationProvider
          generation={sourceRequest.generation}
          pending={operations.pendingOperations}
          perform={operations.perform}
          sourceWriteOnHold={operations.sourceWriteOnHold}
        >
          <SourceRemovalControl
            source={record("D:/Game.z64")}
            generation={sourceRequest.generation}
            ports={[]}
            disabled={false}
          />
          {open && (
            <SourceIntakeDialog
              request={sourceRequest}
              close={() => setOpen(false)}
              onAdded={refresh}
            />
          )}
        </OperationPresentationProvider>
      );
    }
    await root.rerender(
      <InvocationOwnerProvider>
        <Fixture />
      </InvocationOwnerProvider>,
    );
    await act(async () => button("Copy into Portcove")!.click());
    await act(async () => button("Copy into Portcove")!.click());
    expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Restart Portcove to check the saved file location",
    );
    expect(document.body.textContent).not.toContain("the files were already added");
    await act(async () => button("Copy into Portcove")!.click());
    await act(async () => button("Copy into Portcove")!.click());
    expect(document.body.querySelector('[aria-label="Source import review"]')).toBeNull();
    expect(imported).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => button("Close")!.click());
    expect(button("Review saved location removal")?.disabled).toBe(true);
    await act(async () => button("Review saved location removal")!.click());
    expect(remove).not.toHaveBeenCalled();
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

  it("continues only after refresh and uses the saved copy rather than the picked path", async () => {
    const imported = prepareImport();
    const refresh = vi.fn().mockRejectedValueOnce(new Error("unavailable"));
    const continueSetup = vi.fn();
    await root.rerender(
      <SourceIntakeDialog
        request={{ ...request(["D:/Game.z64"]), setup: { channel: "stable", other: undefined } }}
        close={vi.fn()}
        onAdded={refresh}
        onContinueSetup={continueSetup}
      />,
    );
    await act(async () => button("Copy into Portcove")!.click());
    await act(async () => button("Copy into Portcove")!.click());
    expect(button("Continue setup")).toBeUndefined();
    refresh.mockResolvedValue(undefined);
    await act(async () => button("Retry refresh")!.click());
    await page.getByRole("button", { name: "Continue setup", exact: true }).click();
    expect(continueSetup).toHaveBeenCalledExactlyOnceWith(record("D:/Inbox/Game.z64"));
    expect(imported).toHaveBeenCalledOnce();
  });

  it.each(["matched originals", "no match", "newer BIOS check", "saved match"] as const)(
    "scopes the setup store lookup to the current action for %s",
    async (scenario) => {
      const folder = "D:/Steam/steamapps/common/Classic/Game";
      const selectedProfile = {
        ...profile,
        id: "dark-forces-pc-complete-installed-data",
        kind: "file-set" as const,
      };
      const newCheck = scenario === "newer BIOS check";
      const noMatch = scenario === "no match";
      const fromSaved = scenario === "saved match";
      const savedPath = "D:/Originals/Dark Forces";
      const scanId = "00000000-0000-4000-8000-000000000007";
      const savedMatches = vi.spyOn(desktopApi, "gameFileScanMatches");
      if (fromSaved) {
        vi.spyOn(desktopApi, "gameFileScanSnapshot").mockResolvedValue({
          format_version: 13,
          catalog_sha256: "a".repeat(64),
          completed_at: 1,
          freshness: "inputs_match",
          limits: null,
          roots: [],
          report: {
            searched_roots: [],
            searched_profiles: [selectedProfile.id],
            candidates: [],
            entries_examined: 64,
            files_hashed: 32,
            hash_bytes: 1024,
            symlinks_skipped: 0,
            limits_reached: [],
            issues: [],
            issues_omitted: 0,
          },
          matches: {
            scan_id: scanId,
            exact_matches: 128,
            preliminary_selections: 0,
            preview_complete: false,
          },
        });
        savedMatches.mockResolvedValue({
          scan_id: scanId,
          offset: 0,
          kind: "exact",
          total: 1,
          next_offset: null,
          candidates: [{ ...record(savedPath), profile_id: selectedProfile.id }],
          preliminary_selections: [],
        });
      }
      const bios = { ...profile, id: "bios", label: "Fixture BIOS" };
      const storeReport = {
        checked_stores: ["steam"],
        skipped_entries: 0,
        limited: false,
        installs: [
          {
            store: "steam",
            title: "Dark Forces",
            path: "D:/Steam/steamapps/common/Classic",
            saved_root_id: null,
            product_id: "32400",
            original_folder: { profile_id: selectedProfile.id, path: folder },
          },
          {
            store: "steam",
            title: "Dark Forces Remaster",
            path: "D:/Steam/steamapps/common/Remaster",
            saved_root_id: null,
            product_id: "2292260",
          },
        ],
      } satisfies Awaited<ReturnType<typeof desktopApi.storeGameInstalls>>;
      const pending = deferred<typeof storeReport>();
      const lookup = vi.spyOn(desktopApi, "storeGameInstalls").mockImplementation(() => {
        if (newCheck) return pending.promise;
        return Promise.resolve(
          noMatch ? { ...storeReport, installs: storeReport.installs.slice(1) } : storeReport,
        );
      });
      const check = vi.spyOn(desktopApi, "inspectSourceIntake").mockResolvedValue({
        schema_version: 1,
        profile_id: selectedProfile.id,
        input_count: 1,
        state_code: "unrecognized_edition",
        summary: "The stored folder lacks the required original files.",
        next_action: "Choose a compatible copy.",
      });
      const pickerOpen = vi.spyOn(picker, "pickSourcePath").mockResolvedValue(null);
      const save = vi.spyOn(desktopApi, "importSource");
      const transport = installInteractiveTransport("setup", (message) => {
        throw new Error(message);
      });
      vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async () => {
        const snapshot = workspace("setup");
        const target = snapshot.catalog.ports.find((port) => port.id === "orchard")!;
        target.source_profile = selectedProfile.id;
        target.bios_source_profile = newCheck ? bios.id : null;
        snapshot.catalog.source_profiles = newCheck ? [selectedProfile, bios] : [selectedProfile];
        const status = snapshot.statuses.find((entry) => entry.port_id === target.id)!;
        status.active = null;
        status.staged = null;
        status.readiness = {
          launchable: false,
          pending_setup: false,
          blockers: ["missing_source"],
        };
        status.port_actions = [
          { action: "install", availability: "waiting", reason: "missing_source" },
        ];
        return snapshot;
      });
      try {
        localStorage.clear();
        initializeLocalization(["en"]);
        await root.rerender(
          <LocalizationProvider api={desktopApi}>
            <App />
          </LocalizationProvider>,
        );
        await page.getByRole("button", { name: "Discover", exact: true }).click();
        await page.getByRole("textbox", { name: "Search Discover" }).fill("Orchard Quest");
        await page.getByRole("button", { name: /^Orchard Quest(?:[,. ·]|$)/u }).click();
        const installation = page.getByRole("region", { name: "Game actions", exact: true });
        await installation
          .getByRole("button", {
            name: newCheck ? "Choose game files and BIOS" : "Choose game files",
            exact: true,
          })
          .click();
        await expect.poll(() => lookup.mock.calls.length + savedMatches.mock.calls.length).toBe(1);
        const storeReadsBeforeCheck = lookup.mock.calls.length;
        if (newCheck) {
          await page.getByRole("tab", { name: "Game files", exact: true }).click();
          await page.getByRole("button", { name: "Check required BIOS", exact: true }).click();
          await act(async () => pending.resolve(storeReport));
        } else if (!noMatch) {
          await page
            .getByRole("button", {
              name: fromSaved ? "Check saved location" : "Check Dark Forces files from Steam",
              exact: true,
            })
            .click();
        }
        const outcome = newCheck
          ? page.getByRole("dialog", { name: "Check BIOS for Orchard Quest" })
          : noMatch
            ? installation.getByRole("button", { name: "Choose game files", exact: true })
            : page.getByText("The stored folder lacks the required original files.");
        await expect.element(outcome).toBeVisible();
        expect(storeReadsBeforeCheck).toBe(fromSaved ? 0 : 1);
        await expect.poll(() => lookup.mock.calls.length).toBe(1);
        const fallback = fromSaved
          ? page.getByRole("button", { name: "Check Dark Forces files from Steam", exact: true })
          : outcome;
        await expect.element(fallback).toBeVisible();
        expect(savedMatches.mock.calls).toEqual(
          fromSaved
            ? [
                [
                  {
                    scan_id: scanId,
                    offset: 0,
                    kind: "exact",
                    limit: 32,
                    profile_id: selectedProfile.id,
                  },
                  1,
                ],
              ]
            : [],
        );
        await expect.poll(() => pickerOpen.mock.calls.length).toBe(noMatch ? 1 : 0);
        expect(check.mock.calls).toEqual(
          newCheck || noMatch ? [] : [[selectedProfile.id, [fromSaved ? savedPath : folder]]],
        );
        expect(save).not.toHaveBeenCalled();
      } finally {
        await root.rerender(null);
        transport.dispose();
        localStorage.clear();
      }
    },
  );

  it.each([
    "game",
    "bios",
    "changed BIOS",
    "store originals",
    "GOG originals",
    "Doom",
    "BStone Steam AOG",
    "BStone Steam PS",
    "BStone GOG AOG",
    "BStone GOG PS",
    "BStone anthology AOG",
    "BStone anthology PS",
  ])("checks the selected App setup handoff for %s", async (scenario) => {
    const installedSources: SourceRecord[] = [];
    const first = scenario === "bios" ? "bios" : "game";
    const replaceBios = scenario === "changed BIOS";
    const storeCases: Record<
      string,
      {
        store: "steam" | "gog";
        title: string;
        productId: string;
        profileId: string;
        subfolder?: string;
        relative?: boolean;
      }
    > = {
      "store originals": {
        store: "steam",
        title: "Dark Forces",
        productId: "32400",
        profileId: "dark-forces-pc-complete-installed-data",
        subfolder: "Game",
      },
      "GOG originals": {
        store: "gog",
        title: "Dark Forces",
        productId: "1421404433",
        profileId: "dark-forces-pc-complete-installed-data",
      },
      Doom: {
        store: "steam",
        title: "DOOM 3",
        productId: "9050",
        profileId: "doom-3-classic-pc-131-pk4",
        relative: true,
      },
      "BStone Steam AOG": {
        store: "steam",
        title: "Blake Stone",
        productId: "358190",
        profileId: "bstone-aliens-of-gold-originals",
        subfolder: "Blake Stone - Aliens of Gold",
      },
      "BStone Steam PS": {
        store: "steam",
        title: "Planet Strike",
        productId: "358310",
        profileId: "bstone-planet-strike-originals",
        subfolder: "Blake Stone - Planet Strike",
      },
      "BStone GOG AOG": {
        store: "gog",
        title: "Blake Stone",
        productId: "1207658728",
        profileId: "bstone-aliens-of-gold-originals",
      },
      "BStone GOG PS": {
        store: "gog",
        title: "Planet Strike",
        productId: "1207658729",
        profileId: "bstone-planet-strike-originals",
      },
      "BStone anthology AOG": {
        store: "steam",
        title: "Apogee Throwback Pack",
        productId: "238050",
        profileId: "bstone-aliens-of-gold-originals",
        subfolder: "Blake Stone",
      },
      "BStone anthology PS": {
        store: "steam",
        title: "Apogee Throwback Pack",
        productId: "238050",
        profileId: "bstone-planet-strike-originals",
        subfolder: "Planet Strike",
      },
    };
    const selectedStore = storeCases[scenario];
    const fromStore = selectedStore !== undefined;
    const fromGog = selectedStore?.store === "gog";
    const store = selectedStore?.store ?? "steam";
    const title = selectedStore?.title ?? "Dark Forces";
    const storeRoot = fromGog ? `D:/GOG Games/${title}` : `D:/Steam/steamapps/common/${title}`;
    const folder = selectedStore?.subfolder ? `${storeRoot}/${selectedStore.subfolder}` : storeRoot;
    const input = selectedStore
      ? {
          ...profile,
          id: selectedStore.profileId,
          kind: selectedStore.relative ? ("relative-file-set" as const) : ("file-set" as const),
        }
      : profile;
    const pickerOpen = vi
      .spyOn(picker, "pickSourcePath")
      .mockImplementation(async ({ id }) => `D:/${id}.z64`);
    const storeLookup = vi.spyOn(desktopApi, "storeGameInstalls");
    if (selectedStore) {
      storeLookup.mockResolvedValue({
        checked_stores: [store],
        skipped_entries: 0,
        limited: false,
        installs: [
          {
            store,
            product_id: selectedStore.productId,
            title,
            saved_root_id: null,
            path: storeRoot,
            original_folder: { path: folder, profile_id: input.id },
          },
        ],
      });
    }
    const bios = { ...profile, id: "bios", label: "Fixture BIOS" };
    const transport = installInteractiveTransport("setup", (message) => {
      throw new Error(message);
    });
    const selectedRecord = (id: string, path: string) => ({ ...record(path), profile_id: id });
    if (replaceBios) installedSources.push(selectedRecord("bios", "D:/original-bios.z64"));
    vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async () => {
      const snapshot = workspace("setup");
      const port = snapshot.catalog.ports.find((port) => port.id === "orchard")!;
      port.source_profile = input.id;
      port.bios_source_profile = fromStore ? null : bios.id;
      snapshot.catalog.source_profiles = fromStore ? [input] : [input, bios];
      snapshot.sources = [...installedSources];
      const has = (id: string) => installedSources.some((source) => source.profile_id === id);
      const reason = !has(input.id)
        ? "missing_source"
        : !fromStore && !has(bios.id)
          ? "missing_bios"
          : null;
      const status = snapshot.statuses.find((status) => status.port_id === port.id)!;
      status.active = null;
      status.staged = null;
      status.readiness = {
        launchable: false,
        pending_setup: false,
        blockers: reason ? [reason] : [],
      };
      status.port_actions = [
        {
          action: "install",
          availability: reason ? "waiting" : "allowed",
          reason: reason ?? "available",
        },
      ];
      return snapshot;
    });
    vi.spyOn(desktopApi, "inspectSourceIntake").mockImplementation(async (id, paths) => ({
      ...intake(paths[0]!),
      profile_id: id,
    }));
    vi.spyOn(desktopApi, "planSourceImport").mockImplementation(async (id, path, mode) => ({
      schema_version: 1,
      profile_id: id,
      mode,
      source: selectedRecord(id, path),
      admission_mode: "exact_identity",
      destination: path,
      destination_exists: true,
      existing_registration: null,
      reuse_existing: false,
      required_bytes: 0,
      source_guard_sha256: "b".repeat(64),
      plan_sha256: "c".repeat(64),
    }));
    const save = vi.spyOn(desktopApi, "importSource").mockImplementation(async (id, path, mode) => {
      const registered = selectedRecord(id, path);
      if (replaceBios) installedSources[0] = selectedRecord("bios", "D:/replacement-bios.z64");
      installedSources.push(registered);
      return {
        import_id: `imported-${id}`,
        profile_id: id,
        mode,
        outcome: "registered_current_location",
        registered,
        copied: false,
        original_deleted: false,
        original_retained: true,
        recovered: false,
      };
    });
    const reuse = vi.spyOn(desktopApi, "reviewSourceReuse").mockImplementation(async () => ({
      registration: installedSources.find((source) => source.profile_id === input.id)!,
      inspection: { ...report(fromStore ? folder : "D:/game.z64"), profile_id: input.id },
      reference: { profile_id: input.id, reference_sha256: "d".repeat(64) },
      applications: [],
    }));
    const review = vi.spyOn(desktopApi, "plan").mockResolvedValue({
      port_id: "orchard",
      channel: "stable",
      platform: "windows-x86-64",
      bundled_runtime: null,
      action: "download",
      source_requirements: [],
      download_bytes: 1024,
      release: {
        version: "2.0",
        channel: "stable",
        published_at: null,
        asset: {
          name: "orchard.zip",
          url: "https://example.com/orchard.zip",
          size: 1024,
          sha256: "a".repeat(64),
        },
      },
      storage: {
        library_root: "D:/Portcove",
        volume_total_bytes: 1024 ** 4,
        volume_available_bytes: 512 * 1024 ** 3,
      },
      output_location: {
        port_id: "orchard",
        library_root: "D:/Portcove",
        configured_output_directory: null,
        default_output_directory: "D:/Portcove/versions/orchard",
        effective_output_directory: "D:/Portcove/versions/orchard",
        selection_source: "library_default",
        user_data_root: "D:/Portcove/user/orchard",
      },
    });
    const install = vi.spyOn(desktopApi, "install");
    const launch = vi.spyOn(desktopApi, "launch");
    const register = async (id: string) => {
      const label =
        id === "bios"
          ? "Choose BIOS file to check"
          : fromStore
            ? `Check ${title} files from ${fromGog ? "GOG" : "Steam"}`
            : "Choose game files to check";
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByRole("button", { name: "Use current location", exact: true }).click();
      await page.getByRole("button", { name: "Use current location", exact: true }).click();
      await page.getByRole("button", { name: "Continue setup", exact: true }).click();
    };
    try {
      localStorage.clear();
      initializeLocalization(["en"]);
      await root.rerender(
        <LocalizationProvider api={desktopApi}>
          <App />
        </LocalizationProvider>,
      );
      await page.getByRole("button", { name: "Discover", exact: true }).click();
      await page.getByRole("textbox", { name: "Search Discover" }).fill("Orchard Quest");
      await page.getByRole("button", { name: /^Orchard Quest(?:[,. ·]|$)/u }).click();
      if (fromStore) {
        await page
          .getByRole("region", { name: "Game actions", exact: true })
          .getByRole("button", { name: "Choose game files", exact: true })
          .click();
      } else {
        await page.getByRole("tab", { name: "Game files", exact: true }).click();
        await page
          .getByRole("button", {
            name: first === "game" ? "Check game files" : "Check required BIOS",
            exact: true,
          })
          .click();
      }
      await register(first);
      const reviewsBeforeRemainingInput = fromStore ? null : review.mock.calls.length;
      const next = first === "game" ? "bios" : "game";
      if (!fromStore && !replaceBios) await register(next);
      const outcome = replaceBios
        ? page.getByText("The saved files have changed.", { exact: false })
        : page.getByRole("dialog", { name: "Review installation", exact: true });
      await expect.element(outcome).toBeVisible();
      expect(reviewsBeforeRemainingInput).toBe(fromStore ? null : 0);
      expect(review.mock.calls).toEqual(replaceBios ? [] : [["orchard", "stable"]]);
      expect(save).toHaveBeenCalledTimes(replaceBios || fromStore ? 1 : 2);
      expect(save.mock.calls[0]?.slice(0, 2)).toEqual(
        fromStore ? [input.id, folder] : [first, `D:/${first}.z64`],
      );
      expect(reuse.mock.calls).toEqual(replaceBios ? [] : [[input.id, 1]]);
      expect(pickerOpen).toHaveBeenCalledTimes(fromStore ? 0 : replaceBios ? 1 : 2);
      expect(storeLookup.mock.calls).toEqual(fromStore ? [[1, input.id]] : []);
      expect(install).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await root.rerender(null);
      transport.dispose();
      localStorage.clear();
    }
  });

  it("relinks a moved original from the installed game and shows its remaining blocker", async () => {
    const transport = installInteractiveTransport("library", (message) => {
      throw new Error(message);
    });
    const replacement = "D:/Recovered originals/game.z64";
    const old = record("D:/Removed originals/game.z64");
    let registered = old;
    const bios = { ...profile, id: "bios", label: "Fixture BIOS" };
    const fixture = workspace("library");
    const initialInstall = fixture.statuses.find((entry) => entry.port_id === "sample")?.active;
    expect(initialInstall).toBeDefined();
    vi.spyOn(desktopApi, "workspaceSnapshot").mockImplementation(async () => {
      const next = workspace("library");
      const port = next.catalog.ports.find((entry) => entry.id === "sample")!;
      port.source_profile = profile.id;
      port.bios_source_profile = bios.id;
      next.catalog.source_profiles = [profile, bios];
      next.sources = [registered];
      const status = next.statuses.find((entry) => entry.port_id === "sample")!;
      status.readiness = {
        launchable: false,
        source: registered === old ? "missing" : "current",
        bios: "unregistered",
        pending_setup: false,
        blockers: registered === old ? ["missing_source", "missing_bios"] : ["missing_bios"],
      };
      return next;
    });
    vi.spyOn(picker, "pickSourcePath").mockResolvedValue(replacement);
    const inspect = vi
      .spyOn(desktopApi, "inspectSourceIntake")
      .mockImplementation(async (_id, [path]) =>
        path === replacement
          ? intake(replacement)
          : {
              schema_version: 1,
              profile_id: profile.id,
              input_count: 1,
              state_code: "invalid_selection",
              summary: "The file at the saved location is unavailable.",
              next_action: "Choose the file at its new location.",
              report: null,
            },
      );
    const plan = "d".repeat(64);
    vi.spyOn(desktopApi, "planSourceImport").mockResolvedValue({
      schema_version: 1,
      profile_id: profile.id,
      mode: "use_current_location",
      source: record(replacement),
      admission_mode: "exact_identity",
      destination: replacement,
      destination_exists: true,
      existing_registration: old,
      reuse_existing: false,
      required_bytes: 0,
      source_guard_sha256: "b".repeat(64),
      plan_sha256: plan,
    });
    const save = vi
      .spyOn(desktopApi, "importSource")
      .mockImplementation(async (_profile, path, mode) => {
        registered = record(path);
        return {
          import_id: "fixture-relink",
          profile_id: profile.id,
          mode,
          outcome: "registered_current_location",
          registered,
          copied: false,
          original_deleted: false,
          original_retained: true,
          recovered: false,
        };
      });
    const launch = vi.spyOn(desktopApi, "launch");
    try {
      localStorage.clear();
      initializeLocalization(["en"]);
      await root.rerender(
        <LocalizationProvider api={desktopApi}>
          <App />
        </LocalizationProvider>,
      );
      await page
        .getByRole("button", { name: "View details for Harbor Adventure", exact: true })
        .click();
      await page.getByRole("tab", { name: "Game files", exact: true }).click();
      const workspaceSelector = '[data-detail-port-id="sample"]';
      const detail = page.elementLocator(document.querySelector(workspaceSelector)!);
      const check = detail.getByRole("button", { name: "Check game files", exact: true });
      await expect.element(check).toBeVisible();
      await captureParityState("moved-original-before-relink-fixture");
      await check.click();
      await page.getByRole("button", { name: "Choose game files to check", exact: true }).click();
      await page.getByRole("button", { name: "Use current location", exact: true }).click();
      expect(save).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Use current location", exact: true }).click();
      await page.getByRole("button", { name: "Return to game", exact: true }).click();
      await expect
        .element(detail.getByRole("tab", { name: "Game files", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      await expect
        .element(detail.getByRole("textbox", { name: /Game files · Owned game source/ }))
        .toHaveValue(replacement);
      await expect
        .element(detail.getByRole("button", { name: "Check required BIOS", exact: true }))
        .toBeVisible();
      expect(inspect.mock.calls).toEqual([
        [profile.id, [old.path]],
        [profile.id, [replacement]],
      ]);
      expect(save).toHaveBeenCalledExactlyOnceWith(
        profile.id,
        replacement,
        "use_current_location",
        plan,
        1,
      );
      expect(detail.element().querySelector("[data-installation-fact]")?.textContent).toContain(
        initialInstall!.version,
      );
      expect(launch).not.toHaveBeenCalled();
      expect(detail.element().querySelector(".detail-header-actions")?.textContent).toContain(
        "Choose files",
      );
      await captureParityState("moved-original-remaining-bios-fixture");
    } finally {
      await root.rerender(null);
      transport.dispose();
      localStorage.clear();
    }
  });

  it("keeps an in-flight import bound to its original library and discards its completion after switching", async () => {
    const apply = prepareImport();
    const pending = deferred<SourceImportResult | null>();
    apply.mockReturnValueOnce(pending.promise);
    const added = vi.fn();
    await openImportReview(added);
    await act(async () => button("Copy into Portcove")!.click());
    expect(apply).toHaveBeenCalledWith(profile.id, "D:/Game.z64", "copy", "c".repeat(64), 7);
    await root.rerender(
      <SourceIntakeDialog
        request={{ ...request(["D:/Game.z64"]), generation: 8 }}
        close={vi.fn()}
        onAdded={added}
      />,
    );
    await act(async () =>
      pending.resolve({
        import_id: "old-library-import",
        profile_id: profile.id,
        mode: "copy",
        outcome: "copied",
        registered: record("D:/Inbox/Game.z64"),
        copied: true,
        original_deleted: false,
        original_retained: true,
        retained_original_path: "D:/Game.z64",
        recovered: false,
      }),
    );
    expect(added).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("File location saved");
    expect(apply).toHaveBeenCalledOnce();
  });

  it("returns focus to the current same-game action when saving replaces its opener", async () => {
    prepareImport();
    function RepairFixture() {
      const [open, setOpen] = useState(false);
      const [ready, setReady] = useState(false);
      return (
        <>
          <div id="source-save-scroll" style={{ height: 120, overflow: "auto" }}>
            <div style={{ height: 800 }} />
            {ready ? (
              <button id="current-game-action">Play</button>
            ) : (
              <button onClick={() => setOpen(true)}>Select game files</button>
            )}
            <div style={{ height: 400 }} />
          </div>
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
    const owner = document.getElementById("source-save-scroll")!;
    const current = document.getElementById("current-game-action")!;
    owner.scrollTop = 0;
    expect(current.getBoundingClientRect().top).toBeGreaterThan(
      owner.getBoundingClientRect().bottom,
    );
    await page.getByRole("button", { name: "Return to game" }).click();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById("current-game-action")),
    );
    await expect
      .poll(() => current.getBoundingClientRect().bottom)
      .toBeLessThanOrEqual(owner.getBoundingClientRect().bottom);
    expect(current.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      owner.getBoundingClientRect().top,
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
      official_url: "https://www.mamedev.org/release.html",
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
    const toolSection = document.querySelector<HTMLElement>(".source-intake-tool")!;
    const toolChildren = [...toolSection.children];
    for (let index = 1; index < toolChildren.length; index += 1) {
      expect(
        toolChildren[index]!.getBoundingClientRect().top -
          toolChildren[index - 1]!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(11);
    }
    const resultSection = toolSection.parentElement!;
    expect(
      resultSection.getBoundingClientRect().top -
        resultSection.previousElementSibling!.getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(11);
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
