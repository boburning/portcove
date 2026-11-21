import { useState, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { desktopApi } from "../api";
import { BootstrapRecovery } from "../App";
import type { LibraryRecoveryBundle, LibraryRecoveryBundlePlan, OperationEvent } from "../types";
import {
  LibraryRecoveryBundleContinuation,
  LibraryRecoveryBundleControls,
  LibraryRecoveryBundleProvider,
} from "./LibraryRecoveryBundle";
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

async function openCreationReview(
  surface: ReactNode = (
    <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />
  ),
) {
  const review = vi.spyOn(desktopApi, "planLibraryRecoveryBundle").mockResolvedValue(plan);
  await render(surface);
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
  await expect
    .element(dialog.getByText(/original computer and its secure credential store/))
    .toBeVisible();
  await expect.element(review.getByText(/folders private to your account/)).toBeVisible();
  await expect.element(review.getByText("Library saves and settings")).toBeVisible();
  await expect.element(review.getByText("Sign-in credentials")).toBeVisible();
  expect(create).not.toHaveBeenCalled();

  await dialog.getByRole("button", { name: "Copy and verify" }).click();
  expect(create).toHaveBeenCalledExactlyOnceWith(
    destination,
    plan.plan_sha256,
    7,
    expect.any(Function),
  );
  const verified = dialog.getByRole("region", { name: "Verified recovery bundle" });
  await expect.element(verified.getByText("Bundle verified")).toBeVisible();
  await expect
    .element(verified.getByText(/original computer and its secure credential store/))
    .toBeVisible();
  await expect.element(verified.getByText(destination)).toBeVisible();
  await expect.element(verified.getByText("Imported game files")).toBeVisible();
  const bounds = dialog.element().getBoundingClientRect();
  expect(bounds.width).toBeLessThanOrEqual(390);
  expect(page.getByRole("button", { name: "Restore library", exact: true }).query()).toBeNull();
});

it.each([
  {
    name: "Retained update download",
    message: /Open Versions for the game below/,
    exactId: "download-1",
    details: {
      recovery_action: "discard_game_update_acquisition",
      port_id: "exact-port",
      acquisition_id: "download-1",
    },
  },
  {
    name: "Managed installation outside the library",
    message: /Open Manage for the game below/,
    exactId: "install-1",
    details: {
      recovery_action: "review_managed_installation_location",
      port_id: "exact-port",
      install_id: "install-1",
    },
  },
])(
  "retains the exact port and next action for $name",
  async ({ name, message, exactId, details }) => {
    vi.spyOn(desktopApi, "planLibraryRecoveryBundle").mockRejectedValue({
      message: "The copy is held",
      details,
    });
    const copy = vi.spyOn(desktopApi, "createLibraryRecoveryBundle");
    await render(
      <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />,
    );
    await page.getByRole("button", { name: "Create recovery bundle", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create recovery bundle" });
    await dialog.getByRole("textbox", { name: "New bundle folder" }).fill(destination);
    await dialog.getByRole("button", { name: "Review bundle creation" }).click();
    const blocker = dialog.getByRole("region", { name });
    await expect.element(blocker.getByText(message)).toBeVisible();
    await expect.element(blocker.getByText("exact-port")).toBeVisible();
    await expect.element(blocker.getByText(exactId, { exact: true })).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Copy and verify" }))
      .not.toBeInTheDocument();
    expect(copy).not.toHaveBeenCalled();
  },
);

it("waits for the copy worker to stop and offers continuation from its exact staging folder", async () => {
  const staging = "D:/backups/.portcove-recovery-bundle-stage";
  let stopCopy!: () => void;
  const pending = new Promise<LibraryRecoveryBundle>((_resolve, reject) => {
    stopCopy = () =>
      reject({
        message: "Recovery copy stopped.",
        details: { recovery_staging: staging },
      });
  });
  const progress = {
    schema_version: 3,
    type: "progress",
    operation: "copy_recovery_bundle",
    operation_id: "copy-operation",
    parent_operation_id: null,
    target: null,
    sequence: 1,
    timestamp_ms: 1,
    phase: "Copying recovery data",
    completed: 4096,
    total: 16384,
    unit: "bytes",
  } satisfies OperationEvent;
  const copy = vi
    .spyOn(desktopApi, "createLibraryRecoveryBundle")
    .mockImplementation((_destination, _plan, _generation, report) => {
      report?.(progress);
      return pending;
    });
  const cancel = vi.spyOn(desktopApi, "cancelOperation").mockResolvedValue({
    phase: "preparing",
    requested: true,
  });
  function Workspace() {
    const [showSettings, setShowSettings] = useState(true);
    return (
      <LibraryRecoveryBundleProvider>
        <button onClick={() => setShowSettings(false)}>Open Activity</button>
        {showSettings ? (
          <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />
        ) : (
          <h1>Activity</h1>
        )}
        <LibraryRecoveryBundleContinuation />
      </LibraryRecoveryBundleProvider>
    );
  }
  const { dialog } = await openCreationReview(<Workspace />);
  try {
    await dialog.getByRole("button", { name: "Copy and verify", exact: true }).click();
    await expect
      .element(dialog.getByRole("progressbar", { name: "Recovery data copied" }))
      .toBeVisible();
    await dialog.getByRole("button", { name: "Hide details", exact: true }).click();
    await expect.element(dialog).not.toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Create recovery bundle", exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: "Open Activity", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Activity", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "View recovery bundle operation", exact: true }).click();
    const cancelButton = dialog.getByRole("button", { name: "Cancel copy", exact: true });
    await cancelButton.click();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("copy-operation");
    await expect.element(cancelButton).toBeDisabled();
    await expect
      .element(dialog.getByRole("button", { name: "Resume bundle creation", exact: true }))
      .not.toBeInTheDocument();
    stopCopy();
    await expect.element(dialog.getByText(staging, { exact: true })).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Resume bundle creation", exact: true }))
      .toBeEnabled();
    await expect
      .element(dialog.getByText("Bundle verified", { exact: true }))
      .not.toBeInTheDocument();
    expect(copy).toHaveBeenCalledOnce();
  } finally {
    stopCopy();
  }
});

