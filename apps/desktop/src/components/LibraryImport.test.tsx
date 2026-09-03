// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { LibraryImportPlan } from "../types";
import { LibraryImportButton } from "./LibraryImport";

let root: Root;
const plan: LibraryImportPlan = {
  metadata_file: { path: "D:/Backup/library.json", sha256: "a".repeat(64), size: 500 },
  content_root: "D:/Backup/payload", destination_root: "E:/Library", destination_exists: true,
  metadata: { schema_version: 1, exported_at: 1, original_root: "C:/Old", content_roots: [], source_references: [], application_versions: [], port_settings: [], launch_history: [] },
  content: [], required_bytes: 1000, available_bytes: 5000, plan_sha256: "reviewed-plan",
};
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) { await act(async () => button(label).click()); }

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(picker, "pickMetadataImportPath").mockResolvedValue(plan.metadata_file.path);
  vi.spyOn(picker, "pickInstallFolder").mockResolvedValue(plan.content_root);
  vi.spyOn(desktopApi, "planLibraryImport").mockResolvedValue(plan);
  vi.spyOn(desktopApi, "importLibrary").mockRejectedValue({ code: "verification", message: "Copied file changed", details: { transfer_id: "test", import_destination: plan.destination_root } });
  vi.spyOn(desktopApi, "recoverLibraryImport").mockRejectedValue({ message: "Backup disk is offline" });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<LibraryImportButton disabled={false} libraryRoot={plan.destination_root} />));
});
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("invalidates a reviewed backup after editing and exposes recoverable import errors", async () => {
  await click("Import library"); await click("Choose file"); await click("Choose folder"); await click("Review import");
  expect(button("Import this backup").disabled).toBe(false);
  const input = document.querySelector<HTMLInputElement>("#import-metadata")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "D:/Backup/changed.json");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector("[aria-label='Library import plan']")).toBeNull();
  expect(button("Review import").disabled).toBe(false);
  await click("Review import"); await click("Import this backup");
  expect(desktopApi.importLibrary).toHaveBeenCalledWith(plan.metadata_file.path, plan.content_root, plan.plan_sha256);
  expect(document.body.textContent).toContain("Copied file changed");
  expect(document.querySelector<HTMLInputElement>("#import-metadata")!.disabled).toBe(true);
  await click("Resume import");
  expect(desktopApi.recoverLibraryImport).toHaveBeenCalledWith(plan.destination_root);
  expect(document.body.textContent).toContain("Backup disk is offline");
});

it("keeps the dialog open while a reviewed import is running", async () => {
  let rejectImport!: (error: unknown) => void;
  vi.mocked(desktopApi.importLibrary).mockReturnValue(new Promise((_, reject) => { rejectImport = reject; }));
  await click("Import library"); await click("Choose file"); await click("Choose folder"); await click("Review import"); await click("Import this backup");
  expect(button("Close").disabled).toBe(true);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector("[role=dialog]")).not.toBeNull();
  await act(async () => rejectImport({ message: "Import was not confirmed" }));
  expect(button("Close").disabled).toBe(false);
});
