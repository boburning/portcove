import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { AdoptionBatchPreview, AdoptionBatchResult } from "../types";
import { LauncherBatchCopy, type LauncherBatchSelection } from "./LauncherBatchCopy";

const selection: LauncherBatchSelection[] = [
  { item: { source: "C:/Apps/A", port_id: "a" }, label: "Game A" },
  { item: { source: "C:/Apps/B", port_id: "b" }, label: "Game B" },
];

function itemPreview(source: string, port: string, active?: string) {
  return {
    source,
    detected_port_ids: [port],
    selected_port_id: port,
    application_files_will_be_copied: true,
    original_will_be_modified: false,
    copy_plan: { directories: [], files: [], skipped_entries: [], total_bytes: 0 },
    destination: {
      output_location: {
        port_id: port,
        library_root: "D:/L",
        default_output_directory: "D:/L/v",
        configured_output_directory: null,
        effective_output_directory: "D:/L/v",
        selection_source: "library_default",
        user_data_root: "D:/L/u",
      },
      active_install: active
        ? ({ version: active } as unknown as NonNullable<
            AdoptionBatchPreview["items"][number]["destination"]
          >["active_install"])
        : null,
      imported_user_data_paths: [],
      current_user_data_files: 0,
      current_user_data_sha256: null,
    },
    plan_sha256: "b".repeat(64),
  } as AdoptionBatchPreview["items"][number];
}

const preview: AdoptionBatchPreview = {
  items: [itemPreview("C:/Apps/A", "a", "1.0"), itemPreview("C:/Apps/B", "b")],
  total_files: 12,
  total_bytes: 2048,
  items_replacing_saved_files: 1,
  original_will_be_modified: false,
  batch_sha256: "c".repeat(64),
};

const result: AdoptionBatchResult = {
  batch_sha256: "c".repeat(64),
  items: [
    { source: "C:/Apps/A", port_id: "a", outcome: "copied", install: null, message: null },
    {
      source: "C:/Apps/B",
      port_id: "b",
      outcome: "changed",
      install: null,
      message: "The folder changed after review.",
    },
  ],
};

async function render(
  items: LauncherBatchSelection[],
  reviewBatch = vi.fn(async () => preview),
  copyBatch = vi.fn(async (): Promise<AdoptionBatchResult | null> => result),
  copied = vi.fn(),
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <LauncherBatchCopy
        selection={items}
        disabled={false}
        reviewBatch={reviewBatch}
        copyBatch={copyBatch}
        copied={copied}
        gameName={(portId) => `Catalog ${portId.toUpperCase()} (${portId})`}
      />,
    ),
  );
  return {
    root,
    reviewBatch,
    copyBatch,
    copied,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("needs two apps before offering a several-app review, with readable guidance", async () => {
  const view = await render(selection.slice(0, 1));
  try {
    await expect
      .element(page.getByText(/^1 app selected\. Select at least one more/))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Review copying the selected apps" }))
      .toBeDisabled();
  } finally {
    await view.cleanup();
  }
});

it("reviews the selected apps once, discloses consequences, then reports each outcome", async () => {
  const view = await render(selection);
  try {
    await page.getByRole("button", { name: "Review copying the selected apps" }).click();
    expect(view.reviewBatch).toHaveBeenCalledWith(selection.map(({ item }) => item));
    await expect
      .element(page.getByText(/2 apps · 12 files · .* to copy into Portcove/))
      .toBeVisible();
    await expect.element(page.getByText(/^Game A → Catalog A \(a\)/)).toBeVisible();
    await expect
      .element(page.getByText("Becomes the active version; 1.0 stays installed."))
      .toBeVisible();
    await expect
      .element(page.getByText(/For 1 game, matching saved files already in Portcove are replaced/))
      .toBeVisible();
    await page.getByRole("button", { name: "Continue to copy confirmation" }).click();
    expect(view.copyBatch).toHaveBeenCalledWith(
      selection.map(({ item }) => item),
      preview.batch_sha256,
    );
    await expect.element(page.getByText("Copied 1 app of 2.")).toBeVisible();
    // Focus moves to the result, and the parent clears the selection so nothing is copied twice.
    await expect.poll(() => document.activeElement?.textContent).toBe("Copied 1 app of 2.");
    expect(view.copied).toHaveBeenCalledOnce();
    await expect.element(page.getByText(/^Game B: Changed after review; not copied/)).toBeVisible();
    await expect.element(page.getByText("The folder changed after review.")).toBeVisible();
  } finally {
    await view.cleanup();
  }
});

it("keeps the review when the native confirmation is declined", async () => {
  const view = await render(
    selection,
    vi.fn(async () => preview),
    vi.fn(async (): Promise<AdoptionBatchResult | null> => null),
  );
  try {
    await page.getByRole("button", { name: "Review copying the selected apps" }).click();
    await page.getByRole("button", { name: "Continue to copy confirmation" }).click();
    await expect.element(page.getByText(/to copy into Portcove/)).toBeVisible();
    expect(page.getByText(/^Copied/).elements()).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});

it("hides a review once the selection changes", async () => {
  const view = await render(selection);
  try {
    await page.getByRole("button", { name: "Review copying the selected apps" }).click();
    await expect.element(page.getByText(/to copy into Portcove/)).toBeVisible();
    await act(async () =>
      view.root.render(
        <LauncherBatchCopy
          selection={[...selection, { item: { source: "C:/Apps/C", port_id: "c" }, label: "C" }]}
          disabled={false}
          reviewBatch={view.reviewBatch}
          copyBatch={view.copyBatch}
          copied={view.copied}
        />,
      ),
    );
    expect(page.getByText(/to copy into Portcove/).elements()).toHaveLength(0);
  } finally {
    await view.cleanup();
  }
});
