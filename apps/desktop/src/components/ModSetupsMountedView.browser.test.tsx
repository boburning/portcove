import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import {
  requestStandingSetup,
  useStandingSetupCatchUp,
} from "../features/game-file-discovery/use-standing-setup";
import { LocalizationProvider } from "../localization";
import { portDefinition } from "../test-fixtures";
import type { ModSetupsView, ModSetupView } from "../types";
import { DetailLayout } from "./DetailLayout";
import { ModSetupsControl } from "./ModSetupsControl";

let mounted: { root: Root; host: HTMLElement } | undefined;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.root.unmount());
    mounted.host.remove();
    mounted = undefined;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function StandingPassRefresh() {
  useStandingSetupCatchUp(7, true, null, null, async () => {});
  return null;
}

type InventoryCase =
  | "one profile"
  | "one profile with provider"
  | "Default and retained Torches"
  | "Default and retained Torches without provider";

// Synthetic identities and digests. The second case preserves the native
// inventory's two-profile shape without carrying originals, saves or private
// paths from that observation into a browser fixture.
function inventoryFixture(kind: InventoryCase): ModSetupsView {
  const twoProfiles = kind.startsWith("Default");
  const withProvider =
    kind === "one profile with provider" || kind === "Default and retained Torches";
  const portId = twoProfiles ? "zelda64-recomp" : "shipwright";
  const build: ModSetupView["revision"]["build"] = {
    install_id: "mock-runtime",
    port_id: portId,
    artifact: { asset_name: "mock-runtime.zip", sha256: "b".repeat(64), size: 1 },
    manifest_sha256: "b".repeat(64),
    selected_executable: "mock-runtime.exe",
    runtime: null,
    installed_contract_sha256: "b".repeat(64),
    definition: null,
    platform: "windows-x86-64",
  };
  const setup = (id: string, name: string, revision: number, isDefault: boolean): ModSetupView => ({
    originals: [],
    build_availability: "verified",
    build_version: twoProfiles ? "v1.2.2" : "9.3.1",
    profile: {
      id,
      port_id: portId,
      display_name: name,
      is_default: isDefault,
      intent: { update_policy: "review_updates" },
      current_revision: revision,
      created_at: 0,
      updated_at: 0,
    },
    revision: {
      profile_id: id,
      revision,
      parent_revision: revision === 1 ? null : revision - 1,
      build,
      originals: [],
      loader: { id: twoProfiles ? "n64-recomp" : "libultraship", version: "1" },
      save_group: `mock-progress-${id}`,
      created_at: 0,
      digest: "b".repeat(64),
      // Actual native Default revision 1 omits optional package/order arrays.
      ...(twoProfiles ? {} : { packages: [], orderings: [] }),
    },
  });
  const clean = setup("default", "Default", 1, true);
  const profiles = [clean];
  if (twoProfiles) {
    const customized = setup("mock-torches", "Torches native acceptance", 6, false);
    const specifications = [
      ["mm_recomp_buffer_increase.nrm", "1.0.0", "TSEG-Collision_Buffer_Increase"],
      ["mm_recomp_torches.nrm", "1.1.2", "TSEG-Too_Many_Torches"],
      ["yazmt_mm_corelib.nrm", "0.1.1", "YAZMT-YAZMT_Core"],
      ["yazmt_mm_global_objects.nrm", "0.1.1", "YAZMT-Global_Objects"],
    ] as const;
    customized.revision.packages = specifications.map(([native_id, native_version, project]) => ({
      native_id,
      native_version,
      enabled: true,
      sha256: "a".repeat(64),
      size: 1,
      provider: {
        provider: "thunderstore",
        project,
        file: native_version,
        version: native_version,
      },
      ...(native_id === "mm_recomp_torches.nrm"
        ? { requires: ["yazmt_mm_global_objects.nrm", "mm_recomp_buffer_increase.nrm"] }
        : {}),
    }));
    customized.revision.orderings = [
      {
        domain: "asset-override",
        native_ids: customized.revision.packages.map((item) => item.native_id),
      },
    ];
    customized.revision.settings = {
      [`recomp-config/mm_recomp_buffer_increase/${"a".repeat(64)}/buffer_size`]: "2048.0",
    };
    profiles.push(customized);
  }
  return {
    port_id: portId,
    supported: true,
    package_types: twoProfiles ? ["nrm"] : ["o2r", "otr"],
    later_mods_take_priority: !twoProfiles,
    held_updates: [],
    provider: withProvider ? (twoProfiles ? "thunderstore" : "gamebanana") : null,
    current_install_id: "mock-runtime",
    inventory: { port_id: portId, profiles },
    live: {
      profile_id: "default",
      revision: 1,
      unmanaged: [],
      changed_owned: [],
      native_list: { state: "in-sync" },
    },
  };
}

