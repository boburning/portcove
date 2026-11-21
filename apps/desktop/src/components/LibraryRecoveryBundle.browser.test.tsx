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
    await expect.element(dialog).not.toBeInTheDocument();
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

async function openRestoreReview() {
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
  const receipt = {
    completed: true,
    destination_root: restoreDestination,
    input_retained: true,
    transfer_id: "restore-1",
  };
  await render(
    <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />,
  );
  await page.getByRole("button", { name: "Inspect or restore a bundle" }).click();
  const dialog = page.getByRole("dialog", { name: "Inspect or restore a bundle" });
  await dialog.getByRole("textbox", { name: "Recovery bundle folder" }).fill(destination);
  await dialog.getByRole("button", { name: "Verify bundle" }).click();
  expect(verify).toHaveBeenCalledExactlyOnceWith(destination);
  expect(review).not.toHaveBeenCalled();
  await dialog.getByRole("textbox", { name: "Restore destination" }).fill(restoreDestination);
  await dialog.getByRole("button", { name: "Review restore" }).click();
  expect(review).toHaveBeenCalledExactlyOnceWith(destination, restoreDestination, 7);
  return { dialog, restoreReview, receipt };
}

it("verifies the bundle before a distinct restore review and keeps activation separate", async () => {
  const restore = vi.spyOn(desktopApi, "restoreLibraryRecoveryBundle");
  const readRestore = vi.spyOn(desktopApi, "readLibraryRecoveryRestore");
  const { dialog, restoreReview, receipt } = await openRestoreReview();
  restore.mockResolvedValue(receipt);
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
  expect(readRestore).not.toHaveBeenCalled();
});

it.for([
  { outcome: "lost reply", failure: new Error("The desktop reply was interrupted") },
  {
    outcome: "post-publication error",
    failure: {
      message: "Portcove could not archive the completed restore journal",
      details: {
        import_destination: restoreDestination,
        recovery_action: "resume_library_recovery_restore",
        transfer_id: "restore-1",
      },
    },
  },
])("checks the exact reviewed restore after $outcome", async ({ failure }) => {
  const { dialog, restoreReview, receipt } = await openRestoreReview();
  const restore = vi.spyOn(desktopApi, "restoreLibraryRecoveryBundle").mockRejectedValue(failure);
  const readRestore = vi
    .spyOn(desktopApi, "readLibraryRecoveryRestore")
    .mockResolvedValueOnce({ ...receipt, destination_root: source })
    .mockResolvedValue(receipt);

  await dialog.getByRole("button", { name: "Restore library", exact: true }).click();
  const check = dialog.getByRole("button", { name: "Check reviewed restore again" });
  await check.click();
  await expect
    .element(dialog.getByText("Portcove could not verify the reviewed restore destination."))
    .toBeVisible();
  await check.click();
  await expect.element(dialog.getByText("Library restored", { exact: true })).toBeVisible();
  await expect
    .element(dialog.getByRole("button", { name: "Resume bundle restore" }))
    .not.toBeInTheDocument();
  expect(dialog.getByRole("button", { name: /^Open library$/ }).query()).toBeNull();
  expect(readRestore.mock.calls).toEqual([
    [restoreDestination, restoreReview.plan_sha256],
    [restoreDestination, restoreReview.plan_sha256],
  ]);
  expect(restore).toHaveBeenCalledOnce();
});

it("resumes only the transfer identified by the reviewed restore check", async () => {
  const { dialog, receipt } = await openRestoreReview();
  vi.spyOn(desktopApi, "restoreLibraryRecoveryBundle").mockRejectedValue(
    new Error("The desktop reply was interrupted"),
  );
  vi.spyOn(desktopApi, "readLibraryRecoveryRestore").mockRejectedValue({
    message: "The reviewed restore has not finished",
    details: {
      import_destination: restoreDestination,
      recovery_action: "resume_library_recovery_restore",
      transfer_id: receipt.transfer_id,
    },
  });
  vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue({
    ready: true,
    generation: 8,
    library_root: source,
    error: null,
    selection: null,
  });
  const resume = vi.spyOn(desktopApi, "resumeLibraryRecoveryRestore").mockResolvedValue(receipt);

  await dialog.getByRole("button", { name: "Restore library", exact: true }).click();
  await dialog.getByRole("button", { name: "Check reviewed restore again" }).click();
  await dialog.getByRole("button", { name: "Resume bundle restore" }).click();
  await expect.element(dialog.getByText("Library restored", { exact: true })).toBeVisible();
  expect(resume).toHaveBeenCalledExactlyOnceWith(
    restoreDestination,
    8,
    expect.any(Function),
    receipt.transfer_id,
  );
});

