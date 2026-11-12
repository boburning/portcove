import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { LauncherLibraryEntry, LauncherLibraryInventory } from "../types";
import {
  LauncherLibraryImport,
  entryDetails,
  launcherEntryCanBeBatched,
  launcherEntryCanBeReviewed,
} from "./LauncherLibraryImport";

function entry(overrides: Partial<LauncherLibraryEntry>): LauncherLibraryEntry {
  return {
    index: 0,
    name: "Game",
    repository_source: "github",
    repository: "owner/game",
    folder_name: "Game",
    install_path: "C:\\Apps\\Game",
    explicit_install_path: false,
    status: "ready-to-review",
    candidate_port_ids: ["game"],
    detected_port_ids: ["game"],
    user_data_paths: [],
    hints: { preferred_version: null, installed_version_label: null, selected_executable: null },
    mods: null,
    explanation: "Review the copy plan before Portcove copies this installation.",
    adopt_port_id: "game",
    shares_folder_with: null,
    not_carried_over: [],
    ...overrides,
  };
}

const inventory: LauncherLibraryInventory = {
  launcher: "quiver",
  format_revision: "66c45cbe2779818791948c7bd769d388e3a47b44",
  data_root: "C:\\Quiver",
  library_file: "C:\\Quiver\\apps.json",
  legacy_library_file: false,
  apps_root: "C:\\Apps",
  apps_root_origin: "settings",
  entries: [
    entry({
      not_carried_over: ["custom launch command"],
      user_data_paths: ["saves"],
      mods: { records: 2, providers: ["gamebanana"], readable: true },
    }),
    entry({
      index: 1,
      name: "Shared",
      folder_name: "Shared",
      install_path: "C:\\Apps\\Shared",
      status: "ambiguous",
      adopt_port_id: null,
      detected_port_ids: ["a", "b"],
      explanation: "Several catalog ports match these files.",
    }),
    entry({
      index: 2,
      name: "Other",
      status: "not-in-catalog",
      adopt_port_id: null,
      explanation: "No catalog port uses this upstream repository.",
    }),
  ],
  skipped_entries: [{ index: 3, reason: "entry is not an object" }],
  original_will_be_modified: false,
  inventory_sha256: "0".repeat(64),
};

it("offers review only for matched launcher apps that have a folder", () => {
  expect(launcherEntryCanBeReviewed(entry({}))).toBe(true);
  expect(launcherEntryCanBeReviewed(entry({ status: "ambiguous", adopt_port_id: null }))).toBe(
    true,
  );
  expect(launcherEntryCanBeReviewed(entry({ install_path: null }))).toBe(false);
  for (const status of [
    "not-in-catalog",
    "unrecognized-files",
    "adoption-unsupported",
    "not-installed",
    "unsafe-path",
    "duplicate",
  ] as const)
    expect(launcherEntryCanBeReviewed(entry({ status }))).toBe(false);
});

