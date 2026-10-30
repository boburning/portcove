import { captureParityState } from "../../test/parity-capture";
import { controlledAct as act } from "../../test/controlled-react-act";
import { reloadWorkspace } from "../reload-workspace";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { LibraryImportPlan } from "../types";
import { LibraryImportButton } from "./LibraryImport";
import { LibraryMoveButton, LibraryMoveRecovery } from "./LibraryMove";
import { BootstrapRecovery } from "../App";

let root: RenderResult;
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
  vi.mocked(picker.pickMetadataImportPath).mockResolvedValue(plan.metadata_file.path);
  vi.mocked(picker.pickInstallFolder).mockResolvedValue(plan.content_root);
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
  root = await renderComponent(null, { container: document.body.appendChild(host) });
  await root.rerender(<LibraryImportButton disabled={false} libraryRoot={plan.destination_root} />);
});
afterEach(async () => {
  await cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("invalidates a reviewed backup after editing and exposes recoverable import errors", async () => {
  await click("Restore from a library copy");
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
    "Restore from a library copy",
  );
  expect(document.body.textContent).toContain(
    "You need a library metadata file and a separate copy of the original library folder.",
  );
  expect(document.body.textContent).toContain("Restore into a new or empty library.");
  expect(document.body.textContent).toContain(
    "A review alone does not verify a complete recovery copy.",
  );
  expect(document.body.textContent).toContain("Library metadata file");
  expect(document.body.textContent).toContain("Copy of the original library folder");
  expect(document.body.textContent).toContain(plan.destination_root);
  expect(document.body.textContent).toContain("Use an export you trust.");
  expect(document.querySelector<HTMLInputElement>("#import-content")?.placeholder).toBe(
    "Choose the copied library folder",
  );
  expect(document.querySelector("#import-metadata")?.getAttribute("data-slot")).toBe("input");
  expect(document.querySelector("#import-content")?.getAttribute("data-slot")).toBe("input");
  await click("Choose file");
  await click("Choose folder");
  await click("Review restore");
  expect(document.querySelector("[aria-label='Library restore plan']")).not.toBeNull();
  expect(document.body.textContent).toContain(plan.content_root);
  expect(document.body.textContent).toContain(plan.destination_root);
  expect(button("Restore this library").disabled).toBe(false);
  await captureParityState("library-restore-reviewed-fixture");
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
  await captureParityState("library-restore-recovery-failed-fixture");
});

it("keeps the dialog open while a reviewed import is running", async () => {
  let rejectImport!: (error: unknown) => void;
  vi.mocked(desktopApi.importLibrary).mockReturnValue(
    new Promise((_, reject) => {
      rejectImport = reject;
    }),
  );
  await click("Restore from a library copy");
  await click("Choose file");
  await click("Choose folder");
  await click("Review restore");
  await click("Restore this library");
  expect(button("Close").disabled).toBe(true);
  await captureParityState("library-restore-pending-fixture");
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector("[role=dialog]")).not.toBeNull();
  await act(async () => rejectImport({ message: "Import was not confirmed" }));
  expect(button("Close").disabled).toBe(false);
});

it("explains retained originals and space before reviewing a library move", async () => {
  await root.rerender(<LibraryMoveButton disabled={false} />);
  await click("Change library location");
  expect(document.querySelector("#library-destination")?.getAttribute("data-slot")).toBe("input");
  expect(document.body.textContent).toContain(
    "The old folder is kept, so this does not free space on its drive.",
  );
  expect(document.body.textContent).toContain("Original game files stay at their saved locations");
});

it.each([240, 320])(
  "keeps a restore with a long destination within a %spx dialog",
  async (width) => {
    const original = { width: innerWidth, height: innerHeight };
    await page.viewport(width, 160);
    try {
      const destination = String.raw`\\?\E:\Codex-Worktrees\ui-ux-enlargement-2224\Portcove-Development\outputs\desktop-verify\2026-10-20T11-08-50-133Z-BYK1VJ\native\restored-library`;
      vi.mocked(desktopApi.planLibraryImport).mockResolvedValue({
        ...plan,
        destination_root: destination,
      });
      await root.rerender(<LibraryImportButton disabled={false} libraryRoot={destination} />);
      await click("Restore from a library copy");
      await click("Choose file");
      await click("Choose folder");
      await click("Review restore");
      const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
      const bounds = dialog.getBoundingClientRect();
      const offenders = [...dialog.querySelectorAll<HTMLElement>("*")]
        .filter((element) => element.getBoundingClientRect().right > bounds.right + 1)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          text: element.textContent?.slice(0, 100),
        }));
      expect(dialog.scrollWidth, JSON.stringify(offenders)).toBeLessThanOrEqual(
        dialog.clientWidth + 1,
      );
      expect(button("Restore this library").disabled).toBe(false);
    } finally {
      await page.viewport(original.width, original.height);
    }
  },
);

