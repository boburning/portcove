import { fixtureValue } from "../test-fixtures";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import type { DoctorReport, PreparationCleanupPreview } from "../types";
import { portDefinition } from "../test-fixtures";
import { RecoveryReview } from "./RecoveryReview";

type Repair = DoctorReport["repair"];
const port = portDefinition();
const item = (): Repair["items"][number] => ({
  kind: "partial_operation",
  operation_id: "owned-operation",
  port_id: port.id,
  path: "C:\\Owned library\\staging\\retained",
  message: "raw-machine-secret",
  proposed_action: "Review the retained work before another attempt.",
});
const freshDiagnostics = {
  refreshing: false,
  stale: false,
  refresh: vi.fn().mockResolvedValue("completed"),
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("puts paths behind a collapsed review and omits raw errors and execution controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const repair = { generated_at: 1, items: [item()] };
  const original = JSON.stringify(repair);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<RecoveryReview {...freshDiagnostics} repair={repair} ports={[port]} />),
    );
    expect(host.textContent).toContain("1 recorded item needs review.");
    expect(
      host.querySelector(".recovery-review")?.classList.contains("recovery-review-quiet"),
    ).toBe(false);
    expect(host.querySelector("summary")?.textContent).toContain(port.name);
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.textContent).toContain(fixtureValue(repair.items[0], "repair.items[0]").path);
    expect(details.textContent).toContain(
      fixtureValue(repair.items[0], "repair.items[0]").proposed_action,
    );
    expect(host.innerHTML).not.toContain("raw-machine-secret");
    expect(host.querySelectorAll("button,a")).toHaveLength(0);
    expect(JSON.stringify(repair)).toBe(original);
    await act(async () =>
      root.render(
        <RecoveryReview
          {...freshDiagnostics}
          repair={{ generated_at: 2, items: [] }}
          ports={[port]}
        />,
      ),
    );
    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent).not.toContain("owned-operation");
  } finally {
    await act(async () => root.unmount());
  }
});