it("lists a chosen launcher's apps and hands only reviewable ones to the copy review", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const inspect = vi.fn(async () => inventory);
  const choose = vi.fn();
  try {
    await act(async () =>
      root.render(<LauncherLibraryImport disabled={false} inspect={inspect} choose={choose} />),
    );
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await expect.element(page.getByRole("button", { name: "List apps" })).toBeDisabled();
    await page.getByRole("button", { name: "Quiver", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Quiver", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.fill(page.getByLabelText("Quiver data folder"), "  C:\\Quiver  ");
    await page.getByRole("button", { name: "List apps" }).click();
    expect(inspect).toHaveBeenCalledWith("quiver", "C:\\Quiver", undefined);
    await expect
      .element(page.getByText("3 apps listed · 1 ready to review · 1 unreadable entry skipped"))
      .toBeVisible();
    await expect.element(page.getByText("Not carried over: custom launch command")).toBeVisible();
    await expect.element(page.getByText("Saves and settings found: saves")).toBeVisible();
    await expect.element(page.getByText(/^2 launcher mod records, listed only/)).toBeVisible();
    expect(page.getByRole("button", { name: "Review copying Other" }).elements()).toHaveLength(0);
    // No app is missing its folder, so no apps-folder recovery is offered.
    expect(page.getByLabelText("Apps folder, if it moved").elements()).toHaveLength(0);
    await page.getByRole("button", { name: "Review copying Shared" }).click();
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ name: "Shared" }));
    // Choosing collapses the list so the copy review is next; it can be reopened.
    await expect.poll(() => document.querySelector("details")?.open).toBe(false);
    // Focus stays on the collapsed list's summary rather than falling to the page.
    await expect.poll(() => document.activeElement?.tagName).toBe("SUMMARY");
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await page.getByRole("button", { name: "Review copying Game" }).click();
    expect(choose).toHaveBeenLastCalledWith(expect.objectContaining({ adopt_port_id: "game" }));

    // Changing the folder discards results from the previous request.
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await userEvent.fill(page.getByLabelText("Quiver data folder"), "C:\\Elsewhere");
    expect(page.getByText(/apps listed/).elements()).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("offers a moved apps folder and lists again with it when apps were not found", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const unresolved: LauncherLibraryInventory = {
    ...inventory,
    apps_root: null,
    apps_root_origin: "unresolved",
    entries: [
      entry({ status: "not-installed", install_path: "C:\\Old\\Game", adopt_port_id: null }),
    ],
    skipped_entries: [],
  };
  const inspect = vi.fn(async () => unresolved);
  try {
    await act(async () =>
      root.render(<LauncherLibraryImport disabled={false} inspect={inspect} choose={vi.fn()} />),
    );
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await userEvent.fill(page.getByLabelText("GitHub Launcher data folder"), "C:\\GHL");
    await page.getByRole("button", { name: "List apps" }).click();
    await expect.element(page.getByText("1 app listed · none ready to review")).toBeVisible();
    await expect
      .element(page.getByText(/apps folder could not be read from its settings/))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "List apps again" })).toBeDisabled();
    await userEvent.fill(page.getByLabelText("Apps folder, if it moved"), "D:\\Apps");
    await page.getByRole("button", { name: "List apps again" }).click();
    expect(inspect).toHaveBeenLastCalledWith("github-launcher", "C:\\GHL", "D:\\Apps");
    // A failed listing clears the results but keeps the override visible and editable.
    inspect.mockResolvedValueOnce(undefined as unknown as LauncherLibraryInventory);
    await page.getByRole("button", { name: "List apps again" }).click();
    await expect.poll(() => page.getByText(/app listed/).elements().length).toBe(0);
    await expect.element(page.getByLabelText("Apps folder, if it moved")).toHaveValue("D:\\Apps");
    // A different data folder never inherits the previous apps-folder override.
    await userEvent.fill(page.getByLabelText("GitHub Launcher data folder"), "C:\\Other");
    await page.getByRole("button", { name: "List apps", exact: true }).click();
    expect(inspect).toHaveBeenLastCalledWith("github-launcher", "C:\\Other", undefined);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("names saves, mod records and version labels without trusting them", () => {
  expect(entryDetails(entry({}))).toEqual([]);
  expect(
    entryDetails(
      entry({
        user_data_paths: ["saves", "config.ini"],
        mods: { records: 1, providers: ["gamebanana"], readable: true },
        hints: {
          preferred_version: "v9",
          installed_version_label: "v1.2.3",
          selected_executable: "other.exe",
        },
      }),
    ),
  ).toEqual([
    "Saves and settings found: saves, config.ini",
    "1 launcher mod record, listed only; it is not copied as a mod or turned on",
    "Installed version label: v1.2.3 (not verified)",
    "Launcher version setting: v9 (not verified)",
  ]);
  expect(
    entryDetails(
      entry({
        user_data_paths: ["a", "b", "c", "d", "e", "f", "g"],
        mods: { records: 3, providers: [], readable: true },
      }),
    ),
  ).toEqual([
    "Saves and settings found: a, b, c, d, e, and 2 more saves and settings",
    "3 launcher mod records, listed only; they are not copied as mods or turned on",
  ]);
  expect(entryDetails(entry({ user_data_paths: ["a", "b", "c", "d", "e"] }))).toEqual([
    "Saves and settings found: a, b, c, d, e",
  ]);
  expect(entryDetails(entry({ user_data_paths: ["a", "b", "c", "d", "e", "f"] }))).toEqual([
    "Saves and settings found: a, b, c, d, e, and 1 more save or setting",
  ]);
  expect(entryDetails(entry({ mods: { records: 0, providers: [], readable: false } }))).toEqual([
    "Launcher mod records could not be read",
  ]);
  expect(entryDetails(entry({ mods: { records: 0, providers: [], readable: true } }))).toEqual([
    "No launcher mod records",
  ]);
});

it("offers only single-match ready apps for a several-app copy", () => {
  expect(launcherEntryCanBeBatched(entry({}))).toBe(true);
  expect(launcherEntryCanBeBatched(entry({ status: "ambiguous", adopt_port_id: null }))).toBe(
    false,
  );
  expect(launcherEntryCanBeBatched(entry({ install_path: null }))).toBe(false);
  expect(launcherEntryCanBeBatched(entry({ adopt_port_id: null }))).toBe(false);
});

it("selects launcher apps for a several-app copy with accessible checkboxes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const twoReady: LauncherLibraryInventory = {
    ...inventory,
    entries: [
      entry({}),
      entry({
        index: 1,
        name: "Second",
        folder_name: "Second",
        install_path: "C:\\Apps\\Second",
        adopt_port_id: "second",
      }),
    ],
    skipped_entries: [],
  };
  const reviewBatch = vi.fn(async () => undefined);
  try {
    await act(async () =>
      root.render(
        <LauncherLibraryImport
          disabled={false}
          inspect={async () => twoReady}
          choose={vi.fn()}
          reviewBatch={reviewBatch}
          copyBatch={vi.fn(async () => null)}
        />,
      ),
    );
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await userEvent.fill(page.getByLabelText("GitHub Launcher data folder"), "C:\\GHL");
    await page.getByRole("button", { name: "List apps", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select Game to copy with others" }).click();
    await page.getByRole("checkbox", { name: "Select Second to copy with others" }).click();
    await page.getByRole("button", { name: "Review copying 2 apps" }).click();
    expect(reviewBatch).toHaveBeenCalledWith([
      { source: "C:\\Apps\\Game", port_id: "game" },
      { source: "C:\\Apps\\Second", port_id: "second" },
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