it.each([240, 320])(
  "keeps expanded transfer inventory within a %spx recovery dialog",
  async (width) => {
    const original = { width: innerWidth, height: innerHeight };
    await page.viewport(width, 160);
    try {
      vi.spyOn(desktopApi, "planLibraryMove").mockResolvedValue({
        ...plan,
        source_root: "D:/Owned library",
        source_will_be_retained: true,
        content: [
          {
            kind: "user_data",
            relative_path: "user",
            copy: {
              total_bytes: 39,
              skipped_entries: [],
              directories: ["owned-port/empty-folder"],
              files: [
                {
                  relative_path: `owned-port/${"long-path-".repeat(12)}.save`,
                  size: 39,
                  sha256: "a".repeat(64),
                },
              ],
            },
          },
        ],
      });
      await root.rerender(<LibraryMoveButton disabled={false} />);
      await click("Change library location");
      const input = document.querySelector<HTMLInputElement>("#library-destination")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "E:/New",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Review location change");
      await act(async () => {
        for (const details of document.querySelectorAll("[role=dialog] details")) {
          (details as HTMLDetailsElement).open = true;
          details.dispatchEvent(new Event("toggle"));
        }
      });
      const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
      const bounds = dialog.getBoundingClientRect();
      const offenders = [...dialog.querySelectorAll<HTMLElement>("*")]
        .filter((element) => element.getBoundingClientRect().right > bounds.right + 1)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          text: element.textContent?.slice(0, 100),
        }));
      expect(dialog.scrollWidth, JSON.stringify(offenders)).toBeLessThanOrEqual(
        dialog.clientWidth + 1,
      );
    } finally {
      await page.viewport(original.width, original.height);
    }
  },
);

it.each(["move", "import"] as const)(
  "refreshes the workspace after closing a failed %s without repeating the transfer",
  async (kind) => {
    const reload = vi.mocked(reloadWorkspace).mockClear();
    const expectedError =
      kind === "move" ? "Disk disconnected after copying" : "Copied file changed";
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
      await root.rerender(<LibraryMoveButton disabled={false} />);
      await click("Change library location");
      const input = document.querySelector<HTMLInputElement>("#library-destination")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "E:/New",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Review location change");
      await click("Copy and switch");
    } else {
      await click("Restore from a library copy");
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
  await root.rerender(<LibraryMoveRecovery source="D:/Original" canKeepOriginal={true} />);
  expect(document.body.textContent).toContain(
    "Continue to check the new copy and finish switching libraries.",
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
  await root.rerender(<LibraryMoveRecovery source="D:/Original" canKeepOriginal={false} />);
  expect(document.body.textContent).toContain(
    "The new copy is already active. Continue to finish the location change.",
  );
  expect(document.body.textContent).not.toContain("Keep using original library");
  await click("Continue location change");
  expect(recover).toHaveBeenCalledWith("D:/Original", false);
});

it("prioritizes interrupted-transfer recovery and excludes generic reload until settlement", async () => {
  let fail!: (reason: unknown) => void;
  const recover = vi.spyOn(desktopApi, "recoverLibraryMove").mockImplementation(
    () =>
      new Promise<never>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const choose = vi.fn(async () => {});
  const reset = vi.fn(async () => {});
  await root.rerender(
    <BootstrapRecovery
      chooseLibrary={choose}
      resetLibrary={reset}
      error={{
        code: "conflict",
        message: "An interrupted move needs review.",
        details: {
          retained_source: "D:/Original",
          transfer_id: "exact-move",
          move_abort_available: "true",
        },
      }}
    />,
  );
  const buttons = [...document.querySelectorAll("button")];
  expect(buttons.indexOf(button("Continue location change"))).toBeLessThan(
    buttons.indexOf(button("Retry startup")),
  );
  expect(document.body.textContent).toContain("Original library: D:/Original");
  await click("Continue location change");
  expect(recover).toHaveBeenCalledWith("D:/Original", false);
  for (const label of [
    "Continue location change",
    "Keep using original library",
    "Retry startup",
    "Choose library",
    "Use platform default",
  ])
    expect(button(label).disabled).toBe(true);
  await click("Choose library");
  expect(choose).not.toHaveBeenCalled();
  await act(async () => fail({ message: "Original disk disconnected" }));
  expect(button("Continue location change").disabled).toBe(false);
  expect(button("Retry startup").disabled).toBe(false);
  expect(document.body.textContent).toContain("Original disk disconnected");
});

vi.mock("../file-picker", { spy: true });

vi.mock("../reload-workspace", () => ({ reloadWorkspace: vi.fn() }));