// The native regression accumulated whole package-area wrappers while the Saves
// panel stayed mounted under an initially selected Overview tab.
it.each([
  "one profile",
  "one profile with provider",
  "Default and retained Torches",
  "Default and retained Torches without provider",
] as const)(
  "keeps one package area through repeated reads in the mounted hidden Saves panel: %s",
  async (kind) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const inventory = inventoryFixture(kind);
    const portId = inventory.port_id;
    const read = vi
      .spyOn(desktopApi, "modSetups")
      .mockImplementation(async () => structuredClone(inventory));
    const pass = vi.spyOn(desktopApi, "runStandingSetup").mockResolvedValue({
      already_running: false,
      assessments: [],
      not_assessed: 0,
      batches: [],
      failures: [],
    });
    const localeApi = {
      localePreference: vi.fn().mockResolvedValue({ locale: "en" }),
      setLocalePreference: vi.fn().mockResolvedValue({ locale: "en" }),
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = { root, host };
    const tree = () => (
      <StrictMode>
        <LocalizationProvider api={localeApi}>
          <StandingPassRefresh />
          <DetailLayout
            port={{ ...portDefinition(), id: portId }}
            initialSection="overview"
            readiness="Ready to play"
            installation="Managed installation"
            close={() => {}}
            action={() => null}
          >
            {() => ({
              overview: <p>Overview</p>,
              saves: <ModSetupsControl portId={portId} generation={7} busy={false} />,
            })}
          </DetailLayout>
        </LocalizationProvider>
      </StrictMode>
    );
    await act(async () => root.render(tree()));
    const assertPackageArea = () => {
      const sections = host.querySelectorAll('section[aria-label="Mods in Default"]');
      expect(sections).toHaveLength(1);
      const section = sections[0]!;
      expect(section.querySelectorAll(':scope > div[tabindex="-1"]')).toHaveLength(1);
      expect(
        [...section.querySelectorAll("p")].filter(
          (paragraph) =>
            paragraph.textContent === "No mods. The game plays without changes in this setup.",
        ),
      ).toHaveLength(1);
    };
    assertPackageArea();
    if (kind.startsWith("Default")) {
      expect(inventory.inventory?.profiles).toHaveLength(2);
      const customized = inventory.inventory?.profiles.find((entry) => !entry.profile.is_default);
      expect(customized?.profile.current_revision).toBe(6);
      expect(customized?.revision.packages?.map((item) => item.enabled)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect(host.textContent).toContain("Torches native acceptance");
    }
    expect(host.querySelector('[data-detail-section="overview"]')).not.toBeNull();
    expect(host.querySelector("#detail-section-saves")?.closest("[hidden][inert]")).not.toBeNull();

    for (let refresh = 0; refresh < 80; refresh++) {
      const before = read.mock.calls.length;
      await act(async () => {
        root.render(tree());
        requestStandingSetup();
        await vi.advanceTimersByTimeAsync(1_500);
      });
      expect(read.mock.calls.length).toBeGreaterThan(before);
      assertPackageArea();
    }
    expect(pass).toHaveBeenCalledTimes(80);
    const saves = [...host.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "Saves & backups",
    );
    if (!(saves instanceof HTMLElement)) throw new Error("Missing Saves tab");
    await act(async () => saves.click());
    assertPackageArea();
    expect(host.querySelector("#detail-section-saves")?.closest("[hidden]")).toBeNull();
  },
);
