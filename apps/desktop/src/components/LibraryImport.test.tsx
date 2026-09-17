// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { LibraryImportPlan } from "../types";
import { LibraryImportButton } from "./LibraryImport";
import { LibraryMoveButton, LibraryMoveRecovery } from "./LibraryMove";

let root: Root;
const plan: LibraryImportPlan = {
  metadata_file: {
    path: "D:/Backup/library.json",
    sha256: "a".repeat(64),
    size: 500,
  },
  content_root: "D:/Backup/payload",
  destination_root: "E:/Library",
  destination_exists: true,
  metadata: {
    schema_version: 1,
    exported_at: 1,
    original_root: "C:/Old",
    content_roots: [],
    source_references: [],
    application_versions: [],
    port_settings: [],
    launch_history: [],
  },
  content: [],
  required_bytes: 1000,
  available_bytes: 5000,
  plan_sha256: "reviewed-plan",
};
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(picker, "pickMetadataImportPath").mockResolvedValue(plan.metadata_file.path);
  vi.spyOn(picker, "pickInstallFolder").mockResolvedValue(plan.content_root);
  vi.spyOn(desktopApi, "planLibraryImport").mockResolvedValue(plan);
  vi.spyOn(desktopApi, "importLibrary").mockRejectedValue({
    code: "verification",
    message: "Copied file changed",
    details: { transfer_id: "test", import_destination: plan.destination_root },
  });
  vi.spyOn(desktopApi, "recoverLibraryImport").mockRejectedValue({
    message: "Backup disk is offline",
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(<LibraryImportButton disabled={false} libraryRoot={plan.destination_root} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("invalidates a reviewed backup after editing and exposes recoverable import errors", async () => {
  await click("Restore library");
  expect(document.body.textContent).toContain("RESTORE PORTCOVE LIBRARY");
  expect(document.body.textContent).toContain(
    "Portcove checks the copy before opening it and does not change the export.",
  );
  expect(document.body.textContent).toContain("Use an export you trust.");
  expect(document.querySelector<HTMLInputElement>("#import-content")?.placeholder).toBe(
    "Folder containing the exported Portcove library",
  );
  await click("Choose file");
  await click("Choose folder");
  await click("Review restore");
  expect(document.querySelector("[aria-label='Library restore plan']")).not.toBeNull();
  expect(document.body.textContent).toContain(plan.content_root);
  expect(document.body.textContent).toContain(plan.destination_root);
  expect(button("Restore this library").disabled).toBe(false);
  const input = document.querySelector<HTMLInputElement>("#import-metadata")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "D:/Backup/changed.json",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelector("[aria-label='Library restore plan']")).toBeNull();
  expect(button("Review restore").disabled).toBe(false);
  await click("Review restore");
  await click("Restore this library");
  expect(desktopApi.importLibrary).toHaveBeenCalledWith(
    plan.metadata_file.path,
    plan.content_root,
    plan.plan_sha256,
  );
  expect(document.body.textContent).toContain("Copied file changed");
  expect(document.querySelector<HTMLInputElement>("#import-metadata")!.disabled).toBe(true);
  await click("Resume restore");
  expect(desktopApi.recoverLibraryImport).toHaveBeenCalledWith(plan.destination_root);
  expect(document.body.textContent).toContain("Backup disk is offline");
});

it("keeps the dialog open while a reviewed import is running", async () => {
  let rejectImport!: (error: unknown) => void;
  vi.mocked(desktopApi.importLibrary).mockReturnValue(
    new Promise((_, reject) => {
      rejectImport = reject;
    }),
  );
  await click("Restore library");
  await click("Choose file");
  await click("Choose folder");
  await click("Review restore");
  await click("Restore this library");
  expect(button("Close").disabled).toBe(true);
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector("[role=dialog]")).not.toBeNull();
  await act(async () => rejectImport({ message: "Import was not confirmed" }));
  expect(button("Close").disabled).toBe(false);
});

it.each(["move", "import"] as const)(
  "refreshes the workspace after closing a failed %s without repeating the transfer",
  async (kind) => {
    const reload = vi.fn();
    const expectedError =
      kind === "move" ? "Disk disconnected after copying" : "Copied file changed";
    const originalWindow = window;
    vi.stubGlobal(
      "window",
      new Proxy(originalWindow, {
        get(target, key, receiver): unknown {
          return key === "location" ? { reload } : (Reflect.get(target, key, receiver) as unknown);
        },
      }),
    );
    if (kind === "move") {
      vi.spyOn(desktopApi, "planLibraryMove").mockResolvedValue({
        ...plan,
        source_root: plan.content_root,
        source_will_be_retained: true,
        destination_root: "E:/New",
      });
      vi.spyOn(desktopApi, "moveLibrary").mockRejectedValue({
        message: "Disk disconnected after copying",
      });
      await act(async () => root.render(<LibraryMoveButton disabled={false} />));
      await click("Move library");
      const input = document.querySelector<HTMLInputElement>("#library-destination")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "E:/New",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Review move");
      await click("Move to this folder");
    } else {
      await click("Restore library");
      await click("Choose file");
      await click("Choose folder");
      await click("Review restore");
      await click("Restore this library");
    }
    expect(document.body.textContent).toContain(expectedError);
    expect(reload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      kind === "move"
        ? "Closing this review refreshes the library"
        : "Closing this restore review refreshes the library",
    );
    await click("Close");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(
      kind === "move" ? desktopApi.moveLibrary : desktopApi.importLibrary,
    ).toHaveBeenCalledTimes(1);
  },
);

it("offers both move recovery outcomes only before activation", async () => {
  const recover = vi.spyOn(desktopApi, "recoverLibraryMove").mockRejectedValue({
    message: "The copied library is unavailable",
  });
  await act(async () =>
    root.render(<LibraryMoveRecovery source="D:/Original" canKeepOriginal={true} />),
  );
  expect(document.body.textContent).toContain(
    "Resume the move to check the new copy and finish switching libraries.",
  );
  expect(document.body.textContent).toContain(
    "Keep using the original library before the new copy is activated.",
  );
  expect(document.body.textContent).toContain("Neither option deletes the copied files.");
  await click("Keep using original library");
  expect(recover).toHaveBeenCalledWith("D:/Original", true);
  expect(document.body.textContent).toContain("The copied library is unavailable");
});

it("fails closed after activation and offers resume only", async () => {
  const recover = vi.spyOn(desktopApi, "recoverLibraryMove").mockResolvedValue({
    completed: true,
  } as Awaited<ReturnType<typeof desktopApi.recoverLibraryMove>>);
  await act(async () =>
    root.render(<LibraryMoveRecovery source="D:/Original" canKeepOriginal={false} />),
  );
  expect(document.body.textContent).toContain(
    "The new copy is already activated, so recovery can only resume the move.",
  );
  expect(document.body.textContent).not.toContain("Keep using original library");
  await click("Resume move");
  expect(recover).toHaveBeenCalledWith("D:/Original", false);
});
