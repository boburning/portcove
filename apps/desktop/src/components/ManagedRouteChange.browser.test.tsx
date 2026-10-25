import { cleanup, render, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import { failureReport, portDefinition } from "../test-fixtures";
import type { InstallRecord, ManagedRouteChangePreview } from "../types";
import { ManagedRouteChangeControl } from "./ManagedRouteChange";

const port = { ...portDefinition(), adapter: "native-portable" as const };
const installation: InstallRecord = {
  id: "managed-1",
  port_id: port.id,
  version: "v2",
  path: "E:/Portcove/versions/sample/accepted",
  channel: "stable",
  installed_at: 2,
  verified: true,
  staged: false,
  artifact: { asset_name: "sample.zip", sha256: "a".repeat(64), size: 1024 },
  manifest_sha256: "b".repeat(64),
  runtime: null,
  selected_executable: "game.exe",
};
const preview: ManagedRouteChangePreview = {
  port_id: port.id,
  current_registration: {
    id: "external-1",
    port_id: port.id,
    version: "user-managed",
    platform: "windows-x86-64",
    path: "C:/Player/Sample",
    executable: "C:/Player/Sample/game.exe",
    registered_at: 1,
    archive_sha256: "",
    immutable_tree_sha256: "",
    user_selected: { arguments: [] },
  },
  installation: {
    port_id: port.id,
    channel: "stable",
    platform: "windows-x86-64",
    action: "download",
    bundled_runtime: null,
    download_bytes: 1024,
    source_requirements: [],
    release: {
      version: "v2",
      channel: "stable",
      published_at: null,
      asset: {
        name: "sample.zip",
        url: "https://example.com/sample.zip",
        size: 1024,
        sha256: "a".repeat(64),
      },
    },
    storage: {
      library_root: "E:/Portcove",
      volume_available_bytes: 1024 ** 4,
      volume_total_bytes: 1024 ** 4,
    },
    output_location: {
      port_id: port.id,
      library_root: "E:/Portcove",
      configured_output_directory: null,
      default_output_directory: "E:/Portcove/versions/sample",
      effective_output_directory: "E:/Portcove/versions/sample",
      user_data_root: "E:/Portcove/user/sample",
      selection_source: "library_default",
    },
  },
  update_policy: "notify",
  permitted: true,
  reason: null,
  external_files_will_be_preserved: true,
  external_data_will_be_copied: false,
  preview_sha256: "reviewed-route",
};
let root: RenderResult;
beforeEach(async () => {
  await page.viewport(360, 800);
  vi.spyOn(desktopApi, "previewManagedRouteChange").mockResolvedValue(preview);
  root = await render(<ManagedRouteChangeControl port={port} generation={7} busy={false} />);
});
afterEach(async () => {
  await cleanup();
  await page.viewport(1280, 800);
  vi.restoreAllMocks();
});

it("reviews a separate managed copy before consent and leaves Play explicit", async () => {
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime").mockResolvedValue({
    installation,
    previous_registration: preview.current_registration,
    external_files_preserved: true,
  });
  const remove = vi.spyOn(desktopApi, "removeExternalRuntime");
  const launch = vi.spyOn(desktopApi, "launch");
  const changed = vi.fn();
  await root.rerender(
    <ManagedRouteChangeControl port={port} generation={7} busy={false} onChanged={changed} />,
  );
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeEnabled();
  expect(apply).not.toHaveBeenCalled();
  await expect
    .element(page.getByText("E:/Portcove/versions/sample", { exact: true }))
    .toBeVisible();
  expect(document.body.textContent?.replace(/\s+/gu, " ")).toContain(
    "external saves are not copied",
  );
  const dialog = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
  expect(dialog).toBeDefined();
  expect(dialog!.left).toBeGreaterThanOrEqual(0);
  expect(dialog!.right).toBeLessThanOrEqual(360);
  await page.getByRole("button", { name: "Create managed copy" }).click();
  expect(apply).toHaveBeenCalledExactlyOnceWith(port.id, "reviewed-route", 7);
  expect(changed).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it("shows the Core hold while keeping the current copy intact", async () => {
  vi.mocked(desktopApi.previewManagedRouteChange).mockResolvedValue({
    ...preview,
    permitted: false,
    reason: "Portcove already has saved data for this game. Preserve it before changing routes.",
  });
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime");
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect
    .element(
      page.getByText(
        "Portcove already has saved data for this game. Preserve it before changing routes.",
        { exact: true },
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeDisabled();
  expect(apply).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Review a Portcove-managed copy…" }))
    .toBeVisible();
});

it("retains a committed failure until the player refreshes the authoritative installation", async () => {
  const error = failureReport();
  error.presentation.mutation_state = "committed";
  error.presentation.summary =
    "The managed copy v2 is active. Restart Portcove to finish recovery; external files were preserved.";
  vi.spyOn(desktopApi, "changeToManagedRuntime").mockRejectedValue(error);
  const changed = vi.fn();
  await root.rerender(
    <ManagedRouteChangeControl port={port} generation={7} busy={false} onChanged={changed} />,
  );
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeEnabled();
  await page.getByRole("button", { name: "Create managed copy" }).click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("button", { name: "Refresh current installation" }))
    .toBeVisible();
  expect(document.body.textContent).not.toContain("Create managed copy");
  await page.getByRole("button", { name: "Refresh current installation" }).click();
  expect(changed).toHaveBeenCalledOnce();
});

it.each([
  { external_files_will_be_preserved: false, external_data_will_be_copied: false },
  { external_files_will_be_preserved: true, external_data_will_be_copied: true },
])("refuses changed preservation guarantees: %j", async (guarantees) => {
  vi.mocked(desktopApi.previewManagedRouteChange).mockResolvedValue({ ...preview, ...guarantees });
  const apply = vi.spyOn(desktopApi, "changeToManagedRuntime");
  await page.getByRole("button", { name: "Review a Portcove-managed copy…" }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "This proposed change has different file or data handling. Keep your current copy and update Portcove before reviewing it again.",
    );
  await expect.element(page.getByRole("button", { name: "Create managed copy" })).toBeDisabled();
  expect(document.body.textContent).not.toContain("external saves are not copied");
  expect(apply).not.toHaveBeenCalled();
});
