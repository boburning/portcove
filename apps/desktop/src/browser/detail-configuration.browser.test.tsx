import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import App from "../App";
import { desktopApi } from "../api";
import { generation, workspace } from "../dev-scenarios/interactive/scenarios";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";
import { initializeLocalization, LocalizationProvider } from "../localization";
import type { BackupInventory, GameSettingsView, InstallRecord, ModSetupView } from "../types";
import { browserFixture } from "../../test/browser-fixture";
import { captureParityState } from "../../test/parity-capture";
import "../styles/index.css";

const portId = "details-staged";
const setupName = "High-resolution textures and original controls";

function makeSetup(install: InstallRecord, modified: boolean): ModSetupView {
  const id = modified ? "fixture-custom" : "fixture-default";
  return {
    build_availability: "verified",
    build_version: install.version,
    originals: [],
    profile: {
      id,
      port_id: install.port_id,
      display_name: modified ? setupName : "Default",
      is_default: !modified,
      current_revision: 1,
      created_at: 1,
      updated_at: 1,
      intent: { update_policy: "keep_current" },
    },
    revision: {
      profile_id: id,
      revision: 1,
      created_at: 1,
      digest: "a".repeat(64),
      originals: [],
      parent_revision: null,
      save_group: id,
      packages: modified
        ? [{ native_id: "textures.o2r", enabled: true, sha256: "b".repeat(64), size: 1 }]
        : [],
      build: {
        artifact: install.artifact,
        definition: null,
        install_id: install.id,
        installed_contract_sha256: "c".repeat(64),
        manifest_sha256: install.manifest_sha256,
        platform: "windows-x86-64",
        port_id: install.port_id,
        runtime: null,
        selected_executable: "game.exe",
      },
    },
  };
}

function protection(
  active: InstallRecord,
  staged: InstallRecord,
): NonNullable<BackupInventory["protection"]> {
  const declaration = {
    definition_sha256: "d".repeat(64),
    persistent_file_patterns: [],
    persistent_paths: ["saves"],
    saves_and_settings: "portcove-managed" as const,
  };
  return {
    port_id: active.port_id,
    problem: null,
    catalog: declaration,
    exclusions: ["External profiles and mods are outside this backup."],
    managed_data: { path: "fixture/library/user/details-staged", state: "present" },
    latest_completed_backup: null,
    installations: (
      [
        { install: active, role: "active", collection: "direct_to_managed_data" },
        { install: staged, role: "staged", collection: "inactive" },
      ] as const
    ).map(({ install, role, collection }) => ({
      install_id: install.id,
      install_root: install.path,
      version: install.version,
      role,
      update_owner: "portcove",
      collection,
      collection_candidates: [],
      collection_root: null,
      retained: declaration,
      effective: role === "active" ? declaration : null,
      exclusions: [],
      problem: null,
    })),
  };
}

let transport: ReturnType<typeof installInteractiveTransport> | undefined;
let fixture: ReturnType<typeof browserFixture> | undefined;
afterEach(async () => {
  await cleanup();
  transport?.dispose();
  document.getElementById("root")?.remove();
  vi.restoreAllMocks();
  localStorage.clear();
  await fixture?.dispose();
});

