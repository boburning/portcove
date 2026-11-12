import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { PortableSaveExportPreview, PortableSaveImportPreview } from "../types";
import { PortableSaves, type PortableSavesApi } from "./PortableSaves";

const identity = {
  port_id: "shipwright",
  contract_id: "shipwright-save-files-v1",
  version: "9.3.1",
  platform: "windows-x86-64" as const,
};
const save = { path: "Save/file1.sav", size: 2048, sha256: "a".repeat(64) };
const exportPreview: PortableSaveExportPreview = {
  port_id: "shipwright",
  identity,
  files: [save],
  stays_local: [
    { path: "shipofharkinian.json", role: "device-configuration", directory: false },
    { path: "oot.o2r", role: "original-derived", directory: false },
  ],
  content_sha256: "b".repeat(64),
  blockers: [],
};
const diverged: PortableSaveImportPreview = {
  port_id: "shipwright",
  source: { ...identity, platform: "linux-x86-64" },
  destination: identity,
  relation: "diverged",
  changes: [
    { path: "Save/file1.sav", effect: "replace", incoming: save, local: save },
    { path: "Save/file2.sav", effect: "keep-local", local: save },
  ],
  stays_local: [],
  incoming_content_sha256: "c".repeat(64),
  local_content_sha256: "d".repeat(64),
  options: { remove_local_only_saves: false, replace_diverged_progress: false },
  safety_backup_will_be_created: true,
  blockers: ["conflict-needs-choice"],
  preview_sha256: "e".repeat(64),
};

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

function api(overrides: Partial<PortableSavesApi> = {}): PortableSavesApi {
  return {
    previewExport: vi.fn().mockResolvedValue(exportPreview),
    exportSaves: vi.fn().mockResolvedValue({
      path: "/media/usb/Ship saves.json",
      identity,
      files: [save],
      content_sha256: "b".repeat(64),
    }),
    previewImport: vi.fn().mockResolvedValue(diverged),
    importSaves: vi.fn().mockResolvedValue(null),
    pickExportPath: vi.fn().mockResolvedValue("/media/usb/Ship saves.json"),
    pickImportPath: vi.fn().mockResolvedValue("/media/usb/deck saves.json"),
    ...overrides,
  };
}

it("is absent for games without a qualified save contract", async () => {
  await act(async () =>
    root.rerender(
      <PortableSaves
        portId="other"
        gameName="Other"
        generation={1}
        api={api({
          previewExport: vi.fn().mockResolvedValue({
            ...exportPreview,
            identity: undefined,
            files: [],
            blockers: ["unqualified"],
          }),
        })}
      />,
    ),
  );
  expect(document.body.textContent).not.toContain("Move saves to another device");
});

it("exports only the reviewed content and names what stays local", async () => {
  const fake = api();
  await act(async () =>
    root.rerender(<PortableSaves portId="shipwright" gameName="Ship" generation={4} api={fake} />),
  );
  expect(document.body.textContent).toContain("Exports Save/file1.sav.");
  expect(document.body.textContent).toContain("this device's settings");
  expect(document.body.textContent).toContain("made from your own game files");
  await act(async () => button("Export saves…")?.click());
  expect(fake.exportSaves).toHaveBeenCalledWith(
    "shipwright",
    "/media/usb/Ship saves.json",
    "b".repeat(64),
    4,
  );
  expect(document.body.querySelector("[role=status]")?.textContent).toContain(
    "Exported 1 save file",
  );
});

it("requires an explicit replace choice and binds the reviewed import", async () => {
  const chosen = { ...diverged, blockers: [], preview_sha256: "f".repeat(64) };
  const previewImport = vi
    .fn()
    .mockResolvedValueOnce(diverged)
    .mockResolvedValueOnce({
      ...chosen,
      options: { ...chosen.options, replace_diverged_progress: true },
    });
  const importSaves = vi.fn().mockResolvedValue({
    import_snapshot: {
      id: "imported",
      port_id: "shipwright",
      path: "b",
      created_at: 1,
      file_count: 1,
      size: 1,
      sha256: "a".repeat(64),
    },
    safety_backup: {
      id: "safety",
      port_id: "shipwright",
      path: "s",
      created_at: 1,
      file_count: 1,
      size: 1,
      sha256: "a".repeat(64),
    },
    content_sha256: "c".repeat(64),
  });
  const changed = vi.fn();
  const fake = api({ previewImport, importSaves });
  await act(async () =>
    root.rerender(
      <PortableSaves
        portId="shipwright"
        gameName="Ship"
        generation={4}
        api={fake}
        onChanged={changed}
      />,
    ),
  );
  await act(async () => button("Import saves…")?.click());
  const review = document.body.querySelector("[aria-label='Save import review']");
  expect(review?.textContent).toContain("Saves from Linux, game version 9.3.1");
  expect(review?.textContent).toContain("can't confirm");
  expect(review?.textContent).toContain("Save/file1.sav — replaced");
  expect(review?.textContent).toContain("Save/file2.sav — kept (not in the file)");
  expect(button("Import saves")?.disabled).toBe(true);

  const replace = [...document.body.querySelectorAll("label")].find((label) =>
    label.textContent?.includes("Replace this device"),
  );
  await act(async () => replace?.querySelector<HTMLElement>("[data-slot=checkbox]")?.click());
  expect(previewImport).toHaveBeenLastCalledWith(
    "shipwright",
    "/media/usb/deck saves.json",
    { removeLocalOnlySaves: false, replaceDivergedProgress: true },
    4,
  );
  expect(button("Import saves")?.disabled).toBe(false);
  await act(async () => button("Import saves")?.click());
  expect(importSaves).toHaveBeenCalledWith(
    "shipwright",
    "/media/usb/deck saves.json",
    { removeLocalOnlySaves: false, replaceDivergedProgress: true },
    "f".repeat(64),
    4,
  );
  expect(changed).toHaveBeenCalled();
  expect(document.body.querySelector("[role=status]")?.textContent).toContain(
    "previous saves and settings are in a backup",
  );
});

it("leaves the review open and changes nothing when native confirmation is declined", async () => {
  const fake = api({
    previewImport: vi.fn().mockResolvedValue({ ...diverged, blockers: [], relation: "continues" }),
  });
  await act(async () =>
    root.rerender(<PortableSaves portId="shipwright" gameName="Ship" generation={4} api={fake} />),
  );
  await act(async () => button("Import saves…")?.click());
  await act(async () => button("Import saves")?.click());
  expect(fake.importSaves).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector("[aria-label='Save import review']")).not.toBeNull();
  expect(document.body.querySelector("[role=status]")).toBeNull();
});
