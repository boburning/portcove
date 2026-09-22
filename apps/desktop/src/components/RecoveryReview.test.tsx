// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
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

it("keeps unavailable information distinct from an empty recorded repair list", () => {
  const unavailable = renderToStaticMarkup(
    <RecoveryReview {...freshDiagnostics} ports={[port]} stale />,
  );
  const empty = renderToStaticMarkup(
    <RecoveryReview {...freshDiagnostics} ports={[port]} repair={{ generated_at: 1, items: [] }} />,
  );
  expect(unavailable).toContain("has not been checked for the current library state");
  expect(unavailable).not.toContain("No recovery items");
  expect(empty).toContain("No recovery items were recorded in the last check.");
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
    expect(host.querySelector("summary")?.textContent).toContain(port.name);
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.textContent).toContain(repair.items[0].path);
    expect(details.textContent).toContain(repair.items[0].proposed_action);
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

it.each(["future_kind", "constructor", "__proto__"])("uses a neutral label for %s", (kind) => {
  const entry = {
    ...item(),
    kind: kind as ReturnType<typeof item>["kind"],
    path: null,
    proposed_action: "",
    port_id: null,
    operation_id: null,
  };
  const html = renderToStaticMarkup(
    <RecoveryReview
      {...freshDiagnostics}
      repair={{ generated_at: 1, items: [entry] }}
      ports={[]}
    />,
  );
  expect(html).toContain("Library · Recovery information needs review");
  expect(html).toContain("No location was recorded.");
  expect(html).toContain("No recovery guidance was recorded.");
  expect(html).not.toContain("raw-machine-secret");
});

it("retains every recorded item and full long names and paths", () => {
  const longPath = `C:\\${"owned-folder\\".repeat(40)}retained`;
  const items = Array.from({ length: 40 }, (_, index) => ({
    ...item(),
    operation_id: `operation-${index}`,
    path: longPath,
  }));
  const html = renderToStaticMarkup(
    <RecoveryReview
      {...freshDiagnostics}
      repair={{ generated_at: 1, items }}
      ports={[{ ...port, name: "A long game name ".repeat(10) }]}
    />,
  );
  expect(html).toContain("40 recorded items need review.");
  expect(html.match(/<details /g)).toHaveLength(40);
  expect(html).toContain(longPath);
  expect(html).toContain("operation-39");
  expect(html).not.toContain("raw-machine-secret");
});

it("reviews exact private files and preserved paths before cleanup", async () => {
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
      button.textContent?.includes("Review private-file cleanup"),
    );
    expect(review?.dataset.variant).toBe("destructive");
    await act(async () => review?.click());
    expect(load).toHaveBeenCalledWith("owned-operation", 7);
    expect(document.body.textContent).toContain(preview.retained_path);
    expect(document.body.textContent).toContain(preview.original_install_path);
    expect(document.body.textContent).toContain(preview.source_path);
    expect(document.body.textContent).toContain(preview.persistent_data_path);
    expect(document.body.textContent).toContain("private.bin");
    expect(document.body.textContent).toContain("Link or special entry");
    expect(document.body.textContent).toContain("cannot be recovered");
    expect(cleanup).not.toHaveBeenCalled();
    const apply = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Remove reviewed private files permanently"),
    );
    await act(async () => apply?.click());
    expect(cleanup).toHaveBeenCalledWith("owned-operation", preview.preview_sha256, 7);
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
      button.textContent?.includes("Review private-file cleanup"),
    );
    await act(async () => review?.click());
    expect(load).toHaveBeenCalledWith(preview.operation_id, 8);
    expect(document.body.textContent).toContain("0 files");
    expect(document.body.textContent).toContain("Affected entries (0)");
    expect(document.body.querySelector("#preparation-cleanup-description")?.textContent).toBe(
      "Remove empty private preparation state and its stale recovery journal.",
    );
    expect(document.body.textContent).toContain("Recorded private path cleared");
    expect(document.body.textContent).toContain(
      "No retained private entries are present. Cleanup removes the recorded private path if it exists and its stale recovery journal.",
    );
    expect(
      [...document.body.querySelectorAll("button")].some(
        (button) => button.textContent === "Remove empty private state",
      ),
    ).toBe(true);
    expect(document.body.textContent).toContain(preview.retained_path);
    expect(document.body.textContent).toContain(preview.original_install_path);
    expect(document.body.textContent).toContain(preview.source_path);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