it("keeps the selected mod setup and settings draft through version and save tasks opened from Library", async () => {
  fixture = browserFixture({ viewport: true });
  localStorage.clear();
  await page.viewport(960, 640);
  const status = workspace("details").statuses.find((entry) => entry.port_id === portId)!;
  const active = status.active!;
  const staged = status.staged!;
  const selected = makeSetup(active, true);
  const settings: GameSettingsView = {
    port_id: portId,
    install_id: active.id,
    available: true,
    reason: null,
    files: [
      {
        id: "preferences",
        path: "settings.json",
        available: true,
        reason: null,
        configuration_sha256: "e".repeat(64),
        settings: [
          {
            id: "master-volume",
            label: "Master volume",
            value: 70,
            value_type: { kind: "integer", minimum: 0, maximum: 100, step: 1, default: 40 },
          },
        ],
      },
    ],
  };
  const readSettings = vi.spyOn(desktopApi, "gameSettings").mockResolvedValue(settings);
  const readSetups = vi.spyOn(desktopApi, "modSetups").mockResolvedValue({
    port_id: portId,
    supported: true,
    current_install_id: active.id,
    package_types: ["o2r"],
    later_mods_take_priority: true,
    held_updates: [],
    provider: null,
    inventory: { port_id: portId, profiles: [makeSetup(active, false), selected] },
    live: {
      profile_id: selected.profile.id,
      revision: selected.profile.current_revision,
      native_list: { state: "in-sync" },
      changed_owned: [],
      unmanaged: [],
    },
  });
  vi.spyOn(desktopApi, "backups").mockResolvedValue({
    port_id: portId,
    state: "healthy",
    backups: [],
    problems: [],
    create_assessment: { action: "backup_create", availability: "allowed", reason: "available" },
    restore_assessment: {
      action: "backup_restore",
      availability: "waiting",
      reason: "missing_backup",
    },
    protection: protection(active, staged),
  });
  const review = vi.spyOn(desktopApi, "reviewGameSetting").mockResolvedValue({
    port_id: portId,
    install_id: active.id,
    file_id: "preferences",
    setting_id: "master-volume",
    label: "Master volume",
    path: "settings.json",
    change: { action: "set", value: 84 },
    previous_value: 70,
    proposed_value: 84,
    configuration_sha256: "e".repeat(64),
    review_sha256: "f".repeat(64),
  });
  const apply = vi.spyOn(desktopApi, "applyGameSetting");
  const useSetup = vi.spyOn(desktopApi, "useModSetup");

  transport = installInteractiveTransport("details", (message) => {
    throw Error(message);
  });
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  initializeLocalization(["en"]);
  await render(
    <LocalizationProvider api={desktopApi}>
      <App />
    </LocalizationProvider>,
    { container: root },
  );

  const openGame = page.getByRole("button", { name: "Update saved for later", exact: true });
  await openGame.click();
  const configuration = page.getByRole("tab", { name: "Game settings", exact: true });
  await configuration.click();
  const configPanel = page.getByRole("tabpanel", { name: "Game settings", exact: true });
  const read = configPanel.getByRole("button", { name: "Read game settings", exact: true });
  await expect.element(read).toBeVisible();
  await read.click();
  const volume = configPanel.getByRole("spinbutton", { name: "Master volume", exact: true });
  await volume.fill("84");
  const mods = page.getByRole("tab", { name: "Mods", exact: true });
  await mods.click();
  const modsPanel = page.getByRole("tabpanel", { name: "Mods", exact: true });
  const activeSetup = modsPanel.getByRole("region", {
    name: `Mods in ${setupName}`,
    exact: true,
  });
  await expect.element(activeSetup.getByText("textures.o2r", { exact: true })).toBeVisible();
  await modsPanel.getByText("Setups", { exact: true }).click();
  await expect.element(modsPanel.getByText("In use", { exact: true })).toBeVisible();
  await modsPanel.getByText("Setups", { exact: true }).click();
  activeSetup.element().scrollIntoView({ block: "center" });
  await captureParityState("library-selected-mod-setup");
  expect(readSettings).toHaveBeenCalledWith(portId, generation);
  expect(readSetups).toHaveBeenCalledWith(portId, generation);

  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: `Apply update · ${staged.version}`, exact: true }))
    .toBeVisible();
  await page.getByRole("tab", { name: "Saves & backups", exact: true }).click();
  const coverage = page.getByRole("region", { name: "Backups and updates", exact: true });
  await expect
    .element(coverage.getByRole("heading", { name: `Current version · ${active.version}` }))
    .toBeVisible();
  await expect
    .element(coverage.getByRole("heading", { name: `Prepared version · ${staged.version}` }))
    .toBeVisible();
  await expect
    .element(coverage.getByText("External profiles and mods are outside this backup."))
    .toBeVisible();

  await configuration.click();
  await expect.element(configuration).toHaveFocus();
  await expect.element(volume).toHaveValue(84);
  await configPanel.getByRole("button", { name: "Review change", exact: true }).click();
  await expect
    .element(page.getByRole("heading", { name: "Review game setting", exact: true }))
    .toHaveFocus();
  expect(review).toHaveBeenCalledExactlyOnceWith(
    portId,
    "preferences",
    "master-volume",
    { action: "set", value: 84 },
    generation,
  );
  const settingReview = page.getByRole("dialog", { name: "Review game setting", exact: true });
  await expect
    .element(settingReview.getByRole("button", { name: "Save setting", exact: true }))
    .toBeEnabled();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(configPanel.getByRole("heading", { level: 3, name: "Game settings", exact: true }))
    .toHaveFocus();
  await expect.element(volume).toHaveValue(84);
  expect(apply).not.toHaveBeenCalled();
  expect(useSetup).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Back to Library", exact: true }).click();
  await expect.element(openGame).toHaveFocus();
});