it("inspects exact retained facts without deleting, then refreshes the bound plan for separate cleanup", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const preview: PreparationCleanupPreview = {
    format_version: 1,
    operation_id: "owned-operation",
    port_id: port.id,
    retained_path: "C:\\Library\\staging\\owned-operation",
    retained: {
      directories: ["payload/generated"],
      files: [
        {
          relative_path: "payload/generated/private.bin",
          sha256: "a".repeat(64),
          size: 128,
        },
      ],
      skipped_entries: [{ relative_path: "payload/generated/link", reason: "symbolic link" }],
      total_bytes: 128,
    },
    original_install_path: "C:\\Library\\versions\\sample\\original",
    source_path: "D:\\Owned\\source.iso",
    persistent_data_path: "C:\\Library\\user\\sample",
    backup_path: "C:\\Library\\backups\\sample",
    logs_path: "C:\\Library\\logs",
    cleanup_is_irreversible: true,
    interrupted_cleanup_will_retry: true,
    preview_sha256: "b".repeat(64),
  };
  const load = vi.spyOn(desktopApi, "previewPreparationCleanup").mockResolvedValue(preview);
  const cleanup = vi.spyOn(desktopApi, "cleanupPreparation").mockResolvedValue(preview);
  const changed = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <RecoveryReview
          {...freshDiagnostics}
          generation={7}
          cleanupChanged={changed}
          repair={{
            generated_at: 1,
            items: [{ ...item(), kind: "retained_preparation" }],
          }}
          ports={[port]}
        />,
      ),
    );
    const review = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Review unfinished setup files"),
    );
    expect(review?.dataset.variant).toBe("outline");
    await act(async () => review?.click());
    expect(load).toHaveBeenCalledWith("owned-operation", 7);
    expect(document.body.textContent).toContain(preview.retained_path);
    expect(document.body.textContent).toContain(preview.original_install_path);
    expect(document.body.textContent).toContain(preview.source_path);
    expect(document.body.textContent).toContain(preview.persistent_data_path);
    expect(document.body.textContent).toContain("private.bin");
    expect(document.body.textContent).toContain("Files left by unfinished setup");
    expect(document.body.textContent).not.toContain("Delete files left by unfinished setup?");
    expect(document.body.textContent).not.toContain("Setup working folder to delete");
    expect(cleanup).not.toHaveBeenCalled();
    const updated = { ...preview, preview_sha256: "c".repeat(64) };
    load.mockResolvedValue(updated);
    await act(async () =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "Review cleanup…")
        ?.click(),
    );
    expect(load).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Setup working folder to delete");
    expect(document.body.textContent).toContain("Link or special entry");
    expect(document.body.textContent).toContain("cannot be recovered");
    expect(document.body.textContent).toContain("Delete files left by unfinished setup?");
    expect(document.body.textContent).toContain("setup and any programs it started have stopped");
    expect(cleanup).not.toHaveBeenCalled();
    const apply = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Delete setup working files"),
    );
    await act(async () => apply?.click());
    expect(cleanup).toHaveBeenCalledWith("owned-operation", updated.preview_sha256, 7);
    expect(changed).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("explains that journal-only cleanup has no private entries to remove", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const preview: PreparationCleanupPreview = {
    format_version: 1,
    operation_id: "journal-only-operation",
    port_id: port.id,
    retained_path: "C:\\Library\\staging\\journal-only-operation",
    retained: {
      directories: [],
      files: [],
      skipped_entries: [],
      total_bytes: 0,
    },
    original_install_path: "C:\\Library\\versions\\sample\\original",
    source_path: "D:\\Owned\\source.iso",
    persistent_data_path: "C:\\Library\\user\\sample",
    backup_path: "C:\\Library\\backups\\sample",
    logs_path: "C:\\Library\\logs",
    cleanup_is_irreversible: true,
    interrupted_cleanup_will_retry: true,
    preview_sha256: "c".repeat(64),
  };
  const load = vi.spyOn(desktopApi, "previewPreparationCleanup").mockResolvedValue(preview);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <RecoveryReview
          {...freshDiagnostics}
          generation={8}
          repair={{
            generated_at: 1,
            items: [
              {
                ...item(),
                operation_id: preview.operation_id,
                kind: "retained_preparation",
                path: preview.retained_path,
              },
            ],
          }}
          ports={[port]}
        />,
      ),
    );
    const review = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Review unfinished setup files"),
    );
    await act(async () => review?.click());
    expect(load).toHaveBeenCalledWith(preview.operation_id, 8);
    expect(document.body.textContent).toContain("Files left by unfinished setup");
    await act(async () =>
      [...document.body.querySelectorAll("button")]
        .find((button) => button.textContent === "Review cleanup…")
        ?.click(),
    );
    expect(document.body.textContent).toContain("0 files");
    expect(document.body.textContent).toContain("Affected entries (0)");
    expect(document.body.querySelector("#preparation-cleanup-description")?.textContent).toBe(
      "No setup working files remain. Clear the unfinished setup record and its recorded path if present.",
    );
    expect(document.body.textContent).toContain("Clear unfinished setup record?");
    expect(document.body.textContent).toContain("Recorded setup path to clear");
    expect(document.body.textContent).toContain("before clearing this record");
    expect(document.body.textContent).not.toContain("before deleting these files");
    expect(document.body.textContent).toContain(
      "No setup working files were found. Cleanup clears the recorded setup path if it exists and its stale recovery journal.",
    );
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent === "Clear unfinished setup record",
      ),
    ).toBe(true);
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent === "Cancel",
      ),
    ).toBe(true);
    expect(document.body.textContent).not.toContain("Keep retained files");
    expect(document.body.textContent).toContain(preview.retained_path);
    expect(document.body.textContent).toContain(preview.original_install_path);
    expect(document.body.textContent).toContain(preview.source_path);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
