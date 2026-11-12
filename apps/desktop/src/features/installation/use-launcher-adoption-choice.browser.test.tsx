import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../../api";
import { AdoptionModal } from "../../components/AdoptionModal";
import { LauncherLibraryImport } from "../../components/LauncherLibraryImport";
import type { AdoptionPreview, LauncherLibraryEntry, LauncherLibraryInventory } from "../../types";
import type { Perform } from "../operations/use-operation-state";
import { useAdoptionPlanning } from "./use-installation-planning";
import { useLauncherAdoptionChoice } from "./use-launcher-adoption-choice";

function entry(overrides: Partial<LauncherLibraryEntry>): LauncherLibraryEntry {
  return {
    index: 0,
    name: "Game",
    repository_source: "github",
    repository: "owner/game",
    folder_name: "Game",
    install_path: "C:/Apps/Game",
    explicit_install_path: false,
    status: "ready-to-review",
    candidate_port_ids: ["game"],
    detected_port_ids: ["game"],
    user_data_paths: [],
    hints: { preferred_version: null, installed_version_label: null, selected_executable: null },
    mods: null,
    explanation: "Review the copy plan.",
    adopt_port_id: "game",
    shares_folder_with: null,
    not_carried_over: [],
    ...overrides,
  };
}

const inventory: LauncherLibraryInventory = {
  launcher: "github-launcher",
  format_revision: "6e62a967cb37a2106b0420dc47375ee83cac41d3",
  data_root: "C:/GithubLauncher",
  library_file: "C:/GithubLauncher/apps.json",
  legacy_library_file: false,
  apps_root: "C:/Apps",
  apps_root_origin: "default",
  entries: [
    entry({}),
    entry({
      index: 1,
      name: "Shared",
      folder_name: "Shared",
      install_path: "C:/Apps/Shared",
      status: "ambiguous",
      adopt_port_id: null,
      detected_port_ids: ["a", "b"],
    }),
  ],
  skipped_entries: [],
  original_will_be_modified: false,
  inventory_sha256: "0".repeat(64),
};

function preview(source: string, selected: string | null): AdoptionPreview {
  return {
    source,
    detected_port_ids: selected ? [selected] : ["a", "b"],
    selected_port_id: selected,
    application_files_will_be_copied: true,
    original_will_be_modified: false,
    copy_plan: { directories: [], files: [], skipped_entries: [], total_bytes: 0 },
    destination: null,
    plan_sha256: "b".repeat(64),
  };
}

const calls: { command: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  calls.length = 0;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "inspect_launcher_library") return inventory;
        if (command === "preview_adoption")
          return preview(String(args.path), (args.portId as string | null) ?? null);
        throw new Error(`unexpected ${command}`);
      },
      transformCallback: () => 0,
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

let resetChoice: () => void = () => {};

function LauncherCopyDialog() {
  const [path, setPath] = useState("");
  const perform: Perform = async (_name, task) => task();
  const launcher = useLauncherAdoptionChoice(path, "selected-in-browser");
  const planning = useAdoptionPlanning(path, launcher.portId, true, 7, perform, () => {}, []);
  useEffect(() => {
    if (launcher.takePendingReview()) void planning.review();
  });
  const changePath = (next: string) => {
    planning.invalidate();
    setPath(next);
  };
  resetChoice = () => {
    launcher.reset();
    changePath("");
  };
  return (
    <AdoptionModal
      path={path}
      setPath={changePath}
      preview={planning.preview}
      close={() => {}}
      review={(selected) => {
        void planning.review(selected);
      }}
      adopt={() => {}}
      launcherImport={
        <LauncherLibraryImport
          disabled={false}
          inspect={(kind, dataRoot, appsRoot) =>
            desktopApi.inspectLauncherLibrary(kind, dataRoot, 7, appsRoot)
          }
          choose={(chosen) => launcher.choose(chosen, changePath)}
        />
      }
    />
  );
}

it("opens the ordinary copy review for a chosen launcher app with that app's game", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LauncherCopyDialog />));
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await userEvent.fill(page.getByLabelText("GitHub Launcher data folder"), "C:/GithubLauncher");
    await page.getByRole("button", { name: "List apps" }).click();
    await page.getByRole("button", { name: "Review copying Game" }).click();
    await expect
      .poll(() => calls.filter((call) => call.command === "preview_adoption"))
      .toEqual([
        {
          command: "preview_adoption",
          args: { path: "C:/Apps/Game", generation: 7, portId: "game" },
        },
      ]);
    expect(calls[0]).toEqual({
      command: "inspect_launcher_library",
      args: {
        launcher: "github-launcher",
        dataRoot: "C:/GithubLauncher",
        appsRoot: null,
        generation: 7,
      },
    });
    await expect
      .element(page.getByLabelText("Existing installation folder"))
      .toHaveValue("C:/Apps/Game");

    // An ambiguous app opens the review without a game, so the detected choices appear.
    await page.getByText("Moving from GitHub Launcher or Quiver?").click();
    await page.getByRole("button", { name: "Review copying Shared" }).click();
    await expect
      .poll(() => calls.filter((call) => call.command === "preview_adoption").at(-1)?.args)
      .toEqual({ path: "C:/Apps/Shared", generation: 7, portId: null });

    // Closing the dialog session forgets the choice, even for the same folder later.
    await act(async () => resetChoice());
    await userEvent.fill(page.getByLabelText("Existing installation folder"), "C:/Apps/Game");
    await page.getByRole("button", { name: "Review copy plan" }).click();
    await expect
      .poll(() => calls.filter((call) => call.command === "preview_adoption").at(-1)?.args)
      .toEqual({ path: "C:/Apps/Game", generation: 7, portId: "selected-in-browser" });

    // Editing the folder by hand restores the dialog's ordinary port scope.
    await userEvent.fill(page.getByLabelText("Existing installation folder"), "C:/Elsewhere");
    await page.getByRole("button", { name: "Review copy plan" }).click();
    await expect
      .poll(() => calls.filter((call) => call.command === "preview_adoption").at(-1)?.args)
      .toEqual({ path: "C:/Elsewhere", generation: 7, portId: "selected-in-browser" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