it("checks the exact reviewed destination after losing the create reply", async () => {
  const create = vi
    .spyOn(desktopApi, "createLibraryRecoveryBundle")
    .mockRejectedValueOnce(new Error("The create reply was lost"));
  const inspect = vi.spyOn(desktopApi, "inspectLibraryRecoveryBundle").mockResolvedValue(bundle);
  const { dialog } = await openCreationReview();
  await dialog.getByRole("button", { name: "Copy and verify", exact: true }).click();
  await dialog.getByRole("button", { name: "Check reviewed bundle again", exact: true }).click();
  expect(inspect).toHaveBeenCalledExactlyOnceWith(destination, plan.plan_sha256);
  await expect.element(dialog.getByText("Bundle verified", { exact: true })).toBeVisible();
  expect(create).toHaveBeenCalledOnce();
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
  await render(
    <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />,
  );
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
    expect.any(Function),
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
  const resumed = vi
    .spyOn(desktopApi, "resumeLibraryRecoveryBundle")
    .mockRejectedValueOnce(new Error("The staging drive is temporarily unavailable"))
    .mockResolvedValue(bundle);
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
  await expect
    .element(dialog.getByText("The staging drive is temporarily unavailable"))
    .toBeVisible();
  await expect.element(dialog.getByText(staging)).toBeVisible();
  await dialog.getByRole("button", { name: "Resume bundle creation" }).click();
  expect(read).toHaveBeenCalledTimes(2);
  expect(resumed.mock.calls).toEqual([
    [staging, 8, expect.any(Function)],
    [staging, 8, expect.any(Function)],
  ]);
  expect(create).toHaveBeenCalledOnce();
  await expect.element(dialog.getByText("Bundle verified")).toBeVisible();
});

it("opens a restored startup library only after an explicit selection review", async () => {
  vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue({
    ready: false,
    library_root: null,
    generation: 8,
    error: null,
    selection: null,
  });
  const resume = vi.spyOn(desktopApi, "resumeLibraryRecoveryRestore").mockResolvedValue({
    completed: true,
    destination_root: restoreDestination,
    input_retained: true,
    transfer_id: "restore-1",
  });
  const switchLibrary = vi.fn(async () => {});
  await render(
    <BootstrapRecovery
      error={{
        code: "conflict",
        message: "Restore needs recovery",
        details: {
          import_destination: restoreDestination,
          recovery_action: "resume_library_recovery_restore",
          transfer_id: "restore-1",
        },
      }}
      switchLibrary={switchLibrary}
    />,
  );
  await page.getByRole("button", { name: "Resume bundle restore", exact: true }).click();
  expect(resume).toHaveBeenCalledExactlyOnceWith(restoreDestination, 8);
  await expect
    .element(page.getByText("The library has been restored.", { exact: false }))
    .toBeVisible();
  expect(switchLibrary).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Open restored library", exact: true }).click();
  expect(switchLibrary).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Open reviewed library", exact: true }).click();
  expect(switchLibrary).toHaveBeenCalledExactlyOnceWith(restoreDestination);
});