it("verifies a published receipt after a fresh review without copying or resuming", async () => {
  vi.spyOn(desktopApi, "planLibraryRecoveryBundle").mockRejectedValue({
    message:
      "A previous copy was published to this folder. Check the bundle to verify its contents.",
    details: {
      recovery_action: "read_published_recovery_bundle",
      recovery_destination: destination,
      recovery_bundle_id: bundle.bundle_id,
      recovery_source_library_id: bundle.source_library_id,
      recovery_plan_sha256: plan.plan_sha256,
    },
  });
  const read = vi
    .spyOn(desktopApi, "inspectLibraryRecoveryBundle")
    .mockResolvedValueOnce({ ...bundle, bundle_id: "another-bundle" })
    .mockResolvedValue(bundle);
  const copy = vi.spyOn(desktopApi, "createLibraryRecoveryBundle");
  const resume = vi.spyOn(desktopApi, "resumeLibraryRecoveryBundle");
  await render(
    <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />,
  );
  await page.getByRole("button", { name: "Create recovery bundle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create recovery bundle" });
  await dialog.getByRole("textbox", { name: "New bundle folder" }).fill(destination);
  await dialog.getByRole("button", { name: "Review bundle creation" }).click();
  const verify = dialog.getByRole("button", { name: "Verify published bundle" });
  await expect.element(verify).toBeVisible();
  expect(read).not.toHaveBeenCalled();
  await verify.click();
  await expect
    .element(dialog.getByText("The verified bundle does not match the reviewed copy."))
    .toBeVisible();
  await expect.element(dialog.getByText("Bundle verified")).not.toBeInTheDocument();
  await expect.element(verify).toHaveFocus();
  await verify.click();
  await expect.element(dialog.getByText("Bundle verified")).toBeVisible();
  expect(read.mock.calls).toEqual([
    [destination, plan.plan_sha256],
    [destination, plan.plan_sha256],
  ]);
  expect(copy).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
});

it("offers the exact interrupted creation after a fresh review and clears it when the folder changes", async () => {
  const staging = "D:/backups/.portcove-recovery-bundle-stage";
  const review = vi.spyOn(desktopApi, "planLibraryRecoveryBundle").mockRejectedValue({
    code: "conflict",
    message: "An interrupted copy is waiting for this bundle folder.",
    details: { recovery_staging: staging },
    presentation: {
      mutation_state: "unknown",
      phase: null,
      presentation_key: "conflict",
      recovery_actions: [],
      summary: "The selection changed or another operation is using it. Review its current state.",
      technical_context: {},
      technical_message: "An interrupted copy is waiting for this bundle folder.",
      tone: "error",
    },
  });
  const copy = vi.spyOn(desktopApi, "createLibraryRecoveryBundle");
  const resume = vi.spyOn(desktopApi, "resumeLibraryRecoveryBundle").mockResolvedValue(bundle);

  await render(
    <LibraryRecoveryBundleControls generation={7} libraryRoot={source} disabled={false} />,
  );
  await page.getByRole("button", { name: "Create recovery bundle", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create recovery bundle" });
  const folder = dialog.getByRole("textbox", { name: "New bundle folder" });
  const reviewAction = dialog.getByRole("button", { name: "Review bundle creation" });
  const resumeAction = dialog.getByRole("button", { name: "Resume bundle creation" });
  await folder.fill(destination);
  await reviewAction.click();
  await expect.element(dialog.getByText(staging)).toBeVisible();
  await expect.element(resumeAction).toBeVisible();
  const feedback = dialog.getByRole("alert");
  await expect
    .element(
      feedback.getByText("An interrupted copy is waiting for this bundle folder.", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(feedback.getByText(/confirm whether anything changed/))
    .not.toBeInTheDocument();
  await expect.element(feedback.getByText("View technical details")).toBeVisible();
  expect(resume).not.toHaveBeenCalled();

  await folder.fill("D:/backups/Another bundle");
  await expect.element(dialog.getByText(staging)).not.toBeInTheDocument();
  await expect.element(resumeAction).not.toBeInTheDocument();

  await folder.fill(destination);
  await reviewAction.click();
  await resumeAction.click();
  expect(review.mock.calls).toEqual([
    [destination, 7],
    [destination, 7],
  ]);
  expect(resume).toHaveBeenCalledExactlyOnceWith(staging, 7, expect.any(Function));
  expect(copy).not.toHaveBeenCalled();
  await expect.element(dialog.getByText("Bundle verified")).toBeVisible();
  await expect.element(dialog.getByText(destination, { exact: true })).toBeVisible();
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
