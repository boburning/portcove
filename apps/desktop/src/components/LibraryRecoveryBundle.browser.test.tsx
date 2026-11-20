import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { desktopApi } from "../api";
import type { LibraryRecoveryBundle, LibraryRecoveryBundlePlan } from "../types";
import { LibraryRecoveryBundleControls } from "./LibraryRecoveryBundle";
import "../styles/index.css";

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

const destination = "D:/backups/Portcove Recovery Bundle";
const source = "E:/library";
const restoreDestination = "D:/Portcove Recovered Library";
const bundle: LibraryRecoveryBundle = {
  bundle_id: "bundle-1",
  created_at: 1_795_140_000,
  format_version: 1,
  path: destination,
  receipt_sha256: "1".repeat(64),
  source_library_id: "library-1",
  coverage: [
    { kind: "user_data", relative_path: "user", files: 2, directories: 1, bytes: 4096 },
    { kind: "source_inbox", relative_path: "source-inbox", files: 1, directories: 1, bytes: 512 },
  ],
  exclusions: ["host_credentials", "external_saves", "external_originals_and_bios"],
};

const plan: LibraryRecoveryBundlePlan = {
  source_root: source,
  source_library_id: bundle.source_library_id,
  destination_root: destination,
  coverage: bundle.coverage,
  exclusions: bundle.exclusions,
  plan_sha256: "2".repeat(64),
  required_bytes: 66_000_000,
  available_bytes: 140_000_000,
};

async function openCreationReview() {
  const review = vi.spyOn(desktopApi, "planLibraryRecoveryBundle").mockResolvedValue(plan);
  await render(<LibraryRecoveryBundleControls generation={7} disabled={false} />);
  const trigger = page.getByRole("button", { name: "Create recovery bundle", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Create recovery bundle" });
  const folder = dialog.getByRole("textbox", { name: "New bundle folder" });
  await expect.element(folder).toHaveFocus();
  await folder.fill(destination);
  await dialog.getByRole("button", { name: "Review bundle creation" }).click();
  expect(review).toHaveBeenCalledExactlyOnceWith(destination, 7);
  return { dialog, trigger };
}

it("reviews coverage before copying and shows the verified bundle after publishing", async () => {
  const create = vi.spyOn(desktopApi, "createLibraryRecoveryBundle").mockResolvedValue(bundle);
  await page.viewport(390, 844);
  const { dialog } = await openCreationReview();
  const review = dialog.getByRole("region", { name: "Creation review" });
  await expect.element(review.getByText("Library saves and settings")).toBeVisible();
  await expect.element(review.getByText("Sign-in credentials")).toBeVisible();
  expect(create).not.toHaveBeenCalled();

  await dialog.getByRole("button", { name: "Copy and verify" }).click();
  expect(create).toHaveBeenCalledExactlyOnceWith(destination, plan.plan_sha256, 7);
  const verified = dialog.getByRole("region", { name: "Verified recovery bundle" });
  await expect.element(verified.getByText("Bundle verified")).toBeVisible();
  await expect.element(verified.getByText(destination)).toBeVisible();
  await expect.element(verified.getByText("Imported game files")).toBeVisible();
  const bounds = dialog.element().getBoundingClientRect();
  expect(bounds.width).toBeLessThanOrEqual(390);
  expect(page.getByRole("button", { name: "Restore library", exact: true }).query()).toBeNull();
});

it("returns keyboard focus to the entry action when closing a review before copying", async () => {
  const create = vi.spyOn(desktopApi, "createLibraryRecoveryBundle");
  const { trigger } = await openCreationReview();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  expect(create).not.toHaveBeenCalled();
});

it("verifies the bundle before a distinct restore review and keeps activation separate", async () => {
  const verify = vi.spyOn(desktopApi, "inspectLibraryRecoveryBundle").mockResolvedValue(bundle);
  const restoreReview = {
    bundle,
    destination_root: restoreDestination,
    required_bytes: plan.required_bytes,
    available_bytes: plan.available_bytes,
    plan_sha256: "3".repeat(64),
  };
  const review = vi
    .spyOn(desktopApi, "planLibraryRecoveryRestore")
    .mockResolvedValue(restoreReview);
  const restore = vi.spyOn(desktopApi, "restoreLibraryRecoveryBundle").mockResolvedValue({
    completed: true,
    destination_root: restoreDestination,
    input_retained: true,
    transfer_id: "restore-1",
  });
  await render(<LibraryRecoveryBundleControls generation={7} disabled={false} />);
  await page.getByRole("button", { name: "Inspect or restore a bundle" }).click();
  const dialog = page.getByRole("dialog", { name: "Inspect or restore a bundle" });
  await dialog.getByRole("textbox", { name: "Recovery bundle folder" }).fill(destination);
  await dialog.getByRole("button", { name: "Verify bundle" }).click();
  expect(verify).toHaveBeenCalledExactlyOnceWith(destination);
  expect(review).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  await dialog.getByRole("textbox", { name: "Restore destination" }).fill(restoreDestination);
  await dialog.getByRole("button", { name: "Review restore" }).click();
  expect(review).toHaveBeenCalledExactlyOnceWith(destination, restoreDestination, 7);
  expect(restore).not.toHaveBeenCalled();
  await dialog.getByRole("button", { name: "Restore library", exact: true }).click();
  expect(restore).toHaveBeenCalledExactlyOnceWith(
    destination,
    restoreDestination,
    restoreReview.plan_sha256,
    7,
  );
  await expect.element(dialog.getByText("Library restored", { exact: true })).toBeVisible();
  await expect
    .element(dialog.getByText("To use it, close this review", { exact: false }))
    .toBeVisible();
  expect(dialog.getByRole("button", { name: /^Open library$/ }).query()).toBeNull();
});

it("resumes only the reported staging folder after reading the current generation", async () => {
  const staging = "D:/backups/.portcove-recovery-bundle-stage";
  const create = vi.spyOn(desktopApi, "createLibraryRecoveryBundle").mockRejectedValue({
    message: "The copy stopped",
    details: { recovery_staging: staging },
  });
  const resumed = vi.spyOn(desktopApi, "resumeLibraryRecoveryBundle").mockResolvedValue(bundle);
  const read = vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue({
    ready: true,
    library_root: source,
    generation: 8,
    error: null,
    selection: null,
  });
  const { dialog } = await openCreationReview();
  await dialog.getByRole("button", { name: "Copy and verify" }).click();
  await expect.element(dialog.getByText(staging)).toBeVisible();
  expect(resumed).not.toHaveBeenCalled();
  await dialog.getByRole("button", { name: "Resume bundle creation" }).click();
  expect(read).toHaveBeenCalledOnce();
  expect(resumed).toHaveBeenCalledExactlyOnceWith(staging, 8);
  expect(create).toHaveBeenCalledOnce();
  await expect.element(dialog.getByText("Bundle verified")).toBeVisible();
});
